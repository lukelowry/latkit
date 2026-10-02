import { createData, read, type Data } from '@latkit/model';
import type { Column, Query, QueryOptions, Schema, Index } from '@latkit/model';

/** Immutable application data used by unit tests and the headed path benchmark. */
export class PathSource {
  readonly version = 'paths-1';
  readonly schema: Schema;
  queries = 0;
  constructor(
    readonly tables: Readonly<Record<string, Readonly<Record<string, Column>>>>,
    readonly blockRows = 256,
  ) {
    const type = (column: Column): import('@latkit/model').DataType => {
      if (column.kind === 'list') return { kind: 'list', items: type(column.values) };
      if (column.kind === 'vector')
        return {
          kind: 'vector',
          size: column.size,
          items: column.values.values instanceof Float64Array ? 'float64' : 'float32',
        };
      if (column.kind === 'numeric')
        return column.values instanceof Float64Array ? 'float64' : 'float32';
      if (column.kind === 'reference') return { kind: 'reference', to: column.index.type };
      return column.kind;
    };
    this.schema = {
      limits: { maxBlockBytes: 4 * 1024 * 1024 },
      types: Object.fromEntries(
        Object.entries(tables).map(([name, columns]) => [
          name,
          {
            fields: Object.fromEntries(
              Object.entries(columns).map(([name, column]) => [
                name,
                { type: type(column), nullable: !!column.validity },
              ]),
            ),
            ...(columns.position || columns.points
              ? {
                  spatial: {
                    field: columns.position ? 'position' : 'points',
                    system: 'geographic' as const,
                  },
                }
              : {}),
          },
        ]),
      ),
    };
  }
  index(type: string): Index {
    return { source: 'paths-fixture', type, version: 'rows-1' };
  }
  private cached?: Data;
  get data(): Data {
    return (this.cached ??= createData(
      this.schema,
      this.version,
      Object.entries(this.tables).map(([type, columns]) => ({
        kind: 'rows' as const,
        index: this.index(type),
        rows: { kind: 'range' as const, offset: 0, count: Object.values(columns)[0].length },
        columns,
      })),
    ));
  }
  query<Q extends Query>(query: Q, options?: QueryOptions) {
    return read(this.data, query, options);
  }
}

export function vectors(values: readonly number[]): import('@latkit/model').VectorColumn {
  const data = Float64Array.from(values);
  return {
    kind: 'vector',
    offset: 0,
    length: data.length / 2,
    size: 2,
    values: { kind: 'numeric', offset: 0, length: data.length, values: data },
  };
}
export function lists(paths: readonly (readonly number[])[]): import('@latkit/model').ListColumn {
  const offsets = new Int32Array(paths.length + 1);
  for (let i = 0; i < paths.length; i++) offsets[i + 1] = offsets[i] + paths[i].length / 2;
  return {
    kind: 'list',
    offset: 0,
    length: paths.length,
    offsets,
    values: vectors(paths.flatMap((p) => [...p])),
  };
}
export function strings(values: readonly string[]): import('@latkit/model').TextColumn {
  const encoded = values.map((v) => new TextEncoder().encode(v)),
    offsets = new Int32Array(values.length + 1);
  for (let i = 0; i < encoded.length; i++) offsets[i + 1] = offsets[i] + encoded[i].length;
  const bytes = new Uint8Array(offsets[values.length]);
  encoded.forEach((v, i) => bytes.set(v, offsets[i]));
  return { kind: 'text', offset: 0, length: values.length, offsets, bytes };
}
export function references(
  type: string,
  rows: readonly number[],
): import('@latkit/model').ReferenceColumn {
  return {
    kind: 'reference',
    index: { source: 'paths-fixture', type, version: 'rows-1' },
    offset: 0,
    length: rows.length,
    values: Uint32Array.from(rows),
  };
}
/** Nodes wired to one star net; bend and route each join two nodes by their ends. */
export function featureSource(): PathSource {
  return new PathSource(
    {
      node: {
        position: vectors([-70, -20, -30, -10, -60, 30, 20, 40]),
        name: strings(['West', 'East', 'North', 'Distant']),
        star: references('star', [0, 0, 0, 0]),
      },
      bend: {
        points: lists([[-60, 0, -40, 0]]),
        name: strings(['Bent connection']),
        from: references('node', [0]),
        to: references('node', [1]),
      },
      star: { name: strings(['Four-way junction']) },
      route: {
        name: strings(['Great circle']),
        from: references('node', [0]),
        to: references('node', [3]),
      },
      seam: { points: lists([[170, 20, -170, 20]]), name: strings(['Dateline']) },
    },
    2,
  );
}
