/**
 * A document: a native case open for editing. It owns the current bytes and edit history,
 * describes the case as a block diagram, and produces immutable models on demand.
 */

import type { Model } from './model.js';

/** Steps a history keeps; making one more forgets the oldest. */
const DEPTH = 200;

/** A net no element of a field drives. */
const NONE = 0xffffffff;

/**
 * A case open for editing: operations in the model's identities, one history that takes any of
 * them back, and the case as a block diagram. Subclass it for a format: `change` the case for some
 * operations, `revert` a change, `inspect` native values and wiring, describe the `schematic` and
 * `palette`, and `open` the model of the case as it stands; the base keeps the history of the
 * last 200 steps, maps the schematic's parts to elements, and opens a model only when asked.
 * A format opens or creates documents through `Document.Format`; the host owns their lifetime
 * and saves their bytes. A model already produced stays immutable across later edits.
 */
export abstract class Document {
  readonly #undo: Document.Change[] = [];
  readonly #redo: Document.Change[] = [];
  readonly #listeners = new Set<(change: Document.Change) => void>();
  #opening: { readonly promise: Promise<Model>; readonly controller: AbortController } | null =
    null;
  readonly #parts = Document.parts(() => this.schematic);

  /** Local lookups over a schematic or a getter for a changing schematic. */
  static parts(source: Document.Schematic | (() => Document.Schematic)): Document.Parts {
    return new Parts(typeof source === 'function' ? source : () => source);
  }

  /** The case as a block diagram, as of the last change. */
  abstract get schematic(): Document.Schematic;

  /** The classes a diagram can add as blocks, in palette order. */
  abstract get palette(): readonly Document.BlockClass[];

