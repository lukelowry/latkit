import { describe, expect, it } from 'vitest';

import { createGlobeProjection } from '../src/camera/globe.js';
import { createFlatProjection, createTiltProjection } from '../src/camera/plane.js';
import type { Projection, Viewport } from '../src/camera/projection.js';
import type { ProjectionMode } from '../src/projections.js';
import {
  createUniforms,
  ITEM_EDGE_VISIBLE,
  ITEM_VERTEX_VISIBLE,
  type Uniforms,
} from '../src/webgpu/uniforms.js';
import { Picker, type PickQuery, type PickResult } from '../src/pick/picker.js';
import { createPoint, mixPoint, projectorFor, MIN_CLIP_W } from '../src/pick/project.js';
import { prepareScene } from '../src/scene.js';
import { encodeSegments } from '../src/segments/index.js';
import { SEGMENT_RECORD_WORDS, W as SEG_W } from '../src/segments/wire.js';
import { encodeTopology, type Topology } from '../src/topology/index.js';
import { VISUAL } from '../src/visual.js';
import { mulberry32 } from './fixtures/random.js';

const VP: Viewport = { w: 800, h: 600 };

type PickChannel = 'vertexHeight' | 'vertexSize' | 'edgeDash' | 'vertexVisible' | 'edgeVisible';

interface Setup {
  readonly mode: ProjectionMode;
  readonly uniforms: Uniforms;
  readonly proj: Projection;
  readonly state: Float64Array;
  readonly picker: Picker;
  readonly topology: Topology;
  readonly segments: Uint8Array;
  readonly values: Map<PickChannel, Float32Array>;
  readonly dpr: number;
  pack(): void;
  screenAt(x: number, y: number, h?: number): { sx: number; sy: number };
  query(sx: number, sy: number, radiusPx?: number, flags?: Partial<PickQuery>): PickQuery;
}

function gridTopology(): Topology {
  // 5x5 vertex grid spaced 2 apart in [-4, 4]^2, edges right and down, plus
  // one polyline edge with two midpoints (multi-segment, height_t lerp).
  const coords: number[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) coords.push(col * 2 - 4, row * 2 - 4);
  }
  const edges: number[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const i = row * 5 + col;
      if (col < 4) edges.push(i, i + 1);
      if (row < 4) edges.push(i, i + 5);
    }
  }
  edges.push(0, 24);
  const edgeCount = edges.length / 2;
  const polylineStart = new Uint32Array(edgeCount + 1);
  polylineStart[edgeCount] = 2; // the last edge carries 2 midpoints
  return {
    vertexCount: 25,
    vertexCoords: new Float32Array(coords),
    edges: new Uint32Array(edges),
    polylineStart,
    polylinePoints: new Float32Array([-2, -1, 1, 2]),
  };
}

