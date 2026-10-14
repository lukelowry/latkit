/**
 * A worker doing views' jobs: it instantiates the module the page posts first, then answers each
 * job's bytes with its answer's.
 */

import init, { job } from '../pkg/latkit.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WebAssembly.Module | Uint8Array>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let ready: Promise<unknown> | undefined;
scope.onmessage = ({ data }) => {
  if (data instanceof WebAssembly.Module) {
    ready = init({ module_or_path: data });
    return;
  }
  void (async () => {
    try {
      await ready;
      const bytes = job(data);
      scope.postMessage({ bytes }, [bytes.buffer]);
    } catch (error) {
      scope.postMessage({ error: String(error) });
    }
  })();
};
