/** Canvases: views shown in a `<canvas>` or an `OffscreenCanvas`, as a layout places them. */

import type * as bindings from '../pkg/latkit.js';
import { hold, inner, release } from './internal.js';
import { Shot, type ShotOptions } from './shot.js';
import { handleOf, type View } from './view.js';

/** `[x, y, width, height]` as fractions of a canvas or a picture. */
export type Rect = readonly [x: number, y: number, width: number, height: number];

/** A view's place in a canvas or a picture: where it draws, all of it unless `at` says. */
export interface Panel {
  view: View;
  at?: Rect;
}

/** How a canvas shows its views. */
export interface CanvasOptions {
  /** The views shown and where; a later panel draws over an earlier one. */
  layout?: readonly Panel[];
  /** Pixels a CSS pixel of an `OffscreenCanvas`; an element follows its device. */
  pixelRatio?: number;
}

/** The whole of a canvas or a picture. */
const WHOLE: Rect = [0, 0, 1, 1];

/**
 * Views shown in a `<canvas>` element, which sizes itself to its CSS box and passes each view the
 * input landing on its panel, or an `OffscreenCanvas` in a worker, which keeps the size it is given.
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

  /** @internal A canvas of `device` in `target`, which calls `released` once destroyed. */
  static made(
    device: bindings.Gpu,
    target: HTMLCanvasElement | OffscreenCanvas,
    options: CanvasOptions,
    released: () => void,
  ): Canvas {
    return new Canvas(device, target, options, released);
  }

  /** What it draws into. */
  get element(): HTMLCanvasElement | OffscreenCanvas {
    return this.#target;
  }

  /**
   * The views shown and where, a later panel over an earlier one; setting it shows those in place of
   * the ones shown. A view shows in one panel of one canvas at a time.
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
   * A picture of exactly what the canvas shows: its views as its layout places them, at its size in
   * CSS pixels times `scale`.
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

  /** Stops drawing; the views remain, and the element keeps its last frame. */
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

/** @internal Where each panel of `layout` draws, four fractions after another. */
export function placed(layout: readonly Panel[]): Float32Array {
  return Float32Array.from(layout.flatMap(({ at }) => at ?? WHOLE));
}