function makeSetup(
  mode: ProjectionMode,
  opts: {
    topology?: Topology;
    mutate?: (state: Float64Array) => void;
    dpr?: number;
  } = {},
): Setup {
  const topology = opts.topology ?? gridTopology();
  const uniforms = createUniforms();
  const proj =
    mode === 'flat'
      ? createFlatProjection()
      : mode === 'tilt'
        ? createTiltProjection()
        : createGlobeProjection();
  const coords = topology.vertexCoords!;
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity;
  for (let i = 0; i < topology.vertexCount; i++) {
    xMin = Math.min(xMin, coords[i * 2]!);
    xMax = Math.max(xMax, coords[i * 2]!);
    yMin = Math.min(yMin, coords[i * 2 + 1]!);
    yMax = Math.max(yMax, coords[i * 2 + 1]!);
  }
  const state = proj.fit({ xMin, xMax, yMin, yMax }, VP) as Float64Array;
  opts.mutate?.(state);

  const dpr = opts.dpr ?? 1;
  const values = new Map<PickChannel, Float32Array>();
  const pack = (): void => {
    proj.pack(state, uniforms.projection, VP);
    uniforms.frame.viewportX = VP.w * dpr;
    uniforms.frame.viewportY = VP.h * dpr;
    uniforms.frame.backingScale = dpr;
  };
  pack();
  uniforms.geometry.vertexSize = 0.2;
  uniforms.geometry.baseEdgeWidth = 0.05;
  uniforms.geometry.vertexLod = 2;

  const picker = new Picker({
    uniforms,
    mode: () => mode,
    unproject: (sx, sy, vp) => proj.screenToWorld(state, sx, sy, vp),
    values: (channel) => values.get(channel) ?? null,
  });
  const encoded = encodeTopology(topology);
  const segments = encodeSegments(topology);
  const scene = prepareScene(encoded, segments);
  picker.commitScene(picker.prepareScene(scene));

  const projector = projectorFor(mode, uniforms);
  return {
    mode,
    uniforms,
    proj,
    state,
    picker,
    topology,
    segments,
    values,
    dpr,
    pack,
    screenAt(x, y, h = 0) {
      const p = createPoint();
      projector.project(p, x, y, h);
      projector.toScreen(p);
      return { sx: p.sx / dpr, sy: p.sy / dpr };
    },
    query(sx, sy, radiusPx = 6, flags = {}) {
      return {
        sx,
        sy,
        radiusPx,
        vp: VP,
        vertices: true,
        edges: true,
        poles: false,
        ...flags,
      };
    },
  };
}

function bindHeights(
  s: Setup,
  raw: Float32Array,
  worldScale: number,
  outMin = 0,
  outScale = 1,
): void {
  s.values.set('vertexHeight', raw);
  s.uniforms.channel.vHeightMode = 1;
  s.uniforms.channel.heightCenter = 0;
  s.uniforms.channel.heightScale = 1;
  s.uniforms.channel.heightOutMin = outMin;
  s.uniforms.channel.heightOutScale = outScale;
  s.uniforms.geometry.heightWorldScale = worldScale;
}

function bindSizes(s: Setup, raw: Float32Array): void {
  s.values.set('vertexSize', raw);
  s.uniforms.channel.vSizeMode = 1;
  s.uniforms.channel.vSizeMin = 0;
  s.uniforms.channel.vSizeScale = 1;
}

function bindDash(s: Setup, raw: Float32Array): void {
  s.values.set('edgeDash', raw);
  s.uniforms.geometry.dashPeriod = 12;
}

function bindVertexVisibility(s: Setup, raw: Float32Array): void {
  s.values.set('vertexVisible', raw);
  s.uniforms.channel.itemFlags |= ITEM_VERTEX_VISIBLE;
}

function bindEdgeVisibility(s: Setup, raw: Float32Array): void {
  s.values.set('edgeVisible', raw);
  s.uniforms.channel.itemFlags |= ITEM_EDGE_VISIBLE;
}

// ── Brute-force oracle ──────────────────────────────────────────
// Independent reimplementation of the exact tests over every vertex and
// segment — no grid, no query region. The picker must agree with it exactly;
// any conservative-bound bug in the grid path fails here.

