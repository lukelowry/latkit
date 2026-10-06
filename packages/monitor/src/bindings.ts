import { kit, type Colormap, type ColormapName, type RGBA } from '@latkit/gpu';
import {
  failure,
  fieldDefinition,
  rowCount,
  type Data,
  type Schema,
  type Domain,
  type RowSelection,
  type FieldBinding,
  type FieldInput,
  type ReadScope,
} from '@latkit/model';
import type { MonitorData, Trace } from './data.js';
import { domain, finite, fail } from './config.js';
import type { LayerKind } from './rendering/history.js';

/** What a trace reads: its values, and its channels; colors and widths map over their extents. */
const TRACE = {
  y: 'raw',
  color: 'color',
  widthPx: [1, 4],
  visible: 'raw',
  shade: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
export type TraceChannel = keyof typeof TRACE;
/** A row selection with its ids resolved. */
export type Rows = Exclude<RowSelection, { readonly kind: 'ids' }>;
/** How a trace's lines look over what they read: none of it is a reason to read again. */
export interface Look {
  /** The colormap's domain: the values axis for a trace colored by what it plots; null draws `base` alone. */
  readonly domain: Domain | 'values' | null;
  readonly colormap?: Colormap | ColormapName;
  /** The color of rows without a color value: the trace's own, or the style's `traceColor` when null. */
  readonly base: RGBA | null;
  readonly clamp: boolean;
  /**
   * What history keeps for it: colors when the color is fixed; coverage alone when the color reads
   * the plotted field, whose value is where a line lies; else the color values themselves.
   */
  readonly layer: LayerKind;
}
export interface Binding {
  readonly name: string;
  readonly trace: Trace;
  readonly source: Data;
  /** The field the trace plots. */
  readonly field: string;
  readonly schema: Schema;
  /** The rows the trace draws, ids resolved; every row without one. */
  readonly rows?: Rows;
  /** Rows the trace draws. */
  readonly count: number;
  /** What one read of the trace requests: its values as `y`, and each channel's field. */
  readonly fields: Readonly<Record<string, FieldInput>>;
  readonly bound: kit.BoundChannels<TraceChannel>;
  /** Each channel ready to read; the color's scale is its look's, left unresolved here. */
  readonly channels: Readonly<Record<TraceChannel, kit.ResolvedChannel>>;
  /** Whether the color follows the values axis rather than a domain of its own. */
  readonly colorFollows: boolean;
  /** New with each description: a layer stands only while the versions it drew do. */
  readonly version: number;
  readonly look: Look;
  /** Mapped traces whose looks share a key share a value layer. */
  readonly lookKey: string;
}
let versions = 0;

export function validateData(data: MonitorData): void {
  if (!data.source?.schema || !data.source.tables) fail('Monitor requires materialized data');
  for (const [name, trace] of Object.entries(data.traces)) {
    if (!name || !trace.from || !trace.y) fail('Trace requires a name, type and sampled field');
    if (typeof trace.y !== 'string' && !('field' in trace.y))
      fail('Trace requires a sampled field binding');
    if (
      trace.interpolation &&
      !['linear', 'step-before', 'step-after'].includes(trace.interpolation)
    )
      fail('Invalid interpolation');
    const { channels } = kit.bindChannels(trace, TRACE),
      { scale } = channels.color;
    if (Array.isArray(scale?.domain)) domain(scale.domain as Domain);
    if (typeof channels.widthPx.constant === 'number')
      finite(channels.widthPx.constant, 'trace width', 0.1, 64);
  }
}
export function binding(input: FieldInput, source: Data, from: string): FieldBinding | undefined {
  return typeof input === 'string'
    ? { source, from, field: input }
    : 'field' in input
      ? input
      : undefined;
}
/** Whether two configs of a trace read the same, differing at most in how its color looks. */
export function sameReads(a: Trace, b: Trace): boolean {
  return kit.sameReads(a, b, TRACE);
}
/** A trace's channels; a field name reads the request's source, so a trace named by field follows appends. */
function bindTrace(trace: Trace, main: FieldBinding): kit.BoundChannels<TraceChannel> {
  return kit.bindChannels(
    { ...trace, y: typeof trace.y === 'string' ? trace.y : { ...main, rows: undefined } },
    TRACE,
  );
}
/** How a trace's color reads its values: the plotted field, and over the values axis too. */
interface Colored {
  /** The color reads the field the trace plots. */
  readonly own: boolean;
  /** And without a domain of its own, so it follows the values axis. */
  readonly follows: boolean;
}
/** Check a trace's visual fields, and how its color reads them. */
function visuals(
  bound: kit.BoundChannels<TraceChannel>,
  data: MonitorData,
  from: string,
  main: FieldBinding,
): Colored {
  let own = false;
  for (const alias of ['color', 'widthPx', 'visible', 'shade'] as const) {
    const input = bound.channels[alias].field;
    if (input === undefined) continue;
    const other = binding(input, data.source, from);
    if (!other) continue;
    if (other.from !== from) fail('Visual fields must use the trace type');
    const definition = fields(other.source.schema, other.from)[other.field];
    if (!definition) fail('Unknown visual field ' + other.field);
    if (
      ![
        'float32',
        'float64',
        'int32',
        'uint32',
        ...(alias === 'visible' ? ['boolean'] : []),
      ].includes(definition.type as string)
    )
      fail('Visual fields must be scalar numeric data, or boolean visibility');
    if (alias === 'color')
      own = other.source === main.source && other.field === main.field && !other.rows;
  }
  return { own, follows: own && (bound.channels.color.scale?.domain ?? 'auto') === 'auto' };
}
/** The traces `names` names as the monitor reads them; sampled domains fit `window`. */
export async function describeBindings(
  reads: ReadScope,
  data: MonitorData,
  window: Domain,
  names: readonly string[] = Object.keys(data.traces),
): Promise<Binding[]> {
  const result: Binding[] = [];
  for (const name of names) {
    const trace = data.traces[name],
      main = binding(trace.y, data.source, trace.from)!;
    if (main.from !== trace.from) fail('Trace and field must belong to the same type');
    const schema = main.source.schema,
      field = fields(schema, trace.from)[main.field];
    if (
      !field?.sampled ||
      !['float32', 'float64', 'int32', 'uint32'].includes(field.type as string)
    )
      fail('Trace field must be sampled numeric data');
    if (trace.rows && main.rows && JSON.stringify(trace.rows) !== JSON.stringify(main.rows))
      fail('Specify the trace row selection once');
    const bound = bindTrace(trace, main),
      colored = visuals(bound, data, trace.from, main),
      selected = trace.rows ?? main.rows,
      table = main.source.tables[trace.from];
    // Ids resolve once here, so fitting, picking, and reading all test the same rows.
    let rows: Rows | undefined;
    if (selected?.kind === 'ids') {
      const read = await kit.readRows(reads, main.source, trace.from, selected),
        index = read.index ?? table?.index;
      rows = index
        ? { kind: 'indices', index, values: read.rows }
        : { kind: 'range', offset: 0, count: 0 };
    } else rows = selected;
    // The color's scale is its look, resolved apart: a new domain reads nothing history drew.
    const unscaled = {
      ...bound,
      channels: { ...bound.channels, color: { ...bound.channels.color, scale: undefined } },
    };
    const channels = await kit.resolveChannels(
      reads,
      { source: data.source, from: trace.from, rows, window: { kind: 'range', between: window } },
      unscaled,
      // The style's trace width stands in for a width each draw reads.
      { y: NaN, visible: 1 },
    );
    const look = await lookOf(reads, data.source, trace.from, rows, bound, colored, window);
    result.push({
      name,
      trace,
      source: main.source,
      field: main.field,
      schema,
      rows,
      count: rows ? rowCount(rows) : table ? rowCount(table.rows) : 0,
      fields: bound.fields,
      bound,
      channels,
      colorFollows: colored.follows,
      version: ++versions,
      look,
      lookKey: lookKey(look),
    });
  }
  return result;
}
/** A trace whose look alone changed: what it reads, and its version, stand. */
export async function relook(
  reads: ReadScope,
  data: MonitorData,
  previous: Binding,
  trace: Trace,
  window: Domain,
): Promise<Binding> {
  const main = binding(trace.y, data.source, trace.from)!,
    bound = bindTrace(trace, main),
    colored = visuals(bound, data, trace.from, main),
    look = await lookOf(reads, data.source, trace.from, previous.rows, bound, colored, window);
  return {
    ...previous,
    trace,
    bound,
    colorFollows: colored.follows,
    look,
    lookKey: lookKey(look),
  };
}
async function lookOf(
  reads: ReadScope,
  source: Data,
  from: string,
  rows: Rows | undefined,
  bound: kit.BoundChannels<TraceChannel>,
  colored: Colored,
  window: Domain,
): Promise<Look> {
  const tint = bound.channels.color,
    shade = bound.channels.shade,
    base = Array.isArray(tint.constant)
      ? (tint.constant as RGBA)
      : Array.isArray(tint.missing)
        ? (tint.missing as RGBA)
        : null,
    look = { base, colormap: tint.colormap, clamp: tint.scale?.clamp ?? true },
    // A line's place is its value only when it shades by nothing a pixel must remember.
    mapped: LayerKind =
      colored.own && shade.field === undefined && shade.constant === undefined
        ? 'coverage'
        : 'value';
  if (tint.field === undefined || !tint.scale) return { ...look, domain: null, layer: 'color' };
  if (colored.follows) return { ...look, domain: 'values', layer: mapped };
  const scale = await kit.fieldScale(reads, {
    ...tint.scale,
    source,
    from,
    rows,
    field: tint.field,
    window: fieldDefinition(source, from, tint.field)?.sampled
      ? { kind: 'range', between: window }
      : undefined,
  });
  return { ...look, domain: scale.domain, layer: scale.domain ? mapped : 'color' };
}
const colormapIds = new WeakMap<object, number>();
let colormapCount = 0;
function lookKey(look: Look): string {
  let colormap: unknown = look.colormap ?? null;
  if (typeof colormap === 'object' && colormap !== null) {
    let id = colormapIds.get(colormap);
    if (id === undefined) colormapIds.set(colormap, (id = ++colormapCount));
    colormap = id;
  }
  return JSON.stringify([look.layer, look.domain, colormap, look.base, look.clamp]);
}
export function fields(schema: Schema, type: string) {
  const result = schema.types[type]?.fields;
  if (!result) throw failure('invalid-input', 'Unknown model type ' + type);
  return result;
}
