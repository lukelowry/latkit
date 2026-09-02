import {
  PIPELINES,
  PROJECTION_DEFS,
  type ProjectionFamily,
  type Projection,
} from '../projections.js';
import type { Viewport } from '../camera/projection.js';
import type { Uniforms } from '../webgpu/uniforms.js';
import {
  ITEM_EDGE_VISIBLE,
  ITEM_VERTEX_VISIBLE,
  W_BACKING_SCALE,
  W_BASE_EDGE_WIDTH,
  W_DASH_PERIOD,
  W_DEPTH_MIX,
  W_HEIGHT_CENTER,
  W_HEIGHT_OUT_MIN,
  W_HEIGHT_OUT_SCALE,
  W_HEIGHT_SCALE,
  W_HEIGHT_WORLD_SCALE,
  W_ITEM_FLAGS,
  W_VERTEX_LOD,
  W_VIEWPORT_X,
  W_VIEWPORT_Y,
  W_V_HEIGHT_MODE,
  W_V_SIZE_MIN,
  W_V_SIZE_MODE,
  W_V_SIZE_SCALE,
} from '../webgpu/uniforms.js';
import { SEGMENT_RECORD_WORDS } from '../segments/wire.js';
import type { DecodedSegments } from '../segments/index.js';
import type { PreparedScene } from '../scene.js';
import type { Bounds } from '../topology/index.js';
import type { Channel } from '../channels.js';
import { VISUAL } from '../visual.js';
import { Grid } from './grid.js';
import {
  createPoint,
  mixPoint,
  MIN_CLIP_W,
  type ProjectedPoint,
  type Projector,
} from './project.js';

/**
 * Live dependencies the picker reads at query time.
 *
 * The uniform buffer is the same one the shaders render from, so pose,
 * visual scale, and channel normalization cannot drift between picked and
 * painted geometry.
 */
export interface PickerDeps {
  /** Packed render uniforms shared with the GPU shaders. */
  readonly uniforms: Uniforms;
  /** Current projection mode used to select the matching CPU projector. */
  mode(): Projection;
  /**
   * Camera cursor unprojection from CSS px and CSS viewport.
   *
   * Used only to seed the coord-space query region; exact tests are forward
   * projections through the same shader mirror used for rendering.
   */
  unproject(sx: number, sy: number, vp: Viewport): readonly [number, number] | null;
  /** Raw bound channel values (the same arrays the GPU uploaded). */
  values(channel: PickChannel): Float32Array | null;
}

/** Channels that alter projected hit geometry; color channels never affect picking. */
export type PickChannel = Exclude<Channel, 'vertexColor' | 'edgeColor'>;

/** Whether a channel change can move or hide pickable geometry. */
export function isPickChannel(channel: Channel): channel is PickChannel {
  return channel !== 'vertexColor' && channel !== 'edgeColor';
}

/** One screen-space pick request against the current scene. */
export interface PickQuery {
  /** Cursor in CSS px within the canvas. */
  readonly sx: number;
  readonly sy: number;
  /** Pick target radius in CSS px. */
  readonly radiusPx: number;
  /** CSS viewport of the canvas. */
  readonly vp: Viewport;
  /** Whether vertices are eligible for this query. */
  readonly vertices: boolean;
  /** Whether edges are eligible for this query. */
  readonly edges: boolean;
  /** Whether height poles are eligible for this query. */
  readonly poles: boolean;
}

export type PickResult = readonly [kind: 'vertex' | 'edge', index: number];

/** Package-private item anchor with surface visibility retained for reveal policy. */
export interface LocatedItem {
  readonly point: readonly [number, number];
  readonly visible: boolean;
}

/**
 * Largest screen overhang of any pickable primitive around its anchor:
 * vertex radius cap times the size-channel multiplier cap.
 */
const BILLBOARD_PAD_PX = VISUAL.maxVertexRadiusPx * VISUAL.vertexSizeMaxMul;
/**
 * Headroom on the sampled screen-to-coord Jacobian for curvature between
 * sample points. The brute-force parity property test polices this.
 */
const JACOBIAN_SAFETY = 1.5;
/**
 * Extra headroom on the height-shell pad.
 *
 * The anisotropy ratio is sampled at the pick reach but the shell walk
 * extends beyond it, where grazing stretch keeps growing. Also policed by
 * the property test.
 */
const HEIGHT_PAD_SAFETY = 2;
/** Jacobian probe distance in CSS px. */
const PROBE_PX = 4;
/**
 * Anisotropy cap for the height-shell pad.
 *
 * Past this the pose is degenerate (grazing horizon) and the query falls
 * back to covering the scene.
 */
