/**
 * The page models' tests run in node, where fetch reads no files: latkit's WebAssembly, which it
 * fetches from beside its module, is read from disk instead, and loaded before the tests make data.
 */
import { readFile } from 'node:fs/promises';
import { load } from 'latkit';

const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith('file:')) return fetch(input, init);
  const type = url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  return new Response(await readFile(new URL(url)), { headers: { 'Content-Type': type } });
};
await load();
