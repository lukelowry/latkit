import {
  createData,
  textColumn,
  type Data,
  type DataBatch,
  type QueryBlock,
  type QueryHeader,
  type Schema,
} from '../src/index.js';
export const fixtureSchema: Schema = {
  limits: { maxBlockBytes: 65536 },
  axis: { name: 'time' },
  types: {
    Node: {
      fields: {
        value: { type: 'float64' },
        output: { type: 'float64', sampled: true },
        other: { type: 'float64', sampled: true },
      },
    },
  },
};
export function staticData(count = 4, pageRows = 4096): Data {
  const batches: DataBatch[] = [];
  for (let offset = 0; offset < count; offset += pageRows) {
    const n = Math.min(pageRows, count - offset);
    batches.push({
      kind: 'rows',
      index: { source: 'fixture', type: 'Node', version: 'rows1' },
      rows: { kind: 'range', offset, count: n },
      columns: {
        value: {
          kind: 'numeric',
          offset: 0,
          length: n,
          values: Float64Array.from({ length: n }, (_, i) => ((offset + i) % 1009) - 504),
        },
      },
      ...(count <= 10000
        ? { ids: textColumn(Array.from({ length: n }, (_, i) => 'n' + (offset + i))) }
        : {}),
    });
  }
  return createData(fixtureSchema, 'v1', batches);
}
export function sampledData(coordinates: readonly number[], count = 4): Data {
  return createData(
    fixtureSchema,
    'v1',
    coordinates.map((coordinate, frame) => ({
      kind: 'samples' as const,
      index: { source: 'fixture', type: 'Node', version: 'rows1' },
      rows: { kind: 'range' as const, offset: 0, count },
      firstFrame: frame,
      coordinates: Float64Array.of(coordinate),
      columns: {
        output: {
          kind: 'numeric' as const,
          offset: 0,
          length: count,
          values: Float64Array.from({ length: count }, (_, row) => coordinate + row + 1),
          rowStride: 1,
          frameStride: count,
        },
      },
    })),
  );
}
export async function collect<B extends QueryBlock>(
  stream: AsyncIterable<QueryHeader | B>,
): Promise<B[]> {
  const values: B[] = [];
  for await (const value of stream) if (value.kind !== 'schema') values.push(value as B);
  return values;
}
export function failure(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}
export function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
export async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
