/** Carry a model across a socket: one side connects it, the other accepts it, and either may dial. */
export { connectModel } from './connect.js';
export { acceptModel } from './accept.js';
export type {
  AcceptOptions,
  ConnectedModel,
  Connection,
  ConnectLimits,
  ConnectOptions,
  WebSocketLike,
} from './types.js';
/** The wire codec, for storage and gateways: frames, publications, and subprotocols. */
export * as protocol from './protocol.js';
