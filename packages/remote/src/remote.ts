/**
 * The one shape every connected side shares: whatever the peer serves, plus the close that ends
 * the connection to it.
 */

/** The far side of a served `T`: the same surface, and the close that ends the connection. */
export type Remote<T> = T & { close(): void };
