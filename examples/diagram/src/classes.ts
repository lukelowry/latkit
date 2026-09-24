/**
 * The device classes this example draws, modeled on GridKit's PhasorDynamics components: port
 * names, directions and descriptions come from each class README's "Model Ports" table.
 */

/** A port's direction: an `Input` reads a signal, an `Output` drives one, a `Bus` is a terminal. */
export type Flow = 'in' | 'out' | 'both';

/** Port kind as the netlist's `portKind`: only ports of one kind share a net. */
export const SIGNAL = 0;
export const BUS = 1;

/** One port of a class. */
export interface PortSpec {
  readonly name: string;
  readonly flow: Flow;
  readonly kind: typeof SIGNAL | typeof BUS;
  readonly description: string;
}

/** One device class. */
export interface ClassSpec {
  /** The heading drawn inside the block. */
  readonly title: string;
  /** The class name a GridKit case file uses, the first half of a device key. */
  readonly json: string;
  /** The PhasorDynamics folder it lives in; the palette groups by it. */
  readonly category: string;
  readonly ports: readonly PortSpec[];
}

function bus(description: string): PortSpec {
  return { name: 'bus', flow: 'both', kind: BUS, description };
}

function input(name: string, description: string): PortSpec {
  return { name, flow: 'in', kind: SIGNAL, description };
}

function output(name: string, description: string): PortSpec {
  return { name, flow: 'out', kind: SIGNAL, description };
}

export const CLASSES = {
  GENROU: {
    title: 'GENROU',
    json: 'Genrou',
    category: 'Machine',
    ports: [
      bus('Terminal bus voltage and current-balance residuals'),
      input('pmech', 'Mechanical-power input; held constant when unconnected'),
      input('efd', 'Field-voltage input; held constant when unconnected'),
      output('speed', 'Machine speed-deviation output'),
    ],
  },
  GENCLS: {
    title: 'GENCLS',
    json: 'GenClassical',
    category: 'Machine',
    ports: [
      bus('Terminal bus voltage'),
      input('pmech', 'Mechanical-power input'),
      input('efd', 'Field-voltage input'),
      output('speed', 'Speed-deviation output'),
    ],
  },
  TGOV1: {
    title: 'TGOV1',
    json: 'Tgov1',
    category: 'Governor',
    ports: [
      input('speed', 'Machine speed deviation; optional, defaults to zero'),
      input('pref', 'Governor reference; optional'),
      output('pmech', 'Mechanical-power signal seeded by the machine'),
    ],
  },
  IEEET1: {
    title: 'IEEET1',
    json: 'Ieeet1',
    category: 'Exciter',
    ports: [
      bus('Terminal bus voltage'),
      input('speed', 'Machine speed deviation'),
      input('vref', 'Voltage-control reference'),
      input('vs', 'Stabilizer input signal'),
      input('vuel', 'Under-excitation limiter input'),
      input('voel', 'Over-excitation limiter input'),
      output('efd', 'Field-voltage output seeded by the machine'),
    ],
  },
  IEEEST: {
    title: 'IEEEST',
    json: 'Ieeest',
    category: 'Stabilizer',
    ports: [
      input('input', 'Required stabilizer input signal'),
      output('output', 'Limited stabilizer output signal'),
    ],
  },
  REGCA: {
    title: 'REGCA',
    json: 'Regca',
    category: 'Converter',
    ports: [
      bus('Terminal bus voltage'),
      input('ipcmd', 'Active-current command input'),
      input('iqcmd', 'Reactive-current command input'),
      output('ibranchr', 'Branch-current real-component output'),
      output('ibranchi', 'Branch-current imaginary-component output'),
      output('pbranch', 'Branch active-power output'),
      output('qbranch', 'Branch reactive-power output'),
    ],
  },
  REECB: {
    title: 'REECB',
    json: 'Reecb',
    category: 'Controller',
    ports: [
      bus('Terminal-bus voltage'),
      input('pe', 'Active-power feedback'),
      input('qgen', 'Reactive-power feedback'),
      input('qext', 'Volt/VAr reference'),
      input('pfaref', 'Power-factor angle reference'),
      input('pref', 'Active-power reference'),
      output('iqcmd', 'Reactive-current command'),
      output('ipcmd', 'Active-current command'),
    ],
  },
  REPCA: {
    title: 'REPCA',
    json: 'Repca',
    category: 'Controller',
    ports: [
      bus('Regulated-bus voltage'),
      input('ir', 'Branch-current real component on system base'),
      input('ii', 'Branch-current imaginary component on system base'),
      input('p', 'Branch active power on system base'),
      input('q', 'Branch reactive power on system base'),
      input('freq', 'Optional absolute frequency; defaults to 1.0 p.u.'),
      input('vref', 'Voltage-control reference'),
      input('pref', 'Plant active-power reference on system base'),
      input('qref', 'Reactive-power reference on system base'),
      input('freqref', 'Absolute per-unit frequency reference'),
      output('qext', 'Reactive-power command on system base'),
      output('pext', 'Active-power command on system base'),
    ],
  },
} as const satisfies Record<string, ClassSpec>;

/** A class this example knows. */
export type ClassName = keyof typeof CLASSES;

/** Every class name, in palette order. */
export const CLASS_NAMES = Object.keys(CLASSES) as ClassName[];

/** Whether a string names a known class (for data dropped from outside the page). */
export function isClassName(value: string): value is ClassName {
  return Object.prototype.hasOwnProperty.call(CLASSES, value);
}

/** The index of a class's port by name, or -1. */
export function portIndex(cls: ClassName, name: string): number {
  const ports: readonly PortSpec[] = CLASSES[cls].ports;
  return ports.findIndex((port) => port.name === name);
}
