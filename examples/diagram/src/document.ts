/**
 * The example's host: an in-memory case document in GridKit's shape (devices whose ports name a
 * signal or a bus by id), the netlist and placements a diagram shows for it, and the edits the
 * diagram's proposals become. Documents are immutable, so undo and redo are a stack of them.
 */

import type { Part } from '@latkit/model';
import type { Netlist } from '@latkit/model';
import { BUS, CLASSES, SIGNAL, type ClassName, type PortSpec } from './classes.js';

const NONE = 0xffffffff;
const FLOW = { in: 0, out: 1, both: 2 } as const;

/** One device record, as a GridKit case lists it. */
export interface Device {
  readonly cls: ClassName;
  /** Unique per class, like `1_1_genrou`. */
  readonly id: string;
  /** Port name to the signal (signal ports) or bus (bus ports) it is on; absent when unwired. */
  readonly ports: Readonly<Record<string, number>>;
}

/** What the case says: devices, and the signals and buses their ports name. */
export interface Structure {
  /**
   * The scene the case belongs to. It prefixes every block key, so no block of one scene survives
   * into the next: a scene switch loads a fresh layout without asking for one.
   */
  readonly scene: string;
  readonly devices: readonly Device[];
  /** Signal id to name, in id order. */
  readonly signals: ReadonlyMap<number, string>;
  /** Bus id to name, in id order. */
  readonly buses: ReadonlyMap<number, string>;
}

/** One undo step's worth of state: the structure and where the user put blocks. */
export interface Doc {
  readonly structure: Structure;
  /** Device key to a user placement (top-left); a block without one follows the automatic layout. */
  readonly placements: ReadonlyMap<string, readonly [number, number]>;
}

/** The netlist a structure becomes, plus the maps back from its indices to the document. */
export interface Built {
  readonly netlist: Netlist;
  /** Per block: its device's key, `Class/id`; the netlist's `blockKey` puts the scene first. */
  readonly keys: readonly string[];
  /** Per port: the device that owns it. */
  readonly portDevice: Uint32Array;
  /** Per net: `SIGNAL` or `BUS`. */
  readonly netKind: Uint8Array;
  /** Per net: the signal or bus id. */
  readonly netId: Uint32Array;
  readonly signalNet: ReadonlyMap<number, number>;
  readonly busNet: ReadonlyMap<number, number>;
}

/** An edit the document declines; its message is for the user. */
export class Refusal extends Error {
  override readonly name = 'Refusal';
}

/** A diagram proposal, in the diagram's indices of the netlist it was made against. */
export type Edit =
  | {
      readonly kind: 'connect';
      readonly from: number;
      readonly to: { readonly kind: 'port' | 'net'; readonly index: number };
    }
  | { readonly kind: 'disconnect'; readonly port: number }
  | { readonly kind: 'move'; readonly blocks: Uint32Array; readonly positions: Float32Array }
  | { readonly kind: 'delete'; readonly parts: readonly Part[] }
  | { readonly kind: 'insert'; readonly cls: ClassName; readonly at: readonly [number, number] }
  | { readonly kind: 'unplace' };

/** The key GridKit identity gives a device, unique within its case. */
export function keyOf(device: Device): string {
  return `${CLASSES[device.cls].json}/${device.id}`;
}

/** A plant's name from one of its devices: `1_1_genrou` belongs to plant `1_1`. */
function plantOf(device: Device): string {
  const suffix = `_${device.cls.toLowerCase()}`;
  return device.id.endsWith(suffix) ? device.id.slice(0, -suffix.length) : device.id;
}

const builtCache = new WeakMap<Structure, Built>();

/**
 * The netlist of a structure: one block per device, its class's ports in README order, a wired
 * net per signal and a tag net per bus, and a group per plant (devices joined by signals). Cached
 * per structure, so undo and redo hand the diagram the netlist object it saw before.
 */
