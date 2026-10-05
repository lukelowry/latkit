import type { Point } from '@latkit/gpu';
import {
  Work,
  bitAt,
  rowCount,
  rowAt,
  sampleAt,
  type Domain,
  type ReadScope,
  type SampleColumn,
} from '@latkit/model';
import type { Binding } from './bindings.js';
import type { MonitorData, Reading } from './data.js';
import { plotCoordinate, plotX, plotY, type Plot } from './axes.js';

export interface PickRequest {
  readonly reads: ReadScope;
  readonly data: MonitorData;
  readonly bindings: readonly Binding[];
  readonly plot: Plot;
  readonly x: Domain;
  readonly y: Domain;
  readonly point: Point;
  readonly radius: number;
  /** The nearest this many readings are kept. */
  readonly limit: number;
}
interface Candidate {
  readonly distance: number;
  /** Scan order, which is draw order: later is on top. */
  readonly order: number;
  readonly reading: Reading;
}
/** Whether `a` ranks below `b`: farther, or as near and drawn earlier. */
function below(a: Candidate, b: Candidate): boolean {
  return a.distance > b.distance || (a.distance === b.distance && a.order < b.order);
}
/** The best `limit` candidates in a heap whose root is the worst kept. */
class Nearest {
  readonly heap: Candidate[] = [];
  constructor(private readonly limit: number) {}
  admits(distance: number, order: number): boolean {
    const worst = this.heap[0];
    return (
      this.heap.length < this.limit ||
      distance < worst.distance ||
      (distance === worst.distance && order > worst.order)
    );
  }
  add(candidate: Candidate): void {
    const heap = this.heap;
    let i: number;
    if (heap.length < this.limit) {
      i = heap.push(candidate) - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!below(heap[i], heap[parent])) break;
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      }
      return;
    }
    heap[0] = candidate;
    i = 0;
    for (;;) {
      const left = i * 2 + 1,
        right = left + 1;
      let worst = i;
      if (left < heap.length && below(heap[left], heap[worst])) worst = left;
      if (right < heap.length && below(heap[right], heap[worst])) worst = right;
      if (worst === i) break;
      [heap[i], heap[worst]] = [heap[worst], heap[i]];
      i = worst;
    }
  }
  /** Nearest first, topmost breaking ties. */
  sorted(): Reading[] {
    return [...this.heap]
      .sort((a, b) => a.distance - b.distance || b.order - a.order)
      .map((candidate) => candidate.reading);
  }
}
/** Read only the pointer's coordinate interval; readings keep native identities and Float64 values. */
export async function pick(request: PickRequest): Promise<Reading[]> {
  const { reads, data, bindings, plot, x, y, point, radius, limit } = request;
  const work = new Work(reads.signal, Infinity, 3);
  const coordinate = plotCoordinate(plot, x, point[0]),
    delta = (radius / plot.width) * (x[1] - x[0]);
  const between: Domain = [Math.max(x[0], coordinate - delta), Math.min(x[1], coordinate + delta)];
  const nearest = new Nearest(limit);
  let order = 0;
  for (const item of bindings) {
    for await (const tile of reads.fields({
      source: data.source,
      from: item.trace.from,
      rows: item.rows,
      fields: {
        value: item.fields.value,
        ...(item.fields.visible ? { visible: item.fields.visible } : {}),
      },
      window: { kind: 'range', between },
    })) {
      const samples = tile.samples!,
        column = tile.columns.value as SampleColumn,
        visible = tile.columns.visible,
        frames = samples.coordinates.length;
      // Rows draw in order, each from its first frame to its last.
      for (let r = 0; r < rowCount(tile.rows); r++)
        for (let f = 0; f < frames; f++, order++) {
          if ((order & 1023) === 0) await work.step();
          if (!bitAt(tile.presence.value, r)) continue;
          const value = sampleAt(column, r, f);
          if (value === null || !Number.isFinite(value)) continue;
          if (visible && bitAt(tile.presence.visible, r)) {
            const c = visible as typeof visible & { rowStride?: number; frameStride?: number },
              at = c.offset + r * (c.rowStride ?? 1) + f * (c.frameStride ?? 0);
            // As drawn: a sample without a visibility value shows.
            if (
              bitAt(c.validity, at) &&
              (c.kind === 'boolean'
                ? !bitAt(c.values, at)
                : c.kind === 'numeric' && c.values[at] === 0)
            )
              continue;
          }
          const px = plotX(plot, x, samples.coordinates[f]),
            py = plotY(plot, y, value),
            distance = (px - point[0]) ** 2 + (py - point[1]) ** 2;
          if (distance > radius * radius || !nearest.admits(distance, order)) continue;
          const reading: Reading = {
            source: item.source,
            index: tile.index,
            row: rowAt(tile.rows, r),
            field: item.field,
            trace: item.name,
            frame: samples.firstFrame + f,
            coordinate: samples.coordinates[f],
            value,
            point: [px, py],
          };
          nearest.add({ distance, order, reading });
        }
    }
  }
  return nearest.sorted();
}
