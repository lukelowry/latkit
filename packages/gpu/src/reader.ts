import type { Query, Queryable, RequestOptions, Version } from '@latkit/model';
import type { FieldsRequest, NativeFields } from './binding.js';
import type { QueryResult } from './render.js';
import { Fields } from './fields.js';
import { Reads } from './data.js';
import { Memory, type Entry } from './memory.js';
import { GpuError, integer } from './error.js';
import type { UploadScope } from './uploads.js';

/** A bounded, device-independent native read session. Consume iterators before destroying. */
export interface NativeReader {
  readonly signal: AbortSignal;
  readonly at?: number;
  query<Q extends Query>(source: Queryable, query: Q): AsyncIterable<QueryResult<Q>>;
  fields(request: FieldsRequest): AsyncIterable<NativeFields>;
  scale(request: import('./scale.js').ScaleRequest): Promise<import('./scale.js').ResolvedScale>;
  check(): void;
  destroy(): void;
}

/** Uses the GPU's native field resolver and query validation without acquiring a device. */
export function createNativeReader(
  options: RequestOptions & {
    readonly at?: number;
    readonly maxBytes?: number;
    readonly maxBlockBytes?: number;
  } = {},
): NativeReader {
  const stopped = new AbortController();
  const signal = AbortSignal.any([stopped.signal, ...(options.signal ? [options.signal] : [])]);
  const memory = new Memory({ cpuBytes: options.maxBytes });
  const bytes = integer(options.maxBlockBytes ?? 1024 ** 2, 'block bytes', 1);
  const reads = new Reads(memory, bytes, true);
  const fields = new Fields(memory, bytes);
  const versions = new Map<Queryable, Version>();
  const subscriptions = new Map<Queryable, () => void>();
  const entries = new Set<Entry>();
  const checks: (() => void)[] = [];
  let closed = false;
  const observe = (source: Queryable) => {
    signal.throwIfAborted();
    if (!versions.has(source)) {
      versions.set(source, source.version);
      subscriptions.set(
        source,
        source.on('change', (change) => {
          if (change.kind === 'closed') stopped.abort(new GpuError('closed', 'Read source closed'));
        }),
      );
    }
  };
  const check = () => {
    signal.throwIfAborted();
    for (const [source, version] of versions)
      if (source.version !== version) throw new GpuError('conflict', 'Read source changed');
    for (const validate of checks) validate();
  };
  const query = async function* <Q extends Query>(
    source: Queryable,
    request: Q,
  ): AsyncGenerator<QueryResult<Q>> {
    observe(source);
    for await (const block of reads.query(source, request, signal)) {
      if (block.kind === 'schema' && block.version !== versions.get(source))
        throw new GpuError('conflict', 'Read observed different source versions');
      yield block as QueryResult<Q>;
    }
    check();
  };
  const scope: UploadScope = {
    use(entry) {
      if (!entries.has(entry)) {
        entry.pin();
        entries.add(entry);
      }
    },
    check(fn) {
      checks.push(fn);
    },
    copy() {
      throw new GpuError('invalid-input', 'Native reads cannot copy GPU resources');
    },
  };
  const context = { query, signal, at: options.at, observe };
  return {
    signal,
    at: options.at,
    query,
    check,
    async scale(request) {
      const result = await fields.scale(request, context, scope);
      check();
      return result;
    },
    async *fields(request) {
      for await (const tile of fields.prepare(request, context, scope)) {
        check();
        yield { ...tile, versions: new Map(versions) };
      }
    },
    destroy() {
      if (closed) return;
      closed = true;
      stopped.abort(new DOMException('Read session closed', 'AbortError'));
      for (const off of subscriptions.values()) off();
      for (const entry of entries) entry.unpin();
      reads.destroy();
      memory.destroy();
    },
  };
}
