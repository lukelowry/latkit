/**
 * The worker that runs views' jobs. The page's first message is the compiled WebAssembly module,
 * which the worker instantiates and acknowledges with `{ ready: true }`. Each later message is a
 * job's bytes, answered with `{ bytes }` holding the result. Failures post `{ error }`.
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
