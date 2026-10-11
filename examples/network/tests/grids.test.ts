import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  createData,
  read,
  rowCount,
  textColumn,
  validateBlock,
  validateSchema,
  type Data,
  type Query,
  type QueryBlock,
} from '@latkit/model';
import { geojson } from '@latkit/geography';
import { readCase } from '../src/earth/cases.js';
import { lattice } from '../src/earth/lattice.js';
import { stateValues } from '../src/earth/states.js';
import { lists, rows, vector } from '../src/shared/columns.js';

const file = (name: string) => {
  const bytes = gunzipSync(readFileSync(new URL(`../public/grids/${name}`, import.meta.url)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
async function blocks(data: Data, query: Query): Promise<QueryBlock[]> {
  expect(validateSchema(data.schema)).toEqual([]);
  const found: QueryBlock[] = [];
  for await (const block of read(data, query)) {
    expect(validateBlock(data.schema, query, block)).toEqual([]);
    found.push(block);
  }
  return found;
}
const counted = (found: QueryBlock[]) =>
  found.reduce((sum, b) => sum + (b.kind === 'rows' ? rowCount(b.rows) : 0), 0);

it.each(['wecc240', 'activsg2000', 'activsg10k', 'activsg25k', 'activsg70k'])(
  'reads the synthetic case %s into valid buses, lines, and machines',
  async (id) => {
    const grid = readCase(id, file(`${id}.bin`)),
      { data } = grid;
    for (const [type, count] of [
      ['Bus', grid.buses],
      ['Line', grid.lines],
      ['Machine', grid.machines],
    ] as const) {
      const fields = Object.entries(data.schema.types[type]!.fields)
        .filter(([, field]) => !('sampled' in field && field.sampled))
        .map(([name]) => name);
      expect(counted(await blocks(data, { kind: 'rows', from: type, select: fields }))).toBe(count);
    }
    expect(grid.positions.every(Number.isFinite)).toBe(true);
    if (!grid.simulation) return;
    // Machines swing after the fault, and the swing reads at any time simulated.
    const { simulation } = grid,
      after = await blocks(data, { kind: 'rows', from: 'Machine', select: ['speed'], at: 3 });
    expect(simulation.fault?.on).toBe(1);
    expect(simulation.largest).toBeGreaterThan(0);
    expect(
      after.some(
        (b) =>
          b.kind === 'rows' &&
          b.columns.speed?.kind === 'numeric' &&
          b.columns.speed.values.some((v) => v !== 0),
      ),
    ).toBe(true);
  },
);

it('ships the borders as Natural Earth GeoJSON: coasts, countries, and provinces', async () => {
  for (const [file, type] of [
    ['coastline', 'Coast'],
    ['countries', 'Country'],
    ['provinces', 'Province'],
  ] as const) {
    const bytes = gunzipSync(
        readFileSync(new URL(`../public/maps/${file}.geojson.gz`, import.meta.url)),
      ),
      data = await geojson(bytes, { type });
    expect(
      counted(await blocks(data, { kind: 'rows', from: type, select: ['points'] })),
    ).toBeGreaterThan(100);
  }
});

it('builds the stress lattice in valid rows', async () => {
  const built = lattice('lattice-100k');
  expect(
    counted(await blocks(built.data, { kind: 'rows', from: 'Bus', select: ['position', 'load'] })),
  ).toBe(100_000);
  expect(
    counted(await blocks(built.data, { kind: 'rows', from: 'Line', select: ['from', 'to'] })),
  ).toBe(built.lines);
});

it('counts each state the grid reaches, and the swing of its machines', async () => {
  const grid = readCase('wecc240', file('wecc240.bin'));
  // Two squares: one around every bus west of 110°W, one around the rest.
  const square = (w: number, e: number) => [w, 20, e, 20, e, 60, w, 60, w, 20];
  const points = Float64Array.from([...square(-140, -110), ...square(-110, -90)]),
    rings = lists(Int32Array.of(0, 1, 2), lists(Int32Array.of(0, 5, 10), vector(points)));
  const states = createData(
    {
      types: {
        State: {
          fields: {
            rings: {
              type: {
                kind: 'list',
                items: { kind: 'list', items: { kind: 'vector', size: 2, items: 'float64' } },
              },
              geographic: true,
            },
          },
        },
      },
    },
    [
      rows(
        { source: 'squares', type: 'State', version: '1' },
        2,
        { rings },
        textColumn(['west', 'east']),
      ),
    ],
  );
  const values = await stateValues(states, 'State', grid);
  expect(values.states).toBe(2);
  expect(values.peaks.buses).toBeGreaterThan(0);
  expect(values.peaks.swing).toBeGreaterThan(0);
  const found = await blocks(values.data, {
    kind: 'rows',
    from: 'State',
    select: ['buses'],
    ids: true,
  });
  let total = 0;
  for (const block of found)
    if (block.kind === 'rows' && block.columns.buses?.kind === 'numeric')
      for (const value of block.columns.buses.values) total += value;
  expect(total).toBe(grid.buses);
});
