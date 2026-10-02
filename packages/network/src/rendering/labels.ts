import { textAt, bitAt } from '@latkit/model';
import { assertIndex, rowAt, rowCount } from '@latkit/model';
import { GpuError, type Gpu, kit } from '@latkit/gpu';
import type { Data } from '@latkit/model';
import type { NetworkData, Labels as LabelOptions } from '../data.js';
import {
  edgeOptions,
  vertexOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
} from '../geometry/topology.js';
import type { PickGeometry } from '../picking.js';
import type { Camera, Projected } from '../camera.js';
import type { Style } from '../options.js';

export interface LabelBatch {
  readonly runs: readonly kit.TextRun[];
  readonly anchors: kit.BufferData;
}
interface Entry {
  options: LabelOptions;
  revision: number;
  source: Data;
  text: Map<number, { run: kit.TextRun; metrics: kit.TextMetrics }>;
  runs: readonly kit.TextRun[];
  anchors: kit.BufferData;
}
/** Shared collision grid for vertex, edge, and path labels. */
class Occupancy {
  private cells = new Map<string, (readonly number[])[]>();
  place(box: readonly number[]): boolean {
    const keys: string[] = [];
    for (let y = Math.floor(box[1] / 64); y <= Math.floor(box[3] / 64); y++)
      for (let x = Math.floor(box[0] / 64); x <= Math.floor(box[2] / 64); x++) {
        const key = x + ':' + y;
        keys.push(key);
        if (
          this.cells
            .get(key)
            ?.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])
        )
          return false;
      }
    for (const key of keys) {
      const cell = this.cells.get(key) ?? [];
      cell.push(box);
      this.cells.set(key, cell);
    }
    return true;
  }
}
export class Labels {
  private cache = new WeakMap<object, Entry>();
  private revisions = new WeakMap<Data, number>();

  async prepare(
    frame: kit.Preparation,
    gpu: Gpu,
    geometry: Geometry,
    picking: PickGeometry,
    data: NetworkData,
    camera: Camera,
    height: number,
    style: Style,
  ): Promise<readonly LabelBatch[]> {
    const batches: LabelBatch[] = [],
      occupied = new Occupancy(),
      counts = new Map<string, number>(),
      totals = new Map<string, number>();
    const banks: (VertexBank | EdgeBank)[] = [
      ...geometry.vertices.filter((bank) => !bank.synthetic),
      ...geometry.edges,
    ];
    const kind = (bank: VertexBank | EdgeBank) =>
      'batches' in bank ? (bank.kind ?? 'edge') : 'vertex';
    for (const bank of banks) {
      const key = kind(bank) + ':' + bank.type;
      totals.set(key, (totals.get(key) ?? 0) + bank.count);
    }
    for (const bank of banks) {
      const edge = 'batches' in bank,
        type = kind(bank),
        key = type + ':' + bank.type;
      const config = edge ? edgeOptions(data, bank) : vertexOptions(data, bank),
        options = config.labels;
      if (!options || (!edge && !style.showVertices) || (edge && !style.showEdges)) continue;
      const max = options.maxCount ?? 200,
        size = options.size ?? 12;
      if (!Number.isSafeInteger(max) || max < 0 || !Number.isFinite(size) || size <= 0)
        throw new GpuError('invalid-input', 'Invalid label options');
      const count = Math.min(
        bank.count,
        Math.ceil((Math.min(8192, max * 8) * bank.count) / totals.get(key)!),
      );
      if (!count) continue;
      const source = edge ? (bank.source ?? data.source) : data.source,
        revision = this.revisions.get(source) ?? 0;
      let entry = this.cache.get(bank.rows);
      if (
        !entry ||
        entry.options !== options ||
        entry.source !== source ||
        entry.revision !== revision
      ) {
        entry = {
          options,
          source,
          revision,
          text: new Map(),
          runs: [],
          anchors: new kit.BufferData({ size: 16, label: 'network label anchors' }),
        };
        this.cache.set(bank.rows, entry);
      }
      const candidates: { row: number; offset: number; p: Projected; dx: number }[] = [];
      // Geometry determines candidates before text is queried; offscreen labels cost no text IO.
      for (let i = 0; i < count; i++) {
        const offset = Math.floor((i * bank.count) / count),
          row = rowAt(bank.rows, offset);
        const p = edge
          ? picking.edgeAnchor(
              { kind: type as 'edge' | 'path', source, index: bank.index, row },
              data,
              camera,
              frame.viewport,
              height,
            )
          : picking.projected(bank, offset, camera, frame.viewport, height, config);
        if (
          !p?.visible ||
          p.x < 0 ||
          p.y < 0 ||
          p.x > frame.viewport.width ||
          p.y > frame.viewport.height
        )
          continue;
        candidates.push({
          row,
          offset,
          p,
          dx: edge ? 0 : ('radius' in p ? (p.radius as number) : 1) * style.vertexRadiusPx + 4,
        });
      }
      const missing = candidates.filter((c) => !entry!.text.has(c.row));
      if (missing.length) {
        // Bound retained strings/runs as the view moves; the shared atlas owns glyph resources.
        if (entry.text.size + missing.length > count * 4) {
          entry.text.clear();
          missing.splice(0, missing.length, ...candidates);
        }
        const lookup = new Map(candidates.map((c) => [c.row, c]));
        for await (const block of frame.reader.fields({
          source,
          from: bank.type,
          rows: {
            kind: 'indices',
            index: bank.index,
            values: Uint32Array.from(missing, (c) => c.row),
          },
          fields: { label: options.field },
        })) {
          assertIndex(bank.index, block.index);
          const column = block.columns.label;
          if (column?.kind !== 'text')
            throw new GpuError('invalid-input', 'Labels require text fields');
          for (let i = 0; i < rowCount(block.rows); i++) {
            const row = rowAt(block.rows, i);
            if (!lookup.has(row)) throw new GpuError('invalid-input', 'Unexpected label row');
            const text = bitAt(block.presence.label, i) ? (textAt(column, i) ?? '') : '';
            const run: kit.TextRun = {
              text,
              font: options.font,
              size,
              color: options.color ?? [0.85, 0.91, 0.97, 1],
              position: [0, 4],
              anchor: entry.text.size,
            };
            entry.text.set(row, {
              run,
              metrics: await gpu.measureText(run, { signal: frame.signal }),
            });
          }
        }
        entry.runs = [...entry.text.values()].map((v) => v.run);
        entry.anchors.resize(Math.max(16, entry.runs.length * 16));
      }
      const anchors = new Float32Array(Math.max(4, entry.runs.length * 4));
      for (const candidate of candidates) {
        if ((counts.get(key) ?? 0) >= max) break;
        const text = entry.text.get(candidate.row);
        if (!text?.run.text) continue;
        const { metrics, run } = text,
          { p } = candidate;
        const x = p.x + candidate.dx,
          box = [
            x - 2,
            p.y + 2 - metrics.ascent * size,
            x + metrics.advance * size + 2,
            p.y + 6 + metrics.descent * size,
          ];
        if (
          !box.every(Number.isFinite) ||
          box[0] < 0 ||
          box[1] < 0 ||
          box[2] > frame.viewport.width ||
          box[3] > frame.viewport.height ||
          !occupied.place(box)
        )
          continue;
        anchors.set([x, p.y, Math.max(0, p.depth - 0.000001), 1], run.anchor! * 4);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      entry.anchors.write({ data: anchors });
      if (entry.runs.length) batches.push({ runs: entry.runs, anchors: entry.anchors });
    }
    return batches;
  }
}
