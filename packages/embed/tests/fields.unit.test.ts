import { describe, expect, it } from 'vitest';

import type { NetworkData } from '../src/data/types.js';
import { fieldsFor } from '../src/view/fields.js';
import { networkDataWithFields, topology } from './fixtures.js';

describe('field catalog', () => {
  it('indexes fields by id and scope with finite extents', () => {
    const data = networkDataWithFields();
    const fields = fieldsFor(data);

    expect(fields.vertex.map((entry) => entry.field.id)).toEqual(['load', 'capacity']);
    expect(fields.edge.map((entry) => entry.field.id)).toEqual(['flow']);
    expect(fields.byId.get('load')?.extent).toEqual([10, 30]);
    expect(fields.byId.get('capacity')?.extent).toEqual([40, 80]);
    expect(fields.byId.get('flow')?.extent).toEqual([4, 8]);
  });

  it('returns the same catalog for the same decoded data', () => {
    const data = networkDataWithFields();
    expect(fieldsFor(data)).toBe(fieldsFor(data));
  });

  it('uses a null extent for an empty field', () => {
    const data: NetworkData = {
      topology: {
        ...topology(),
        vertexCount: 0,
        vertexCoords: new Float32Array(),
        edges: new Uint32Array(),
        polylineStart: new Uint32Array([0]),
      },
      fields: [
        {
          id: 'empty',
          label: 'Empty',
          scope: 'vertex',
          values: new Float32Array(),
        },
      ],
    };

    expect(fieldsFor(data).byId.get('empty')?.extent).toBeNull();
  });
});
