/**
 * Scenes: case documents built from the plant shapes GridKit's TwoArea and WECC cases use. Every
 * plant sits on a bus (a tag net) and names its signals corpus-style, `1_1_speed`.
 */

import type { ClassName } from './classes.js';
import type { Device, Structure } from './document.js';

/** The plant shapes scenes are made of. */
export type Plant = 'steam' | 'steamPss' | 'classical' | 'renewable';

/** One scene button. */
export interface SceneOption {
  readonly id: string;
  readonly label: string;
  readonly build: () => Structure;
}

/** Accumulates devices, signals and buses. */
class Case {
  readonly devices: Device[] = [];
  readonly signals = new Map<number, string>();
  readonly buses = new Map<number, string>();
  #plantsOnBus = new Map<number, number>();

  constructor(readonly scene: string) {}

  /** Add one plant on `bus`, named `<bus>_<k>` for its `k`-th plant there. */
  plant(shape: Plant, bus: number): void {
    const k = (this.#plantsOnBus.get(bus) ?? 0) + 1;
    this.#plantsOnBus.set(bus, k);
    if (!this.buses.has(bus)) this.buses.set(bus, `bus_${bus}`);
    const prefix = `${bus}_${k}`;
    const signal = (name: string): number => {
      const id = this.signals.size + 1;
      this.signals.set(id, `${prefix}_${name}`);
      return id;
    };
    const add = (cls: ClassName, ports: Record<string, number>): void => {
      this.devices.push({ cls, id: `${prefix}_${cls.toLowerCase()}`, ports });
    };
    switch (shape) {
      case 'classical':
        add('GENCLS', { bus });
        return;
      case 'steam':
      case 'steamPss': {
        const pmech = signal('pmech');
        const efd = signal('efd');
        const speed = signal('speed');
        add('GENROU', { bus, pmech, efd, speed });
        add('TGOV1', { speed, pmech });
        if (shape === 'steam') {
          add('IEEET1', { bus, speed, efd });
          return;
        }
        const vs = signal('vs');
        add('IEEET1', { bus, speed, vs, efd });
        add('IEEEST', { input: speed, output: vs });
        return;
      }
      case 'renewable': {
        const ipcmd = signal('ipcmd');
        const iqcmd = signal('iqcmd');
        const ibranchr = signal('ibranchr');
        const ibranchi = signal('ibranchi');
        const pbranch = signal('pbranch');
        const qbranch = signal('qbranch');
        const pext = signal('pext');
        const qext = signal('qext');
        add('REGCA', { bus, ipcmd, iqcmd, ibranchr, ibranchi, pbranch, qbranch });
        add('REECB', { bus, pe: pbranch, qgen: qbranch, qext, pref: pext, iqcmd, ipcmd });
        add('REPCA', { bus, ir: ibranchr, ii: ibranchi, p: pbranch, q: qbranch, qext, pext });
        return;
      }
    }
  }

  done(): Structure {
    const { scene, devices, signals, buses } = this;
    return { scene, devices, signals, buses };
  }
}

/** A seeded linear congruential generator in [0, 1), so scenes are the same on every visit. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** One TwoArea generator unit: GENROU with its TGOV1 governor and IEEET1 exciter. */
function unit(c: Case): void {
  c.plant('steam', 1);
}

/** Kundur's two-area system: four steam units, two per area, each on its own bus. */
function twoArea(c: Case): void {
  for (let bus = 1; bus <= 4; bus++) c.plant('steam', bus);
}

/** A WECC-style mix: dozens of steam, stabilized steam, classical and renewable plants. */
function wecc(c: Case): void {
  const next = random(240);
  for (let i = 0; i < 64; i++) {
    const r = next();
    const shape: Plant =
      r < 0.3 ? 'steam' : r < 0.5 ? 'steamPss' : r < 0.8 ? 'renewable' : 'classical';
    // About 1.6 plants per bus, so some buses carry two plants' tags.
    c.plant(shape, 1 + Math.floor(next() * 40));
  }
}

/** About 36k blocks: 13,100 plants of the four shapes, two per bus (EastWest's scale). */
function scale(c: Case): void {
  const shapes: readonly Plant[] = ['steam', 'steamPss', 'renewable', 'classical'];
  const plants = 13_100;
  const buses = Math.ceil(plants / 2);
  for (let i = 0; i < plants; i++) c.plant(shapes[i % shapes.length]!, (i % buses) + 1);
}

/** A scene whose case `fill` writes; its id becomes the case's `scene`, the block key prefix. */
function scene(id: string, label: string, fill: (c: Case) => void): SceneOption {
  return {
    id,
    label,
    build: () => {
      const c = new Case(id);
      fill(c);
      return c.done();
    },
  };
}

export const SCENES: readonly SceneOption[] = [
  scene('unit', 'twoarea unit', unit),
  scene('two-area', 'two area', twoArea),
  scene('wecc', 'wecc mix', wecc),
  scene('scale', '36k blocks', scale),
];
