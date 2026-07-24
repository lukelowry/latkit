import { describe, expect, it } from 'vitest';

import type { NetworkData } from '../src/index.js';
import { validateNetworkData } from '../src/data/validate.js';

describe('validateNetworkData', () => {
  it('accepts decoded static network data', () => {
    expect(() => validateNetworkData(data())).not.toThrow();
  });

  it('checks direct data with the same field and label rules as parsed input', () => {
    expect(() =>
      validateNetworkData(
        data({
          labels: { vertex: ['A', 2 as unknown as string] },
        }),
      ),
    ).toThrow('vertex labels must contain strings');
    expect(() =>
      validateNetworkData(
        data({
          fields: [
            {
              id: 'load',
              label: 'Load',
              scope: 'vertex',
              values: [0, 1] as unknown as Float32Array,
            },
          ],
        }),
      ),
    ).toThrow('field load values must be Float32Array');
  });
});

/** Minimal decoded network data with optional root overrides. */
function data(overrides: Partial<NetworkData> = {}): NetworkData {
  return {
    topology: {
      vertexCount: 2,
      vertexCoords: new Float32Array([0, 0, 1, 1]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    },
    ...overrides,
  };
}
