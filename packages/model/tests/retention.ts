import type { RetainOptions, SampleWindow } from '../src/index.js';
import { failure } from './source.js';
export function retainOptions(options: RetainOptions): void {
  if (options.signal?.aborted) throw failure('aborted');
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
  )
    throw failure('invalid-input');
  const w: SampleWindow | undefined = options.window;
  if (w === undefined) return;
  if (!w || typeof w !== 'object') throw failure('invalid-input');
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (w.kind === 'frames') {
    if (!integer(w.offset) || !integer(w.count) || !integer(w.offset + w.count))
      throw failure('invalid-input');
  } else if (w.kind === 'at') {
    if (!Number.isFinite(w.value)) throw failure('invalid-input');
  } else if (w.kind === 'range') {
    if (
      !Array.isArray(w.between) ||
      w.between.length !== 2 ||
      !w.between.every(Number.isFinite) ||
      w.between[0] > w.between[1] ||
      (w.context !== undefined && (!w.context || typeof w.context !== 'object')) ||
      !integer(w.context?.before ?? 0) ||
      !integer(w.context?.after ?? 0)
    )
      throw failure('invalid-input');
  } else throw failure('invalid-input');
}
/** Budgets native retained allocations, not JS heap overhead or consumer-held returned blocks. */
export class RetainedBudget {
  private held = new Map<object, { bytes: number; count: number }>();
  bytes = 0;
  constructor(
    readonly limit = 512 * 1024 * 1024,
    readonly defaultLimit = 256 * 1024 * 1024,
  ) {}
  acquire(backing: ReadonlyMap<object, number>, maxBytes = this.defaultLimit): () => void {
    let total = 0,
      added = 0;
    for (const [key, bytes] of backing) {
      total += bytes;
      if (!this.held.has(key)) added += bytes;
    }
    if (total > maxBytes || this.bytes + added > this.limit) throw failure('resource-limit');
    for (const [key, bytes] of backing) {
      const held = this.held.get(key);
      if (held) held.count++;
      else this.held.set(key, { bytes, count: 1 });
    }
    this.bytes += added;
    let keys: object[] | undefined = [...backing.keys()];
    return () => {
      if (!keys) return;
      const releasing = keys;
      keys = undefined;
      for (const key of releasing) {
        const held = this.held.get(key)!;
        if (--held.count === 0) {
          this.held.delete(key);
          this.bytes -= held.bytes;
        }
      }
    };
  }
}
