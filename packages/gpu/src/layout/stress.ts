import type { Work } from '@latkit/model';
import type { LayoutOptions, LayoutPart, LayoutStrategy } from './place.js';

/** Pivots a part keeps its distances to: enough for its shape, few enough to stay linear. */
const PIVOTS = 16;
/** Relaxation sweeps after the first placement. */
const SWEEPS = 8;
/** Ends a net joins all to each other; a larger one joins each to its first end. */
const CLIQUE = 16;
const FAR = 0xffff;

/**
 * Keep graph distances: a part takes its shape from its hop distances to a few pivots, then relaxes
 * toward edges `vertexGap` long with pinned vertices fixed. Deterministic, and linear in the part:
 * about pivots × (vertices + edges) for the distances, and pivots² × vertices for the shape.
 */
export function stress(layout: Required<LayoutOptions>, work: Work): LayoutStrategy {
  return { arrange: (part) => relaxed(part, layout, work) };
}
async function relaxed(
  part: LayoutPart,
  layout: Required<LayoutOptions>,
  work: Work,
): Promise<Float64Array> {
  const { graph, input, vertices } = part,
    n = vertices.length,
    sizes = input.sizes;
  // Each vertex's neighbours in the part, as runs of local indices, read straight from the graph. A
  // net of more than CLIQUE ends joins each to its first end alone, so large nets stay linear.
  const near = new Uint32Array(n + 1),
    incident = graph.incident,
    ends = graph.ends;
  const each = (i: number, visit: (j: number) => void) => {
    const v = vertices[i];
    for (let a = incident.offsets[v]; a < incident.offsets[v + 1]; a++) {
      const e = incident.items[a],
        first = ends.offsets[e],
        end = ends.offsets[e + 1],
        last = end - first > CLIQUE && ends.items[first] !== v ? first + 1 : end;
      for (let b = first; b < last; b++) {
        const u = ends.items[b],
          j = u === v ? -1 : part.indexOf(u);
        if (j >= 0) visit(j);
      }
    }
  };
  for (let i = 0; i < n; i++) each(i, () => near[i + 1]++);
  for (let i = 0; i < n; i++) near[i + 1] += near[i];
  const neighbors = new Uint32Array(near[n]),
    fill = near.slice(0, n);
  for (let i = 0; i < n; i++) each(i, (j) => (neighbors[fill[i]++] = j));
  await work.step();
  // Centers, so sized vertices keep their gaps; an edge spans the gap and a typical vertex.
  const half = new Float64Array(n * 2),
    x = new Float64Array(n),
    y = new Float64Array(n),
    fixed = new Uint8Array(n);
  let extent = 0,
    pins = 0;
  for (let i = 0; i < n; i++) {
    const v = vertices[i];
    half[i * 2] = (sizes?.[v * 2] ?? 0) / 2;
    half[i * 2 + 1] = (sizes?.[v * 2 + 1] ?? 0) / 2;
    extent += Math.max(half[i * 2], half[i * 2 + 1]) * 2;
    const px = input.pinned[v * 2],
      py = input.pinned[v * 2 + 1];
    if (Number.isFinite(px) && Number.isFinite(py)) {
      x[i] = px + half[i * 2];
      y[i] = py + half[i * 2 + 1];
      fixed[i] = 1;
      pins++;
    }
  }
  const unit = layout.vertexGap + extent / n || 1;
  // Hop distances to pivots, each the vertex farthest from those before it, kept vertex by vertex
  // so the relaxation below reads each vertex's distances together.
  const k = Math.min(PIVOTS, n),
    hops = new Uint16Array(k * n),
    level = new Uint16Array(n),
    nearest = new Uint16Array(n).fill(FAR),
    queue = new Uint32Array(n),
    pivots = new Uint32Array(k);
  let pivot = pins ? fixed.indexOf(1) : 0;
  for (let p = 0; p < k; p++) {
    await work.step();
    pivots[p] = pivot;
    level.fill(FAR);
    level[pivot] = 0;
    queue[0] = pivot;
    for (let head = 0, tail = 1; head < tail; head++) {
      const i = queue[head],
        next = Math.min(level[i] + 1, FAR - 1);
      for (let a = near[i]; a < near[i + 1]; a++) {
        const j = neighbors[a];
        if (level[j] === FAR) {
          level[j] = next;
          queue[tail++] = j;
        }
      }
    }
    let far = 0;
    for (let i = 0; i < n; i++) {
      hops[i * k + p] = level[i];
      if (level[i] < nearest[i]) nearest[i] = level[i];
      if (nearest[i] > nearest[far]) far = i;
    }
    pivot = far;
  }
  if (pins) await spread(near, neighbors, x, y, fixed, unit, work);
  else await scale(hops, k, n, x, y, near, neighbors, unit, work);
  // Relax: each free vertex moves to where its neighbours and the pivots would have it, each term
  // weighted by its inverse squared length.
  const neighbour = 1 / (unit * unit);
  for (let sweep = 0; sweep < SWEEPS; sweep++)
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0) await work.step();
      if (fixed[i]) continue;
      const xi = x[i],
        yi = y[i];
      let sx = 0,
        sy = 0,
        sw = 0;
      for (let t = near[i], end = near[i + 1] + k; t < end; t++) {
        let j: number, length: number, w: number;
        if (t < near[i + 1]) {
          j = neighbors[t];
          length = unit;
          w = neighbour;
        } else {
          const h = hops[i * k + t - near[i + 1]];
          if (h === 0 || h === FAR) continue;
          j = pivots[t - near[i + 1]];
          length = h * unit;
          w = 1 / (length * length);
        }
        let dx = xi - x[j],
          dy = yi - y[j],
          d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1e-9) {
          // Coincident points part along a direction of their own.
          const angle = (i * 2.399963 + j) % (2 * Math.PI);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        const reach = length / d;
        sx += w * (x[j] + dx * reach);
        sy += w * (y[j] + dy * reach);
        sw += w;
      }
      if (sw > 0) {
        x[i] = sx / sw;
        y[i] = sy / sw;
      }
    }
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = x[i] - half[i * 2];
    out[i * 2 + 1] = y[i] - half[i * 2 + 1];
  }
  return out;
}
/**
 * The part's shape from its distances to the pivots, scaled to its edges' length: the two leading
 * axes of the doubly centered squared distances (pivot MDS).
 */
