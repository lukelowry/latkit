/** Pictures of views: images to encode as files, and H.264 video written as frames are drawn. */

import type * as bindings from '../pkg/latkit.js';
import { placed, type Panel } from './canvas.js';
import {
  hold,
  inner,
  release,
  thrown,
  waited,
  wasm,
  type LatkitError,
  type Wait,
} from './internal.js';
import { handleOf } from './view.js';

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
   * still: transitions, camera flights, and label fades run until they finish. `'now'` waits only
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
 * A picture of views, `size` pixels in all, each view drawn into its layout panel. While a shot
 * draws a view, a canvas showing that view keeps its last frame. An image draws each view's data as
 * it was when the picture began. A canvas's `shot()` makes a shot of what the canvas shows.
 *
 * ```ts
 * const png = await (await canvas.shot({ scale: 2 }).image()).encode('png');
 * ```
 */
export class Shot {
  /** The picture's size, `[width, height]` in pixels. */
  readonly size: readonly [number, number];
  /** How the picture is taken, and in `layout`, the panel each view is drawn into. */
  readonly options: ShotOptions & { layout?: readonly Panel[] };

  /** Creates a shot of `size`, `[width, height]` in pixels, of the views in `options.layout`. */
  constructor(
    size: readonly [number, number],
    options: ShotOptions & { layout?: readonly Panel[] } = {},
  ) {
    this.size = size;
    this.options = options;
  }

  /**
   * Draws the picture once every view is complete, as `capture` says, and resolves to the
   * {@link Image}. Rejects with an `invalid` error for invalid options or a view in two panels, and
   * with the first error a view reports while drawing.
   */
  async image(wait: Wait = {}): Promise<Image> {
    const taken = wasm().image(this.#json(this.size), this.#views());
    const image = await waited<bindings.Image>(taken, wait, 'taking a picture');
    return Image.made(image);
  }

  /**
   * Starts a video of this shot: H.264 in MP4 at `options.fps` frames per second, written to
   * `options.output` as frames are drawn. `options.bitrate` is in bits per second, about 0.15 bits
   * per pixel per frame by default. The width is rounded down to a multiple of 4 and the height to a
   * multiple of 2, as the encoder requires. Canvases showing the views keep their last frame until
   * the video finishes or aborts. Aborting `options.signal` aborts the video and its output; frames
   * have no other time limit.
   */
  video(
    options: { fps: number; output: WritableStream<Uint8Array>; bitrate?: number } & Wait,
  ): Video {
    const { fps, output, bitrate, signal } = options;
    signal?.throwIfAborted();
    const writer = output.getWriter();
    try {
      const [width, height] = this.size;
      const blocks = [
        Math.max(4, width - (width % 4)),
        Math.max(2, height - (height % 2)),
      ] as const;
      return Video.made(
        wasm().video(this.#json(blocks), this.#views(), fps, bitrate),
        writer,
        fps,
        signal,
      );
    } catch (error) {
      writer.releaseLock();
      throw error;
    }
  }

  /** The shot as JSON for the bindings, at `size` pixels, with times in seconds. */
  #json(size: readonly [number, number]): string {
    const {
      scale = 1,
      transparent = false,
      capture = 'still',
      elapsed,
      layout = [],
    } = this.options;
    const placing = Array.from(placed(layout));
    const panels = Array.from({ length: layout.length }, (_, i) => placing.slice(i * 4, i * 4 + 4));
    return JSON.stringify({ size: [...size], scale, panels, transparent, capture, elapsed });
  }

  #views(): bindings.Handle[] {
    return (this.options.layout ?? []).map(({ view }) => handleOf(view));
  }
}

/** A picture's RGBA pixels, with straight alpha, rows top to bottom. */
export class Image {
  private constructor(image: bindings.Image) {
    hold(this, image);
  }

  /** @internal Wraps a bindings image. */
  static made(image: bindings.Image): Image {
    return new Image(image);
  }

