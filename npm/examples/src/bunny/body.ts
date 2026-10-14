import type { Mesh } from './mesh.js';
import { Burst } from './burst.js';

/** What the controls set; the body reads them every step. */
export interface Controls {
  /** Meters per second squared. */
  gravity: number;
  /** 0 is jelly, 1 is rubber: how hard the body pulls back to its shape. */
  firmness: number;
  /** The volume the body's pressure holds, as a share of its rest volume. */
  inflate: number;
  wind: boolean;
  playful?: boolean;
  reducedMotion?: boolean;
}

/** One frame of every vertex, a column per field, filled in place by {@link Body.sample}. */
export interface Frame {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Meters per second. */
  readonly speed: Float32Array;
  /** Meters from where the rest shape would put the vertex. */
  readonly strain: Float32Array;
}

/** One step, in seconds. */
export const STEP = 1 / 120;
/** The walls stand this far from the center. */
export const ROOM = 3.6;
const CEILING = 6.5;

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Column-major rotation of a unit quaternion [x, y, z, w]. */
function rotation([x, y, z, w]: number[]): [Vec3, Vec3, Vec3] {
  return [
    [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + w! * z!), 2 * (x! * z! - w! * y!)],
    [2 * (x! * y! - w! * z!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + w! * x!)],
    [2 * (x! * z! + w! * y!), 2 * (y! * z! - w! * x!), 1 - 2 * (x! * x! + y! * y!)],
  ];
}

/**
 * A soft bunny: Verlet integration with compliant stretch, bend, and volume constraints. Soft pose
 * targets give the torso support, let the ear tips lag, and drive anticipation and recovery.
 */
