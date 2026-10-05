import {
  interruptible,
  failure,
  type Reader,
  type ReadScope,
  type ReadRecord,
  type MemoryEntry,
  type Memory,
} from '@latkit/model';
import { integer } from '../error.js';
import type { CopyJob } from '../fields/pages.js';
import type { Uploader, UploadScope } from '../fields/upload.js';
import type { Colormaps } from '../colors/preparation.js';
import type { Buffers } from '../memory/buffers.js';
import { BufferData } from '../memory/buffer-data.js';
import type { Images } from '../memory/images.js';
import { TextureData } from '../memory/texture-data.js';
import type { Textures } from '../memory/textures.js';
import { shadeUniforms } from '../style/shade.js';
import type { TextAtlas } from '../text/atlas.js';
import type { Uniforms } from './uniforms.js';
import {
  targetResources,
  type CapturedFrame,
  type FrameInfo,
  type Preparation,
  type PreparedFrame,
  type Renderer,
  type RenderOptions,
} from './render.js';

/** What memoized work held and bound, and what it depended on, as it was built. */
interface Recording {
  readonly held: Set<MemoryEntry>;
  readonly buffers: Map<BufferData, number>;
  readonly reads: ReadRecord;
}
export interface Memo extends Recording {
  readonly deps: readonly unknown[];
  readonly at: number | undefined;
  readonly value: unknown;
}
/** What one frame borrows from its Gpu. */
export interface FrameOwner {
  readonly device: GPUDevice;
  readonly reader: Reader;
  readonly memory: Memory;
  readonly uploader: Uploader;
  readonly uniforms: Uniforms;
  readonly colormaps: Colormaps;
  readonly text: TextAtlas;
  readonly images: Images;
  readonly textures: Textures;
  readonly buffers: Buffers;
  readonly stopped: AbortSignal;
  /** Renderers with a preparation in progress. */
  readonly busy: Set<Renderer>;
  /** Each renderer's memoized work, by slot. */
  readonly memos: WeakMap<Renderer, Map<unknown, Memo>>;
  /** Submitted work not yet done. */
  readonly pending: Set<Promise<void>>;
  readonly maxFrames: number;
  stop(reason: unknown): void;
}

