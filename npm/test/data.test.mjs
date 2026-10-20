// Patches written in TypeScript and read by latkit's WebAssembly: the two halves of the byte
// format agree on every kind of value, and data reads back as it was written. Runs against the
// built package (`node npm/build.mjs compile npm`) or the installed one (LATKIT_TEST_PACKAGE).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const directory = process.env.LATKIT_TEST_PACKAGE ?? path.resolve(import.meta.dirname, '..');
const { loadLatkit, Patch, reference, field } = await import(
  pathToFileURL(path.join(directory, 'dist/index.js')).href
);
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(directory, 'pkg/latkit_bg.wasm')));
const { Data } = await loadLatkit({ wasm });

/** Every chunk of `bytes`, `size` at a time, as a socket might hand them over. */
function* pieces(bytes, size) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

test('patches carry every kind of value through the bytes', () => {
  const grid = new Data('grid').apply(
    Patch.to('grid')
      .axis('time', 's')
      .replace('Bus', [101, 102, 103], {
        kv: Float64Array.of(230, 115, 69),
        vm: [1.01, null, 0.99],
        load: Float32Array.of(1.5, 2.5, 3.5),
        rank: Int32Array.of(-1, 0, 1),
        zone: Uint32Array.of(7, 8, 9),
        flag: Uint8Array.of(1, 0, 2),
        open: [true, null, false],
        name: ['North', null, 'Sü∂'],
        point: [[0, 1], null, [4, 5]],
        path: [
          [
            [0, 0],
            [1, 1],
          ],
          [],
          [
            [2, 2],
            [3, 3],
            [4, 4],
          ],
        ],
        area: [
          [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
              ],
            ],
          ],
          null,
          [
            [
              [
                [5, 5],
                [6, 5],
                [6, 6],
              ],
            ],
            [
              [
                [7, 7],
                [8, 7],
                [8, 8],
              ],
            ],
          ],
        ],
      })
      .replace(
        'Branch',
        { count: 2 },
        {
          from: reference('Bus', [101, 102]),
          to: reference('Bus', [102, null]),
        },
      )
      .replace('Named', ['a', 'b'], { x: [1, 2] }),
  );
  const get = (id, name) => grid.get('Bus', id, name);
  assert.equal(get(101, 'kv'), 230);
  assert.equal(get(102, 'vm'), null, 'null is missing');
  assert.equal(get(103, 'load'), 3.5);
  assert.equal(get(101, 'rank'), -1);
  assert.equal(get(102, 'zone'), 8);
  assert.deepEqual(
    [get(101, 'flag'), get(102, 'flag'), get(103, 'flag')],
    [true, false, true],
    'a Uint8Array holds booleans',
  );
  assert.deepEqual([get(101, 'open'), get(102, 'open'), get(103, 'open')], [true, null, false]);
  assert.deepEqual([get(101, 'name'), get(102, 'name'), get(103, 'name')], ['North', null, 'Sü∂']);
  assert.deepEqual(get(103, 'point'), [4, 5]);
  assert.equal(get(102, 'point'), null);
  assert.deepEqual(get(103, 'path'), [
    [2, 2],
    [3, 3],
    [4, 4],
  ]);
  assert.equal(get(102, 'path'), null, 'an empty geometry is missing');
  assert.equal(get(103, 'area').length, 2, 'two polygons');
  assert.equal(grid.get('Branch', 0, 'from'), 101, 'a reference reads as the id it names');
  assert.equal(grid.get('Branch', 1, 'to'), null, 'null leaves a reference unwired');
  assert.equal(grid.get('Named', 'b', 'x'), 2);
  const kinds = Object.fromEntries(
    grid
      .describe()
      .tables.find((t) => t.name === 'Bus')
      .fields.map((f) => [f.name, f.kind]),
  );
  assert.deepEqual(
    [kinds.kv, kinds.open, kinds.name, kinds.point, kinds.path, kinds.area],
    ['number', 'bool', 'text', 'point', 'path', 'polygons'],
  );
  // A dataset's bytes are the patch that builds it, read back alike.
  const again = new Data('grid').apply(Patch.fromBytes(grid.toBytes()));
  assert.deepEqual(again.describe(), grid.describe());
  assert.deepEqual(again.get('Bus', 103, 'area'), get(103, 'area'));
  grid.destroy();
  again.destroy();
});

