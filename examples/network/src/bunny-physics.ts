import type { Mesh } from './bunny-mesh.js';

/** What the controls set; the body reads them every step. */
export interface Controls {
  /** Meters per second squared. */
  gravity: number;
  /** 0 is jelly, 1 is rubber: how hard the body pulls back to its shape. */
  firmness: number;
  /** The volume the body's pressure holds, as a share of its rest volume. */
  inflate: number;
  wind: boolean;
}
/** One step, in seconds. */
export const STEP = 1 / 240;
/** The walls stand this far from the center; the floor's grid reaches a little past them. */
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
 * A soft bunny: Verlet points held by springs along its edges, a pressure that keeps its volume,
 * and shape matching that pulls it back toward its rest shape, turned however it lies.
 */
export class SoftBody {
  readonly count: number;
  /** Positions now and one step ago, x, y, z per vertex. */
  readonly x: Float64Array;
  private readonly previous: Float64Array;
  /** Rest positions about the rest center. */
  private readonly rest: Float64Array;
  private readonly lengths: Float64Array;
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
  /** Seconds left flying apart, then how far it has pulled itself together, 0 to 1. */
  private scattered = 0;
  private gathered = 1;
  volume = 0;
  private grabbed?: {
    readonly rows: Uint32Array;
    readonly weights: Float64Array;
    readonly offsets: Float64Array;
    target: Vec3;
  };

  constructor(readonly mesh: Mesh) {
    const count = (this.count = mesh.count);
    this.x = Float64Array.from(mesh.positions);
    this.previous = Float64Array.from(mesh.positions);
    this.rest = Float64Array.from(mesh.positions);
    const center = this.center(this.rest);
    for (let i = 0; i < count * 3; i++) this.rest[i] = this.rest[i]! - center[i % 3]!;
    this.lengths = new Float64Array(mesh.edges.length / 2);
    for (let e = 0; e < this.lengths.length; e++)
      this.lengths[e] = this.distance(this.x, mesh.edges[e * 2]!, mesh.edges[e * 2 + 1]!);
    this.gradient = new Float64Array(count * 3);
    this.normals = new Float64Array(count * 3);
    this.restVolume = this.measure();
    this.volume = this.restVolume;
  }

  /** Advance by whole steps; returns how many ran. */
  advance(seconds: number, controls: Controls): number {
    const steps = Math.min(16, Math.floor(seconds / STEP));
    for (let s = 0; s < steps; s++) this.step(controls);
    return steps;
  }

  /** x, y, z, speed in meters per second, and strain in meters from its shape, per vertex. */
  sample(out: Float32Array): void {
    const n = this.count,
      [c, r0, r1, r2] = this.goal;
    for (let i = 0; i < n; i++) {
      const x = this.x[i * 3]!,
        y = this.x[i * 3 + 1]!,
        z = this.x[i * 3 + 2]!;
      out[i] = x;
      out[n + i] = y;
      out[2 * n + i] = z;
      out[3 * n + i] =
        Math.hypot(
          x - this.previous[i * 3]!,
          y - this.previous[i * 3 + 1]!,
          z - this.previous[i * 3 + 2]!,
        ) / STEP;
      const rx = this.rest[i * 3]!,
        ry = this.rest[i * 3 + 1]!,
        rz = this.rest[i * 3 + 2]!;
      out[4 * n + i] = Math.hypot(
        c[0] + r0[0] * rx + r1[0] * ry + r2[0] * rz - x,
        c[1] + r0[1] * rx + r1[1] * ry + r2[1] * rz - y,
        c[2] + r0[2] * rx + r1[2] * ry + r2[2] * rz - z,
      );
    }
  }

