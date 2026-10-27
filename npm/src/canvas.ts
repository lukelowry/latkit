/** Canvases, which views create: the views shown in one `<canvas>` or `OffscreenCanvas`. */

import type * as bindings from '../pkg/latkit.js';
import { Handle, inner } from './internal.js';
import { handleOf, type View } from './view.js';

/** A region `[x, y, width, height]` in fractions of a canvas or picture, from its top left. */
export type Rect = readonly [x: number, y: number, width: number, height: number];

/** @internal A `<canvas>` element or an `OffscreenCanvas` that views draw in. */
export type Target = HTMLCanvasElement | OffscreenCanvas;

/**
 * @internal Shows views in a `<canvas>` element or an `OffscreenCanvas`, each in its region, later
 * views over earlier ones. A `<canvas>` element sizes itself to its CSS box at the device pixel
 * ratio and passes pointer, wheel, and key input to the view under the pointer. A frame redraws
 * only the views that need it, or every view after a resize or a change of views. It is destroyed
 * with its last view, and the element keeps its last frame.
 */
export class Canvas extends Handle {
  #views: View[] = [];
  #released: () => void;

  private constructor(
    device: bindings.Gpu,
    target: Target,
    pixelRatio: number | undefined,
    released: () => void,
  ) {
    super(device.canvas(target, ...encoded([]), pixelRatio), 'Canvas');
    this.#released = released;
  }

  /** Creates a canvas of `device` in `target`; `released` runs once it is destroyed. */
  static made(
    device: bindings.Gpu,
    target: Target,
    pixelRatio: number | undefined,
    released: () => void,
  ): Canvas {
    return new Canvas(device, target, pixelRatio, released);
  }

  /** The views shown, in drawing order. */
  get views(): readonly View[] {
    return this.#views;
  }

  /** The canvas's size in CSS pixels. */
  get cssSize(): [width: number, height: number] {
    const [width = 1, height = 1] = inner<bindings.Canvas>(this).cssSize;
    return [width, height];
  }

  /** Shows `view` over the others. */
  add(view: View): void {
    this.#views.push(view);
    this.relayout();
  }

  /** Stops showing `view`; with no view left, destroys the canvas. */
  remove(view: View): void {
    this.#views = this.#views.filter((shown) => shown !== view);
    if (this.#views.length) this.relayout();
    else this.destroy();
  }

  /** Tells the bindings where each view draws, after a view or its region changed. */
  relayout(): void {
    inner<bindings.Canvas>(this).setLayout(...encoded(this.#views));
  }

  protected override freeing(): void {
    this.#views = [];
    this.#released();
  }
}

/** A view drawn into a picture, in its own region or in `region`. */
export type Placed =
  | View
  | {
      /** The view drawn. */
      readonly view: View;
      /** Where it draws in the picture, in place of its own region. */
      readonly region: Rect;
    };

/**
 * @internal Views as the bindings take them: each view's handle, and its region's four fractions
 * in one array.
 */
export function encoded(views: readonly Placed[]): [bindings.Handle[], Float32Array] {
  const placed = views.map((v) => ('view' in v ? v : { view: v, region: v.region }));
  return [
    placed.map(({ view }) => handleOf(view)),
    Float32Array.from(placed.flatMap(({ region }) => region)),
  ];
}
