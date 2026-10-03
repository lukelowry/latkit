/** The wire codec, for storage, gateways, and hosts, without coupling application code to stream IDs. */
export { subprotocols, Op, prepare, decode } from './frame.js';
export type { Frame, FrameLimits, Opcode, Plan } from './frame.js';
export { preparePublication, decodePublication } from './columns.js';
export type { PublicationLimits } from './columns.js';
export type { EncodedPublication } from './types.js';
