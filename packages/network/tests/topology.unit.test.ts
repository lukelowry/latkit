import { describe, expect, it } from 'vitest';

import topologySrc from '../src/shaders/common/topology-buffer.wgsl?raw';
import {
  W,
  encodeTopology,
  readEncodedTopologyInfo,
  validateTopology,
} from '../src/topology/index.js';
import { HEADER_WORDS, MAGIC, WGSL_LAYOUT } from '../src/topology/wire.js';
import { computeBounds, estimateCharacteristicLength, ringLayout } from '../src/topology/pack.js';
import { sampleTopology } from './fixtures/topology.js';

describe('Topology', () => {
  it('packs topology into the canonical numeric upload layout', () => {
    const topology = sampleTopology();
    const encoded = encodeTopology(topology);
    const words = new Uint32Array(encoded.buffer);

    expect(words[W.magic]).toBe(MAGIC);
    expect(words[W.headerWords]).toBe(HEADER_WORDS);
    expect(words[W.storageBytes]).toBe(encoded.byteLength);
    expect(words[W.flags]).toBe(0);
    expect(words[W.vCount]).toBe(3);
    expect(words[W.eCount]).toBe(2);
    expect(words[W.vCoords]).toBe(HEADER_WORDS);
    expect(words[W.vSphere]).toBe(HEADER_WORDS + topology.vertexCoords!.length);
    expect(words[W.fingerprint]).not.toBe(0);
    expect(encoded.byteLength).toBe(
      (HEADER_WORDS + topology.vertexCoords!.length + topology.vertexCount * 3) * 4,
    );

    const sphere = new Float32Array(
      encoded.buffer,
      words[W.vSphere]! * 4,
      topology.vertexCount * 3,
    );
    expect(Array.from(sphere.slice(0, 6), snap)).toEqual(
      [1, 0, 0, Math.cos((10 * Math.PI) / 180), 0, -Math.sin((10 * Math.PI) / 180)].map(snap),
    );

    expect('storage' in topology).toBe(false);
    expect('bounds' in topology).toBe(false);
    expect('characteristicLength' in topology).toBe(false);

    const info = readEncodedTopologyInfo(encoded);
    expect(info.vertexCount).toBe(3);
    expect(info.edgeCount).toBe(2);
    expect(info.fingerprint).toBe(words[W.fingerprint]);
    expect(info.bounds).toEqual(computeBounds(topology.vertexCoords!));
  });

  it('validates empty polyline sections without placeholder buffers', () => {
    const topology = sampleTopology({
      polylineStart: new Uint32Array([0, 0, 0]),
      polylinePoints: new Float32Array(0),
    });
    const encoded = encodeTopology(topology);
    const info = readEncodedTopologyInfo(encoded);

    expect(encoded.byteLength).toBeGreaterThan(0);
    expect(info.edgeCount).toBe(2);
  });

  it('preserves the metric helpers used by camera setup in the encoded header', () => {
    const topology = sampleTopology();
    const info = readEncodedTopologyInfo(encodeTopology(topology));
    const bounds = computeBounds(topology.vertexCoords!);

    expect(info.bounds).toEqual(bounds);
    expect(info.characteristicLength).toBeCloseTo(
      estimateCharacteristicLength(topology.vertexCount, bounds),
      6,
    );
  });

  it('keeps canonical fit bounds vertex-only when edge bends cross the antimeridian', () => {
    const topology = sampleTopology({
      vertexCoords: new Float32Array([170, -5, 175, 5, 179, 0]),
      polylinePoints: new Float32Array([181, -2, -179, 2]),
    });
    const info = readEncodedTopologyInfo(encodeTopology(topology));
    const vertexBounds = computeBounds(topology.vertexCoords!);

    expect(info.bounds).toEqual(vertexBounds);
    expect(info.characteristicLength).toBeCloseTo(
      estimateCharacteristicLength(topology.vertexCount, vertexBounds),
      6,
    );
  });

  it('copies SharedArrayBuffer-backed parsed input into owned encoded storage', () => {
    const shared = new SharedArrayBuffer(24);
    const vertexCoords = new Float32Array(shared);
    vertexCoords.set([0, 0, 10, 0, 20, 0]);

    const encoded = encodeTopology(sampleTopology({ vertexCoords }));

    expect(encoded.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('synthesizes a unit-radius ring layout when parsed input has no coords', () => {
    const encoded = encodeTopology(sampleTopology({ vertexCoords: new Float32Array(0) }));
    const words = new Uint32Array(encoded.buffer);
    const coords = new Float32Array(encoded.buffer, words[W.vCoords]! * 4, 6);

    expect(coords.length).toBe(6);
    expect(coords[0]).toBeCloseTo(1, 6);
    expect(coords[1]).toBeCloseTo(0, 6);
  });

  it('validates topology without encoding renderer storage', () => {
    expect(() => validateTopology(sampleTopology())).not.toThrow();
    expect(() => validateTopology(sampleTopology({ edges: new Uint32Array([0, 1, 2]) }))).toThrow(
      'invalid edge length',
    );
    expect(() =>
      validateTopology(sampleTopology({ vertexCoords: new Float32Array([0, 0, NaN, 1, 2, 2]) })),
    ).toThrow('invalid vertex coordinates');
    expect(() =>
      validateTopology(sampleTopology({ edges: [0, 1] as unknown as Uint32Array })),
    ).toThrow('edges must be Uint32Array');
  });

  it('places fallback vertices on a deterministic unit ring', () => {
    expect([...ringLayout(0)]).toEqual([]);
    expect([...ringLayout(1)]).toEqual([0, 0]);
    expect(Array.from(ringLayout(4), snap)).toEqual([1, 0, 0, 1, -1, 0, 0, -1]);
  });

  it('rejects mismatched vertex coordinates', () => {
    expect(() =>
      encodeTopology(sampleTopology({ vertexCoords: new Float32Array([0, 0]) })),
    ).toThrow('invalid vertex coordinate length');
  });

  it('rejects edge endpoints outside the vertex range', () => {
    expect(() => encodeTopology(sampleTopology({ edges: new Uint32Array([0, 3, 1, 2]) }))).toThrow(
      'edge endpoint out of range',
    );
  });

  it('rejects odd-length polyline point buffers', () => {
    expect(() =>
      encodeTopology(
        sampleTopology({
          polylineStart: new Uint32Array([0, 1, 1]),
          polylinePoints: new Float32Array([10, 1, 11]),
        }),
      ),
    ).toThrow('invalid polyline point length');
  });

  it('generates shader constants from the wire layout', () => {
    expect(topologySrc).not.toContain('TOPO_');
    expect(WGSL_LAYOUT).toContain('const V_COORDS');
    expect(WGSL_LAYOUT).toContain('const V_SPHERE');
    expect(WGSL_LAYOUT).toContain(`${W.vCoords}u`);
    expect(WGSL_LAYOUT).toContain(`${W.vSphere}u`);
  });
});

function snap(value: number): number {
  return Math.abs(value) < 1e-6 ? 0 : Number(value.toFixed(6));
}
