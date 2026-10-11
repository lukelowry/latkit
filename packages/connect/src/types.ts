import type { Command, Query, Model } from '@latkit/model';

/** A publication as it travels: the frame from byte 16 on (two lengths, metadata, padding, body). */
export interface EncodedPublication {
  readonly bytes: Uint8Array;
}
interface Endpoint {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<Connection.Limits>;
}
export interface Connection {
  readonly closed: Promise<void>;
  close(reason?: { readonly code: string; readonly message: string }): Promise<void>;
}
export declare namespace Connection {
  /** Dial exactly `url`, or answer on a `socket` a server accepted. */
  type Options = Endpoint &
    (
      | { readonly url: string | URL; readonly socket?: never }
      | { readonly socket: Socket; readonly url?: never }
    );
  /** Dial exactly `url`, or answer on a `socket` a server accepted. */
  type AcceptOptions = Options;
  interface Limits {
    readonly messageBytes: number;
    readonly metadataBytes: number;
    readonly bufferedBytes: number;
    readonly bufferedMessages: number;
    readonly streamWindowBytes: number;
    readonly streamWindowMessages: number;
    readonly streams: number;
    readonly publicationBatches: number;
    readonly logs: number;
    /** Registration, cancellation response, close notification and cleanup deadlines; never a flow-control timeout. */
    readonly timeoutMs: number;
  }
  /** Structural subset shared by browser, Node built-in, and ws WebSockets. */
  interface Socket {
    readonly readyState: number;
    readonly protocol: string;
    readonly bufferedAmount: number;
    binaryType: string;
    send(data: Uint8Array<ArrayBuffer>): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: (event: { readonly reason?: string }) => void): void;
    addEventListener(type: 'open' | 'error', listener: () => void): void;
    removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    removeEventListener(
      type: 'close',
      listener: (event: { readonly reason?: string }) => void,
    ): void;
    removeEventListener(type: 'open' | 'error', listener: () => void): void;
  }
}
/** The model a connection carries. Reading and running it go over the socket; connectModel serves
 *  it onward as it is. */
export interface ConnectedModel extends Model, Connection {
  /** Absent when the model offers no reading. An empty selection reads nothing. */
  readonly monitor?: (
    fields: readonly Query.Selection[],
    context?: Partial<Model.MonitorContext>,
  ) => AsyncIterableIterator<Model.Publication>;
  /** Each run goes to the model, its values checked against the command's parameters; whoever runs
   *  it supplies `publish` for the outputs it asks for, and may supply `progress`, `log`, and
   *  `signal`. */
  readonly commands: Readonly<
    Record<
      string,
      Command.Description & {
        run(
          values: Command.Arguments<Command.Parameters> | Readonly<Record<string, Command.Input>>,
          context?: Partial<Command.Context>,
        ): Promise<Command.Result>;
      }
    >
  >;
}
