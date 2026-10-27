/** Pictures of views: images to encode as files, and H.264 video written as frames are drawn. */

import type * as bindings from '../pkg/latkit.js';
import { encoded, type Placed } from './canvas.js';
import { Handle, inner, thrown, waited, wasm, type LatkitError, type Wait } from './internal.js';
import { canvasOf, type View } from './view.js';

/** Options for a {@link Shot}. */
export interface ShotOptions {
  /**
   * Pixels per CSS pixel, 1 by default. Views lay out at `size / scale` CSS pixels, so 2 draws the
   * same layout twice as sharp.
   */
  scale?: number;
  /** Leaves the background transparent where the theme's background color would be. */
  transparent?: boolean;
  /**
   * When the picture is taken. `'still'`, the default, waits until every view is complete and
   * still: transitions, camera flights, and tile fades run until they finish. `'now'` waits only
   * until every view is complete, and freezes anything moving where it is.
   */
  capture?: 'still' | 'now';
  /**
   * The time in seconds that `elapsed()` expressions and flowing comets show in a still picture. By
   * default they follow the view's clock.
   */
  elapsed?: number;
}

/**
 * A picture of views, `size` pixels in all, each view drawn in its region. While a shot draws a
 * view, its canvas keeps its last frame. An image draws each view's data as it was when the
 * picture began. `Shot.of(view)` makes a shot of what a view's canvas shows.
 *
 * ```ts
 * const png = await (await Shot.of(view, { scale: 2 }).image()).encode('png');
 * ```
 */
export class Shot {
  /** The picture's size, `[width, height]` in pixels. */
  readonly size: readonly [number, number];
  /** How the picture is taken, and in `views`, the views drawn into it. */
  readonly options: ShotOptions & { views?: readonly Placed[] };

  /** Creates a shot of `size`, `[width, height]` in pixels. */
  constructor(
    size: readonly [number, number],
    options: ShotOptions & {
      /**
       * The views drawn, later views over earlier ones: each in its own region, or, given as
       * `{ view, region }`, in that region of the picture.
       */
      views?: readonly Placed[];
    } = {},
  ) {
    this.size = size;
    this.options = options;
  }

  /**
   * A shot of exactly what the canvas showing `view` shows: its views in their regions, at the
   * canvas's CSS size times `options.scale` in pixels. Throws an `invalid` error for a view on no
   * canvas, which a shot must be given a size for.
   */
  static of(view: View, options: ShotOptions = {}): Shot {
    const canvas = canvasOf(view);
    if (!canvas)
      throw thrown({
        code: 'invalid',
        message: 'the view is on no canvas: create a Shot of a size',
      });
    const scale = options.scale ?? 1;
    const [width, height] = canvas.cssSize.map((side) => Math.max(1, Math.round(side * scale)));
    return new Shot([width!, height!], { ...options, views: canvas.views });
  }

  /**
   * Draws the picture once every view is complete, as `capture` says, and resolves to the
   * {@link Image}. Rejects with the first error a view reports while drawing.
   */
  async image(wait: Wait = {}): Promise<Image> {
    const taken = wasm().image(this.#json(), ...encoded(this.options.views ?? []));
    return Image.made(await waited<bindings.Image>(taken, wait, 'taking a picture'));
  }

  /**
   * Starts a video of this shot: H.264 in MP4, written to `options.output` as frames are drawn. The
   * width is rounded down to a multiple of 4 and the height to an even number, as the encoder
   * requires. Canvases showing the views keep their last frame until the video finishes or aborts.
   * Aborting `options.signal` aborts the video and its output; frames have no other time limit.
   */
  video(
    options: {
      /** Frames per second. */
      fps: number;
      /** Where the file's bytes go, locked until the video finishes or aborts. */
      output: WritableStream<Uint8Array>;
      /** Bits per second; about 0.15 bits per pixel per frame by default. */
      bitrate?: number;
    } & Wait,
  ): Video {
    options.signal?.throwIfAborted();
    const writer = options.output.getWriter();
    try {
      const views = encoded(this.options.views ?? []);
      const video = wasm().video(this.#json(), ...views, options.fps, options.bitrate);
      return Video.made(video, writer, options.fps, options.signal);
    } catch (error) {
      writer.releaseLock();
      throw error;
    }
  }

  /** The shot as JSON for the bindings, with times in seconds; the views cross on their own. */
  #json(): string {
    const { scale = 1, transparent = false, capture = 'still', elapsed } = this.options;
    return JSON.stringify({ size: [...this.size], scale, transparent, capture, elapsed });
  }
}

/** A picture's RGBA pixels, with straight alpha, rows top to bottom. */
export class Image extends Handle {
  private constructor(image: bindings.Image) {
    super(image, 'Image');
  }

