import {
  failure,
  type Data,
  type FieldInput,
  type FieldValues,
  type FieldsBlock,
} from '@latkit/model';
import { kit } from '@latkit/gpu';
import type { EdgeOptions, PathOptions, VertexOptions } from '../data.js';
import type { VertexBank, EdgeBank } from '../geometry/topology.js';
import { SIZE_RANGE, WIDTH_RANGE } from '../options.js';

/** What a vertex reads, and how: a field spans the range, or reads as it is when raw. */
export const VERTEX = {
  x: 'raw',
  y: 'raw',
  z: [0, 1],
  sizePx: SIZE_RANGE,
  color: 'color',
  visible: 'raw',
  shade: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
/** What an edge or a path reads; an edge's x and y center a net's star. */
export const LINE = {
  x: 'raw',
  y: 'raw',
  widthPx: WIDTH_RANGE,
  color: 'color',
  visible: 'raw',
  shade: 'raw',
  dash: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
export type ChannelName = keyof typeof VERTEX | keyof typeof LINE;
const NAMES = [...new Set([...Object.keys(VERTEX), ...Object.keys(LINE)])] as ChannelName[];
export type Options = VertexOptions | EdgeOptions | PathOptions;
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
/**
 * A type's channels, bound once per options object; `layout` places rows that bind neither x nor
 * y, as a circle does.
 */
export function channels(
  options: Options,
  kinds: Kinds,
  layout?: FieldValues,
): kit.BoundChannels<ChannelName> {
  const cache = bindings.get(kinds)!,
    key = layout ?? options;
  let found = cache.get(key);
  if (!found) {
    // A kind names only its own channels; the others stay unbound.
    found = kit.bindChannels(
      layout ? { ...options, x: { field: layout }, y: { field: layout, component: 1 } } : options,
      kinds as Readonly<Record<ChannelName, kit.ChannelKind>>,
    );
    cache.set(key, found);
  }
  return found;
}

export interface ReadPage {
  readonly page: kit.GpuPage;
  readonly offset: number;
}
/** A bank's fields, uploaded, and its channels ready to read. */
export class FieldRead {
  /** Each channel ready to read, rows without a value reading its default. */
  readonly channels: Readonly<Record<ChannelName, kit.ChannelRead>>;
  /** Channels read with fallbacks of the caller's, such as a style's marker radius. */
  private readonly custom = new Map<ChannelName, Map<number, kit.ChannelRead>>();
  constructor(
    readonly pages: readonly ReadPage[],
    readonly native: readonly FieldsBlock[],
    readonly bound: kit.BoundChannels<ChannelName>,
    /** Each scaled channel's domain, resolved across its type's banks. */
    readonly scales: Readonly<Partial<Record<ChannelName, kit.ResolvedScale>>> = {},
  ) {
    const channels = {} as Record<ChannelName, kit.ChannelRead>;
    for (const name of NAMES) channels[name] = this.read(name, FALLBACK[name] ?? 0);
    this.channels = channels;
  }
  /** Whether the type binds a channel, to a field or a constant. */
  has(name: ChannelName): boolean {
    const channel = this.bound.channels[name];
    return !!channel && (channel.field !== undefined || channel.constant !== undefined);
  }
  /** A channel ready to read; rows without a value read `fallback`, or its default. */
  channel(name: ChannelName, fallback?: number): kit.ChannelRead {
    if (fallback === undefined) return this.channels[name];
    let reads = this.custom.get(name);
    if (!reads) this.custom.set(name, (reads = new Map<number, kit.ChannelRead>()));
    let read = reads.get(fallback);
    if (!read) reads.set(fallback, (read = this.read(name, fallback)));
    return read;
  }
  /** An unset axis reads 0, so one bound axis lays rows along it. */
  private read(name: ChannelName, fallback: number): kit.ChannelRead {
    const bound = this.bound.channels[name] ?? UNSET,
      own = (name === 'x' || name === 'y') && bound.field === undefined ? 0 : fallback;
    return kit.channelRead(bound, this.scales[name], own);
  }
  scaled(scales: Readonly<Partial<Record<ChannelName, kit.ResolvedScale>>>): FieldRead {
    return new FieldRead(this.pages, this.native, this.bound, scales);
  }
}

/** The polylines a type draws through: an edge's bends or a path's points. */
function lists(options: Options): Record<string, FieldInput> {
  const out: Record<string, FieldInput> = {};
  if ('bends' in options && options.bends) out.bends = options.bends;
  if ('points' in options && options.points) out.points = options.points;
  return out;
}
export async function readFields(
  frame: kit.Preparation,
  source: Data,
  bank: VertexBank | EdgeBank,
  options: Options,
  layout?: FieldValues,
): Promise<FieldRead> {
  const bound = channels(options, 'batches' in bank ? LINE : VERTEX, layout),
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
    for (const name of ['bends', 'points']) {
      const column = tile.columns[name];
      if (
        column &&
        (column.kind !== 'list' || column.values.kind !== 'vector' || column.values.size !== 2)
      )
        throw failure('invalid-input', 'Paths require lists of two-component numeric vectors');
    }
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
          source: 'source' in bank ? (bank.source ?? source) : source,
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