test('changes apply in place, a snapshot keeps a version, and a patch names its dataset', () => {
  const data = new Data('grid').apply(new Patch().replace('Bus', [1, 2, 3], { x: [1, 2, 3] }));
  const before = data.snapshot();
  data.apply(
    new Patch()
      .set('Bus', [3, 4], { x: [30, 40] })
      .remove('Bus', [1])
      .append([0, 1], 'Bus', { v: Float32Array.of(1, 2, 3, 4, 5, 6) })
      .append(2, 'Bus', { v: [9] }, [4]),
  );
  assert.deepEqual(data.ids('Bus'), [2, 3, 4]);
  assert.deepEqual(before.ids('Bus'), [1, 2, 3], 'the snapshot holds');
  assert.equal(data.get('Bus', 4, 'x'), 40);
  assert.equal(data.get('Bus', 4, 'v', 2), 9, 'rows named take the frame');
  assert.equal(data.get('Bus', 2, 'v', 2), 4, 'the rest hold their last values');
  assert.deepEqual(data.span, [0, 2]);
  data.apply(new Patch().forget(1));
  assert.deepEqual(data.span, [1, 2]);
  assert.throws(() => data.apply(Patch.to('weather')), { code: 'invalid' });
  assert.throws(() => data.apply(new Patch().set('Bus', [1], { x: ['a'] })), { code: 'invalid' });
  assert.equal(data.get('Bus', 2, 'x'), 2, 'a failed patch changes nothing');
  data.destroy();
  before.destroy();
});

test('a failed change leaves the patch as it was', () => {
  const patch = new Patch().set('Bus', [1], { x: [1] });
  const bytes = patch.toBytes();
  assert.throws(() => patch.set('Bus', [2], { x: [1, 'two'] }), { code: 'invalid', path: 'Bus.x' });
  assert.throws(() => patch.remove('Bus', [1.5]), { code: 'invalid' });
  assert.deepEqual(patch.toBytes(), bytes);
  const extended = new Patch().set('Bus', [2], { x: [2] }).extend(patch);
  const data = new Data('grid').apply(extended);
  assert.deepEqual(data.ids('Bus'), [2, 1]);
  data.destroy();
});

test('patches stream back to back, split anywhere, and refuse what is too long', async () => {
  const sent = [
    Patch.to('grid').replace('Bus', [7, 8, 9], { x: [1, 2, 3] }),
    new Patch().set('Bus', [7], { x: [10] }),
    new Patch().remove('Bus', [8]),
  ];
  const stream = new Uint8Array(sent.flatMap((p) => [...p.toBytes()]));
  for (const size of [1, 3, 64, stream.length]) {
    const data = new Data('grid');
    const read = [];
    for await (const patch of Patch.stream(pieces(stream, size))) {
      read.push(patch.data);
      data.apply(patch);
    }
    assert.deepEqual(read, ['grid', undefined, undefined]);
    assert.deepEqual(data.ids('Bus'), [7, 9]);
    assert.equal(data.get('Bus', 7, 'x'), 10);
    data.destroy();
  }
  const long = Patch.to('grid')
    .replace('Bus', [1], { name: ['x'.repeat(100)] })
    .toBytes();
  const read = (stream, options) => Array.fromAsync(Patch.stream(stream, options));
  await assert.rejects(read(pieces(long, 16), { limit: 64 }), { code: 'limit' });
  await assert.rejects(read(pieces(long.subarray(0, 40), 16)), /ended inside a patch/);
  const json = new TextEncoder().encode('{"not": "latkit"}');
  await assert.rejects(read([json]), { code: 'invalid' });
});

test('JSON, latkit bytes, and GeoJSON read as datasets', async () => {
  const json = JSON.stringify({
    name: 'grid',
    patch: [{ replace: { table: 'Bus', ids: { count: 2 }, fields: { x: [1, 2] } } }],
  });
  const loaded = await Data.load(json);
  assert.equal(loaded.get('Bus', 1, 'x'), 2);
  const read = await Data.read(loaded.toBytes(), 'renamed');
  assert.equal(read.name, 'renamed');
  const patch = await Patch.load('[{"set": {"table": "Bus", "ids": [1], "fields": {"x": [20]}}}]');
  assert.equal(read.apply(patch).get('Bus', 1, 'x'), 20);
  const geojson = new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    }),
  );
  const places = await Data.read(geojson, 'places');
  assert.deepEqual(places.get('points', 0, 'geometry'), [1, 2]);
  await assert.rejects(Data.read(geojson), { code: 'invalid' }, 'GeoJSON takes a name');
  for (const data of [loaded, read, places]) data.destroy();
});

test('queries filter, sort, page, and count', () => {
  const data = new Data('grid').apply(
    new Patch().replace('Branch', [7, 8, 9], {
      loading: [40, 120, 95],
      name: ['Ash', 'Birch', 'Cedar'],
    }),
  );
  const hot = data.query({
    of: 'Branch',
    filter: field('loading').gt(90),
    sort: [[field('loading'), 'descending']],
    select: { name: 'name', loading: 'loading' },
    limit: 1,
  });
  assert.deepEqual(hot.ids, [8]);
  assert.equal(hot.total, 2, 'rows kept before paging');
  assert.ok(hot.fields.loading instanceof Float64Array);
  const named = data.query({ of: 'Branch', filter: field('name').contains('ED') });
  assert.deepEqual(named.ids, [9], 'contains ignores case');
  assert.deepEqual(data.query({ of: 'Branch', ids: [9, 7] }).ids, [9, 7], 'ids keep their order');
  data.destroy();
});