export function build(structure: Structure): Built {
  const cached = builtCache.get(structure);
  if (cached) return cached;
  const { scene, devices, signals, buses } = structure;
  const blockCount = devices.length;
  const portStart = new Uint32Array(blockCount + 1);
  for (let b = 0; b < blockCount; b++) {
    portStart[b + 1] = portStart[b]! + CLASSES[devices[b]!.cls].ports.length;
  }
  const portCount = portStart[blockCount]!;
  const portFlow = new Uint8Array(portCount);
  const portKind = new Uint8Array(portCount);
  const portDevice = new Uint32Array(portCount);
  const portLabel = new Array<string>(portCount);
  const portNet = new Int32Array(portCount).fill(-1);

  const signalNet = new Map<number, number>();
  const busNet = new Map<number, number>();
  let netCount = 0;
  for (const id of signals.keys()) signalNet.set(id, netCount++);
  for (const id of buses.keys()) busNet.set(id, netCount++);
  const netSize = new Uint32Array(netCount);

  for (let b = 0; b < blockCount; b++) {
    const device = devices[b]!;
    const specs: readonly PortSpec[] = CLASSES[device.cls].ports;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const p = portStart[b]! + i;
      portFlow[p] = FLOW[spec.flow];
      portKind[p] = spec.kind;
      portDevice[p] = b;
      portLabel[p] = spec.name;
      const value = device.ports[spec.name];
      if (value === undefined) continue;
      const net = (spec.kind === BUS ? busNet : signalNet).get(value);
      if (net === undefined) {
        throw new Error(
          `document: ${device.id}.${spec.name} names ${spec.kind === BUS ? 'bus' : 'signal'} ${value}, which does not exist`,
        );
      }
      portNet[p] = net;
      netSize[net]!++;
    }
  }

  const netStart = new Uint32Array(netCount + 1);
  for (let n = 0; n < netCount; n++) netStart[n + 1] = netStart[n]! + netSize[n]!;
  const netPorts = new Uint32Array(netStart[netCount]!);
  const cursor = netStart.slice(0, netCount);
  for (let p = 0; p < portCount; p++) {
    const net = portNet[p]!;
    if (net >= 0) netPorts[cursor[net]!++] = p;
  }

  const netStyle = new Uint8Array(netCount);
  const netKind = new Uint8Array(netCount);
  const netId = new Uint32Array(netCount);
  const netLabel = new Array<string>(netCount);
  let n = 0;
  for (const [id, name] of signals) {
    netKind[n] = SIGNAL;
    netId[n] = id;
    netLabel[n++] = name;
  }
  for (const [id, name] of buses) {
    netStyle[n] = 1;
    netKind[n] = BUS;
    netId[n] = id;
    netLabel[n++] = name;
  }

  // Plants: union-find over the blocks every signal joins. A lone block stays ungrouped.
  const parent = new Uint32Array(blockCount);
  for (let b = 0; b < blockCount; b++) parent[b] = b;
  const find = (b: number): number => {
    let root = b;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[b] !== root) {
      const next = parent[b]!;
      parent[b] = root;
      b = next;
    }
    return root;
  };
  for (let net = 0; net < signals.size; net++) {
    const start = netStart[net]!;
    const end = netStart[net + 1]!;
    if (end - start < 2) continue;
    const first = find(portDevice[netPorts[start]!]!);
    for (let i = start + 1; i < end; i++) {
      const other = find(portDevice[netPorts[i]!]!);
      if (other !== first) parent[other] = first;
    }
  }
  const members = new Uint32Array(blockCount);
  for (let b = 0; b < blockCount; b++) members[find(b)]!++;
  const groupOfRoot = new Uint32Array(blockCount).fill(NONE);
  const blockGroup = new Uint32Array(blockCount).fill(NONE);
  const groupLabel: string[] = [];
  for (let b = 0; b < blockCount; b++) {
    const root = find(b);
    if (members[root]! < 2) continue;
    if (groupOfRoot[root] === NONE) {
      groupOfRoot[root] = groupLabel.length;
      groupLabel.push(`plant ${plantOf(devices[b]!)}`);
    }
    blockGroup[b] = groupOfRoot[root]!;
  }

  const keys = devices.map(keyOf);
  const netlist: Netlist = {
    blockCount,
    blockKey: keys.map((key) => `${scene}:${key}`),
    blockTitle: devices.map((device) => CLASSES[device.cls].title),
    blockLabel: devices.map((device) => device.id),
    portStart,
    portFlow,
    portKind,
    portLabel,
    netStart,
    netPorts,
    netStyle,
    netLabel,
    blockGroup,
    groupCount: groupLabel.length,
    groupLabel,
  };
  const built: Built = { netlist, keys, portDevice, netKind, netId, signalNet, busNet };
  builtCache.set(structure, built);
  return built;
}

