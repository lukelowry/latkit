import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

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
  assert.equal(field('x').toJSON(), '$x');
  // Writing a patch and reading its bytes need no WASM. Creating a dataset and reading a patch's
  // JSON throw until WASM is loaded.
  const patch = new Patch().replace('Node', { count: 1 }, { x: [42] });
  assert.equal((await Patch.read(patch.toBytes())).byteLength, patch.byteLength);
  assert.throws(() => new Data('early'), { code: 'unloaded' });
  await assert.rejects(Patch.read([{ set: { table: 'Node', ids: [0], fields: { x: [1] } } }]), {
    code: 'unloaded',
  });
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

test('a bundle that only writes patches leaves the WebAssembly bindings out', async () => {
  const directory = process.env.LATKIT_TEST_PACKAGE;
  assert(directory, 'run through cargo xtask package-test');
  // Bundled into one file, as a worker often is, so nothing hides in a chunk loaded later.
  const bundled = async (name) => {
    const { outputFiles } = await build({
      stdin: {
        contents: `export { ${name} } from 'latkit';`,
        resolveDir: path.resolve(directory, '../..'),
      },
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'error',
    });
    return outputFiles[0].text;
  };
  assert.match(await bundled('load'), /__wbg_/, 'the bindings name their imports __wbg_');
  assert.doesNotMatch(await bundled('Patch'), /__wbg_/);
});