const JACOBIAN_RATIO_CAP = 64;
/** Binary-search steps when the cursor unprojects off the surface. */
const SEED_SEARCH_STEPS = 18;
/**
 * Hull stretch beyond which one bounding circle gives way to a walk of
 * minor-radius circles along the major axis.
 */
const ELLIPSE_THRESHOLD = 4;
/**
 * Cap on walked circles.
 *
 * A footprint stretched past this covers so much of the scene that a full
 * scan is cheaper than the walk's overhead.
 */
const ELLIPSE_MAX_STEPS = 64;

/** Coord-space circle used to enumerate grid candidates. */
interface QueryCircle {
  /** Circle center x in topology coord space. */
  readonly x: number;
  /** Circle center y in topology coord space. */
  readonly y: number;
  /** Circle radius in topology coord units. */
  readonly r: number;
}

/** Static topology and coord-space acceleration data used by exact picking. */
interface Scene {
  /** Number of vertices in `coords`. */
  readonly vertexCount: number;
  /** Number of encoded segment records. */
  readonly segmentCount: number;
  /** Interleaved topology coordinates as x/y pairs. */
  readonly coords: Float32Array;
  /** Validated segment views shared with the renderer's prepared scene. */
  readonly seg: DecodedSegments;
  /** Topology coordinate bounds. */
  readonly bounds: Bounds;
  /** Diagonal extent used as the full-scene query radius. */
  readonly extent: number;
  /** Periodic x span, or 0 for non-wrapping coordinate spaces. */
  readonly wrapX: number;
  /** Coord-space grid over vertices. */
  readonly vertexGrid: Grid;
  /** Coord-space grid over segment records. */
  readonly segmentGrid: Grid;
}

/**
 * Synchronous CPU picker over a static coord-space index.
 *
 * The scene (vertex grid + segment grid over the encoded wire blobs) builds
 * once per topology; camera motion never touches it. A pick unprojects the
 * cursor, derives a conservative coord-space radius from a numerically
 * sampled screen-to-coord Jacobian, enumerates grid candidates, and runs
 * exact screen-space tests that mirror the render shaders: LOD floor, size
 * multipliers, height displacement, pole capsules, dash gaps, positive-w
 * clipping, horizon visibility, and vertex-beats-edge ranking.
 */
export class Picker {
  private scene: Scene | null = null;
  private readonly projectors = new Map<ProjectionFamily, Projector>();
  private readonly f32: Float32Array;
  private readonly u32: Uint32Array;

  // Scratch for exact tests; a pick allocates nothing.
  private readonly pA = createPoint();
  private readonly pB = createPoint();
  private readonly pM = createPoint();

  /** Create a picker bound to live render dependencies. */
  constructor(private readonly deps: PickerDeps) {
    this.f32 = deps.uniforms.rawF32;
    this.u32 = deps.uniforms.rawU32;
  }

  /**
   * Build static picking indices without replacing the active scene.
   *
   * This is the fallible half of scene replacement; callers commit the result
   * only once every other scene resource is ready.
   */
  prepareScene(scene: PreparedScene): Scene {
    const { info, coords, segments } = scene;
    const { bounds, vertexCount } = info;
    const { segmentCount } = segments.info;
    const wrapX = isGeoBounds(bounds) ? 360 : 0;
    return {
      vertexCount,
      segmentCount,
      coords,
      seg: segments,
      bounds,
      extent: Math.hypot(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin) || 1,
      wrapX,
      vertexGrid: Grid.points(coords, vertexCount, bounds),
      segmentGrid: Grid.segments(
        segments.f32,
        segments.recordsOffset,
        SEGMENT_RECORD_WORDS,
        4,
        6,
        segmentCount,
        bounds,
        wrapX,
      ),
    };
  }

  /** Replace (or clear) the active scene; never throws. */
  commitScene(scene: Scene | null): void {
    this.scene = scene;
  }

  /** Best hit under the cursor; a vertex beats any edge. */
  pick(q: PickQuery): PickResult | null {
    const r = this.query(q);
    return r.vertex ?? r.edge;
  }

  /** Best vertex then best edge; the contract tap-cycling relies on. */
  pickAll(q: PickQuery): PickResult[] {
    const r = this.query(q);
    const hits: PickResult[] = [];
    if (r.vertex) hits.push(r.vertex);
    if (r.edge) hits.push(r.edge);
    return hits;
  }

