import {
  appendData,
  createData,
  textColumn,
  type Data,
  type DataBatch,
  type Index,
  type NumericColumn,
  type SampleBatch,
  type SampleColumn,
  type Schema,
} from '@latkit/model';
import type { Mesh } from './bunny-mesh.js';

/** The floor's grid reaches this far from the center, in meters, and fixes the drawing's extent. */
export const FLOOR = 4;
/** Seconds of history kept: past MAX, it drops to the last KEEP. */
const MAX = 30,
  KEEP = 15;

const sampled = { type: 'float32', sampled: true } as const;
const vertex = { type: { kind: 'reference', to: 'Vertex' } } as const;
const corner = { type: { kind: 'reference', to: 'Floor' } } as const;
const schema = {
  axis: { name: 'Time', unit: 's' },
  types: {
    Vertex: { fields: { x: sampled, y: sampled, z: sampled, speed: sampled, strain: sampled } },
    Link: { fields: { from: vertex, to: vertex } },
    /** The bunny's points again, drawn on the floor beneath it. */
    Shadow: { fields: { x: sampled, y: sampled } },
    Floor: { fields: { x: { type: 'float32' }, y: { type: 'float32' } } },
    Grid: { fields: { from: corner, to: corner } },
    /** One row: the center's height, mean speed, and volume over rest volume. */
    Body: { fields: { height: sampled, speed: sampled, volume: sampled } },
  },
} as const satisfies Schema;

interface Frame {
  readonly batches: readonly SampleBatch[];
  readonly at: number;
}
function numeric(values: Float32Array): NumericColumn {
  return { kind: 'numeric', offset: 0, length: values.length, values };
}
/** One frame of a field, a value per row. */
function samples(values: Float32Array): SampleColumn {
  return { ...numeric(values), rowStride: 1, frameStride: values.length };
}

/**
 * The application's history of the simulation: one immutable Data value, appended once per drawn
 * frame. Views read whichever frame they are told to; the simulation never mutates published
 * buffers.
 */
export class History {
  readonly source = crypto.randomUUID();
  private readonly base: Data<typeof schema>;
  private readonly frames: Frame[] = [];
  private frame = 0;
  data: Data<typeof schema>;

  constructor(readonly mesh: Mesh) {
    const count = mesh.count;
    const range = (count: number) => ({ kind: 'range', offset: 0, count }) as const;
    const ids = (name: string, count: number) =>
      textColumn(Array.from({ length: count }, (_, i) => `${name} ${i}`));
    const references = (to: string, values: Uint32Array) => ({
      kind: 'reference' as const,
      index: this.index(to),
      offset: 0,
      length: values.length,
      values,
    });
    const side = FLOOR * 2 + 1,
      floorX = new Float32Array(side * side),
      floorY = new Float32Array(side * side),
      from: number[] = [],
      to: number[] = [];
    for (let j = 0; j < side; j++)
      for (let i = 0; i < side; i++) {
        const row = j * side + i;
        floorX[row] = i - FLOOR;
        floorY[row] = j - FLOOR;
        if (i + 1 < side) {
          from.push(row);
          to.push(row + 1);
        }
        if (j + 1 < side) {
          from.push(row);
          to.push(row + side);
        }
      }
    const edges = mesh.edges.length / 2;
    const batches: DataBatch[] = [
      {
        kind: 'rows',
        index: this.index('Vertex'),
        rows: range(count),
        ids: ids('Vertex', count),
        columns: {},
      },
      { kind: 'rows', index: this.index('Shadow'), rows: range(count), columns: {} },
      {
        kind: 'rows',
        index: this.index('Link'),
        rows: range(edges),
        columns: {
          from: references(
            'Vertex',
            mesh.edges.filter((_, i) => i % 2 === 0),
          ),
          to: references(
            'Vertex',
            mesh.edges.filter((_, i) => i % 2 === 1),
          ),
        },
      },
      {
        kind: 'rows',
        index: this.index('Floor'),
        rows: range(side * side),
        columns: { x: numeric(floorX), y: numeric(floorY) },
      },
      {
        kind: 'rows',
        index: this.index('Grid'),
        rows: range(from.length),
        columns: {
          from: references('Floor', Uint32Array.from(from)),
          to: references('Floor', Uint32Array.from(to)),
        },
      },
      { kind: 'rows', index: this.index('Body'), rows: range(1), columns: {} },
    ];
    this.data = this.base = createData(schema, batches);
  }

  index(type: string): Index {
    return { source: this.source, type, version: '1' };
  }
  /** The first and last coordinates kept. */
  get start(): number {
    return this.frames[0]?.at ?? 0;
  }
  get end(): number {
    return this.frames.at(-1)?.at ?? 0;
  }

  /**
   * Publish one frame: the vertices' x, y, z, speed, and strain, one after another, and the body's
   * metrics. Ownership of both arrays passes to the history.
   */
  append(at: number, vertices: Float32Array, body: Float32Array): void {
    const n = this.mesh.count,
      firstFrame = this.frame++,
      coordinates = Float64Array.of(at);
    const field = (i: number) => samples(vertices.subarray(i * n, (i + 1) * n));
    const sample = (type: string, count: number, columns: SampleBatch['columns']): SampleBatch => ({
      kind: 'samples',
      index: this.index(type),
      rows: { kind: 'range', offset: 0, count },
      firstFrame,
      coordinates,
      columns,
    });
    const x = field(0),
      y = field(1);
    const batches = [
      sample('Vertex', n, { x, y, z: field(2), speed: field(3), strain: field(4) }),
      // The shadow shares the bunny's x and y buffers.
      sample('Shadow', n, { x, y }),
      sample('Body', 1, {
        height: samples(body.subarray(0, 1)),
        speed: samples(body.subarray(1, 2)),
        volume: samples(body.subarray(2, 3)),
      }),
    ];
    this.frames.push({ batches, at });
    if (at - this.start <= MAX) {
      this.data = appendData(this.data, batches);
      return;
    }
    // Forget the oldest frames: a new value from the kept ones, sharing their buffers.
    const first = this.frames.findIndex((frame) => frame.at >= at - KEEP);
    this.frames.splice(0, first);
    this.data = appendData(
      this.base,
      this.frames.flatMap((frame) => frame.batches),
    );
  }
}
