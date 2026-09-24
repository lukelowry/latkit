/**
 * Netlists every diagram test shares: a builder over named ports, plants shaped like GridKit's
 * PhasorDynamics classes (port names and directions from their "Model Ports" tables), whole
 * systems of plants, a synthetic scale netlist, and seeded random ones.
 */

import type { Netlist } from '@latkit/model';

const NONE = 0xffffffff;

/** One port as a class names it. */
export interface PortSpec {
  readonly name: string;
  readonly flow: 'in' | 'out' | 'both';
  /** @defaultValue `0` (signal); buses are `1`. */
  readonly kind?: number;
  readonly side?: 0 | 1 | 2 | 3;
}

export interface BlockSpec {
  readonly key?: string;
  readonly title?: string;
  readonly label?: string;
  readonly group?: number;
  readonly ports: readonly PortSpec[];
}

export interface NetSpec {
  readonly label?: string;
  readonly style?: 0 | 1;
  /** Each member as `[block, port name]`. */
  readonly ports: readonly (readonly [block: number, port: string])[];
}

export interface NetlistSpec {
  readonly blocks: readonly BlockSpec[];
  readonly nets: readonly NetSpec[];
  readonly groups?: readonly string[];
}

const FLOW = { in: 0, out: 1, both: 2 } as const;

/** Build a columnar netlist from named blocks, ports and nets. */
export function build(spec: NetlistSpec): Netlist {
  const blockCount = spec.blocks.length;
  const portStart = new Uint32Array(blockCount + 1);
  for (let b = 0; b < blockCount; b++)
    portStart[b + 1] = portStart[b]! + spec.blocks[b]!.ports.length;
  const portCount = portStart[blockCount]!;
  const portFlow = new Uint8Array(portCount);
  const portKind = new Uint8Array(portCount);
  const portLabel: string[] = [];
  let sided = false;
  const portSide = new Uint8Array(portCount);
  spec.blocks.forEach((block, b) => {
    block.ports.forEach((port, i) => {
      const p = portStart[b]! + i;
      portFlow[p] = FLOW[port.flow];
      portKind[p] = port.kind ?? 0;
      portLabel.push(port.name);
      if (port.side !== undefined) sided = true;
      portSide[p] = port.side ?? (port.flow === 'in' ? 0 : port.flow === 'out' ? 1 : 2);
    });
  });
  const portOf = (block: number, name: string): number => {
    const index = spec.blocks[block]!.ports.findIndex((port) => port.name === name);
    if (index < 0) throw new Error(`fixture: block ${block} has no port ${name}`);
    return portStart[block]! + index;
  };
  const netStart = new Uint32Array(spec.nets.length + 1);
  const members: number[] = [];
  spec.nets.forEach((net, n) => {
    for (const [block, name] of net.ports) members.push(portOf(block, name));
    netStart[n + 1] = members.length;
  });
  const grouped = spec.blocks.some((block) => block.group !== undefined);
  return {
    blockCount,
    blockKey: spec.blocks.every((block) => block.key !== undefined)
      ? spec.blocks.map((block) => block.key!)
      : undefined,
    blockTitle: spec.blocks.map((block) => block.title ?? ''),
    blockLabel: spec.blocks.map((block) => block.label ?? ''),
    portStart,
    portFlow,
    portKind,
    portSide: sided ? portSide : undefined,
    portLabel,
    netStart,
    netPorts: Uint32Array.from(members),
    netStyle: Uint8Array.from(spec.nets, (net) => net.style ?? 0),
    netLabel: spec.nets.map((net) => net.label ?? ''),
    blockGroup: grouped ? Uint32Array.from(spec.blocks, (block) => block.group ?? NONE) : undefined,
    groupCount: spec.groups?.length ?? 0,
    groupLabel: spec.groups ? [...spec.groups] : undefined,
  };
}

/**
 * One TwoArea generator unit, verbatim from DIAGRAM.md: TGOV1 drives pmech, IEEET1 drives efd,
 * and GENROU's speed feeds both back.
 *
 * Ports: GENROU 0 pmech (in), 1 efd (in), 2 speed (out); TGOV1 3 speed (in), 4 pmech (out);
 * IEEET1 5 speed (in), 6 efd (out). Nets: 0 pmech [4, 0], 1 efd [6, 1], 2 speed [2, 3, 5].
 */
export function twoArea(): Netlist {
  return {
    blockCount: 3,
    blockKey: ['Genrou/1_1_genrou', 'Tgov1/1_1_tgov1', 'Ieeet1/1_1_ieeet1'],
    blockTitle: ['GENROU', 'TGOV1', 'IEEET1'],
    portStart: Uint32Array.of(0, 3, 5, 7),
    portFlow: Uint8Array.of(0, 0, 1, /* tgov1 */ 0, 1, /* ieeet1 */ 0, 1),
    portLabel: ['pmech', 'efd', 'speed', 'speed', 'pmech', 'speed', 'efd'],
    netStart: Uint32Array.of(0, 2, 4, 7),
    netPorts: Uint32Array.of(4, 0, /* efd */ 6, 1, /* speed */ 2, 3, 5),
    netLabel: ['1_1_pmech', '1_1_efd', '1_1_speed'],
  };
}

