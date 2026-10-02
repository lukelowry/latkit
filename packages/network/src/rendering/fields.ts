import { kit, GpuError } from '@latkit/gpu';
import type { EdgeData, PathData, VertexData } from '../data.js';
import type { VertexBank, EdgeBank } from '../geometry/topology.js';
import { nativeValue } from '../geometry/rows.js';
export interface ReadPage {
  readonly page: kit.GpuPage;
  readonly offset: number;
}
export interface FieldRead {
  readonly pages: readonly ReadPage[];
  readonly native: readonly kit.NativeFields[];
  readonly scales: Readonly<Record<string, kit.ResolvedScale>>;
  readonly vector: boolean;
}
export function splitPosition(
  position: kit.Position2D,
): position is { readonly x: kit.FieldInput; readonly y: kit.FieldInput } {
  return typeof position === 'object' && 'x' in position;
}
const fieldBindings = new WeakMap<
  object,
  {
    position: kit.Position2D | undefined;
    fields: Record<string, kit.FieldInput>;
    vector: boolean;
  }
>();
function bindings(options: VertexData | EdgeData | PathData, position: kit.Position2D | undefined) {
  const cached = fieldBindings.get(options);
  if (cached && cached.position === position) return cached;
  const fields: Record<string, kit.FieldInput> = {};
  let vector = false;
  if (position) {
    if (splitPosition(position)) {
      fields.x = position.x;
      fields.y = position.y;
    } else {
      fields.position = position;
      vector = true;
    }
  }
  for (const [name, mapped] of Object.entries(mappings(options))) {
    if (mapped) fields[name] = mapped.field;
  }
  const inputs = {
    visible: options.visible,
    shade: 'shade' in options ? options.shade : undefined,
    dash: 'dash' in options ? options.dash : undefined,
    bends: 'bends' in options ? options.bends : undefined,
    points: 'points' in options ? options.points : undefined,
  };
  for (const [name, input] of Object.entries(inputs)) if (input != null) fields[name] = input;
  if ('junction' in options && options.junction) {
    if (splitPosition(options.junction)) {
      fields.junctionX = options.junction.x;
      fields.junctionY = options.junction.y;
    } else fields.junction = options.junction;
  }
  const result = { fields, vector, position };
  fieldBindings.set(options, result);
  return result;
}
export async function readFields(
  frame: kit.Preparation,
  source: import('@latkit/model').Data,
  bank: VertexBank | EdgeBank,
  options: VertexData | EdgeData | PathData,
  position: kit.Position2D | undefined,
): Promise<FieldRead> {
  const { fields, vector } = bindings(options, position);
  const control = new Set(['bends', 'points', 'junction', 'junctionX', 'junctionY']);
  const pages: ReadPage[] = [],
    native: kit.NativeFields[] = [];
  for await (const tile of frame.fields({
    source,
    from: bank.index.type,
    rows: { ...bank.rows, index: bank.index },
    fields,
  })) {
    native.push(tile);
    for (const page of frame.upload(tile, {
      select: Object.keys(fields).filter((name) => !control.has(name)),
      float64: 'relative',
    })) {
      if (
        vector &&
        (page.columns.position.kind !== 'value' || page.columns.position.components !== 2)
      )
        throw new GpuError('invalid-input', 'Network positions must be two-component vectors');
      if (
        !vector &&
        position &&
        (page.columns.x.kind !== 'value' ||
          page.columns.y.kind !== 'value' ||
          page.columns.x.components !== 1 ||
          page.columns.y.components !== 1)
      )
        throw new GpuError('invalid-input', 'Position axes must be scalar');
      for (const [name, column] of Object.entries(page.columns))
        if (
          name !== 'position' &&
          name !== 'bends' &&
          name !== 'points' &&
          name !== 'junction' &&
          (column.kind !== 'value' || column.components !== 1)
        )
          throw new GpuError('invalid-input', 'Visual fields must be scalar');
      if (page.native) {
        for (const name of ['bends', 'points']) {
          const column = page.native.columns[name];
          if (
            column &&
            (column.kind !== 'list' || column.values.kind !== 'vector' || column.values.size !== 2)
          )
            throw new GpuError(
              'invalid-input',
              'Paths require lists of two-component numeric vectors',
            );
        }
        const junction = page.native.columns.junction;
        if (junction && (junction.kind !== 'vector' || junction.size !== 2))
          throw new GpuError('invalid-input', 'Junction positions require two-component vectors');
      }
      pages.push({ page, offset: page.rowOffset });
    }
  }
  return { pages, native, scales: {}, vector };
}
/** Resolve each mapping once across all banks, never independently per upload page. */
export async function resolveDomains(
  frame: kit.Preparation,
  source: import('@latkit/model').Data,
  reads: Map<VertexBank | EdgeBank, FieldRead>,
  config: (bank: VertexBank | EdgeBank) => VertexData | EdgeData | PathData,
): Promise<void> {
  const groups = new Map<VertexData | EdgeData | PathData, (VertexBank | EdgeBank)[]>();
  for (const bank of reads.keys()) {
    const options = config(bank),
      banks = groups.get(options) ?? [];
    banks.push(bank);
    groups.set(options, banks);
  }
  for (const [options, banks] of groups) {
    const scales: Record<string, kit.ResolvedScale> = {};
    for (const [name, mapping] of Object.entries(mappings(options))) {
      if (!mapping) continue;
      let lo = Infinity,
        hi = -Infinity;
      for (const bank of banks) {
        const scale = await frame.scale({
          source: 'source' in bank ? (bank.source ?? source) : source,
          from: bank.index.type,
          rows: { ...bank.rows, index: bank.index },
          ...mapping,
        });
        if (scale.domain) {
          lo = Math.min(lo, scale.domain[0]);
          hi = Math.max(hi, scale.domain[1]);
        }
      }
      scales[name] = kit.resolveScale(
        {
          ...mapping,
          range:
            'range' in mapping ? (mapping.range ?? (name === 'size' ? [0.5, 2] : [0, 1])) : [0, 1],
        },
        lo <= hi ? [lo, hi] : null,
      );
    }
    for (const bank of banks) reads.set(bank, { ...reads.get(bank)!, scales });
  }
}
export function scaledValue(
  read: FieldRead,
  name: string,
  tile: kit.NativeFields,
  row: number,
  mapping: kit.Scale | kit.ColorScale | null | undefined,
  fallback: number,
): number {
  const raw = nativeValue(tile, name, row);
  if (!mapping || !Number.isFinite(raw)) return fallback;
  return kit.scaleValue(raw, read.scales[name] ?? kit.resolveScale({}, null)) ?? fallback;
}

function mappings(options: VertexData | EdgeData | PathData) {
  return {
    color: options.color,
    size: 'size' in options ? options.size : undefined,
    height: 'height' in options ? options.height : undefined,
  };
}
