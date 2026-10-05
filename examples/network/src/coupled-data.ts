import { appendData, createData, textColumn, type Schema } from '@latkit/model';
import { numeric, vector } from './source.js';

/** Synthetic history owned by this application, shared unchanged by both views. */
export function coupledData() {
  const side = 20,
    count = side * side,
    frames = 1201,
    step = 0.05;
  const index = { source: 'coupled-demo', type: 'Node', version: '1' };
  const edgeIndex = { ...index, type: 'Link' };
  const positions = new Float32Array(count * 2);
  const from: number[] = [],
    to: number[] = [];
  for (let row = 0; row < count; row++) {
    const x = row % side,
      y = Math.floor(row / side);
    positions[row * 2] = x;
    positions[row * 2 + 1] = y;
    if (x + 1 < side) {
      from.push(row);
      to.push(row + 1);
    }
    if (y + 1 < side) {
      from.push(row);
      to.push(row + side);
    }
  }
  const schema = {
    axis: { name: 'Time', unit: 's' },
    types: {
      Node: {
        fields: {
          position: { type: { kind: 'vector', size: 2, items: 'float32' } },
          signal: { type: 'float32', sampled: true },
        },
      },
      Link: {
        fields: {
          from: { type: { kind: 'reference', to: 'Node' } },
          to: { type: { kind: 'reference', to: 'Node' } },
        },
      },
    },
  } as const satisfies Schema;
  const rows = { kind: 'range', offset: 0, count } as const;
  const reference = (values: number[]) => ({
    kind: 'reference' as const,
    index,
    offset: 0,
    length: values.length,
    values: Uint32Array.from(values),
  });
  const topology = createData(schema, [
    {
      kind: 'rows',
      index,
      rows,
      ids: textColumn(Array.from({ length: count }, (_, i) => `Node ${i}`)),
      columns: { position: vector(positions) },
    },
    {
      kind: 'rows',
      index: edgeIndex,
      rows: { kind: 'range', offset: 0, count: from.length },
      columns: { from: reference(from), to: reference(to) },
    },
  ]);
  const coordinates = Float64Array.from({ length: frames }, (_, f) => f * step);
  const values = new Float32Array(frames * count);
  for (let frame = 0; frame < frames; frame++) {
    const t = coordinates[frame]!;
    for (let row = 0; row < count; row++) {
      const x = row % side,
        y = Math.floor(row / side);
      const wave = Math.sin(x * 0.37 + t * 1.3) * Math.cos(y * 0.31 - t * 0.7);
      values[frame * count + row] = 0.5 + 0.45 * wave;
    }
  }
  const data = appendData(topology, [
    {
      kind: 'samples',
      index,
      rows,
      firstFrame: 0,
      coordinates,
      columns: { signal: { ...numeric(values), frameStride: count, rowStride: 1 } },
    },
  ]);
  return { data, index, count, frames, duration: coordinates[frames - 1]!, edges: from.length };
}