/** The empty netlist. */
export function empty(): Netlist {
  return {
    blockCount: 0,
    portStart: Uint32Array.of(0),
    portFlow: new Uint8Array(0),
    netStart: Uint32Array.of(0),
    netPorts: new Uint32Array(0),
  };
}

const BUS: PortSpec = { name: 'bus', flow: 'both', kind: 1 };

/** GridKit class port lists, in their README order. */
export const CLASSES = {
  GENROU: [
    BUS,
    { name: 'pmech', flow: 'in' },
    { name: 'efd', flow: 'in' },
    { name: 'speed', flow: 'out' },
  ],
  GENCLS: [
    BUS,
    { name: 'pmech', flow: 'in' },
    { name: 'efd', flow: 'in' },
    { name: 'speed', flow: 'out' },
  ],
  TGOV1: [
    { name: 'speed', flow: 'in' },
    { name: 'pref', flow: 'in' },
    { name: 'pmech', flow: 'out' },
  ],
  IEEET1: [
    BUS,
    { name: 'speed', flow: 'in' },
    { name: 'vref', flow: 'in' },
    { name: 'vs', flow: 'in' },
    { name: 'vuel', flow: 'in' },
    { name: 'voel', flow: 'in' },
    { name: 'efd', flow: 'out' },
  ],
  IEEEST: [
    { name: 'input', flow: 'in' },
    { name: 'output', flow: 'out' },
  ],
  REGCA: [
    BUS,
    { name: 'ipcmd', flow: 'in' },
    { name: 'iqcmd', flow: 'in' },
    { name: 'ibranchr', flow: 'out' },
    { name: 'ibranchi', flow: 'out' },
    { name: 'pbranch', flow: 'out' },
    { name: 'qbranch', flow: 'out' },
  ],
  REECB: [
    BUS,
    { name: 'pe', flow: 'in' },
    { name: 'qgen', flow: 'in' },
    { name: 'qext', flow: 'in' },
    { name: 'pfaref', flow: 'in' },
    { name: 'pref', flow: 'in' },
    { name: 'iqcmd', flow: 'out' },
    { name: 'ipcmd', flow: 'out' },
  ],
  REPCA: [
    BUS,
    { name: 'ir', flow: 'in' },
    { name: 'ii', flow: 'in' },
    { name: 'p', flow: 'in' },
    { name: 'q', flow: 'in' },
    { name: 'freq', flow: 'in' },
    { name: 'vref', flow: 'in' },
    { name: 'pref', flow: 'in' },
    { name: 'qref', flow: 'in' },
    { name: 'freqref', flow: 'in' },
    { name: 'qext', flow: 'out' },
    { name: 'pext', flow: 'out' },
  ],
} as const satisfies Record<string, readonly PortSpec[]>;

export type ClassName = keyof typeof CLASSES;

/** The plant shapes a system is made of. */
export type Plant = 'steam' | 'steamPss' | 'classical' | 'renewable';

/** Blocks and nets of one plant, appended to `blocks`/`nets`; returns its block indices. */
function addPlant(
  plant: Plant,
  prefix: string,
  group: number | undefined,
  blocks: BlockSpec[],
  nets: NetSpec[],
): number[] {
  const at = (cls: ClassName): number => {
    blocks.push({
      key: `${cls[0]}${cls.slice(1).toLowerCase()}/${prefix}_${cls.toLowerCase()}`,
      title: cls,
      label: `${prefix}_${cls.toLowerCase()}`,
      group,
      ports: CLASSES[cls],
    });
    return blocks.length - 1;
  };
  const wire = (label: string, ...ports: (readonly [number, string])[]): void => {
    nets.push({ label: `${prefix}_${label}`, ports });
  };
  switch (plant) {
    case 'classical': {
      return [at('GENCLS')];
    }
    case 'steam':
    case 'steamPss': {
      const machine = at('GENROU');
      const governor = at('TGOV1');
      const exciter = at('IEEET1');
      wire('pmech', [governor, 'pmech'], [machine, 'pmech']);
      wire('efd', [exciter, 'efd'], [machine, 'efd']);
      if (plant === 'steam') {
        wire('speed', [machine, 'speed'], [governor, 'speed'], [exciter, 'speed']);
        return [machine, governor, exciter];
      }
      const stabilizer = at('IEEEST');
      wire(
        'speed',
        [machine, 'speed'],
        [governor, 'speed'],
        [exciter, 'speed'],
        [stabilizer, 'input'],
      );
      wire('vs', [stabilizer, 'output'], [exciter, 'vs']);
      return [machine, governor, exciter, stabilizer];
    }
    case 'renewable': {
      const converter = at('REGCA');
      const electrical = at('REECB');
      const plantController = at('REPCA');
      wire('ipcmd', [electrical, 'ipcmd'], [converter, 'ipcmd']);
      wire('iqcmd', [electrical, 'iqcmd'], [converter, 'iqcmd']);
      wire('ibranchr', [converter, 'ibranchr'], [plantController, 'ir']);
      wire('ibranchi', [converter, 'ibranchi'], [plantController, 'ii']);
      wire('pbranch', [converter, 'pbranch'], [plantController, 'p'], [electrical, 'pe']);
      wire('qbranch', [converter, 'qbranch'], [plantController, 'q'], [electrical, 'qgen']);
      wire('pext', [plantController, 'pext'], [electrical, 'pref']);
      wire('qext', [plantController, 'qext'], [electrical, 'qext']);
      return [converter, electrical, plantController];
    }
  }
}