function oraclePick(
  s: Setup,
  q: PickQuery,
): { vertex: PickResult | null; edge: PickResult | null } {
  const u = s.uniforms;
  const projector = projectorFor(s.mode, u);
  const dprX = u.frame.viewportX / q.vp.w;
  const dprY = u.frame.viewportY / q.vp.h;
  const cursorX = q.sx * dprX;
  const cursorY = q.sy * dprY;
  const radiusDev = Math.max(1, q.radiusPx * Math.max(dprX, dprY));

  const heights = u.channel.vHeightMode !== 0 ? (s.values.get('vertexHeight') ?? null) : null;
  const sizes = u.channel.vSizeMode !== 0 ? (s.values.get('vertexSize') ?? null) : null;
  const dashes = u.geometry.dashPeriod > 0 ? (s.values.get('edgeDash') ?? null) : null;
  const vertexVisible =
    (u.channel.itemFlags & ITEM_VERTEX_VISIBLE) !== 0
      ? (s.values.get('vertexVisible') ?? null)
      : null;
  const edgeVisible =
    (u.channel.itemFlags & ITEM_EDGE_VISIBLE) !== 0 ? (s.values.get('edgeVisible') ?? null) : null;
  const poles = q.poles && heights !== null && s.mode !== 'flat';

  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const normHeight = (vi: number): number => {
    if (!heights) return 0;
    const t = clamp01((heights[vi]! - u.channel.heightCenter) * u.channel.heightScale);
    return u.channel.heightOutMin + t * u.channel.heightOutScale;
  };
  const sizeScale = (vi: number): number => {
    if (!sizes) return 1;
    const t = clamp01((sizes[vi]! - u.channel.vSizeMin) * u.channel.vSizeScale);
    return VISUAL.vertexSizeMinMul + (VISUAL.vertexSizeMaxMul - VISUAL.vertexSizeMinMul) * t;
  };

  let bestVertexD2 = Infinity,
    bestVertexId = -1;
  let bestEdgeD2 = Infinity,
    bestEdgeId = -1;
  const acceptVertex = (id: number, d2: number): void => {
    if (d2 < bestVertexD2 || (d2 === bestVertexD2 && id < bestVertexId)) {
      bestVertexD2 = d2;
      bestVertexId = id;
    }
  };
  const acceptEdge = (id: number, d2: number): void => {
    if (d2 < bestEdgeD2 || (d2 === bestEdgeD2 && id < bestEdgeId)) {
      bestEdgeD2 = d2;
      bestEdgeId = id;
    }
  };

  const segD2 = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): { d2: number; t: number; len2: number } => {
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = Math.max(abx * abx + aby * aby, 1e-6);
    const t = clamp01(((px - ax) * abx + (py - ay) * aby) / len2);
    const dx = px - (ax + abx * t);
    const dy = py - (ay + aby * t);
    return { d2: dx * dx + dy * dy, t, len2 };
  };

  const coords = s.topology.vertexCoords!;
  const A = createPoint(),
    B = createPoint(),
    M = createPoint();

  for (let id = 0; id < s.topology.vertexCount; id++) {
    if (vertexVisible && !(vertexVisible[id]! > 0)) continue;
    const x = coords[id * 2]!;
    const y = coords[id * 2 + 1]!;
    const h = normHeight(id);

    if (q.vertices) {
      projector.project(A, x, y, h);
      if (projector.visible(A)) {
        const radius = projector.screenRadius(A) * sizeScale(id);
        if (radius >= u.geometry.vertexLod * u.frame.backingScale) {
          projector.toScreen(A);
          const dx = cursorX - A.sx;
          const dy = cursorY - A.sy;
          const d2 = dx * dx + dy * dy;
          const limit = radiusDev + radius;
          if (d2 <= limit * limit) acceptVertex(id, d2);
        }
      }
    }

    if (poles && Math.abs(h) > 1e-6) {
      projector.project(A, x, y, 0);
      projector.project(B, x, y, h);
      if (A.cw > MIN_CLIP_W && B.cw > MIN_CLIP_W && projector.visible(B)) {
        projector.toScreen(A);
        projector.toScreen(B);
        const { d2 } = segD2(cursorX, cursorY, A.sx, A.sy, B.sx, B.sy);
        const limit = radiusDev + projector.poleHalfWidth(A);
        if (d2 <= limit * limit) acceptVertex(id, d2);
      }
    }
  }

  if (q.edges) {
    const segU32 = new Uint32Array(
      s.segments.buffer,
      s.segments.byteOffset,
      s.segments.byteLength / 4,
    );
    const segF32 = new Float32Array(
      s.segments.buffer,
      s.segments.byteOffset,
      s.segments.byteLength / 4,
    );
    const records = segU32[SEG_W.records]!;
    const count = segU32[SEG_W.segmentCount]!;
    for (let id = 0; id < count; id++) {
      const base = records + id * SEGMENT_RECORD_WORDS;
      const edgeId = segU32[base]!;
      if (edgeVisible && !(edgeVisible[edgeId]! > 0)) continue;
      const tPack = segU32[base + 3]!;
      const hFrom = normHeight(segU32[base + 1]!);
      const hTo = normHeight(segU32[base + 2]!);
      projector.project(
        A,
        segF32[base + 4]!,
        segF32[base + 5]!,
        hFrom + (hTo - hFrom) * ((tPack & 0xffff) / 0xffff),
      );
      projector.project(
        B,
        segF32[base + 6]!,
        segF32[base + 7]!,
        hFrom + (hTo - hFrom) * ((tPack >>> 16) / 0xffff),
      );

      if (A.cw <= MIN_CLIP_W && B.cw <= MIN_CLIP_W) continue;
      if (A.cw <= MIN_CLIP_W) {
        mixPoint(A, A, B, clamp01((MIN_CLIP_W - A.cw) / Math.max(B.cw - A.cw, 1e-6)));
      } else if (B.cw <= MIN_CLIP_W) {
        mixPoint(B, A, B, clamp01((MIN_CLIP_W - A.cw) / Math.min(B.cw - A.cw, -1e-6)));
      }
      projector.toScreen(A);
      projector.toScreen(B);

      const { d2, t, len2 } = segD2(cursorX, cursorY, A.sx, A.sy, B.sx, B.sy);
      mixPoint(M, A, B, t);
      if (!projector.visible(M)) continue;

      if (u.geometry.dashPeriod > 0 && dashes && dashes[edgeId]! < 0.5) {
        const phase = (t * Math.sqrt(len2)) / (u.geometry.dashPeriod * u.frame.backingScale);
        if (phase - Math.floor(phase) > 0.5) continue;
      }

      mixPoint(M, A, B, 0.5);
      const limit = radiusDev + projector.screenHalfWidth(M, u.geometry.baseEdgeWidth);
      if (d2 <= limit * limit) acceptEdge(edgeId, d2);
    }
  }

  return {
    vertex: bestVertexId >= 0 ? ['vertex', bestVertexId] : null,
    edge: bestEdgeId >= 0 ? ['edge', bestEdgeId] : null,
  };
}

