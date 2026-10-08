import { kit, type Point } from '@latkit/gpu';
import {
  Work,
  bitAt,
  rowCount,
  rowAt,
  sampleAt,
  type Data,
  type Domain,
  type ReadScope,
  type SampleColumn,
} from '@latkit/model';
import type { Binding } from './bindings.js';
import type { Reading, Trace } from './data.js';
import { plotCoordinate, plotX, plotY, type Plot } from './axes.js';

/** What a presented frame drew: what pick, locate, and coordinateAt read. */
export interface Shown {
  readonly source: Data;
  readonly traces: readonly Binding[];
  readonly window: Domain;
  readonly values: Domain;
  readonly plot: Plot;
  /** The width of traces whose `widthPx` is unset. */
  readonly widthPx: number;
}
/** A sample where its line draws it, in canvas pixels. */
interface Drawn {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly valid: boolean;
  readonly frame: number;
  readonly coordinate: number;
  readonly value: number;
}
interface Found {
  /** Squared, in pixels. */
  readonly distance: number;
  /** Draw order: a later trace, then a later row, draws on top. */
  readonly order: number;
  readonly row: number;
  readonly reading: Reading;
}
/** The widest a width field draws without a scale, as `traceWidthPx` allows. */
const WIDEST_PX = 64;
type Interpolation = NonNullable<Trace['interpolation']>;

/**
 * The traces drawn near a point, nearest first: each row's line is hit as `traces.wgsl` strokes it,
 * its steps, width, lone samples, and the plot's edges included, and reads the recorded sample whose
 * value the part it hits shows. One reading for each trace row.
 */
export async function pick(
  reads: ReadScope,
  shown: Shown,
  point: Point,
  radius: number,
  limit: number,
): Promise<Reading[]> {
  const { plot, window: x, values: y } = shown;
  if (!(plot.width > 0) || !(plot.height > 0) || limit < 1) return [];
  const widths = shown.traces.map((trace) =>
    kit.resolveChannel(trace.bound.channels.widthPx, trace.channels.widthPx.scale, shown.widthPx),
  );
  // A line reaches the pointer from half its width away, between samples outside the window.
  const reach = radius + Math.max(0, ...widths.map(widest)) / 2,
    at = plotCoordinate(plot, x, point[0]),
    span = (reach / plot.width) * (x[1] - x[0]),
    between: Domain = [Math.max(x[0], at - span), Math.min(x[1], at + span)],
    work = new Work(reads.signal, Infinity, 3),
    found = new Map<number, Found>();
  let steps = 0;
  for (const [order, trace] of shown.traces.entries()) {
    const { y: plotted, visible } = trace.channels,
      width = widths[order],
      step: Interpolation = trace.trace.interpolation ?? 'linear',
      fields = { [plotted.column!]: trace.fields[plotted.column!] };
    for (const channel of [visible, width])
      if (channel.column !== undefined) fields[channel.column] = trace.fields[channel.column];
    const last = new Map<number, Drawn>();
    for await (const tile of reads.fields({
      source: shown.source,
      from: trace.trace.from,
      rows: trace.rows,
      fields,
      window: { kind: 'range', between, context: { before: 1, after: 1 } },
    })) {
      const samples = tile.samples!,
        column = tile.columns[plotted.column!] as SampleColumn,
        present = tile.presence[plotted.column!];
      for (let r = 0; r < rowCount(tile.rows); r++) {
        const row = rowAt(tile.rows, r),
          key = order * 2 ** 32 + row;
        /** Keep this leg's hit when it is the row's nearest yet. */
        const test = (from: Drawn, to: Drawn, sample: Drawn) => {
          if (!from.valid || !to.valid) return;
          const half = Math.max(from.width, to.width) / 2,
            distance = clipped(point, from, to, plot, half + 1);
          if (distance > (radius + half) ** 2 || (found.get(key)?.distance ?? Infinity) <= distance)
            return;
          found.set(key, {
            distance,
            order,
            row,
            reading: {
              source: trace.source,
              index: tile.index,
              row,
              field: trace.field,
              trace: trace.name,
              frame: sample.frame,
              coordinate: sample.coordinate,
              value: sample.value,
              point: [sample.x, sample.y],
            },
          });
        };
        let a = last.get(row);
        for (let f = 0; f < samples.coordinates.length; f++) {
          if ((steps++ & 1023) === 0) await work.step();
          const value = sampleAt(column, r, f) ?? NaN,
            coordinate = samples.coordinates[f];
          const b: Drawn = {
            x: plotX(plot, x, coordinate),
            y: plotY(plot, y, value),
            width: kit.channelValue(width, tile, r, f),
            valid:
              bitAt(present, r) && Number.isFinite(value) && kit.channelOn(visible, tile, r, f),
            frame: samples.firstFrame + f,
            coordinate,
            value,
          };
          // Each sample draws at least the dot a lone one does; after another, the legs between.
          test(b, b, b);
          if (a?.frame === b.frame - 1) {
            const nearer = near(point, a) <= near(point, b) ? a : b;
            if (step === 'linear') test(a, b, nearer);
            else if (step === 'step-after') {
              // The earlier value holds until the later sample's coordinate, then steps to it.
              const corner = { ...a, x: b.x };
              test(a, corner, a);
              test(corner, b, nearer);
            } else {
              // The value steps at the earlier coordinate, and the later value holds.
              const corner = { ...a, y: b.y, width: b.width };
              test(a, corner, nearer);
              test(corner, b, b);
            }
          }
          a = b;
        }
        if (a) last.set(row, a);
      }
    }
  }
  // Nearest first; a later trace, then a later row, draws on top.
  return [...found.values()]
    .sort((p, q) => p.distance - q.distance || q.order - p.order || q.row - p.row)
    .slice(0, limit)
    .map((hit) => hit.reading);
}
/** The widest a width channel draws: its scale's top, or its constant. */
function widest(width: kit.ResolvedChannel): number {
  if (width.column === undefined) return width.fallback;
  return width.scale ? Math.max(...width.scale.range, width.fallback) : WIDEST_PX;
}
/** The squared distance from `point` to a sample, in pixels. */
function near(point: Point, sample: Drawn): number {
  return (point[0] - sample.x) ** 2 + (point[1] - sample.y) ** 2;
}
/**
 * The squared distance from `point` to the part of a leg that draws on the plot, grown by `margin`
 * on each side; Infinity when none of it does or it does not draw at all.
 */
function clipped(point: Point, from: Drawn, to: Drawn, plot: Plot, margin: number): number {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  if (![from.x, from.y, dx, dy].every(Number.isFinite)) return Infinity;
  let first = 0,
    last = 1;
  // Liang–Barsky against each side of the grown plot.
  const side = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) first = Math.max(first, t);
    else last = Math.min(last, t);
    return first <= last;
  };
  if (
    !side(-dx, from.x - plot.x + margin) ||
    !side(dx, plot.x + plot.width + margin - from.x) ||
    !side(-dy, from.y - plot.y + margin) ||
    !side(dy, plot.y + plot.height + margin - from.y)
  )
    return Infinity;
  const length = dx * dx + dy * dy,
    t = length
      ? Math.max(
          first,
          Math.min(last, ((point[0] - from.x) * dx + (point[1] - from.y) * dy) / length),
        )
      : first;
  return (point[0] - from.x - t * dx) ** 2 + (point[1] - from.y - t * dy) ** 2;
}
