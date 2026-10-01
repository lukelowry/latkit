import { rowAt } from '@latkit/model';
import { GpuError, type NativeFields, type FieldValues } from '@latkit/gpu';
import type { NetworkData, EdgeOptions } from '../data.js';
import {
  BANK_ROWS,
  edgeOptions,
  vertexOptions,
  segmentBatch,
  type Geometry,
  type VertexBank,
  type EdgeBank,
  type Limits,
} from './topology.js';
import { nativeValue, value, bit, RowLookup } from './rows.js';
import { scaledValue, type FieldRead } from '../rendering/fields.js';
import type { Reads } from '../rendering/painter.js';

type Point = readonly [number, number, number];
type Address = { bank: VertexBank; offset: number; point: Point };
const DEG = Math.PI / 180;
const unit = (p: Point): Point => [
  Math.cos(p[1] * DEG) * Math.cos(p[0] * DEG),
  Math.sin(p[1] * DEG),
  Math.cos(p[1] * DEG) * Math.sin(p[0] * DEG),
];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const longitude = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
/** Deterministic shortest great-circle interpolation, including antipodal endpoints. */
export function geodesic(a: Point, b: Point, t: number): Point {
  const u = unit(a),
    v = unit(b),
    cosine = Math.max(-1, Math.min(1, dot(u, v))),
    angle = Math.acos(cosine);
  if (angle < 1e-8) return [a[0], a[1], a[2] + (b[2] - a[2]) * t];
  let tangent: Point = [v[0] - u[0] * cosine, v[1] - u[1] * cosine, v[2] - u[2] * cosine];
  let n = Math.hypot(...tangent);
  if (n < 1e-8) {
    const axis: Point = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const d = dot(axis, u);
    tangent = [axis[0] - d * u[0], axis[1] - d * u[1], axis[2] - d * u[2]];
    n = Math.hypot(...tangent);
  }
  const c = Math.cos(angle * t),
    s = Math.sin(angle * t) / n;
  const p: Point = [
    u[0] * c + tangent[0] * s,
    u[1] * c + tangent[1] * s,
    u[2] * c + tangent[2] * s,
  ];
  return [
    Math.atan2(p[2], p[0]) / DEG,
    Math.asin(Math.max(-1, Math.min(1, p[1]))) / DEG,
    a[2] + (b[2] - a[2]) * t,
  ];
}
function lookup(read: FieldRead): RowLookup<NativeFields> {
  const result = new RowLookup<NativeFields>();
  for (const tile of read.native) result.add(tile.rows, tile);
  result.seal();
  return result;
}
function signature(reads: Reads, data: NetworkData): unknown[] {
  const key: unknown[] = [];
  const column = (v: unknown): void => {
    if (ArrayBuffer.isView(v)) {
      key.push(v.buffer, v.byteOffset, v.byteLength);
      return;
    }
    if (v && typeof v === 'object') {
      for (const child of Object.values(v)) column(child);
    } else key.push(v);
  };
  for (const [bank, read] of reads.vertices) {
    column(vertexOptions(data, bank).height?.range);
    column(read.scales.height?.domain);
    for (const tile of read.native)
      for (const name of ['position', 'x', 'y', 'height']) {
        column(tile.columns[name]);
        column(tile.presence[name]);
      }
  }
  for (const [bank, read] of reads.edges) {
    key.push(
      (edgeOptions(data, bank) as EdgeOptions).curve,
      !!(edgeOptions(data, bank) as EdgeOptions).junction,
    );
    for (const tile of read.native)
      for (const name of ['points', 'bends', 'junction', 'junctionX', 'junctionY']) {
        column(tile.columns[name]);
        column(tile.presence[name]);
      }
  }
  return key;
}
export class Paths {
  private decorations = new WeakMap<
    EdgeBank,
    { key: unknown[]; geometry: Geometry; vertices: readonly VertexBank[]; edge: EdgeBank }
  >();
  private cached?: {
    native: Geometry;
    key: unknown[];
    geometry: Geometry;
    origins: Map<EdgeBank, EdgeBank>;
  };
  prepare(
    native: Geometry,
    reads: Reads,
    data: NetworkData,
    limits: Required<Limits>,
  ): { geometry: Geometry; origins: ReadonlyMap<EdgeBank, EdgeBank> } {
    const needed = native.edges.some(
      (bank) => bank.kind || bank.stars || (edgeOptions(data, bank) as EdgeOptions).bends,
    );
    if (!needed) {
      this.cached = undefined;
      return { geometry: native, origins: new Map() };
    }
    const key = signature(reads, data),
      cached = this.cached;
    if (
      cached?.native === native &&
      key.length === cached.key.length &&
      key.every((v, i) => v === cached.key[i])
    )
      return cached;
    const vertices = [...native.vertices],
      edges: EdgeBank[] = [],
      origins = new Map<EdgeBank, EdgeBank>();
    const lookups = new Map(
      native.vertices.map((bank) => [bank, lookup(reads.vertices.get(bank)!)]),
    );
    let bytes = native.bytes,
      segments = 0,
      points = 0,
      branch = 0;
    const charge = (n: number) => {
      bytes += n;
      if (bytes > limits.cpuBytes)
        throw new GpuError('resource-limit', 'Paths exceed the network CPU budget');
    };
    const point = (bank: VertexBank, offset: number): Point => {
      const read = reads.vertices.get(bank)!,
        found = lookups.get(bank)!.get(rowAt(bank.rows, offset))!;
      return [
        nativeValue(found.value, read.vector ? 'position' : 'x', found.offset),
        nativeValue(found.value, read.vector ? 'position' : 'y', found.offset, read.vector ? 1 : 0),
        scaledValue(read, 'height', found.value, found.offset, vertexOptions(data, bank).height, 0),
      ];
    };
    const address = (dense: number): Address => {
      let lo = 0,
        hi = native.vertices.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (native.vertices[m].base <= dense) lo = m + 1;
        else hi = m;
      }
      const bank = native.vertices[lo - 1],
        offset = dense - bank.base;
      return { bank, offset, point: point(bank, offset) };
    };
    for (const original of native.edges) {
      const options = edgeOptions(data, original) as EdgeOptions;
      if (!original.kind && !options.bends && !original.stars) {
        edges.push(original);
        segments += original.batches.reduce((n, b) => n + b.records.length / 4, 0);
        continue;
      }
      if (options.curve === 'geodesic' && !native.geographic)
        throw new GpuError('invalid-input', 'Geodesics require geographic coordinates');
      const ownKey: unknown[] = [options.curve];
      if (original.kind)
        for (const tile of reads.edges.get(original)!.native) {
          const c = tile.columns.points;
          if (c?.kind === 'list' && c.values.kind === 'vector')
            ownKey.push(
              c.offset,
              c.length,
              c.offsets.buffer,
              c.offsets.byteOffset,
              c.values.offset,
              c.values.values.offset,
              c.values.values.values.buffer,
              c.values.values.values.byteOffset,
              c.validity,
              tile.presence.points,
            );
        }
      const previous = original.kind ? this.decorations.get(original) : undefined;
      if (
        previous &&
        ownKey.length === previous.key.length &&
        ownKey.every((v, i) => v === previous.key[i])
      ) {
        vertices.push(...previous.vertices);
        edges.push(previous.edge);
        origins.set(previous.edge, original);
        charge(previous.geometry.bytes);
        segments += previous.edge.batches.reduce((n, b) => n + b.records.length / 4, 0);
        continue;
      }
      const firstVertex = vertices.length,
        beforeBytes = bytes;
      const fields = lookup(reads.edges.get(original)!);
      const groups = new Map<
        string,
        { a: VertexBank; b: VertexBank; values: number[]; order: number[] }
      >();
      let sequence = 0;
      let coordinates: number[] = [],
        heights: number[] = [];
      let active: VertexBank;
      const allocate = () => {
        active = {
          id: vertices.length,
          type: original.type,
          index: original.index,
          rows: { kind: 'range', offset: 0, count: 0 },
          count: 0,
          base: native.vertexCount + points,
          synthetic: {},
        };
        vertices.push(active);
      };
      const flush = () => {
        if (!coordinates.length) return;
        const count = heights.length,
          rows = { kind: 'range' as const, offset: 0, count };
        const values = new Float64Array(coordinates),
          h = new Float32Array(heights);
        const position: FieldValues = {
          index: active.index,
          rows,
          values: {
            kind: 'vector',
            offset: 0,
            length: count,
            size: 2,
            values: { kind: 'numeric', offset: 0, length: values.length, values },
          },
        };
        Object.assign(active, {
          rows,
          count,
          position,
          synthetic: {
            position,
            height: {
              field: {
                index: active.index,
                rows,
                values: { kind: 'numeric', offset: 0, length: count, values: h },
              },
              domain: [0, 1],
              range: [0, 1],
            },
          },
        });
        points += count;
        coordinates = [];
        heights = [];
      };
      const addPoint = (p: Point): Address => {
        if (!active || heights.length === BANK_ROWS) {
          flush();
          allocate();
        }
        const offset = heights.length;
        coordinates.push(p[0], p[1]);
        heights.push(p[2]);
        charge(40);
        return { bank: active, offset, point: p };
      };
      const segment = (a: Address, b: Address, owner: number, branch: number) => {
        if (++segments > limits.maxSegments)
          throw new GpuError('resource-limit', 'Path segment limit exceeded');
        charge(48);
        const key = a.bank.id + ':' + b.bank.id;
        let group = groups.get(key);
        if (!group) {
          group = { a: a.bank, b: b.bank, values: [], order: [] };
          groups.set(key, group);
        }
        group.values.push(a.offset, b.offset, owner, branch);
        group.order.push(sequence++);
      };
      const trace = (controls: (Address | Point)[], owner: number) => {
        let previous: Address | undefined;
        const currentBranch = ++branch;
        for (let c = 0; c < controls.length; c++) {
          const control = controls[c],
            target = 'bank' in control ? control : addPoint(control);
          if (!target.point.every(Number.isFinite)) {
            previous = undefined;
            continue;
          }
          if (!previous) {
            previous = target;
            continue;
          }
          const start = previous,
            a = start.point,
            b = target.point;
          let steps = 1;
          if (native.geographic && options.curve !== 'geodesic') {
            const angle = Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) / DEG;
            steps = Math.max(1, Math.ceil(angle));
          }
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const p: Point =
              options.curve === 'geodesic'
                ? b
                : [
                    a[0] + (native.geographic ? longitude(b[0] - a[0]) : b[0] - a[0]) * t,
                    a[1] + (b[1] - a[1]) * t,
                    a[2] + (b[2] - a[2]) * t,
                  ];
            let next = s === steps ? target : addPoint(p);
            if (
              native.geographic &&
              options.curve !== 'geodesic' &&
              Math.abs(longitude(previous!.point[0]) - longitude(p[0])) > 180
            ) {
              const pa = previous!.point,
                x = longitude(pa[0]),
                y = longitude(p[0]);
              const seam = x > 0 ? 180 : -180,
                adjusted = y + (x > 0 ? 360 : -360),
                k = (seam - x) / (adjusted - x);
              const lat = pa[1] + (p[1] - pa[1]) * k,
                h = pa[2] + (p[2] - pa[2]) * k;
              const end = addPoint([seam, lat, h]);
              segment(previous!, end, owner, currentBranch);
              previous = addPoint([-seam, lat, h]);
              next = addPoint([y, p[1], p[2]]);
            }
            segment(previous!, next, owner, currentBranch);
            previous = next;
          }
        }
      };
      const list = (tile: NativeFields, name: string, row: number): Point[] => {
        const column = tile.columns[name];
        if (column?.kind !== 'list' || column.values.kind !== 'vector' || column.values.size !== 2)
          throw new GpuError('invalid-input', 'Paths require lists of two-component vectors');
        const at = column.offset + row;
        if (!bit(tile.presence[name], row) || !bit(column.validity, at)) return [];
        const result: Point[] = [];
        for (let i = column.offsets[at]; i < column.offsets[at + 1]; i++)
          result.push([value(column.values, i), value(column.values, i, 1), 0]);
        return result;
      };
      for (let row = 0; row < original.count; row++) {
        const found = fields.get(rowAt(original.rows, row))!;
        if (original.kind) {
          trace(list(found.value, 'points', found.offset), row);
          continue;
        }
        const ends = Array.from(
          original.incidence.vertices.subarray(
            original.incidence.offsets[row],
            original.incidence.offsets[row + 1],
          ),
          address,
        );
        if (options.junction ? ends.length : ends.length > 2) {
          let center: Point;
          if (options.junction) {
            const vector = !!found.value.columns.junction;
            center = [
              nativeValue(found.value, vector ? 'junction' : 'junctionX', found.offset),
              nativeValue(
                found.value,
                vector ? 'junction' : 'junctionY',
                found.offset,
                vector ? 1 : 0,
              ),
              0,
            ];
          } else {
            const valid = ends.filter((end) => end.point.every(Number.isFinite));
            if (!valid.length) continue;
            const sum = [0, 0, 0];
            for (const end of valid) {
              const p = native.geographic ? unit(end.point) : end.point;
              for (let i = 0; i < 3; i++) sum[i] += p[i];
            }
            center = native.geographic
              ? [
                  Math.atan2(sum[2], sum[0]) / DEG,
                  Math.atan2(sum[1], Math.hypot(sum[0], sum[2])) / DEG,
                  valid.reduce((n, e) => n + e.point[2], 0) / valid.length,
                ]
              : [sum[0] / valid.length, sum[1] / valid.length, sum[2] / valid.length];
            if (native.geographic && Math.hypot(...sum) < 1e-12) center = valid[0].point;
          }
          const junction = addPoint(center);
          for (const end of ends) trace([end, junction], row);
        } else if (ends.length === 2) {
          const bends = options.bends ? list(found.value, 'bends', found.offset) : [];
          for (let i = 0; i < bends.length; i++)
            bends[i] = [
              bends[i][0],
              bends[i][1],
              ends[0].point[2] +
                ((ends[1].point[2] - ends[0].point[2]) * (i + 1)) / (bends.length + 1),
            ];
          trace([ends[0], ...bends, ends[1]], row);
        }
      }
      flush();
      const ordered = [...groups.values()],
        order = new Uint32Array(sequence * 2);
      ordered.forEach((group, batch) =>
        group.order.forEach((sequence, offset) => {
          order[sequence * 2] = batch;
          order[sequence * 2 + 1] = offset;
        }),
      );
      charge(order.byteLength + sequence * 4);
      const bank = {
        ...original,
        order,
        batches: ordered.map((g) => ({
          ...segmentBatch(g.a, g.b, Uint32Array.from(g.values)),
          order: Uint32Array.from(g.order),
        })),
      };
      origins.set(bank, original);
      edges.push(bank);
      if (original.kind)
        this.decorations.set(original, {
          key: ownKey,
          edge: bank,
          vertices: vertices.slice(firstVertex),
          geometry: { ...native, bytes: bytes - beforeBytes },
        });
    }
    const geometry: Geometry = {
      ...native,
      native,
      vertices,
      edges,
      bytes,
      segmentCount: segments,
    };
    this.cached = { native, key, geometry, origins };
    return this.cached;
  }
}