export class Body {
  readonly count: number;
  /** Positions now and one step ago, x, y, z per vertex. */
  readonly x: Float64Array;
  private readonly previous: Float64Array;
  /** Rest positions about the rest center. */
  private readonly rest: Float64Array;
  private readonly lengths: Float64Array;
  private readonly lambdas: Float64Array;
  private readonly inverseMass: Float64Array;
  private readonly neighbors: { row: number; length: number }[][];
  private readonly bends: { a: number; b: number; length: number; lambda: number }[] = [];
  private volumeLambda = 0;
  private readonly gradient: Float64Array;
  /** Unit outward normals, as of the last step. */
  readonly normals: Float64Array;
  private readonly restVolume: number;
  private quaternion = [0, 0, 0, 1];
  private goal: [Vec3, Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  /** Seconds simulated. */
  time = 0;
  readonly burst: Burst;
  private action: 'idle' | 'crouch' | 'flight' | 'land' | 'squash' | 'pop' = 'idle';
  private age = 0;
  private supported = false;
  private contacts = 0;
  private idleFor = 0;
  private nextHop = 7;
  private look?: Vec3;
  private attention = 0;
  private crouch = 0;
  private squashHeld = false;
  private scale = 1;
  private animate = true;
  volume = 0;
  private grabbed?: {
    readonly rows: Uint32Array;
    readonly weights: Float64Array;
    readonly offsets: Float64Array;
    target: Vec3;
    filtered: Vec3;
  };

  constructor(readonly mesh: Mesh) {
    const count = (this.count = mesh.count);
    this.x = Float64Array.from(mesh.positions);
    this.previous = Float64Array.from(mesh.positions);
    this.rest = Float64Array.from(mesh.positions);
    const center = this.center(this.rest);
    for (let i = 0; i < count * 3; i++) this.rest[i] = this.rest[i]! - center[i % 3]!;
    const { a, b } = mesh.springs;
    this.lengths = Float64Array.from(a, (_, e) => this.distance(this.x, a[e]!, b[e]!));
    this.lambdas = new Float64Array(a.length);
    this.neighbors = Array.from({ length: count }, () => []);
    for (let e = 0; e < a.length; e++) {
      this.neighbors[a[e]!]!.push({ row: b[e]!, length: this.lengths[e]! });
      this.neighbors[b[e]!]!.push({ row: a[e]!, length: this.lengths[e]! });
    }
    // Area-weighted mass avoids making dense parts of the scan artificially heavy.
    const mass = new Float64Array(count);
    const opposite = new Map<number, number>();
    for (let t = 0; t < mesh.faces.a.length; t++) {
      const face = [mesh.faces.a[t]!, mesh.faces.b[t]!, mesh.faces.c[t]!];
      const edge = (u: number, v: number): Vec3 =>
        [0, 1, 2].map((k) => this.x[v * 3 + k]! - this.x[u * 3 + k]!) as Vec3;
      const area = Math.hypot(...cross(edge(face[0]!, face[1]!), edge(face[0]!, face[2]!))) / 6;
      for (const row of face) mass[row] = mass[row]! + area;
      for (let e = 0; e < 3; e++) {
        const u = face[e]!,
          v = face[(e + 1) % 3]!,
          w = face[(e + 2) % 3]!;
        const key = Math.min(u, v) * count + Math.max(u, v);
        const other = opposite.get(key);
        if (other !== undefined)
          this.bends.push({ a: other, b: w, length: this.distance(this.x, other, w), lambda: 0 });
        else opposite.set(key, w);
      }
    }
    const mean = mass.reduce((sum, v) => sum + v, 0) / count;
    this.inverseMass = Float64Array.from(mass, (m) => mean / Math.max(mean * 0.2, m));
    this.gradient = new Float64Array(count * 3);
    this.normals = new Float64Array(count * 3);
    this.restVolume = this.measure();
    this.volume = this.restVolume;
    this.burst = new Burst(mesh, ROOM, CEILING);
  }

  /** A frame to {@link sample} into, reused every step: appending copies it. */
  frame(): Frame {
    const column = () => new Float32Array(this.count);
    return { x: column(), y: column(), z: column(), speed: column(), strain: column() };
  }

  /** Advance by whole steps; returns how many ran. */
  advance(seconds: number, controls: Controls): number {
    const steps = Math.min(16, Math.floor(seconds / STEP));
    for (let s = 0; s < steps; s++) this.step(controls);
    return steps;
  }

  /** Every vertex's position, speed, and strain now. */
  sample(frame: Frame): void {
    const [c, r0, r1, r2] = this.goal;
    for (let i = 0; i < this.count; i++) {
      const x = this.x[i * 3]!;
      const y = this.x[i * 3 + 1]!;
      const z = this.x[i * 3 + 2]!;
      frame.x[i] = x;
      frame.y[i] = y;
      frame.z[i] = z;
      frame.speed[i] =
        Math.hypot(
          x - this.previous[i * 3]!,
          y - this.previous[i * 3 + 1]!,
          z - this.previous[i * 3 + 2]!,
        ) / STEP;
      const rx = this.rest[i * 3]!;
      const ry = this.rest[i * 3 + 1]!;
      const rz = this.rest[i * 3 + 2]!;
      frame.strain[i] = Math.hypot(
        c[0] + r0[0] * rx + r1[0] * ry + r2[0] * rz - x,
        c[1] + r0[1] * rx + r1[1] * ry + r2[1] * rz - y,
        c[2] + r0[2] * rx + r1[2] * ry + r2[2] * rz - z,
      );
    }
  }

  /** Center height, mean speed, and intact volume. Volume is missing while in pieces. */
  metrics(): [number, number, number] {
    if (this.burst.active) {
      const chunks = this.burst.chunks;
      return [
        chunks.reduce((sum, c) => sum + c.position[2], 0) / chunks.length,
        chunks.reduce((sum, c) => sum + Math.hypot(...c.velocity), 0) / chunks.length,
        NaN,
      ];
    }
    let speed = 0;
    for (let i = 0; i < this.count * 3; i += 3)
      speed += Math.hypot(
        this.x[i]! - this.previous[i]!,
        this.x[i + 1]! - this.previous[i + 1]!,
        this.x[i + 2]! - this.previous[i + 2]!,
      );
    return [
      this.center(this.x)[2],
      speed / this.count / STEP,
      Math.min(2, Math.max(0, this.volume / this.restVolume)),
    ];
  }

  // Impulses change velocity, which Verlet keeps as the step from previous to now.
  private push(row: number, v: Vec3): void {
    for (let a = 0; a < 3; a++)
      this.previous[row * 3 + a] = this.previous[row * 3 + a]! - v[a]! * STEP;
  }

  /** A grounded hop: first crouch, then push off. Repeated presses never stack impulses. */
  jump(): void {
    if (!this.supported || this.grabbed || this.burst.active || this.action !== 'idle') return;
    this.action = 'crouch';
    this.age = 0;
  }

  /** Compress briefly, then let the material rebound. */
  squash(held = false): void {
    if (this.burst.active || this.grabbed || this.action !== 'idle') return;
    this.action = 'squash';
    this.squashHeld = held;
    this.age = 0;
  }

  endSquash(): void {
    if (this.action === 'squash' && this.squashHeld) this.age = 0.22;
    this.squashHeld = false;
  }

  /** Pop into capped pieces; pressing again calls them home. */
  explode(): void {
    if (this.burst.active) return this.burst.gather();
    if (this.action === 'pop') return;
    this.release();
    this.action = 'pop';
    this.age = 0;
  }

  /** Dent the surface around a vertex. */
  poke(row: number, speed = 6): void {
    if (this.burst.active || this.action === 'pop') return;
    this.idleFor = 0;
    const near = this.near(row, 0.7);
    for (let j = 0; j < near.rows.length; j++) {
      const i = near.rows[j]!;
      const w = near.weights[j]! * speed;
      this.push(i, [
        -this.normals[i * 3]! * w,
        -this.normals[i * 3 + 1]! * w,
        -this.normals[i * 3 + 2]! * w,
      ]);
    }
  }

  /** Lift it high, turned at random unless `upright`, and let go. */
  drop(upright = false): void {
    const yaw = upright ? 0.6 : Math.random() * Math.PI * 2;
    const tilt = upright ? 0 : (Math.random() - 0.5) * 0.9;
    const [cy, sy, ct, st] = [Math.cos(yaw), Math.sin(yaw), Math.cos(tilt), Math.sin(tilt)];
    for (let i = 0; i < this.count; i++) {
      const rx = this.rest[i * 3]!;
      const ry = this.rest[i * 3 + 1]!;
      const rz = this.rest[i * 3 + 2]!;
      const tx = rx * ct + rz * st;
      const tz = -rx * st + rz * ct;
      const p: Vec3 = [tx * cy - ry * sy, tx * sy + ry * cy, tz + 4.2];
      for (let a = 0; a < 3; a++) this.x[i * 3 + a] = this.previous[i * 3 + a] = p[a]!;
    }
    this.quaternion = [0, 0, 0, 1];
    this.burst.reset();
    this.action = 'idle';
    this.age = this.idleFor = this.crouch = 0;
    this.supported = false;
    this.grabbed = undefined;
    this.match(0);
    this.measure();
  }

  /** Hold a vertex and the surface around it toward `target` until released. */
  grab(row: number, target: readonly number[]): void {
    if (this.burst.active || this.action === 'pop') return;
    this.action = 'idle';
    this.crouch = this.idleFor = 0;
    const near = this.near(row, 0.65);
    const offsets = new Float64Array(near.rows.length * 3);
    near.rows.forEach((i, j) => {
      for (let a = 0; a < 3; a++) offsets[j * 3 + a] = this.x[i * 3 + a]! - this.x[row * 3 + a]!;
    });
    const point: Vec3 = [target[0]!, target[1]!, target[2]!];
    this.grabbed = { ...near, offsets, target: point, filtered: [...point] };
  }

  drag(target: readonly number[]): void {
    if (this.grabbed)
      this.grabbed.target = [
        Math.max(-ROOM, Math.min(ROOM, target[0]!)),
        Math.max(-ROOM, Math.min(ROOM, target[1]!)),
        Math.max(0.1, Math.min(CEILING - 0.2, target[2]!)),
      ];
  }

  release(cancelled = false): void {
    if (cancelled && this.grabbed) this.previous.set(this.x);
    this.grabbed = undefined;
  }

  lookAt(target?: readonly number[]): void {
    this.look = target ? [target[0]!, target[1]!, target[2]!] : undefined;
  }

  get state(): string {
    if (this.burst.active) return this.burst.gathering ? 'gathering' : 'tumbling';
    if (this.grabbed) return 'held';
    return this.action === 'flight'
      ? 'hopping'
      : this.action === 'crouch'
        ? 'getting ready'
        : this.action;
  }

  private step(controls: Controls): void {
    const { x, previous, count, normals } = this;
    const t = (this.time += STEP);
    if (this.burst.active) {
      if (this.burst.step(STEP, controls.gravity)) {
        x.set(this.burst.targetBody);
        previous.set(x);
        this.crouch = 0;
        this.action = 'land';
        this.age = 0;
        this.match(0);
        this.measure();
      }
      return;
    }
    this.behave(controls);
    if (this.burst.active) return;
    const gust = controls.wind ? 16 : 0;
    const wx = Math.cos(t * 0.4);
    const wy = Math.sin(t * 0.4);
    const dt2 = STEP * STEP;
    const damping = Math.exp(-(this.contacts > 8 && !this.grabbed ? 2.4 : 0.6) * STEP);
    for (let i = 0; i < count; i++) {
      let ax = 0;
      let ay = 0;
      let az = -controls.gravity;
      if (gust) {
        const facing = Math.max(0, -(normals[i * 3]! * wx + normals[i * 3 + 1]! * wy));
        const g =
          gust *
          (0.25 + facing) *
          (0.6 + 0.4 * Math.sin(t * 2.3 + x[i * 3]! * 1.7 + x[i * 3 + 2]! * 1.1));
        ax += wx * g;
        ay += wy * g;
        az += g * 0.15;
      }
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        const now = x[k]!;
        const velocity = Math.max(-10 * STEP, Math.min(10 * STEP, now - previous[k]!));
        x[k] = now + velocity * damping + (a === 0 ? ax : a === 1 ? ay : az) * dt2;
        previous[k] = now;
      }
    }
    const firm = controls.firmness;
    const breathing =
      controls.reducedMotion || this.grabbed || this.action !== 'idle'
        ? 1
        : 1 + 0.004 * Math.sin(t * 2.2);
    this.scale = Math.cbrt(controls.inflate * breathing);
    this.lambdas.fill(0);
    this.volumeLambda = 0;
    for (const bend of this.bends) bend.lambda = 0;
    const compliance = 1e-7 * 10 ** (3 * (1 - firm));
    for (let iteration = 0; iteration < 3; iteration++) {
      this.springs(compliance);
      this.pressure(1e-8, controls.inflate * breathing);
    }
    this.match(1 - Math.exp(-(1.2 + 6 * firm * firm) * STEP));
    if (this.grabbed) this.hold(this.grabbed);
    this.collide();
  }

