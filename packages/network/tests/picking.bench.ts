import { bench, describe } from 'vitest';

import { createFlatProjection } from '../src/camera/flat.js';
import { createGlobeProjection } from '../src/camera/globe.js';
import { createTiltProjection } from '../src/camera/tilt.js';
import type { Projection, Viewport } from '../src/camera/projection.js';
import type { ProjectionMode } from '../src/projections.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import { Picker } from '../src/pick/picker.js';
import { encodeSegments } from '../src/segments/index.js';
import { encodeTopology, type Topology } from '../src/topology/index.js';

const VP: Viewport = { w: 1600, h: 900 };

/** ~500k vertices on a jittered grid, 1M edges to near neighbors — the
 *  synthetic stress case the picker must stay flat on. */
function stressTopology(scale: number): Topology {
  const cols = 830;
  const rows = 600;
  const vertexCount = cols * rows; // 498k
  const coords = new Float32Array(vertexCount * 2);
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      coords[i * 2] = ((c + rand() * 0.8) / cols - 0.5) * 2 * scale;
      coords[i * 2 + 1] = ((r + rand() * 0.8) / rows - 0.5) * 2 * scale * 0.6;
    }
  }
  const edges = new Uint32Array(vertexCount * 4);
  let e = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) {
        edges[e++] = i;
        edges[e++] = i + 1;
      }
      if (r + 1 < rows) {
        edges[e++] = i;
        edges[e++] = i + cols;
      }
    }
  }
  const edgeCount = e / 2;
  return {
    vertexCount,
    vertexCoords: coords,
    edges: edges.subarray(0, e),
    polylineStart: new Uint32Array(edgeCount + 1),
  };
}

interface Rig {
  picker: Picker;
  pick(sxOverride?: number, syOverride?: number): void;
}

function makeRig(
  mode: ProjectionMode,
  topology: Topology,
  encoded: ReturnType<typeof encodeTopology>,
  segments: ReturnType<typeof encodeSegments>,
  mutate?: (state: Float64Array) => void,
): Rig {
  const uniforms = createUniforms();
  const proj: Projection =
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
  mutate?.(state);
  proj.pack(state, uniforms.projection, VP);
  uniforms.frame.viewportX = VP.w;
  uniforms.frame.viewportY = VP.h;
  uniforms.geometry.vertexSize = (xMax - xMin) * 0.0005;
  uniforms.geometry.baseEdgeWidth = (xMax - xMin) * 0.0001;
  uniforms.geometry.vertexLod = 2;

  const picker = new Picker({
    uniforms,
    mode: () => mode,
    unproject: (sx, sy, vp) => proj.screenToWorld(state, sx, sy, vp),
    values: () => null,
  });
  picker.setScene(encoded, segments);

  // Rotate cursors so successive picks touch different grid regions.
  const cursors: [number, number][] = [];
  for (let i = 0; i < 32; i++) {
    cursors.push([100 + ((i * 47) % (VP.w - 200)), 80 + ((i * 31) % (VP.h - 160))]);
  }
  let at = 0;
  return {
    picker,
    pick(sxOverride, syOverride) {
      const [sx, sy] = cursors[at++ % cursors.length]!;
      picker.pick({
        sx: sxOverride ?? sx,
        sy: syOverride ?? sy,
        radiusPx: 10,
        vp: VP,
        vertices: true,
        edges: true,
        poles: false,
      });
    },
  };
}

const topology = stressTopology(500);
const encoded = encodeTopology(topology);
const segments = encodeSegments(topology);

describe('picking at 1M segments', () => {
  bench(
    'scene build (grids over 500k vertices + 1M segments)',
    () => {
      const picker = new Picker({
        uniforms: createUniforms(),
        mode: () => 'flat',
        unproject: () => [0, 0],
        values: () => null,
      });
      picker.setScene(encoded, segments);
    },
    { iterations: 5, warmupIterations: 1 },
  );

  {
    const rig = makeRig('flat', topology, encoded, segments);
    bench('flat pick at fit zoom (widest candidate sweep)', () => {
      rig.pick();
    });
  }
  {
    const rig = makeRig('flat', topology, encoded, segments, (s) => {
      s[2] = s[2]! * 64;
    });
    bench('flat pick zoomed in 64x', () => {
      rig.pick();
    });
  }
  {
    const rig = makeRig('tilt', topology, encoded, segments);
    bench('tilt pick at default pitch', () => {
      rig.pick();
    });
  }
  {
    const rig = makeRig('tilt', topology, encoded, segments, (s) => {
      s[3] = 85;
    });
    bench('tilt pick at grazing pitch', () => {
      rig.pick();
    });
  }
  {
    // Cursor pinned just below the horizon line at grazing pitch: the
    // footprint reaches past the horizon and the conservative region
    // degenerates to a full scan — the documented worst case.
    const rig = makeRig('tilt', topology, encoded, segments, (s) => {
      s[3] = 85;
    });
    const proj = createTiltProjection();
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
    state[3] = 85;
    let lo = 0;
    let hi = VP.h;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (proj.screenToWorld(state, VP.w / 2, mid, VP)) hi = mid;
      else lo = mid;
    }
    bench(
      'tilt pick in the horizon band (full-scan worst case)',
      () => {
        rig.pick(VP.w / 2, hi + 5);
      },
      { time: 1500 },
    );
  }
});

describe('picking at 1M segments (globe)', () => {
  const geo = stressTopology(60);
  const geoEncoded = encodeTopology(geo);
  const geoSegments = encodeSegments(geo);
  {
    const rig = makeRig('globe', geo, geoEncoded, geoSegments);
    bench('globe pick at fit zoom', () => {
      rig.pick();
    });
  }
  {
    const rig = makeRig('globe', geo, geoEncoded, geoSegments, (s) => {
      s[2] = 1.2;
    });
    bench('globe pick zoomed in', () => {
      rig.pick();
    });
  }
});
