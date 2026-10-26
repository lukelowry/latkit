import type { Mesh } from './mesh.js';
import { Burst } from './burst.js';

/** Settings from the page's controls. The body reads them every step. */
export interface Controls {
  /** Meters per second squared. */
  gravity: number;
  /** How strongly the body pulls back to its shape, from 0 (jelly) to 1 (rubber). */
  firmness: number;
  /** The volume the body's pressure keeps, as a fraction of its rest volume. */
  inflate: number;
  wind: boolean;
}

/** Per-vertex state at one step, one column per field, filled in place by {@link Body.sample}. */
export interface Frame {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Meters per second. */
  readonly speed: Float32Array;
  /** Meters between the vertex and its place in the rest shape the body is pulled toward. */
  readonly strain: Float32Array;
}

/** Length of one simulation step, in seconds. */
export const STEP = 1 / 120;
/** Distance from the center to each wall, in meters. */
export const ROOM = 3.6;
const CEILING = 6.5;
/** The body counts as still below this mean speed, in meters per second, and rests after staying
 * still for `REST_AFTER` seconds. */
const STILL = 0.02;
const REST_AFTER = 0.5;
/** Floor friction, scaled by how far a vertex sank into the floor this step. Static friction stops
 * a short slide, and kinetic friction slows a longer one. */
const STATIC_FRICTION = 0.8;
const KINETIC_FRICTION = 0.5;
/** Compliance of the bend constraints, as a multiple of the springs' compliance. */
const BEND = 12;
/** Fraction by which a full squash lowers the rest shape. The shape widens to keep its volume. */
const SQUASH = 0.29;
/** Cosine of the tilt from upright past which the bunny topples and stays down. */
const TIPPING = 0.6;
/** Rate, per second, at which a standing bunny's orientation returns to upright. */
const BALANCE = 18;

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** A vector's length. Same as `Math.hypot`, but much cheaper in the inner loops. */
const norm = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The rotation matrix of a unit quaternion [x, y, z, w], as its three columns. */
function rotation([x, y, z, w]: number[]): [Vec3, Vec3, Vec3] {
  return [
    [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + w! * z!), 2 * (x! * z! - w! * y!)],
    [2 * (x! * y! - w! * z!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + w! * x!)],
    [2 * (x! * z! + w! * y!), 2 * (y! * z! - w! * x!), 1 - 2 * (x! * x! + y! * y!)],
  ];
}

/**
 * A soft bunny, simulated with Verlet integration, compliant stretch, bend, and volume constraints,
 * and a pull toward its rest shape. It moves only when something acts on it and rests once still,
 * so a resting bunny needs no simulation steps until it is touched.
 */
