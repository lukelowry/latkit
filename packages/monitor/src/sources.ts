import type { Queryable, SampleWindow } from '@latkit/model';
import type { HistoryRequest } from './history.js';
import { binding } from './bindings.js';
import { wait } from './async.js';

/** Reuse a bounded acquisition across matching history, resize and focus work. */
export class Sources {
  private entries = new Map<
    Queryable,
    {
      key: string;
      users: number;
      retired: boolean;
      control: AbortController;
      value: Promise<Queryable>;
    }
  >();
  private closed = false;
  async acquire(request: Omit<HistoryRequest, 'signal'>, signal: AbortSignal) {
    const window: SampleWindow = request.frames
      ? { kind: 'frames', ...request.frames }
      : {
          ...request.window,
          context: {
            before: Math.max(1, request.window.context?.before ?? 0),
            after: Math.max(1, request.window.context?.after ?? 0),
          },
        };
    const originals = new Set([request.data.source]);
    for (const item of request.bindings) {
      originals.add(item.source);
      for (const field of Object.values(item.fields)) {
        const ref = binding(field, request.data.source, item.trace.from);
        if (ref) originals.add(ref.source);
      }
    }
    const releases: (() => void)[] = [],
      acquired = new Map<Queryable, Queryable>();
    const release = () => {
      for (const dispose of releases.splice(0)) dispose();
    };
    try {
      for (const source of originals) {
        signal.throwIfAborted();
        const key = JSON.stringify([source.version, window]);
        let entry = this.entries.get(source);
        if (!entry || entry.key !== key) {
          if (entry) this.retire(entry);
          const control = new AbortController();
          entry = {
            key,
            control,
            users: 0,
            retired: false,
            value: (async () => {
              const schema = await source.describe({ signal: control.signal });
              return source.retain({
                signal: control.signal,
                ...(schema.axis ? { window } : {}),
                maxBytes: request.limits.historyBytes,
              });
            })(),
          };
          this.entries.set(source, entry);
          const own = entry;
          void entry.value.catch(() => {
            if (this.entries.get(source) === own) this.entries.delete(source);
          });
        }
        entry.users++;
        const own = entry;
        releases.push(() => {
          own.users--;
          if (own.retired && !own.users) {
            own.control.abort();
            void own.value.then((v) => v.close()).catch(() => {});
          }
        });
        const fixed = await wait(entry.value, signal);
        if (this.closed) throw new DOMException('Monitor destroyed', 'AbortError');
        acquired.set(source, fixed);
      }
      const bindings = request.bindings.map((item) => ({
        ...item,
        source: acquired.get(item.source)!,
        fields: Object.fromEntries(
          Object.entries(item.fields).map(([name, value]) => {
            const ref = binding(value, request.data.source, item.trace.from);
            return [name, ref ? { ...ref, source: acquired.get(ref.source)! } : value];
          }),
        ),
      }));
      return {
        request: {
          ...request,
          data: { ...request.data, source: acquired.get(request.data.source)! },
          bindings,
          focus: request.focus
            ? { ...request.focus, source: acquired.get(request.focus.source)! }
            : undefined,
        },
        originals: new Map([...acquired].map(([original, fixed]) => [fixed, original])),
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  private retire(entry: {
    retired: boolean;
    users: number;
    control: AbortController;
    value: Promise<Queryable>;
  }) {
    entry.retired = true;
    if (!entry.users) {
      entry.control.abort();
      void entry.value.then((v) => v.close()).catch(() => {});
    }
  }
  prune(sources: ReadonlySet<Queryable>) {
    for (const [source, entry] of this.entries)
      if (!sources.has(source)) {
        this.entries.delete(source);
        this.retire(entry);
      }
  }
  destroy() {
    this.closed = true;
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
  }
}
