/**
 * A field: one quantity of a class a host can bind, plot, or list, either a numeric column or a
 * recorded signal. Fields are how a host names what it shows without knowing where the values
 * come from.
 */

import type { ClassData, ClassSpec } from './model.js';
import type { Series } from './series.js';

/** Stable identity of a field within a class. */
export interface FieldRef {
  readonly classId: string;
  readonly source: 'column' | 'signal';
  readonly id: string;
}

/** A field as a picker shows it: its identity plus label and unit. */
export interface Field extends FieldRef {
  readonly label: string;
  readonly unit: string;
}

/** A stable map key for a field reference. */
export function fieldKey(ref: FieldRef): string {
  return `${ref.classId}\0${ref.source}\0${ref.id}`;
}

/**
 * Every field of a class: its number columns, then its recorded signals.
 *
 * @remarks
 * Signals are listed only when `results` is absent or carries every recorded signal, so a results
 * set from a different recording never offers a signal it cannot supply.
 */
export function fieldsOf(
  spec: ClassSpec,
  data: ClassData | null,
  results?: Series | null,
): readonly Field[] {
  const fields: Field[] = [];
  for (const column of data?.columns ?? []) {
    if (column.kind === 'number') {
      fields.push({
        classId: spec.id,
        source: 'column',
        id: column.id,
        label: column.label,
        unit: column.unit ?? '',
      });
    }
  }
  const recorded = spec.signals.filter((signal) => signal.recorded);
  if (results === null || results === undefined || results.signalCount === recorded.length) {
    for (const signal of recorded) {
      fields.push({
        classId: spec.id,
        source: 'signal',
        id: signal.id,
        label: signal.label,
        unit: signal.unit,
      });
    }
  }
  return fields;
}