export class Body {
  readonly count: number;
  /** Current positions, x, y, z per vertex. `previous` holds the positions one step earlier. */
  readonly x: Float64Array;
  private readonly previous: Float64Array;
  /** Rest positions relative to the rest shape's center. */
  private readonly rest: Float64Array;
  /** How closely each vertex follows the rest shape. The ears are softer and lag behind. */
  private readonly softness: Float64Array;
  /**
   * Distance constraints. Springs along every edge come first, then bends joining the two corners
   * opposite each edge. Each has two end vertices, a rest length, a compliance as a multiple of the
   * springs', and a Lagrange multiplier.
   */
  private readonly ends: Uint32Array;
  private readonly lengths: Float64Array;
  private readonly compliances: Float64Array;
  private readonly lambdas: Float64Array;
  private readonly inverseMass: Float64Array;
  private readonly neighbors: { row: number; length: number }[][];
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
  volume = 0;
  private contacts = 0;
  /** Seconds it has been still with nothing acting on it. */
  private still = 0;
  private scale = 1;
  /** How far squashed, from 0 to 1, and the simulated time until which the squash is held. */
  private squashing = 0;
  private squashUntil = -Infinity;
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
    // The ears, above 1.5 m, follow the rest shape loosely, and their tips most loosely.
    this.softness = Float64Array.from(
      { length: count },
      (_, i) => 1 - 0.8 * clamp((mesh.positions[i * 3 + 2]! - 1.5) / 0.75, 0, 1),
    );
    const { a, b } = mesh.springs;
    const ends: number[] = [];
    const lengths: number[] = [];
    const compliances: number[] = [];
    this.neighbors = Array.from({ length: count }, () => []);
    for (let e = 0; e < a.length; e++) {
      const length = this.distance(this.x, a[e]!, b[e]!);
      ends.push(a[e]!, b[e]!);
      lengths.push(length);
      compliances.push(1);
      this.neighbors[a[e]!]!.push({ row: b[e]!, length });
      this.neighbors[b[e]!]!.push({ row: a[e]!, length });
    }
    // Area-weighted mass avoids making dense parts of the scan artificially heavy. Each edge shared
    // by two faces adds a bend between its two opposite corners.
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
        if (other === undefined) {
          opposite.set(key, w);
          continue;
        }
        ends.push(other, w);
        lengths.push(this.distance(this.x, other, w));
        compliances.push(BEND);
      }
    }
    this.ends = Uint32Array.from(ends);
    this.lengths = Float64Array.from(lengths);
    this.compliances = Float64Array.from(compliances);
    this.lambdas = new Float64Array(lengths.length);
    const mean = mass.reduce((sum, v) => sum + v, 0) / count;
    this.inverseMass = Float64Array.from(mass, (m) => mean / Math.max(mean * 0.2, m));
    this.gradient = new Float64Array(count * 3);
    this.normals = new Float64Array(count * 3);
    this.restVolume = this.measure();
    this.volume = this.restVolume;
    this.burst = new Burst(mesh, ROOM, CEILING);
  }

  /** Creates a frame for {@link sample} to fill. Reuse it every step, since appending copies it. */
  frame(): Frame {
    const column = () => new Float32Array(this.count);
    return { x: column(), y: column(), z: column(), speed: column(), strain: column() };
  }

  /** Whether the body is resting: still, with nothing acting on it. It takes no steps until
   * woken. */
  get asleep(): boolean {
    return this.still >= REST_AFTER;
  }

  /** Wakes the body. Anything that acts on the body wakes it, and so should changed controls. */
  wake(): void {
    this.still = 0;
  }

  /** Advances by whole steps, at most 16, stopping once the body rests. Returns the steps taken. */
  advance(seconds: number, controls: Controls): number {
    const most = Math.min(16, Math.floor(seconds / STEP));
    let steps = 0;
    for (; steps < most && !this.asleep; steps++) this.step(controls);
    return steps;
  }

  /** Writes every vertex's current position, speed, and strain into `frame`. */
  sample(frame: Frame): void {
    const [c, r0, r1, r2] = this.goal;
    const [lateral, vertical] = this.shape();
    for (let i = 0; i < this.count; i++) {
      const x = this.x[i * 3]!;
      const y = this.x[i * 3 + 1]!;
      const z = this.x[i * 3 + 2]!;
      frame.x[i] = x;
      frame.y[i] = y;
      frame.z[i] = z;
      frame.speed[i] =
        norm(
          x - this.previous[i * 3]!,
          y - this.previous[i * 3 + 1]!,
          z - this.previous[i * 3 + 2]!,
        ) / STEP;
      // Strain is the distance from the inflated, squashed rest shape the body is pulled toward.
      const rx = this.rest[i * 3]! * lateral;
      const ry = this.rest[i * 3 + 1]! * lateral;
      const rz = this.rest[i * 3 + 2]! * vertical;
      frame.strain[i] = norm(
        c[0] + r0[0] * rx + r1[0] * ry + r2[0] * rz - x,
        c[1] + r0[1] * rx + r1[1] * ry + r2[1] * rz - y,
        c[2] + r0[2] * rx + r1[2] * ry + r2[2] * rz - z,
      );
    }
  }

  /** Returns the center height, the mean speed, and the volume as a fraction of the rest volume.
   * The volume is NaN while the body is in pieces. */
  metrics(): [number, number, number] {
    if (this.burst.active) {
      const chunks = this.burst.chunks;
      return [
        chunks.reduce((sum, c) => sum + c.position[2], 0) / chunks.length,
        chunks.reduce((sum, c) => sum + norm(...c.velocity), 0) / chunks.length,
        NaN,
      ];
    }
    let speed = 0;
    for (let i = 0; i < this.count * 3; i += 3)
      speed += norm(
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

  // Verlet keeps velocity as the step from the previous position to the current one, so an
  // impulse moves the previous position.
  private push(row: number, v: Vec3): void {
    for (let a = 0; a < 3; a++)
      this.previous[row * 3 + a] = this.previous[row * 3 + a]! - v[a]! * STEP;
  }

  /** Hops up and slightly forward if the body is on the floor. A `gentle` hop is lower. */
  hop(gentle = false): void {
    if (this.contacts === 0 || this.grabbed || this.burst.active) return;
    const facing = this.goal[1];
    const speed = gentle ? 2 : 3.8;
    for (let i = 0; i < this.count; i++) {
      const vz = (this.x[i * 3 + 2]! - this.previous[i * 3 + 2]!) / STEP;
      this.push(i, [facing[0] * 0.45, facing[1] * 0.45, Math.max(0, speed - vz)]);
    }
    // The body has left the floor, so presses before it lands do nothing.
    this.contacts = 0;
    this.wake();
  }

  /** Squashes the body until {@link endSquash} if `held`, else for 0.3 s. The material makes the
   * rebound. */
  squash(held = false): void {
    if (this.burst.active || this.grabbed) return;
    this.squashUntil = held ? Infinity : this.time + 0.3;
    this.wake();
  }

  endSquash(): void {
    if (this.squashUntil === Infinity) this.squashUntil = this.time;
  }

  /** Pops the body into capped pieces, which fly less if `gentle`. Called while the body is in
   * pieces, it gathers them back. */
  pop(gentle = false): void {
    if (this.burst.active) return this.burst.gather();
    this.release();
    this.squashUntil = -Infinity;
    this.squashing = 0;
    const yaw = Math.atan2(this.goal[1][1], this.goal[1][0]);
    this.burst.start(this.x, this.previous, STEP, yaw, gentle, this.scale);
    this.wake();
  }

  /** Dents the surface around vertex `row`. */
  poke(row: number, speed = 6): void {
    if (this.burst.active) return;
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
    this.wake();
  }

  /** Lifts the body high, turned at random unless `upright`, and lets go. */
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
    this.squashUntil = -Infinity;
    this.squashing = 0;
    this.contacts = 0;
    this.grabbed = undefined;
    this.match(0);
    this.measure();
    this.wake();
  }

  /** Pulls vertex `row` and the surface around it toward `target` until released. */
  grab(row: number, target: readonly number[]): void {
    if (this.burst.active) return;
    this.squashUntil = -Infinity;
    const near = this.near(row, 0.65);
    const offsets = new Float64Array(near.rows.length * 3);
    near.rows.forEach((i, j) => {
      for (let a = 0; a < 3; a++) offsets[j * 3 + a] = this.x[i * 3 + a]! - this.x[row * 3 + a]!;
    });
    const point: Vec3 = [target[0]!, target[1]!, target[2]!];
    this.grabbed = { ...near, offsets, target: point, filtered: [...point] };
    this.wake();
  }

  drag(target: readonly number[]): void {
    if (this.grabbed)
      this.grabbed.target = [
        clamp(target[0]!, -ROOM, ROOM),
        clamp(target[1]!, -ROOM, ROOM),
        clamp(target[2]!, 0.1, CEILING - 0.2),
      ];
  }

  release(cancelled = false): void {
    if (!this.grabbed) return;
    if (cancelled) this.previous.set(this.x);
    this.grabbed = undefined;
    this.wake();
  }

  get state(): string {
    if (this.burst.active) return this.burst.gathering ? 'gathering' : 'tumbling';
    if (this.grabbed) return 'held';
    if (this.squashing > 0.01) return 'squashed';
    if (this.contacts === 0) return 'airborne';
    if (!this.asleep) return 'settling';
    return this.goal[3][2] > TIPPING ? 'resting' : 'toppled';
  }

  private step(controls: Controls): void {
    this.time += STEP;
    if (this.burst.active) {
      if (this.burst.step(STEP, controls.gravity)) {
        this.x.set(this.burst.targetBody);
        this.previous.set(this.x);
        this.match(0);
        this.measure();
      }
      this.still = 0;
      return;
    }
    this.integrate(controls);
    this.scale = Math.cbrt(controls.inflate);
    const squashed = this.time < this.squashUntil ? 1 : 0;
    this.squashing += (squashed - this.squashing) * (1 - Math.exp(-20 * STEP));
    this.solve(controls);
    this.match(1 - Math.exp(-(1.2 + 6 * controls.firmness * controls.firmness) * STEP));
    if (this.grabbed) this.hold(this.grabbed);
    const speed = this.collide();
    const falling = this.contacts === 0 && controls.gravity > 0;
    const acting = controls.wind || !!this.grabbed || this.squashing > 0.01 || falling;
    this.still = !acting && speed < STILL ? this.still + STEP : 0;
  }

  /** Moves every vertex on by its damped velocity from the last step, plus gravity and wind. */
  private integrate(controls: Controls): void {
    const { x, previous, count, normals } = this;
    const t = this.time;
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
        const velocity = clamp(now - previous[k]!, -10 * STEP, 10 * STEP);
        x[k] = now + velocity * damping + (a === 0 ? ax : a === 1 ? ay : az) * dt2;
        previous[k] = now;
      }
    }
  }

  /** Runs three iterations of every distance constraint and the pressure, then updates the
   * normals. */
  private solve(controls: Controls): void {
    const compliance = 1e-7 * 10 ** (3 * (1 - controls.firmness));
    this.lambdas.fill(0);
    this.volumeLambda = 0;
    for (let iteration = 0; iteration < 3; iteration++) {
      this.distances(compliance);
      this.pressure(1e-8, controls.inflate);
    }
    this.normalize();
  }

  /** Pulls every spring and bend toward its rest length, scaled by the inflation. */
  private distances(compliance: number): void {
    const { x, ends, lengths, compliances, lambdas, inverseMass, scale } = this;
    const alpha = compliance / (STEP * STEP);
    for (let e = 0; e < lengths.length; e++) {
      const a = ends[e * 2]!;
      const b = ends[e * 2 + 1]!;
      const ia = a * 3;
      const ib = b * 3;
      const dx = x[ia]! - x[ib]!;
      const dy = x[ia + 1]! - x[ib + 1]!;
      const dz = x[ia + 2]! - x[ib + 2]!;
      const length = norm(dx, dy, dz);
      if (length < 1e-9) continue;
      const wa = inverseMass[a]!;
      const wb = inverseMass[b]!;
      const compliant = alpha * compliances[e]!;
      const delta =
        (-(length - lengths[e]! * scale) - compliant * lambdas[e]!) / (wa + wb + compliant);
      lambdas[e] = lambdas[e]! + delta;
      const k = delta / length;
      x[ia] = x[ia]! + wa * dx * k;
      x[ia + 1] = x[ia + 1]! + wa * dy * k;
      x[ia + 2] = x[ia + 2]! + wa * dz * k;
      x[ib] = x[ib]! - wb * dx * k;
      x[ib + 1] = x[ib + 1]! - wb * dy * k;
      x[ib + 2] = x[ib + 2]! - wb * dz * k;
    }
  }

  /** Computes the enclosed volume, its gradient per vertex, and the normals from that gradient. */
  private measure(): number {
    const volume = this.enclose();
    this.normalize();
    return volume;
  }

  /** Computes the enclosed volume and its gradient per vertex. */
  private enclose(): number {
    const { x, gradient } = this;
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
    return (this.volume = volume / 6);
  }

  /** Sets the unit outward normals from the last volume gradient. */
  private normalize(): void {
    const { gradient, normals } = this;
    for (let i = 0; i < gradient.length; i += 3) {
      const length = norm(gradient[i]!, gradient[i + 1]!, gradient[i + 2]!) || 1;
      normals[i] = gradient[i]! / length;
      normals[i + 1] = gradient[i + 1]! / length;
      normals[i + 2] = gradient[i + 2]! / length;
    }
  }

  /** Pulls the enclosed volume toward `inflate` times the rest volume. */
  private pressure(compliance: number, inflate: number): void {
    const volume = this.enclose();
    const { x, gradient, inverseMass, count } = this;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const g = norm(gradient[i * 3]!, gradient[i * 3 + 1]!, gradient[i * 3 + 2]!) / 6;
      sum += inverseMass[i]! * g * g;
    }
    if (sum < 1e-12) return;
    const alpha = compliance / (STEP * STEP);
    const delta = (this.restVolume * inflate - volume - alpha * this.volumeLambda) / (sum + alpha);
    this.volumeLambda += delta;
    for (let i = 0; i < count; i++) {
      const k = (delta * inverseMass[i]!) / 6;
      x[i * 3] = x[i * 3]! + k * gradient[i * 3]!;
      x[i * 3 + 1] = x[i * 3 + 1]! + k * gradient[i * 3 + 1]!;
      x[i * 3 + 2] = x[i * 3 + 2]! + k * gradient[i * 3 + 2]!;
    }
  }

  /** The rest shape's sideways and vertical scale, with the inflation and a squash that keeps the
   * volume. */
  private shape(): [number, number] {
    const squashed = 1 - SQUASH * this.squashing;
    return [this.scale / Math.sqrt(squashed), this.scale * squashed];
  }

  /** Pulls the body toward its rest shape, rotated and moved to best fit the current positions. */
  private match(stiffness: number): void {
    const { x, rest, count, softness } = this;
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
    // Find the rotation nearest A (Müller et al. 2016), warm started from the last step.
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
      const w = norm(omega[0], omega[1], omega[2]) * k;
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
    // Shape matching reads part of gravity's sag as a rotation, which alone would roll the bunny
    // over. Short of the tipping point, the rotation eases back upright at the same heading. Past
    // it, the bunny lies where it fell.
    if (stiffness > 0 && this.contacts > 8 && !this.grabbed && rotation(q)[2][2] > TIPPING) {
      const heading = rotation(q)[0];
      const yaw = Math.atan2(heading[1], heading[0]);
      const upright = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
      const sign = q.reduce((sum, v, i) => sum + v * upright[i]!, 0) < 0 ? -1 : 1;
      const k = 1 - Math.exp(-BALANCE * STEP);
      q = q.map((v, i) => v + (upright[i]! * sign - v) * k);
      const length = Math.hypot(...q);
      q = q.map((v) => v / length);
    }
    this.quaternion = q;
    const [r0, r1, r2] = rotation(q);
    this.goal = [c, r0, r1, r2];
    if (stiffness <= 0) return;
    const [lateral, vertical] = this.shape();
    for (let i = 0; i < count; i++) {
      const rx = rest[i * 3]! * lateral;
      const ry = rest[i * 3 + 1]! * lateral;
      const rz = rest[i * 3 + 2]! * vertical;
      const k = stiffness * softness[i]!;
      for (let a = 0; a < 3; a++) {
        const goal = c[a]! + r0[a]! * rx + r1[a]! * ry + r2[a]! * rz;
        x[i * 3 + a] = x[i * 3 + a]! + (goal - x[i * 3 + a]!) * k;
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
        x[k] = x[k]! + clamp(correction, -0.025, 0.025);
      }
    }
  }

  /** Collides with the floor (with friction), the ceiling, then the walls. Returns the mean speed
   * this step. */
  private collide(): number {
    const { x, previous } = this;
    let contacts = 0;
    let travel = 0;
    for (let i = 0; i < x.length; i += 3) {
      // The floor comes first, since friction needs the vertex's previous position before a wall
      // bounce rewrites it.
      if (x[i + 2]! < 0) {
        const depth = -x[i + 2]!;
        const vz = x[i + 2]! - previous[i + 2]!;
        x[i + 2] = 0;
        previous[i + 2] = vz < -0.5 * STEP ? vz * 0.18 : 0;
        // Friction acts on this step's movement along the floor, so pushes from the springs or
        // the rest shape cannot ratchet the body across it.
        const tx = x[i]! - previous[i]!;
        const ty = x[i + 1]! - previous[i + 1]!;
        const slide = Math.sqrt(tx * tx + ty * ty);
        if (slide <= STATIC_FRICTION * depth) {
          x[i] = previous[i]!;
          x[i + 1] = previous[i + 1]!;
        } else {
          const k = (KINETIC_FRICTION * depth) / slide;
          x[i] = x[i]! - tx * k;
          x[i + 1] = x[i + 1]! - ty * k;
        }
      } else if (x[i + 2]! > CEILING) {
        const vz = x[i + 2]! - previous[i + 2]!;
        x[i + 2] = CEILING;
        previous[i + 2] = CEILING + vz * 0.3;
      }
      for (let a = 0; a < 2; a++) {
        const limit = x[i + a]! < 0 ? -ROOM : ROOM;
        if (Math.abs(x[i + a]!) <= ROOM) continue;
        const v = x[i + a]! - previous[i + a]!;
        x[i + a] = limit;
        previous[i + a] = limit + v * 0.4;
      }
      if (x[i + 2]! < 0.012) contacts++;
      travel += norm(
        x[i]! - previous[i]!,
        x[i + 1]! - previous[i + 1]!,
        x[i + 2]! - previous[i + 2]!,
      );
    }
    this.contacts = contacts;
    return travel / this.count / STEP;
  }

  private near(row: number, radius: number) {
    // Search along the rest surface's edges, not through space, so ears folded against each other
    // do not share a grab neighborhood.
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
    return norm(
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
