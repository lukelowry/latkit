/**
 * A DC power flow. It computes each bus's voltage angle from its injection, with branches weighted
 * by their susceptance, and how the angles shift when one branch opens.
 */

/** A network of buses and the branches between them. Reactance is in per unit. */
export interface Network {
  readonly buses: number;
  readonly from: Uint32Array;
  readonly to: Uint32Array;
  readonly reactance: Float32Array;
}

/** The smallest reactance magnitude a branch is given, so no susceptance is infinite. */
const STIFFEST = 1e-4;

/** The network's susceptance matrix in compressed sparse rows, with the diagonal stored separately,
 * and each bus's island. */
class Susceptance {
  readonly start: Uint32Array;
  readonly column: Uint32Array;
  readonly weight: Float64Array;
  readonly diagonal: Float64Array;
  readonly island: Uint32Array;
  readonly net: Network;

  constructor(net: Network) {
    this.net = net;
    const { buses, from, to } = net;
    const degree = new Uint32Array(buses + 1);
    for (let e = 0; e < from.length; e++) {
      degree[from[e]! + 1]!++;
      degree[to[e]! + 1]!++;
    }
    for (let b = 0; b < buses; b++) degree[b + 1]! += degree[b]!;
    this.start = degree;
    this.column = new Uint32Array(degree[buses]!);
    this.weight = new Float64Array(degree[buses]!);
    this.diagonal = new Float64Array(buses);
    const fill = degree.slice(0, buses);
    for (let e = 0; e < from.length; e++) {
      const [a, c, w] = [from[e]!, to[e]!, this.susceptance(e)];
      this.column[fill[a]!] = c;
      this.weight[fill[a]!++] = w;
      this.column[fill[c]!] = a;
      this.weight[fill[c]!++] = w;
      this.diagonal[a]! += w;
      this.diagonal[c]! += w;
    }
    // Find the islands with union-find, so each one is balanced separately.
    const root = Uint32Array.from({ length: buses }, (_, b) => b);
    const find = (b: number): number => {
      while (root[b] !== b) b = root[b] = root[root[b]!]!;
      return b;
    };
    for (let e = 0; e < from.length; e++) root[find(from[e]!)] = find(to[e]!);
    this.island = Uint32Array.from({ length: buses }, (_, b) => find(b));
  }

  /** A branch's susceptance: the inverse of its reactance's magnitude, so series capacitors
   * (negative reactance) count by their size. */
  susceptance(e: number): number {
    return 1 / Math.max(Math.abs(this.net.reactance[e]!), STIFFEST);
  }

  /** Writes `B·v` into `out`. */
  times(v: Float64Array, out: Float64Array): void {
    for (let b = 0; b < v.length; b++) {
      let sum = this.diagonal[b]! * v[b]!;
      for (let k = this.start[b]!; k < this.start[b + 1]!; k++)
        sum -= this.weight[k]! * v[this.column[k]!]!;
      out[b] = sum;
    }
  }

  /** Returns `p` minus its island's mean, so every island's injections sum to zero. */
  balanced(p: Float64Array): Float64Array {
    const sum = new Float64Array(p.length);
    const count = new Float64Array(p.length);
    for (let b = 0; b < p.length; b++) {
      sum[this.island[b]!]! += p[b]!;
      count[this.island[b]!]!++;
    }
    const mean = sum.map((s, i) => (count[i] ? s / count[i] : 0));
    return p.map((v, b) => v - mean[this.island[b]!]!);
  }

  /** Solves `B·θ = p` for the angles `θ`, after balancing `p` per island, by conjugate gradients
   * with a diagonal (Jacobi) preconditioner. */
  solve(injection: Float64Array, tolerance = 1e-10): Float64Array {
    const n = injection.length;
    const p = this.balanced(injection);
    const theta = new Float64Array(n);
    const scale = this.diagonal.map((v) => 1 / v);
    const r = p.slice();
    const z = r.map((v, b) => v * scale[b]!);
    const d = z.slice();
    const bd = new Float64Array(n);
    const dot = (a: Float64Array, c: Float64Array) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += a[i]! * c[i]!;
      return sum;
    };
    let rz = dot(r, z);
    const goal = tolerance * tolerance * dot(p, p);
    for (let step = 0; step < 50 * n && dot(r, r) > goal; step++) {
      this.times(d, bd);
      const alpha = rz / dot(d, bd);
      for (let b = 0; b < n; b++) {
        theta[b]! += alpha * d[b]!;
        r[b]! -= alpha * bd[b]!;
        z[b] = r[b]! * scale[b]!;
      }
      const next = dot(r, z);
      for (let b = 0; b < n; b++) d[b] = z[b]! + (next / rz) * d[b]!;
      rz = next;
    }
    return theta;
  }
}

/** Returns each bus's angle in radians, given its injection in per unit. */
export function angles(net: Network, injection: Float64Array): Float64Array {
  return new Susceptance(net).solve(injection);
}

/**
 * Returns how each bus's angle shifts when `branch` opens, given the angles `theta` before. The
 * branch's flow moves onto the rest of the network, as if injected at one end and withdrawn at the
 * other.
 */
export function shifts(net: Network, theta: Float64Array, branch: number): Float64Array {
  const b = new Susceptance(net);
  const [i, j] = [net.from[branch]!, net.to[branch]!];
  const unit = new Float64Array(net.buses);
  unit[i] = 1;
  unit[j] = -1;
  const phi = b.solve(unit);
  const w = b.susceptance(branch);
  const flow = (theta[i]! - theta[j]!) * w;
  const share = (phi[i]! - phi[j]!) * w;
  return phi.map((v) => (v * flow) / (1 - share));
}