/** The `blockPosition` channel of a document: placements, NaN for automatic blocks. */
export function positionsOf(doc: Doc, built: Built): Float32Array {
  const positions = new Float32Array(built.keys.length * 2).fill(Number.NaN);
  if (doc.placements.size === 0) return positions;
  built.keys.forEach((key, b) => {
    const at = doc.placements.get(key);
    if (!at) return;
    positions[2 * b] = at[0];
    positions[2 * b + 1] = at[1];
  });
  return positions;
}

/** A part named for people: `GENROU 1_1_genrou`, `1_1_genrou.speed`, `signal 1_1_speed`. */
export function describe(doc: Doc, built: Built, part: Part): string {
  const { netlist } = built;
  const devices = doc.structure.devices;
  switch (part.kind) {
    case 'block': {
      const device = devices[part.index];
      return device ? `${CLASSES[device.cls].title} ${device.id}` : `block ${part.index}`;
    }
    case 'port': {
      const device = devices[built.portDevice[part.index] ?? NONE];
      const name = netlist.portLabel?.[part.index];
      return device && name ? `${device.id}.${name}` : `port ${part.index}`;
    }
    case 'net': {
      const label = netlist.netLabel?.[part.index];
      if (label === undefined) return `net ${part.index}`;
      return `${built.netKind[part.index] === BUS ? 'bus' : 'signal'} ${label}`;
    }
    case 'group':
      return netlist.groupLabel?.[part.index] ?? `group ${part.index}`;
  }
}

/** The result of an accepted step: the next document and a line for the status bar. */
export interface Applied {
  readonly doc: Doc;
  readonly summary: string;
}

/**
 * Apply edits as one step, all or nothing.
 *
 * @throws Refusal with a message for the user when the case cannot take an edit; `doc` is
 * untouched then.
 */
export function apply(doc: Doc, built: Built, edits: readonly Edit[]): Applied {
  const draft = new Draft(doc, built);
  const lines = edits.map((edit) => draft.apply(edit));
  return { doc: draft.finish(), summary: lines.filter((line) => line !== '').join('; ') };
}

/** A copy-on-write working document for one step. */
class Draft {
  #devices: Device[] | null = null;
  #signals: Map<number, string> | null = null;
  #buses: Map<number, string> | null = null;
  #placements: Map<string, readonly [number, number]> | null = null;
  #removed = false;

  constructor(
    private readonly doc: Doc,
    private readonly built: Built,
  ) {}

  get devices(): readonly Device[] {
    return this.#devices ?? this.doc.structure.devices;
  }

  get signals(): ReadonlyMap<number, string> {
    return this.#signals ?? this.doc.structure.signals;
  }

  get buses(): ReadonlyMap<number, string> {
    return this.#buses ?? this.doc.structure.buses;
  }

  apply(edit: Edit): string {
    switch (edit.kind) {
      case 'connect':
        return edit.to.kind === 'port'
          ? this.connect(this.port(edit.from), this.port(edit.to.index))
          : this.join(this.port(edit.from), this.net(edit.to.index));
      case 'disconnect':
        return this.disconnect(this.port(edit.port));
      case 'move':
        return this.move(edit.blocks, edit.positions);
      case 'delete':
        return this.delete(edit.parts);
      case 'insert':
        return this.insert(edit.cls, edit.at);
      case 'unplace':
        if (this.doc.placements.size === 0) return '';
        this.#placements = new Map();
        return 'placements cleared';
    }
  }