  /**
   * Project one item to a stable CSS-pixel anchor in the supplied viewport.
   *
   * This deliberately ignores display visibility and occlusion. Edges prefer
   * the visible point nearest the viewport center, then fall back to the
   * nearest projectable point when the entire edge is occluded.
   */
  locate(item: PickResult, vp: Viewport): readonly [number, number] | null {
    return this.locateDetail(item, vp)?.point ?? null;
  }

  /** Project one item and retain whether its chosen anchor is on the visible surface. */
  locateDetail(item: PickResult, vp: Viewport): LocatedItem | null {
    const scene = this.scene;
    if (!scene || !Number.isFinite(vp.w) || !Number.isFinite(vp.h) || vp.w <= 0 || vp.h <= 0) {
      return null;
    }

    const deviceW = this.f32[W_VIEWPORT_X]!;
    const deviceH = this.f32[W_VIEWPORT_Y]!;
    if (!Number.isFinite(deviceW) || !Number.isFinite(deviceH) || deviceW <= 0 || deviceH <= 0) {
      return null;
    }

    const [kind, id] = item;
    if (!Number.isInteger(id) || id < 0) return null;
    const proj = this.projector(this.deps.mode());
    const heights = this.u32[W_V_HEIGHT_MODE] !== 0 ? this.deps.values('vertexHeight') : null;
    const dprX = deviceW / vp.w;
    const dprY = deviceH / vp.h;

    if (kind === 'vertex') {
      if (id >= scene.vertexCount) return null;
      const p = this.pA;
      proj.project(
        p,
        scene.coords[id * 2]!,
        scene.coords[id * 2 + 1]!,
        this.normHeight(heights, id),
      );
      if (p.cw <= MIN_CLIP_W) return null;
      proj.toScreen(p);
      const x = p.sx / dprX;
      const y = p.sy / dprY;
      return Number.isFinite(x) && Number.isFinite(y)
        ? { point: [x, y], visible: proj.visible(p) }
        : null;
    }

    if (kind !== 'edge' || id >= scene.seg.info.edgeCount) return null;
    const { edgeStarts, f32, u32, recordsOffset } = scene.seg;
    const start = edgeStarts[id]!;
    const end = edgeStarts[id + 1]!;
    let visibleScore = Infinity;
    let visibleX = 0;
    let visibleY = 0;
    let fallbackScore = Infinity;
    let fallbackX = 0;
    let fallbackY = 0;

    for (let segment = start; segment < end; segment++) {
      const base = recordsOffset + segment * SEGMENT_RECORD_WORDS;
      const from = u32[base + 1]!;
      const to = u32[base + 2]!;
      const tPack = u32[base + 3]!;
      const ta = (tPack & 0xffff) / 0xffff;
      const tb = (tPack >>> 16) / 0xffff;
      const hFrom = this.normHeight(heights, from);
      const hTo = this.normHeight(heights, to);
      const A = this.pA;
      const B = this.pB;
      proj.project(A, f32[base + 4]!, f32[base + 5]!, hFrom + (hTo - hFrom) * ta);
      proj.project(B, f32[base + 6]!, f32[base + 7]!, hFrom + (hTo - hFrom) * tb);
      if (!clipPositiveW(A, B)) continue;
      proj.toScreen(A);
      proj.toScreen(B);

      const abx = B.sx - A.sx;
      const aby = B.sy - A.sy;
      const len2 = abx * abx + aby * aby;
      const t =
        len2 > 1e-6
          ? clamp01(((deviceW / 2 - A.sx) * abx + (deviceH / 2 - A.sy) * aby) / len2)
          : 0.5;
      const x = A.sx + abx * t;
      const y = A.sy + aby * t;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const score = (x - deviceW / 2) ** 2 + (y - deviceH / 2) ** 2;
      if (score < fallbackScore) {
        fallbackScore = score;
        fallbackX = x;
        fallbackY = y;
      }

      const M = this.pM;
      mixPoint(M, A, B, t);
      if (proj.visible(M) && score < visibleScore) {
        visibleScore = score;
        visibleX = x;
        visibleY = y;
      }
    }

    if (visibleScore < Infinity) {
      return { point: [visibleX / dprX, visibleY / dprY], visible: true };
    }
    return fallbackScore < Infinity
      ? { point: [fallbackX / dprX, fallbackY / dprY], visible: false }
      : null;
  }

  // Query core.

