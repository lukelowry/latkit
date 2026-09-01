/**
 * The shard pack: one class's data. Number and flag columns are sections read back as views; text
 * columns are a dictionary in the directory plus a u32 index section, zero meaning null.
 */

import type { ClassData, Column } from '../model.js';
import { decode, encode, type Section, typed } from './container.js';

const KIND = 'latkit-model-shard';

interface ColumnMeta {
  readonly kind: Column['kind'];
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly group?: string;
  readonly section: string;
  readonly dictionary?: readonly string[];
}

interface Meta {
  readonly labels: readonly string[];
  readonly columns: readonly ColumnMeta[];
}

/** Pack one class's data. Returned bytes are the caller's. */
export function encodeShard(data: ClassData): Uint8Array {
  const sections: { id: string; data: Section }[] = [];
  const columns = data.columns.map((column, index): ColumnMeta => {
    const section = `column.${index}`;
    const entry: ColumnMeta = {
      kind: column.kind,
      id: column.id,
      label: column.label,
      section,
      ...(column.group !== undefined && { group: column.group }),
      ...(column.kind === 'number' && column.unit !== undefined && { unit: column.unit }),
    };
    if (column.kind !== 'text') {
      sections.push({ id: section, data: column.values });
      return entry;
    }
    const dictionary: string[] = [];
    const slots = new Map<string, number>();
    const indices = new Uint32Array(column.values.length);
    column.values.forEach((value, at) => {
      if (value === null) return;
      let slot = slots.get(value);
      if (slot === undefined) {
        slot = dictionary.push(value);
        slots.set(value, slot);
      }
      indices[at] = slot;
    });
    sections.push({ id: section, data: indices });
    return { ...entry, dictionary };
  });
  return encode<Meta>(KIND, { labels: data.labels, columns }, sections);
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Unpack one class's data; numeric columns view the received buffer. */
export function decodeShard(bytes: Uint8Array): ClassData {
  const pack = decode<{ labels?: unknown; columns?: unknown }>(bytes, KIND);
  const { labels, columns } = pack.meta;
  if (!isStrings(labels) || !Array.isArray(columns)) throw new Error('invalid shard directory');
  return {
    labels,
    columns: (columns as readonly ColumnMeta[]).map((entry): Column => {
      if (typeof entry.id !== 'string' || typeof entry.label !== 'string') {
        throw new Error('invalid shard column');
      }
      const base = {
        id: entry.id,
        label: entry.label,
        ...(entry.group !== undefined && { group: entry.group }),
      };
      switch (entry.kind) {
        case 'number':
          return {
            kind: 'number',
            ...base,
            ...(entry.unit !== undefined && { unit: entry.unit }),
            values: typed(pack, entry.section, Float64Array),
          };
        case 'flag':
          return { kind: 'flag', ...base, values: typed(pack, entry.section, Uint8Array) };
        case 'text': {
          const dictionary = entry.dictionary;
          if (!isStrings(dictionary)) throw new Error(`column '${entry.id}' lacks a dictionary`);
          const indices = typed(pack, entry.section, Uint32Array);
          const values = new Array<string | null>(indices.length);
          for (let at = 0; at < indices.length; at++) {
            const slot = indices[at]!;
            if (slot > dictionary.length)
              throw new Error(`column '${entry.id}' index out of range`);
            values[at] = slot === 0 ? null : dictionary[slot - 1]!;
          }
          return { kind: 'text', ...base, values };
        }
        default:
          throw new Error('invalid shard column kind');
      }
    }),
  };
}
