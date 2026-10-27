/** Canvases that show views in a `<canvas>` element or an `OffscreenCanvas`. */

import type * as bindings from '../pkg/latkit.js';
import { Handle, inner } from './internal.js';
import { Shot, type ShotOptions } from './shot.js';
import { handleOf, type View } from './view.js';

/** A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left. */
export type Rect = readonly [x: number, y: number, width: number, height: number];

/** A view and the region of a canvas or picture it draws in. */
export interface Panel {
  /** The view drawn. */
  view: View;
  /** Where the view draws; the whole canvas or picture by default. */
  at?: Rect;
}

/** The rect covering a whole canvas or picture. */
const WHOLE: Rect = [0, 0, 1, 1];

/**
 * Shows views in a `<canvas>` element or an `OffscreenCanvas`, each in its layout panel; created by
 * `Gpu.canvas()`. A frame redraws only the views that need it, or every view after a resize or a
 * layout change. Destroying it stops drawing; the views stay usable, and the element keeps its last
 * frame.
 */
export class Canvas extends Handle {
  #target: HTMLCanvasElement | OffscreenCanvas;
  #layout: readonly Panel[];
  #released: () => void;

  private constructor(
    device: bindings.Gpu,
    target: HTMLCanvasElement | OffscreenCanvas,
    options: { layout?: readonly Panel[]; pixelRatio?: number },
    released: () => void,
  ) {
    const layout = options.layout ?? [];
    super(device.canvas(target, ...encoded(layout), options.pixelRatio), 'Canvas');
    this.#target = target;
    this.#layout = [...layout];
    this.#released = released;
  }

  /** @internal Creates a canvas of `device` in `target`; `released` runs once it is destroyed. */
  static made(
    device: bindings.Gpu,
    target: HTMLCanvasElement | OffscreenCanvas,
    options: { layout?: readonly Panel[]; pixelRatio?: number },
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
   * shown views. A view shows in at most one panel of one canvas at a time.
   */
  get layout(): readonly Panel[] {
    return this.#layout;
  }

  set layout(layout: readonly Panel[]) {
    inner<bindings.Canvas>(this).setLayout(...encoded(layout));
    this.#layout = [...layout];
  }

  /**
   * A {@link Shot} of exactly what the canvas shows: its views in its layout, at the canvas's CSS
   * size times `options.scale` in pixels.
   */
  shot(options: ShotOptions = {}): Shot {
    const scale = options.scale ?? 1;
    const css = inner<bindings.Canvas>(this).cssSize;
    const [width = 1, height = 1] = Array.from(css, (side) =>
      Math.max(1, Math.round(side * scale)),
    );
    return new Shot([width, height], { ...options, layout: this.#layout });
  }

  /** @internal Tells the GPU the canvas is gone. */
  protected override freeing(): void {
    this.#released();
  }
}

/**
 * @internal A layout as the bindings take it: each panel's view, and its rect's four fractions in
 * one array, the whole target where `at` is unset.
 */
export function encoded(layout: readonly Panel[]): [bindings.Handle[], Float32Array] {
  return [
    layout.map(({ view }) => handleOf(view)),
    Float32Array.from(layout.flatMap(({ at }) => at ?? WHOLE)),
  ];
}
