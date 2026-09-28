/**
 * The shard pack: one class's data. What each column is lives in the core, so a shard holds only
 * labels and values: number and flag columns are sections read back as views; a text column is a
 * dictionary in the directory plus a u32 index section, zero meaning null.
 */

import type { Model } from '../model.js';
import { decode, encode, type Section, typed } from './container.js';

const KIND = 'latkit-model-shard';

interface ColumnMeta {
  readonly kind: Model.Column['kind'];
  readonly id: string;
  readonly section: string;
  readonly dictionary?: readonly string[];
}

interface Meta {
  readonly labels: readonly string[];
  readonly columns: readonly ColumnMeta[];
}

/** Pack one class's data. Returned bytes are the caller's. */
export function encodeShard(data: Model.Data): Uint8Array {
  const sections: { id: string; data: Section }[] = [];
  const columns = data.columns.map((column, index): ColumnMeta => {
    const entry: ColumnMeta = { kind: column.kind, id: column.id, section: `column.${index}` };
    if (column.kind !== 'text') {
      sections.push({ id: entry.section, data: column.values });
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
    sections.push({ id: entry.section, data: indices });
    return { ...entry, dictionary };
  });
  return encode<Meta>(KIND, { labels: data.labels, columns }, sections);
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Unpack one class's values against the columns its spec declares; numeric columns view the
 * received buffer.
 *
 * @throws Error when the shard is not a valid pack or holds other columns than `spec` declares.
 */
export function decodeShard(bytes: Uint8Array, spec: Model.Class): Model.Values {
  const pack = decode<{ labels?: unknown; columns?: unknown }>(bytes, KIND);
  const { labels, columns } = pack.meta;
  if (!isStrings(labels) || !Array.isArray(columns)) throw new Error('invalid shard directory');
  const mismatch = (): Error =>
    new Error(`shard for class '${spec.id}' does not hold the columns its spec declares`);
  if (columns.length !== spec.columns.length) throw mismatch();
  const values = spec.columns.map((declared, at): Model.Values['values'][number] => {
    const entry = columns[at] as Partial<ColumnMeta> | null;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      entry.id !== declared.id ||
      entry.kind !== declared.kind ||
      typeof entry.section !== 'string'
    ) {
      throw mismatch();
    }
    switch (declared.kind) {
      case 'number':
        return typed(pack, entry.section, Float64Array);
      case 'flag':
        return typed(pack, entry.section, Uint8Array);
      case 'text': {
        const dictionary = entry.dictionary;
        if (!isStrings(dictionary)) throw new Error(`column '${declared.id}' lacks a dictionary`);
        const indices = typed(pack, entry.section, Uint32Array);
        const texts = new Array<string | null>(indices.length);
        for (let row = 0; row < indices.length; row++) {
          const slot = indices[row]!;
          if (slot > dictionary.length) {
            throw new Error(`column '${declared.id}' index out of range`);
          }
          texts[row] = slot === 0 ? null : dictionary[slot - 1]!;
        }
        return texts;
      }
    }
  });
  return { labels, values };
}
