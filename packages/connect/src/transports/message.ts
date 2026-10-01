import type { Transport } from '../transport.js';
import { failure } from '../internal/errors.js';
import { Events } from './events.js';
export interface MessageTarget {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  start?(): void;
  close?(): void;
}
/** A dedicated MessagePort, Worker, or worker scope; message buffers use structured clone/transfer. */
export function messagePort(target: MessageTarget): Transport {
  const events = new Events();
  const receive: EventListener = (event) => events.message((event as MessageEvent<unknown>).data);
  const fail: EventListener = () =>
    events.end(failure('disconnected', 'Message transport failed.'));
  const closed: EventListener = () => events.end();
  target.addEventListener('message', receive);
  target.addEventListener('messageerror', fail);
  target.addEventListener('error', fail);
  target.addEventListener('close', closed);
  target.start?.();
  return {
    transfers: true,
    send(message, transfer = []) {
      events.check();
      target.postMessage(message, [...transfer]);
      return Promise.resolve();
    },
    subscribe: events.subscribe.bind(events),
    close() {
      target.removeEventListener('message', receive);
      target.removeEventListener('messageerror', fail);
      target.removeEventListener('error', fail);
      target.removeEventListener('close', closed);
      target.close?.();
      events.end();
      return Promise.resolve();
    },
  };
}
