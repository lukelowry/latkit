// Tests patches written in TypeScript and read by latkit's WebAssembly. Both sides of the binary
// format must agree on every kind of value, and data must read back unchanged. Runs against the
// built package (`node npm/build.mjs compile npm`) or the installed one (LATKIT_TEST_PACKAGE).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const directory = process.env.LATKIT_TEST_PACKAGE ?? path.resolve(import.meta.dirname, '..');
const { load, Data, Patch, reference, field } = await import(
  pathToFileURL(path.join(directory, 'dist/index.js')).href
);
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(directory, 'pkg/latkit_bg.wasm')));
await load({ wasm });

/** Yields `bytes` in chunks of `size`, as a socket might deliver them. */
function* pieces(bytes, size) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/** The ids of `table` in `data`, in row order. */
const ids = (data, table) => data.query({ of: table }).ids;

test('patches carry every kind of value through the bytes', async () => {
  const grid = new Data('grid').apply(
    new Patch('grid')
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
  assert.equal(grid.get('Branch', 0, 'from'), 101, 'a reference reads as the referenced id');
  assert.equal(grid.get('Branch', 1, 'to'), null, 'a null id is a missing reference');
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
  // A dataset's bytes are the patch that builds it, so reading them back gives an equal dataset.
  const again = new Data('grid').apply(await Patch.read(grid.toBytes()));
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
      .append('Bus', [0, 1], { v: Float32Array.of(1, 2, 3, 4, 5, 6) })
      .append('Bus', 2, { v: [9] }, { ids: [4] }),
  );
  assert.deepEqual(ids(data, 'Bus'), [2, 3, 4]);
  assert.deepEqual(ids(before, 'Bus'), [1, 2, 3], 'the snapshot is unchanged');
  assert.equal(data.get('Bus', 4, 'x'), 40);
  assert.equal(data.get('Bus', 4, 'v', { at: 2 }), 9, 'the listed rows take the frame');
  assert.equal(data.get('Bus', 2, 'v', { at: 2 }), 4, 'other rows keep their last values');
  assert.deepEqual(data.describe().span, [0, 2]);
  data.apply(new Patch().forget(1));
  assert.deepEqual(data.describe().span, [1, 2]);
  assert.throws(() => data.apply(new Patch('weather')), { code: 'invalid' });
  assert.throws(() => data.apply(new Patch().set('Bus', [1], { x: ['a'] })), { code: 'invalid' });
  assert.equal(data.get('Bus', 2, 'x'), 2, 'a failed patch changes nothing');
  data.restore(before);
  assert.deepEqual(ids(data, 'Bus'), [1, 2, 3], 'restored to the snapshot');
  assert.throws(() => new Data('other').restore(before), { code: 'invalid' });
  data.destroy();
  before.destroy();
});

test('each change applies on its own, and tables write as their JSON form', () => {
  const data = new Data('grid')
    .axis('time', 's')
    .replace('Bus', [1, 2, 3], { x: [1, 2, 3] })
    .set('Bus', [4], { x: [4] })
    .remove('Bus', [1])
    .append('Bus', [0, 1], { v: Float32Array.of(1, 2, 3, 4, 5, 6) })
    .forget(1);
  assert.deepEqual(ids(data, 'Bus'), [2, 3, 4]);
  assert.deepEqual(data.describe().span, [1, 1]);
  assert.throws(() => data.set('Bus', [1], { x: ['a'] }), { code: 'invalid' });
  assert.equal(data.get('Bus', 2, 'x'), 2, 'a failed change changes nothing');
  const bus = data.table('Bus');
  assert.equal(bus.source, data);
  assert.equal(
    JSON.stringify({ vertices: bus, color: field('kv').from(data.table('Station')) }),
    '{"vertices":["grid","Bus"],"color":{"field":"kv","from":["grid","Station"]}}',
  );
  data.destroy();
});

test('appended frames retain their values', () => {
  const frame = new Float32Array(2);
  const patch = new Patch().replace('Bus', [1, 2], { x: [1, 2] });
  for (let f = 0; f < 4; f++) {
    frame.set([f, 10 * f]);
    patch.append('Bus', f, { v: frame });
  }
  const data = new Data('grid').apply(patch);
  const v = (at) => data.get('Bus', 2, 'v', { at });
  assert.deepEqual([v(0), v(1), v(2), v(3)], [0, 10, 20, 30], 'each frame copied when appended');
  const envelope = data.envelope({ table: 'Bus', field: 'v', range: [0, 4], spans: 2, ids: [2] });
  assert.deepEqual([...envelope.at], [0, 2, 4]);
  assert.deepEqual(
    [...envelope.least, ...envelope.greatest],
    [0, 20, 10, 30],
    'row 2, span by span',
  );
  assert.throws(() => data.envelope({ table: 'Nope', field: 'v', range: [0, 1], spans: 1 }), {
    code: 'invalid',
    path: 'Nope',
  });
  data.destroy();
});

