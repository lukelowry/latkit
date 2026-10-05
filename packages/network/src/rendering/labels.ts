import { failure, textAt, bitAt, assertIndex, rowAt, rowCount, type Data } from '@latkit/model';
import { type Gpu, kit, type TextLayout } from '@latkit/gpu';
import type { NetworkData, NetworkLabels } from '../data.js';
import {
  edgeOptions,
  vertexOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
} from '../geometry/topology.js';
import type { Projector } from '../picking.js';
import type { Camera, Projected } from '../camera.js';
import type { Style } from '../options.js';

export interface LabelBatch {
  readonly runs: readonly kit.TextRun[];
  readonly anchors: kit.BufferData;
}
interface Entry {
  /** The labels option as configured: a field name, or labels. */
  options: string | NetworkLabels;
  /** The style's text defaults the layouts were built with. */
  defaults: readonly unknown[];
  revision: number;
  source: Data;
  /** Each row's text, laid out once. */
  layouts: Map<number, TextLayout>;
  /** The rows' runs, laid into pages once; each frame moves and hides only their anchors. */
  bank: kit.TextBank;
}
/** Room between a marker and its label. */
const GAP = 4;
/** Around a marker of radius `r`, best first: right, left, above, below. */
/** Edges a label's gap reads: enough to see around a vertex, few enough for a hub. */
const GAP_EDGES = 32;
/**
 * Where a vertex's label reads clear of its edges: in the widest gap between them on screen, its
 * text leaning away from the vertex; undefined without edges.
 */
function gapSpot(p: Projected, r: number, angles: number[]): kit.TextCandidate | undefined {
  if (!angles.length) return undefined;
  angles.sort((a, b) => a - b);
  let widest = -1,
    middle = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI,
      gap = next - angles[i];
    if (gap > widest) {
      widest = gap;
      middle = angles[i] + gap / 2;
    }
  }
  const cos = Math.cos(middle),
    sin = Math.sin(middle);
  return [
    p.x + (r + GAP) * cos,
    p.y + (r + GAP) * sin,
    cos > 0.38 ? 'start' : cos < -0.38 ? 'end' : 'center',
    sin > 0.38 ? 'top' : sin < -0.38 ? 'bottom' : 'middle',
  ];
}
function around(p: Projected, r: number): kit.TextCandidate[] {
  return [
    [p.x + r + GAP, p.y, 'start', 'middle'],
    [p.x - r - GAP, p.y, 'end', 'middle'],
    [p.x, p.y - r - GAP, 'center', 'bottom'],
    [p.x, p.y + r + GAP, 'center', 'top'],
  ];
}
interface Candidate {
  readonly row: number;
  readonly p: Projected;
  /** A marker's radius; zero for a line's label, which centers on its anchor. */
  readonly r: number;
  /** A vertex's dense address, whose edges its label keeps clear of. */
  readonly dense?: number;
}
export class Labels {
  private cache = new WeakMap<object, Entry>();
  private revisions = new WeakMap<Data, number>();

