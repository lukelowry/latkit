import type { Commands, Model, RequestOptions } from '@latkit/model';
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
export interface ServeOptions extends ConnectOptions {
  readonly commands?: Commands;
}
/** Closing ends this peer's subscriptions and commands. Delivered values remain usable. */
export interface Connection extends Model {
  readonly commands?: Commands;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
export async function connect(
  transport: Transport,
  options: ConnectOptions = {},
): Promise<Connection> {
  const peer = new Peer(transport, options);
  try {
    const bindings = new Bindings(peer);
    await peer.ready;
    const root = await bindings.connectRoot();
    return Object.assign(root, { closed: peer.closed, close: () => peer.close() });
  } catch (error) {
    await peer.close();
    throw error;
  }
}
/** Borrow a live producer and, independently, an optional command capability. */
export async function serve(
  transport: Transport,
  model: Model,
  options: ServeOptions = {},
): Promise<void> {
  const peer = new Peer(transport, options);
  try {
    new Bindings(peer, { model, commands: options.commands });
    await peer.ready;
    await peer.closed;
  } finally {
    await peer.close();
  }
}