  /** Run one query and return independently ranked best vertex and edge hits. */
  private query(q: PickQuery): { vertex: PickResult | null; edge: PickResult | null } {
    const scene = this.scene;
    const miss = { vertex: null, edge: null };
    if (!scene || q.vp.w <= 0 || q.vp.h <= 0) return miss;
    if (this.f32[W_VIEWPORT_X]! <= 0 || this.f32[W_VIEWPORT_Y]! <= 0) return miss;

    const proj = this.projector(this.deps.mode());

    // Device-px cursor and radius (uniform viewport is device px).
    const dprX = this.f32[W_VIEWPORT_X]! / q.vp.w;
    const dprY = this.f32[W_VIEWPORT_Y]! / q.vp.h;
    const backingScale = this.f32[W_BACKING_SCALE]!;
    const cursorX = q.sx * dprX;
    const cursorY = q.sy * dprY;
    const radiusDev = Math.max(1, q.radiusPx * Math.max(dprX, dprY));

    const region = this.queryRegion(q, scene, proj);
    if (!region) return miss;

    const itemFlags = this.u32[W_ITEM_FLAGS]!;
    const heights = this.u32[W_V_HEIGHT_MODE] !== 0 ? this.deps.values('vertexHeight') : null;
    const sizes = this.u32[W_V_SIZE_MODE] !== 0 ? this.deps.values('vertexSize') : null;
    const dashes = this.f32[W_DASH_PERIOD]! > 0 ? this.deps.values('edgeDash') : null;
    const vertexVisible =
      itemFlags & ITEM_VERTEX_VISIBLE ? this.deps.values('vertexVisible') : null;
    const edgeVisible = itemFlags & ITEM_EDGE_VISIBLE ? this.deps.values('edgeVisible') : null;
    // The globe always packs full depth, so one uniform read covers both
    // families - no per-mode dispatch.
    const poles = q.poles && heights !== null && this.f32[W_DEPTH_MIX]! > 0;

    const state: TestState = {
      proj,
      scene,
      cursorX,
      cursorY,
      radiusDev,
      heights,
      sizes,
      dashes,
      vertexVisible,
      edgeVisible,
      vertices: q.vertices,
      poles,
      lod: this.f32[W_VERTEX_LOD]! * backingScale,
      dashPeriod: this.f32[W_DASH_PERIOD]! * backingScale,
      baseEdgeWidth: this.f32[W_BASE_EDGE_WIDTH]!,
      bestVertexD2: Infinity,
      bestVertexId: -1,
      bestEdgeD2: Infinity,
      bestEdgeId: -1,
    };

    // Grid stamps dedupe within one circle; across circles the min-tracking
    // accept functions make repeats idempotent. A region that covers the
    // scene (the horizon-band worst case) scans ids directly: same exact
    // tests, none of the cell-enumeration overhead.
    if (region.length === 1 && region[0]!.r >= scene.extent) {
      if (q.vertices || poles) {
        for (let id = 0; id < scene.vertexCount; id++) this.testVertex(state, id);
      }
      if (q.edges) {
        for (let id = 0; id < scene.segmentCount; id++) this.testSegment(state, id);
      }
    } else {
      const testVertex = (id: number): void => this.testVertex(state, id);
      const testSegment = (id: number): void => this.testSegment(state, id);
      for (const circle of region) {
        for (const cx of this.seamMirrors(scene, circle.x, circle.r)) {
          if (q.vertices || poles) scene.vertexGrid.each(cx, circle.y, circle.r, testVertex);
          if (q.edges) scene.segmentGrid.each(cx, circle.y, circle.r, testSegment);
        }
      }
    }

    return {
      vertex: state.bestVertexId >= 0 ? ['vertex', state.bestVertexId] : null,
      edge: state.bestEdgeId >= 0 ? ['edge', state.bestEdgeId] : null,
    };
  }

