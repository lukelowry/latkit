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
  const { loadLatkit, field } = await import(
    pathToFileURL(path.join(directory, 'dist/index.js')).href
  );
  assert.equal(requests, 0);
  assert.deepEqual(field('x').toJSON(), { field: 'x' });
  const first = loadLatkit({ wasm: 'https://example.invalid/latkit.wasm' });
  assert.equal(first, loadLatkit());
  await assert.rejects(first, { code: 'load' });
  const retry = loadLatkit({ wasm: new URL('https://example.invalid/latkit.wasm') });
  assert.equal(retry, loadLatkit({ wasm: 'https://example.invalid/latkit.wasm' }));
  const kit = await retry;
  assert.equal(kit, await loadLatkit());
  assert.equal(requests, 2);
  await assert.rejects(loadLatkit({ wasm: 'https://example.invalid/other.wasm' }), {
    code: 'load',
  });
  await assert.rejects(
    loadLatkit({
      createWorker: () => {
        throw new Error('unused');
      },
    }),
    { code: 'load' },
  );
  const data = new kit.Data('test');
  const patch = new kit.Patch().put('Node', 1, { x: [42] });
  const next = data.apply(patch);
  patch.destroy();
  patch.destroy();
  assert.throws(() => patch.toBytes(), /applied or destroyed/);
  assert.equal(next.get('Node', 0, 'x'), 42);
  data.destroy();
  data.destroy();
  assert.throws(() => data.name, /destroyed/);
  assert.equal(next.get('Node', 0, 'x'), 42);
  next.destroy();
  next.destroy();
});
