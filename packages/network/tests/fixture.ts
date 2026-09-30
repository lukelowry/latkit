import type {
  Query,
  Queryable,
  QueryOptions,
  QueryHeader,
  QueryBlock,
  Schema,
  Update,
  Column,
  RowAxis,
} from '@latkit/model';
export class GraphSource implements Queryable {
  version = 'v0';
  readonly document: string;
  readonly listeners = new Set<(update: Update) => void>();
  queries = 0;
  linksQueries = 0;
  private readonly coordinates = new Map<string, Float64Array>();
  readonly positions: Float64Array;
  readonly from: Uint32Array;
  readonly to: Uint32Array;
  readonly weights: Float32Array;
  readonly schema: Schema;
  readonly observations: readonly Float32Array[];
  constructor(
    readonly count = 1000,
    readonly blockRows = 4096,
    readonly geographic = false,
  ) {
    this.document = 'fixture-' + count + '-' + geographic;
    this.positions = new Float64Array(count * 2);
    this.weights = new Float32Array(count);
    const width = Math.ceil(Math.sqrt(count)),
      offset = geographic ? 0 : 1e9;
    for (let i = 0; i < count; i++) {
      const x = i % width,
        y = Math.floor(i / width);
      this.positions[i * 2] = geographic
        ? -110 + (x / Math.max(1, width - 1)) * 90
        : offset + x * 10;
      this.positions[i * 2 + 1] = geographic
        ? -35 + (y / Math.max(1, width - 1)) * 85
        : offset + y * 10;
      this.weights[i] = (Math.sin(i * 0.73) + 1) / 2;
    }
    const pairs: number[] = [];
    for (let i = 0; i < count; i++) {
      if (i % width < width - 1 && i + 1 < count) pairs.push(i, i + 1);
      if (i + width < count) pairs.push(i, i + width);
    }
    this.from = new Uint32Array(pairs.length / 2);
    this.to = new Uint32Array(pairs.length / 2);
    for (let i = 0; i < this.from.length; i++) {
      this.from[i] = pairs[i * 2];
      this.to[i] = pairs[i * 2 + 1];
    }
    this.observations = Array.from({ length: 16 }, (_, f) =>
      Float32Array.from(
        { length: Math.max(count, this.from.length) },
        (_, i) => (Math.sin(i * 0.13 + f * 0.4) + 1) / 2,
      ),
    );
    this.schema = {
      version: 'schema-1',
      limits: { maxBlockBytes: Math.max(65536, blockRows * 32) },
      queries: ['rows', 'links'],
      axis: { name: 'time', unit: 's' },
      components: {
        node: {
          fields: {
            location: { type: { kind: 'vector', items: 'float64', size: 2 } },
            weight: { type: 'float32' },
            name: { type: 'text' },
            signal: { type: 'float32', sampled: true },
            baseX: { type: 'float64' },
            baseY: { type: 'float64' },
            x: { type: 'float64', sampled: true },
            y: { type: 'float64', sampled: true },
            z: { type: 'float32', sampled: true },
          },
          spatial: { field: 'location', system: geographic ? 'geographic' : 'cartesian' },
        },
        line: {
          fields: { signal: { type: 'float32', sampled: true } },
          ports: { a: { direction: 'both' }, b: { direction: 'both' } },
        },
      },
      connections: {
        attachment: { fields: {}, roles: { node: { min: 1, max: 1 }, line: { min: 1, max: 1 } } },
      },
    };
  }
  private scalar(field: string, frame: number): Float32Array | Float64Array {
    if (field === 'weight') return this.weights;
    if (field === 'signal' || field === 'z') return this.observations[frame];
    if (!['baseX', 'baseY', 'x', 'y'].includes(field))
      throw new Error('Unknown fixture field: ' + field);
    const sampled = field === 'x' || field === 'y';
    const key = sampled ? field + ':' + frame : field;
    let values = this.coordinates.get(key);
    if (!values) {
      const axis = field === 'y' || field === 'baseY' ? 1 : 0;
      const width = Math.ceil(Math.sqrt(this.count));
      const amplitude = this.geographic ? 4 : Math.max(1, width - 1) * 0.4;
      values = Float64Array.from({ length: this.count }, (_, row) => {
        const phase = (row % width) * 0.11 + Math.floor(row / width) * 0.17 + frame * 0.4;
        const wave = axis ? Math.cos(phase) : Math.sin(phase);
        return this.positions[row * 2 + axis] + (sampled ? amplitude * wave : 0);
      });
      this.coordinates.set(key, values);
    }
    return values;
  }
  index(type: string) {
    return { document: this.document, type, version: type + '-rows-1' };
  }
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  retain(): Promise<Queryable> {
    return Promise.reject(new Error('This deterministic test fixture does not acquire recordings'));
  }
  close(): Promise<void> {
    for (const listener of this.listeners) listener({ kind: 'closed' });
    this.listeners.clear();
    return Promise.resolve();
  }
  query: Queryable['query'] = ((query: Query, options?: QueryOptions) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options?: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    this.queries++;
    if (query.kind === 'links') this.linksQueries++;
    options?.signal?.throwIfAborted();
    yield { kind: 'schema', version: this.version, schema: this.schema };
    const total = query.from === 'node' ? this.count : this.from.length;
    const selection = 'rows' in query ? query.rows : undefined;
    if (selection?.kind === 'ids') throw new Error('Fixture does not resolve string ids');
    const selected = selection?.kind === 'indices' ? selection.values : undefined;
    const offset = selection?.kind === 'range' ? selection.offset : 0;
    const count = selected?.length ?? (selection?.kind === 'range' ? selection.count : total);
    const index = this.index(query.from);
    const sampled = query.kind === 'rows' ? (query.at ?? 0) : 0,
      frame = Math.max(0, Math.min(15, Math.floor(sampled)));
    for (let first = 0; first < count; first += this.blockRows) {
      const length = Math.min(this.blockRows, count - first);
      const rows: RowAxis = selected
        ? { kind: 'indices', values: selected.subarray(first, first + length) }
        : { kind: 'range', offset: offset + first, count: length };
      const row = (i: number) => (rows.kind === 'range' ? rows.offset + i : rows.values[i]);
      const base = {
        kind: query.kind,
        version: this.version,
        schemaVersion: this.schema.version,
        index,
        rows,
      };
      if (query.kind === 'links') {
        const source = selected
          ? Uint32Array.from({ length }, (_, i) => this.from[row(i)])
          : this.from.subarray(row(0), row(0) + length);
        const target = selected
          ? Uint32Array.from({ length }, (_, i) => this.to[row(i)])
          : this.to.subarray(row(0), row(0) + length);
        const validity = new Uint8Array(Math.ceil(length / 8));
        validity.fill(255);
        yield { ...base, kind: 'links', targetIndex: this.index('node'), source, target, validity };
      } else if (query.kind === 'rows') {
        const columns: Record<string, Column> = {};
        for (const field of query.select) {
          if (field === 'location') {
            const values = selected
              ? Float64Array.from(
                  { length: length * 2 },
                  (_, i) => this.positions[row(i >>> 1) * 2 + (i & 1)],
                )
              : this.positions.subarray(row(0) * 2, (row(0) + length) * 2);
            columns[field] = {
              kind: 'vector',
              size: 2,
              offset: 0,
              length,
              values: { kind: 'numeric', offset: 0, length: values.length, values },
            };
          } else if (field === 'name') {
            const encoded = Array.from({ length }, (_, i) =>
                new TextEncoder().encode('Node ' + row(i)),
              ),
              offsets = new Int32Array(length + 1);
            for (let i = 0; i < length; i++) offsets[i + 1] = offsets[i] + encoded[i].length;
            const bytes = new Uint8Array(offsets[length]);
            for (let i = 0; i < length; i++) bytes.set(encoded[i], offsets[i]);
            columns[field] = { kind: 'text', offset: 0, length, bytes, offsets };
          } else {
            const values = this.scalar(field, frame);
            columns[field] = {
              kind: 'numeric',
              offset: 0,
              length,
              values: selected
                ? Float32Array.from({ length }, (_, i) => values[row(i)])
                : values.subarray(row(0), row(0) + length),
            };
          }
        }
        yield { ...base, kind: 'rows', position: first, columns };
      } else throw new Error('Fixture query not implemented: ' + query.kind);
    }
    await Promise.resolve();
  }
}
