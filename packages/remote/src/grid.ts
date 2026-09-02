/**
 * A grid as a port service. The server publishes the grid's header (columns and row count) and
 * answers windows and lookups; the client exposes each published grid as the same `Grid` shape a
 * table primitive binds directly. Windows carry no version: the port is ordered and a header
 * always precedes the windows answered under it, so the heavy work stays where the data is and
 * only windows of display text cross.
 */

import type { Grid, GridSort, GridWindow } from '@latkit/model';
import { connect, type Port, type Protocol, protocol, serve } from '@latkit/port';
import { bounded, index, nullable, object, oneOf, requests, str } from '@latkit/port/guard';

/** The most rows one window may ask for. */
const MAX_WINDOW = 4096;

/** What a client needs to bind a grid: its columns and row count. */
export interface GridHeader {
  readonly rowCount: number;
  readonly columns: readonly { readonly id: string; readonly label: string }[];
}

type Request =
  | { readonly op: 'describe' }
  | {
      readonly op: 'window';
      readonly query: string;
      readonly sort: GridSort | null;
      readonly offset: number;
      readonly limit: number;
    }
  | {
      readonly op: 'locate';
      readonly index: number;
      readonly query: string;
      readonly sort: GridSort | null;
    };

/** The served state at one version: a header, or nothing served. */
interface Described {
  readonly version: number;
  readonly header: GridHeader | null;
}

type Reply = Described | GridWindow | number | null;

const EMPTY: GridWindow = { rows: [], total: 0 };

const isSort = object<{ column: string | null; dir: 'asc' | 'desc' }>({
  column: nullable(str),
  dir: oneOf(['asc', 'desc']),
});

const isRequest = requests<Request>({
  describe: {},
  window: { query: str, sort: nullable(isSort), offset: index, limit: bounded(MAX_WINDOW) },
  locate: { index, query: str, sort: nullable(isSort) },
});

const gridProtocol = (name: string): Protocol<Request, Reply, Described> =>
  protocol<Request, Reply, Described>(`grid:${name}`, isRequest);

/** The served side of one named grid. */
export interface GridServer {
  /** Serve a different grid (or none); the previous one is disposed. */
  set(grid: Grid | null, header?: GridHeader): void;
  close(): void;
}

/** Serve one named grid on `port`. */
export function serveGrid(port: Port, name: string): GridServer {
  let grid: Grid | null = null;
  let header: GridHeader | null = null;
  let version = 0;
  const describe = (): Described => ({ version, header: grid ? header : null });
  const service = serve(port, gridProtocol(name), async (request, signal) => {
    if (request.op === 'describe') return describe();
    const answering = grid;
    const nothing = request.op === 'locate' ? null : EMPTY;
    if (!answering) return nothing;
    try {
      return request.op === 'locate'
        ? await answering.locate(request.index, request.query, request.sort, signal)
        : await answering.window(
            request.query,
            request.sort,
            request.offset,
            request.limit,
            signal,
          );
    } catch (error) {
      // The grid was replaced under this request: the client already holds the newer header and
      // re-asks; an empty answer is not an error.
      if (answering !== grid && (error as Error).name === 'AbortError') return nothing;
      throw error;
    }
  });
  const publish = (): void => service.emit(describe());
  return {
    set(next, nextHeader) {
      if (next && !nextHeader) throw new Error('a served grid needs a header');
      grid?.dispose();
      grid = next;
      header = nextHeader ?? null;
      version++;
      publish();
    },
    close() {
      grid?.dispose();
      grid = null;
      service.close();
    },
  };
}

/**
 * Connect to one named grid: `onGrid` receives a fresh binding for every published header (the
 * `Grid` queries plus the header), null when nothing is served. Returns the unsubscribe, which
 * also closes the connection.
 */
export function connectGrid(
  port: Port,
  name: string,
  onGrid: (grid: (Grid & GridHeader) | null) => void,
): () => void {
  const connection = connect(port, gridProtocol(name));
  let latest = -1;
  const apply = ({ version, header }: Described): void => {
    if (version <= latest) return;
    latest = version;
    onGrid(
      header && {
        ...header,
        window: (query, sort, offset, limit, signal) =>
          connection.call(
            { op: 'window', query, sort, offset, limit },
            { signal },
          ) as Promise<GridWindow>,
        locate: (index, query, sort, signal) =>
          connection.call({ op: 'locate', index, query, sort }, { signal }) as Promise<
            number | null
          >,
        dispose: () => undefined,
      },
    );
  };
  const off = connection.on(apply);
  void connection.call({ op: 'describe' }).then(
    (reply) => apply(reply as Described),
    () => undefined,
  );
  return () => {
    off();
    connection.close();
  };
}
