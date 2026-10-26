import type { Frame } from './body.js';
import { fracture, type Piece, type Vec3 } from './fracture.js';
import type { Mesh } from './mesh.js';

interface Chunk {
  piece: Piece;
  offset: number;
  position: Vec3;
  target: Vec3;
  velocity: Vec3;
  spin: Vec3;
  rotation: [number, number, number, number];
  local: Float64Array;
  rest: Float64Array;
  radius: number;
  mass: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The body popped into independent capped pieces, which no original triangle or spring
 * connects. */
export class Burst {
  readonly chunks: Chunk[];
  readonly count: number;
  readonly faces: Mesh['faces'];
  readonly x: Float64Array;
  readonly targetBody: Float64Array;
  private readonly previous: Float64Array;
  private age = 0;
  private returnAt = 1.8;
  private reduced = false;
  active = false;

  constructor(
    private readonly mesh: Mesh,
    private readonly room: number,
    private readonly ceiling: number,
  ) {
    let count = 0;
    const a: number[] = [],
      b: number[] = [],
      c: number[] = [];
    this.chunks = fracture(mesh).map((piece) => {
      const offset = count;
      for (const face of piece.faces) {
        a.push(face[0] + offset);
        b.push(face[1] + offset);
        c.push(face[2] + offset);
      }
      count += piece.vertices.length;
      return {
        piece,
        offset,
        position: [0, 0, 0],
        target: [0, 0, 0],
        velocity: [0, 0, 0],
        spin: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        radius: 0,
        mass: 1,
        local: new Float64Array(piece.vertices.length * 3),
        rest: new Float64Array(piece.vertices.length * 3),
      };
    });
    this.count = count;
    this.faces = { a: Uint32Array.from(a), b: Uint32Array.from(b), c: Uint32Array.from(c) };
    this.x = new Float64Array(count * 3);
    this.previous = new Float64Array(count * 3);
    this.targetBody = new Float64Array(mesh.count * 3);
  }

  start(
    x: Float64Array,
    previous: Float64Array,
    dt: number,
    yaw: number,
    reduced: boolean,
    scale = 1,
  ): void {
    this.active = true;
    this.age = 0;
    this.returnAt = reduced ? 0.95 : 1.8;
    this.reduced = reduced;
    const center: Vec3 = [0, 0, 0];
    for (let i = 0; i < x.length; i++) center[i % 3] = center[i % 3]! + x[i]! / this.mesh.count;
    const cx = clamp(center[0], -this.room + 1.7, this.room - 1.7);
    const cy = clamp(center[1], -this.room + 1.7, this.room - 1.7);
    const cos = Math.cos(yaw),
      sin = Math.sin(yaw);
    for (let i = 0; i < x.length; i += 3) {
      const rx = this.mesh.positions[i]! * scale,
        ry = this.mesh.positions[i + 1]! * scale;
      this.targetBody[i] = cx + rx * cos - ry * sin;
      this.targetBody[i + 1] = cy + rx * sin + ry * cos;
      this.targetBody[i + 2] = this.mesh.positions[i + 2]! * scale + 0.025;
    }
    // Seeded random variation, sampled only at launch. Replay records the resulting positions.
    let seed = 0x12b9;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (const chunk of this.chunks) {
      chunk.position = [0, 0, 0];
      chunk.target = [0, 0, 0];
      chunk.velocity = [0, 0, 0];
      chunk.rotation = [0, 0, 0, 1];
      const n = chunk.piece.vertices.length;
      for (let j = 0; j < n; j++) {
        const { weights } = chunk.piece.vertices[j]!;
        for (let axis = 0; axis < 3; axis++) {
          let value = 0,
            goal = 0,
            velocity = 0;
          for (const [row, weight] of weights) {
            const k = row * 3 + axis;
            value += x[k]! * weight;
            goal += this.targetBody[k]! * weight;
            velocity += ((x[k]! - previous[k]!) / dt) * weight;
          }
          chunk.local[j * 3 + axis] = value;
          chunk.rest[j * 3 + axis] = goal;
          chunk.position[axis] = chunk.position[axis]! + value / n;
          chunk.target[axis] = chunk.target[axis]! + goal / n;
          chunk.velocity[axis] = chunk.velocity[axis]! + velocity / n;
        }
      }
      chunk.radius = 0;
      for (let j = 0; j < n; j++) {
        for (let axis = 0; axis < 3; axis++) {
          chunk.local[j * 3 + axis] = chunk.local[j * 3 + axis]! - chunk.position[axis]!;
          chunk.rest[j * 3 + axis] = chunk.rest[j * 3 + axis]! - chunk.target[axis]!;
        }
        chunk.radius = Math.max(
          chunk.radius,
          Math.hypot(...chunk.local.subarray(j * 3, j * 3 + 3)),
        );
      }
      chunk.mass = Math.max(0.02, chunk.radius ** 3);
      const dx = chunk.position[0] - center[0],
        dy = chunk.position[1] - center[1];
      const angle =
        (Math.hypot(dx, dy) > 0.05 ? Math.atan2(dy, dx) : random() * Math.PI * 2) +
        (random() - 0.5) * 0.7;
      const strength = (3.2 + random() * 1.2) * (reduced ? 0.45 : 1);
      // Separate lift from radial spread, so pieces already moving down cannot cancel the pop.
      chunk.velocity[0] = clamp(chunk.velocity[0] * 0.35, -1.2, 1.2) + Math.cos(angle) * strength;
      chunk.velocity[1] = clamp(chunk.velocity[1] * 0.35, -1.2, 1.2) + Math.sin(angle) * strength;
      chunk.velocity[2] =
        clamp(chunk.velocity[2] * 0.35, 0, 1.2) + (reduced ? 1.8 : 4.2) + random() * 0.8;
      for (let a = 0; a < 3; a++) {
        chunk.spin[a] = (random() - 0.5) * (reduced ? 0.5 : 5);
      }
    }
    this.writeVertices(0);
    this.previous.set(this.x);
  }