  /** Coord-space query circles covering everything whose projection can
   *  land within the pick radius, or null when nothing can (cursor far off
   *  the surface). Strongly anisotropic footprints, such as grazing tilt or
   *  the globe's limb, walk small circles along the stretched axis instead
   *  of inflating one bounding circle to the whole scene. Degenerate poses
   *  clamp to the scene extent; the grid then degrades to a full scan,
   *  which stays exact. */
  private queryRegion(q: PickQuery, scene: Scene, proj: Projector): readonly QueryCircle[] | null {
    const { vp } = q;
    let sx = q.sx;
    let sy = q.sy;
    let reachPx =
      q.radiusPx +
      BILLBOARD_PAD_PX /
        Math.min(this.f32[W_VIEWPORT_X]! / vp.w, this.f32[W_VIEWPORT_Y]! / vp.h, 1);

    const heightsActive = this.f32[W_DEPTH_MIX]! > 0 && this.u32[W_V_HEIGHT_MODE] !== 0;
    let seed = this.deps.unproject(sx, sy, vp);
    if (!seed) {
      // Cursor is off the surface (above tilt's horizon / off the globe).
      // Find the nearest on-surface point; beyond the pick reach nothing can
      // be hit unless heights are bound, where lifted geometry can
      // overhang the surface's screen footprint, so the padded query below
      // must run regardless.
      const found = this.seedNearSurface(sx, sy, vp);
      if (!found) return this.coverAll(scene);
      if (!heightsActive && found.offPx > reachPx) return null;
      sx = found.sx;
      sy = found.sy;
      seed = found.seed;
      reachPx += found.offPx;
    }

    // Sample the screen-to-coord map at the probe distance and at the full
    // pick reach in the four screen directions, keeping the coord-space
    // delta vectors (short probes normalized up to the reach). The vector
    // hull bounds the footprint; perspective stretch toward the horizon
    // makes it strongly anisotropic. When a probe falls off the surface
    // because the seed sits against the horizon rim, retry once from a point
    // pushed toward the viewport center, widening the reach by the push;
    // past that the footprint genuinely reaches the horizon and only a
    // full scan is conservative.
    const vecs: [number, number][] = [];
    let jacMax = 0;
    let jacMin = Infinity;
    const cx = vp.w / 2;
    const cy = vp.h / 2;
    for (let attempt = 0; ; attempt++) {
      vecs.length = 0;
      let probesOk = true;
      for (const d of [PROBE_PX, reachPx]) {
        for (const [dx, dy] of [
          [d, 0],
          [-d, 0],
          [0, d],
          [0, -d],
        ] as const) {
          const p = this.deps.unproject(sx + dx, sy + dy, vp);
          if (!p) {
            probesOk = false;
            break;
          }
          const vx = wrapDelta(p[0] - seed[0], scene.wrapX) * (reachPx / d);
          const vy = (p[1] - seed[1]) * (reachPx / d);
          vecs.push([vx, vy]);
          const w = Math.hypot(vx, vy) / reachPx;
          if (w > jacMax) jacMax = w;
          if (w > 0 && w < jacMin) jacMin = w;
        }
        if (!probesOk) break;
      }
      if (probesOk) break;
      if (attempt >= 1) return this.coverAll(scene);
      const away = Math.hypot(cx - sx, cy - sy);
      if (away < 1) return this.coverAll(scene);
      const push = Math.min(reachPx * 2, away);
      sx += ((cx - sx) / away) * push;
      sy += ((cy - sy) / away) * push;
      const pushed = this.deps.unproject(sx, sy, vp);
      if (!pushed) return this.coverAll(scene);
      seed = pushed;
      reachPx += push;
      jacMax = 0;
      jacMin = Infinity;
    }
    if (!(jacMax > 0) || !Number.isFinite(jacMax)) return this.coverAll(scene);

    // Height displacement widens the footprint: walking the cursor ray up
    // the height shell moves its surface intersection by up to
    // h / tan(elevation) in coord space, and the sampled anisotropy ratio
    // bounds 1 / sin(elevation) from above. The projector owns the
    // world-to-coord conversion (tilt: coord units faded by depth blend;
    // globe: radial units to surface degrees). Flat pays nothing.
    let pad = 0;
    if (heightsActive) {
      const outMin = this.f32[W_HEIGHT_OUT_MIN]!;
      const outScale = this.f32[W_HEIGHT_OUT_SCALE]!;
      const maxAbsH = Math.max(Math.abs(outMin), Math.abs(outMin + outScale));
      const hCoord = maxAbsH * this.f32[W_HEIGHT_WORLD_SCALE]! * proj.heightPadScale();
      const ratio = jacMin > 0 ? jacMax / jacMin : Infinity;
      if (!(ratio <= JACOBIAN_RATIO_CAP)) return this.coverAll(scene);
      pad = hCoord * ratio * HEIGHT_PAD_SAFETY;
    }

    return this.circlesForHull(scene, seed[0], seed[1], vecs, pad);
  }