  private behave(controls: Controls): void {
    this.animate = !controls.reducedMotion;
    this.age += STEP;
    this.idleFor = this.grabbed ? 0 : this.idleFor + STEP;
    if (this.action === 'crouch') {
      this.crouch = Math.min(1, this.age / 0.14);
      if (this.age >= 0.14) {
        if (this.supported) {
          const facing = this.goal[1];
          const speed = controls.reducedMotion ? 2 : 3.8;
          for (let i = 0; i < this.count; i++) {
            const vz = (this.x[i * 3 + 2]! - this.previous[i * 3 + 2]!) / STEP;
            this.push(i, [facing[0] * 0.45, facing[1] * 0.45, Math.max(0, speed - vz)]);
          }
        }
        this.action = 'flight';
        this.age = this.crouch = 0;
      }
    } else if (this.action === 'flight' && this.age > 0.15 && this.contacts > 0) {
      this.action = 'land';
      this.age = 0;
    } else if (this.action === 'land' && this.age > 0.35) this.action = 'idle';
    else if (this.action === 'squash') {
      this.crouch = this.squashHeld
        ? 1.8 * Math.min(1, this.age / 0.16)
        : 1.8 * Math.sin(Math.PI * Math.min(1, this.age / 0.45));
      if (!this.squashHeld && this.age > 0.45) this.action = 'idle';
    } else if (this.action === 'pop') {
      this.crouch = Math.min(1.4, (this.age / 0.16) * 1.4);
      if (this.age >= 0.16) {
        this.burst.start(
          this.x,
          this.previous,
          STEP,
          Math.atan2(this.goal[1][1], this.goal[1][0]),
          !!controls.reducedMotion,
          Math.cbrt(controls.inflate),
        );
        this.crouch = 0;
      }
    } else if (this.action === 'idle') {
      this.crouch = 0;
      if (controls.playful && !controls.reducedMotion && this.idleFor > this.nextHop) {
        this.jump();
        this.idleFor = 0;
        this.nextHop = 6 + 3 * (0.5 + 0.5 * Math.sin(this.time * 1.7));
      }
    }
    let attention = 0;
    if (this.look && !this.grabbed && !controls.reducedMotion) {
      const c = this.goal[0];
      const direction = Math.atan2(this.look[1] - c[1], this.look[0] - c[0]);
      const yaw = Math.atan2(this.goal[1][1], this.goal[1][0]);
      attention = Math.max(
        -0.35,
        Math.min(0.35, Math.atan2(Math.sin(direction - yaw), Math.cos(direction - yaw))),
      );
    }
    this.attention += (attention - this.attention) * (1 - Math.exp(-8 * STEP));
  }

