/**
 * A field: one quantity of a class a host binds, plots, or lists, either a number column or a
 * signal. A resolved field is the `{ series, signal }` every renderer takes, so a column binds the
 * way a signal does: its series is sealed with one frame, which holds at every time.
 */

import { normalizeDomain } from './domain.js';
import type { Model } from './model.js';
import { Gathered, type Series } from './series.js';

/** An element no item holds. */
const NONE = 0xffffffff;

/**
 * The field `ref` names over signal `index` of `series`, for a class of `count` elements, whose
 * frame at a time is `frameAt`'s.
 */
export function fieldOf(
  ref: Model.FieldRef,
  label: string,
  unit: string,
  series: Series,
  index: number,
  count: number,
  frameAt: (time: number) => number,
): Model.Field {
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
    gather(elements) {
      const picks = new Uint32Array(elements.length);
      for (let item = 0; item < elements.length; item++) {
        const element = elements[item]!;
        if (element !== NONE && !(Number.isSafeInteger(element) && element >= 0 && element < count))
          throw new RangeError(`element ${element} is not one of the class's ${count}`);
        picks[item] = element;
      }
      return fieldOf(
        ref,
        label,
        unit,
        new Gathered(series, index, picks),
        0,
        picks.length,
        frameAt,
      );
    },
  };
}

/**
 * Check that `ref` is shaped like a field reference.
 *
 * @throws TypeError when it is not.
 */
export function checkRef(ref: Model.FieldRef): void {
  if (
    !ref ||
    typeof ref !== 'object' ||
    typeof ref.classId !== 'string' ||
    (ref.kind !== 'column' && ref.kind !== 'signal') ||
    typeof ref.id !== 'string'
  )
    throw new TypeError('a field reference needs a classId, a column or signal kind, and an id');
}
