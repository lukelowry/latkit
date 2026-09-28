/**
 * A recording served across a port: its declaration and clock arrive with the connection, so
 * `frameAt`, `timeAt`, and every series' `locate` answer on the far side at once, and only sample
 * windows travel afterwards. The recording's own source is what crosses: `openRecording` does the
 * rest on the far side.
 */

import { openRecording, type Recording, type RecordingSource } from '@latkit/model';

import { connect, serve, transferred, type Remote } from './channel.js';
import { check } from './check.js';
import type { Port } from './port.js';
import { protocol } from './protocol.js';

type Window = Parameters<RecordingSource['read']>[2];
type Description = Awaited<ReturnType<RecordingSource['describe']>>;
type Change = RecordingSource['changes'] extends (signal?: AbortSignal) => AsyncIterable<infer C>
  ? C
  : never;
type Block = Awaited<ReturnType<RecordingSource['read']>>;

type Request =
  | { readonly op: 'describe' }
  | { readonly op: 'changes' }
  | {
      readonly op: 'read';
      readonly classId: string;
      readonly signalIndex: number;
      readonly window: Window;
    };

const recordingProtocol = (id: string) =>
  protocol<Request, Description | Change | Block>(
    `recording:${id}`,
    check.requests<Request>({
      describe: {},
      changes: {},
      read: {
        classId: check.string,
        signalIndex: check.index,
        window: check.object<Window>({
          frameOffset: check.index,
          frameCount: check.index,
          elementOffset: check.index,
          elementCount: check.index,
        }),
      },
    }),
  );

/**
 * Serve one recording until either side closes. Sample windows are capped at `maxBytes` (4 MiB by
 * default), time included. Returns the server's own close.
 *
 * @throws Error when the recording has no id; RangeError when `maxBytes` is below 16.
 */
export function serveRecording(
  port: Port,
  recording: Recording,
  options: { readonly maxBytes?: number; onClose?(): void } = {},
): () => void {
  if (!recording?.id) throw new Error('a recording needs an id');
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16)
    throw new RangeError('maxBytes must be an integer of at least 16');
  const source = recording.source();
  const service = serve(
    port,
    recordingProtocol(recording.id),
    (request, signal) => {
      switch (request.op) {
        case 'describe':
          return source.describe(signal);
        case 'changes':
          return owned(source.changes(signal));
        case 'read': {
          const { frameCount, elementCount } = request.window;
          if (frameCount * (elementCount + 1) * 8 > maxBytes)
            return Promise.reject(new RangeError('sample window exceeds maxBytes'));
          return source
            .read(request.classId, request.signalIndex, request.window, signal)
            .then((block) =>
              transferred(block, [
                block.time.buffer as ArrayBuffer,
                block.values.buffer as ArrayBuffer,
              ]),
            );
        }
      }
    },
    {
      onClose: () => {
        source.close?.();
        options.onClose?.();
      },
    },
  );
  return () => service.close();
}

/** Each change as the caller's own: its buffers cross without a copy. */
async function* owned(changes: AsyncIterable<Change>) {
  for await (const change of changes) {
    const buffers = [change.time.buffer as ArrayBuffer];
    for (const range of Object.values(change.ranges))
      if (range) buffers.push(range.buffer as ArrayBuffer);
    yield transferred(change, buffers);
  }
}

/**
 * Open the recording a `serveRecording` peer serves as `id`: its clock and every class's shape
 * arrive before this resolves, and its series follow the peer's changes until it is closed, which
 * closes the connection.
 *
 * @throws Error when `id` is empty, or the peer cannot open the recording.
 */
export async function connectRecording(
  port: Port,
  id: string,
  signal?: AbortSignal,
): Promise<Remote<Recording>> {
  if (!id) throw new Error('a recording needs an id');
  const connection = connect(port, recordingProtocol(id));
  return openRecording(
    {
      describe: (describing) =>
        connection.call({ op: 'describe' }, { signal: describing }) as Promise<Description>,
      changes: (following) =>
        connection.stream({ op: 'changes' }, { signal: following }) as AsyncIterable<Change>,
      read: (classId, signalIndex, window, reading) =>
        connection.call(
          { op: 'read', classId, signalIndex, window },
          { signal: reading },
        ) as Promise<Block>,
      close: () => connection.close(),
    },
    signal,
  );
}
