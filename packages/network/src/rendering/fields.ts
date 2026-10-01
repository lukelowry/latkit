import { resolveScale, scaleValue } from '@latkit/gpu';
import {
  GpuError,
  type FieldInput,
  type GpuPage,
  type NativeFields,
  type Preparation,
} from '@latkit/gpu';
import type { ColorScale, Position2D as Position, Scale } from '@latkit/gpu';
import type { EdgeOptions, PathOptions, VertexOptions } from '../data.js';
import type { VertexBank, EdgeBank } from '../geometry/topology.js';
import { nativeValue } from '../geometry/rows.js';
export interface ReadPage {
  readonly page: GpuPage;
  readonly offset: number;
}
export interface FieldRead {
  readonly pages: readonly ReadPage[];
  readonly native: readonly NativeFields[];
  readonly scales: Readonly<Record<string, import('@latkit/gpu').ResolvedScale>>;
  readonly vector: boolean;
}
export function splitPosition(
  position: Position,
): position is { readonly x: FieldInput; readonly y: FieldInput } {
  return typeof position === 'object' && 'x' in position;
}
export async function readFields(
  frame: Preparation,
  source: import('@latkit/model').Queryable,
  bank: VertexBank | EdgeBank,
  options: VertexOptions | EdgeOptions | PathOptions,
  position: Position | undefined,
  retain: (native: NativeFields) => void,
): Promise<FieldRead> {
  const fields: Record<string, FieldInput> = {};
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
  const control = new Set(['bends', 'points', 'junction', 'junctionX', 'junctionY']);
  const pages: ReadPage[] = [],
    native: NativeFields[] = [];
  for await (const tile of frame.fields({
    source,
    from: bank.index.type,
    rows: { ...bank.rows, index: bank.index },
    fields,
  })) {
    retain(tile);
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
  frame: Preparation,
  source: import('@latkit/model').Queryable,
  reads: Map<VertexBank | EdgeBank, FieldRead>,
  config: (bank: VertexBank | EdgeBank) => VertexOptions | EdgeOptions | PathOptions,
): Promise<void> {
  const groups = new Map<VertexOptions | EdgeOptions | PathOptions, (VertexBank | EdgeBank)[]>();
  for (const bank of reads.keys()) {
    const options = config(bank),
      banks = groups.get(options) ?? [];
    banks.push(bank);
    groups.set(options, banks);
  }
  for (const [options, banks] of groups) {
    const scales: Record<string, import('@latkit/gpu').ResolvedScale> = {};
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
      scales[name] = resolveScale(
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
  tile: NativeFields,
  row: number,
  mapping: Scale | ColorScale | null | undefined,
  fallback: number,
): number {
  const raw = nativeValue(tile, name, row);
  if (!mapping || !Number.isFinite(raw)) return fallback;
  return scaleValue(raw, read.scales[name] ?? resolveScale({}, null)) ?? fallback;
}

function mappings(options: VertexOptions | EdgeOptions | PathOptions) {
  return {
    color: options.color,
    size: 'size' in options ? options.size : undefined,
    height: 'height' in options ? options.height : undefined,
  };
}
