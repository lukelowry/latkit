import { describe } from 'vitest';
import { appendData, createData, createReader, read, selectBatches } from '@latkit/model';
import { batches, drain, frames, grid, schema, sizes, suite, voltages } from './harness.ts';

describe.each(sizes)('model %i buses', (buses) => {
  const data = grid(buses),
    input = batches(buses),
    next = voltages(buses, frames),
    reader = createReader({ maxBytes: 512 * 1024 ** 2 }),
    window = { kind: 'range', between: [0, frames - 1] } as const;
  const fields = () => {
    const scope = reader.open();
    return drain(scope.fields({ source: data, from: 'Bus', fields: { load: 'load' } })).finally(
      () => scope.close(),
    );
  };
  const measure = suite(`model ${buses} buses`, buses, () => reader.stats());
  measure('createData', () => createData(schema, input));
  measure('appendData frame', () => appendData(data, [next]));
  measure('read rows', () => drain(read(data, { kind: 'rows', from: 'Bus', select: ['load'] })));
  measure('read samples', () =>
    drain(read(data, { kind: 'samples', from: 'Bus', select: ['voltage'], window })),
  );
  measure('read envelope', () =>
    drain(read(data, { kind: 'envelope', from: 'Bus', select: ['voltage'], window, buckets: 8 })),
  );
  measure('selectBatches', () =>
    drain(selectBatches(data, [{ from: 'Bus', select: ['load', 'voltage'] }])),
  );
  measure('reader fields, cold', () => {
    reader.trim();
    return fields();
  });
  measure('reader fields, cached', fields);
  measure('reader extent', async () => {
    const scope = reader.open();
    try {
      return await scope.extent({ source: data, from: 'Bus', field: 'voltage', window });
    } finally {
      scope.close();
    }
  });
});
