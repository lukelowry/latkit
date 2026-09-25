/**
 * One network frame, in the order the controller relies on: camera, visual derivation, fit
 * notice, backing size, hover, submit. `@latkit/gpu`'s frame loop decides when and at what size a
 * frame runs; this decides what it does.
 */

import type { Frame } from '@latkit/gpu';

import type { CameraRig } from '../camera/rig.js';
import type { Viewport } from '../camera/projection.js';
import type { Renderer } from './renderer.js';
import type { Uniforms } from './uniforms.js';

/** What one network frame reads, writes, and calls. */
export interface FrameTickDeps {
  /** The presented canvas; its backing size is the viewport the uniforms carry. */
  readonly canvas: HTMLCanvasElement;
  /** Packed uniform views shared with camera, renderer, and picking state. */
  readonly uniforms: Uniforms;
  /** Submits one encoded network frame; false while it cannot paint yet. */
  readonly renderer: Pick<Renderer, 'render'>;
  /** Camera authority ticked once per frame; owns all deferred placement. */
  readonly rig: Pick<CameraRig, 'tick' | 'isAnimating' | 'isAtFitView' | 'pendingPlacement'>;
  /** Moves the camera by continuous motion, such as an orbit, before the camera tick. */
  readonly advance?: (now: number) => void;
  /** Receives fit-view state transitions after the camera tick. */
  readonly onZoom?: (atFitView: boolean) => void;
  /**
   * Updates viewport-derived visual uniforms before hover picking and the submit observe them;
   * `now` is the frame's timestamp.
   */
  readonly onBeforeFrame?: (vp: Viewport, now: number) => void;
  /**
   * Runs after the camera pose is final and before the submit, so the hover it resolves is part
   * of the frame; `sizeSettled` is false while a resize is in flight.
   */
  readonly onFrame?: (sizeSettled: boolean) => void;
  /** Fires after a successful submit, not after a skipped render attempt. */
  readonly onPaint?: () => void;
  /** Whether something besides the camera wants another frame. */
  readonly animating?: () => boolean;
  /**
   * Whether the frame may still submit. A host callback run from `onBeforeFrame` may pause,
   * detach, or destroy the view; the frame then stops before touching the GPU.
   *
   * @defaultValue always true
   */
  readonly live?: () => boolean;
}

/**
 * Build the `render` callback `createFrameLoop` drives for one network canvas.
 *
 * @returns A callback that renders one frame and says whether another is wanted: while the camera
 *   eases, a deferred placement waits for a usable viewport, or an outside animator asks.
 */
export function createFrameTick(deps: FrameTickDeps): (frame: Frame) => boolean {
  const { canvas, uniforms, renderer, rig, advance, onZoom, onBeforeFrame, onFrame, onPaint } =
    deps;
  const animating = deps.animating ?? (() => false);
  const live = deps.live ?? (() => true);
  // Reused so a frame allocates nothing; the rig and hooks read it only during the call.
  const vp: Viewport = { w: 0, h: 0 };
  let lastFit = true;

  return (frame) => {
    vp.w = frame.width;
    vp.h = frame.height;
    advance?.(frame.now);
    // Nothing loaded: nothing to draw, and nothing to wait for.
    if (!rig.tick(frame.now, vp)) return false;
    onBeforeFrame?.(vp, frame.now);

    const fit = rig.isAtFitView();
    if (fit !== lastFit) {
      lastFit = fit;
      onZoom?.(fit);
    }

    uniforms.frame.viewportX = canvas.width;
    uniforms.frame.viewportY = canvas.height;
    uniforms.frame.backingScale = frame.backingScale;

    onFrame?.(frame.settled);
    if (!live()) return false;

    if (renderer.render(uniforms)) onPaint?.();
    return rig.isAnimating() || rig.pendingPlacement || animating();
  };
}