test('time tiles store runs of a sampled field with gaps between them', async () => {
  const data = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { x: [1, 2] }));
  data.apply(
    new Patch()
      .frames('Bus', 'v', { first: 100, at: [100, 101], values: Float32Array.of(1, 2, 3, 4) })
      .frames('Bus', 'v', { level: 1, first: 0, at: [0, 7], values: [0.5, 0.25, 1.5, 1.25] }),
  );
  assert.deepEqual(data.describe().span, [0, 101]);
  assert.equal(data.get('Bus', 2, 'v', { at: 101 }), 4);
  assert.equal(data.get('Bus', 1, 'v', { at: 50 }), null, 'a gap has no frame');
  const again = new Patch().frames('Bus', 'v', { first: 100, at: [100], values: [1, 2] });
  assert.throws(() => data.apply(again), { code: 'invalid' }, 'frames already stored');
  assert.throws(
    () => new Patch().frames('Bus', 'v', { level: 1, first: 0, at: [0, 7, 9], values: [1] }),
    { code: 'invalid' },
  );
  const back = new Data('grid').apply(await Patch.read(data.toBytes()));
  assert.deepEqual(back.describe(), data.describe());
  assert.equal(back.get('Bus', 1, 'v', { at: 100.5 }), 1);
  data.destroy();
  back.destroy();
});

test('a failed change leaves the patch unchanged', () => {
  const patch = new Patch().set('Bus', [1], { x: [1] });
  const bytes = patch.toBytes();
  assert.throws(() => patch.set('Bus', [2], { x: [1, 'two'] }), { code: 'invalid', path: 'Bus.x' });
  assert.throws(() => patch.remove('Bus', [1.5]), { code: 'invalid' });
  assert.deepEqual(patch.toBytes(), bytes);
  const extended = new Patch().set('Bus', [2], { x: [2] }).extend(patch);
  const data = new Data('grid').apply(extended);
  assert.deepEqual(ids(data, 'Bus'), [2, 1]);
  data.destroy();
});

test('patches stream back to back, split anywhere, and reject oversized frames', async () => {
  const sent = [
    new Patch('grid').replace('Bus', [7, 8, 9], { x: [1, 2, 3] }),
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
    assert.deepEqual(ids(data, 'Bus'), [7, 9]);
    assert.equal(data.get('Bus', 7, 'x'), 10);
    data.destroy();
  }
  const long = new Patch('grid').replace('Bus', [1], { name: ['x'.repeat(100)] }).toBytes();
  const read = (stream, options) => Array.fromAsync(Patch.stream(stream, options));
  await assert.rejects(read(pieces(long, 16), { limit: 64 }), { code: 'limit' });
  await assert.rejects(read(pieces(long, 16), { limit: 4 }), { code: 'invalid', path: 'limit' });
  await assert.rejects(read(pieces(long.subarray(0, 40), 16)), /ended inside a patch/);
  const json = new TextEncoder().encode('{"not": "latkit"}');
  await assert.rejects(read([json]), { code: 'invalid' });
});

test('failed fetches are io errors, and aborting one rejects as cancelled', async (t) => {
  const missing = new Response('gone', { status: 404 });
  await assert.rejects(Patch.read(missing), { code: 'io' });
  await assert.rejects(Data.read(new Response('gone', { status: 404 })), { code: 'io' });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    signal?.throwIfAborted();
    throw new TypeError(`${url}: no network`);
  });
  await assert.rejects(Patch.read('https://example.invalid/p.latk'), { code: 'io' });
  await assert.rejects(Data.read('https://example.invalid/d.latk'), { code: 'io' });
  // Like a real fetch, this one rejects with the abort's reason before latkit hears of the abort.
  globalThis.fetch.mock.mockImplementation(
    (url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  );
  const controller = new AbortController();
  const reading = Patch.read('https://example.invalid/p.latk', { signal: controller.signal });
  controller.abort();
  await assert.rejects(reading, { code: 'cancelled' });
});

test('blobs and streams read within their signal, fail as io, and cancel when stopped', async () => {
  const bytes = new Patch().axis('t', 's').toBytes();
  const length = async (source) => (await Patch.read(source)).toBytes().length;
  assert.equal(await length(new Blob([bytes])), bytes.length);
  assert.equal(
    await length(
      (async function* () {
        yield bytes;
      })(),
    ),
    bytes.length,
  );
  const stopped = AbortSignal.abort('stop');
  await assert.rejects(Patch.read(new Blob([bytes]), { signal: stopped }), { code: 'cancelled' });
  const failing = () =>
    new ReadableStream({
      pull() {
        throw new Error('the socket closed');
      },
    });
  const closed = (error) => error.code === 'io' && error.cause.message === 'the socket closed';
  await assert.rejects(Patch.read(failing()), closed);
  await assert.rejects(async () => {
    for await (const patch of Patch.stream(failing())) void patch;
  }, closed);
  const cancelled = [];
  const stalled = () =>
    new ReadableStream({ pull: () => new Promise(() => {}), cancel: (why) => cancelled.push(why) });
  const controller = new AbortController();
  const reading = Patch.read(stalled(), { signal: controller.signal });
  controller.abort('stop');
  await assert.rejects(reading, { code: 'cancelled', cause: 'stop' });
  await assert.rejects(Data.read(stalled(), { signal: stopped }), { code: 'cancelled' });
  assert.deepEqual(cancelled, ['stop', 'stop'], 'a stream stopped mid-read or before is cancelled');
});

