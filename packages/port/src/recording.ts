/**
 * A recording served across a port: its classes and clock arrive with the connection, so
 * `frameAt`, `timeAt`, and every series' `locate` answer on the far side at once, and only sample
 * windows travel afterwards. The recording's own source is what crosses: `Recording.from` does the
 * rest on the far side, against the model the recording records.
 */

import { Recording, type Model, type Series } from '@latkit/model';

import { connect, serve, transferred, type Remote } from './channel.js';
import { check } from './check.js';
import type { Port } from './port.js';
import { protocol } from './protocol.js';

type Description = Awaited<ReturnType<Recording.Source['describe']>>;

type Request =
  | { readonly op: 'describe' }
  | { readonly op: 'changes' }
  | {
      readonly op: 'read';
      readonly classId: string;
      readonly signalIndex: number;
      readonly window: Series.Window;
    };

/** The most one sample window carries, time included: four times what any latkit reader asks. */
const MAX_BYTES = 4 << 20;

const recordingProtocol = (id: string) =>
  protocol<Request, Description | Recording.Change | Series.Block>(
    `recording:${id}`,
    check.requests<Request>({
      describe: {},
      changes: {},
      read: {
        classId: check.string,
        signalIndex: check.index,
        window: check.object<Series.Window>({
          frameOffset: check.index,
          frameCount: check.index,
          elementOffset: check.index,
          elementCount: check.index,
        }),
      },
    }),
  );

/**
 * Serve one recording until either side closes. A sample window carries at most 4 MiB, time
 * included. Returns the server's own close.
 *
 * @throws Error when the recording has no id.
 */
export function serveRecording(
  port: Port,
  recording: Recording,
  options: { onClose?(): void } = {},
): () => void {
  if (!recording?.id) throw new Error('a recording needs an id');
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
          if (frameCount * (elementCount + 1) * 8 > MAX_BYTES)
            return Promise.reject(new RangeError('sample window exceeds 4 MiB'));
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
async function* owned(changes: AsyncIterable<Recording.Change>) {
  for await (const change of changes) {
    const buffers = [change.time.buffer as ArrayBuffer];
    for (const range of Object.values(change.ranges))
      if (range) buffers.push(range.buffer as ArrayBuffer);
    yield transferred(change, buffers);
  }
}

/**
 * Open the recording of `model` a `serveRecording` peer serves as `id`: its classes and clock
 * arrive before this resolves, and its series follow the peer's changes until it is stopped;
 * closing it closes the connection.
 *
 * @throws Error when `id` is empty, the peer cannot open the recording, or it does not fit `model`.
 */
export async function connectRecording(
  port: Port,
  model: Model,
  id: string,
  signal?: AbortSignal,
): Promise<Remote<Recording>> {
  if (!id) throw new Error('a recording needs an id');
  const connection = connect(port, recordingProtocol(id));
  return Recording.from(
    model,
    {
      describe: (describing) =>
        connection.call({ op: 'describe' }, { signal: describing }) as Promise<Description>,
      changes: (following) =>
        connection.stream(
          { op: 'changes' },
          { signal: following },
        ) as AsyncIterable<Recording.Change>,
      read: (classId, signalIndex, window, reading) =>
        connection.call(
          { op: 'read', classId, signalIndex, window },
          { signal: reading },
        ) as Promise<Series.Block>,
      close: () => connection.close(),
    },
    signal,
  );
}
