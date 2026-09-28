/**
 * The example's format: an in-memory case in GridKit's shape (devices whose ports name a signal or
 * a bus by id), read as a `Model` and edited as a `Document`. A case is immutable, so a step keeps
 * the case it replaced, and taking the step back puts that case back.
 */

import { Document, Model, Refusal } from '@latkit/model';

import {
  BUS,
  CLASS_NAMES,
  CLASSES,
  isClassName,
  SIGNAL,
  type ClassName,
  type PortSpec,
} from './classes.js';

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

/** A case as a model: a class per device class, its signals, and its buses, each bus a vertex. */
export class DynamicsCase extends Model {
  readonly structure: Structure;

  constructor(structure: Structure, name: string = structure.scene) {
    const { members } = build(structure);
    super({
      format: 'dynamics',
      id: structure.scene,
      name,
      topology: {
        vertexCount: structure.buses.size,
        edges: new Uint32Array(0),
        polylineStart: Uint32Array.of(0),
      },
      owners: { vertex: 'bus' },
      classes: [
        ...CLASS_NAMES.map((cls) => ({
          id: cls,
          label: CLASSES[cls].title,
          count: members.get(cls)?.length ?? 0,
          columns: [],
          signals: [],
        })),
        { id: 'signal', label: 'Signal', count: structure.signals.size, columns: [], signals: [] },
        { id: 'bus', label: 'Bus', count: structure.buses.size, columns: [], signals: [] },
      ],
    });
    this.structure = structure;
  }

  override document(): Promise<DynamicsDocument> {
    return Promise.resolve(new DynamicsDocument(this));
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(encode({ structure: this.structure, placements: new Map() }));
  }

  protected values(classId: string): Promise<Model.Values> {
    const { devices, signals, buses } = this.structure;
    const labels =
      classId === 'signal'
        ? [...signals.values()]
        : classId === 'bus'
          ? [...buses.values()]
          : (build(this.structure).members.get(classId) ?? []).map((d) => devices[d]!.id);
    return Promise.resolve({ labels, values: [] });
  }
}

/** One step's case: its structure, and where the user put blocks. */
interface Snapshot {
  readonly structure: Structure;
  /** Device key to a user placement (top-left); a block without one follows the automatic layout. */
  readonly placements: ReadonlyMap<string, readonly [number, number]>;
}

/** What taking a step back restores. */
interface Step {
  /** The case before the step. */
  readonly before: Snapshot;
  /** The elements the step removed, as the case before it names them: taking it back makes them. */
  readonly removed: readonly Model.Element[];
}

/**
 * A dynamics case open for editing: the diagram's proposals as operations on its devices, signals,
 * and buses, and the case as the schematic the diagram draws.
 */
