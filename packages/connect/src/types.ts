import type {
  Arguments,
  CommandDescription,
  CommandResult,
  DataBatch,
  Diagnostic,
  FieldSelection,
  InputValue,
  LogEntry,
  Parameters,
  Progress,
  Schema,
} from '@latkit/model';

/** A bounded group is delivered atomically. A large model is many publications. */
export type Publication = readonly DataBatch[];
export interface EncodedPublication {
  readonly bytes: Uint8Array;
}
export interface Publish {
  (batch: DataBatch | Publication): Promise<void>;
}
export interface MonitorContext {
  readonly signal: AbortSignal;
  readonly maxBatchBytes: number;
}
export interface CommandContext extends MonitorContext {
  readonly outputs: readonly FieldSelection[];
  readonly publish: Publish;
  /** Coalesces pending updates. Does not block the solver. */
  progress(value: Progress): void;
  /** Bounded diagnostics; dropped entries are reported to the host. */
  log(value: Diagnostic): void;
}
export interface Command<P extends Parameters = Parameters> extends CommandDescription<P> {
  run(
    values: Arguments<P>,
    context: CommandContext,
  ): CommandResult | void | Promise<CommandResult | void>;
}
export interface Limits {
  readonly maxMessageBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedMessages: number;
  readonly streamWindowBytes: number;
  readonly streamWindowMessages: number;
  readonly maxStreams: number;
  readonly maxPublicationBatches: number;
  readonly maxLogs: number;
  readonly timeoutMs: number;
}
export interface ConnectOptions<C extends Record<string, Parameters> = Record<string, Parameters>> {
  readonly url: string | URL;
  readonly name: string;
  readonly schema: Schema;
  readonly monitor?: (
    fields: readonly FieldSelection[],
    context: MonitorContext,
  ) => Iterable<DataBatch | Publication> | AsyncIterable<DataBatch | Publication>;
  readonly commands?: {
    readonly [K in keyof C]: {
      readonly label?: string;
      readonly description?: string;
      readonly parameters: { readonly [P in keyof C[K]]: C[K][P] };
      run(
        values: Arguments<C[K]>,
        context: CommandContext,
      ): CommandResult | void | Promise<CommandResult | void>;
    };
  };
  readonly signal?: AbortSignal;
  readonly limits?: Partial<Limits>;
}
export interface Connection {
  readonly closed: Promise<void>;
  close(reason?: { readonly code: string; readonly message: string }): Promise<void>;
}
export interface MonitorOptions {
  readonly signal?: AbortSignal;
  readonly format?: 'decoded';
}
export interface EncodedMonitorOptions {
  readonly signal?: AbortSignal;
  readonly format: 'encoded';
}
interface RunBase {
  readonly signal?: AbortSignal;
  readonly outputs?: readonly FieldSelection[];
  readonly onProgress?: (value: Progress) => void;
  readonly onLog?: (value: LogEntry) => void;
}
export interface RunOptions extends RunBase {
  readonly format?: 'decoded';
  readonly onData?: (publication: Publication) => void | Promise<void>;
}
export interface EncodedRunOptions extends RunBase {
  readonly format: 'encoded';
  readonly onData?: (publication: EncodedPublication) => void | Promise<void>;
}
export interface ConnectedModel extends Connection {
  readonly name: string;
  readonly schema: Schema;
  readonly commands: Readonly<Record<string, CommandDescription>>;
  monitor(
    fields: readonly FieldSelection[],
    options: EncodedMonitorOptions,
  ): AsyncIterableIterator<EncodedPublication>;
  monitor(
    fields: readonly FieldSelection[],
    options?: MonitorOptions,
  ): AsyncIterableIterator<Publication>;
  run(
    command: string,
    values: Readonly<Record<string, InputValue>>,
    options: EncodedRunOptions,
  ): Promise<CommandResult>;
  run(
    command: string,
    values: Readonly<Record<string, InputValue>>,
    options?: RunOptions,
  ): Promise<CommandResult>;
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
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
}
export interface AcceptOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<Limits>;
}