  /** @internal Wraps a bindings image. */
  static made(image: bindings.Image): Image {
    return new Image(image);
  }

  /** Width in pixels. */
  get width(): number {
    return inner<bindings.Image>(this).width;
  }

  /** Height in pixels. */
  get height(): number {
    return inner<bindings.Image>(this).height;
  }

  /** A copy of the pixels: 4 bytes per pixel, `width * height * 4` bytes in all. */
  get rgba(): Uint8Array {
    return inner<bindings.Image>(this).rgba;
  }

  /**
   * Encodes the image as a file, in a worker. PNG is lossless with alpha. JPEG drops alpha. WebP
   * is lossless with alpha and smaller than PNG.
   */
  encode(
    format: ImageFormat,
    options: {
      /** JPEG quality, from 1 (smallest) to 100 (sharpest); 90 by default. */
      quality?: number;
    } & Wait = {},
  ): Promise<Uint8Array> {
    const encoding = inner<bindings.Image>(this).encode(format, options.quality);
    return waited<Uint8Array>(encoding, options, 'encoding an image');
  }
}

/** An image file format for {@link Image.encode}. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * A video being drawn, encoded, and written; created by {@link Shot.video}. Draw frames with
 * {@link Video.frame} or {@link Video.record}, then call {@link Video.finish}.
 */
export class Video {
  #video: bindings.Video | undefined;
  #state: 'open' | 'finishing' | 'aborting' | 'closed' = 'open';
  /** The operation in progress, and the bindings task it waits on. */
  #operation?: Promise<void>;
  #task?: bindings.Task;
  #finished?: Promise<void>;
  #aborted?: Promise<void>;
  #reason: unknown;
  #frames = 0;
  #removeAbort?: () => void;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #fps: number;