  /**
   * Make `operations` true as one step, or return null when the case already agrees. A refused
   * edit throws and leaves the case as it was.
   *
   * @throws Refusal saying why, and what it is about.
   */
  apply(...operations: Document.Operation[]): Document.Change | null {
    const change = this.change(operations);
    if (!change) return null;
    if (this.#undo.push(change) > DEPTH) this.#undo.shift();
    this.#redo.length = 0;
    this.#changed(change);
    return change;
  }

  /** Take the last step back, returning the change that makes it again; null when there is none. */
  undo(): Document.Change | null {
    const change = this.#undo.pop();
    if (!change) return null;
    const reverse = this.revert(change);
    this.#redo.push(reverse);
    this.#changed(reverse);
    return reverse;
  }

  /** Make the last step taken back again; null when there is none. */
  redo(): Document.Change | null {
    const change = this.#redo.pop();
    if (!change) return null;
    const again = this.revert(change);
    this.#undo.push(again);
    this.#changed(again);
    return again;
  }

  /** The steps `undo` and `redo` take next, nearest first, the last 200: what a history lists. */
  get history(): {
    readonly undo: readonly Document.Change[];
    readonly redo: readonly Document.Change[];
  } {
    return { undo: [...this.#undo].reverse(), redo: [...this.#redo].reverse() };
  }

  /** The element drawn by a schematic part, or null. */
  elementAt(part: Document.Part): Model.Element | null {
    return this.#parts.elementAt(part);
  }
  /** The schematic part drawing an element, or null. */
  partOf(element: Model.Element): Document.Part | null {
    return this.#parts.partOf(element);
  }
  /** A schematic port in the case's identities. */
  portAt(index: number): Document.Port {
    return this.#parts.portAt(index);
  }
  /** The schematic index of a port, or null. */
  portOf(port: Document.Port): number | null {
    return this.#parts.portOf(port);
  }
  /** The elements whose recorded field drives each net. */
  drivers(ref: Model.FieldRef): Uint32Array {
    return this.#parts.drivers(ref);
  }

  /** An element's identity across edits; null when it has none. */
  abstract keyOf(element: Model.Element): string | null;

  /** The element an identity names now; null when the case no longer has it. */
  abstract find(key: string): Model.Element | null;

  /**
   * Current editable values and wiring, including elements absent from the diagram. Return null
   * only when the element does not exist. Read native indexes without opening a model; do not
   * mutate the document. Values use the column names accepted by `set`.
   */
  abstract inspect(element: Model.Element): Document.Inspection | null;

  /** Current native bytes, including placement, for the host to save; the caller's own. */
  abstract bytes(signal?: AbortSignal): Promise<Uint8Array>;

  /**
   * An immutable model of the current case, first opened when asked for. Readers share one open;
   * layout changes keep it, and values or structure changes invalidate it. A failed open rejects
   * its readers; the next call retries without requiring an edit. Cancelling one reader does not
   * cancel the shared open.
   */
  async model(signal?: AbortSignal): Promise<Model> {
    signal?.throwIfAborted();
    if (this.#opening === null) {
      const controller = new AbortController();
      const promise = (async (): Promise<Model> => {
        const model = await this.open(controller.signal);
        controller.signal.throwIfAborted();
        return model;
      })();
      // Only this attempt may clear the cached open; an older failure cannot invalidate a new one.
      void promise.catch(() => {
        if (this.#opening?.promise === promise) this.#opening = null;
      });
      this.#opening = { promise, controller };
    }
    const model = await this.#opening.promise;
    signal?.throwIfAborted();
    return model;
  }

  /** A step was made, taken back, or made again; the schematic already shows it. */
  on(_event: 'change', listener: (change: Document.Change) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /**
   * Make `operations` true in the case as one change; null when it already agrees.
   *
   * @throws Refusal saying why, and nothing changes.
   */
  protected abstract change(operations: readonly Document.Operation[]): Document.Change | null;

  /** Take `change` back, returning the change that makes it again. */
  protected abstract revert(change: Document.Change): Document.Change;

  /**
   * Capture an immutable model of the current case. Its values and native bytes must remain
   * independent of later edits, even when they are loaded lazily.
   */
  protected abstract open(signal: AbortSignal): Promise<Model>;

  #changed(change: Document.Change): void {
    if (change.scope !== 'layout') {
      this.#opening?.controller.abort();
      this.#opening = null;
    }
    for (const listener of [...this.#listeners]) listener(change);
  }
}

/** What a document speaks: its format, netlists and their parts, operations, changes, and schematics. */
export declare namespace Document {
  /**
   * A native format a host registers. Opening and creating both return an independent document;
   * neither needs to build a model. The host owns files, permissions, document lifetime, and
   * saving. Implementations honor an aborted signal by rejecting.
   */
  interface Format {
    /** The format's identity, matching the models its documents produce. */
    readonly id: string;
    /** The name a host shows when choosing a format. */
    readonly label: string;
    /** Filename suffixes including the dot, preferred first; for example, `.case.json`. */
    readonly extensions: readonly string[];
    /** Open native bytes without modifying them; the returned document owns its editable state. */
    open(bytes: Uint8Array, signal?: AbortSignal): Promise<Document>;
    /**
     * A new native document. `name` is the case's display name; its filename and destination are
     * the host's choice. Absent when this format cannot create cases. Does not write a file.
     */
    create?(name: string, signal?: AbortSignal): Promise<Document>;
  }
  /** A revision belongs to one live document owner; a recreated owner has a new epoch. */
  interface Version {
    readonly epoch: string;
    readonly revision: number;
  }
  /** An element in this revision, and its identity across edits when the format provides one. */
  interface Reference {
    readonly element: Model.Element;
    readonly key: string | null;
  }
  /**
   * One element's editable values and complete wiring in a single document revision. This is
   * native document data, independent of displayed model columns or diagram visibility. Treat
   * the result as read-only; implementations may reuse their indexed data.
   */
  interface Inspection extends Reference {
    /** Column names accepted by `set`, with their current values; empty when none are editable. */
    readonly values: Readonly<Record<string, Extract<Operation, { kind: 'set' }>['value']>>;
    /** Every declared port, including unwired ports whose net is null. */
    readonly ports: readonly { readonly name: string; readonly net: Reference | null }[];
    /** For a net, the element ports on it; empty when none are connected. */
    readonly members: readonly { readonly owner: Reference; readonly port: string }[];
  }
  /** An inspection and its revision, retained together when drafting an edit. */
  interface InspectionResult {
    readonly version: Version;
    readonly inspection: Inspection | null;
  }
  /** The document state a session keeps locally, replaced before a change is announced. */
  interface View {
    readonly version: Version;
    readonly schematic: Schematic;
    readonly palette: readonly BlockClass[];
    readonly history: Document['history'];
  }
  /** An immutable model held by a session's caller; close it once its readers and runs finish. */
  type Snapshot = Model & { close(): void };
  /** Local schematic lookup methods, shared by documents and sessions. */
  type Parts = Pick<Document, 'elementAt' | 'partOf' | 'portAt' | 'portOf' | 'drivers'>;
  /**
   * An asynchronous editing boundary. Edits use an explicit base or the view's version at
   * invocation and resolve after their accepted change is visible locally. Concurrent stale edits
   * reject with `DocumentConflict`; they are never silently rebased. A snapshot stays immutable
   * across edits.
   */
  interface Session extends Parts {
    readonly view: View;
    /** Apply against the cached view's revision at invocation. */
    apply(...operations: Operation[]): Promise<Change | null>;
    /** Apply a retained draft against the revision it inspected; the owner rejects stale bases. */
    apply(base: Version, ...operations: Operation[]): Promise<Change | null>;
    /**
     * Inspect an element in the cached revision, or resolve a key within that revision. Missing
     * elements return null inside the result; stale revisions reject with `DocumentConflict`.
     * No model is opened. Later edits do not change the returned data or its version.
     */
    inspect(target: Model.Element | string, signal?: AbortSignal): Promise<InspectionResult>;
    undo(): Promise<Change | null>;
    redo(): Promise<Change | null>;
    /** Capture an immutable model for views or execution; close it when its readers finish. */
    model(signal?: AbortSignal): Promise<Snapshot>;
    /** Export current native bytes, including placement, for the host to save. */
    bytes(signal?: AbortSignal): Promise<Uint8Array>;
    on(event: 'change', listener: (change: Change) => void): () => void;
  }

  /**
   * A block diagram's structure, columnar: blocks, the ports each block owns, and the nets that
   * join ports. The shape `@latkit/diagram` loads. Placement is not structure; it is a renderer's
   * position channel, so a drag or a layout never rebuilds a netlist.
   *
   * @remarks
   * `0xffffffff` marks "none" wherever an index may be absent. Counts are derived: the port count
   * is `portStart[blockCount]`, the net count `netStart.length - 1`.
   */
  interface Netlist {
    /** Number of blocks. */
    readonly blockCount: number;
    /**
     * Identity across loads, unique per block: a reload keeps the automatic position, the
     * placement, and the selection of every block whose key survives. Without keys, a changed
     * netlist starts over.
     */
    readonly blockKey?: readonly string[];
    /** Block `b` owns ports `portStart[b]` up to `portStart[b + 1]`; `blockCount + 1` long, from 0. */
    readonly portStart: Uint32Array;
    /** Per port: `0` in, `1` out, `2` both (an undirected terminal). */
    readonly portFlow: Uint8Array;
    /** Per port: a compatibility class; only ports of one kind share a net. @defaultValue all `0` */
    readonly portKind?: Uint8Array;
    /** Per port: `0` left, `1` right, `2` top, `3` bottom. @defaultValue in left, out right, both top */
    readonly portSide?: Uint8Array;
    /**
     * Net `n` joins `netPorts[netStart[n]]` up to `netPorts[netStart[n + 1]]`: at most one `out`
     * port, its driver, and every port on at most one net. `netStart` begins at 0.
     */
    readonly netStart: Uint32Array;
    /** The ports of every net, net after net, as `netStart` delimits them. */
    readonly netPorts: Uint32Array;
    /** Per net: `0` drawn as wires, `1` as a tag at each port, for a net too wide to wire (a bus). */
    readonly netStyle?: Uint8Array;
    /** Per block: its group, or `0xffffffff`. A group is framed, arranged, and moved as one. */
    readonly blockGroup?: Uint32Array;
    /** Number of groups. @defaultValue `0` */
    readonly groupCount?: number;
    /** Per block: the heading drawn inside it, between its ports' labels, such as its class. */
    readonly blockTitle?: readonly string[];
    /** Per block: the name drawn under it, such as its id. */
    readonly blockLabel?: readonly string[];
    /**
     * Per port: the name drawn beside it inside its block; a top or bottom port's name sits in a
     * band along that edge.
     */
    readonly portLabel?: readonly string[];
    /** Per net: the name drawn on its wire, or in each of its tags. */
    readonly netLabel?: readonly string[];
    /** Per group: the name drawn in its frame's header. */
    readonly groupLabel?: readonly string[];
  }
  /** One piece of a netlist by index. Field-for-field the part `@latkit/diagram` picks. */
  interface Part {
    readonly kind: 'block' | 'port' | 'net' | 'group';
    readonly index: number;
  }
  /** A port of an element, by the name its class gives it. */
  interface Port {
    readonly element: Model.Element;
    readonly port: string;
  }
  /** One change to a case, in the model's identities. */
  type Operation =
    /** Wire a port to another port, or onto a net. */
    | {
        readonly kind: 'connect';
        readonly from: Port;
        readonly to: Port | { readonly net: Model.Element };
      }
    | { readonly kind: 'disconnect'; readonly port: Port }
    /**
     * Add an element of a class as a block at a diagram point, or where the layout puts it with
     * null; wired as it lands when `wire` says to.
     */
    | {
        readonly kind: 'insert';
        readonly classId: string;
        readonly at: readonly [x: number, y: number] | null;
        readonly wire?: { readonly port: string; readonly to: Port };
      }
    | { readonly kind: 'remove'; readonly elements: readonly Model.Element[] }
    /** Pin blocks at top-left corners, two floats each; null hands them back to the layout. */
    | {
        readonly kind: 'place';
        readonly elements: readonly Model.Element[];
        readonly positions: Float32Array | null;
      }
    /** Set one column of one element. */
    | {
        readonly kind: 'set';
        readonly element: Model.Element;
        readonly column: string;
        readonly value: number | string | boolean | null;
      }
    /** Record one signal of a class, or stop recording it. */
    | {
        readonly kind: 'record';
        readonly classId: string;
        readonly signal: string;
        readonly recorded: boolean;
      };
  /** What one step changed. */
  interface Change {
    /** What taking it back undoes, as a history lists it. */
    readonly label: string;
    /** What follows it: `layout` the schematic alone, `values` the model, `structure` both. */
    readonly scope: 'layout' | 'values' | 'structure';
    /** The elements it made, such as an inserted block. */
    readonly created: readonly Model.Element[];
  }
  /** The case as a block diagram: what `@latkit/diagram` draws, and what each part is. */
  interface Schematic {
    readonly netlist: Netlist;
    /** Per block, the element it is. */
    readonly blocks: readonly Model.Element[];
    /** Per net, the element it is: a signal, or the bus a tagged net stands for; null for none. */
    readonly nets: readonly (Model.Element | null)[];
    /** Per net, the recorded signal of the element that drives it; null when nothing records it. */
    readonly sources: readonly ({
      readonly field: Model.FieldRef;
      readonly index: number;
    } | null)[];
    /**
     * Per port, the diagram's `portStatus`: `0` fine, `1` a required port left unwired, `2` wiring
     * the case refuses.
     */
    readonly status: Float32Array;
    /** Per block, the corner the user placed it at, two floats; NaN where the layout places it. */
    readonly positions: Float32Array;
    /** What is wrong with the case's wiring, and where; empty when nothing is. */
    readonly problems: readonly Problem[];
  }
  /** A wiring problem, located in the case. */
  interface Problem {
    readonly at: Port | Model.Element;
    /** `unsupported` means the case's definitions cannot check it, not that it is invalid. */
    readonly kind: 'unwired' | 'invalid' | 'unsupported';
    readonly message: string;
  }
  /** A class a diagram can add as a block, as a palette lists it. */
  interface BlockClass {
    readonly classId: string;
    readonly label: string;
    /** The family a palette groups it under. */
    readonly group: string;
    /** Its ports in the order its block draws them. */
    readonly ports: readonly {
      readonly name: string;
      readonly flow: 'in' | 'out' | 'bus';
      /** Leaving the port unwired is a problem. */
      readonly required: boolean;
    }[];
  }
}

/** A local index over one schematic; no lookup makes a remote call. */
class Parts {
  /** The schematic `elementAt` and `partOf` last indexed, and the parts of its elements. */
  #indexed: {
    readonly blocks: Document.Schematic['blocks'];
    readonly nets: Document.Schematic['nets'];
    readonly parts: Map<string, Document.Part>;
  } | null = null;

  constructor(readonly source: () => Document.Schematic) {}

  get schematic(): Document.Schematic {
    return this.source();
  }

  /** The element a part of the schematic is: a block's, a net's, or a port's block; else null. */
  elementAt(part: Document.Part): Model.Element | null {
    const { blocks, nets, netlist } = this.schematic;
    if (part.kind === 'block') return blocks[part.index] ?? null;
    if (part.kind === 'net') return nets[part.index] ?? null;
    if (part.kind === 'port') {
      if (!Number.isSafeInteger(part.index) || part.index < 0) return null;
      if (part.index >= netlist.portStart[netlist.blockCount]!) return null;
      return blocks[ownerOf(netlist.portStart, part.index)] ?? null;
    }
    return null;
  }

  /** The block or net that shows an element; null when the diagram does not draw it. */
  partOf(element: Model.Element): Document.Part | null {
    const schematic = this.schematic;
    let indexed = this.#indexed;
    if (indexed?.blocks !== schematic.blocks || indexed.nets !== schematic.nets) {
      const parts = new Map<string, Document.Part>();
      schematic.blocks.forEach((block, index) => parts.set(keyOf(block), { kind: 'block', index }));
      // A bus a tagged net stands for shows as that net.
      schematic.nets.forEach((net, index) => {
        if (net) parts.set(keyOf(net), { kind: 'net', index });
      });
      indexed = { blocks: schematic.blocks, nets: schematic.nets, parts };
      this.#indexed = indexed;
    }
    return indexed.parts.get(keyOf(element)) ?? null;
  }

  /** Port `index` of the schematic, as the case names it. */
  portAt(index: number): Document.Port {
    const { blocks, netlist } = this.schematic;
    return {
      element: blocks[ownerOf(netlist.portStart, index)]!,
      port: netlist.portLabel?.[index] ?? '',
    };
  }

  /**
   * Per net of the schematic, the element of `ref.classId` whose recorded `ref` drives it, and
   * `0xffffffff` for every other net: what `field.gather` takes to show `ref` over the nets.
   */
  drivers(ref: Model.FieldRef): Uint32Array {
    const { sources } = this.schematic;
    const drivers = new Uint32Array(sources.length).fill(NONE);
    sources.forEach((source, net) => {
      const field = source?.field;
      if (field?.classId === ref.classId && field.kind === ref.kind && field.id === ref.id)
        drivers[net] = source!.index;
    });
    return drivers;
  }

  /** The schematic's index of a port the case names; null when the diagram does not draw it. */
  portOf(port: Document.Port): number | null {
    const block = this.partOf(port.element);
    if (block?.kind !== 'block') return null;
    const { portStart, portLabel } = this.schematic.netlist;
    for (let index = portStart[block.index]!; index < portStart[block.index + 1]!; index++)
      if (portLabel?.[index] === port.port) return index;
    return null;
  }
}

/** An edit or read addressed a document version that is no longer current. */
export class DocumentConflict extends Error {
  override readonly name = 'DocumentConflict';

  constructor(
    readonly expected: Document.Version,
    readonly actual: Document.Version,
  ) {
    super('The document changed; refresh the selection and try again.');
  }
}

function keyOf(element: Model.Element): string {
  return `${element.classId}\0${element.index}`;
}

/** The block that owns `port`: the last block whose first port is at or before it. */
function ownerOf(portStart: Uint32Array, port: number): number {
  let low = 0;
  let high = portStart.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (portStart[middle]! <= port) low = middle;
    else high = middle - 1;
  }
  return low;
}