  async prepare(
    frame: kit.Preparation,
    gpu: Gpu,
    geometry: Geometry,
    picking: Projector,
    data: NetworkData,
    camera: Camera,
    height: number,
    style: Style,
  ): Promise<readonly LabelBatch[]> {
    const batches: LabelBatch[] = [],
      occupied = new kit.Occupancy(),
      counts = new Map<string, number>(),
      totals = new Map<string, number>();
    const banks: (VertexBank | EdgeBank)[] = [
      ...geometry.vertices.filter((bank) => !bank.synthetic),
      ...geometry.edges,
    ];
    const kind = (bank: VertexBank | EdgeBank) =>
      'batches' in bank ? (bank.kind ?? 'edge') : 'vertex';
    const native = geometry.native ?? geometry,
      graph = native.adjacency.graph;
    /** The screen angles of the edges at a vertex, toward their other ends. */
    const angles = (dense: number, p: Projected): number[] => {
      const out: number[] = [];
      for (const e of graph.edgesOf(dense).subarray(0, GAP_EDGES))
        for (const other of graph.endsOf(e)) {
          if (other === dense) continue;
          const bank = bankOf(native.vertices, other),
            q = picking.projected(
              bank,
              other - bank.base,
              camera,
              frame.viewport,
              height,
              undefined,
              false,
            );
          if (Number.isFinite(q.x) && Number.isFinite(q.y) && (q.x !== p.x || q.y !== p.y))
            out.push(Math.atan2(q.y - p.y, q.x - p.x));
        }
      return out;
    };
    for (const bank of banks) {
      const key = kind(bank) + ':' + bank.type;
      totals.set(key, (totals.get(key) ?? 0) + bank.count);
    }
    // Candidates and their text first: markers claim their room before any label is placed.
    const pending: {
      key: string;
      entry: Entry;
      candidates: Candidate[];
      max: number;
      repeat: number;
    }[] = [];
    for (const bank of banks) {
      const edge = 'batches' in bank,
        type = kind(bank),
        key = type + ':' + bank.type;
      const configured = (edge ? edgeOptions(data, bank) : vertexOptions(data, bank)).labels,
        options = kit.resolveLabels(configured);
      if (!configured || !options || (!edge && !style.markers) || (edge && !style.lines)) continue;
      // Checked when set: see `checkLabels`.
      const max = options.maxCount ?? 200,
        size = options.fontSizePx ?? style.fontSizePx,
        repeat = options.repeatSpacingPx ?? 0;
      const count = Math.min(
        bank.count,
        Math.ceil((Math.min(8192, max * 8) * bank.count) / totals.get(key)!),
      );
      if (!count) continue;
      const source = edge ? (bank.source ?? data.source) : data.source,
        revision = this.revisions.get(source) ?? 0;
      let entry = this.cache.get(bank.rows);
      const defaults = [style.font, style.fontSizePx, style.textColor];
      if (
        !entry ||
        entry.options !== configured ||
        entry.source !== source ||
        entry.revision !== revision ||
        entry.defaults.some((value, i) => value !== defaults[i])
      ) {
        entry = {
          options: configured,
          defaults,
          source,
          revision,
          layouts: new Map(),
          bank: new kit.TextBank({ label: 'network labels' }),
        };
        this.cache.set(bank.rows, entry);
      }
      entry.bank.hide();
      const candidates: Candidate[] = [];
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
          : picking.projected(bank, offset, camera, frame.viewport, height, style.vertexRadiusPx);
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
          p,
          r: edge ? 0 : 'radius' in p ? (p.radius as number) : style.vertexRadiusPx,
          ...(edge ? {} : { dense: (bank as VertexBank).base + offset }),
        });
      }
      const missing = candidates.filter((c) => !entry.layouts.has(c.row));
      if (missing.length) {
        // Bound retained strings and runs as the view moves; the shared atlas owns glyphs.
        if (entry.layouts.size + missing.length > count * 4) {
          entry.layouts.clear();
          entry.bank.clear();
          missing.splice(0, missing.length, ...candidates);
        }
        const wanted = new Set(missing.map((c) => c.row));
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
          if (column?.kind !== 'text') throw failure('invalid-input', 'Labels require text fields');
          for (let i = 0; i < rowCount(block.rows); i++) {
            const row = rowAt(block.rows, i);
            if (!wanted.has(row)) throw failure('invalid-input', 'Unexpected label row');
            const text = bitAt(block.presence.label, i) ? (textAt(column, i) ?? '') : '';
            entry.layouts.set(
              row,
              await gpu.layoutText(
                {
                  text,
                  font: options.font ?? style.font,
                  size,
                  color: options.color ?? style.textColor,
                },
                { signal: frame.signal },
              ),
            );
          }
        }
      }
      pending.push({ key, entry, candidates, max, repeat });
    }
    // A marker claims its room, so no label covers a vertex it does not name.
    for (const { candidates } of pending)
      for (const { p, r } of candidates)
        if (r > 0) occupied.add([p.x - r, p.y - r, p.x + r, p.y + r]);
    for (const { key, entry, candidates, max, repeat } of pending) {
      const named = new Map<string, Projected[]>();
      for (const { row, p, r, dense } of candidates) {
        if ((counts.get(key) ?? 0) >= max) break;
        const layout = entry.layouts.get(row);
        if (!layout?.runs.length) continue;
        const text = layout.runs[0].text,
          twins = repeat > 0 ? (named.get(text) ?? []) : undefined;
        if (twins?.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < repeat)) continue;
        // A vertex's label sits in the widest gap between its edges, else on a side of it.
        const gap = dense === undefined ? undefined : gapSpot(p, r, angles(dense, p)),
          spots: readonly kit.TextCandidate[] =
            r > 0 ? [...(gap ? [gap] : []), ...around(p, r)] : [[p.x, p.y, 'center', 'middle']];
        const depth = Math.max(0, p.depth - 0.000001);
        if (!entry.bank.place(row, layout, spots, occupied, { margin: 2, depth })) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (twins) named.set(text, [...twins, p]);
      }
      for (const page of entry.bank.flush())
        if (page.runs.length) batches.push({ runs: page.runs, anchors: page.anchors });
    }
    return batches;
  }
}

/** The bank holding a dense vertex address. */
function bankOf(banks: readonly VertexBank[], dense: number): VertexBank {
  let lo = 0,
    hi = banks.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (banks[m].base <= dense) lo = m + 1;
    else hi = m;
  }
  return banks[lo - 1];
}
