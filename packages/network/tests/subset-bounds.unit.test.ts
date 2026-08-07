import { describe, expect, it } from 'vitest';

import { boundsForItems, expandDegenerateBounds } from '../src/topology/subset-bounds.js';
import type { Topology } from '../src/topology/index.js';
import { sampleTopology } from './fixtures/topology.js';

describe('subset topology bounds', () => {
  it('deduplicates valid items and ignores stale identities', () => {
    const topology = sampleTopology();

    expect(
      boundsForItems(
        topology,
        [
          { kind: 'vertex', index: 1 },
          { kind: 'vertex', index: 1 },
          { kind: 'vertex', index: -1 },
          { kind: 'edge', index: 99 },
        ],
        null,
      ),
    ).toEqual({ xMin: 10, xMax: 10, yMin: 0, yMax: 0 });
    expect(boundsForItems(topology, [], null)).toBeNull();
  });

  it('includes edge endpoints and every polyline bend point', () => {
    const topology = sampleTopology({
      polylinePoints: new Float32Array([-30, -5, 40, 25]),
    });

    expect(boundsForItems(topology, [{ kind: 'edge', index: 1 }], null)).toEqual({
      xMin: -30,
      xMax: 40,
      yMin: -5,
      yMax: 25,
    });
  });

  it('unwraps antimeridian edges while planar bounds retain raw longitudes', () => {
    const topology: Topology = {
      vertexCount: 2,
      vertexCoords: new Float32Array([179, 5, -179, 7]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    };

    const globe = boundsForItems(topology, [{ kind: 'edge', index: 0 }], 0)!;
    expect(globe.xMax - globe.xMin).toBeCloseTo(2);
    expect(Math.abs((globe.xMin + globe.xMax) / 2)).toBeCloseTo(180);
    expect(boundsForItems(topology, [{ kind: 'edge', index: 0 }], null)).toEqual({
      xMin: -179,
      xMax: 179,
      yMin: 5,
      yMax: 7,
    });
  });

  it('finds the same minimum globe arc regardless of item order', () => {
    const topology: Topology = {
      vertexCount: 3,
      vertexCoords: new Float32Array([-180, 1, 0, 2, 90, 3]),
      edges: new Uint32Array(0),
      polylineStart: new Uint32Array([0]),
    };
    const forward = boundsForItems(
      topology,
      [
        { kind: 'vertex', index: 0 },
        { kind: 'vertex', index: 1 },
        { kind: 'vertex', index: 2 },
      ],
      0,
    );
    const reverse = boundsForItems(
      topology,
      [
        { kind: 'vertex', index: 2 },
        { kind: 'vertex', index: 1 },
        { kind: 'vertex', index: 0 },
      ],
      0,
    );

    expect(forward).toEqual({ xMin: 0, xMax: 180, yMin: 1, yMax: 3 });
    expect(reverse).toEqual(forward);
  });

  it('retains a long edge path instead of minimizing only its point set', () => {
    const topology: Topology = {
      vertexCount: 2,
      vertexCoords: new Float32Array([0, 0, -20, 0]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 1]),
      polylinePoints: new Float32Array([170, 0]),
    };

    const bounds = boundsForItems(topology, [{ kind: 'edge', index: 0 }], 0)!;
    expect(bounds.xMax - bounds.xMin).toBeCloseTo(340);
  });

  it('expands degenerate axes with one span derived from the full extent', () => {
    expect(
      expandDegenerateBounds(
        { xMin: 5, xMax: 5, yMin: 6, yMax: 6 },
        { xMin: 0, xMax: 100, yMin: 0, yMax: 20 },
        10,
      ),
    ).toEqual({ xMin: 0, xMax: 10, yMin: 1, yMax: 11 });
  });

  it('leaves already non-degenerate bounds untouched', () => {
    const bounds = { xMin: 5, xMax: 5.001, yMin: 6, yMax: 6.001 };
    expect(expandDegenerateBounds(bounds, { xMin: 0, xMax: 100, yMin: 0, yMax: 20 }, 10)).toBe(
      bounds,
    );
  });
});
