import { describe, expect, it } from 'vitest';

import segmentsSrc from '../src/shaders/common/segment-buffer.wgsl?raw';
import {
  decodeSegments,
  encodeSegments,
  readEdgeSegmentStarts,
  readEncodedSegmentsInfo,
  type EncodedSegments,
} from '../src/segments/index.js';
import { encodeTopology, prepareTopology, readEncodedTopologyInfo } from '../src/topology/index.js';
import {
  HEADER_WORDS,
  MAGIC,
  SEGMENT_RECORD_WORDS,
  SEGMENT_SPHERE_ENDPOINT_WORDS,
  W,
  WGSL_LAYOUT,
} from '../src/segments/wire.js';
import { sampleTopology } from './fixtures/topology.js';

describe('EncodedSegments', () => {
  it('shares validated preparation with topology encoding', () => {
    const topology = sampleTopology();
    const prepared = prepareTopology(topology);
    const topologyInfo = readEncodedTopologyInfo(encodeTopology(prepared));
    const segmentsInfo = readEncodedSegmentsInfo(encodeSegments(prepared));

    expect(segmentsInfo.fingerprint).toBe(topologyInfo.fingerprint);
    expect(segmentsInfo.edgeCount).toBe(topologyInfo.edgeCount);
  });

  it('packs edge-major precomputed segment records', () => {
    const encoded = encodeSegments(sampleTopology());
    const words = new Uint32Array(encoded.buffer);
    const floats = new Float32Array(encoded.buffer);

    expect(words[W.magic]).toBe(MAGIC);
    expect(words[W.headerWords]).toBe(HEADER_WORDS);
    expect(words[W.storageBytes]).toBe(encoded.byteLength);
    expect(words[W.flags]).toBe(0);
    expect(words[W.vertexCount]).toBe(3);
    expect(words[W.edgeCount]).toBe(2);
    expect(words[W.segmentCount]).toBe(4);
    expect(words[W.fingerprint]).not.toBe(0);
    expect(words[W.edgeStarts]).toBe(HEADER_WORDS);
    expect(words[W.records]).toBe(HEADER_WORDS + 3);
    expect(words[W.sphereEndpoints]).toBe(HEADER_WORDS + 3 + 4 * SEGMENT_RECORD_WORDS);

    expect([...readEdgeSegmentStarts(encoded)]).toEqual([0, 1, 4]);

    const records = words[W.records]!;
    expect(words[records]).toBe(0);
    expect(words[records + 1]).toBe(0);
    expect(words[records + 2]).toBe(1);
    expect(unpackUnorm2x16(words[records + 3]!)).toEqual([0, 1]);
    expect(floats[records + 4]).toBe(0);
    expect(floats[records + 5]).toBe(0);
    expect(floats[records + 6]).toBe(10);
    expect(floats[records + 7]).toBe(0);

    const sphere = words[W.sphereEndpoints]!;
    expect(Array.from(floats.slice(sphere, sphere + SEGMENT_SPHERE_ENDPOINT_WORDS), snap)).toEqual(
      [1, 0, 0, Math.cos((10 * Math.PI) / 180), 0, -Math.sin((10 * Math.PI) / 180)].map(snap),
    );

    const third = records + 2 * SEGMENT_RECORD_WORDS;
    expect(words[third]).toBe(1);
    expect(words[third + 1]).toBe(1);
    expect(words[third + 2]).toBe(2);
    expect(unpackUnorm2x16(words[third + 3]!)).toEqual([1 / 3, 2 / 3]);
    expect(floats[third + 4]).toBe(12);
    expect(floats[third + 5]).toBe(2);
    expect(floats[third + 6]).toBe(18);
    expect(floats[third + 7]).toBe(4);
  });

  it('reports counts from the encoded header', () => {
    const encoded = encodeSegments(sampleTopology());
    const words = new Uint32Array(encoded.buffer);
    const info = readEncodedSegmentsInfo(encoded);

    expect(info).toEqual({
      vertexCount: 3,
      edgeCount: 2,
      segmentCount: 4,
      fingerprint: words[W.fingerprint],
    });
  });

  it('decodes validated metadata and reusable views together', () => {
    const encoded = encodeSegments(sampleTopology());
    const decoded = decodeSegments(encoded);

    expect(decoded.encoded).toBe(encoded);
    expect(decoded.info).toMatchObject({
      vertexCount: 3,
      edgeCount: 2,
      segmentCount: 4,
    });
    expect(decoded.u32.buffer).toBe(encoded.buffer);
    expect(decoded.f32.buffer).toBe(encoded.buffer);
    expect([...decoded.edgeStarts]).toEqual([0, 1, 4]);
    expect(decoded.edgeStarts.buffer).not.toBe(encoded.buffer);
    expect(decoded.recordsOffset).toBe(decoded.u32[W.records]);
  });

  it('validates segment section offsets and starts', () => {
    const encoded = encodeSegments(sampleTopology());
    const corrupted = new Uint8Array(encoded) as EncodedSegments;
    const words = new Uint32Array(corrupted.buffer);
    words[words[W.edgeStarts]!] = 1;

    expect(() => readEncodedSegmentsInfo(corrupted)).toThrow(
      'segments edgeStarts must begin at zero',
    );
  });

  it('validates segment record edge ownership', () => {
    const corrupted = corruptSegments((words) => {
      const secondEdgeFirstRecord = words[W.records]! + SEGMENT_RECORD_WORDS;
      words[secondEdgeFirstRecord] = 0;
    });

    expect(() => readEncodedSegmentsInfo(corrupted)).toThrow('segments record edge mismatch');
  });

  it('validates segment record endpoint ranges', () => {
    const corrupted = corruptSegments((words) => {
      const records = words[W.records]!;
      words[records + 2] = 3;
    });

    expect(() => readEncodedSegmentsInfo(corrupted)).toThrow('segments endpoint out of range');
  });

  it('rejects segment sources with invalid endpoints or polyline order', () => {
    expect(() => encodeSegments(sampleTopology({ edges: new Uint32Array([0, 3, 1, 2]) }))).toThrow(
      'edge endpoint out of range',
    );

    expect(() =>
      encodeSegments(
        sampleTopology({
          polylineStart: new Uint32Array([0, 2, 1]),
          polylinePoints: new Float32Array([10, 1]),
        }),
      ),
    ).toThrow('polylineStart must be monotonic');
  });

  it('validates every segment section offset boundary', () => {
    expect(() =>
      readEncodedSegmentsInfo(
        corruptSegments((words) => {
          words[W.records] = words[W.records]! + 1;
        }),
      ),
    ).toThrow('invalid segments section offset: records');

    expect(() =>
      readEncodedSegmentsInfo(
        corruptSegments((words) => {
          words[W.sphereEndpoints] = words[W.sphereEndpoints]! + 1;
        }),
      ),
    ).toThrow('invalid segments section offset: sphereEndpoints');

    const truncated = truncateSegments();
    expect(() => readEncodedSegmentsInfo(truncated)).toThrow('segments trailing bytes mismatch');
  });

  it('uses the deterministic fallback ring layout for segment endpoints', () => {
    const encoded = encodeSegments(
      sampleTopology({
        vertexCoords: new Float32Array(0),
        edges: new Uint32Array([0, 1]),
        polylineStart: new Uint32Array([0, 0]),
        polylinePoints: new Float32Array(0),
      }),
    );
    const words = new Uint32Array(encoded.buffer);
    const floats = new Float32Array(encoded.buffer);
    const records = words[W.records]!;

    expect(floats[records + 4]).toBeCloseTo(1, 6);
    expect(floats[records + 5]).toBeCloseTo(0, 6);
    expect(floats[records + 6]).toBeCloseTo(-0.5, 6);
    expect(floats[records + 7]).toBeCloseTo(Math.sqrt(3) / 2, 6);
  });

  it('generates shader constants from the wire layout', () => {
    expect(segmentsSrc).toContain('@group(2) @binding(0)');
    expect(WGSL_LAYOUT).toContain('const SEG_RECORDS');
    expect(WGSL_LAYOUT).toContain('const SEG_SPHERE_ENDPOINTS');
    expect(WGSL_LAYOUT).toContain(`${SEGMENT_RECORD_WORDS}u`);
    expect(WGSL_LAYOUT).toContain(`${SEGMENT_SPHERE_ENDPOINT_WORDS}u`);
  });
});

function corruptSegments(mutator: (words: Uint32Array) => void): EncodedSegments {
  const encoded = encodeSegments(sampleTopology());
  const corrupted = new Uint8Array(encoded) as EncodedSegments;
  mutator(new Uint32Array(corrupted.buffer));
  return corrupted;
}

function truncateSegments(): EncodedSegments {
  const encoded = encodeSegments(sampleTopology());
  const truncated = new Uint8Array(
    encoded.buffer.slice(0, encoded.byteLength - 4),
  ) as EncodedSegments;
  new Uint32Array(truncated.buffer)[W.storageBytes] = truncated.byteLength;
  return truncated;
}

function unpackUnorm2x16(value: number): [number, number] {
  const lo = value & 0xffff;
  const hi = value >>> 16;
  return [snap(lo / 0xffff), snap(hi / 0xffff)];
}

function snap(value: number): number {
  const third = 1 / 3;
  if (Math.abs(value - third) < 1e-4) return third;
  if (Math.abs(value - 2 * third) < 1e-4) return 2 * third;
  return Math.abs(value) < 1e-6 ? 0 : Number(value.toFixed(6));
}
