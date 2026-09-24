/**
 * A stand-in for playback: each signal's deviation from its initial value, a disturbance that
 * rings down and recurs, with every plant swinging at its own mode. Buses carry no value.
 */

import { SIGNAL } from './classes.js';
import type { Built } from './document.js';

/** Seconds between disturbances. */
const PERIOD = 12;
/** Ring-down time constant, in seconds. */
const DECAY = 2.5;

/** A well-mixed hash of an index into [0, 1). */
function hash(i: number): number {
  let x = Math.imul(i + 1, 0x9e3779b1);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 0x100000000;
}

/** Per-net values for one netlist: `netColor` deviations in [-1, 1] and a constant `netFlow`. */
export class Simulation {
  /** `netFlow`: signals march from their driver; buses are tags and stand still. */
  readonly flow: Float32Array;
  readonly #color: Float32Array;
  readonly #amplitude: Float32Array;
  readonly #frequency: Float32Array;
  readonly #phase: Float32Array;

  constructor(built: Built) {
    const { netlist, netKind, portDevice } = built;
    const count = netKind.length;
    this.flow = new Float32Array(count);
    this.#color = new Float32Array(count);
    this.#amplitude = new Float32Array(count);
    this.#frequency = new Float32Array(count);
    this.#phase = new Float32Array(count);
    for (let n = 0; n < count; n++) {
      if (netKind[n] !== SIGNAL) continue;
      const first = netlist.netPorts[netlist.netStart[n]!];
      if (first === undefined) continue;
      // Signals of one plant share its electromechanical mode.
      const block = portDevice[first]!;
      const group = netlist.blockGroup?.[block];
      const mode = group === undefined || group === 0xffffffff ? 0x40000000 + block : group;
      this.flow[n] = 1;
      this.#amplitude[n] = 0.45 + 0.55 * hash(n * 7 + 3);
      this.#frequency[n] = 0.35 + 0.9 * hash(mode);
      this.#phase[n] = 2 * Math.PI * hash(n);
    }
  }

  /** The deviations at `timeMs`; the same array every call. */
  at(timeMs: number): Float32Array {
    const t = timeMs / 1000;
    const since = t % PERIOD;
    const envelope = 0.2 + 0.8 * Math.exp(-since / DECAY);
    const color = this.#color;
    for (let n = 0; n < color.length; n++) {
      color[n] =
        this.#amplitude[n]! *
        envelope *
        Math.sin(2 * Math.PI * this.#frequency[n]! * t + this.#phase[n]!);
    }
    return color;
  }
}
