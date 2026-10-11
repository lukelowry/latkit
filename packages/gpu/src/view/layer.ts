import type { RGBA } from '../colors/color.js';
import type { Encoding, Preparation } from '../frame/render.js';
import type { Light, ProjectedCamera } from './projection.js';
import type { Point } from './view.js';
import type { ItemView } from './item-view.js';
/** What a host's frame tells the view it draws beneath itself. */
export interface LayerScene {
  /** The camera the host draws this frame with. */
  readonly camera: ProjectedCamera;
  /** The host's samples per pixel, which the layer's pipelines match. */
  readonly msaa: 1 | 4;
  /** The pointer, where the host found nothing under it: the layer's to hover. */
  readonly pointer: Point | null;
  /**
   * The host's scene block this frame, the projection and the light its uniforms begin with, as
   * `Projector.write` and `Projector.light` lay them out: the layer binds it in place of its own,
   * so a frame writes its camera once.
   */
  readonly scene: GPUBufferBinding;
}
/** A layer's prepared frame, drawn inside its host's pass before the host's own draws. */
export interface PreparedLayer {
  /** Record work the draw reads, such as compute passes, before the host's pass begins. */
  encode(frame: Encoding): void;
  /** Draw into the host's pass: premultiplied color over a `depth32float` depth attachment. */
  draw(pass: GPURenderPassEncoder): void;
  submitted(): void;
  discard(): void;
}
/** How a layer looks to its host: the sun it lights the scene with, and the ground's color. */
export interface LayerLook {
  /** The sun the layer lights the host's scene with, or none. */
  readonly light: Light | null;
  /** The color the layer fills the ground with, which what draws over it matches, as halos do. */
  readonly fill: RGBA | null;
}
/** A layer's frame, captured with its host's, before anything prepares. */
export interface CapturedLayer extends LayerLook {
  prepare(frame: Preparation, scene: LayerScene): Promise<PreparedLayer>;
  release(): void;
}
/**
 * A view another view draws beneath itself, in its own pass, with its camera, `at`, and depth: one
 * pass, one camera, nothing composited. While hosted, the view presents nowhere else.
 */
export interface Layer {
  capture(): CapturedLayer;
  /** Whether the layer wants another frame, as it eases or loads. */
  readonly animating: boolean;
  /** Settles once work the layer started, such as loading tiles, lands. */
  readonly pending: Promise<void> | undefined;
  /** Follow the layer's invalidations; returns the unsubscribe. */
  invalidated(listener: () => void): () => void;
  /** A click the host's own items left unclaimed: the layer selects what it hits there. */
  click(point: Point, modifiers: ItemView.Modifiers, touch: boolean): Promise<void>;
  /** A menu the host's own items left unclaimed, which the layer reports with its hits. */
  menu(point: Point, trigger: 'pointer' | 'keyboard', modifiers: ItemView.Modifiers): Promise<void>;
  /** End hosting; the view may present again. */
  release(): void;
}