  /** Cover the probe-vector hull around the seed with query circles. Nearly
   *  isotropic hulls get one circle; stretched hulls walk minor-radius
   *  circles along the major axis (asymmetric because grazing stretch is
   *  one-sided), so the enumerated area tracks the true footprint instead
   *  of its bounding circle. */
  private circlesForHull(
    scene: Scene,
    x: number,
    y: number,
    vecs: readonly (readonly [number, number])[],
    pad: number,
  ): readonly QueryCircle[] {
    let major = 0;
    let mx = 0;
    let my = 0;
    for (const [vx, vy] of vecs) {
      const len = Math.hypot(vx, vy);
      if (len > major) {
        major = len;
        mx = vx / len;
        my = vy / len;
      }
    }

    let along = 0; // farthest reach with the major direction
    let against = 0; // farthest reach opposing it
    let minor = 0; // farthest reach perpendicular to it
    for (const [vx, vy] of vecs) {
      const a = vx * mx + vy * my;
      const p = Math.abs(vx * -my + vy * mx);
      along = Math.max(along, a);
      against = Math.max(against, -a);
      minor = Math.max(minor, p);
    }
    along = along * JACOBIAN_SAFETY + pad;
    against = against * JACOBIAN_SAFETY + pad;
    minor = minor * JACOBIAN_SAFETY + pad;

    const bounding = Math.max(along, against);
    if (!Number.isFinite(bounding) || bounding > scene.extent) return [this.coverAllCircle(scene)];
    if (bounding <= minor * ELLIPSE_THRESHOLD) {
      return [{ x, y, r: bounding }];
    }

    const steps = Math.ceil((along + against) / minor);
    if (steps > ELLIPSE_MAX_STEPS) return [this.coverAllCircle(scene)];
    const circles: QueryCircle[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = -against + ((along + against) * i) / steps;
      circles.push({ x: x + mx * t, y: y + my * t, r: minor * 1.5 });
    }
    return circles;
  }

  /** Return the full-scene fallback as a one-circle query region. */
  private coverAll(scene: Scene): readonly QueryCircle[] {
    return [this.coverAllCircle(scene)];
  }

  /** Build a coord-space circle large enough to enumerate the whole scene. */
  private coverAllCircle(scene: Scene): QueryCircle {
    return {
      x: (scene.bounds.xMin + scene.bounds.xMax) / 2,
      y: (scene.bounds.yMin + scene.bounds.yMax) / 2,
      r: scene.extent,
    };
  }

  /** Nearest on-surface screen point to an off-surface cursor. Probes
   *  toward the viewport center (the radial nearest direction for the
   *  globe's centered disc) and straight down the screen (the nearest
   *  direction to tilt's horizontal horizon), keeping the closer boundary
   *  so the off-distance never overstates the true gap. */
  private seedNearSurface(
    sx: number,
    sy: number,
    vp: Viewport,
  ): { sx: number; sy: number; seed: readonly [number, number]; offPx: number } | null {
    let best: { sx: number; sy: number; seed: readonly [number, number]; offPx: number } | null =
      null;
    const targets: readonly (readonly [number, number])[] = [
      [vp.w / 2, vp.h / 2],
      [sx, vp.h],
    ];
    for (const [tx, ty] of targets) {
      if (!this.deps.unproject(tx, ty, vp)) continue;
      let lo = 0; // off-surface end
      let hi = 1; // on-surface end
      for (let i = 0; i < SEED_SEARCH_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (this.deps.unproject(sx + (tx - sx) * mid, sy + (ty - sy) * mid, vp)) hi = mid;
        else lo = mid;
      }
      const bx = sx + (tx - sx) * hi;
      const by = sy + (ty - sy) * hi;
      const seed = this.deps.unproject(bx, by, vp);
      if (!seed) continue;
      const offPx = Math.hypot(bx - sx, by - sy);
      if (!best || offPx < best.offPx) best = { sx: bx, sy: by, seed, offPx };
    }
    return best;
  }

  /** Yield x positions needed to query a circle across a periodic seam. */
  private *seamMirrors(scene: Scene, x: number, r: number): Generator<number> {
    yield x;
    if (scene.wrapX <= 0) return;
    const half = scene.wrapX / 2;
    if (x - r < -half) yield x + scene.wrapX;
    if (x + r > half) yield x - scene.wrapX;
  }

  /** Return the cached per-family projector over the live uniform buffer. */
  private projector(mode: Projection): Projector {
    const family = PROJECTION_DEFS[mode].family;
    let proj = this.projectors.get(family);
    if (!proj) {
      proj = PIPELINES[family].projector(this.deps.uniforms);
      this.projectors.set(family, proj);
    }
    return proj;
  }

  // Exact tests (mirror the render shaders in device px).