  /** Center height, mean speed, and volume as a share of rest, up to 2: scattered, it has none. */
  metrics(): [number, number, number] {
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
  /** Leap with a flip about the way it faces. */
  jump(): void {
    const c = this.center(this.x),
      facing = this.goal[1],
      axis = cross([0, 0, 1], facing),
      length = Math.hypot(...axis) || 1,
      spin = (Math.random() < 0.5 ? -7.5 : 7.5) / length;
    const omega: Vec3 = [axis[0] * spin, axis[1] * spin, axis[2] * spin];
    for (let i = 0; i < this.count; i++) {
      const r: Vec3 = [this.x[i * 3]! - c[0], this.x[i * 3 + 1]! - c[1], this.x[i * 3 + 2]! - c[2]];
      const v = cross(omega, r);
      this.push(i, [v[0] + facing[0] * 1.5, v[1] + facing[1] * 1.5, v[2] + 7]);
    }
  }
  /** Slam the top down onto the bottom. */
  squash(): void {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 2; i < this.count * 3; i += 3) {
      lo = Math.min(lo, this.x[i]!);
      hi = Math.max(hi, this.x[i]!);
    }
    for (let i = 0; i < this.count; i++)
      this.push(i, [0, 0, (-11 * (this.x[i * 3 + 2]! - lo)) / Math.max(hi - lo, 1e-6)]);
  }
  /** Fly apart for a moment, then pull back together. */
  explode(): void {
    const c = this.center(this.x);
    this.scattered = 1.1;
    this.gathered = 0;
    this.grabbed = undefined;
    for (let i = 0; i < this.count; i++) {
      const r: Vec3 = [this.x[i * 3]! - c[0], this.x[i * 3 + 1]! - c[1], this.x[i * 3 + 2]! - c[2]];
      const k = (3 + Math.random() * 2.5) / (Math.hypot(...r) || 1);
      this.push(i, [r[0] * k, r[1] * k, r[2] * k + 1.5 + Math.random() * 2]);
    }
  }
  /** Dent the surface around a vertex. */
  poke(row: number, speed = 6): void {
    const near = this.near(row, 0.7);
    for (let j = 0; j < near.rows.length; j++) {
      const i = near.rows[j]!,
        w = near.weights[j]! * speed;
      this.push(i, [
        -this.normals[i * 3]! * w,
        -this.normals[i * 3 + 1]! * w,
        -this.normals[i * 3 + 2]! * w,
      ]);
    }
  }
  /** Lift it high, turned at random unless `upright`, and let go. */
  drop(upright = false): void {
    const yaw = upright ? 0.6 : Math.random() * Math.PI * 2,
      tilt = upright ? 0 : (Math.random() - 0.5) * 0.9;
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw),
      ct = Math.cos(tilt),
      st = Math.sin(tilt);
    for (let i = 0; i < this.count; i++) {
      const rx = this.rest[i * 3]!,
        ry = this.rest[i * 3 + 1]!,
        rz = this.rest[i * 3 + 2]!;
      const tx = rx * ct + rz * st,
        tz = -rx * st + rz * ct;
      const p: Vec3 = [tx * cy - ry * sy, tx * sy + ry * cy, tz + 4.2];
      for (let a = 0; a < 3; a++) this.x[i * 3 + a] = this.previous[i * 3 + a] = p[a]!;
    }
    this.quaternion = [0, 0, 0, 1];
    this.scattered = 0;
    this.gathered = 1;
    this.grabbed = undefined;
  }
  /** Hold a vertex and the surface around it toward a point until released. */
  grab(row: number, target: Vec3): void {
    const near = this.near(row, 0.8);
    const offsets = new Float64Array(near.rows.length * 3);
    near.rows.forEach((i, j) => {
      for (let a = 0; a < 3; a++) offsets[j * 3 + a] = this.x[i * 3 + a]! - this.x[row * 3 + a]!;
    });
    this.grabbed = { ...near, offsets, target };
  }
  drag(target: Vec3): void {
    if (this.grabbed) this.grabbed.target = target;
  }
  release(): void {
    this.grabbed = undefined;
  }

  private step(controls: Controls): void {
    const { x, previous, count, normals } = this;
    const t = (this.time += STEP);
    if (this.scattered > 0) this.scattered -= STEP;
    else if (this.gathered < 1) this.gathered = Math.min(1, this.gathered + STEP / 1.5);
    const gust = controls.wind ? 16 : 0,
      wx = Math.cos(t * 0.4),
      wy = Math.sin(t * 0.4);
    const dt2 = STEP * STEP,
      damping = 0.9992;
    for (let i = 0; i < count; i++) {
      let ax = 0,
        ay = 0,
        az = -controls.gravity;
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
        const k = i * 3 + a,
          now = x[k]!;
        x[k] = now + (now - previous[k]!) * damping + (a === 0 ? ax : a === 1 ? ay : az) * dt2;
        previous[k] = now;
      }
    }
    const together = this.gathered;
    const firm = controls.firmness;
    if (together > 0) {
      this.springs((0.2 + 0.7 * firm) * together ** 3);
      this.pressure(0.6 * together ** 4, controls.inflate);
    } else this.measure();
    this.match(
      (0.0015 + 0.05 * firm * firm) * together + (together < 1 ? 0.025 * together : 0),
      together,
    );
    if (this.grabbed) this.hold(this.grabbed);
    this.collide();
  }

  private springs(stiffness: number): void {
    const { x, lengths } = this,
      edges = this.mesh.edges;
    for (let e = 0; e < lengths.length; e++) {
      const a = edges[e * 2]! * 3,
        b = edges[e * 2 + 1]! * 3;
      const dx = x[b]! - x[a]!,
        dy = x[b + 1]! - x[a + 1]!,
        dz = x[b + 2]! - x[a + 2]!;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) continue;
      const k = (0.5 * stiffness * (d - lengths[e]!)) / d;
      x[a] = x[a]! + dx * k;
      x[a + 1] = x[a + 1]! + dy * k;
      x[a + 2] = x[a + 2]! + dz * k;
      x[b] = x[b]! - dx * k;
      x[b + 1] = x[b + 1]! - dy * k;
      x[b + 2] = x[b + 2]! - dz * k;
    }
  }

  /** The enclosed volume, with its gradient per vertex and the normals it implies. */
  private measure(): number {
    const { x, gradient, normals } = this,
      triangles = this.mesh.triangles;
    gradient.fill(0);
    let volume = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t]! * 3,
        b = triangles[t + 1]! * 3,
        c = triangles[t + 2]! * 3;
      const ax = x[a]!,
        ay = x[a + 1]!,
        az = x[a + 2]!,
        bx = x[b]!,
        by = x[b + 1]!,
        bz = x[b + 2]!,
        cx = x[c]!,
        cy = x[c + 1]!,
        cz = x[c + 2]!;
      // Each corner's gradient is the cross product of the other two.
      const gax = by * cz - bz * cy,
        gay = bz * cx - bx * cz,
        gaz = bx * cy - by * cx;
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

  private pressure(stiffness: number, inflate: number): void {
    const volume = this.measure(),
      { x, gradient } = this;
    let norm = 0;
    for (let i = 0; i < gradient.length; i++) norm += (gradient[i]! / 6) ** 2;
    if (norm < 1e-12) return;
    const s = (stiffness * (this.restVolume * inflate - volume)) / norm / 6;
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + s * gradient[i]!;
  }

  /** Pull toward the rest shape, turned and moved to fit where the body is now. */
  private match(stiffness: number, together: number): void {
    const { x, rest, count } = this;
    const c = this.center(x);
    // A = sum of (x - c) times rest transposed, by columns.
    const A: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < count; i++) {
      const px = x[i * 3]! - c[0],
        py = x[i * 3 + 1]! - c[1],
        pz = x[i * 3 + 2]! - c[2];
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
      const s = Math.sin(w / 2) / (w / k),
        dq = [omega[0] * s, omega[1] * s, omega[2] * s, Math.cos(w / 2)];
      q = [
        dq[3]! * q[0]! + dq[0]! * q[3]! + dq[1]! * q[2]! - dq[2]! * q[1]!,
        dq[3]! * q[1]! - dq[0]! * q[2]! + dq[1]! * q[3]! + dq[2]! * q[0]!,
        dq[3]! * q[2]! + dq[0]! * q[1]! - dq[1]! * q[0]! + dq[2]! * q[3]!,
        dq[3]! * q[3]! - dq[0]! * q[0]! - dq[1]! * q[1]! - dq[2]! * q[2]!,
      ];
      const n = Math.hypot(...q);
      q = q.map((v) => v / n);
    }
    this.quaternion = q;
    const [r0, r1, r2] = rotation(q);
    this.goal = [c, r0, r1, r2];
    if (stiffness <= 0 || !together) return;
    for (let i = 0; i < count; i++) {
      const rx = rest[i * 3]!,
        ry = rest[i * 3 + 1]!,
        rz = rest[i * 3 + 2]!;
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a,
          goal = c[a]! + r0[a]! * rx + r1[a]! * ry + r2[a]! * rz;
        x[k] = x[k]! + (goal - x[k]!) * stiffness;
      }
    }
  }

  private hold(grabbed: NonNullable<SoftBody['grabbed']>): void {
    const { x } = this;
    for (let j = 0; j < grabbed.rows.length; j++) {
      const i = grabbed.rows[j]!,
        w = 0.45 * grabbed.weights[j]!;
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        x[k] = x[k]! + (grabbed.target[a]! + grabbed.offsets[j * 3 + a]! - x[k]!) * w;
      }
    }
  }

  private collide(): void {
    const { x, previous } = this;
    for (let i = 0; i < x.length; i += 3) {
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
        previous[i + 2] = vz * 0.3;
        // Friction: keep a little of the sliding.
        previous[i] = x[i]! - (x[i]! - previous[i]!) * 0.55;
        previous[i + 1] = x[i + 1]! - (x[i + 1]! - previous[i + 1]!) * 0.55;
      } else if (x[i + 2]! > CEILING) {
        const vz = x[i + 2]! - previous[i + 2]!;
        x[i + 2] = CEILING;
        previous[i + 2] = CEILING + vz * 0.3;
      }
    }
  }

  private near(row: number, radius: number) {
    const { x } = this,
      rows: number[] = [],
      weights: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const d = this.distance(x, row, i);
      if (d < radius) {
        rows.push(i);
        weights.push(1 - d / radius);
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