  /** The next document; structural edits drop signals and buses no port names any more. */
  finish(): Doc {
    let structure = this.doc.structure;
    if (this.#devices || this.#signals || this.#buses) {
      const usedSignals = new Set<number>();
      const usedBuses = new Set<number>();
      for (const device of this.devices) {
        const specs: readonly PortSpec[] = CLASSES[device.cls].ports;
        for (const spec of specs) {
          const value = device.ports[spec.name];
          if (value !== undefined) (spec.kind === BUS ? usedBuses : usedSignals).add(value);
        }
      }
      const keep = (table: ReadonlyMap<number, string>, used: Set<number>) =>
        new Map([...table].filter(([id]) => used.has(id)));
      structure = {
        scene: structure.scene,
        devices: this.#devices ?? structure.devices,
        signals: keep(this.signals, usedSignals),
        buses: keep(this.buses, usedBuses),
      };
    }
    let placements = this.#placements ?? this.doc.placements;
    if (this.#removed) {
      const live = new Set(structure.devices.map(keyOf));
      placements = new Map([...placements].filter(([key]) => live.has(key)));
    }
    return { structure, placements };
  }

  // ---- references ----

  private port(index: number): PortRef {
    const device = this.built.portDevice[index];
    const name = this.built.netlist.portLabel?.[index];
    if (device === undefined || name === undefined) throw new Refusal(`no port ${index}`);
    const spec = (CLASSES[this.devices[device]!.cls].ports as readonly PortSpec[]).find(
      (entry) => entry.name === name,
    )!;
    return { device, spec };
  }

  private net(index: number): NetRef {
    const id = this.built.netId[index];
    if (id === undefined) throw new Refusal(`no net ${index}`);
    return { kind: this.built.netKind[index] === BUS ? BUS : SIGNAL, id };
  }

  private value(ref: PortRef): number | undefined {
    return this.devices[ref.device]!.ports[ref.spec.name];
  }

  private name(ref: PortRef): string {
    return `${this.devices[ref.device]!.id}.${ref.spec.name}`;
  }

  private tableName(kind: number, id: number): string {
    return (kind === BUS ? this.buses : this.signals).get(id) ?? String(id);
  }

  /** The port driving a signal, or null. */
  private driverOf(signal: number, except?: PortRef): string | null {
    const devices = this.devices;
    for (let d = 0; d < devices.length; d++) {
      const device = devices[d]!;
      for (const spec of CLASSES[device.cls].ports as readonly PortSpec[]) {
        if (spec.flow !== 'out' || device.ports[spec.name] !== signal) continue;
        if (except && except.device === d && except.spec === spec) continue;
        return `${device.id}.${spec.name}`;
      }
    }
    return null;
  }

  // ---- writes ----

  private setPort(ref: PortRef, value: number | undefined): void {
    this.#devices ??= [...this.doc.structure.devices];
    const device = this.#devices[ref.device]!;
    const ports: Record<string, number> = { ...device.ports };
    if (value === undefined) delete ports[ref.spec.name];
    else ports[ref.spec.name] = value;
    this.#devices[ref.device] = { ...device, ports };
  }

