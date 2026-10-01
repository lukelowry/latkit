import { rowAt, rowCount, type RowAxis } from '@latkit/model';
import { isEnvelope, type Chunk } from './history.js';
import type { Reading } from './data.js';
/** Submitted rectangles only; never retain observation columns for inspection. */
export class Coverage {
  private rectangles: { trace: string; rows: RowAxis; first: number; last: number }[] = [];
  add(chunk: Chunk) {
    const d = chunk.data;
    let first: number, last: number;
    if (isEnvelope(d)) {
      first = Infinity;
      last = -Infinity;
      for (const frame of d.columns[chunk.binding.field].frames) {
        first = Math.min(first, frame);
        last = Math.max(last, frame);
      }
    } else {
      first = d.samples!.firstFrame;
      last = first + d.samples!.coordinates.length - 1;
    }
    const rows = d.rows,
      trace = chunk.binding.name;
    const previous = this.rectangles[this.rectangles.length - 1];
    if (
      previous &&
      previous.trace === trace &&
      rows.kind === 'range' &&
      previous.rows.kind === 'range' &&
      rows.offset === previous.rows.offset &&
      rows.count === previous.rows.count &&
      first <= previous.last + 1 &&
      last >= previous.first - 1
    ) {
      previous.first = Math.min(first, previous.first);
      previous.last = Math.max(last, previous.last);
    } else this.rectangles.push({ trace, rows, first, last });
  }
  contains(reading: Reading) {
    return this.rectangles.some((r) => {
      if (r.trace !== reading.trace || reading.frame < r.first || reading.frame > r.last)
        return false;
      if (r.rows.kind === 'range')
        return reading.row >= r.rows.offset && reading.row < r.rows.offset + r.rows.count;
      for (let i = 0; i < rowCount(r.rows); i++) if (rowAt(r.rows, i) === reading.row) return true;
      return false;
    });
  }
  get bytes() {
    return this.rectangles.reduce(
      (n, r) => n + 96 + (r.rows.kind === 'range' ? 0 : rowCount(r.rows) * 8),
      0,
    );
  }
}
