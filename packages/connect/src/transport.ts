/** Ordered, reliable messages. send resolves after transport acceptance, not peer consumption. */
export interface Transport {
  readonly transfers: boolean;
  send(message: unknown, transfer?: readonly ArrayBuffer[]): Promise<void>;
  subscribe(receive: (message: unknown) => void, ended: (error?: Error) => void): () => void;
  close(): Promise<void>;
}
