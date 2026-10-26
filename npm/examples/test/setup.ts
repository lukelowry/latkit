/**
 * Setup for the examples' tests, which run in node. Node's fetch cannot read files, so `file:`
 * URLs, such as latkit's WebAssembly beside its module, are read from disk instead. latkit is
 * loaded before any test makes data.
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
