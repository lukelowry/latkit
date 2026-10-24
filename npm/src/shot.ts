/** Pictures and videos of views: images to encode, and H.264 video written as it is drawn. */

import type * as bindings from '../pkg/latkit.js';
import { placed, type Panel } from './canvas.js';
import { hold, inner, release, thrown, waited, wasm, type Wait } from './internal.js';
import { handleOf } from './view.js';

/** How a picture is taken. */
export interface ShotOptions {
  /** Pixels per CSS pixel: a view lays out `size / scale` CSS pixels, so 2 draws twice as sharp. 1 unless given. */
  scale?: number;
  /** Keeps alpha where the themes' backgrounds would be. */
  transparent?: boolean;
  /**
   * When the picture is taken: once its views are complete and still, transitions, flights, and
   * label fades run on until they land (`still`, the default); or once they are complete, as they
   * stand now, what moves held where it is (`now`).
   */
  capture?: 'still' | 'now';
  /** A still's effect time in seconds, where elapsed time and flowing comets read it. */
  elapsed?: number;
}

/**
 * A picture of views, each drawn into its panel of `size` pixels as `layout` places it: drawn while a
 * canvas showing it holds its last frame, each view's data as it was when the picture began. A
 * canvas's `shot()` takes one of what it shows.
 *
 * ```ts
 * const png = await (await canvas.shot({ scale: 2 }).image()).encode('png');
 * ```
 */
export class Shot {
  /** A picture `size` pixels wide and high, of the views of `options.layout`. */
  constructor(
    readonly size: readonly [number, number],
    readonly options: ShotOptions & { layout?: readonly Panel[] } = {},
  ) {}

  /** The picture, once every view is complete as `capture` says. */
  async image(wait: Wait = {}): Promise<Image> {
    const taken = wasm().image(this.#json(this.size), this.#views());
    const image = await waited<bindings.Image>(taken, wait, 'a picture');
    return Image.made(image);
  }

  /**
   * A video of these pictures at `fps` frames a second, H.264 in MP4, written to `output` as it is
   * drawn, at `bitrate` bits a second or about 0.15 bits a pixel a frame. Its width rounds down to a
   * multiple of 4 and its height of 2, the blocks H.264 takes. `signal` aborts it: the output is
   * aborted and the views are given back.
   */
  video({
    fps,
    output,
    bitrate,
    signal,
  }: { fps: number; output: WritableStream<Uint8Array>; bitrate?: number } & Wait): Video {
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

  /** The shot of `size` pixels as the bindings read it: JSON, times in seconds. */
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

/** RGBA pixels, straight alpha, rows top to bottom. */
export class Image {
  private constructor(image: bindings.Image) {
    hold(this, image);
  }

  /** @internal An image of the bindings' `image`. */
  static made(image: bindings.Image): Image {
    return new Image(image);
  }

  get width(): number {
    return pixels(this).width;
  }

  get height(): number {
    return pixels(this).height;
  }

  /** The pixels, copied. */
  get rgba(): Uint8Array {
    return pixels(this).rgba;
  }

  /**
   * The image as a file, written in a worker: PNG, lossless with alpha; JPEG at `quality` from 1 to
   * 100 (90 by default), small, its alpha dropped; or WebP, lossless with alpha, smaller than PNG.
   */
  encode(format: ImageFormat, options: { quality?: number } & Wait = {}): Promise<Uint8Array> {
    return waited<Uint8Array>(
      pixels(this).encode(format, options.quality),
      options,
      'writing an image',
    );
  }

  destroy(): void {
    release<bindings.Image>(this)?.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

function pixels(owner: Image): bindings.Image {
  return inner<bindings.Image>(owner, 'Image');
}

/** How an image is written as a file. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** A video being drawn, encoded, and written. */
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

  /** @internal A video of the bindings' `video`, written to `writer`. */
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
    if (!video)
      throw Object.assign(
        thrown({ code: 'cancelled', message: 'this Video was finished or aborted' }),
        {
          cause: this.#reason,
        },
      );
    return video;
  }

  /** Seconds into the video the next frame shows at; kept once it is done. */
  get time(): number {
    return this.frames / this.#fps;
  }

  /** Frames drawn or held so far; kept once it is done. */
  get frames(): number {
    return encoder(this)?.frames ?? this.#frames;
  }

  /** Draws and writes one frame, waiting for the output's backpressure. One frame draws at a time. */
  frame(): Promise<void> {
    if (this.#state !== 'open' || this.#operation)
      return Promise.reject(new Error('a Video draws one frame at a time, before it finishes'));
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

  /** Records until `step(time)` returns false; any step, drawing, output, or progress error aborts it. */
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

  /** Finishes pending work, writes the end of the file, and closes and unlocks the output. Idempotent. */
  finish(): Promise<void> {
    if (this.#finished) return this.#finished;
    if (this.#state !== 'open') return Promise.reject(new Error('this Video was aborted'));
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

  /** Cancels drawing and encoding, aborts the output, and unlocks it once pending writes settle. Idempotent. */
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

/** The video's encoder, while it has one. */
function encoder(owner: Video): bindings.Video | undefined {
  try {
    return inner<bindings.Video>(owner, 'Video');
  } catch {
    return undefined;
  }
}
