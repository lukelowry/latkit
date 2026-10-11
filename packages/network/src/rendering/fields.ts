import {
  failure,
  type Data,
  type FieldInput,
  type FieldValues,
  type FieldsBlock,
} from '@latkit/model';
import { kit } from '@latkit/gpu';
import type { EdgeOptions, VertexOptions } from '../data.js';
import type { VertexBank, EdgeBank } from '../geometry/topology.js';
import { FLOW_RANGE, RADIUS_RANGE, WIDTH_RANGE } from '../options.js';

/** What a vertex reads, and how: a field spans the range, or reads as it is when raw. */
export const VERTEX = {
  x: 'raw',
  y: 'raw',
  z: [0, 1],
  radiusPx: RADIUS_RANGE,
  color: 'color',
  visible: 'raw',
  shade: 'raw',
  // What a marker reads, its inputs in order.
  input0: 'raw',
  input1: 'raw',
  input2: 'raw',
  input3: 'raw',
  input4: 'raw',
  input5: 'raw',
  input6: 'raw',
  input7: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
/**
 * What an edge reads; its x and y center a net's star, and its lane is its place
 * among the edges joining the same two vertices, which the view finds.
 */
export const LINE = {
  x: 'raw',
  y: 'raw',
  widthPx: WIDTH_RANGE,
  color: 'color',
  visible: 'raw',
  shade: 'raw',
  dash: 'raw',
  flowPx: FLOW_RANGE,
  lane: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
export type ChannelName = keyof typeof VERTEX | keyof typeof LINE;
const NAMES = [...new Set([...Object.keys(VERTEX), ...Object.keys(LINE)])] as ChannelName[];
export type Options = VertexOptions | EdgeOptions;
/** What a row reads without a value: no position, no height, and shown. */
const FALLBACK: Readonly<Partial<Record<ChannelName, number>>> = {
  x: NaN,
  y: NaN,
  z: 0,
  visible: 1,
  shade: 0,
  dash: 0,
};
const UNSET: kit.BoundChannel = { component: 0 };

export type Kinds = typeof VERTEX | typeof LINE;
const bindings = new Map<Kinds, WeakMap<object, kit.BoundChannels<ChannelName>>>([
  [VERTEX, new WeakMap()],
  [LINE, new WeakMap()],
]);
/** Banks' channels by their type's, then by what the view found for each bank. */
const banks = new WeakMap<
  kit.BoundChannels<ChannelName>,
  WeakMap<FieldValues, kit.BoundChannels<ChannelName>>
>();
/** A type's channels, bound once per options object: what checks, placement, and reads share. */
export function channels(options: Options, kinds: Kinds): kit.BoundChannels<ChannelName> {
  const cache = bindings.get(kinds)!;
  let found = cache.get(options);
  if (!found) cache.set(options, (found = bind(options, kinds)));
  return found;
}
/**
 * A bank's channels: its type's, with what the view finds for the bank itself in place of its own,
 * every vertex's position where layout placed any or every edge's lane. A restyle keeps the layout
 * and lanes, and a new layout keeps the style, so both key the binding.
 */
export function bankChannels(
  options: Options,
  kinds: Kinds,
  local?: FieldValues,
): kit.BoundChannels<ChannelName> {
  const shared = channels(options, kinds);
  if (!local) return shared;
  let laid = banks.get(shared);
  if (!laid) banks.set(shared, (laid = new WeakMap()));
  let found = laid.get(local);
  if (!found) {
    const own =
      kinds === VERTEX
        ? { x: { field: local }, y: { field: local, component: 1 } }
        : { lane: { field: local } };
    laid.set(local, (found = bind(options, kinds, own)));
  }
  return found;
}
/**
 * A kind names only its own channels; the others stay unbound. A marker's inputs read as `input0`
 * and on, in the order it names them.
 */
function bind(options: Options, kinds: Kinds, own: object = {}): kit.BoundChannels<ChannelName> {
  const marker = 'marker' in options ? options.marker : undefined,
    inputs = Object.fromEntries(
      Object.values(marker?.inputs ?? {}).map((channel, i) => ['input' + i, channel]),
    );
  return kit.bindChannels(
    { ...options, ...inputs, ...own },
    kinds as Readonly<Record<ChannelName, kit.ChannelKind>>,
  );
}

export interface ReadPage {
  readonly page: kit.GpuPage;
  readonly offset: number;
}
/** A bank's fields, uploaded, and its channels ready to read. */
export class FieldRead {
  /** Each channel ready to read, rows without a value reading its default. */
  readonly channels: Readonly<Record<ChannelName, kit.ResolvedChannel>>;
  /** Channels read with fallbacks of the caller's, such as a style's marker radius. */
  private readonly custom = new Map<ChannelName, Map<number, kit.ResolvedChannel>>();
  constructor(
    readonly pages: readonly ReadPage[],
    readonly native: readonly FieldsBlock[],
    readonly bound: kit.BoundChannels<ChannelName>,
    /** Each scaled channel's domain, resolved across its type's banks. */
    readonly scales: Readonly<Partial<Record<ChannelName, kit.ResolvedScale>>> = {},
  ) {
    const channels = {} as Record<ChannelName, kit.ResolvedChannel>;
    for (const name of NAMES) channels[name] = this.read(name, FALLBACK[name] ?? 0);
    this.channels = channels;
  }
  /** Whether the type binds a channel, to a field or a constant. */
  has(name: ChannelName): boolean {
    const channel = this.bound.channels[name];
    return !!channel && (channel.field !== undefined || channel.constant !== undefined);
  }
  /** A channel ready to read; rows without a value read `fallback`, or its default. */
  channel(name: ChannelName, fallback?: number): kit.ResolvedChannel {
    if (fallback === undefined) return this.channels[name];
    let reads = this.custom.get(name);
    if (!reads) this.custom.set(name, (reads = new Map<number, kit.ResolvedChannel>()));
    let read = reads.get(fallback);
    if (!read) reads.set(fallback, (read = this.read(name, fallback)));
    return read;
  }
  /** An unset axis reads 0, so one bound axis lays rows along it. */
  private read(name: ChannelName, fallback: number): kit.ResolvedChannel {
    const bound = this.bound.channels[name] ?? UNSET,
      own = (name === 'x' || name === 'y') && bound.field === undefined ? 0 : fallback;
    return kit.resolveChannel(bound, this.scales[name], own);
  }
  scaled(scales: Readonly<Partial<Record<ChannelName, kit.ResolvedScale>>>): FieldRead {
    return new FieldRead(this.pages, this.native, this.bound, scales);
  }
}

/** The polylines a type draws through: an edge's bends. */
function lists(options: Options): Record<string, FieldInput> {
  return 'bends' in options && options.bends ? { bends: options.bends } : {};
}
export async function readFields(
  frame: kit.Preparation,
  source: Data,
  bank: VertexBank | EdgeBank,
  options: Options,
  local?: FieldValues,
): Promise<FieldRead> {
  const bound = bankChannels(options, 'batches' in bank ? LINE : VERTEX, local),
    select = Object.keys(bound.fields);
  const pages: ReadPage[] = [],
    native: FieldsBlock[] = [];
  for await (const tile of frame.reader.fields({
    source,
    from: bank.index.type,
    rows: { ...bank.rows, index: bank.index },
    fields: { ...bound.fields, ...lists(options) },
  })) {
    native.push(tile);
    const bends = tile.columns.bends;
    if (bends && (bends.kind !== 'list' || bends.values.kind !== 'vector' || bends.values.size !== 2))
      throw failure('invalid-input', 'Bends require lists of two-component numeric vectors');
    for (const page of frame.upload(tile, { select, float64: 'relative' }))
      pages.push({ page, offset: page.rowOffset });
  }
  return new FieldRead(pages, native, bound);
}
/** Resolve each scaled channel once across a type's banks, never per upload page. */
export async function resolveDomains(
  frame: kit.Preparation,
  source: Data,
  reads: Map<VertexBank | EdgeBank, FieldRead>,
  config: (bank: VertexBank | EdgeBank) => Options,
): Promise<void> {
  const groups = new Map<Options, (VertexBank | EdgeBank)[]>();
  for (const bank of reads.keys()) {
    const options = config(bank),
      banks = groups.get(options) ?? [];
    banks.push(bank);
    groups.set(options, banks);
  }
  for (const banks of groups.values()) {
    const scales: Partial<Record<ChannelName, kit.ResolvedScale>> = {};
    for (const [name, channel] of Object.entries(reads.get(banks[0])!.bound.channels) as [
      ChannelName,
      kit.BoundChannel,
    ][]) {
      if (!channel.scale || channel.field === undefined) continue;
      let lo = Infinity,
        hi = -Infinity;
      for (const bank of banks) {
        const scale = await kit.fieldScale(frame.reader, {
          ...channel.scale,
          source,
          from: bank.index.type,
          rows: { ...bank.rows, index: bank.index },
          field: channel.field,
        });
        if (scale.domain) {
          lo = Math.min(lo, scale.domain[0]);
          hi = Math.max(hi, scale.domain[1]);
        }
      }
      scales[name] = kit.resolveScale(channel.scale, lo <= hi ? [lo, hi] : null);
    }
    for (const bank of banks) reads.set(bank, reads.get(bank)!.scaled(scales));
  }
}
/** What a read's channels place, by identity: their lanes, scales, constants, and columns. */
export function readIdentity(
  read: FieldRead,
  names: readonly ChannelName[] = ['x', 'y'],
): unknown[] {
  const key: unknown[] = [],
    fields = new Set<string>();
  const view = (value?: ArrayBufferView) => {
    key.push(value?.buffer, value?.byteOffset, value?.byteLength, value?.constructor);
  };
  for (const name of names) {
    const channel = read.channel(name);
    key.push(channel.column, channel.component, channel.fallback, ...(channel.scale?.domain ?? []));
    key.push(...(channel.scale?.range ?? []), channel.scale?.clamp);
    if (channel.column !== undefined) fields.add(channel.column);
  }
  for (const tile of read.native) {
    key.push(tile.rows.kind);
    if (tile.rows.kind === 'range') key.push(tile.rows.offset, tile.rows.count);
    else view(tile.rows.values);
    for (const field of fields) {
      const column = tile.columns[field];
      key.push(column?.kind, column?.offset, column?.length);
      view(column?.validity);
      view(tile.presence[field]);
      if (column?.kind === 'vector') {
        key.push(column.size, column.values.offset, column.values.length);
        view(column.values.values);
      } else if (column && column.kind !== 'list' && column.kind !== 'text') view(column.values);
    }
  }
  return key;
}
export function sameIdentity(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