export class DynamicsDocument extends Document {
  readonly #name: string;
  readonly #steps = new WeakMap<Document.Change, Step>();
  #now: Snapshot;
  #shown: { readonly now: Snapshot; readonly schematic: Document.Schematic } | null = null;
  #named: {
    readonly structure: Structure;
    readonly elements: ReadonlyMap<string, Model.Element>;
  } | null = null;

  constructor(model: DynamicsCase) {
    super(model);
    this.#name = model.name;
    this.#now = { structure: model.structure, placements: new Map() };
  }

  get schematic(): Document.Schematic {
    const now = this.#now;
    if (this.#shown?.now !== now) {
      const { netlist, keys, blocks, nets, sources, status, problems } = build(now.structure);
      const positions = new Float32Array(keys.length * 2).fill(Number.NaN);
      if (now.placements.size > 0) {
        keys.forEach((key, b) => {
          const at = now.placements.get(key);
          if (!at) return;
          positions[2 * b] = at[0];
          positions[2 * b + 1] = at[1];
        });
      }
      const schematic = { netlist, blocks, nets, sources, status, positions, problems };
      this.#shown = { now, schematic };
    }
    return this.#shown.schematic;
  }

  get palette(): readonly Document.BlockClass[] {
    return PALETTE;
  }

  /** A part named for people: `GENROU 1_1_genrou`, `1_1_genrou.speed`, `signal 1_1_speed`. */
  describe(part: Document.Part): string {
    const { devices } = this.#now.structure;
    const { netlist, portDevice, nets } = build(this.#now.structure);
    switch (part.kind) {
      case 'block': {
        const device = devices[part.index];
        return device ? `${CLASSES[device.cls].title} ${device.id}` : `block ${part.index}`;
      }
      case 'port': {
        const device = devices[portDevice[part.index] ?? NONE];
        const name = netlist.portLabel?.[part.index];
        return device && name ? `${device.id}.${name}` : `port ${part.index}`;
      }
      case 'net': {
        const net = nets[part.index];
        const label = netlist.netLabel?.[part.index];
        return net && label !== undefined ? `${net.classId} ${label}` : `net ${part.index}`;
      }
      case 'group':
        return netlist.groupLabel?.[part.index] ?? `group ${part.index}`;
    }
  }

  keyOf(element: Model.Element): string | null {
    const { structure } = this.#now;
    const built = build(structure);
    if (element.classId === 'signal' || element.classId === 'bus') {
      const signal = element.classId === 'signal';
      const id = (signal ? built.signalIds : built.busIds)[element.index];
      const name =
        id === undefined ? undefined : (signal ? structure.signals : structure.buses).get(id);
      return name === undefined ? null : `${element.classId}/${name}`;
    }
    const device = built.members.get(element.classId)?.[element.index];
    return device === undefined ? null : deviceKey(structure.devices[device]!);
  }

  find(key: string): Model.Element | null {
    const { structure } = this.#now;
    if (this.#named?.structure !== structure) {
      const { keys, blocks } = build(structure);
      const elements = new Map<string, Model.Element>();
      keys.forEach((device, b) => elements.set(device, blocks[b]!));
      let index = 0;
      for (const name of structure.signals.values())
        elements.set(`signal/${name}`, { classId: 'signal', index: index++ });
      index = 0;
      for (const name of structure.buses.values())
        elements.set(`bus/${name}`, { classId: 'bus', index: index++ });
      this.#named = { structure, elements };
    }
    return this.#named.elements.get(key) ?? null;
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(encode(this.#now));
  }

  protected change(operations: readonly Document.Operation[]): Document.Change | null {
    const draft = new Draft(this.#now);
    const label = operations
      .map((operation) => draft.apply(operation))
      .filter((line) => line !== '')
      .join('; ');
    if (label === '') return null;
    const { next, created } = draft.finish();
    const change: Document.Change = { label, scope: draft.scope, created };
    this.#steps.set(change, { before: this.#now, removed: draft.removed });
    this.#now = next;
    return change;
  }

  protected revert(change: Document.Change): Document.Change {
    const step = this.#steps.get(change);
    if (!step) throw new Error('this document did not make that change');
    const back: Document.Change = {
      label: change.label,
      scope: change.scope,
      created: step.removed,
    };
    this.#steps.set(back, { before: this.#now, removed: change.created });
    this.#now = step.before;
    return back;
  }

  protected open(): Promise<Model> {
    return Promise.resolve(new DynamicsCase(this.#now.structure, this.#name));
  }
}

/** The classes a diagram can add, in palette order. */
const PALETTE: readonly Document.BlockClass[] = CLASS_NAMES.map((cls) => ({
  classId: cls,
  label: CLASSES[cls].title,
  group: CLASSES[cls].category,
  ports: (CLASSES[cls].ports as readonly PortSpec[]).map(({ name, flow, required }) => ({
    name,
    flow: flow === 'both' ? 'bus' : flow,
    required,
  })),
}));

/** The key GridKit identity gives a device, unique within its case. */
function deviceKey(device: Device): string {
  return `${CLASSES[device.cls].json}/${device.id}`;
}

/** A plant's name from one of its devices: `1_1_genrou` belongs to plant `1_1`. */
function plantOf(device: Device): string {
  const suffix = `_${device.cls.toLowerCase()}`;
  return device.id.endsWith(suffix) ? device.id.slice(0, -suffix.length) : device.id;
}

/** The case as bytes: its structure and placements, as JSON. */
function encode({ structure, placements }: Snapshot): Uint8Array {
  const { scene, devices, signals, buses } = structure;
  return new TextEncoder().encode(
    JSON.stringify({
      scene,
      devices,
      signals: [...signals],
      buses: [...buses],
      placements: [...placements],
    }),
  );
}

/** The schematic a structure becomes, but for placements, and the maps back to the structure. */
interface Built {
  readonly netlist: Document.Netlist;
  /** Per block: its device's key, `Class/id`; the netlist's `blockKey` puts the scene first. */
  readonly keys: readonly string[];
  /** Per block, the element it is: its class, and its place among the class's devices. */
  readonly blocks: readonly Model.Element[];
  /** Per net, the signal or bus it is. */
  readonly nets: readonly Model.Element[];
  /** Per net: nothing records the example's signals. */
  readonly sources: readonly null[];
  /** Per port: `1` for a required port left unwired, which `problems` lists too. */
  readonly status: Float32Array;
  readonly problems: readonly Document.Problem[];
  /** Per port: the device that owns it. */
  readonly portDevice: Uint32Array;
  /** Per class: its devices in case order, so element `i` of a class is device `members[i]`. */
  readonly members: ReadonlyMap<string, readonly number[]>;
  /** Signal and bus ids in id order, so element `i` of `signal` or `bus` has id `[i]`. */
  readonly signalIds: readonly number[];
  readonly busIds: readonly number[];
}

const builtCache = new WeakMap<Structure, Built>();

/** One frozen element per class and index, shared by every build, so a step allocates none. */
const interned = new Map<string, Model.Element[]>();

function elementsOf(classId: string): Model.Element[] {
  let elements = interned.get(classId);
  if (!elements) interned.set(classId, (elements = []));
  return elements;
}

/**
 * The netlist of a structure: one block per device, its class's ports in README order, a wired
 * net per signal and a tag net per bus, and a group per plant (devices joined by signals). Cached
 * per structure, so undo and redo hand the diagram the netlist object it saw before.
 */
function build(structure: Structure): Built {
  const cached = builtCache.get(structure);
  if (cached) return cached;
  const { scene, devices, signals, buses } = structure;
  const blockCount = devices.length;
  const byClass = new Map<
    string,
    { readonly members: number[]; readonly elements: Model.Element[] }
  >();
  const blocks = new Array<Model.Element>(blockCount);
  for (let b = 0; b < blockCount; b++) {
    const { cls } = devices[b]!;
    let entry = byClass.get(cls);
    if (!entry) byClass.set(cls, (entry = { members: [], elements: elementsOf(cls) }));
    const index = entry.members.push(b) - 1;
    blocks[b] = entry.elements[index] ??= Object.freeze({ classId: cls, index });
  }
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
  const status = new Float32Array(portCount);
  const problems: Document.Problem[] = [];

  const signalIds = [...signals.keys()];
  const busIds = [...buses.keys()];
  const netCount = signalIds.length + busIds.length;
  const signalNet = new Map<number, number>();
  const busNet = new Map<number, number>();
  for (let n = 0; n < signalIds.length; n++) signalNet.set(signalIds[n]!, n);
  for (let n = 0; n < busIds.length; n++) busNet.set(busIds[n]!, signalIds.length + n);
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
      if (value === undefined) {
        if (spec.required) {
          status[p] = 1;
          problems.push({
            at: { element: blocks[b]!, port: spec.name },
            kind: 'unwired',
            message: `${device.id}.${spec.name} is unwired`,
          });
        }
        continue;
      }
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

  const netStyle = new Uint8Array(netCount).fill(1, signalIds.length);
  const netLabel = [...signals.values(), ...buses.values()];
  const nets = new Array<Model.Element>(netCount);
  const signalElements = elementsOf('signal');
  const busElements = elementsOf('bus');
  for (let index = 0; index < signalIds.length; index++) {
    nets[index] = signalElements[index] ??= Object.freeze({ classId: 'signal', index });
  }
  for (let index = 0; index < busIds.length; index++) {
    nets[signalIds.length + index] = busElements[index] ??= Object.freeze({
      classId: 'bus',
      index,
    });
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
  for (let net = 0; net < signalIds.length; net++) {
    const start = netStart[net]!;
    const end = netStart[net + 1]!;
    if (end - start < 2) continue;
    const first = find(portDevice[netPorts[start]!]!);
    for (let i = start + 1; i < end; i++) {
      const other = find(portDevice[netPorts[i]!]!);
      if (other !== first) parent[other] = first;
    }
  }
  const size = new Uint32Array(blockCount);
  for (let b = 0; b < blockCount; b++) size[find(b)]!++;
  const groupOfRoot = new Uint32Array(blockCount).fill(NONE);
  const blockGroup = new Uint32Array(blockCount).fill(NONE);
  const groupLabel: string[] = [];
  for (let b = 0; b < blockCount; b++) {
    const root = find(b);
    if (size[root]! < 2) continue;
    if (groupOfRoot[root] === NONE) {
      groupOfRoot[root] = groupLabel.length;
      groupLabel.push(`plant ${plantOf(devices[b]!)}`);
    }
    blockGroup[b] = groupOfRoot[root]!;
  }

  const keys = devices.map(deviceKey);
  const netlist: Document.Netlist = {
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
  const built: Built = {
    netlist,
    keys,
    blocks,
    nets,
    sources: new Array<null>(netCount).fill(null),
    status,
    problems,
    portDevice,
    members: new Map([...byClass].map(([cls, entry]) => [cls, entry.members])),
    signalIds,
    busIds,
  };
  builtCache.set(structure, built);
  return built;
}

/** A copy-on-write working case for one step, and what the step makes and removes. */
class Draft {
  /** What follows the step: `layout` until it writes the structure. */
  scope: Document.Change['scope'] = 'layout';
  /** The elements the step removes, as the case before it names them. */
  readonly removed: Model.Element[] = [];
  readonly #built: Built;
  #devices: Device[] | null = null;
  #signals: Map<number, string> | null = null;
  #buses: Map<number, string> | null = null;
  #placements: Map<string, readonly [number, number]> | null = null;
  /** Devices the step removes, by index in the case before it; they drop out as it finishes. */
  readonly #dropped = new Set<number>();
  /** Signals and buses a port of the step let go of: the ones no port names any more drop out. */
  readonly #freed = { [SIGNAL]: new Set<number>(), [BUS]: new Set<number>() };
  #inserted = 0;

  constructor(private readonly now: Snapshot) {
    this.#built = build(now.structure);
  }

  get devices(): readonly Device[] {
    return this.#devices ?? this.now.structure.devices;
  }

  get signals(): ReadonlyMap<number, string> {
    return this.#signals ?? this.now.structure.signals;
  }

  get buses(): ReadonlyMap<number, string> {
    return this.#buses ?? this.now.structure.buses;
  }

  /** Make one operation true in the draft; what it did, for the status bar, or '' for nothing. */
  apply(operation: Document.Operation): string {
    switch (operation.kind) {
      case 'connect': {
        const from = this.port(operation.from);
        const { to } = operation;
        return 'net' in to ? this.join(from, this.net(to.net)) : this.connect(from, this.port(to));
      }
      case 'disconnect':
        return this.disconnect(this.port(operation.port));
      case 'insert':
        return this.insert(operation.classId, operation.at, operation.wire);
      case 'remove':
        return this.remove(operation.elements);
      case 'place':
        return this.place(operation.elements, operation.positions);
      case 'set':
        throw new Refusal(
          `${this.describe(operation.element)} has no column ${operation.column}`,
          operation.element,
        );
      case 'record':
        throw new Refusal('this case records no signals');
    }
  }

  /**
   * The case after the step, and the devices it inserted as elements of it. A structural step
   * drops signals and buses no port names any more.
   */
  finish(): { readonly next: Snapshot; readonly created: readonly Model.Element[] } {
    let structure = this.now.structure;
    if (this.#devices || this.#signals || this.#buses || this.#dropped.size > 0) {
      const devices =
        this.#dropped.size > 0
          ? this.devices.filter((_, d) => !this.#dropped.has(d))
          : this.devices;
      structure = {
        scene: structure.scene,
        devices,
        signals: this.kept(SIGNAL, devices),
        buses: this.kept(BUS, devices),
      };
    }
    let placements = this.#placements ?? this.now.placements;
    if (this.#dropped.size > 0) {
      const live = new Set(structure.devices.map(deviceKey));
      placements = new Map([...placements].filter(([key]) => live.has(key)));
    }
    // Inserted devices are the last ones, each after the devices of its class that stay.
    const created: Model.Element[] = [];
    if (this.#inserted > 0) {
      const counts = new Map<string, number>();
      for (const [cls, members] of this.#built.members) counts.set(cls, members.length);
      for (const d of this.#dropped) {
        const { cls } = this.now.structure.devices[d]!;
        counts.set(cls, counts.get(cls)! - 1);
      }
      const { devices } = structure;
      for (let d = devices.length - this.#inserted; d < devices.length; d++) {
        const { cls } = devices[d]!;
        const index = counts.get(cls) ?? 0;
        counts.set(cls, index + 1);
        created.push((elementsOf(cls)[index] ??= Object.freeze({ classId: cls, index })));
      }
    }
    return { next: { structure, placements }, created };
  }

  /** The signal or bus table without what the step freed that no port of `devices` names. */
  private kept(
    kind: typeof SIGNAL | typeof BUS,
    devices: readonly Device[],
  ): ReadonlyMap<number, string> {
    const table = this.table(kind);
    const unnamed = new Set([...this.#freed[kind]].filter((id) => table.has(id)));
    for (let d = 0; d < devices.length && unnamed.size > 0; d++) {
      const device = devices[d]!;
      for (const spec of CLASSES[device.cls].ports as readonly PortSpec[]) {
        const value = device.ports[spec.name];
        if (spec.kind === kind && value !== undefined) unnamed.delete(value);
      }
    }
    return unnamed.size === 0 ? table : new Map([...table].filter(([id]) => !unnamed.has(id)));
  }

  // ---- references ----

  /** The device an element is in the case before the step, whether or not the step removes it. */
  private member(element: Model.Element): number {
    const device = this.#built.members.get(element.classId)?.[element.index];
    if (device === undefined) {
      throw new Refusal(`the case has no ${this.describe(element)}`, element);
    }
    return device;
  }

  /** The device an element is, which the step has not removed. */
  private device(element: Model.Element): number {
    const device = this.member(element);
    if (this.#dropped.has(device)) {
      throw new Refusal(`${this.devices[device]!.id} is removed`, element);
    }
    return device;
  }

  private port(port: Document.Port): PortRef {
    const device = this.device(port.element);
    const { cls, id } = this.devices[device]!;
    const spec = (CLASSES[cls].ports as readonly PortSpec[]).find(
      (entry) => entry.name === port.port,
    );
    if (!spec) throw new Refusal(`${id} has no port ${port.port}`, port);
    return { device, spec };
  }

  /** The signal or bus an element is, whether or not the step removed it. */
  private netOf(element: Model.Element): NetRef {
    const kind = element.classId === 'bus' ? BUS : element.classId === 'signal' ? SIGNAL : null;
    const id =
      kind === null
        ? undefined
        : (kind === BUS ? this.#built.busIds : this.#built.signalIds)[element.index];
    if (kind === null || id === undefined) {
      throw new Refusal(`the case has no net ${this.describe(element)}`, element);
    }
    return { kind, id };
  }

  /** The signal or bus an element is, which the step has not removed. */
  private net(element: Model.Element): NetRef {
    const net = this.netOf(element);
    if (!this.table(net.kind).has(net.id)) {
      throw new Refusal(`${this.tableName(net.kind, net.id)} is removed`, element);
    }
    return net;
  }

  private table(kind: number): ReadonlyMap<number, string> {
    return kind === BUS ? this.buses : this.signals;
  }

  private value(ref: PortRef): number | undefined {
    return this.devices[ref.device]!.ports[ref.spec.name];
  }

  private name(ref: PortRef): string {
    return `${this.devices[ref.device]!.id}.${ref.spec.name}`;
  }

  private tableName(kind: number, id: number): string {
    return `${kind === BUS ? 'bus' : 'signal'} ${this.table(kind).get(id) ?? String(id)}`;
  }

  private describe(element: Model.Element): string {
    return `${element.classId} ${element.index}`;
  }

  /** The port driving a signal, or null; a device the step removes drives nothing. */
  private driverOf(signal: number, except?: PortRef): string | null {
    const devices = this.devices;
    for (let d = 0; d < devices.length; d++) {
      if (this.#dropped.has(d)) continue;
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
    this.scope = 'structure';
    this.#devices ??= [...this.now.structure.devices];
    const device = this.#devices[ref.device]!;
    const previous = device.ports[ref.spec.name];
    if (previous !== undefined && previous !== value) this.#freed[ref.spec.kind].add(previous);
    const ports: Record<string, number> = { ...device.ports };
    if (value === undefined) delete ports[ref.spec.name];
    else ports[ref.spec.name] = value;
    this.#devices[ref.device] = { ...device, ports };
  }

  private newSignal(name: string): number {
    this.#signals ??= new Map(this.now.structure.signals);
    const id = nextId(this.#signals);
    const taken = new Set(this.#signals.values());
    let unique = name;
    for (let k = 2; taken.has(unique); k++) unique = `${name}_${k}`;
    this.#signals.set(id, unique);
    return id;
  }

  private newBus(): number {
    this.#buses ??= new Map(this.now.structure.buses);
    const id = nextId(this.#buses);
    this.#buses.set(id, `bus_${id}`);
    return id;
  }

  // ---- operations ----

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
    return `connect ${this.name(driver)} -> ${this.name(reader)} (new ${this.tableName(SIGNAL, id)})`;
  }

  private readsAnother(reader: PortRef): string {
    const reads = this.value(reader)!;
    return `${this.name(reader)} already reads ${this.tableName(SIGNAL, reads)}; disconnect it first`;
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
          `${this.name(ref)} is already on ${this.tableName(BUS, current)}; disconnect it first`,
        );
      }
      this.setPort(ref, net.id);
      return `connect ${this.name(ref)} -> ${name}`;
    }
    if (current !== undefined) {
      throw new Refusal(
        ref.spec.flow === 'out'
          ? `${this.name(ref)} already drives ${this.tableName(SIGNAL, current)}`
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
        throw new Refusal(`${name} is already driven by ${driver}; disconnect it first`);
      }
    }
    this.setPort(ref, signal);
    return `connect ${this.name(ref)} -> ${name}`;
  }

  private connectBus(a: PortRef, b: PortRef): string {
    const va = this.value(a);
    const vb = this.value(b);
    if (va !== undefined && vb !== undefined) {
      if (va === vb) throw new Refusal(`${this.name(a)} and ${this.name(b)} share a bus already`);
      throw new Refusal(
        `${this.name(b)} is already on ${this.tableName(BUS, vb)}; disconnect it first`,
      );
    }
    const id = va ?? vb ?? this.newBus();
    this.setPort(a, id);
    this.setPort(b, id);
    return `connect ${this.name(a)} -> ${this.name(b)} on ${this.tableName(BUS, id)}`;
  }

  private disconnect(ref: PortRef): string {
    const value = this.value(ref);
    if (value === undefined) return '';
    const from = this.tableName(ref.spec.kind, value);
    this.setPort(ref, undefined);
    return `disconnect ${this.name(ref)} from ${from}`;
  }

  /** Add a device of a class, placed at `at` or by the layout, and wired as it lands. */
  private insert(
    classId: string,
    at: readonly [number, number] | null,
    wire?: { readonly port: string; readonly to: Document.Port },
  ): string {
    if (!isClassName(classId)) throw new Refusal(`this case has no class ${classId}`);
    this.scope = 'structure';
    const taken = new Set(this.devices.map((device) => device.id));
    const base = classId.toLowerCase();
    let k = 1;
    while (taken.has(`${base}_${k}`)) k++;
    const device: Device = { cls: classId, id: `${base}_${k}`, ports: {} };
    this.#devices ??= [...this.now.structure.devices];
    this.#devices.push(device);
    this.#inserted++;
    if (at) {
      this.#placements ??= new Map(this.now.placements);
      this.#placements.set(deviceKey(device), [at[0], at[1]]);
    }
    const said = `insert ${CLASSES[classId].title} ${device.id}`;
    if (!wire) return said;
    const spec = (CLASSES[classId].ports as readonly PortSpec[]).find(
      (entry) => entry.name === wire.port,
    );
    if (!spec) throw new Refusal(`${CLASSES[classId].title} has no port ${wire.port}`);
    const ref = { device: this.#devices.length - 1, spec };
    return `${said}; ${this.connect(ref, this.port(wire.to))}`;
  }

  /** Remove devices and nets; every port on a removed net becomes unwired. */
  private remove(elements: readonly Model.Element[]): string {
    let blocks = 0;
    let nets = 0;
    for (const element of elements) {
      if (element.classId === 'signal' || element.classId === 'bus') {
        const net = this.netOf(element);
        if (!this.table(net.kind).has(net.id)) continue;
        this.removeNet(net);
        nets++;
      } else {
        const device = this.member(element);
        if (this.#dropped.has(device)) continue;
        this.#dropped.add(device);
        const { cls, ports } = this.devices[device]!;
        for (const spec of CLASSES[cls].ports as readonly PortSpec[]) {
          const value = ports[spec.name];
          if (value !== undefined) this.#freed[spec.kind].add(value);
        }
        blocks++;
      }
      this.removed.push(element);
    }
    if (blocks + nets === 0) return '';
    this.scope = 'structure';
    const said = [blocks > 0 ? plural(blocks, 'block') : '', nets > 0 ? plural(nets, 'net') : ''];
    return `delete ${said.filter((part) => part !== '').join(', ')}`;
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
      this.#buses ??= new Map(this.now.structure.buses);
      this.#buses.delete(net.id);
    } else {
      this.#signals ??= new Map(this.now.structure.signals);
      this.#signals.delete(net.id);
    }
  }

  /** Pin blocks at top-left corners, or with null hand them back to the layout. */
  private place(elements: readonly Model.Element[], positions: Float32Array | null): string {
    if (positions !== null && positions.length !== elements.length * 2) {
      throw new Refusal('a placement takes two numbers per block');
    }
    const placements = (this.#placements ??= new Map(this.now.placements));
    let placed = 0;
    elements.forEach((element, i) => {
      const key = deviceKey(this.devices[this.device(element)]!);
      if (positions === null) {
        if (placements.delete(key)) placed++;
        return;
      }
      placements.set(key, [positions[2 * i]!, positions[2 * i + 1]!]);
      placed++;
    });
    if (placed === 0) return '';
    return positions === null
      ? `${plural(placed, 'placement')} cleared`
      : `move ${plural(placed, 'block')}`;
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
