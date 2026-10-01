import type { Model, Queryable, RequestOptions } from '@latkit/model';
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
  readonly kind?: 'model';
}
export interface QueryableConnectOptions extends Omit<ConnectOptions, 'kind'> {
  readonly kind: 'queryable';
}
/** Closing ends this peer's monitors, retained reads and commands, never the shared model. */
export interface Connection extends Model {
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
    const root = await bindings.connectRoot(options.kind ?? 'model');
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
export function serve(transport: Transport, model: Model, options?: ConnectOptions): Promise<void>;
/** Serve an application-authorized model or read-only source. The root is borrowed: every peer
 * shares it, and its owner closes it. A peer's monitors, retained reads and commands belong to
 * that peer, and end when it disconnects. */
export async function serve(
  transport: Transport,
  root: Model | Queryable,
  options: ConnectOptions | QueryableConnectOptions = {},
): Promise<void> {
  const peer = new Peer(transport, options);
  try {
    new Bindings(peer, { kind: options.kind ?? 'model', value: root });
    await peer.ready;
    await peer.closed;
  } finally {
    await peer.close();
  }
}
