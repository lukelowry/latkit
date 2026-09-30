import {
  GpuError,
  rowCount,
  rowAt,
  type FieldInput,
  type FieldValues,
  type GpuPage,
  type NativeFields,
  type Preparation,
} from '@latkit/gpu';
import type { Domain } from '@latkit/model';
import type {
  ColorScale,
  EdgeOptions,
  PathOptions,
  Position,
  Scale,
  VertexOptions,
} from '../data.js';
import type { VertexBank, EdgeBank } from '../geometry/connectivity.js';
import { nativeValue } from '../geometry/rows.js';
export interface ReadPage {
  readonly page: GpuPage;
  readonly offset: number;
}
export interface FieldRead {
  readonly pages: readonly ReadPage[];
  readonly native: readonly NativeFields[];
  readonly domains: Readonly<Record<string, Domain>>;
  readonly vector: boolean;
}
const extents = new WeakMap<
  object,
  WeakMap<object, { mask?: WeakRef<Uint8Array>; value: Domain }>
>();
const identities = new WeakMap<object, FieldValues>();
function identity(bank: VertexBank | EdgeBank): FieldValues {
  let input = identities.get(bank);
  if (!input) {
    input = {
      index: bank.index,
      rows: bank.rows,
      values: {
        kind: 'boolean',
        offset: 0,
        length: bank.count,
        values: new Uint8Array(Math.ceil(bank.count / 8)),
      },
    };
    identities.set(bank, input);
  }
  return input;
}
export function splitPosition(
  position: Position,
): position is { readonly x: FieldInput; readonly y: FieldInput } {
  return typeof position === 'object' && 'x' in position;
}
function validateDomain(domain: Domain): Domain {
  if (domain.length !== 2 || !domain.every(Number.isFinite) || domain[1] < domain[0])
    throw new GpuError('invalid-input', 'Invalid field domain');
  return domain;
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
  for (const name of ['color', 'size', 'height'] as const) {
    const mapped = (options as VertexOptions)[name];
    if (mapped) fields[name] = mapped.field;
  }
  for (const name of ['visible', 'shade', 'dash'] as const) {
    const input = (options as EdgeOptions)[name];
    if (input != null) fields[name] = input;
  }
  for (const name of ['bends', 'points', 'junction'] as const) {
    const input = (options as unknown as Record<string, FieldInput>)[name];
    if (input) {
      if (name === 'junction' && splitPosition(input as Position)) {
        fields.junctionX = (input as unknown as { x: FieldInput }).x;
        fields.junctionY = (input as unknown as { y: FieldInput }).y;
      } else fields[name] = input;
    }
  }
  const control = new Set(['bends', 'points', 'junction', 'junctionX', 'junctionY']);
  if (!Object.keys(fields).some((name) => !control.has(name))) fields.identity = identity(bank);
  const pages: ReadPage[] = [],
    native: NativeFields[] = [];
  for await (const page of frame.fields({
    source,
    index: bank.index,
    rows: bank.rows,
    fields,
    float64: 'relative',
    read: Object.keys(fields),
    upload: Object.keys(fields).filter((name) => !control.has(name)),
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
    if (page.native && !native.includes(page.native)) {
      retain(page.native);
      native.push(page.native);
    }
  }
  return { pages, native, domains: {}, vector };
}
/** Resolve each mapping once across all banks, never independently per upload page. */
export async function resolveDomains(
  frame: Preparation,
  source: import('@latkit/model').Queryable,
  reads: Map<VertexBank | EdgeBank, FieldRead>,
  config: (bank: VertexBank | EdgeBank) => VertexOptions | EdgeOptions | PathOptions,
): Promise<void> {
  const groups = new Map<object, (VertexBank | EdgeBank)[]>();
  for (const bank of reads.keys()) {
    const options = config(bank),
      banks = groups.get(options) ?? [];
    banks.push(bank);
    groups.set(options, banks);
  }
  for (const [options, banks] of groups) {
    const domains: Record<string, Domain> = {};
    for (const name of ['color', 'size', 'height'] as const) {
      const mapping = (options as VertexOptions)[name];
      if (!mapping) continue;
      if (
        'range' in mapping &&
        mapping.range &&
        (mapping.range.length !== 2 || !mapping.range.every(Number.isFinite))
      )
        throw new GpuError('invalid-input', 'Invalid output range');
      if (Array.isArray(mapping.domain)) domains[name] = validateDomain(mapping.domain as Domain);
      else {
        let lo = Infinity,
          hi = -Infinity;
        if (mapping.domain && mapping.domain !== 'auto') {
          for (const bank of banks) {
            const extent = await frame.extent({
              source: 'source' in bank ? (bank.source ?? source) : source,
              index: bank.index,
              rows: bank.rows,
              field: mapping.field,
              window: (mapping.domain as { window: import('@latkit/model').SampleWindow }).window,
            });
            if (extent) {
              lo = Math.min(lo, extent[0]);
              hi = Math.max(hi, extent[1]);
            }
          }
        } else
          for (const bank of banks) {
            const read = reads.get(bank)!;
            for (const tile of read.native) {
              const column = tile.columns[name];
              if (!column) continue;
              let byBank = extents.get(column);
              if (!byBank) {
                byBank = new WeakMap();
                extents.set(column, byBank);
              }
              const cached = byBank.get(bank),
                mask = tile.presence[name];
              if (cached && cached.mask?.deref() === mask) {
                lo = Math.min(lo, cached.value[0]);
                hi = Math.max(hi, cached.value[1]);
                continue;
              }
              let min = Infinity,
                max = -Infinity;
              const lookup = bank.rows.kind === 'indices' ? new Set(bank.rows.values) : undefined;
              for (let i = 0; i < rowCount(tile.rows); i++) {
                const row = rowAt(tile.rows, i);
                if (
                  bank.rows.kind === 'range'
                    ? row < bank.rows.offset || row >= bank.rows.offset + bank.count
                    : !lookup!.has(row)
                )
                  continue;
                const value = nativeValue(tile, name, i);
                if (Number.isFinite(value)) {
                  min = Math.min(min, value);
                  max = Math.max(max, value);
                }
              }
              byBank.set(bank, { mask: mask ? new WeakRef(mask) : undefined, value: [min, max] });
              lo = Math.min(lo, min);
              hi = Math.max(hi, max);
            }
          }
        domains[name] = lo <= hi ? [lo, hi] : [0, 1];
      }
    }
    for (const bank of banks) reads.set(bank, { ...reads.get(bank)!, domains });
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
  const domain = read.domains[name] ?? [0, 1],
    range = 'range' in mapping ? (mapping.range ?? (name === 'size' ? [0.5, 2] : [0, 1])) : [0, 1];
  const t =
    domain[0] === domain[1]
      ? 0.5
      : Math.max(0, Math.min(1, (raw - domain[0]) / (domain[1] - domain[0])));
  return range[0] + t * (range[1] - range[0]);
}
