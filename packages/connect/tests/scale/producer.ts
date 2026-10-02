import {
  type Model,
  type Schema,
  type MonitorOptions,
  type FieldSelection,
  type DataEvent,
  type Commands,
  validateQuery,
} from '@latkit/model';
export interface Metrics {
  active: number;
  opened: number;
  released: number;
  blocks: number;
  generatedBytes: number;
  waiting: number;
}
/** Synthetic live producer: each subscription generates fresh values once, keeping no history. */
export class Producer implements Model {
  readonly name = 'Scale producer';
  readonly schema: Schema = {
    limits: { maxBlockBytes: 256 * 1024 },
    axis: { name: 'time' },
    types: {
      Node: { fields: { value: { type: 'float64' }, output: { type: 'float64', sampled: true } } },
    },
  };
  readonly commands: Commands = {
    routines: [{ id: 'echo', label: 'Echo', parameters: [] }],
    run: async (command, options = {}) => {
      options.signal?.throwIfAborted();
      return { routine: command.routine };
    },
  };
  readonly stats: Metrics = {
    active: 0,
    opened: 0,
    released: 0,
    blocks: 0,
    generatedBytes: 0,
    waiting: 0,
  };
  private paused = false;
  private wake = new Set<() => void>();
  private stops = new Set<AbortController>();
  constructor(
    readonly rows: number,
    readonly pageRows = 8192,
  ) {}
  inspect(): Metrics {
    return { ...this.stats };
  }
  pause(value: boolean): void {
    this.paused = value;
    if (!value) for (const wake of [...this.wake]) wake();
  }
  close(): void {
    for (const stop of this.stops) stop.abort();
    this.pause(false);
  }
  monitor(
    fields: readonly FieldSelection[],
    options: MonitorOptions = {},
  ): AsyncIterableIterator<DataEvent> {
    for (const field of fields)
      if (
        validateQuery(this.schema, {
          ...field,
          kind: 'rows',
          ...(field.select.includes('output') ? { at: 0 } : {}),
        }).length
      )
        throw Object.assign(new Error('Invalid selection'), { code: 'invalid-input' });
    const controller = new AbortController(),
      signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    this.stops.add(controller);
    this.stats.opened++;
    this.stats.active++;
    const { stats, wake, rows: totalRows } = this;
    const paused = () => this.paused;
    const bound = Math.min(options.maxBlockBytes ?? Infinity, this.schema.limits.maxBlockBytes),
      n = Math.max(1, Math.min(this.pageRows, Math.floor((bound - 512) / 8)));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.stops.delete(controller);
      stats.active--;
      stats.released++;
    };
    const check = () => {
      if (signal.aborted) throw Object.assign(new Error('Aborted'), { code: 'aborted' });
    };
    async function* generate(): AsyncGenerator<DataEvent> {
      try {
        check();
        yield { kind: 'begin', version: 'v1', initial: true };
        for (const field of fields)
          for (const name of field.select) {
            const nf = name === 'output' ? 3 : 1;
            for (let frame = 0; frame < nf; frame++)
              for (let offset = 0; offset < totalRows; offset += n) {
                check();
                if (paused()) {
                  stats.waiting++;
                  try {
                    await new Promise<void>((resolve, reject) => {
                      const done = () => {
                        wake.delete(done);
                        signal.removeEventListener('abort', abort);
                        resolve();
                      };
                      const abort = () => {
                        done();
                        reject(Object.assign(new Error('Aborted'), { code: 'aborted' }));
                      };
                      wake.add(done);
                      signal.addEventListener('abort', abort, { once: true });
                      if (signal.aborted) abort();
                    });
                  } finally {
                    stats.waiting--;
                  }
                }
                check();
                const count = Math.min(n, totalRows - offset),
                  values = new Float64Array(count);
                for (let i = 0; i < count; i++) values[i] = ((offset + i) % 1009) - 504;
                if (name === 'output')
                  for (let i = 0; i < count; i++) values[i] = values[i] * 2 + frame;
                const base = {
                  index: { source: 'scale', type: 'Node', version: 'rows1' },
                  rows: { kind: 'range' as const, offset, count },
                };
                stats.blocks++;
                stats.generatedBytes += values.byteLength;
                yield {
                  kind: 'data',
                  version: 'v1',
                  block:
                    name === 'value'
                      ? {
                          ...base,
                          kind: 'rows',
                          columns: { value: { kind: 'numeric', offset: 0, length: count, values } },
                        }
                      : {
                          ...base,
                          kind: 'samples',
                          firstFrame: frame,
                          coordinates: Float64Array.of(frame),
                          columns: {
                            output: {
                              kind: 'numeric',
                              offset: 0,
                              length: count,
                              values,
                              rowStride: 1,
                              frameStride: count,
                            },
                          },
                        },
                };
              }
          }
        yield { kind: 'end', version: 'v1' };
      } finally {
        release();
      }
    }
    const iterator = generate();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => iterator.next(),
      return: async () => {
        controller.abort();
        release();
        return iterator.return(undefined);
      },
      throw: async (error) => {
        controller.abort();
        release();
        return iterator.throw(error);
      },
    };
  }
}