  private springs(compliance: number): void {
    const { lengths } = this;
    const { a: from, b: to } = this.mesh.springs;
    for (let e = 0; e < lengths.length; e++) {
      this.lambdas[e] = this.distanceConstraint(
        from[e]!,
        to[e]!,
        lengths[e]!,
        compliance,
        this.lambdas[e]!,
      );
    }
    for (const bend of this.bends)
      bend.lambda = this.distanceConstraint(
        bend.a,
        bend.b,
        bend.length,
        compliance * 12,
        bend.lambda,
      );
  }

  private distanceConstraint(
    a: number,
    b: number,
    rest: number,
    compliance: number,
    lambda: number,
  ): number {
    const ia = a * 3,
      ib = b * 3;
    const dx = this.x[ia]! - this.x[ib]!,
      dy = this.x[ia + 1]! - this.x[ib + 1]!,
      dz = this.x[ia + 2]! - this.x[ib + 2]!;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-9) return lambda;
    const wa = this.inverseMass[a]!,
      wb = this.inverseMass[b]!;
    const alpha = compliance / (STEP * STEP);
    const delta = (-(length - rest * this.scale) - alpha * lambda) / (wa + wb + alpha);
    const k = delta / length;
    this.x[ia] = this.x[ia]! + wa * dx * k;
    this.x[ia + 1] = this.x[ia + 1]! + wa * dy * k;
    this.x[ia + 2] = this.x[ia + 2]! + wa * dz * k;
    this.x[ib] = this.x[ib]! - wb * dx * k;
    this.x[ib + 1] = this.x[ib + 1]! - wb * dy * k;
    this.x[ib + 2] = this.x[ib + 2]! - wb * dz * k;
    return lambda + delta;
  }

  /** The enclosed volume, with its gradient per vertex and the normals it implies. */
  private measure(): number {
    const { x, gradient, normals } = this;
    const { a: fa, b: fb, c: fc } = this.mesh.faces;
    gradient.fill(0);
    let volume = 0;
    for (let t = 0; t < fa.length; t++) {
      const a = fa[t]! * 3;
      const b = fb[t]! * 3;
      const c = fc[t]! * 3;
      const [ax, ay, az] = [x[a]!, x[a + 1]!, x[a + 2]!];
      const [bx, by, bz] = [x[b]!, x[b + 1]!, x[b + 2]!];
      const [cx, cy, cz] = [x[c]!, x[c + 1]!, x[c + 2]!];
      // Each corner's gradient is the cross product of the other two.
      const gax = by * cz - bz * cy;
      const gay = bz * cx - bx * cz;
      const gaz = bx * cy - by * cx;
      volume += ax * gax + ay * gay + az * gaz;
      gradient[a] = gradient[a]! + gax;
      gradient[a + 1] = gradient[a + 1]! + gay;
      gradient[a + 2] = gradient[a + 2]! + gaz;
      gradient[b] = gradient[b]! + cy * az - cz * ay;
      gradient[b + 1] = gradient[b + 1]! + cz * ax - cx * az;
      gradient[b + 2] = gradient[b + 2]! + cx * ay - cy * ax;
      gradient[c] = gradient[c]! + ay * bz - az * by;
      gradient[c + 1] = gradient[c + 1]! + az * bx - ax * bz;
      gradient[c + 2] = gradient[c + 2]! + ax * by - ay * bx;
    }
    for (let i = 0; i < gradient.length; i += 3) {
      const length = Math.hypot(gradient[i]!, gradient[i + 1]!, gradient[i + 2]!) || 1;
      for (let k = 0; k < 3; k++) normals[i + k] = gradient[i + k]! / length;
    }
    return (this.volume = volume / 6);
  }

  private pressure(compliance: number, inflate: number): void {
    const volume = this.measure();
    const { x, gradient } = this;
    let norm = 0;
    for (let i = 0; i < gradient.length; i++)
      norm += this.inverseMass[Math.floor(i / 3)]! * (gradient[i]! / 6) ** 2;
    if (norm < 1e-12) return;
    const alpha = compliance / (STEP * STEP);
    const delta = (this.restVolume * inflate - volume - alpha * this.volumeLambda) / (norm + alpha);
    this.volumeLambda += delta;
    for (let i = 0; i < x.length; i++)
      x[i] = x[i]! + (delta * this.inverseMass[Math.floor(i / 3)]! * gradient[i]!) / 6;
  }

  /** Pull toward the rest shape, turned and moved to fit where the body is now. */
  private match(stiffness: number): void {
    const { x, rest, count } = this;
    const c = this.center(x);
    // A = sum of (x - c) times rest transposed, by columns.
    const A: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < count; i++) {
      const px = x[i * 3]! - c[0];
      const py = x[i * 3 + 1]! - c[1];
      const pz = x[i * 3 + 2]! - c[2];
      for (let col = 0; col < 3; col++) {
        const r = rest[i * 3 + col]!;
        const column = A[col]!;
        column[0] += px * r;
        column[1] += py * r;
        column[2] += pz * r;
      }
    }
    // Müller et al. 2016: the rotation nearest A, warm started from the last step.
    let q = this.quaternion;
    for (let iteration = 0; iteration < 8; iteration++) {
      const R = rotation(q);
      const omega: Vec3 = [0, 0, 0];
      let denominator = 0;
      for (let col = 0; col < 3; col++) {
        const w = cross(R[col]!, A[col]!);
        omega[0] += w[0];
        omega[1] += w[1];
        omega[2] += w[2];
        denominator += dot(R[col]!, A[col]!);
      }
      const k = 1 / (Math.abs(denominator) + 1e-9);
      const w = Math.hypot(omega[0], omega[1], omega[2]) * k;
      if (w < 1e-9) break;
      const s = Math.sin(w / 2) / (w / k);
      const dq = [omega[0] * s, omega[1] * s, omega[2] * s, Math.cos(w / 2)];
      q = [
        dq[3]! * q[0]! + dq[0]! * q[3]! + dq[1]! * q[2]! - dq[2]! * q[1]!,
        dq[3]! * q[1]! - dq[0]! * q[2]! + dq[1]! * q[3]! + dq[2]! * q[0]!,
        dq[3]! * q[2]! + dq[0]! * q[1]! - dq[1]! * q[0]! + dq[2]! * q[3]!,
        dq[3]! * q[3]! - dq[0]! * q[0]! - dq[1]! * q[1]! - dq[2]! * q[2]!,
      ];
      const n = Math.hypot(...q);
      q = q.map((v) => v / n);
    }
    // A quiet recovery motor rights a resting bunny, but never fights a grab or a flight.
    if (
      stiffness > 0 &&
      this.contacts > 8 &&
      !this.grabbed &&
      this.idleFor > 0.7 &&
      this.action === 'idle'
    ) {
      const yaw = Math.atan2(rotation(q)[0][1], rotation(q)[0][0]);
      const upright = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
      const sign = q.reduce((sum, v, i) => sum + v * upright[i]!, 0) < 0 ? -1 : 1;
      q = q.map((v, i) => v + (upright[i]! * sign - v) * (1 - Math.exp(-18 * STEP)));
      const length = Math.hypot(...q);
      q = q.map((v) => v / length);
    }
    this.quaternion = q;
    const [r0, r1, r2] = rotation(q);
    this.goal = [c, r0, r1, r2];
    if (stiffness <= 0) return;
    for (let i = 0; i < count; i++) {
      const height = this.mesh.positions[i * 3 + 2]!;
      const ear = Math.max(0, Math.min(1, (height - 1.5) / 0.75));
      const head = Math.max(0, Math.min(1, (height - 0.9) / 0.65));
      const turn = this.attention * head;
      // Brief, offset ear adjustments; no per-frame randomness or continuous waving.
      const earTime = (this.time + (rest[i * 3]! > 0 ? 1.7 : 0)) % 9;
      const flick =
        this.animate && !this.grabbed && this.action === 'idle'
          ? 0.08 * Math.exp(-(((earTime - 0.8) / 0.14) ** 2)) * ear * ear
          : 0;
      const vertical = 1 - this.crouch * 0.16;
      const lateral = 1 / Math.sqrt(vertical);
      const rx =
        (rest[i * 3]! * Math.cos(turn) - rest[i * 3 + 1]! * Math.sin(turn)) * this.scale * lateral;
      const ry =
        (rest[i * 3]! * Math.sin(turn) + rest[i * 3 + 1]! * Math.cos(turn)) * this.scale * lateral +
        flick;
      const rz = rest[i * 3 + 2]! * this.scale * vertical;
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        const goal = c[a]! + r0[a]! * rx + r1[a]! * ry + r2[a]! * rz;
        x[k] = x[k]! + (goal - x[k]!) * stiffness * (1 - ear * 0.8);
      }
    }
  }

  private hold(grabbed: NonNullable<Body['grabbed']>): void {
    const { x } = this;
    for (let a = 0; a < 3; a++)
      grabbed.filtered[a] =
        grabbed.filtered[a]! +
        (grabbed.target[a]! - grabbed.filtered[a]!) * (1 - Math.exp(-30 * STEP));
    for (let j = 0; j < grabbed.rows.length; j++) {
      const i = grabbed.rows[j]!;
      const w = 0.16 * grabbed.weights[j]!;
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        const correction = (grabbed.filtered[a]! + grabbed.offsets[j * 3 + a]! - x[k]!) * w;
        x[k] = x[k]! + Math.max(-0.025, Math.min(0.025, correction));
      }
    }
  }

  private collide(): void {
    const { x, previous } = this;
    this.contacts = 0;
    let feet = 0;
    for (let i = 0; i < x.length; i += 3) {
      if (x[i + 2]! < 0.012) {
        this.contacts++;
        if (this.mesh.positions[i + 2]! < 0.25) feet++;
      }
      for (let a = 0; a < 2; a++) {
        const limit = x[i + a]! < 0 ? -ROOM : ROOM;
        if (Math.abs(x[i + a]!) <= ROOM) continue;
        const v = x[i + a]! - previous[i + a]!;
        x[i + a] = limit;
        previous[i + a] = limit + v * 0.4;
      }
      if (x[i + 2]! < 0) {
        const vz = x[i + 2]! - previous[i + 2]!;
        x[i + 2] = 0;
        previous[i + 2] = vz < -0.5 * STEP ? vz * 0.18 : 0;
        // Friction: keep a little of the sliding.
        previous[i] = x[i]! - (x[i]! - previous[i]!) * 0.55;
        previous[i + 1] = x[i + 1]! - (x[i + 1]! - previous[i + 1]!) * 0.55;
      } else if (x[i + 2]! > CEILING) {
        const vz = x[i + 2]! - previous[i + 2]!;
        x[i + 2] = CEILING;
        previous[i + 2] = CEILING + vz * 0.3;
      }
    }
    this.supported = feet >= 3 && this.goal[3][2] > 0.5;
  }

  private near(row: number, radius: number) {
    // Walk the rest surface: adjacent folded ears must not share a grab neighborhood.
    const distance = new Float64Array(this.count).fill(Infinity);
    distance[row] = 0;
    const queue = [row];
    for (let at = 0; at < queue.length; at++) {
      const current = queue[at]!;
      for (const edge of this.neighbors[current]!) {
        const d = distance[current]! + edge.length;
        if (d < radius && d < distance[edge.row]!) {
          distance[edge.row] = d;
          queue.push(edge.row);
        }
      }
    }
    const rows: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const d = distance[i]!;
      if (d < radius) {
        rows.push(i);
        weights.push((1 - d / radius) ** 2);
      }
    }
    return { rows: Uint32Array.from(rows), weights: Float64Array.from(weights) };
  }

  private distance(x: Float64Array, a: number, b: number): number {
    return Math.hypot(
      x[a * 3]! - x[b * 3]!,
      x[a * 3 + 1]! - x[b * 3 + 1]!,
      x[a * 3 + 2]! - x[b * 3 + 2]!,
    );
  }

  private center(x: Float64Array): Vec3 {
    const c: Vec3 = [0, 0, 0];
    for (let i = 0; i < x.length; i += 3) {
      c[0] += x[i]!;
      c[1] += x[i + 1]!;
      c[2] += x[i + 2]!;
    }
    return [c[0] / this.count, c[1] / this.count, c[2] / this.count];
  }
}
