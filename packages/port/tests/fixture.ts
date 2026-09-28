import { createModel, type Model, type RunUpdate } from '@latkit/model';

/** Let every queued microtask-delivered message land. */
export async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
}

/**
 * A two-bus, one-line model whose class data loads lazily; buses record their voltage. With `run`,
 * the model runs on it.
 */
export function fixture<Command = Uint8Array>(
  name = 'Fixture',
  run?: (command: Command, signal: AbortSignal) => AsyncIterable<RunUpdate>,
): Model<Command> {
  return createModel<Command>({
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
        columns: [{ kind: 'number', id: 'kv', label: 'kV' }],
        signals: [{ id: 'Vm', label: 'Vm', unit: 'pu', recorded: true }],
      },
      { id: 'line', label: 'Line', count: 1, columns: [], signals: [] },
    ],
    load: async (id) =>
      id === 'bus'
        ? { labels: ['Bus 1', 'Bus 2'], values: [Float64Array.of(1, 2)] }
        : { labels: ['Line 1'], values: [] },
    bytes: async () => new TextEncoder().encode(name),
    ...(run && { run }),
  });
}

/** `model`, its source replaced by what `source` makes of the model's own. */
export function withSource<Command>(
  model: Model<Command>,
  source: (own: ReturnType<Model<Command>['source']>) => ReturnType<Model<Command>['source']>,
): Model<Command> {
  return { ...model, source: () => source(model.source()) };
}

export const FRAMES: RunUpdate = {
  type: 'frames',
  time: Float64Array.of(0.5),
  values: { bus: Float32Array.of(1, 2) },
};

export async function collect(updates: AsyncIterable<RunUpdate>): Promise<RunUpdate[]> {
  const out: RunUpdate[] = [];
  for await (const update of updates) out.push(update);
  return out;
}