  gather(): void {
    // Defer early requests, including key repeats, until the pieces have visibly separated.
    if (this.active)
      this.returnAt = Math.min(this.returnAt, Math.max(this.age, this.reduced ? 0.5 : 0.9));
  }

  get gathering(): boolean {
    return this.age >= this.returnAt;
  }

  reset(): void {
    this.active = false;
  }

  /** Advances one step. Returns true on the step that finishes reassembly. */
  step(dt: number, gravity: number): boolean {
    if (!this.active) return false;
    this.previous.set(this.x);
    this.age += dt;
    let settled = true;
    for (let id = 0; id < this.chunks.length; id++) {
      const chunk = this.chunks[id]!;
      const returning = this.age >= this.returnAt + this.delay(chunk);
      if (returning) {
        const frequency = this.reduced ? 14 : 10;
        const decay = Math.exp(-frequency * dt);
        for (let a = 0; a < 3; a++) {
          const error = chunk.position[a]! - chunk.target[a]!;
          const combined = chunk.velocity[a]! + frequency * error;
          chunk.position[a] = chunk.target[a]! + (error + combined * dt) * decay;
          chunk.velocity[a] = (chunk.velocity[a]! - frequency * combined * dt) * decay;
        }
        // Shortest-path rotational spring toward the captured world-space orientation.
        if (chunk.rotation[3] < 0)
          chunk.rotation = chunk.rotation.map((v) => -v) as Chunk['rotation'];
        const length = Math.hypot(...chunk.rotation.slice(0, 3));
        const angle = 2 * Math.atan2(length, chunk.rotation[3]);
        for (let a = 0; a < 3; a++) {
          const error = length > 1e-8 ? (-chunk.rotation[a]! / length) * angle : 0;
          chunk.spin[a] = chunk.spin[a]! + (100 * error - 20 * chunk.spin[a]!) * dt;
        }
        if (
          angle > 0.015 ||
          Math.hypot(...chunk.velocity) > 0.04 ||
          Math.hypot(...chunk.position.map((v, a) => v - chunk.target[a]!)) > 0.004
        )
          settled = false;
      } else {
        settled = false;
        chunk.velocity[2] -= gravity * dt;
        for (let a = 0; a < 3; a++) {
          chunk.velocity[a] = chunk.velocity[a]! * Math.exp(-0.5 * dt);
          chunk.position[a] = chunk.position[a]! + chunk.velocity[a]! * dt;
        }
      }
      this.rotate(chunk, dt);
    }
    // Soft sphere proxies push tumbling pieces apart. They stop once the return starts, so the
    // seams can close.
    if (this.age < this.returnAt) this.separate();
    this.writeVertices(dt);
    if (settled && this.age > this.returnAt + 1.1) {
      this.active = false;
      return true;
    }
    return false;
  }

  frame(): Frame {
    const column = () => new Float32Array(this.count);
    return { x: column(), y: column(), z: column(), speed: column(), strain: column() };
  }

  sample(frame: Frame, dt: number): void {
    for (let i = 0; i < this.count; i++) {
      frame.x[i] = this.x[i * 3]!;
      frame.y[i] = this.x[i * 3 + 1]!;
      frame.z[i] = this.x[i * 3 + 2]!;
      frame.speed[i] =
        Math.hypot(
          this.x[i * 3]! - this.previous[i * 3]!,
          this.x[i * 3 + 1]! - this.previous[i * 3 + 1]!,
          this.x[i * 3 + 2]! - this.previous[i * 3 + 2]!,
        ) / dt;
      frame.strain[i] = 0;
    }
  }