  /** Decode normalized vertex height in the same range the shader uses. */
  private normHeight(heights: Float32Array | null, vi: number): number {
    if (!heights) return 0;
    const t = clamp01((heights[vi]! - this.f32[W_HEIGHT_CENTER]!) * this.f32[W_HEIGHT_SCALE]!);
    return this.f32[W_HEIGHT_OUT_MIN]! + t * this.f32[W_HEIGHT_OUT_SCALE]!;
  }

  /** Decode per-vertex size multiplier, or 1 when the channel is unbound. */
  private sizeScale(state: TestState, vi: number): number {
    const sizes = state.sizes;
    if (!sizes) return 1;
    const t = clamp01((sizes[vi]! - this.f32[W_V_SIZE_MIN]!) * this.f32[W_V_SIZE_SCALE]!);
    return VISUAL.vertexSizeMinMul + (VISUAL.vertexSizeMaxMul - VISUAL.vertexSizeMinMul) * t;
  }

  /** Test one vertex billboard and optional height pole against the cursor. */
  private testVertex(state: TestState, id: number): void {
    if (state.vertexVisible && !(state.vertexVisible[id]! > 0)) return;
    const x = state.scene.coords[id * 2]!;
    const y = state.scene.coords[id * 2 + 1]!;
    const h = this.normHeight(state.heights, id);

    if (state.vertices) {
      const p = this.pA;
      state.proj.project(p, x, y, h);
      if (state.proj.visible(p)) {
        const radius = state.proj.screenRadius(p) * this.sizeScale(state, id);
        if (radius >= state.lod) {
          state.proj.toScreen(p);
          const dx = state.cursorX - p.sx;
          const dy = state.cursorY - p.sy;
          const d2 = dx * dx + dy * dy;
          const limit = state.radiusDev + radius;
          if (d2 <= limit * limit) acceptVertex(state, id, d2);
        }
      }
    }

    if (state.poles && Math.abs(h) > 1e-6) {
      const base = this.pA;
      const tip = this.pB;
      state.proj.project(base, x, y, 0);
      state.proj.project(tip, x, y, h);
      if (base.cw <= MIN_CLIP_W || tip.cw <= MIN_CLIP_W) return;
      if (!state.proj.visible(tip)) return;
      state.proj.toScreen(base);
      state.proj.toScreen(tip);
      const d2 = pointSegmentD2(state.cursorX, state.cursorY, base.sx, base.sy, tip.sx, tip.sy);
      const limit = state.radiusDev + state.proj.poleHalfWidth(base);
      if (d2 <= limit * limit) acceptVertex(state, id, d2);
    }
  }

  /** Test one encoded segment against the cursor in device-pixel space. */
  private testSegment(state: TestState, id: number): void {
    const { u32, f32, recordsOffset } = state.scene.seg;
    const base = recordsOffset + id * SEGMENT_RECORD_WORDS;
    const edgeId = u32[base]!;
    if (state.edgeVisible && !(state.edgeVisible[edgeId]! > 0)) return;
    const from = u32[base + 1]!;
    const to = u32[base + 2]!;
    const tPack = u32[base + 3]!;
    const ta = (tPack & 0xffff) / 0xffff;
    const tb = (tPack >>> 16) / 0xffff;

    const hFrom = this.normHeight(state.heights, from);
    const hTo = this.normHeight(state.heights, to);

    const A = this.pA;
    const B = this.pB;
    state.proj.project(A, f32[base + 4]!, f32[base + 5]!, hFrom + (hTo - hFrom) * ta);
    state.proj.project(B, f32[base + 6]!, f32[base + 7]!, hFrom + (hTo - hFrom) * tb);

    if (!clipPositiveW(A, B)) return;
    state.proj.toScreen(A);
    state.proj.toScreen(B);

    const abx = B.sx - A.sx;
    const aby = B.sy - A.sy;
    const len2 = Math.max(abx * abx + aby * aby, 1e-6);
    const t = clamp01(((state.cursorX - A.sx) * abx + (state.cursorY - A.sy) * aby) / len2);
    const qx = A.sx + abx * t;
    const qy = A.sy + aby * t;
    const dx = state.cursorX - qx;
    const dy = state.cursorY - qy;
    const d2 = dx * dx + dy * dy;

    const M = this.pM;
    mixPoint(M, A, B, t);
    if (!state.proj.visible(M)) return;

    if (state.dashPeriod > 0 && state.dashes && state.dashes[edgeId]! < 0.5) {
      const lenPx = Math.sqrt(len2);
      const phase = (t * lenPx) / state.dashPeriod;
      if (phase - Math.floor(phase) > 0.5) return;
    }

    mixPoint(M, A, B, 0.5);
    const limit = state.radiusDev + state.proj.screenHalfWidth(M, state.baseEdgeWidth);
    if (d2 <= limit * limit) acceptEdge(state, edgeId, d2);
  }
}

