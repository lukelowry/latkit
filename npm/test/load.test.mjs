import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('installed package imports without WASM, retries failures, and shares initialization', async (t) => {
  const directory = process.env.LATKIT_TEST_PACKAGE;
  assert(directory, 'run through cargo xtask package-test');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests === 1) return new Response('retry', { status: 503 });
    return new Response(fs.readFileSync(path.join(directory, 'pkg/latkit_bg.wasm')), {
      headers: { 'Content-Type': 'application/wasm' },
    });
  });
  const { load, field, Data, Patch } = await import(
    pathToFileURL(path.join(directory, 'dist/index.js')).href
  );
  assert.equal(requests, 0);
  assert.deepEqual(field('x').toJSON(), { field: 'x' });
  // Writing a patch needs no WASM. Creating a dataset throws until WASM is loaded.
  const patch = new Patch().replace('Node', { count: 1 }, { x: [42] });
  assert.throws(() => new Data('early'), { code: 'unloaded' });
  assert.equal(requests, 0);
  const first = load({ wasm: 'https://example.invalid/latkit.wasm' });
  assert.equal(first, load());
  await assert.rejects(first, { code: 'io' });
  const retry = load({ wasm: new URL('https://example.invalid/latkit.wasm') });
  assert.equal(retry, load({ wasm: 'https://example.invalid/latkit.wasm' }));
  await retry;
  assert.equal(load(), retry, 'loaded once');
  assert.equal(requests, 2);
  await assert.rejects(load({ wasm: 'https://example.invalid/other.wasm' }), { code: 'io' });
  await assert.rejects(
    load({
      worker: () => {
        throw new Error('unused');
      },
    }),
    { code: 'io' },
  );
  const data = new Data('test').apply(patch);
  const kept = data.snapshot();
  data.apply(new Patch().set('Node', [0], { x: [7] }));
  assert.equal(data.get('Node', 0, 'x'), 7);
  data.destroy();
  data.destroy();
  assert.throws(() => data.name, { code: 'destroyed' });
  assert.equal(kept.get('Node', 0, 'x'), 42, 'a snapshot outlives its source');
  kept.destroy();
  kept.destroy();
});
