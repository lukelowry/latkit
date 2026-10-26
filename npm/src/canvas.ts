/** Canvases that show views in a `<canvas>` element or an `OffscreenCanvas`. */

import type * as bindings from '../pkg/latkit.js';
import { hold, inner, release } from './internal.js';
import { Shot, type ShotOptions } from './shot.js';
import { handleOf, type View } from './view.js';

/** A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left. */
export type Rect = readonly [x: number, y: number, width: number, height: number];

/** A view and the region of a canvas or picture it draws in. */
export interface Panel {
  view: View;
  /** Where the view draws; the whole canvas or picture by default. */
  at?: Rect;
}

/** Options for `Gpu.canvas()`. */
export interface CanvasOptions {
  /** The views shown and their regions; later panels draw over earlier ones. None by default. */
  layout?: readonly Panel[];
  /**
   * Pixels per CSS pixel of an `OffscreenCanvas`, 1 by default; it must be positive. A `<canvas>`
   * element uses the device pixel ratio instead.
   */
  pixelRatio?: number;
}

/** The rect covering a whole canvas or picture. */
const WHOLE: Rect = [0, 0, 1, 1];

/**
 * Shows views in a `<canvas>` element or an `OffscreenCanvas`, each in its layout panel; created by
 * `Gpu.canvas()`. A frame redraws only the views that need it, or every view after a resize or a
 * layout change.
 */
export class Canvas {
  #target: HTMLCanvasElement | OffscreenCanvas;
  #pixelRatio: number;
  #layout: readonly Panel[] = [];
  #released: () => void;

  private constructor(
    device: bindings.Gpu,
    target: HTMLCanvasElement | OffscreenCanvas,
    options: CanvasOptions,
    released: () => void,
  ) {
    const layout = options.layout ?? [];
    hold(
      this,
      device.canvas(
        target,
        layout.map(({ view }) => handleOf(view)),
        placed(layout),
        options.pixelRatio,
      ),
    );
    this.#target = target;
    this.#pixelRatio = options.pixelRatio ?? 1;
    this.#layout = [...layout];
    this.#released = released;
  }

  /** @internal Creates a canvas of `device` in `target`; `released` runs once it is destroyed. */
  static made(
    device: bindings.Gpu,
    target: HTMLCanvasElement | OffscreenCanvas,
    options: CanvasOptions,
    released: () => void,
  ): Canvas {
    return new Canvas(device, target, options, released);
  }

  /** The `<canvas>` element or `OffscreenCanvas` it draws into. */
  get element(): HTMLCanvasElement | OffscreenCanvas {
    return this.#target;
  }

  /**
   * The views shown and their regions; later panels draw over earlier ones. Setting it replaces the
   * shown views. A view can show in only one panel of one canvas at a time. Setting a layout that
   * breaks this, or that has a panel covering no pixels, throws an `invalid` error.
   */
  get layout(): readonly Panel[] {
    return this.#layout;
  }

  set layout(layout: readonly Panel[]) {
    canvas(this).setLayout(
      layout.map(({ view }) => handleOf(view)),
      placed(layout),
    );
    this.#layout = [...layout];
  }

  /**
   * Returns a {@link Shot} of exactly what the canvas shows: its views in its layout, at the
   * canvas's CSS size times `options.scale` (1 by default) in pixels.
   */
  shot(options: ShotOptions = {}): Shot {
    const scale = options.scale ?? 1;
    const target = this.#target;
    const [width, height] =
      'clientWidth' in target
        ? [target.clientWidth, target.clientHeight]
        : [target.width / this.#pixelRatio, target.height / this.#pixelRatio];
    const size = [
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    ] as const;
    return new Shot(size, { ...options, layout: this.#layout });
  }

  /**
   * Stops drawing and frees the canvas. The views stay usable, and the element keeps its last
   * frame. Calling it again does nothing.
   */
  destroy(): void {
    const freed = release<bindings.Canvas>(this);
    if (!freed) return;
    freed.free();
    this.#released();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

function canvas(owner: Canvas): bindings.Canvas {
  return inner<bindings.Canvas>(owner, 'Canvas');
}

/** @internal Flattens each panel's rect into four floats; the whole target where `at` is unset. */
export function placed(layout: readonly Panel[]): Float32Array {
  return Float32Array.from(layout.flatMap(({ at }) => at ?? WHOLE));
}