/** Mutable scratch state shared by exact primitive tests during one query. */
interface TestState {
  /** Projection mirror for the active render mode. */
  readonly proj: Projector;
  /** Static scene and coord-space indices. */
  readonly scene: Scene;
  /** Cursor x in device px. */
  readonly cursorX: number;
  /** Cursor y in device px. */
  readonly cursorY: number;
  /** Pick target radius in device px. */
  readonly radiusDev: number;
  /** Bound raw vertex-height channel values, if enabled. */
  readonly heights: Float32Array | null;
  /** Bound raw vertex-size channel values, if enabled. */
  readonly sizes: Float32Array | null;
  /** Bound raw edge-dash channel values, if enabled. */
  readonly dashes: Float32Array | null;
  /** Bound raw per-vertex visibility values, if enabled. */
  readonly vertexVisible: Float32Array | null;
  /** Bound raw per-edge visibility values, if enabled. */
  readonly edgeVisible: Float32Array | null;
  /** Whether vertex billboards are eligible. */
  readonly vertices: boolean;
  /** Whether height poles are eligible. */
  readonly poles: boolean;
  /** Vertex radius LOD floor in device px. */
  readonly lod: number;
  /** Dash period in device px; non-positive values disable dash rejection. */
  readonly dashPeriod: number;
  /** Base edge width in world or flat units, before projection scaling. */
  readonly baseEdgeWidth: number;
  /** Best vertex squared distance in device px. */
  bestVertexD2: number;
  /** Best vertex index, or -1 before any hit. */
  bestVertexId: number;
  /** Best edge squared distance in device px. */
  bestEdgeD2: number;
  /** Best edge id, or -1 before any hit. */
  bestEdgeId: number;
}

/** Same ranking as the compute reduce: lower score wins, lower id ties. */
function acceptVertex(state: TestState, id: number, d2: number): void {
  if (d2 < state.bestVertexD2 || (d2 === state.bestVertexD2 && id < state.bestVertexId)) {
    state.bestVertexD2 = d2;
    state.bestVertexId = id;
  }
}

/** Same edge ranking as the compute reduce: lower score wins, lower id ties. */
function acceptEdge(state: TestState, id: number, d2: number): void {
  if (d2 < state.bestEdgeD2 || (d2 === state.bestEdgeD2 && id < state.bestEdgeId)) {
    state.bestEdgeD2 = d2;
    state.bestEdgeId = id;
  }
}

/**
 * Mirror of clip_segment_positive_w: reject when both endpoints sit at or
 * behind the clip floor, else pull the failing endpoint onto it. The two
 * branches are mutually exclusive (the both-behind case already returned),
 * so clipping in place is safe.
 */
function clipPositiveW(a: ProjectedPoint, b: ProjectedPoint): boolean {
  const aw = a.cw;
  const bw = b.cw;
  if (aw <= MIN_CLIP_W && bw <= MIN_CLIP_W) return false;
  if (aw <= MIN_CLIP_W) {
    mixPoint(a, a, b, clamp01((MIN_CLIP_W - aw) / Math.max(bw - aw, 1e-6)));
  } else if (bw <= MIN_CLIP_W) {
    mixPoint(b, a, b, clamp01((MIN_CLIP_W - aw) / Math.min(bw - aw, -1e-6)));
  }
  return true;
}

/** Squared distance from a point to a screen-space segment in device px. */
function pointSegmentD2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = Math.max(abx * abx + aby * aby, 1e-6);
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / len2);
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}

/** Signed x delta folded to the shortest span across a periodic seam. */
function wrapDelta(dx: number, wrapX: number): number {
  if (wrapX <= 0) return dx;
  if (dx > wrapX / 2) return dx - wrapX;
  if (dx < -wrapX / 2) return dx + wrapX;
  return dx;
}

/** Whether bounds look like longitude/latitude degrees and should wrap at 360. */
function isGeoBounds(b: Bounds): boolean {
  return b.xMin >= -180 && b.xMax <= 180 && b.yMin >= -90 && b.yMax <= 90;
}

/** Clamp a scalar to [0, 1]. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
