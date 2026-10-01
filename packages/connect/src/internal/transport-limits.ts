import type { Transport } from '../transport.js';
import type { Limits } from './frame.js';
const configurations = new WeakMap<Transport, (bounds: Limits) => void>();
export function configureTransport(
  transport: Transport,
  configure: (bounds: Limits) => void,
): void {
  configurations.set(transport, configure);
}
export function limitTransport(transport: Transport, bounds: Limits): void {
  configurations.get(transport)?.(bounds);
}
