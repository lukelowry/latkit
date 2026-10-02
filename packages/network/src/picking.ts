import { kit } from '@latkit/gpu';
import { rowAt, sameIndex } from '@latkit/model';
import type { NetworkData, NetworkItem, VertexData } from './data.js';
import {
  vertexOptions,
  edgeOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
  type SegmentBatch,
} from './geometry/topology.js';
import { nativeValue, RowLookup } from './geometry/rows.js';
import { project, projectedStroke, worldVisible, type Camera, type Projected } from './camera.js';
import { geodesic } from './geometry/paths.js';
import { scaledValue, type FieldRead } from './rendering/fields.js';
import type { Reads } from './rendering/painter.js';
import type { Style } from './options.js';

class Tree {
  readonly order: Uint32Array;
  readonly boxes: Float64Array;
  readonly size: number;
  constructor(count: number, read: (i: number) => kit.Bounds2D) {
    let size = 1;
    while (size < count) size *= 2;
    this.size = size;
    this.order = Uint32Array.from({ length: count }, (_, i) => i);
    const boxes = new Float64Array(count * 4);
    for (let i = 0; i < count; i++) boxes.set(read(i), i * 4);
    // Sorting once makes the hierarchy useful even for arbitrarily ordered native rows.
    this.order.sort(
      (a, b) =>
        boxes[a * 4] + boxes[a * 4 + 2] - (boxes[b * 4] + boxes[b * 4 + 2]) ||
        boxes[a * 4 + 1] + boxes[a * 4 + 3] - (boxes[b * 4 + 1] + boxes[b * 4 + 3]) ||
        a - b,
    );
    this.boxes = new Float64Array(size * 8);
    for (let i = 0; i < size; i++)
      this.boxes.set(
        i < count
          ? boxes.subarray(this.order[i] * 4, this.order[i] * 4 + 4)
          : [Infinity, Infinity, -Infinity, -Infinity],
        (size + i) * 4,
      );
    for (let i = size - 1; i > 0; i--) {
      const l = i * 8,
        r = l + 4;
      this.boxes.set(
        [
          Math.min(this.boxes[l], this.boxes[r]),
          Math.min(this.boxes[l + 1], this.boxes[r + 1]),
          Math.max(this.boxes[l + 2], this.boxes[r + 2]),
          Math.max(this.boxes[l + 3], this.boxes[r + 3]),
        ],
        i * 4,
      );
    }
  }
  *query(bounds: kit.Bounds2D, check: () => void): Iterable<number> {
    const stack = [1];
    while (stack.length) {
      check();
      const node = stack.pop()!,
        at = node * 4;
      if (
        this.boxes[at] > bounds[2] ||
        this.boxes[at + 1] > bounds[3] ||
        this.boxes[at + 2] < bounds[0] ||
        this.boxes[at + 3] < bounds[1]
      )
        continue;
      if (node >= this.size) {
        const i = node - this.size;
        if (i < this.order.length) yield this.order[i];
      } else {
        stack.push(node * 2, node * 2 + 1);
      }
    }
  }
}
interface Spatial {
  readonly identity: readonly unknown[];
  readonly bounds: kit.Bounds2D;
  tree?: Tree;
}
interface CpuBank {
  readonly bank: VertexBank;
  readonly read: FieldRead;
  readonly lookup: RowLookup<kit.NativeFields>;
  readonly spatial: Spatial;
  readonly heightIdentity: readonly unknown[];
}
interface CpuEdge {
  readonly bank: EdgeBank;
  readonly read: FieldRead;
  readonly lookup: RowLookup<kit.NativeFields>;
}
interface CpuSegment {
  readonly batch: SegmentBatch;
  readonly edge: CpuEdge;
  readonly a: CpuBank;
  readonly b: CpuBank;
  readonly spatial: { tree?: Tree };
}
function readLookup(read: FieldRead): RowLookup<kit.NativeFields> {
  const lookup = new RowLookup<kit.NativeFields>();
  for (const tile of read.native) lookup.add(tile.rows, tile);
  lookup.seal();
  return lookup;
}
function identity(read: FieldRead, fields = ['position', 'x', 'y']): unknown[] {
  const key: unknown[] = [read.vector];
  const view = (value?: ArrayBufferView) => {
    key.push(value?.buffer, value?.byteOffset, value?.byteLength, value?.constructor);
  };
  for (const tile of read.native) {
    key.push(tile.rows.kind);
    if (tile.rows.kind === 'range') key.push(tile.rows.offset, tile.rows.count);
    else view(tile.rows.values);
    for (const field of fields) {
      const column = tile.columns[field];
      key.push(column?.kind, column?.offset, column?.length);
      view(column?.validity);
      view(tile.presence[field]);
      if (column?.kind === 'vector') {
        key.push(column.size, column.values.offset, column.values.length);
        view(column.values.values);
      } else if (column && column.kind !== 'list' && column.kind !== 'text') view(column.values);
    }
  }
  return key;
}
function equal(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function raw(bank: CpuBank, offset: number): readonly [number, number] {
  const row = rowAt(bank.bank.rows, offset),
    found = bank.lookup.get(row);
  if (!found) return [NaN, NaN];
  return bank.read.vector
    ? [
        nativeValue(found.value, 'position', found.offset),
        nativeValue(found.value, 'position', found.offset, 1),
      ]
    : [nativeValue(found.value, 'x', found.offset), nativeValue(found.value, 'y', found.offset)];
}
function box(x: number, y: number): kit.Bounds2D {
  return Number.isFinite(x) && Number.isFinite(y)
    ? [x, y, x, y]
    : [Infinity, Infinity, -Infinity, -Infinity];
}
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; t: number; length: number } {
  const dx = bx - ax,
    dy = by - ay,
    len = dx * dx + dy * dy,
    t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return { distance: Math.hypot(px - ax - t * dx, py - ay - t * dy), t, length: Math.sqrt(len) };
}
function treeBytes(count: number): number {
  let n = 1;
  while (n < count) n *= 2;
  return n * 64 + count * 4;
}
function readBounds(
  bank: VertexBank,
  read: FieldRead,
  lookup: RowLookup<kit.NativeFields>,
): kit.Bounds2D {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const include = (tile: kit.NativeFields, i: number) => {
    const x = nativeValue(tile, read.vector ? 'position' : 'x', i);
    const y = nativeValue(tile, read.vector ? 'position' : 'y', i, read.vector ? 1 : 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  if (bank.rows.kind === 'range' && read.native.every((tile) => tile.rows.kind === 'range')) {
    for (const tile of read.native) {
      if (tile.rows.kind !== 'range') continue;
      const start = Math.max(0, bank.rows.offset - tile.rows.offset);
      const end = Math.min(tile.rows.count, bank.rows.offset + bank.rows.count - tile.rows.offset);
      for (let i = start; i < end; i++) include(tile, i);
    }
  } else {
    for (let i = 0; i < bank.count; i++) {
      const found = lookup.get(rowAt(bank.rows, i));
      if (found) include(found.value, found.offset);
    }
  }
  return [minX, minY, maxX, maxY];
}
export class Picking {
  private cache = new WeakMap<VertexBank, Spatial>();
  private segments = new WeakMap<
    SegmentBatch,
    { a: Spatial; b: Spatial; spatial: { tree?: Tree } }
  >();
  prepare(
    geometry: Pick<Geometry, 'vertices' | 'edges'>,
    reads: Reads,
    byteLimit: number,
  ): PickGeometry {
    const vertices = new Map<VertexBank, CpuBank>(),
      edges: CpuSegment[] = [];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const bank of geometry.vertices) {
      const read = reads.vertices.get(bank)!,
        key = identity(read),
        previous = this.cache.get(bank),
        lookup = readLookup(read);
      const spatial =
        previous && equal(key, previous.identity)
          ? previous
          : { identity: key, bounds: readBounds(bank, read, lookup) };
      this.cache.set(bank, spatial);
      vertices.set(bank, {
        bank,
        read,
        lookup,
        spatial,
        heightIdentity: [...identity(read, ['height']), ...(read.scales.height?.domain ?? [])],
      });
      if (bank.synthetic && geometry.vertices.some((v) => !v.synthetic)) continue;
      minX = Math.min(minX, spatial.bounds[0]);
      minY = Math.min(minY, spatial.bounds[1]);
      maxX = Math.max(maxX, spatial.bounds[2]);
      maxY = Math.max(maxY, spatial.bounds[3]);
    }
    for (const bank of geometry.edges) {
      const read = reads.edges.get(bank)!,
        edge = { bank, read, lookup: readLookup(read) };
      for (const batch of bank.batches) {
        const a = vertices.get(batch.a)!,
          b = vertices.get(batch.b)!,
          previous = this.segments.get(batch);
        const spatial =
          previous && previous.a === a.spatial && previous.b === b.spatial ? previous.spatial : {};
        this.segments.set(batch, { a: a.spatial, b: b.spatial, spatial });
        edges.push({ batch, edge, a, b, spatial });
      }
    }
    return new PickGeometry(
      vertices,
      edges,
      minX <= maxX ? [minX, minY, maxX, maxY] : [-1, -1, 1, 1],
      byteLimit,
    );
  }
}
interface Hit {
  readonly item: NetworkItem;
  readonly distance: number;
  readonly kind: number;
}
function compare(a: Hit, b: Hit): number {
  return a.kind - b.kind || a.distance - b.distance || a.item.row - b.item.row;
}
export const HOVER_EXHAUSTED = Symbol('hover budget exhausted');
const unchecked = () => {};
function* offsets(count: number, check: () => void): Iterable<number> {
  for (let i = 0; i < count; i++) {
    check();
    yield i;
  }
}
export class PickGeometry {
  constructor(
    private readonly vertices: ReadonlyMap<VertexBank, CpuBank>,
    private readonly edges: readonly CpuSegment[],
    readonly bounds: kit.Bounds2D,
    private readonly byteLimit: number,
  ) {}
  get bytes(): number {
    let bytes = 0;
    for (const cpu of this.vertices.values())
      if (cpu.spatial.tree)
        bytes += cpu.spatial.tree.boxes.byteLength + cpu.spatial.tree.order.byteLength;
    for (const cpu of this.edges)
      if (cpu.spatial.tree)
        bytes += cpu.spatial.tree.boxes.byteLength + cpu.spatial.tree.order.byteLength;
    return bytes;
  }
  samePositions(previous: PickGeometry): boolean {
    if (this.vertices.size !== previous.vertices.size) return false;
    for (const [bank, cpu] of this.vertices) {
      const old = previous.vertices.get(bank);
      if (!old || old.spatial !== cpu.spatial || !equal(old.heightIdentity, cpu.heightIdentity))
        return false;
    }
    return true;
  }
  private index(): void {
    // Only explicit flat hit queries build indexes. Include construction scratch in admission.
    let available = this.byteLimit - this.bytes;
    const build = (spatial: { tree?: Tree }, count: number, read: (i: number) => kit.Bounds2D) => {
      if (spatial.tree || treeBytes(count) + count * 32 > available) return;
      spatial.tree = new Tree(count, read);
      available -= treeBytes(count);
    };
    for (const cpu of this.vertices.values())
      build(cpu.spatial, cpu.bank.count, (i) => {
        const [x, y] = raw(cpu, i);
        return box(x, y);
      });
    for (const cpu of this.edges)
      build(cpu.spatial, cpu.batch.records.length / 4, (i) => {
        const [ax, ay] = raw(cpu.a, cpu.batch.records[i * 4]);
        const [bx, by] = raw(cpu.b, cpu.batch.records[i * 4 + 1]);
        return [ax, ay, bx, by].every(Number.isFinite)
          ? [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
          : [Infinity, Infinity, -Infinity, -Infinity];
      });
  }
  position(bank: VertexBank, offset: number): readonly [number, number] {
    return raw(this.vertices.get(bank)!, offset);
  }
  projected(
    bank: VertexBank,
    offset: number,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
    options: VertexData,
    marker = true,
  ): Projected & { radius: number; visible: boolean } {
    const cpu = this.vertices.get(bank)!,
      row = rowAt(bank.rows, offset),
      found = cpu.lookup.get(row)!;
    const [x, y] = raw(cpu, offset);
    const h =
      scaledValue(cpu.read, 'height', found.value, found.offset, options.height, 0) * height;
    const projected = project(camera, viewport, x, y, h);
    const visible = nativeValue(found.value, 'visible', found.offset);
    return {
      ...projected,
      visible: projected.visible && (!marker || !Number.isFinite(visible) || visible > 0),
      radius:
        bank.synthetic || (Number.isFinite(visible) && visible <= 0)
          ? 0
          : scaledValue(cpu.read, 'size', found.value, found.offset, options.size, 1),
    };
  }
  private phases = new Map<SegmentBatch, Float32Array>();
  /** Only multi-segment dashed paths need a prefix; ordinary edges pay no preparation cost. */
  dashPhases(
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
  ): ReadonlyMap<SegmentBatch, Float32Array> {
    const groups = new Map<EdgeBank, CpuSegment[]>();
    for (const batch of this.edges)
      if (
        batch.edge.bank.order &&
        (edgeOptions(data, batch.edge.bank) as import('./data.js').EdgeData).dash
      ) {
        const group = groups.get(batch.edge.bank) ?? [];
        group.push(batch);
        groups.set(batch.edge.bank, group);
      }
    for (const [bank, batches] of groups) {
      const outputs = batches.map((batch) => {
        const values = new Float32Array(batch.batch.records.length / 4);
        this.phases.set(batch.batch, values);
        return values;
      });
      let owner = -1,
        branch = -1,
        phase = 0;
      for (let i = 0; i < bank.order!.length; i += 2) {
        const group = bank.order![i],
          offset = bank.order![i + 1],
          batch = batches[group],
          records = batch.batch.records,
          at = offset * 4;
        if (owner !== records[at + 2] || branch !== records[at + 3]) {
          owner = records[at + 2];
          branch = records[at + 3];
          phase = 0;
        }
        const found = batch.edge.lookup.get(rowAt(bank.rows, owner))!;
        if (!(nativeValue(found.value, 'dash', found.offset) > 0)) continue;
        outputs[group][offset] = phase;
        for (const piece of this.stroke(
          batch,
          records[at],
          records[at + 1],
          data,
          camera,
          viewport,
          height,
          unchecked,
        ))
          phase += Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y);
      }
    }
    return this.phases;
  }
  private *stroke(
    batch: CpuSegment,
    ao: number,
    bo: number,
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
    check: () => void,
  ): Iterable<{ a: Projected; b: Projected; first: boolean; last: boolean }> {
    const ac = vertexOptions(data, batch.a.bank),
      bc = vertexOptions(data, batch.b.bank);
    const a = this.projected(batch.a.bank, ao, camera, viewport, height, ac, false),
      b = this.projected(batch.b.bank, bo, camera, viewport, height, bc, false);
    if (edgeOptions(data, batch.edge.bank).curve !== 'geodesic') {
      const clip = projectedStroke(a, b, camera, viewport);
      if (clip) yield { a: clip[0], b: clip[1], first: true, last: true };
      return;
    }
    const start = raw(batch.a, ao),
      end = raw(batch.b, bo);
    const ah =
      camera.projection === 'globe'
        ? Math.hypot(a.world[0], a.world[1], a.world[2] + 1) - 1
        : a.world[2];
    const bh =
      camera.projection === 'globe'
        ? Math.hypot(b.world[0], b.world[1], b.world[2] + 1) - 1
        : b.world[2];
    if (![...start, ...end, ah, bh].every(Number.isFinite)) return;
    const rad = Math.PI / 180,
      cosine =
        Math.sin(start[1] * rad) * Math.sin(end[1] * rad) +
        Math.cos(start[1] * rad) * Math.cos(end[1] * rad) * Math.cos((end[0] - start[0]) * rad);
    const steps = Math.max(1, Math.ceil(Math.acos(Math.max(-1, Math.min(1, cosine))) / rad));
    let previous: Projected = a;
    let previousXY: readonly [number, number] = start;
    for (let i = 1; i <= steps; i++) {
      check();
      const p = geodesic([start[0], start[1], ah], [end[0], end[1], bh], i / steps);
      const next = project(camera, viewport, p[0], p[1], p[2]);
      if (camera.projection !== 'globe' && Math.abs(p[0] - previousXY[0]) > 180) {
        const seam = previousXY[0] > 0 ? 180 : -180,
          adjusted = p[0] + (seam > 0 ? 360 : -360),
          t = (seam - previousXY[0]) / (adjusted - previousXY[0]);
        const lat = previousXY[1] + (p[1] - previousXY[1]) * t,
          h = previous.world[2] + (p[2] - previous.world[2]) * t;
        const left = projectedStroke(
          previous,
          project(camera, viewport, seam, lat, h),
          camera,
          viewport,
        );
        const right = projectedStroke(
          project(camera, viewport, -seam, lat, h),
          next,
          camera,
          viewport,
        );
        if (left) yield { a: left[0], b: left[1], first: i === 1, last: false };
        if (right) yield { a: right[0], b: right[1], first: false, last: i === steps };
      } else {
        const clip = projectedStroke(previous, next, camera, viewport);
        if (clip) yield { a: clip[0], b: clip[1], first: i === 1, last: i === steps };
      }
      previous = next;
      previousXY = [p[0], p[1]];
    }
  }
  hit(
    point: readonly [number, number],
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
    options: Style,
    radius: number,
  ): readonly NetworkItem[] {
    if (camera.projection === 'flat') this.index();
    const hits = [...this.hits(point, data, camera, viewport, height, options, radius, unchecked)];
    hits.sort(compare);
    const seen = new Set<string>();
    return hits
      .filter(({ item }) => {
        const key = item.kind + ':' + item.index.type + ':' + item.row;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((hit) => hit.item);
  }
  nearest(
    point: readonly [number, number],
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
    options: Style,
    radius: number,
    budgetMs?: number,
  ): NetworkItem | null | typeof HOVER_EXHAUSTED {
    const result = kit.withinBudget((check) => {
      let best: Hit | undefined;
      for (const hit of this.hits(point, data, camera, viewport, height, options, radius, check))
        if (!best || compare(hit, best) < 0) best = hit;
      return best?.item ?? null;
    }, budgetMs);
    return result.complete ? result.value : HOVER_EXHAUSTED;
  }
  private *hits(
    point: readonly [number, number],
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
    options: Style,
    radius: number,
    check: () => void,
  ): Iterable<Hit> {
    let bounds: kit.Bounds2D = [-Infinity, -Infinity, Infinity, Infinity];
    if (camera.projection === 'flat') {
      const dx = (point[0] - viewport.width / 2) / camera.scale,
        dy = -(point[1] - viewport.height / 2) / camera.scale,
        b = (camera.bearing * Math.PI) / 180;
      const x = camera.center[0] + dx * Math.cos(b) - dy * Math.sin(b),
        y = camera.center[1] + dx * Math.sin(b) + dy * Math.cos(b);
      const maxSize = Math.max(
        1,
        ...Object.values(data.vertices).map((v) => v.size?.range?.[1] ?? 2),
      );
      const reach =
        (radius +
          Math.max(options.vertexRadiusPx * maxSize, options.edgeWidthPx) +
          options.vertexSelectedPx) /
        camera.scale;
      bounds = [x - reach, y - reach, x + reach, y + reach];
    }
    if (options.showVertices || options.showPoles)
      for (const [bank, cpu] of this.vertices)
        if (!bank.synthetic)
          for (const offset of cpu.spatial.tree?.query(bounds, check) ??
            offsets(bank.count, check)) {
            check();
            const p = this.projected(
              bank,
              offset,
              camera,
              viewport,
              height,
              data.vertices[bank.type],
            );
            if (!p.visible) continue;
            let distance = options.showVertices
              ? Math.max(
                  0,
                  Math.hypot(point[0] - p.x, point[1] - p.y) - p.radius * options.vertexRadiusPx,
                )
              : Infinity;
            if (options.showPoles) {
              const [x, y] = raw(cpu, offset),
                base = project(camera, viewport, x, y);
              if (base.visible)
                distance = Math.min(
                  distance,
                  segmentDistance(point[0], point[1], base.x, base.y, p.x, p.y).distance - 1,
                );
            }
            if (distance <= radius)
              yield {
                item: {
                  kind: 'vertex',
                  source: data.source,
                  index: bank.index,
                  row: rowAt(bank.rows, offset),
                },
                distance,
                kind: 0,
              };
          }
    if (options.showEdges)
      for (const batch of this.edges)
        if (batch.edge.bank.kind !== 'path' || data.paths![batch.edge.bank.type].pickable)
          for (const offset of (edgeOptions(data, batch.edge.bank).curve === 'geodesic'
            ? undefined
            : batch.spatial.tree?.query(bounds, check)) ??
            offsets(batch.batch.records.length / 4, check)) {
            check();
            const records = batch.batch.records,
              ao = records[offset * 4],
              bo = records[offset * 4 + 1],
              eo = records[offset * 4 + 2];
            const edgeRow = rowAt(batch.edge.bank.rows, eo),
              ef = batch.edge.lookup.get(edgeRow)!;
            const visible = nativeValue(ef.value, 'visible', ef.offset);
            if (Number.isFinite(visible) && visible <= 0) continue;
            const a = this.projected(
              batch.a.bank,
              ao,
              camera,
              viewport,
              height,
              vertexOptions(data, batch.a.bank),
              false,
            );
            const b = this.projected(
              batch.b.bank,
              bo,
              camera,
              viewport,
              height,
              vertexOptions(data, batch.b.bank),
              false,
            );
            let phase = this.phases.get(batch.batch)?.[offset] ?? 0;
            for (const piece of this.stroke(batch, ao, bo, data, camera, viewport, height, check)) {
              const start = piece.a,
                end = piece.b;
              const hit = segmentDistance(point[0], point[1], start.x, start.y, end.x, end.y);
              const dashStart = phase;
              phase += hit.length;
              const width =
                batch.edge.bank.kind === 'path'
                  ? (data.paths![batch.edge.bank.type].widthPx ?? 1)
                  : options.edgeWidthPx;
              if (hit.distance > radius + width / 2) continue;
              let world = start.world.map(
                (v, i) => v + (end.world[i] - v) * hit.t,
              ) as unknown as Projected['world'];
              if (
                (records[offset * 4 + 3] ||
                  edgeOptions(data, batch.edge.bank).curve === 'geodesic') &&
                camera.projection === 'globe'
              ) {
                const sphere = [world[0], world[1], world[2] + 1],
                  r = Math.hypot(...sphere),
                  k = Math.max(1, r) / r;
                world = [sphere[0] * k, sphere[1] * k, sphere[2] * k - 1];
              }
              if (!worldVisible(world, camera, viewport)) continue;
              const dash = nativeValue(ef.value, 'dash', ef.offset);
              if (
                dash > 0 &&
                ((dashStart + hit.t * hit.length) / Math.max(1, options.dashPeriodPx)) % 1 > 0.55
              )
                continue;
              if (
                options.showVertices &&
                ((piece.first &&
                  Math.hypot(point[0] - a.x, point[1] - a.y) < a.radius * options.vertexRadiusPx) ||
                  (piece.last &&
                    Math.hypot(point[0] - b.x, point[1] - b.y) < b.radius * options.vertexRadiusPx))
              )
                continue;
              yield {
                item: {
                  kind: batch.edge.bank.kind ?? 'edge',
                  source: batch.edge.bank.source ?? data.source,
                  index: batch.edge.bank.index,
                  row: edgeRow,
                },
                distance: hit.distance,
                kind: 1,
              };
            }
          }
  }
  locate(
    item: NetworkItem,
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
  ): readonly [number, number] | null {
    if (
      item.source !==
      (item.kind === 'path' ? (data.paths?.[item.index.type]?.source ?? data.source) : data.source)
    )
      return null;
    if (item.kind === 'vertex')
      for (const [bank, cpu] of this.vertices) {
        if (bank.synthetic || !sameIndex(bank.index, item.index)) continue;
        const found = cpu.lookup.get(item.row);
        if (!found) continue;
        const [x, y] = cpu.read.vector
          ? [
              nativeValue(found.value, 'position', found.offset),
              nativeValue(found.value, 'position', found.offset, 1),
            ]
          : [
              nativeValue(found.value, 'x', found.offset),
              nativeValue(found.value, 'y', found.offset),
            ];
        const h =
          scaledValue(
            cpu.read,
            'height',
            found.value,
            found.offset,
            data.vertices[bank.type].height,
            0,
          ) * height;
        const p = project(camera, viewport, x, y, h);
        return Number.isFinite(p.x) && Number.isFinite(p.y) ? [p.x, p.y] : null;
      }
    const anchor = this.edgeAnchor(item, data, camera, viewport, height);
    return anchor ? [anchor.x, anchor.y] : null;
  }
  edgeAnchor(
    item: NetworkItem,
    data: NetworkData,
    camera: Camera,
    viewport: kit.Viewport,
    height: number,
  ): Projected | null {
    const segments: { batch: CpuSegment; offset: number }[] = [];
    for (const batch of this.edges) {
      const bank = batch.edge.bank;
      if ((bank.kind ?? 'edge') !== item.kind || !sameIndex(bank.index, item.index)) continue;
      const owner =
        bank.rows.kind === 'range'
          ? item.row - bank.rows.offset
          : bank.rows.values.indexOf(item.row);
      if (owner < 0 || owner >= bank.count) continue;
      const records = batch.batch.records;
      // Owner rows stay ordered inside every dense path batch; no per-frame spatial rebuild.
      let lo = 0,
        hi = records.length / 4;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (records[m * 4 + 2] < owner) lo = m + 1;
        else hi = m;
      }
      for (let i = lo * 4; i < records.length && records[i + 2] === owner; i += 4)
        segments.push({ batch, offset: i });
    }
    if (!segments.length) return null;
    if (segments[0].batch.batch.order)
      segments.sort(
        (a, b) => a.batch.batch.order![a.offset / 4] - b.batch.batch.order![b.offset / 4],
      );
    const branches = new Map<
      number,
      { length: number; pieces: { a: Projected; b: Projected; length: number }[] }
    >();
    for (const { batch, offset } of segments) {
      const records = batch.batch.records,
        ef = batch.edge.lookup.get(item.row)!;
      if (nativeValue(ef.value, 'visible', ef.offset) <= 0) continue;
      for (const piece of this.stroke(
        batch,
        records[offset],
        records[offset + 1],
        data,
        camera,
        viewport,
        height,
        unchecked,
      )) {
        const start = piece.a,
          end = piece.b;
        if (
          !worldVisible(start.world, camera, viewport) &&
          !worldVisible(end.world, camera, viewport)
        )
          continue;
        // Clip to the visible viewport before computing the label's arc-length midpoint.
        const dx = end.x - start.x,
          dy = end.y - start.y;
        let lo = 0,
          hi = 1;
        for (const [p, q] of [
          [-dx, start.x],
          [dx, viewport.width - start.x],
          [-dy, start.y],
          [dy, viewport.height - start.y],
        ]) {
          if (p === 0) {
            if (q < 0) {
              hi = -1;
              break;
            }
          } else if (p < 0) lo = Math.max(lo, q / p);
          else hi = Math.min(hi, q / p);
        }
        if (lo > hi) continue;
        const sample = (t: number): Projected => ({
          ...start,
          x: start.x + dx * t,
          y: start.y + dy * t,
          depth: start.depth + (end.depth - start.depth) * t,
        });
        const length = Math.hypot(dx, dy) * (hi - lo),
          branch = records[offset + 3];
        const entry = branches.get(branch) ?? { length: 0, pieces: [] };
        entry.length += length;
        entry.pieces.push({ a: sample(lo), b: sample(hi), length });
        branches.set(branch, entry);
      }
    }
    let best:
      { length: number; pieces: { a: Projected; b: Projected; length: number }[] } | undefined;
    for (const branch of branches.values()) if (!best || branch.length > best.length) best = branch;
    if (!best?.length) return null;
    let remaining = best.length / 2;
    for (const piece of best.pieces) {
      if (remaining <= piece.length) {
        const t = remaining / piece.length;
        return {
          ...piece.a,
          x: piece.a.x + (piece.b.x - piece.a.x) * t,
          y: piece.a.y + (piece.b.y - piece.a.y) * t,
          depth: piece.a.depth + (piece.b.depth - piece.a.depth) * t,
          visible: true,
        };
      }
      remaining -= piece.length;
    }
    return null;
  }
}
