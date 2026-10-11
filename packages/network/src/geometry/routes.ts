import { bitAt, failure, rowAt, type Block, type FieldInput } from '@latkit/model';
import { kit } from '@latkit/gpu';
import type { NetworkData } from '../data.js';
import {
  BANK_ROWS,
  edgeOptions,
  segmentBatch,
  type Geometry,
  type VertexBank,
  type EdgeBank,
} from './topology.js';
import { value, RowLookup } from './rows.js';
import type { ChannelName, FieldRead } from '../rendering/fields.js';
import type { Reads } from '../rendering/painter.js';
import type { Network } from '../network.js';
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
/**
 * The point `t` of the way along a route between two geographic points: the great circle, or
 * straight in longitude and latitude the short way round, as the GPU draws them.
 */
export function routePoint(route: 'straight' | 'geodesic', a: Point, b: Point, t: number): Point {
  if (route === 'geodesic') return geodesic(a, b, t);
  return [a[0] + longitude(b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** The degrees of arc between two geographic points. */
export function arc(a: Point, b: Point): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) / DEG;
}
function lookup(read: FieldRead): RowLookup<Block.Fields> {
  const result = new RowLookup<Block.Fields>();
  for (const tile of read.native) result.add(tile.rows, tile);
  result.seal();
  return result;
}
/** Whether a net type centers its stars on its own x and y. */
function centered(options: Network.EdgeOptions): boolean {
  return options.x != null || options.y != null;
}
function signature(reads: Reads, data: NetworkData): unknown[] {
  const key: unknown[] = [];
  const add = (v: unknown): void => {
    if (ArrayBuffer.isView(v)) {
      key.push(v.buffer, v.byteOffset, v.byteLength);
      return;
    }
    if (v && typeof v === 'object') {
      for (const child of Object.values(v)) add(child);
    } else key.push(v);
  };
  /** What a read's channels place: their columns, lanes, scales, and constants. */
  const channels = (read: FieldRead, names: readonly ChannelName[], lists: readonly string[]) => {
    const columns = [...lists];
    for (const name of names) {
      const channel = read.channel(name);
      key.push(channel.column, channel.component, channel.fallback);
      add(channel.scale);
      if (channel.column !== undefined) columns.push(channel.column);
    }
    for (const tile of read.native)
      for (const name of columns) {
        add(tile.columns[name]);
        add(tile.presence[name]);
      }
  };
  for (const read of reads.vertices.values()) channels(read, ['x', 'y', 'z'], []);
  for (const [bank, read] of reads.edges) {
    const options = edgeOptions(data, bank);
    key.push(options.route, centered(options));
    channels(read, ['x', 'y'], ['bends']);
  }
  return key;
}
/**
 * Edges that draw through points of their own: bends, and stars meeting at a junction. Their
 * points become private vertex banks, compiled once until what they read changes.
 */
export class Routes {
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
    limits: Required<Network.Limits>,
  ): { geometry: Geometry; origins: ReadonlyMap<EdgeBank, EdgeBank> } {
    const needed = native.edges.some((bank) => bank.stars || edgeOptions(data, bank).bends);
    if (!needed) {
      this.cached = undefined;
      return { geometry: native, origins: new Map() };
    }
    const key = signature(reads, data),
      cached = this.cached;
    if (
      cached?.native === native &&
      key.length === cached.key.length &&
      key.every((v, i) => Object.is(v, cached.key[i]))
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
      branches = 0;
    const charge = (n: number) => {
      bytes += n;
      if (bytes > limits.geometryBytes)
        throw failure('resource-limit', 'Routes exceed the network CPU budget');
    };
    const point = (bank: VertexBank, offset: number): Point => {
      const read = reads.vertices.get(bank)!,
        found = lookups.get(bank)!.get(rowAt(bank.rows, offset))!;
      return [
        kit.channelValue(read.channels.x, found.value, found.offset),
        kit.channelValue(read.channels.y, found.value, found.offset),
        kit.channelValue(read.channels.z, found.value, found.offset),
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
      const options = edgeOptions(data, original);
      if (!options.bends && !original.stars) {
        edges.push(original);
        segments += original.batches.reduce((n, b) => n + b.records.length / 4, 0);
        continue;
      }
      const read = reads.edges.get(original)!,
        fields = lookup(read);
      const groups = new Map<
        string,
        { a: VertexBank; b: VertexBank; values: number[]; prefixes: number[]; order: number[] }
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
        const position: FieldInput.Values = {
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
        const height: FieldInput.Values = {
          index: active.index,
          rows,
          values: { kind: 'numeric', offset: 0, length: count, values: h },
        };
        Object.assign(active, {
          rows,
          count,
          synthetic: {
            x: { field: position },
            y: { field: position, component: 1 },
            z: { field: height, domain: [0, 1], range: [0, 1] },
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
      /** A segment of an owner's branch, `along` it from where its dashes start. */
      const segment = (a: Address, b: Address, owner: number, branch: number, along: number) => {
        if (++segments > limits.segments)
          throw failure('resource-limit', 'Network segment limit exceeded');
        charge(52);
        const key = a.bank.id + ':' + b.bank.id;
        let group = groups.get(key);
        if (!group) {
          group = { a: a.bank, b: b.bank, values: [], prefixes: [], order: [] };
          groups.set(key, group);
        }
        group.values.push(a.offset, b.offset, owner, branch);
        group.prefixes.push(along);
        group.order.push(sequence++);
      };
      /** How far apart two points lie: degrees of arc on the earth, the data's units on a plane. */
      const span = (a: Point, b: Point) =>
        native.geographic ? arc(a, b) : Math.hypot(b[0] - a[0], b[1] - a[1]);
      /** A branch of segments through an owner's points, in order, its dashes carrying on along it. */
      const trace = (controls: (Address | Point)[], owner: number) => {
        const branch = ++branches;
        let previous: Address | undefined,
          along = 0;
        for (const control of controls) {
          const target = 'bank' in control ? control : addPoint(control);
          if (!target.point.every(Number.isFinite)) {
            previous = undefined;
            continue;
          }
          if (previous) {
            const a = previous.point,
              b = target.point;
            // A straight line on a flat map crosses the antimeridian at the map's edge, as two
            // segments; the curves the GPU draws split there themselves.
            if (
              native.geographic &&
              options.route !== 'geodesic' &&
              Math.abs(longitude(a[0]) - longitude(b[0])) > 180
            ) {
              const x = longitude(a[0]),
                y = longitude(b[0]),
                seam = x > 0 ? 180 : -180,
                k = (seam - x) / (y + (x > 0 ? 360 : -360) - x),
                lat = a[1] + (b[1] - a[1]) * k,
                h = a[2] + (b[2] - a[2]) * k,
                end = addPoint([seam, lat, h]);
              segment(previous, end, owner, branch, along);
              along += span(a, end.point);
              previous = addPoint([-seam, lat, h]);
            }
            segment(previous, target, owner, branch, along);
            along += span(previous.point, b);
          }
          previous = target;
        }
      };
      const list = (tile: Block.Fields, name: string, row: number): Point[] => {
        const column = tile.columns[name];
        if (column?.kind !== 'list' || column.values.kind !== 'vector' || column.values.size !== 2)
          throw failure('invalid-input', 'Bends require lists of two-component vectors');
        const at = column.offset + row;
        if (!bitAt(tile.presence[name], row) || !bitAt(column.validity, at)) return [];
        const result: Point[] = [];
        for (let i = column.offsets[at]; i < column.offsets[at + 1]; i++)
          result.push([value(column.values, i), value(column.values, i, 1), 0]);
        return result;
      };
      for (let row = 0; row < original.count; row++) {
        const found = fields.get(rowAt(original.rows, row))!;
        const ends = Array.from(
          original.incidence.vertices.subarray(
            original.incidence.offsets[row],
            original.incidence.offsets[row + 1],
          ),
          address,
        );
        if (centered(options) ? ends.length : ends.length > 2) {
          let center: Point;
          if (centered(options))
            center = [
              kit.channelValue(read.channels.x, found.value, found.offset),
              kit.channelValue(read.channels.y, found.value, found.offset),
              0,
            ];
          else {
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
      charge(sequence * 4);
      const bank = {
        ...original,
        batches: [...groups.values()].map((g) => ({
          ...segmentBatch(g.a, g.b, Uint32Array.from(g.values)),
          order: Uint32Array.from(g.order),
          prefixes: Float32Array.from(g.prefixes),
        })),
      };
      origins.set(bank, original);
      edges.push(bank);
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
