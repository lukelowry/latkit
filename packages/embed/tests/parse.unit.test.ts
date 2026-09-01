import { describe, expect, it } from 'vitest';

import { parseNetwork } from '../src/index.js';

describe('parseNetwork', () => {
  it('parses plain arrays and supplies straight-edge offsets', () => {
    const coords = [-96, 30, -95, 31, -94, 30];
    const input = {
      ignored: 'future metadata',
      topology: {
        vertexCount: 3,
        vertexCoords: coords,
        edges: [0, 1, 1, 2],
        ignored: true,
      },
      labels: {
        vertex: ['Bus 1', 'Bus 2', 'Bus 3'],
      },
      fields: [
        {
          id: 'vm',
          label: 'Voltage',
          unit: 'pu',
          scope: 'vertex',
          values: [1.01, 0.99, 1.03],
          ignored: 1,
        },
        {
          id: 'x',
          label: 'Reactance',
          scope: 'edge',
          values: [0.011, 0.007],
        },
      ],
    };

    const data = parseNetwork(input);

    expect(data.topology.vertexCount).toBe(3);
    expect(data.topology.vertexCoords).toBeInstanceOf(Float32Array);
    expect(data.topology.vertexCoords).toEqual(Float32Array.from(coords));
    expect(data.topology.edges).toEqual(Uint32Array.from([0, 1, 1, 2]));
    expect(data.topology.polylineStart).toEqual(Uint32Array.from([0, 0, 0]));
    expect(data.topology.polylinePoints).toBeUndefined();
    expect(data.labels?.vertex).toEqual(['Bus 1', 'Bus 2', 'Bus 3']);
    expect(data.fields?.map((field) => [field.id, field.scope])).toEqual([
      ['vm', 'vertex'],
      ['x', 'edge'],
    ]);
    expect(data.fields?.[0]?.values).toEqual(Float32Array.from([1.01, 0.99, 1.03]));

    coords[0] = 0;
    expect(data.topology.vertexCoords?.[0]).toBe(-96);
  });

  it('decodes every numeric slot from little-endian base64', () => {
    const data = parseNetwork({
      topology: {
        vertexCount: 2,
        vertexCoords: f32Base64([-96.5, 30.25, -95.75, 31.5]),
        edges: u32Base64([0, 1]),
        polylineStart: u32Base64([0, 2]),
        polylinePoints: f32Base64([-96.25, 30.75, -96, 31]),
      },
      labels: {
        vertex: ['A', 'B'],
        edge: ['A to B'],
      },
      fields: [
        {
          id: 'load',
          label: 'Load',
          scope: 'vertex',
          values: f32Base64([0.25, 0.75]),
        },
      ],
    });

    expect(data.topology.vertexCoords).toEqual(Float32Array.from([-96.5, 30.25, -95.75, 31.5]));
    expect(data.topology.edges).toEqual(Uint32Array.from([0, 1]));
    expect(data.topology.polylineStart).toEqual(Uint32Array.from([0, 2]));
    expect(data.topology.polylinePoints).toEqual(Float32Array.from([-96.25, 30.75, -96, 31]));
    expect(data.fields?.[0]?.values).toEqual(Float32Array.from([0.25, 0.75]));
  });

  it('preserves omitted coordinates for the renderer-generated layout', () => {
    const data = parseNetwork({
      topology: {
        vertexCount: 2,
        edges: [0, 1],
      },
    });

    expect(data.topology.vertexCoords).toBeUndefined();
    expect(data.topology.polylineStart).toEqual(Uint32Array.from([0, 0]));
    expect(data.labels).toBeUndefined();
    expect(data.fields).toBeUndefined();
  });

  it('forwards the declared coordinate space and rejects unknown values', () => {
    const topology = {
      vertexCount: 2,
      vertexCoords: [0, 0, 10, 10],
      edges: [0, 1],
    };

    expect(parseNetwork({ topology }).topology.coordinateSpace).toBeUndefined();
    expect(
      parseNetwork({ topology: { ...topology, coordinateSpace: 'cartesian' } }).topology
        .coordinateSpace,
    ).toBe('cartesian');
    expect(
      parseNetwork({ topology: { ...topology, coordinateSpace: 'geographic' } }).topology
        .coordinateSpace,
    ).toBe('geographic');
    expect(() => parseNetwork({ topology: { ...topology, coordinateSpace: 'polar' } })).toThrow(
      'topology.coordinateSpace must be "cartesian" or "geographic"',
    );
  });

  it.each([
    ['a null root', null, 'root must be an object'],
    ['a missing topology', {}, 'root.topology is required'],
    [
      'a negative vertex count',
      document({ vertexCount: -1 }),
      'topology.vertexCount must be non-negative',
    ],
    [
      'a fractional vertex count',
      document({ vertexCount: 1.5 }),
      'topology.vertexCount must be an integer',
    ],
    ['an odd endpoint array', document({ edges: [0] }), 'topology.edges length must be even'],
    [
      'an out-of-range endpoint',
      document({ edges: [0, 2] }),
      'invalid network data: edge endpoint out of range',
    ],
    [
      'mismatched coordinates',
      document({ vertexCoords: [0, 0] }),
      'invalid network data: invalid vertex coordinate length',
    ],
    ['fractional u32 input', document({ edges: [0, 1.5] }), 'topology.edges[1] must be an integer'],
    [
      'negative u32 input',
      document({ edges: [0, -1] }),
      'topology.edges[1] is outside the u32 range',
    ],
    [
      'overflowing u32 input',
      document({ edges: [0, 0x1_0000_0000] }),
      'topology.edges[1] is outside the u32 range',
    ],
    [
      'non-finite numeric input',
      document({ vertexCoords: [0, 0, Infinity, 1] }),
      'topology.vertexCoords[2] must be a finite number',
    ],
    [
      'f32 overflow',
      document({ vertexCoords: [0, 0, 1e100, 1] }),
      'topology.vertexCoords[2] is outside the f32 range',
    ],
    [
      'an invalid offset length',
      document({ polylineStart: [0] }),
      'invalid network data: invalid polylineStart length',
    ],
    [
      'a nonzero first offset',
      document({ polylineStart: [1, 1] }),
      'invalid network data: polylineStart must begin at zero',
    ],
    [
      'non-monotonic offsets',
      document({
        edges: [0, 1, 1, 0],
        polylineStart: [0, 2, 1],
        polylinePoints: [0, 0],
      }),
      'invalid network data: polylineStart must be monotonic',
    ],
    [
      'an invalid terminal offset',
      document({ polylineStart: [0, 1] }),
      'invalid network data: polylineStart terminal mismatch',
    ],
  ])('rejects %s', (_name, input, error) => {
    expect(() => parseNetwork(input)).toThrow(error);
  });

  it.each([
    ['an invalid base64 string', { base64: '%' }, 'base64 is invalid'],
    ['a misaligned base64 value', { base64: btoa('abc') }, 'divisible by 4'],
    ['a non-string base64 value', { base64: 1 }, 'base64 must be a string'],
    ['a non-finite base64 f32', f32Base64([NaN, 1]), 'contains a non-finite f32'],
  ])('rejects %s', (_name, vertexCoords, error) => {
    expect(() => parseNetwork(document({ vertexCoords }))).toThrow(error);
  });

  it('rejects malformed labels', () => {
    expect(() =>
      parseNetwork({
        ...document(),
        labels: { vertex: ['only one'] },
      }),
    ).toThrow('vertex labels length 1 != 2');
    expect(() =>
      parseNetwork({
        ...document(),
        labels: { vertex: ['one', 2] },
      }),
    ).toThrow('labels.vertex[1] must be a string');
    expect(() =>
      parseNetwork({
        ...document(),
        labels: { edge: [] },
      }),
    ).toThrow('edge labels length 0 != 1');
  });

  it('rejects malformed and duplicate fields', () => {
    const field = {
      id: 'value',
      label: 'Value',
      scope: 'vertex',
      values: [0, 1],
    };

    expect(() => parseNetwork({ ...document(), fields: [{ ...field, id: ' ' }] })).toThrow(
      'field id must not be empty',
    );
    expect(() => parseNetwork({ ...document(), fields: [field, field] })).toThrow(
      'duplicate field id value',
    );
    expect(() => parseNetwork({ ...document(), fields: [{ ...field, scope: 'face' }] })).toThrow(
      'scope must be "vertex" or "edge"',
    );
    expect(() => parseNetwork({ ...document(), fields: [{ ...field, values: [0] }] })).toThrow(
      'field value values length 1 != 2',
    );
    expect(() => parseNetwork({ ...document(), fields: [{ ...field, values: [0, NaN] }] })).toThrow(
      'must be a finite number',
    );
  });
});

/** Minimal two-vertex, one-edge serialized topology with optional overrides. */
function document(topology: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topology: {
      vertexCount: 2,
      vertexCoords: [0, 0, 1, 1],
      edges: [0, 1],
      ...topology,
    },
  };
}

/** Encode f32 values as explicit little-endian base64. */
function f32Base64(values: readonly number[]): { base64: string } {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i]!, true);
  return { base64: encodeBase64(bytes) };
}

/** Encode u32 values as explicit little-endian base64. */
function u32Base64(values: readonly number[]): { base64: string } {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]!, true);
  return { base64: encodeBase64(bytes) };
}

/** Convert bytes to browser base64 without Node-only Buffer APIs. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
