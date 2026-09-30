import type { ModelService, RequestOptions } from '@latkit/model-new';
import type { Transport } from './transport.js';
import { Peer } from './internal/peer.js';
import { Bindings } from './internal/bindings.js';
export interface ConnectionLimits {
  readonly maxMetadataBytes?: number;
  readonly maxInFlightBytes?: number;
  readonly maxStreams?: number;
  readonly maxReferences?: number;
}
export interface ConnectOptions extends RequestOptions {
  readonly limits?: ConnectionLimits;
}
/** Closing releases this peer's acquisitions and grants, never the shared service itself. */
export interface Connection extends ModelService {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
export async function connect(
  transport: Transport,
  options: ConnectOptions = {},
): Promise<Connection> {
  const peer = new Peer(transport, options);
  const bindings = new Bindings(peer);
  try {
    await peer.ready;
    const service = await bindings.connectService();
    return Object.assign(service, { closed: peer.closed, close: () => peer.close() });
  } catch (error) {
    await peer.close();
    throw error;
  }
}
/** Serve one connection to an application-authorized view of a shared service. */
export async function serve(
  transport: Transport,
  service: ModelService,
  options: ConnectOptions = {},
): Promise<void> {
  const peer = new Peer(transport, options);
  new Bindings(peer, service);
  try {
    await peer.ready;
    await peer.closed;
  } finally {
    await peer.close();
  }
}
