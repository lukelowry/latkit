import { describe, expect, it } from 'vitest';

import { prepareScene } from '../src/scene.js';
import { encodeSegments, type EncodedSegments } from '../src/segments/index.js';
import { W as SEG_W } from '../src/segments/wire.js';
import { encodeTopology, prepareTopology } from '../src/topology/index.js';
import { sampleTopology } from './fixtures/topology.js';

describe('PreparedScene', () => {
  it('validates once and exposes the reusable encoded views', () => {
    const prepared = prepareTopology(sampleTopology());
    const topology = encodeTopology(prepared);
    const encodedSegments = encodeSegments(prepared);

    const scene = prepareScene(topology, encodedSegments);

    expect(scene.topology).toBe(topology);
    expect(scene.segments.encoded).toBe(encodedSegments);
    expect(scene.info).toMatchObject({ vertexCount: 3, edgeCount: 2 });
    expect(scene.segments.info).toMatchObject({
      vertexCount: 3,
      edgeCount: 2,
      segmentCount: 4,
    });
    expect(scene.coords.buffer).toBe(topology.buffer);
    expect([...scene.coords]).toEqual([...prepared.vertexCoords]);
    expect(scene.segments.u32.buffer).toBe(encodedSegments.buffer);
    expect(scene.segments.f32.buffer).toBe(encodedSegments.buffer);
    expect([...scene.segments.edgeStarts]).toEqual([0, 1, 4]);
  });

  it('rejects topology and segment vertex-count mismatches', () => {
    const topology = sampleTopology();
    const encodedTopology = encodeTopology(topology);
    const encodedSegments = corruptSegments(topology, (words) => {
      words[SEG_W.vertexCount] = 99;
    });

    expect(() => prepareScene(encodedTopology, encodedSegments)).toThrow(
      'network segment vertex count does not match topology',
    );
  });

  it('rejects topology and segment edge-count mismatches', () => {
    const encodedTopology = encodeTopology(sampleTopology());
    const encodedSegments = encodeSegments(
      sampleTopology({
        edges: new Uint32Array([0, 1]),
        polylineStart: new Uint32Array([0, 0]),
        polylinePoints: new Float32Array(0),
      }),
    );

    expect(() => prepareScene(encodedTopology, encodedSegments)).toThrow(
      'network segment edge count does not match topology',
    );
  });

  it('rejects topology and segment fingerprint mismatches', () => {
    const topology = sampleTopology();
    const encodedTopology = encodeTopology(topology);
    const encodedSegments = corruptSegments(topology, (words) => {
      words[SEG_W.fingerprint] = (words[SEG_W.fingerprint]! ^ 0xffffffff) >>> 0;
    });

    expect(() => prepareScene(encodedTopology, encodedSegments)).toThrow(
      'network segment fingerprint does not match topology',
    );
  });
});

function corruptSegments(
  topology: ReturnType<typeof sampleTopology>,
  mutate: (words: Uint32Array) => void,
): EncodedSegments {
  const encoded = new Uint8Array(encodeSegments(topology)) as EncodedSegments;
  mutate(new Uint32Array(encoded.buffer));
  return encoded;
}
