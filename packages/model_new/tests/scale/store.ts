import type { Index, RowAxis, RowSelection } from '../../src/index.js';
import { failure, axisAt, axisLength } from '../source.js';
export { failure, axisAt, axisLength };
export interface Metrics {
  generatedBytes: number;
  editCopiedBytes: number;
  ownedCopiedBytes: number;
  gatherCopiedBytes: number;
  waitingReads: number;
  waitingCommands: number;
  blocks: number;
  activeReads: number;
  peakReads: number;
  openedReads: number;
  releasedReads: number;
  frameBytes: number;
  peakFrameBytes: number;
  models: number;
  acquisitions: number;
}
export const metrics = (): Metrics => ({
  generatedBytes: 0,
  editCopiedBytes: 0,
  ownedCopiedBytes: 0,
  gatherCopiedBytes: 0,
  waitingReads: 0,
  waitingCommands: 0,
  blocks: 0,
  activeReads: 0,
  peakReads: 0,
  openedReads: 0,
  releasedReads: 0,
  frameBytes: 0,
  peakFrameBytes: 0,
  models: 0,
  acquisitions: 0,
});
export interface State {
  readonly version: string;
  readonly pages: ReadonlyMap<number, Float64Array>;
}
/** Deliberately simple deterministic data, checked independently by the test oracle. */
export class Store {
  readonly index: Index;
  private base = new Map<number, Float64Array>();
  state: State = { version: '1', pages: new Map() };
  constructor(
    readonly id: string,
    readonly rows: number,
    readonly pageRows: number,
    readonly stats: Metrics,
  ) {
    if (
      !Number.isSafeInteger(rows) ||
      rows < 1 ||
      rows > 0xffffffff ||
      !Number.isSafeInteger(pageRows) ||
      pageRows < 1
    )
      throw failure('invalid-input');
    this.index = { document: id, type: 'Node', version: '1' };
  }
  page(state: State, index: number): Float64Array {
    const edited = state.pages.get(index);
    if (edited) return edited;
    let page = this.base.get(index);
    if (!page) {
      const start = index * this.pageRows;
      page = new Float64Array(Math.min(this.pageRows, this.rows - start));
      for (let i = 0; i < page.length; i++) page[i] = ((start + i) % 1009) - 504;
      this.stats.generatedBytes += page.byteLength;
      this.base.set(index, page);
    }
    return page;
  }
  at(state: State, row: number): number {
    return this.page(state, Math.floor(row / this.pageRows))[row % this.pageRows];
  }
  select(selection?: RowSelection): RowAxis {
    if (!selection) return { kind: 'range', offset: 0, count: this.rows };
    if (selection.kind === 'ids')
      return { kind: 'indices', values: Uint32Array.from(selection.ids, (id) => this.row(id)) };
    if (
      selection.index &&
      (selection.index.document !== this.id ||
        selection.index.type !== 'Node' ||
        selection.index.version !== '1')
    )
      throw failure('conflict');
    if (selection.kind === 'range') {
      if (
        selection.offset < 0 ||
        selection.count < 0 ||
        selection.offset + selection.count > this.rows
      )
        throw failure('invalid-input');
      return { kind: 'range', offset: selection.offset, count: selection.count };
    }
    if (selection.values.some((row) => row >= this.rows)) throw failure('invalid-input');
    return { kind: 'indices', values: selection.values };
  }
  row(id: string): number {
    if (!/^n(0|[1-9][0-9]*)$/.test(id)) throw failure('invalid-input');
    const row = Number(id.slice(1));
    if (!Number.isSafeInteger(row) || row >= this.rows) throw failure('invalid-input');
    return row;
  }
  edit(changes: ReadonlyMap<number, number>): boolean {
    const pages = new Map(this.state.pages);
    const touched = new Set<number>();
    for (const [row, value] of changes) {
      if (this.at(this.state, row) === value) continue;
      const key = Math.floor(row / this.pageRows);
      if (!touched.has(key)) {
        const page = this.page(this.state, key).slice();
        pages.set(key, page);
        touched.add(key);
        this.stats.editCopiedBytes += page.byteLength;
      }
      pages.get(key)![row % this.pageRows] = value;
    }
    if (!touched.size) return false;
    this.state = { version: String(Number(this.state.version) + 1), pages };
    return true;
  }
  clear(): void {
    this.base.clear();
    this.state = { version: this.state.version, pages: new Map() };
  }
}
export const slice = (rows: RowAxis, offset: number, count: number): RowAxis =>
  rows.kind === 'range'
    ? { kind: 'range', offset: rows.offset + offset, count }
    : { kind: 'indices', values: rows.values.subarray(offset, offset + count) };
export function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export async function interrupt<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw failure('aborted');
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(failure('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