test('Data.read detects JSON, latkit bytes, and GeoJSON by their first bytes', async () => {
  const document = {
    name: 'grid',
    patch: [{ replace: { table: 'Bus', ids: { count: 2 }, fields: { x: [1, 2] } } }],
  };
  const loaded = await Data.read(document);
  assert.equal(loaded.get('Bus', 1, 'x'), 2);
  const text = await Data.read(new TextEncoder().encode(JSON.stringify(document)));
  assert.deepEqual(text.describe(), loaded.describe(), 'a document read from its bytes');
  const read = await Data.read(loaded.toBytes(), { name: 'renamed' });
  assert.equal(read.name, 'renamed');
  const patch = await Patch.read([{ set: { table: 'Bus', ids: [1], fields: { x: [20] } } }]);
  assert.equal(read.apply(patch).get('Bus', 1, 'x'), 20);
  const geojson = new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    }),
  );
  const places = await Data.read(geojson, { name: 'places' });
  assert.deepEqual(places.get('points', 0, 'geometry'), [1, 2]);
  await assert.rejects(Data.read(geojson), { code: 'invalid' }, 'GeoJSON needs a name');
  const aborted = AbortSignal.abort();
  await assert.rejects(Data.read(geojson, { name: 'places', signal: aborted }), {
    code: 'cancelled',
  });
  for (const data of [loaded, text, read, places]) data.destroy();
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
    select: { name: '$name', loading: '$loading' },
    limit: 1,
  });
  assert.deepEqual(hot.ids, [8]);
  assert.equal(hot.total, 2, 'rows matched before paging');
  assert.ok(hot.fields.loading instanceof Float64Array);
  const named = data.query({ of: 'Branch', filter: field('name').contains('ED') });
  assert.deepEqual(named.ids, [9], 'contains ignores case');
  assert.deepEqual(data.query({ of: 'Branch', ids: [9, 7] }).ids, [9, 7], 'ids keep their order');
  data.destroy();
});

test('the patch fixture and frame indexes past 2^32 agree with Rust', () => {
  const fixture = Buffer.from(
    fs
      .readFileSync(
        new URL('../../crates/latkit/tests/fixtures/patch.hex', import.meta.url),
        'utf8',
      )
      .trim(),
    'hex',
  );
  const patch = new Patch().frames('T', 'v', { first: 2 ** 32 + 3, at: [0, 1], values: [1, 2] });
  assert.deepEqual(Buffer.from(patch.toBytes()), fixture);
  const data = new Data('test').apply(new Patch().replace('T', { count: 1 }).extend(patch));
  data.apply(new Patch().append('T', 2, { v: [3] }));
  assert.equal(data.get('T', 0, 'v'), 3);
  assert.deepEqual(data.describe().span, [0, 2]);
  data.destroy();
  assert.throws(
    () => new Patch().frames('T', 'v', { first: Number.MAX_SAFE_INTEGER, at: [0], values: [1] }),
    /safe/,
  );
});

test('query fields preserve arbitrary names as own properties', () => {
  const data = new Data('test').apply(
    new Patch().replace('T', [1], { ['__proto__']: [42], constructor: [7] }),
  );
  const fields = data.query({ of: 'T' }).fields;
  assert.deepEqual(Object.keys(fields), ['__proto__', 'constructor']);
  assert.equal(fields.__proto__[0], 42);
  data.destroy();
});

test('stream rejects oversized headers and cancels owned readers on early termination', async () => {
  let cancelled = 0;
  const frame = new Patch().axis('t', 's').toBytes();
  const oversized = new Uint8Array(2 << 20);
  oversized.set(frame);
  // The frame's length follows the 4-byte magic.
  new DataView(oversized.buffer).setBigUint64(4, BigInt(oversized.length), true);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(oversized);
    },
    cancel() {
      cancelled++;
    },
  });
  await assert.rejects(async () => {
    for await (const patch of Patch.stream(stream, { limit: 1024 })) void patch;
  }, /longer/);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
  const many = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([...frame, ...frame]));
    },
    cancel() {
      cancelled++;
    },
  });
  for await (const patch of Patch.stream(many)) {
    assert.equal(patch.toBytes().length, frame.length);
    break;
  }
  assert.equal(cancelled, 2);
  assert.equal(many.locked, false);
});
