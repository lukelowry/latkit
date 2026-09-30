import type { Gpu } from './gpu.js';
import { GpuError } from './error.js';
import { createPresentation, type Presentation } from './presentation.js';
import type { Invalidation, Renderer } from './render.js';

export interface CanvasView {
  readonly presentation: Presentation;
  /** Coalesces requests. A newer request cancels preparation of an older one. */
  request(options?: { readonly at?: number; readonly timeMs?: number }): void;
  pause(): void;
  resume(): void;
  /** Releases scheduling and presentation, never the renderer, Gpu, or source. */
  destroy(): void;
}

export function createCanvasView(options: {
  readonly gpu: Gpu;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly onError: (error: unknown) => void;
  readonly onLost?: (info: GPUDeviceLostInfo) => void;
  readonly onRendered?: () => void;
}): CanvasView {
  const { gpu, canvas, renderer } = options;
  const presentation = createPresentation({ gpu, canvas });
  const view = canvas.ownerDocument.defaultView;
  if (!view) {
    presentation.destroy();
    throw new GpuError('unavailable', 'Canvas has no window');
  }
  let closed = false,
    paused = false,
    wanted = false,
    raf = 0;
  let active: AbortController | undefined;
  let coordinate: number | undefined, timestamp: number | undefined;
  const schedule = (): void => {
    if (!closed && !paused && wanted && !active && !raf) raf = view.requestAnimationFrame(tick);
  };
  const tick = (now: number): void => {
    raf = 0;
    if (closed || paused || !wanted) return;
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (!width || !height) return;
    wanted = false;
    const scale = Math.min(
      view.devicePixelRatio || 1,
      gpu.device.limits.maxTextureDimension2D / width,
      gpu.device.limits.maxTextureDimension2D / height,
    );
    const size = {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
    const target = {
      device: gpu.device,
      format: presentation.format,
      ...size,
      texture() {
        presentation.resize(size);
        return presentation.texture();
      },
    };
    const own = new AbortController();
    active = own;
    void gpu
      .render({
        timeMs: timestamp ?? now,
        signal: own.signal,
        views: [
          {
            renderer,
            target,
            at: coordinate,
            viewport: { width, height, pixelRatio: scale },
          },
        ],
      })
      .then(
        () => {
          if (!closed && !own.signal.aborted) {
            if (renderer.animating) wanted = true;
            options.onRendered?.();
          }
        },
        (error) => {
          if (!closed && !own.signal.aborted) {
            if (error instanceof GpuError && error.code === 'busy') wanted = true;
            else options.onError(error);
          }
        },
      )
      .finally(() => {
        if (active === own) active = undefined;
        schedule();
      });
  };
  const invalidate = (change: Invalidation = 'replace'): void => {
    wanted = true;
    if (change === 'replace')
      active?.abort(new DOMException('Canvas frame superseded', 'AbortError'));
    schedule();
  };
  const resize = (): void => invalidate('replace');
  let unsubscribe: (() => void) | undefined;
  let observer: ResizeObserver | undefined;
  let ratio: MediaQueryList | undefined;
  const watchRatio = (): void => {
    ratio?.removeEventListener('change', onRatio);
    ratio = view.matchMedia('(resolution: ' + (view.devicePixelRatio || 1) + 'dppx)');
    ratio.addEventListener('change', onRatio, { once: true });
  };
  const onRatio = (): void => {
    watchRatio();
    invalidate();
  };
  const dispose = (): void => {
    closed = true;
    active?.abort(new DOMException('Canvas view closed', 'AbortError'));
    if (raf) view.cancelAnimationFrame(raf);
    try {
      observer?.disconnect();
      view.removeEventListener('resize', resize);
      unsubscribe?.();
      ratio?.removeEventListener('change', onRatio);
    } finally {
      presentation.destroy();
    }
  };
  try {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(resize);
      try {
        observer.observe(canvas, { box: 'device-pixel-content-box' });
      } catch {
        observer.observe(canvas);
      }
    }
    view.addEventListener('resize', resize);
    unsubscribe = renderer.on?.('invalidate', invalidate);
    watchRatio();
    invalidate();
  } catch (error) {
    try {
      dispose();
    } catch {
      /* Preserve the setup failure. */
    }
    throw error;
  }
  void gpu.lost.then((info) => {
    if (!closed) {
      paused = true;
      active?.abort(info);
      options.onLost?.(info);
    }
  });
  return {
    presentation,
    request(request = {}) {
      if (closed) throw new GpuError('closed', 'Canvas view is closed');
      if ('at' in request) coordinate = request.at;
      if ('timeMs' in request) timestamp = request.timeMs;
      invalidate();
    },
    pause() {
      paused = true;
      active?.abort(new DOMException('Canvas paused', 'AbortError'));
      if (raf) view.cancelAnimationFrame(raf);
      raf = 0;
    },
    resume() {
      if (closed) throw new GpuError('closed', 'Canvas view is closed');
      paused = false;
      invalidate();
    },
    destroy() {
      if (closed) return;
      dispose();
    },
  };
}