/** Capture every view, prepare them concurrently, then encode and submit one command buffer. */
export async function renderFrame(owner: FrameOwner, options: RenderOptions): Promise<void> {
  owner.stopped.throwIfAborted();
  if (!Number.isFinite(options.timeMs)) throw failure('invalid-input', 'Frame time must be finite');
  const renderers = new Set(options.views.map((view) => view.renderer));
  if (renderers.size !== options.views.length)
    throw failure('invalid-input', 'A renderer may appear only once in a frame');
  for (const renderer of renderers)
    if (owner.busy.has(renderer))
      throw failure('busy', 'Renderer already has a preparation in progress');
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    owner.stopped,
    cancelled.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const infos = options.views.map((view): FrameInfo => {
    if (view.target.device !== owner.device)
      throw failure('invalid-input', 'Target belongs to a different device');
    integer(view.target.width, 'target width', 1);
    integer(view.target.height, 'target height', 1);
    if (view.at !== undefined && !Number.isFinite(view.at))
      throw failure('invalid-input', 'Model coordinate must be finite');
    const viewport = view.viewport ?? {
      width: view.target.width,
      height: view.target.height,
      pixelRatio: 1,
    };
    if (
      ![viewport.width, viewport.height, viewport.pixelRatio].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      throw failure('invalid-input', 'Viewport dimensions and pixel ratio must be positive');
    return {
      at: view.at,
      timeMs: options.timeMs,
      viewport: { ...viewport },
      format: view.target.format,
      width: view.target.width,
      height: view.target.height,
      presented: view.presented ?? true,
    };
  });
  for (const renderer of renderers) owner.busy.add(renderer);
  const held = new Set<MemoryEntry>();
  const uniforms = owner.uniforms.begin();
  const checks: (() => void)[] = [];
  const copies = new Set<CopyJob>();
  const snapshots: CapturedFrame[] = [];
  const prepared: (PreparedFrame | undefined)[] = [];
  const scopes: ReadScope[] = [];
  const tasks = new Set<Promise<unknown>>();
  let phase: 'prepare' | 'encode' | 'closed' = 'prepare';
  let submitted = false;
  let preparation: Promise<unknown> = Promise.resolve();
  const assertPreparing = (): void => {
    signal.throwIfAborted();
    if (phase !== 'prepare') throw failure('closed', 'Frame preparation is finished');
  };
  const scope: UploadScope = {
    copy: (job) => {
      assertPreparing();
      if (job.pending) copies.add(job);
    },
    use: (entry) => {
      assertPreparing();
      if (!held.has(entry)) {
        entry.pin();
        held.add(entry);
      }
    },
    check: (check) => {
      assertPreparing();
      checks.push(check);
    },
  };
  const release = (): void => {
    for (const entry of held) entry.unpin();
    held.clear();
    uniforms.release();
    for (const reads of scopes) reads.close();
  };
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task);
    const settle = () => void tasks.delete(task);
    void task.then(settle, settle);
    return task;
  };
  /**
   * A view's frame. Inside memoized work, `records` note everything the work holds and binds, for
   * every memo it is nested in.
   */
  const makeFrame = (
    info: FrameInfo,
    reader: ReadScope,
    renderer: Renderer,
    touched: Set<unknown>,
    records: readonly Recording[] = [],
  ): Preparation => {
    const held: UploadScope = records.length
      ? {
          ...scope,
          use: (entry) => {
            scope.use(entry);
            for (const record of records) record.held.add(entry);
          },
        }
      : scope;
    const perFrame = (what: string) => {
      if (records.length)
        throw failure('invalid-input', 'Memoized work cannot hold per-frame ' + what);
    };
    const frame: Preparation = {
      ...info,
      signal,
      reader,
      shade: (request = {}) => {
        assertPreparing();
        perFrame('shades');
        return uniforms.add(shadeUniforms(request, info));
      },
      colormap: (value) => {
        assertPreparing();
        return owner.colormaps.prepare(value, held);
      },
      text: (request) => {
        assertPreparing();
        return track(owner.text.prepare(request, held, signal));
      },
      upload: (block, upload) => {
        assertPreparing();
        return owner.uploader.upload(block, upload, held);
      },
      buffer: (data) => {
        assertPreparing();
        if (data instanceof BufferData) {
          for (const record of records) record.buffers.set(data, data.revision);
          return owner.uploader.buffer(data, held);
        }
        held.use(owner.buffers.entry(data));
        return { buffer: data.buffer, offset: 0, size: data.buffer.size };
      },
      uniforms: (data) => {
        assertPreparing();
        perFrame('uniforms');
        return uniforms.add(data);
      },
      texture: (resource) => {
        assertPreparing();
        if (resource instanceof TextureData) return owner.images.upload(resource, held);
        held.use(owner.textures.entry(resource));
        return resource.texture;
      },
      memo: async <T>(
        slot: unknown,
        deps: readonly unknown[],
        build: (frame: Preparation, previous: T | undefined) => Promise<T> | T,
      ): Promise<T> => {
        assertPreparing();
        touched.add(slot);
        let store = owner.memos.get(renderer);
        if (!store) owner.memos.set(renderer, (store = new Map<unknown, Memo>()));
        const old = store.get(slot);
        if (
          old &&
          old.deps.length === deps.length &&
          old.deps.every((dep, i) => Object.is(dep, deps[i])) &&
          (!old.reads.sampled || old.at === info.at) &&
          [...old.buffers].every(([data, revision]) => data.revision === revision) &&
          [...old.held].every((entry) => entry.live && !entry.retire) &&
          reader.hold(old.reads.entries)
        ) {
          // Holding again notes into the memos this one is nested in, as a build would.
          for (const entry of old.held) held.use(entry);
          for (const record of records) {
            for (const [data, revision] of old.buffers) record.buffers.set(data, revision);
            if (old.reads.sampled) record.reads.sampled = true;
          }
          return old.value as T;
        }
        const record: Recording = {
          held: new Set(),
          buffers: new Map(),
          reads: { entries: new Set(), sampled: false },
        };
        const value = await build(
          makeFrame(info, reader.recording(record.reads), renderer, touched, [...records, record]),
          old?.value as T | undefined,
        );
        store.set(slot, { ...record, deps: [...deps], at: info.at, value });
        return value;
      },
    };
    return frame;
  };
  const touched = options.views.map(() => new Set<unknown>());
  try {
    for (const view of options.views) snapshots.push(view.renderer.capture());
    while (owner.pending.size >= owner.maxFrames)
      await interruptible(Promise.race(owner.pending), signal);
    for (const info of infos) scopes.push(owner.reader.open({ signal, at: info.at }));
    const jobs = snapshots.map((snapshot, i) =>
      Promise.resolve().then(async () => {
        const renderer = options.views[i].renderer;
        prepared[i] = await snapshot.prepare(makeFrame(infos[i], scopes[i], renderer, touched[i]));
        // A slot the view did not use this frame is no longer its work.
        const store = owner.memos.get(renderer);
        if (store) for (const slot of store.keys()) if (!touched[i].has(slot)) store.delete(slot);
      }),
    );
    preparation = Promise.allSettled(jobs);
    await interruptible(Promise.all(jobs), signal);
    while (owner.pending.size >= owner.maxFrames)
      await interruptible(Promise.race(owner.pending), signal);
    assertPreparing();
    if (scopes.some((reads) => reads.busy) || tasks.size)
      throw failure('invalid-input', 'Preparation left asynchronous work open');
    for (const check of checks) check();
    for (const [i, view] of options.views.entries()) {
      if (
        view.target.width !== infos[i].width ||
        view.target.height !== infos[i].height ||
        view.target.format !== infos[i].format
      )
        throw failure('conflict', 'Target changed during preparation');
      const resource = targetResources.get(view.target)?.();
      if (resource) scope.use(owner.textures.entry(resource));
    }
    phase = 'encode';
    const encoder = owner.device.createCommandEncoder({ label: 'latkit frame' });
    const encodedCopies = [...copies].filter((job) => job.pending);
    for (const job of encodedCopies)
      for (const copy of job.copies)
        encoder.copyBufferToBuffer(
          copy.source.buffer,
          copy.source.offset ?? 0,
          copy.target.buffer,
          copy.target.offset ?? 0,
          copy.source.size!,
        );
    const targets = new Map<object, GPUTextureView>();
    for (const [i, view] of options.views.entries()) {
      signal.throwIfAborted();
      let target = targets.get(view.target);
      if (!target) {
        target = view.target.texture().createView();
        targets.set(view.target, target);
      }
      const result: unknown = prepared[i]!.encode({ ...infos[i], encoder, target });
      if (result && typeof (result as PromiseLike<unknown>).then === 'function')
        throw failure('invalid-input', 'Renderer encoding must be synchronous');
    }
    const extra: unknown = options.encode?.(encoder);
    if (extra && typeof (extra as PromiseLike<unknown>).then === 'function')
      throw failure('invalid-input', 'Final encoding must be synchronous');
    signal.throwIfAborted();
    uniforms.flush();
    owner.device.queue.submit([encoder.finish()]);
    submitted = true;
    for (const job of encodedCopies) {
      job.pending = false;
      for (const copy of job.copies) owner.memory.gpuCopiedBytes += copy.source.size!;
    }
    owner.memory.submissions++;
    const done = owner.device.queue.onSubmittedWorkDone();
    owner.pending.add(done);
    void done.then(
      () => {
        release();
        owner.pending.delete(done);
      },
      (error) => {
        release();
        owner.pending.delete(done);
        owner.stop(error);
      },
    );
    const failures: unknown[] = [];
    for (const [i] of options.views.entries()) {
      try {
        prepared[i]!.submitted();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Frame submitted, but a renderer notification failed');
  } catch (error) {
    cancelled.abort(error);
    throw error;
  } finally {
    phase = 'closed';
    cancelled.abort(new DOMException('Frame preparation ended', 'AbortError'));
    if (!submitted) release();
    // An uncooperative prepare cannot race a later call on the same renderer.
    const settle = () => {
      const failures: unknown[] = [];
      if (!submitted)
        for (const candidate of prepared)
          try {
            candidate?.discard();
          } catch (error) {
            failures.push(error);
          }
      for (const snapshot of snapshots)
        try {
          snapshot.release();
        } catch (error) {
          failures.push(error);
        }
      for (const renderer of renderers) owner.busy.delete(renderer);
      if (failures.length) owner.stop(new AggregateError(failures, 'Frame cleanup failed'));
    };
    void preparation.then(settle, settle);
  }
}