// ── Behavior ────────────────────────────────────────────────────

describe('Picker behavior (flat)', () => {
  it('hits vertices at their projection, edges between them, nothing in the void', () => {
    const s = makeSetup('flat');
    const v12 = s.screenAt(0, 0); // vertex 12 sits at the grid center
    expect(s.picker.pick(s.query(v12.sx, v12.sy))).toEqual(['vertex', 12]);

    const mid = s.screenAt(1, 0); // midpoint of the horizontal edge 12-13
    const hit = s.picker.pick(s.query(mid.sx, mid.sy));
    expect(hit?.[0]).toBe('edge');

    expect(s.picker.pick(s.query(2, 2))).toBeNull();
  });

  it('prefers a vertex over an overlapping edge and returns both from pickAll', () => {
    const s = makeSetup('flat');
    const v = s.screenAt(0, 0);
    const all = s.picker.pickAll(s.query(v.sx, v.sy));
    expect(all[0]).toEqual(['vertex', 12]);
    expect(all[1]?.[0]).toBe('edge');
  });

  it('respects vertex/edge visibility flags', () => {
    const s = makeSetup('flat');
    const v = s.screenAt(0, 0);
    expect(s.picker.pick(s.query(v.sx, v.sy, 6, { vertices: false }))?.[0]).toBe('edge');
    expect(s.picker.pick(s.query(v.sx, v.sy, 6, { vertices: false, edges: false }))).toBeNull();
  });

  it('matches raw visibility thresholds while locate remains geometry-only', () => {
    const s = makeSetup('flat');
    const center = s.screenAt(0, 0);
    const vertexVisible = new Float32Array(25).fill(1);
    vertexVisible[12] = Number.NaN;
    bindVertexVisibility(s, vertexVisible);

    expect(s.picker.pick(s.query(center.sx, center.sy))?.[0]).toBe('edge');
    expect(s.picker.locate(['vertex', 12], VP)).not.toBeNull();

    const midpoint = s.screenAt(1, 0);
    const query = s.query(midpoint.sx, midpoint.sy, 1, { vertices: false });
    const edge = s.picker.pick(query);
    expect(edge?.[0]).toBe('edge');

    const edgeVisible = new Float32Array(s.topology.edges.length / 2).fill(1);
    edgeVisible[edge![1]] = 0;
    bindEdgeVisibility(s, edgeVisible);
    expect(s.picker.pick(query)).toBeNull();
  });

  it('drops vertices below the LOD floor while edges stay pickable', () => {
    const s = makeSetup('flat', {
      mutate: (state) => {
        state[2] = state[2]! / 100;
      }, // zoom far out
    });
    s.pack();
    const v = s.screenAt(0, 0);
    const hit = s.picker.pick(s.query(v.sx, v.sy, 4));
    expect(hit?.[0]).toBe('edge');
  });

  it('rejects picks in dash gaps and accepts them on solid stretches', () => {
    const s = makeSetup('flat');
    bindDash(s, new Float32Array(s.topology.edges.length / 2)); // all dashed

    const a = s.screenAt(0, 0);
    const b = s.screenAt(2, 0);
    const lenPx = Math.hypot(b.sx - a.sx, b.sy - a.sy);
    const period = 12;
    const solidT = (0.25 * period) / lenPx;
    const gapT = (0.75 * period) / lenPx;
    const at = (t: number): { sx: number; sy: number } => ({
      sx: a.sx + (b.sx - a.sx) * t,
      sy: a.sy + (b.sy - a.sy) * t,
    });

    const solid = at(solidT);
    const gap = at(gapT);
    expect(s.picker.pick(s.query(solid.sx, solid.sy, 1, { vertices: false }))?.[0]).toBe('edge');
    expect(s.picker.pick(s.query(gap.sx, gap.sy, 1, { vertices: false }))).toBeNull();
  });

  it('is orthographic: bound heights neither move geometry nor enable poles', () => {
    const s = makeSetup('flat');
    bindHeights(s, new Float32Array(25).fill(1), 5);

    const v = s.screenAt(0, 0); // undisplaced position
    expect(s.picker.pick(s.query(v.sx, v.sy))).toEqual(['vertex', 12]);
    // Poles are gated off in flat even when requested.
    const between = s.screenAt(0, 0.9);
    const hit = s.picker.pick(s.query(between.sx, between.sy, 2, { poles: true, edges: false }));
    expect(hit).toBeNull();
  });

  it('converts CSS px through a non-unit device pixel ratio', () => {
    const s = makeSetup('flat', { dpr: 2 });
    const v = s.screenAt(0, 0); // screenAt already divides by dpr
    expect(s.picker.pick(s.query(v.sx, v.sy))).toEqual(['vertex', 12]);
    const located = s.picker.locate(['vertex', 12], VP);
    expect(located?.[0]).toBeCloseTo(v.sx);
    expect(located?.[1]).toBeCloseTo(v.sy);
  });

  it('keeps capped billboard extent and LOD in CSS pixels at high DPR', () => {
    const s = makeSetup('flat', { dpr: 2 });
    s.uniforms.geometry.vertexSize = 100;
    const v = s.screenAt(0, 0);

    expect(
      s.picker.pick(
        s.query(v.sx + VISUAL.maxVertexRadiusPx - 0.25, v.sy, 0, {
          vertices: true,
          edges: false,
        }),
      ),
    ).toEqual(['vertex', 12]);
    // A zero-radius query still owns the deliberate one-device-pixel target
    // floor, which is 0.5 CSS px at DPR 2.
    expect(
      s.picker.pick(
        s.query(v.sx + VISUAL.maxVertexRadiusPx + 0.25, v.sy, 0, {
          vertices: true,
          edges: false,
        }),
      ),
    ).toEqual(['vertex', 12]);
    expect(
      s.picker.pick(
        s.query(v.sx + VISUAL.maxVertexRadiusPx + 0.75, v.sy, 0, {
          vertices: true,
          edges: false,
        }),
      ),
    ).toBeNull();

    s.uniforms.geometry.vertexLod = VISUAL.maxVertexRadiusPx + 0.25;
    expect(s.picker.pick(s.query(v.sx, v.sy, 0, { vertices: true, edges: false }))).toBeNull();
    s.uniforms.geometry.vertexLod = VISUAL.maxVertexRadiusPx - 0.25;
    expect(s.picker.pick(s.query(v.sx, v.sy, 0, { vertices: true, edges: false }))).toEqual([
      'vertex',
      12,
    ]);
  });

  it('locates a stable anchor on a multi-segment edge', () => {
    const s = makeSetup('flat');
    const edge = s.topology.edges.length / 2 - 1;
    const located = s.picker.locate(['edge', edge], VP);

    expect(located).not.toBeNull();
    expect(Number.isFinite(located![0])).toBe(true);
    expect(Number.isFinite(located![1])).toBe(true);
  });

  it('does not replace the active picker scene before commit', () => {
    const s = makeSetup('flat');
    const center = s.screenAt(0, 0);
    const query = s.query(center.sx, center.sy, 0, { edges: false });
    const topology: Topology = {
      vertexCount: 1,
      vertexCoords: new Float32Array([100, 100]),
      edges: new Uint32Array(0),
      polylineStart: new Uint32Array([0]),
    };
    const scene = prepareScene(encodeTopology(topology), encodeSegments(topology));

    const candidate = s.picker.prepareScene(scene);

    expect(s.picker.pick(query)).toEqual(['vertex', 12]);
    s.picker.commitScene(candidate);
    expect(s.picker.pick(query)).toBeNull();
  });

  it('rejects invalid locate requests and unavailable scenes', () => {
    const s = makeSetup('flat');
    const edgeCount = s.topology.edges.length / 2;

    expect(s.picker.locate(['vertex', 25], VP)).toBeNull();
    expect(s.picker.locate(['edge', edgeCount], VP)).toBeNull();
    expect(s.picker.locate(['vertex', -1], VP)).toBeNull();
    expect(s.picker.locate(['vertex', 1.5], VP)).toBeNull();
    expect(s.picker.locate(['vertex', 0], { w: 0, h: VP.h })).toBeNull();

    s.picker.commitScene(null);
    expect(s.picker.locate(['vertex', 0], VP)).toBeNull();
  });

  it('returns nothing before a scene is bound or after it is cleared', () => {
    const s = makeSetup('flat');
    s.picker.commitScene(null);
    expect(s.picker.pick(s.query(400, 300, 50))).toBeNull();
  });
});

