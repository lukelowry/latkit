/**
 * A field: one quantity of a class a host binds, plots, or lists, either a number column or a
 * signal. A resolved field is the `{ series, signal }` every renderer takes, so a column binds the
 * way a signal does: its series is sealed with one frame, which holds at every time.
 */

import { normalizeDomain, type Domain } from './domain.js';
import type { Series } from './series.js';

/** Which quantity of a class: a number column or a signal. Plain data a host persists. */
export interface FieldRef {
  readonly classId: string;
  readonly kind: 'column' | 'signal';
  readonly id: string;
}

/**
 * A field resolved against a model and, for a signal, a recording: the `{ series, signal }` every
 * renderer binds.
 */
export interface Field {
  readonly ref: FieldRef;
  readonly label: string;
  readonly unit: string;
  /** A signal's series in the recording; a column's is sealed with one frame. */
  readonly series: Series;
  /** The field's index in `series.signals`. */
  readonly signal: number;
  /** `normalizeDomain` over every committed value; it grows while the recording is live. */
  readonly domain: Domain;
  /**
   * Every element's value at `time`: the latest frame at or before it, the first before the
   * recording starts, NaN where an element has no value. The array is borrowed; never mutate it.
   *
   * @throws RangeError when `time` is not finite.
   */
  at(time: number, signal?: AbortSignal): Promise<Float32Array | Float64Array>;
}

/**
 * The field `ref` names over signal `index` of `series`, for a class of `count` elements, whose
 * frame at a time is `frameAt`'s.
 */
export function fieldOf(
  ref: FieldRef,
  label: string,
  unit: string,
  series: Series,
  index: number,
  count: number,
  frameAt: (time: number) => number,
): Field {
  return {
    ref: Object.freeze({ classId: ref.classId, kind: ref.kind, id: ref.id }),
    label,
    unit,
    series,
    signal: index,
    get domain() {
      const ranges = series.state.ranges;
      const at = index * 2;
      return normalizeDomain(
        ranges && !Number.isNaN(ranges[at]) ? [ranges[at]!, ranges[at + 1]!] : null,
      );
    },
    async at(time, signal) {
      signal?.throwIfAborted();
      const frame = frameAt(time);
      if (frame < 0) return new Float64Array(count).fill(NaN);
      const block = await series.read(
        index,
        { frameOffset: frame, frameCount: 1, elementOffset: 0, elementCount: series.elementCount },
        signal,
      );
      const values = block.values.subarray(0, series.elementCount);
      const elements = series.elements;
      if (!elements) return values;
      const dense = (
        values instanceof Float32Array ? new Float32Array(count) : new Float64Array(count)
      ).fill(NaN);
      elements.forEach((element, at) => (dense[element] = values[at]!));
      return dense;
    },
  };
}

/**
 * Check that `ref` is shaped like a field reference.
 *
 * @throws TypeError when it is not.
 */
export function checkRef(ref: FieldRef): void {
  if (
    !ref ||
    typeof ref !== 'object' ||
    typeof ref.classId !== 'string' ||
    (ref.kind !== 'column' && ref.kind !== 'signal') ||
    typeof ref.id !== 'string'
  )
    throw new TypeError('a field reference needs a classId, a column or signal kind, and an id');
}