/** One plant alone, grouped as group 0, with its bus as a tag net. */
export function plant(kind: Plant, prefix = '1_1'): Netlist {
  const blocks: BlockSpec[] = [];
  const nets: NetSpec[] = [];
  const members = addPlant(kind, prefix, 0, blocks, nets);
  const bus = members
    .filter((b) => blocks[b]!.ports.some((port) => port.name === 'bus'))
    .map((b) => [b, 'bus'] as const);
  if (bus.length > 0) nets.push({ label: 'bus_1', style: 1, ports: bus });
  return build({ blocks, nets, groups: [`plant ${prefix}`] });
}

/**
 * Many plants, one group each, cycling through `shapes`; plant `i` sits on bus `i % buses`
 * (a tag net shared by every plant on that bus). 2.75 blocks per plant for the default mix.
 */
export function system(
  plants: number,
  shapes: readonly Plant[] = ['steam', 'steamPss', 'renewable', 'classical'],
  buses = Math.max(1, Math.ceil(plants / 2)),
): Netlist {
  const blocks: BlockSpec[] = [];
  const nets: NetSpec[] = [];
  const groups: string[] = [];
  const busPorts: (readonly [number, string])[][] = Array.from({ length: buses }, () => []);
  for (let i = 0; i < plants; i++) {
    const prefix = `${Math.floor(i / 4) + 1}_${(i % 4) + 1}`;
    const members = addPlant(shapes[i % shapes.length]!, prefix, i, blocks, nets);
    groups.push(`plant ${prefix}`);
    for (const b of members) {
      if (blocks[b]!.ports.some((port) => port.name === 'bus'))
        busPorts[i % buses]!.push([b, 'bus']);
    }
  }
  busPorts.forEach((ports, i) => {
    if (ports.length > 0) nets.push({ label: `bus_${i + 1}`, style: 1, ports });
  });
  return build({ blocks, nets, groups });
}

/** About 36k blocks from four plant shapes: the EastWest signal diagram's scale. */
export function scale(plants = 13_100): Netlist {
  return system(plants);
}

/** A seeded linear congruential generator in [0, 1). */
export function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * A random valid netlist: blocks with one to five ports, nets of one driver and one to three
 * readers of the same kind, some ports left unwired; no groups, keys `b<i>`.
 */
export function randomNetlist(blockCount: number, seed = 1): Netlist {
  const next = random(seed);
  const blocks: BlockSpec[] = [];
  for (let b = 0; b < blockCount; b++) {
    const ports: PortSpec[] = [];
    const count = 1 + Math.floor(next() * 5);
    for (let i = 0; i < count; i++) {
      ports.push({ name: `p${i}`, flow: next() < 0.45 ? 'out' : 'in', kind: next() < 0.1 ? 1 : 0 });
    }
    blocks.push({ key: `b${b}`, title: `B${b}`, label: `block_${b}`, ports });
  }
  const free = { out: [[], []] as [number, string][][], in: [[], []] as [number, string][][] };
  blocks.forEach((block, b) =>
    block.ports.forEach((port) => {
      if (port.flow !== 'both') free[port.flow][port.kind ?? 0]!.push([b, port.name]);
    }),
  );
  const nets: NetSpec[] = [];
  for (const kind of [0, 1]) {
    const outs = free.out[kind]!;
    const ins = free.in[kind]!;
    for (const driver of outs) {
      const readers = 1 + Math.floor(next() * 3);
      const ports: (readonly [number, string])[] = [driver];
      for (let r = 0; r < readers && ins.length > 0; r++) {
        ports.push(ins.splice(Math.floor(next() * ins.length), 1)[0]!);
      }
      if (ports.length > 1) nets.push({ label: `n${nets.length}`, ports });
    }
  }
  return build({ blocks, nets });
}
