import type { ModelService, Queryable, RequestOptions } from '@latkit/model';
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
  readonly kind?: 'service';
}
export interface QueryableConnectOptions extends Omit<ConnectOptions, 'kind'> {
  readonly kind: 'queryable';
}
/** Closing releases this peer's acquisitions and grants, never the shared service itself. */
export interface Connection extends ModelService {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
/** Read-only capability. Closing releases this connection, never the supplied root acquisition. */
export interface QueryableConnection extends Queryable {
  readonly closed: Promise<void>;
  /** End the transport and release all acquisitions belonging to this connection.
   * The borrowed native root and acquisitions on other connections remain usable. */
  close(): Promise<void>;
}
export function connect(
  transport: Transport,
  options: QueryableConnectOptions,
): Promise<QueryableConnection>;
export function connect(transport: Transport, options?: ConnectOptions): Promise<Connection>;
export async function connect(
  transport: Transport,
  options: ConnectOptions | QueryableConnectOptions = {},
): Promise<Connection | QueryableConnection> {
  const peer = new Peer(transport, options);
  const bindings = new Bindings(peer);
  try {
    await peer.ready;
    const root = await bindings.connectRoot(options.kind ?? 'service');
    return Object.assign(root, { closed: peer.closed, close: () => peer.close() });
  } catch (error) {
    await peer.close();
    throw error;
  }
}
export function serve(
  transport: Transport,
  source: Queryable,
  options: QueryableConnectOptions,
): Promise<void>;
export function serve(
  transport: Transport,
  service: ModelService,
  options?: ConnectOptions,
): Promise<void>;
/** Serve an application-authorized capability. The supplied root is borrowed; its owner closes it.
 * Independently acquired children belong to this connection and are released on disconnect. */
export async function serve(
  transport: Transport,
  root: ModelService | Queryable,
  options: ConnectOptions | QueryableConnectOptions = {},
): Promise<void> {
  const peer = new Peer(transport, options);
  try {
    new Bindings(peer, { kind: options.kind ?? 'service', value: root });
    await peer.ready;
    await peer.closed;
  } finally {
    await peer.close();
  }
}
