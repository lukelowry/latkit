import { createModel, type Model, type RunUpdate, type Source, sourceOf } from '@latkit/model';

/** A two-bus, one-line model whose class data loads lazily. */
export function fixture(name = 'Fixture'): Model {
  return createModel(
    {
      vendor: 'test',
      id: 'fixture',
      name,
      meta: {},
      topology: {
        vertexCount: 2,
        edges: Uint32Array.of(0, 1),
        polylineStart: Uint32Array.of(0, 0),
      },
      owners: { vertex: 'bus', edge: 'line' },
      classes: [
        {
          id: 'bus',
          label: 'Bus',
          count: 2,
          signals: [{ id: 'Vm', label: 'Vm', unit: 'pu', recorded: true }],
        },
        { id: 'line', label: 'Line', count: 1, signals: [] },
      ],
    },
    {
      load: async (id) =>
        id === 'bus'
          ? {
              labels: ['Bus 1', 'Bus 2'],
              columns: [{ kind: 'number', id: 'kv', label: 'kV', values: Float64Array.of(1, 2) }],
            }
          : { labels: ['Line 1'], columns: [] },
      bytes: async () => new TextEncoder().encode(name),
    },
  );
}

/** A source over the fixture that records when it is closed. */
export function fixtureSource(name = 'Fixture', closed?: () => void): Source {
  return { ...sourceOf(fixture(name)), close: () => closed?.() };
}

export const FRAMES: RunUpdate = {
  type: 'frames',
  classId: 'bus',
  elementCount: 2,
  signalCount: 1,
  time: Float64Array.of(0.5),
  values: Float32Array.of(1, 2),
};

export async function collect(updates: AsyncIterable<RunUpdate>): Promise<RunUpdate[]> {
  const out: RunUpdate[] = [];
  for await (const update of updates) out.push(update);
  return out;
}