  private newSignal(name: string): number {
    this.#signals ??= new Map(this.doc.structure.signals);
    const id = nextId(this.#signals);
    const taken = new Set(this.#signals.values());
    let unique = name;
    for (let k = 2; taken.has(unique); k++) unique = `${name}_${k}`;
    this.#signals.set(id, unique);
    return id;
  }

  private newBus(): number {
    this.#buses ??= new Map(this.doc.structure.buses);
    const id = nextId(this.#buses);
    this.#buses.set(id, `bus_${id}`);
    return id;
  }

  // ---- edits ----

  /** Put two ports on one signal or bus, GridKit-style: the driver is the `out` port. */
  private connect(a: PortRef, b: PortRef): string {
    if (a.device === b.device && a.spec === b.spec) throw new Refusal('a port cannot wire itself');
    if (a.spec.kind !== b.spec.kind) {
      throw new Refusal(
        `${this.name(a)} and ${this.name(b)} are a signal and a bus; they never share a net`,
      );
    }
    if (a.spec.kind === BUS) return this.connectBus(a, b);
    const va = this.value(a);
    const vb = this.value(b);
    if (va !== undefined && va === vb) {
      throw new Refusal(`${this.name(a)} and ${this.name(b)} are already connected`);
    }
    if (a.spec.flow === 'out' && b.spec.flow === 'out') {
      throw new Refusal(
        `${this.name(a)} and ${this.name(b)} are both outputs; a signal has one driver`,
      );
    }
    if (a.spec.flow !== 'out' && b.spec.flow !== 'out') {
      // Two readers: the unwired one joins the other's signal.
      if (va === undefined && vb === undefined) {
        throw new Refusal(
          `${this.name(a)} and ${this.name(b)} are both inputs; wire an output first`,
        );
      }
      if (va !== undefined && vb !== undefined) throw new Refusal(this.readsAnother(b));
      return va === undefined ? this.joinSignal(a, vb!) : this.joinSignal(b, va);
    }
    const [driver, reader] = a.spec.flow === 'out' ? [a, b] : [b, a];
    const drives = this.value(driver);
    const reads = this.value(reader);
    if (reads !== undefined && drives !== undefined) throw new Refusal(this.readsAnother(reader));
    if (drives !== undefined) return this.joinSignal(reader, drives);
    if (reads !== undefined) return this.joinSignal(driver, reads);
    const prefix = plantOf(this.devices[reader.device]!);
    const id = this.newSignal(`${prefix}_${reader.spec.name}`);
    this.setPort(driver, id);
    this.setPort(reader, id);
    return `connect ${this.name(driver)} -> ${this.name(reader)} (new signal ${this.tableName(SIGNAL, id)})`;
  }

  private readsAnother(reader: PortRef): string {
    const reads = this.value(reader)!;
    return `${this.name(reader)} already reads signal ${this.tableName(SIGNAL, reads)}; disconnect it first`;
  }

  /** Put a port on an existing net (a wire released on a net). */
  private join(ref: PortRef, net: NetRef): string {
    if (ref.spec.kind !== net.kind) {
      throw new Refusal(`${this.name(ref)} cannot join ${net.kind === BUS ? 'a bus' : 'a signal'}`);
    }
    const current = this.value(ref);
    const name = this.tableName(net.kind, net.id);
    if (current === net.id) throw new Refusal(`${this.name(ref)} is already on ${name}`);
    if (net.kind === BUS) {
      if (current !== undefined) {
        throw new Refusal(
          `${this.name(ref)} is already on bus ${this.tableName(BUS, current)}; disconnect it first`,
        );
      }
      this.setPort(ref, net.id);
      return `connect ${this.name(ref)} -> bus ${name}`;
    }
    if (current !== undefined) {
      throw new Refusal(
        ref.spec.flow === 'out'
          ? `${this.name(ref)} already drives signal ${this.tableName(SIGNAL, current)}`
          : this.readsAnother(ref),
      );
    }
    return this.joinSignal(ref, net.id);
  }

  private joinSignal(ref: PortRef, signal: number): string {
    const name = this.tableName(SIGNAL, signal);
    if (ref.spec.flow === 'out') {
      const driver = this.driverOf(signal, ref);
      if (driver !== null) {
        throw new Refusal(`signal ${name} is already driven by ${driver}; disconnect it first`);
      }
    }
    this.setPort(ref, signal);
    return `connect ${this.name(ref)} -> signal ${name}`;
  }

  private connectBus(a: PortRef, b: PortRef): string {
    const va = this.value(a);
    const vb = this.value(b);
    if (va !== undefined && vb !== undefined) {
      if (va === vb) throw new Refusal(`${this.name(a)} and ${this.name(b)} share a bus already`);
      throw new Refusal(
        `${this.name(b)} is already on bus ${this.tableName(BUS, vb)}; disconnect it first`,
      );
    }
    const id = va ?? vb ?? this.newBus();
    this.setPort(a, id);
    this.setPort(b, id);
    return `connect ${this.name(a)} -> ${this.name(b)} on bus ${this.tableName(BUS, id)}`;
  }

  private disconnect(ref: PortRef): string {
    const value = this.value(ref);
    if (value === undefined) return '';
    this.setPort(ref, undefined);
    return `disconnect ${this.name(ref)} from ${this.tableName(ref.spec.kind, value)}`;
  }

  private move(blocks: Uint32Array, positions: Float32Array): string {
    this.#placements ??= new Map(this.doc.placements);
    for (let i = 0; i < blocks.length; i++) {
      const device = this.devices[blocks[i]!];
      if (!device) throw new Refusal(`no block ${blocks[i]}`);
      this.#placements.set(keyOf(device), [positions[2 * i]!, positions[2 * i + 1]!]);
    }
    return `move ${plural(blocks.length, 'block')}`;
  }

  private insert(cls: ClassName, at: readonly [number, number]): string {
    const taken = new Set(this.devices.map((device) => device.id));
    const base = cls.toLowerCase();
    let k = 1;
    while (taken.has(`${base}_${k}`)) k++;
    const device: Device = { cls, id: `${base}_${k}`, ports: {} };
    this.#devices ??= [...this.doc.structure.devices];
    this.#devices.push(device);
    this.#placements ??= new Map(this.doc.placements);
    this.#placements.set(keyOf(device), [at[0], at[1]]);
    return `insert ${CLASSES[cls].title} ${device.id}`;
  }

  private delete(parts: readonly Part[]): string {
    const { netlist } = this.built;
    const blocks = new Set<number>();
    const counts = { block: 0, port: 0, net: 0 };
    for (const part of parts) {
      if (part.kind === 'block' && part.index < this.devices.length) blocks.add(part.index);
      if (part.kind === 'group') {
        netlist.blockGroup?.forEach((group, b) => {
          if (group === part.index) blocks.add(b);
        });
      }
    }
    for (const part of parts) {
      if (part.kind === 'port') {
        const ref = this.port(part.index);
        if (!blocks.has(ref.device) && this.disconnect(ref) !== '') counts.port++;
      } else if (part.kind === 'net') {
        const net = this.net(part.index);
        this.removeNet(net);
        counts.net++;
      }
    }
    if (blocks.size > 0) {
      this.#devices = this.devices.filter((_, d) => !blocks.has(d));
      this.#removed = true;
      counts.block = blocks.size;
    }
    const said = [
      counts.block > 0 ? plural(counts.block, 'block') : '',
      counts.net > 0 ? plural(counts.net, 'net') : '',
      counts.port > 0 ? `${plural(counts.port, 'port')} unwired` : '',
    ].filter((line) => line !== '');
    return said.length > 0 ? `delete ${said.join(', ')}` : '';
  }

  /** Remove a signal or bus: every port on it becomes unwired. */
  private removeNet(net: NetRef): void {
    const devices = this.devices;
    for (let d = 0; d < devices.length; d++) {
      for (const spec of CLASSES[devices[d]!.cls].ports as readonly PortSpec[]) {
        if (spec.kind === net.kind && devices[d]!.ports[spec.name] === net.id) {
          this.setPort({ device: d, spec }, undefined);
        }
      }
    }
    if (net.kind === BUS) {
      this.#buses ??= new Map(this.doc.structure.buses);
      this.#buses.delete(net.id);
    } else {
      this.#signals ??= new Map(this.doc.structure.signals);
      this.#signals.delete(net.id);
    }
  }
}

interface PortRef {
  readonly device: number;
  readonly spec: PortSpec;
}

interface NetRef {
  readonly kind: typeof SIGNAL | typeof BUS;
  readonly id: number;
}

function nextId(table: ReadonlyMap<number, string>): number {
  let max = 0;
  for (const id of table.keys()) if (id > max) max = id;
  return max + 1;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/** Undo and redo over whole documents. */
export class History {
  #past: Doc[] = [];
  #future: Doc[] = [];

  constructor(public current: Doc) {}

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** Make `doc` current as a new step; the redo stack clears. */
  commit(doc: Doc): void {
    this.#past.push(this.current);
    if (this.#past.length > 200) this.#past.shift();
    this.#future = [];
    this.current = doc;
  }

  /** Start over at `doc` with no history. */
  reset(doc: Doc): void {
    this.#past = [];
    this.#future = [];
    this.current = doc;
  }

  undo(): Doc | null {
    const doc = this.#past.pop();
    if (!doc) return null;
    this.#future.push(this.current);
    this.current = doc;
    return doc;
  }

  redo(): Doc | null {
    const doc = this.#future.pop();
    if (!doc) return null;
    this.#past.push(this.current);
    this.current = doc;
    return doc;
  }
}