  private delay(chunk: Chunk): number {
    return this.reduced ? 0 : Math.max(0, chunk.target[2] - 0.7) * 0.12;
  }

  private rotate(chunk: Chunk, dt: number): void {
    const speed = Math.hypot(...chunk.spin);
    if (speed < 1e-8) return;
    const s = Math.sin((speed * dt) / 2) / speed;
    const [ax, ay, az] = chunk.spin.map((v) => v * s) as Vec3;
    const w = Math.cos((speed * dt) / 2);
    const [x, y, z, qw] = chunk.rotation;
    const q: Chunk['rotation'] = [
      w * x + ax * qw + ay * z - az * y,
      w * y - ax * z + ay * qw + az * x,
      w * z + ax * y - ay * x + az * qw,
      w * qw - ax * x - ay * y - az * z,
    ];
    const norm = Math.hypot(...q);
    chunk.rotation = q.map((v) => v / norm) as Chunk['rotation'];
  }

  private separate(): void {
    for (let i = 0; i < this.chunks.length; i++)
      for (let j = i + 1; j < this.chunks.length; j++) {
        const a = this.chunks[i]!,
          b = this.chunks[j]!;
        const delta = b.position.map((v, k) => v - a.position[k]!) as Vec3;
        const length = Math.hypot(...delta);
        const overlap = (a.radius + b.radius) * 0.52 - length;
        if (overlap <= 0 || length < 1e-8) continue;
        const wa = 1 / a.mass,
          wb = 1 / b.mass;
        const relative = delta.reduce(
          (v, d, k) => v + (d / length) * (b.velocity[k]! - a.velocity[k]!),
          0,
        );
        const impulse = (Math.max(0, -relative) * 1.15) / (wa + wb);
        for (let k = 0; k < 3; k++) {
          const n = delta[k]! / length;
          a.position[k] = a.position[k]! - (n * overlap * wa) / (wa + wb);
          b.position[k] = b.position[k]! + (n * overlap * wb) / (wa + wb);
          a.velocity[k] = a.velocity[k]! - n * impulse * wa;
          b.velocity[k] = b.velocity[k]! + n * impulse * wb;
        }
      }
  }

  private writeVertices(dt: number): void {
    for (const chunk of this.chunks) {
      const blend = clamp((this.age - this.returnAt - this.delay(chunk)) / 0.6, 0, 1);
      const smooth = blend * blend * (3 - 2 * blend);
      const [qx, qy, qz, qw] = chunk.rotation;
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      for (let j = 0; j < chunk.piece.vertices.length; j++) {
        const k = j * 3;
        const x = chunk.local[k]! * (1 - smooth) + chunk.rest[k]! * smooth;
        const y = chunk.local[k + 1]! * (1 - smooth) + chunk.rest[k + 1]! * smooth;
        const z = chunk.local[k + 2]! * (1 - smooth) + chunk.rest[k + 2]! * smooth;
        const tx = 2 * (qy * z - qz * y),
          ty = 2 * (qz * x - qx * z),
          tz = 2 * (qx * y - qy * x);
        const p = [
          x + qw * tx + qy * tz - qz * ty,
          y + qw * ty + qz * tx - qx * tz,
          z + qw * tz + qx * ty - qy * tx,
        ];
        for (let a = 0; a < 3; a++) {
          const value = p[a]! + chunk.position[a]!;
          this.x[(chunk.offset + j) * 3 + a] = value;
          lo[a] = Math.min(lo[a]!, value);
          hi[a] = Math.max(hi[a]!, value);
        }
      }
      for (let a = 0; a < 3; a++) {
        const min = a === 2 ? 0 : -this.room,
          max = a === 2 ? this.ceiling : this.room;
        const shift = lo[a]! < min ? min - lo[a]! : hi[a]! > max ? max - hi[a]! : 0;
        if (!shift) continue;
        chunk.position[a] = chunk.position[a]! + shift;
        if (chunk.velocity[a]! * shift < 0)
          chunk.velocity[a] = chunk.velocity[a]! * (Math.abs(chunk.velocity[a]!) > 0.5 ? -0.25 : 0);
        if (a === 2) {
          const friction = Math.exp(-9 * dt);
          chunk.velocity[0] *= friction;
          chunk.velocity[1] *= friction;
          chunk.spin = chunk.spin.map((v) => v * friction) as Vec3;
        }
        for (let j = 0; j < chunk.piece.vertices.length; j++) {
          const k = (chunk.offset + j) * 3 + a;
          this.x[k] = this.x[k]! + shift;
        }
      }
    }
  }
}