describe('Picker behavior (tilt)', () => {
  it('picks height-displaced vertices at their lifted position', () => {
    const s = makeSetup('tilt');
    const heights = new Float32Array(25);
    heights[12] = 1;
    bindHeights(s, heights, 3);

    const lifted = s.screenAt(0, 0, 1);
    const base = s.screenAt(0, 0, 0);
    expect(Math.hypot(lifted.sx - base.sx, lifted.sy - base.sy)).toBeGreaterThan(20);
    expect(s.picker.pick(s.query(lifted.sx, lifted.sy, 4, { edges: false }))).toEqual([
      'vertex',
      12,
    ]);
    expect(s.picker.locate(['vertex', 12], VP)?.[0]).toBeCloseTo(lifted.sx);
    expect(s.picker.locate(['vertex', 12], VP)?.[1]).toBeCloseTo(lifted.sy);
  });

  it('picks poles along the base-to-tip column when enabled', () => {
    const s = makeSetup('tilt');
    const heights = new Float32Array(25);
    heights[12] = 1;
    bindHeights(s, heights, 3);

    const base = s.screenAt(0, 0, 0);
    const tip = s.screenAt(0, 0, 1);
    const mid = { sx: (base.sx + tip.sx) / 2, sy: (base.sy + tip.sy) / 2 };
    expect(
      s.picker.pick(s.query(mid.sx, mid.sy, 2, { poles: true, edges: false, vertices: false })),
    ).toEqual(['vertex', 12]);
    expect(
      s.picker.pick(s.query(mid.sx, mid.sy, 2, { poles: false, edges: false, vertices: false })),
    ).toBeNull();
  });
});