async function scale(
  hops: Uint16Array,
  k: number,
  n: number,
  x: Float64Array,
  y: Float64Array,
  near: Uint32Array,
  neighbors: Uint32Array,
  unit: number,
  work: Work,
): Promise<void> {
  const square = (p: number, i: number) => hops[i * k + p] * hops[i * k + p],
    columns = new Float64Array(k),
    rows = new Float64Array(n);
  let all = 0;
  for (let i = 0; i < n; i++)
    for (let p = 0; p < k; p++) {
      const s = square(p, i);
      columns[p] += s / n;
      rows[i] += s / k;
      all += s / (n * k);
    }
  const c = (p: number, i: number) => -0.5 * (square(p, i) - columns[p] - rows[i] + all);
  // The pivots' cross products, k × k, which the two axes are eigenvectors of.
  const cross = new Float64Array(k * k),
    row = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0) await work.step();
    for (let p = 0; p < k; p++) row[p] = c(p, i);
    for (let p = 0; p < k; p++) for (let q = p; q < k; q++) cross[p * k + q] += row[p] * row[q];
  }
  for (let p = 0; p < k; p++) for (let q = 0; q < p; q++) cross[p * k + q] = cross[q * k + p];
  const first = leading(cross, k),
    value = rayleigh(cross, k, first);
  for (let p = 0; p < k; p++)
    for (let q = 0; q < k; q++) cross[p * k + q] -= value * first[p] * first[q];
  const second = leading(cross, k);
  for (let i = 0; i < n; i++) {
    let a = 0,
      b = 0;
    for (let p = 0; p < k; p++) {
      const v = c(p, i);
      a += v * first[p];
      b += v * second[p];
    }
    x[i] = a;
    y[i] = b;
  }
  // Scale so an edge is a unit long on average; a part collapsed to a point spreads on a circle.
  let total = 0,
    count = 0;
  for (let i = 0; i < n; i++)
    for (let e = near[i]; e < near[i + 1]; e++) {
      total += Math.hypot(x[i] - x[neighbors[e]], y[i] - y[neighbors[e]]);
      count++;
    }
  const mean = count ? total / count : 0;
  if (!(mean > 1e-12)) {
    const radius = (unit * n) / (2 * Math.PI);
    for (let i = 0; i < n; i++) {
      x[i] = radius * Math.cos((2 * Math.PI * i) / n);
      y[i] = radius * Math.sin((2 * Math.PI * i) / n);
    }
    return;
  }
  const s = unit / mean;
  for (let i = 0; i < n; i++) {
    x[i] *= s;
    y[i] *= s;
  }
}
/** The leading eigenvector of a small symmetric matrix, by power iteration from a fixed start. */
function leading(matrix: Float64Array, k: number): Float64Array {
  const v = Float64Array.from({ length: k }, (_, p) => 1 / (p + 1)),
    next = new Float64Array(k);
  for (let round = 0; round < 100; round++) {
    let norm = 0;
    for (let p = 0; p < k; p++) {
      let sum = 0;
      for (let q = 0; q < k; q++) sum += matrix[p * k + q] * v[q];
      next[p] = sum;
      norm += sum * sum;
    }
    norm = Math.sqrt(norm);
    if (!(norm > 0)) break;
    for (let p = 0; p < k; p++) v[p] = next[p] / norm;
  }
  return v;
}
function rayleigh(matrix: Float64Array, k: number, v: Float64Array): number {
  let value = 0;
  for (let p = 0; p < k; p++) {
    let sum = 0;
    for (let q = 0; q < k; q++) sum += matrix[p * k + q] * v[q];
    value += v[p] * sum;
  }
  return value;
}
/**
 * Free vertices of a part with pins, outward from them: each starts at the mean of its placed
 * neighbours, a unit off along a direction of its own.
 */
async function spread(
  near: Uint32Array,
  neighbors: Uint32Array,
  x: Float64Array,
  y: Float64Array,
  fixed: Uint8Array,
  unit: number,
  work: Work,
): Promise<void> {
  const n = x.length,
    placed = Uint8Array.from(fixed),
    queue = new Uint32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) if (fixed[i]) queue[tail++] = i;
  for (let head = 0; head < tail; head++) {
    if ((head & 4095) === 0) await work.step();
    const i = queue[head];
    for (let a = near[i]; a < near[i + 1]; a++) {
      const j = neighbors[a];
      if (placed[j]) continue;
      let sx = 0,
        sy = 0,
        count = 0;
      for (let b = near[j]; b < near[j + 1]; b++)
        if (placed[neighbors[b]]) {
          sx += x[neighbors[b]];
          sy += y[neighbors[b]];
          count++;
        }
      const angle = (j * 2.399963) % (2 * Math.PI);
      x[j] = sx / count + unit * Math.cos(angle);
      y[j] = sy / count + unit * Math.sin(angle);
      placed[j] = 1;
      queue[tail++] = j;
    }
  }
}