  private constructor(
    video: bindings.Video,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    fps: number,
    signal?: AbortSignal,
  ) {
    this.#video = video;
    this.#writer = writer;
    this.#fps = fps;
    if (signal) {
      const abort = () => void this.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.#removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
  }

  /** @internal Wraps a bindings video whose bytes go to `writer`. */
  static made(
    video: bindings.Video,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    fps: number,
    signal?: AbortSignal,
  ): Video {
    return new Video(video, writer, fps, signal);
  }

  /** The time in seconds at which the next frame shows. Still readable after the video ends. */
  get time(): number {
    return this.frames / this.#fps;
  }

  /**
   * Frames recorded so far, including frames repeated because nothing moved. Still readable after
   * the video ends.
   */
  get frames(): number {
    return this.#video?.frames ?? this.#frames;
  }

  /**
   * Draws the next frame once its views are complete, and writes its bytes, waiting on the
   * output's backpressure. Calls must not overlap: a call made before the previous one resolves,
   * or after `finish()`, rejects with an `invalid` error, and a call after `abort()` with a
   * `cancelled` error. A failure aborts the video.
   */
  frame(): Promise<void> {
    if (this.#state !== 'open') return Promise.reject(this.#ended());
    if (this.#operation)
      return Promise.reject(
        thrown({ code: 'invalid', message: 'a Video draws one frame at a time' }),
      );
    return this.#run(async () => {
      const bytes = await this.#await(this.#open().frame());
      // An abort while the frame drew rejects it, even if the frame finished first.
      this.#open();
      if (bytes.length) await this.#writer.write(bytes);
    });
  }

  /**
   * Records frames until `step(time)` returns false, then finishes the video. `step` gets the next
   * frame's time in seconds and can change the views before that frame is drawn. `onProgress` is
   * called after each frame. An error from `step`, drawing, the output, or `onProgress` aborts the
   * video and is rethrown.
   */
  async record(
    step: (time: number) => boolean | Promise<boolean>,
    onProgress?: (progress: { frames: number; time: number }) => void,
  ): Promise<void> {
    try {
      while (await step(this.time)) {
        await this.frame();
        onProgress?.({ frames: this.frames, time: this.time });
      }
      await this.finish();
    } catch (error) {
      await this.abort(error);
      throw error;
    }
  }

  /**
   * Waits for the frame in progress, encodes the remaining frames, writes the end of the file, and
   * closes and unlocks the output. Later calls return the same promise. Rejects with a `cancelled`
   * error if the video was aborted.
   */
  finish(): Promise<void> {
    if (this.#finished) return this.#finished;
    if (this.#state !== 'open') return Promise.reject(this.#ended());
    this.#state = 'finishing';
    const frame = this.#operation;
    this.#finished = this.#run(async () => {
      await frame;
      const bytes = await this.#await(this.#open().finish());
      if (bytes.length) await this.#writer.write(bytes);
      this.#open();
      await this.#writer.close();
    }).then(() => {
      if (this.#state === 'finishing') this.#release();
    });
    return this.#finished;
  }

  /**
   * Cancels drawing and encoding, aborts the output with `reason`, and unlocks it once pending
   * writes settle. Later calls return the same promise. After `finish()` completes, it does
   * nothing.
   */
  abort(reason?: unknown): Promise<void> {
    if (this.#aborted) return this.#aborted;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'aborting';
    this.#reason = reason;
    this.#frames = this.frames;
    this.#task?.cancel();
    this.#video?.cancel();
    this.#aborted = Promise.allSettled([this.#operation, this.#writer.abort(reason)]).then(() =>
      this.#release(),
    );
    return this.#aborted;
  }

  /** Runs `operation` as the one in progress. A failure aborts the video and is rethrown. */
  #run(operation: () => Promise<void>): Promise<void> {
    const running = operation();
    this.#operation = running;
    return running
      .catch(async (error: unknown) => {
        await this.abort(error);
        throw error;
      })
      .finally(() => {
        if (this.#operation === running) this.#operation = undefined;
      });
  }

  /** Awaits bindings task `task`, which `abort()` cancels, and frees it. */
  async #await(task: bindings.Task): Promise<Uint8Array> {
    this.#task = task;
    try {
      return (await task.promise) as Uint8Array;
    } finally {
      this.#task = undefined;
      task.free();
    }
  }

  /** The bindings video while the video is open or finishing; else throws why it ended. */
  #open(): bindings.Video {
    const open = this.#state === 'open' || this.#state === 'finishing';
    if (!open || !this.#video) throw this.#ended();
    return this.#video;
  }

  /**
   * The error for a call after the video ended: `cancelled` with the abort reason as its `cause`
   * once aborted, else `invalid`.
   */
  #ended(): LatkitError {
    return this.#aborted
      ? thrown({ code: 'cancelled', message: 'this Video was aborted', cause: this.#reason })
      : thrown({ code: 'invalid', message: 'a Video draws no frames after finish()' });
  }

  #release(): void {
    this.#frames = this.frames;
    this.#video?.free();
    this.#video = undefined;
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    this.#writer.releaseLock();
    this.#state = 'closed';
  }
}