  /** Width in pixels. */
  get width(): number {
    return pixels(this).width;
  }

  /** Height in pixels. */
  get height(): number {
    return pixels(this).height;
  }

  /** A copy of the pixels: 4 bytes per pixel, `width * height * 4` bytes in all. */
  get rgba(): Uint8Array {
    return pixels(this).rgba;
  }

  /**
   * Encodes the image as a file, in a worker. PNG is lossless with alpha. JPEG uses
   * `options.quality` from 1 to 100 (90 by default) and drops alpha. WebP is lossless with alpha
   * and smaller than PNG. Rejects with an `invalid` error for a quality outside 1 to 100 or an
   * unknown format.
   */
  encode(format: ImageFormat, options: { quality?: number } & Wait = {}): Promise<Uint8Array> {
    return waited<Uint8Array>(
      pixels(this).encode(format, options.quality),
      options,
      'encoding an image',
    );
  }

  /** Frees the pixels. Other methods throw afterwards. */
  destroy(): void {
    release<bindings.Image>(this)?.free();
  }

  /** Calls {@link Image.destroy}, so a `using` declaration destroys it when its block ends. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}

function pixels(owner: Image): bindings.Image {
  return inner<bindings.Image>(owner, 'Image');
}

/** An image file format for {@link Image.encode}. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * A video being drawn, encoded, and written; created by {@link Shot.video}. Draw frames with
 * {@link Video.frame} or {@link Video.record}, then call {@link Video.finish}.
 */
export class Video {
  #state: 'open' | 'finishing' | 'aborting' | 'closed' = 'open';
  #operation?: Promise<void>;
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
    hold(this, video);
    this.#writer = writer;
    this.#fps = fps;
    if (signal) {
      const abort = () => {
        void this.abort(signal.reason);
      };
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

  #check(): bindings.Video {
    const video =
      this.#state === 'aborting' || this.#state === 'closed' ? undefined : encoder(this);
    if (!video) throw this.#ended();
    return video;
  }

  /**
   * The error for a call after the video ended: `cancelled` with the abort reason as its `cause`
   * once aborted, else `invalid`.
   */
  #ended(): LatkitError {
    return this.#aborted
      ? Object.assign(thrown({ code: 'cancelled', message: 'this Video was aborted' }), {
          cause: this.#reason,
        })
      : thrown({ code: 'invalid', message: 'a Video draws no frames after finish()' });
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
    return encoder(this)?.frames ?? this.#frames;
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
    const operation = (async () => {
      const bytes = (await this.#check().frame()) as Uint8Array;
      this.#frames = this.#check().frames;
      if (bytes.length) await this.#writer.write(bytes);
    })();
    this.#operation = operation;
    return operation
      .catch(async (error: unknown) => {
        await this.abort(error);
        throw error;
      })
      .finally(() => {
        if (this.#operation === operation) this.#operation = undefined;
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
    const operation = (async () => {
      await frame;
      const bytes = (await this.#check().finish()) as Uint8Array;
      this.#check();
      if (bytes.length) await this.#writer.write(bytes);
      this.#check();
      await this.#writer.close();
    })();
    this.#operation = operation;
    this.#finished = operation
      .then(() => {
        if (this.#state === 'finishing') this.#release();
      })
      .catch(async (error: unknown) => {
        await this.abort(error);
        throw error;
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
    encoder(this)?.cancel();
    this.#aborted = Promise.allSettled([this.#operation, this.#writer.abort(reason)]).then(() =>
      this.#release(),
    );
    return this.#aborted;
  }

  #release(): void {
    this.#frames = this.frames;
    release<bindings.Video>(this)?.free();
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    this.#writer.releaseLock();
    this.#state = 'closed';
  }
}

/** The video's bindings object, or `undefined` once it is released. */
function encoder(owner: Video): bindings.Video | undefined {
  try {
    return inner<bindings.Video>(owner, 'Video');
  } catch {
    return undefined;
  }
}
