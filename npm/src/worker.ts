/**
 * A worker doing views' jobs: it instantiates the module the page posts first, then answers each
 * job with its bytes.
 */

import init, { job } from '../pkg/latkit.js';

interface Asked {
  id: number;
  bytes: Uint8Array;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WebAssembly.Module | Asked>) => void) | null;
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
      const bytes = job(data.bytes);
      scope.postMessage({ id: data.id, bytes }, [bytes.buffer]);
    } catch (error) {
      scope.postMessage({ id: data.id, error: String(error) });
    }
  })();
};
