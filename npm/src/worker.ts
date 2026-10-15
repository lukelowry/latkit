/**
 * A worker doing views' jobs: it instantiates the module the page posts first, then answers each
 * job's bytes with its answer's.
 */

import { initSync, job } from '../pkg/latkit.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WebAssembly.Module | Uint8Array>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let ready = false;
scope.onmessage = ({ data }) => {
  try {
    if (data instanceof WebAssembly.Module) {
      initSync({ module: data });
      ready = true;
      scope.postMessage({ ready: true });
    } else {
      if (!ready) throw new Error('worker has not received its WASM module');
      const bytes = job(data);
      scope.postMessage({ bytes }, [bytes.buffer]);
    }
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
