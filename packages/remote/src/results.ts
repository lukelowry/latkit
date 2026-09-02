/**
 * A run's results as a port service. The side that holds the recorded samples serves them; the
 * other side reads the same `Results`, one class's batches per stream. Batches are self-describing,
 * so nothing is published ahead of a read and nothing is versioned: a read asks, the batches
 * answer, the stream ends.
 */

import type { Results, RunFrames } from '@latkit/model';
import { connect, type Port, type Protocol, protocol, serve } from '@latkit/port';
import { arrayOf, index, nullable, object, str } from '@latkit/port/guard';

import type { Remote } from './remote.js';

type Request = { readonly classId: string; readonly signals: readonly number[] | null };

/** The one `results` protocol; its guard bounds a selection only where the served side asks. */
const resultsProtocol = (maxSignals = Infinity): Protocol<Request, RunFrames> =>
  protocol<Request, RunFrames>(
    'results',
    object<Request>({ classId: str, signals: nullable(arrayOf(index, maxSignals)) }),
  );

/**
 * Serve `results` on `port` until the returned close is called. Each read is one stream of its
 * batches; the service awaits the port's drain between them and aborts the read when the caller
 * stops or the connection closes.
 *
 * @param options - `maxSignals` caps how many signals one read may select; unbounded when omitted.
 */
export function serveResults(
  port: Port,
  results: Results,
  options: { readonly maxSignals?: number } = {},
): () => void {
  const service = serve(port, resultsProtocol(options.maxSignals), (request, signal) =>
    results.read(request.classId, request.signals, signal),
  );
  return () => service.close();
}

/** Read the results a `serveResults` peer holds. Closing ends every read in flight. */
export function connectResults(port: Port): Remote<Results> {
  const connection = connect(port, resultsProtocol());
  return {
    read: (classId, signals, signal) => connection.stream({ classId, signals }, { signal }),
    close: () => connection.close(),
  };
}
