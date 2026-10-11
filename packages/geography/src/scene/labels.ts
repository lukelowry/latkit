import { assertIndex, bitAt, failure, rowAt, rowCount, textAt, type Data } from '@latkit/model';
import { kit, type Gpu, type Labels as LabelOptions, type TextLayout } from '@latkit/gpu';
import type { Shapes } from '../prepare/shapes.js';
import type { Style } from '../options.js';
import { meets, type Region } from './visible.js';

export interface LabelBatch {
  readonly runs: readonly kit.TextRun[];
  readonly anchors: kit.BufferData;
}
/** A record's labels as a frame draws them: its rows, their shapes, and what labels them. */
export interface LabelSource {
  readonly data: Data;
  readonly type: string;
  readonly shapes: Shapes;
  readonly labels: string | LabelOptions;
}
interface Entry {
  readonly labels: string | LabelOptions;
  readonly defaults: readonly unknown[];
  /** Each row's text, laid out once. */
  readonly layouts: Map<number, TextLayout>;
  readonly bank: kit.TextBank;
}
/** A piece this narrow on screen, in CSS pixels, is too small to name. */
const SMALLEST_PX = 28;

/**
 * Labels at each row's anchor: the largest pieces in view first, each placed only where it is
 * clear of those placed before it. Text lays out once per row.
 */
export class Labels {
  private readonly cache = new WeakMap<Shapes, Entry>();

  async prepare(
    frame: kit.Preparation,
    gpu: Gpu,
    sources: readonly LabelSource[],
    projector: kit.Projector,
    region: Region,
    pixels: number,
    style: Style,
  ): Promise<readonly LabelBatch[]> {
    const occupied = new kit.Occupancy(),
      batches: LabelBatch[] = [],
      { viewport } = projector,
      // Each type's texts placed this frame, and where: a feature split across tiles is named once.
      named = new Map<string, Map<string, kit.Projected[]>>();
    for (const source of sources) {
      const options = kit.resolveLabels(source.labels);
      if (!options) continue;
      const defaults = [style.font, style.fontSizePx, style.textColor];
      let entry = this.cache.get(source.shapes);
      if (
        !entry ||
        entry.labels !== source.labels ||
        entry.defaults.some((value, i) => value !== defaults[i])
      ) {
        entry = {
          labels: source.labels,
          defaults,
          layouts: new Map(),
          bank: new kit.TextBank({ label: 'geography labels' }),
        };
        this.cache.set(source.shapes, entry);
      }
      entry.bank.hide();
      // Unset, a text is named once in view.
      const repeat = options.repeatSpacingPx ?? Infinity,
        max = options.maxCount ?? 200,
        candidates = this.candidates(source.shapes, region, pixels, max * 4)
          .map((position) => {
            const x = source.shapes.anchors[position * 2],
              y = source.shapes.anchors[position * 2 + 1];
            return { position, p: Number.isFinite(x) ? projector.project(x, y) : undefined };
          })
          .filter(
            ({ p }) =>
              p?.visible && p.x >= 0 && p.y >= 0 && p.x <= viewport.width && p.y <= viewport.height,
          );
      const table = source.data.tables[source.type],
        missing = candidates.filter((c) => !entry.layouts.has(c.position));
      if (missing.length) {
        if (entry.layouts.size + missing.length > max * 16) {
          entry.layouts.clear();
          entry.bank.clear();
        }
        const wanted = new Map(missing.map((c) => [rowAt(table.rows, c.position), c.position]));
        for await (const block of frame.reader.fields({
          source: source.data,
          from: source.type,
          rows: { kind: 'indices', index: table.index, values: Uint32Array.from(wanted.keys()) },
          fields: { label: options.field },
        })) {
          assertIndex(table.index, block.index);
          const column = block.columns.label;
          if (column && column.kind !== 'text')
            throw failure('invalid-input', 'Labels require text fields');
          for (let i = 0; i < rowCount(block.rows); i++) {
            const position = wanted.get(rowAt(block.rows, i));
            if (position === undefined) continue;
            const text = column && bitAt(block.presence.label, i) ? (textAt(column, i) ?? '') : '';
            entry.layouts.set(
              position,
              await gpu.layoutText(
                {
                  text,
                  font: options.font ?? style.font,
                  size: options.fontSizePx ?? style.fontSizePx,
                  color: options.color ?? style.textColor,
                },
                { signal: frame.signal },
              ),
            );
          }
        }
      }
      let texts = named.get(source.type);
      if (!texts) named.set(source.type, (texts = new Map<string, kit.Projected[]>()));
      let placed = 0;
      for (const { position, p } of candidates) {
        if (placed >= max) break;
        const layout = entry.layouts.get(position);
        if (!layout?.runs.length || !p) continue;
        const text = layout.runs.map((run) => run.text).join('\n'),
          twins = texts.get(text) ?? [];
        if (twins.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < repeat)) continue;
        if (
          entry.bank.place(position, layout, [[p.x, p.y, 'center', 'middle']], occupied, {
            margin: 3,
          })
        ) {
          placed++;
          texts.set(text, [...twins, p]);
        }
      }
      for (const page of entry.bank.flush())
        if (page.runs.length) batches.push({ runs: page.runs, anchors: page.anchors });
    }
    return batches;
  }
  /** Rows of pieces in view large enough to name, largest first: each row once, at most `limit`. */
  private candidates(shapes: Shapes, region: Region, pixels: number, limit: number): number[] {
    const { cells, next, pieces } = shapes.nodes,
      bounds = shapes.pieceBounds,
      found: { position: number; size: number }[] = [],
      seen = new Set<number>(),
      smallest = SMALLEST_PX / pixels;
    let node = 0;
    while (node < next.length) {
      const depth = cells[node * 3],
        w = 360 / 2 ** depth,
        h = 180 / 2 ** depth,
        west = -180 + cells[node * 3 + 1] * w - w / 2,
        south = -90 + cells[node * 3 + 2] * h - h / 2;
      if (!meets(region, west, south, west + 2 * w, south + 2 * h)) {
        node = next[node];
        continue;
      }
      // Cells deeper than this hold pieces too small to name.
      if (Math.max(w, h) < smallest) {
        node = next[node];
        continue;
      }
      for (let k = pieces[node]; k < pieces[node + 1]; k++) {
        const size = Math.max(
            bounds[k * 4 + 2] - bounds[k * 4],
            bounds[k * 4 + 3] - bounds[k * 4 + 1],
          ),
          position = shapes.pieces[k * 3];
        if (size < smallest || seen.has(position)) continue;
        if (!meets(region, bounds[k * 4], bounds[k * 4 + 1], bounds[k * 4 + 2], bounds[k * 4 + 3]))
          continue;
        seen.add(position);
        found.push({ position, size });
      }
      node++;
    }
    found.sort((a, b) => b.size - a.size);
    return found.slice(0, limit).map((f) => f.position);
  }
}