describe('Picker behavior (globe)', () => {
  it('never picks geometry behind the horizon', () => {
    const topology: Topology = {
      vertexCount: 2,
      vertexCoords: new Float32Array([0, 0, 179, 0]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    };
    // Camera over the near vertex, close enough that vertices clear the LOD
    // floor; the far vertex stays behind the horizon.
    const s = makeSetup('globe', {
      topology,
      mutate: (state) => {
        state[0] = 0;
        state[2] = 2;
      },
    });
    s.uniforms.geometry.vertexSize = 2;
    const near = s.screenAt(0, 0);
    expect(s.picker.pick(s.query(near.sx, near.sy, 8, { edges: false }))).toEqual(['vertex', 0]);
    expect(s.picker.locateDetail(['vertex', 0], VP)?.visible).toBe(true);

    // Nowhere on screen picks the far-side vertex.
    for (let gy = 0; gy < 10; gy++) {
      for (let gx = 0; gx < 10; gx++) {
        const hit = s.picker.pick(
          s.query(((gx + 0.5) * VP.w) / 10, ((gy + 0.5) * VP.h) / 10, 20, { edges: false }),
        );
        expect(hit).not.toEqual(['vertex', 1]);
      }
    }

    const far = s.screenAt(179, 0);
    expect(s.picker.locate(['vertex', 1], VP)?.[0]).toBeCloseTo(far.sx);
    expect(s.picker.locate(['vertex', 1], VP)?.[1]).toBeCloseTo(far.sy);
    expect(s.picker.locateDetail(['vertex', 1], VP)?.visible).toBe(false);
  });

  it('picks across the antimeridian seam', () => {
    const topology: Topology = {
      vertexCount: 2,
      vertexCoords: new Float32Array([179.5, 0, -179.5, 0]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    };
    const s = makeSetup('globe', {
      topology,
      mutate: (state) => {
        state[0] = 180;
        state[1] = 0;
        state[2] = 2;
      },
    });
    s.uniforms.geometry.vertexSize = 2;

    const west = s.screenAt(179.5, 0);
    const east = s.screenAt(-179.5, 0);
    expect(s.picker.pick(s.query(west.sx, west.sy, 6, { edges: false }))).toEqual(['vertex', 0]);
    expect(s.picker.pick(s.query(east.sx, east.sy, 6, { edges: false }))).toEqual(['vertex', 1]);

    const seamMid = s.screenAt(180, 0);
    expect(s.picker.pick(s.query(seamMid.sx, seamMid.sy, 6, { vertices: false }))).toEqual([
      'edge',
      0,
    ]);
  });
});

// ── Oracle property test ────────────────────────────────────────

describe('Picker matches the brute-force oracle', () => {
  function randomTopology(rand: () => number, geo: boolean): Topology {
    const vertexCount = 120;
    const span = geo ? 60 : 12;
    const coords = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      coords[i * 2] = (rand() * 2 - 1) * span;
      coords[i * 2 + 1] = (rand() * 2 - 1) * (geo ? 40 : span);
    }
    const edges: number[] = [];
    for (let i = 0; i < 180; i++) {
      const a = Math.floor(rand() * vertexCount);
      const b = (a + 1 + Math.floor(rand() * (vertexCount - 1))) % vertexCount;
      edges.push(a, b);
    }
    return {
      vertexCount,
      vertexCoords: coords,
      edges: new Uint32Array(edges),
      polylineStart: new Uint32Array(edges.length / 2 + 1),
    };
  }

  function posesFor(mode: ProjectionMode, rand: () => number): ((state: Float64Array) => void)[] {
    const jitter = (scale: number): number => (rand() * 2 - 1) * scale;
    return Array.from({ length: 8 }, (_, i) => (state: Float64Array): void => {
      if (mode === 'flat') {
        state[0] = state[0]! + jitter(6);
        state[1] = state[1]! + jitter(6);
        state[2] = state[2]! * Math.pow(2, jitter(2));
      } else if (mode === 'tilt') {
        state[0] = state[0]! + jitter(6);
        state[1] = state[1]! + jitter(6);
        state[2] = state[2]! * Math.pow(2, jitter(1.5));
        state[3] = i === 0 ? 0 : rand() * 85;
        state[4] = rand() * 360;
      } else {
        state[0] = state[0]! + jitter(50);
        state[1] = Math.max(-80, Math.min(80, state[1]! + jitter(40)));
        state[2] = 1.05 + rand() * 2;
      }
    });
  }

  for (const mode of ['flat', 'tilt', 'globe'] as const) {
    it(`agrees on ${mode} across random poses, cursors, and channels`, () => {
      const rand = mulberry32(mode === 'flat' ? 101 : mode === 'tilt' ? 202 : 303);
      const topology = randomTopology(rand, mode === 'globe');

      for (const [poseIndex, mutate] of posesFor(mode, rand).entries()) {
        const s = makeSetup(mode, { topology, mutate, dpr: (poseIndex % 3) + 1 });
        s.pack();

        // Alternate channel bindings across poses.
        if (poseIndex % 2 === 1) {
          const heights = new Float32Array(topology.vertexCount);
          for (let i = 0; i < heights.length; i++) heights[i] = rand();
          bindHeights(s, heights, mode === 'globe' ? 0.15 : 2, -0.5, 1.5);
        }
        if (poseIndex % 3 === 2) {
          const sizes = new Float32Array(topology.vertexCount);
          for (let i = 0; i < sizes.length; i++) sizes[i] = rand();
          bindSizes(s, sizes);
        }
        if (poseIndex % 4 === 3) {
          const dashes = new Float32Array(topology.edges.length / 2);
          for (let i = 0; i < dashes.length; i++) dashes[i] = rand() < 0.5 ? 0 : 1;
          bindDash(s, dashes);
        }
        if (poseIndex % 5 === 4) {
          const vertexVisible = new Float32Array(topology.vertexCount);
          for (let i = 0; i < vertexVisible.length; i++) vertexVisible[i] = rand() < 0.3 ? 0 : 1;
          bindVertexVisibility(s, vertexVisible);
          const edgeVisible = new Float32Array(topology.edges.length / 2);
          for (let i = 0; i < edgeVisible.length; i++) edgeVisible[i] = rand() < 0.3 ? 0 : 1;
          bindEdgeVisibility(s, edgeVisible);
        }

        for (let c = 0; c < 12; c++) {
          // Half the cursors aim near real geometry, half roam the viewport.
          let sx: number;
          let sy: number;
          if (c % 2 === 0) {
            const vi = Math.floor(rand() * topology.vertexCount);
            const at = s.screenAt(
              topology.vertexCoords![vi * 2]!,
              topology.vertexCoords![vi * 2 + 1]!,
            );
            sx = at.sx + (rand() * 2 - 1) * 15;
            sy = at.sy + (rand() * 2 - 1) * 15;
          } else {
            sx = rand() * VP.w;
            sy = rand() * VP.h;
          }
          if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

          const q = s.query(sx, sy, 4 + rand() * 12, {
            poles: s.values.has('vertexHeight'),
          });
          const expected = oraclePick(s, q);
          const label = `${mode} pose ${poseIndex} cursor (${sx.toFixed(1)}, ${sy.toFixed(1)})`;
          expect(s.picker.pick(q), label).toEqual(expected.vertex ?? expected.edge);
          expect(s.picker.pickAll(q), label).toEqual(
            [expected.vertex, expected.edge].filter((h): h is PickResult => h !== null),
          );
        }
      }
    });
  }
});
