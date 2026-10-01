import type { Index, RowAxis, RowSelection } from '../../src/index.js';
import { RetainedBudget } from '../retention.js';
import { failure, axisAt, axisLength } from '../source.js';
export { failure, axisAt, axisLength };
export interface Metrics {
  generatedBytes: number;
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
  acquisitions: number;
}
export const metrics = (): Metrics => ({
  generatedBytes: 0,
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
  acquisitions: 0,
});
/** Deliberately simple deterministic data, checked independently by the test oracle. */
export class Store {
  readonly index: Index;
  private base = new Map<number, Float64Array>();
  private held = new Map<object, number>();
  private waiting?: ReturnType<typeof deferred<void>>;
  constructor(
    readonly id: string,
    readonly rows: number,
    readonly pageRows: number,
    readonly stats: Metrics,
    readonly retention = new RetainedBudget(),
  ) {
    if (
      !Number.isSafeInteger(rows) ||
      rows < 1 ||
      rows > 0xffffffff ||
      !Number.isSafeInteger(pageRows) ||
      pageRows < 1
    )
      throw failure('invalid-input');
    this.index = { source: id, type: 'Node', version: '1' };
  }
  page(index: number): Float64Array {
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
  at(row: number): number {
    return this.page(Math.floor(row / this.pageRows))[row % this.pageRows];
  }
  select(selection?: RowSelection): RowAxis {
    if (!selection) return { kind: 'range', offset: 0, count: this.rows };
    if (selection.kind === 'ids')
      return { kind: 'indices', values: Uint32Array.from(selection.ids, (id) => this.row(id)) };
    if (
      selection.index &&
      (selection.index.source !== this.id ||
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
  /** Test control: hold every read and command at its next step until resumed. */
  pause(paused: boolean): void {
    if (paused) this.waiting ??= deferred();
    else {
      this.waiting?.resolve();
      this.waiting = undefined;
    }
  }
  get gate(): Promise<void> | undefined {
    return this.waiting?.promise;
  }
  /** Count frames once however many monitors and retained reads hold them. */
  hold(frames: readonly { readonly values: Float64Array }[]): () => void {
    for (const frame of frames) {
      const count = this.held.get(frame) ?? 0;
      this.held.set(frame, count + 1);
      if (count) continue;
      this.stats.frameBytes += frame.values.byteLength + 8;
      this.stats.peakFrameBytes = Math.max(this.stats.peakFrameBytes, this.stats.frameBytes);
    }
    let held: typeof frames | undefined = frames;
    return () => {
      for (const frame of held ?? []) {
        const count = this.held.get(frame)!;
        if (count > 1) this.held.set(frame, count - 1);
        else {
          this.held.delete(frame);
          this.stats.frameBytes -= frame.values.byteLength + 8;
        }
      }
      held = undefined;
    };
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
