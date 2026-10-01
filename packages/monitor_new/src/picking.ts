import { GpuError, type Gpu } from '@latkit/gpu';
import { bitAt, rowCount, rowAt, sampleAt, type Domain, type SampleColumn } from '@latkit/model';
import type { Binding } from './bindings.js';
import type { MonitorData, Reading } from './data.js';
import type { Plot } from './axes.js';
import { finite } from './config.js';
import { yieldWork } from './async.js';
export class HoverBudget extends Error {
  constructor() {
    super('Automatic hover exceeded its CPU budget');
  }
}
export interface PickRequest {
  gpu: Gpu;
  data: MonitorData;
  bindings: readonly Binding[];
  plot: Plot;
  x: Domain;
  y: Domain;
  point: readonly [number, number];
  radius: number;
  limit: number;
  maxBytes: number;
  signal: AbortSignal;
  budget?: number;
}
/** Refine only the pointer's coordinate interval; preserve native identities and Float64 values. */
export async function pick(request: PickRequest): Promise<Reading[]> {
  const { gpu, data, bindings, plot, x, y, point, radius, limit, maxBytes, signal, budget } =
    request;
  finite(radius, 'pick radius', 0, 1024);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new GpuError('invalid-input', 'Pick limit must be a positive integer');
  if (limit * 192 > maxBytes)
    throw new GpuError('resource-limit', 'Pick result exceeds pickingBytes');
  const coordinate = x[0] + ((point[0] - plot.x) / plot.width) * (x[1] - x[0]),
    delta = (radius / plot.width) * (x[1] - x[0]);
  const between: Domain = [Math.max(x[0], coordinate - delta), Math.min(x[1], coordinate + delta)];
  const result: { reading: Reading; distance: number }[] = [];
  let used = 0;
  for (const item of bindings) {
    for await (const tile of gpu.fields(
      {
        source: data.source,
        from: item.trace.from,
        rows: item.rows,
        fields: {
          value: item.fields.value,
          ...(item.fields.visible ? { visible: item.fields.visible } : {}),
        },
        window: { kind: 'range', between },
      },
      { signal },
    )) {
      const version = tile.versions.get(item.source);
      if (version === undefined)
        throw new GpuError('conflict', 'Missing authoritative trace version');
      const samples = tile.samples!,
        column = tile.columns.value as SampleColumn;
      let began = performance.now(),
        checked = 0;
      for (let f = 0; f < samples.coordinates.length; f++)
        for (let r = 0; r < rowCount(tile.rows); r++) {
          if ((checked++ & 1023) === 0) {
            signal.throwIfAborted();
            const elapsed = performance.now() - began;
            if (used + elapsed > (budget ?? Infinity)) throw new HoverBudget();
            if (elapsed > 3) {
              used += elapsed;
              await yieldWork(signal);
              began = performance.now();
            }
          }
          if (!bitAt(tile.presence.value, r)) continue;
          const value = sampleAt(column, { row: r, frame: f });
          if (value === null || !Number.isFinite(value)) continue;
          const visible = tile.columns.visible;
          if (visible && bitAt(tile.presence.visible, r)) {
            const c = visible as typeof visible & { rowStride?: number; frameStride?: number },
              at = c.offset + r * (c.rowStride ?? 1) + f * (c.frameStride ?? 0);
            if (
              !bitAt(c.validity, at) ||
              (c.kind === 'boolean'
                ? !bitAt(c.values, at)
                : c.kind === 'numeric' && (!Number.isFinite(c.values[at]) || c.values[at] === 0))
            )
              continue;
          }
          const px = plot.x + ((samples.coordinates[f] - x[0]) / (x[1] - x[0])) * plot.width,
            py = plot.y + ((y[1] - value) / (y[1] - y[0])) * plot.height,
            distance = (px - point[0]) ** 2 + (py - point[1]) ** 2;
          if (
            distance > radius * radius ||
            (result.length === limit && distance >= result[result.length - 1].distance)
          )
            continue;
          const reading: Reading = {
            source: item.source,
            version,
            index: tile.index,
            row: rowAt(tile.rows, r),
            field: item.field,
            trace: item.name,
            frame: samples.firstFrame + f,
            coordinate: samples.coordinates[f],
            value,
            point: [px, py],
          };
          let at = result.findIndex((v) => distance < v.distance);
          if (at < 0) at = result.length;
          result.splice(at, 0, { reading, distance });
          if (result.length > limit) result.pop();
        }
      used += performance.now() - began;
      if (used > (budget ?? Infinity)) throw new HoverBudget();
    }
  }
  return result.map((item) => item.reading);
}
