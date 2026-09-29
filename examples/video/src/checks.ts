import { exportVideo, type Options, type Scene, type VideoWrite } from '@latkit/video';
import { Series, type Domain } from '@latkit/model';

/** Browser-only lifecycle checks, callable from the example or automation. */
export async function checkLifecycle(): Promise<string[]> {
  const passed: string[] = [];
  const NativeWorker = globalThis.Worker;
  const workers = new Set<Worker>();
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.add(this);
    }
    override terminate(): void {
      workers.delete(this);
      super.terminate();
    }
  };
  const series = Series.create({ signals: ['x'], elementCount: 2 });
  series.append({
    time: new Float64Array([0, 1, 2]),
    values: new Float32Array([0, 1, 1, 0, 0, 1]),
  });
  series.seal();
  const scene: Scene = {
    kind: 'network',
    topology: {
      vertexCount: 2,
      vertexCoords: new Float32Array([0, 0, 1, 1]),
      edges: new Uint32Array([0, 1]),
      polylineStart: new Uint32Array([0, 0]),
    },
    channels: { vertexColor: { values: { series, signal: 0 }, domain: [0, 1] } },
  };
  const options: Options & { output?: undefined } = {
    views: [scene],
    timeRange: [0, 2],
    width: 320,
    height: 180,
    frameRate: 30,
  };
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };
  const rejects = async (run: () => Promise<unknown>, match: string): Promise<void> => {
    let failure: unknown;
    try {
      await run();
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error && `${failure.name}: ${failure.message}`.includes(match),
      `Expected ${match}, received ${String(failure)}`,
    );
    assert(workers.size === 0, 'An export leaked its worker');
  };
  try {
    await rejects(() => exportVideo({ ...options, width: 3 }), 'even');
    passed.push('invalid settings start no worker');
    const abort = new AbortController();
    let closed = false,
      aborted = false;
    const destination = new WritableStream<VideoWrite>({
      write() {},
      close() {
        closed = true;
      },
      abort() {
        aborted = true;
      },
    });
    await rejects(
      () =>
        exportVideo({
          ...options,
          output: destination,
          signal: abort.signal,
          onProgress() {
            abort.abort();
          },
        }),
      'AbortError',
    );
    assert(
      aborted && !closed && !destination.locked,
      'Cancelled export committed or retained the sink',
    );
    passed.push('mid-export cancellation aborts sink and releases worker/lock');
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sourceAborted = false;
    class Stalled extends Series {
      constructor() {
        super(series);
        this.publish(series.state);
      }
      locate(range: Domain, count: number, signal?: AbortSignal) {
        return series.locate(range, count, signal);
      }
      protected fetch(
        _index: number,
        _window: Series.Window,
        signal?: AbortSignal,
      ): Promise<Series.Block> {
        entered();
        return new Promise((_resolve, reject) =>
          signal!.addEventListener(
            'abort',
            () => {
              sourceAborted = true;
              reject(new DOMException('Read cancelled', 'AbortError'));
            },
            { once: true },
          ),
        );
      }
    }
    const cancellation = new AbortController();
    const stalled = exportVideo({
      ...options,
      views: [{ kind: 'monitor', series: new Stalled(), signal: 0 }],
      signal: cancellation.signal,
    });
    await reading;
    cancellation.abort();
    await rejects(() => stalled, 'AbortError');
    assert(sourceAborted, 'Source read did not receive cancellation');
    passed.push('stalled monitor reads cancel across the port');
    class Broken extends Stalled {
      protected override fetch(): Promise<Series.Block> {
        return Promise.reject(new Error('deliberate source failure'));
      }
    }
    await rejects(
      () =>
        exportVideo({ ...options, views: [{ kind: 'monitor', series: new Broken(), signal: 0 }] }),
      'deliberate source failure',
    );
    passed.push('source failures reject without hanging');
    const failedSink = new WritableStream<VideoWrite>({
      write() {
        throw new Error('deliberate sink failure');
      },
    });
    await rejects(() => exportVideo({ ...options, output: failedSink }), 'deliberate sink failure');
    assert(!failedSink.locked, 'Failed sink remains locked');
    passed.push('sink failures reject and release ownership');
    const empty = Series.create({ signals: ['x'], elementCount: 1 });
    await rejects(
      () => exportVideo({ ...options, views: [{ kind: 'monitor', series: empty, signal: 0 }] }),
      'empty monitor',
    );
    passed.push('empty histories fail explicitly');
    const video = await exportVideo(options);
    assert(
      video.size > 0 && workers.size === 0,
      'Export did not recover after cancelled/failed jobs',
    );
    const sample = await series.read(0, {
      frameOffset: 0,
      frameCount: 3,
      elementOffset: 0,
      elementCount: 2,
    });
    assert(
      sample.values.length === 6 && sample.values[1] === 1,
      'Export damaged borrowed series buffers',
    );
    passed.push('successful export after failures preserves borrowed data');
    return passed;
  } finally {
    for (const worker of workers) worker.terminate();
    globalThis.Worker = NativeWorker;
  }
}
