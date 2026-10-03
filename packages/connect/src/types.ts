import type {
  Arguments,
  CommandContext,
  CommandDescription,
  CommandResult,
  FieldSelection,
  InputValue,
  Model,
  MonitorContext,
  Parameters,
  Publication,
} from '@latkit/model';

/** A publication as it travels: the frame from byte 16 on (two lengths, metadata, padding, body). */
export interface EncodedPublication {
  readonly bytes: Uint8Array;
}
export interface ConnectLimits {
  readonly maxMessageBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedMessages: number;
  readonly streamWindowBytes: number;
  readonly streamWindowMessages: number;
  readonly maxStreams: number;
  readonly maxPublicationBatches: number;
  readonly maxLogs: number;
  /** Registration, cancellation response, close notification and cleanup deadlines; never a flow-control timeout. */
  readonly timeoutMs: number;
}
interface Endpoint {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ConnectLimits>;
}
/** Dial exactly `url`, or answer on a `socket` a server accepted. */
export type ConnectOptions = Endpoint &
  (
    | { readonly url: string | URL; readonly socket?: never }
    | { readonly socket: WebSocketLike; readonly url?: never }
  );
/** Dial exactly `url`, or answer on a `socket` a server accepted. */
export type AcceptOptions = ConnectOptions;
export interface Connection {
  readonly closed: Promise<void>;
  close(reason?: { readonly code: string; readonly message: string }): Promise<void>;
}
/** The model a connection carries. Reading and running it go over the socket; connectModel serves
 *  it onward as it is. */
export interface ConnectedModel extends Model, Connection {
  /** Absent when the model offers no reading. An empty selection reads nothing. */
  readonly monitor?: (
    fields: readonly FieldSelection[],
    context?: Partial<MonitorContext>,
  ) => AsyncIterableIterator<Publication>;
  /** Each run goes to the model, its values checked against the command's parameters; whoever runs
   *  it supplies `publish` for the outputs it asks for, and may supply `progress`, `log`, and
   *  `signal`. */
  readonly commands: Readonly<
    Record<
      string,
      CommandDescription & {
        run(
          values: Arguments<Parameters> | Readonly<Record<string, InputValue>>,
          context?: Partial<CommandContext>,
        ): Promise<CommandResult>;
      }
    >
  >;
}
/** Structural subset shared by browser, Node built-in, and ws WebSockets. */
export interface WebSocketLike {
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
  removeEventListener(type: 'close', listener: (event: { readonly reason?: string }) => void): void;
  removeEventListener(type: 'open' | 'error', listener: () => void): void;
}
