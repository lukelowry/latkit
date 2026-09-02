/// <reference types="@webgpu/types" />

/** Canvas types accepted by a WebGPU presentation context. */
export type PresentationCanvas = GPUCanvasContext['canvas'];

/** A configured WebGPU canvas binding. */
export interface Presentation<TCanvas extends PresentationCanvas = PresentationCanvas> {
  /** Borrowed canvas configured by this presentation binding. */
  readonly canvas: TCanvas;
  /** Borrowed device used to configure the canvas. */
  readonly device: GPUDevice;
  /** Configured context borrowed from the canvas. */
  readonly context: GPUCanvasContext;
  /** Texture format used by the presentation context. */
  readonly format: GPUTextureFormat;

  /**
   * Sets the canvas backing size in device pixels, fitting it within the
   * device's 2D texture limit when necessary.
   *
   * @returns `true` when the backing size changed.
   */
  resize(width: number, height: number): boolean;

  /**
   * Report the canvas's device-pixel size and pixel ratio now, then on every change.
   *
   * A canvas that cannot be observed (OffscreenCanvas) reports once from its
   * current size and never again. After `destroy()`, the listener never runs.
   *
   * @returns An idempotent function that stops observation.
   */
  observe(listener: (width: number, height: number, pixelRatio: number) => void): () => void;

  /** Unconfigures the context and restores the canvas's original backing size. */
  destroy(): void;
}

interface State {
  restore(): void;
}

function isHtmlCanvas(canvas: PresentationCanvas): canvas is HTMLCanvasElement {
  return 'getAttribute' in canvas && typeof canvas.getAttribute === 'function';
}

function capture(canvas: PresentationCanvas): State {
  if (isHtmlCanvas(canvas)) {
    const width = canvas.getAttribute('width');
    const height = canvas.getAttribute('height');

    return {
      restore() {
        if (width === null) canvas.removeAttribute('width');
        else canvas.setAttribute('width', width);

        if (height === null) canvas.removeAttribute('height');
        else canvas.setAttribute('height', height);
      },
    };
  }

  const { width, height } = canvas;
  return {
    restore() {
      canvas.width = width;
      canvas.height = height;
    },
  };
}

function canvasView(canvas: HTMLCanvasElement): (Window & typeof globalThis) | null {
  return canvas.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? null : window);
}

function preferredFormat(): GPUTextureFormat {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) throw new Error('WebGPU is not available in this context');
  return gpu.getPreferredCanvasFormat();
}

function assertSize(width: number, height: number): void {
  if (!Number.isInteger(width) || width < 0 || !Number.isInteger(height) || height < 0) {
    throw new RangeError('Canvas dimensions must be non-negative integers');
  }
}

/**
 * Configures a canvas for presentation with a borrowed WebGPU device.
 *
 * The returned presentation owns the context configuration and any backing-size
 * changes made through {@link Presentation.resize}. It never owns the device.
 */
export function createPresentation<TCanvas extends PresentationCanvas>(
  device: GPUDevice,
  canvas: TCanvas,
  options: Omit<GPUCanvasConfiguration, 'device' | 'format'> & {
    /** Defaults to the user agent's preferred canvas format. */
    format?: GPUTextureFormat;
  } = {},
): Presentation<TCanvas> {
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('WebGPU canvas context unavailable');

  const state = capture(canvas);
  const { format: requestedFormat, alphaMode = 'premultiplied', ...configuration } = options;
  const format = requestedFormat ?? preferredFormat();
  const maxSize = device.limits.maxTextureDimension2D;

  const resize = (width: number, height: number): boolean => {
    assertSize(width, height);

    // Keep the backing store valid on every device while retaining the
    // requested aspect ratio when either dimension exceeds its 2D limit.
    const scale = Math.min(1, maxSize / width, maxSize / height);
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));

    let changed = false;
    if (canvas.width !== nextWidth) {
      canvas.width = nextWidth;
      changed = true;
    }
    if (canvas.height !== nextHeight) {
      canvas.height = nextHeight;
      changed = true;
    }
    return changed;
  };

  try {
    resize(canvas.width, canvas.height);
    context.configure({
      ...configuration,
      device,
      format,
      alphaMode,
    });
  } catch (error) {
    try {
      context.unconfigure();
    } catch {
      // Preserve the configuration error.
    }
    try {
      state.restore();
    } catch {
      // Preserve the configuration error.
    }
    throw error;
  }

  let destroyed = false;

  return {
    canvas,
    device,
    context,
    format,

    resize(width, height) {
      if (destroyed) return false;
      return resize(width, height);
    },

    observe(listener) {
      if (destroyed) return () => {};
      if (isHtmlCanvas(canvas)) return observeCanvas(canvas, listener);
      listener(canvas.width, canvas.height, 1);
      return () => {};
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      let failed = false;
      let failure: unknown;
      try {
        context.unconfigure();
      } catch (error) {
        failed = true;
        failure = error;
      }

      try {
        state.restore();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }

      if (failed) throw failure;
    },
  };
}

function reportSize(
  canvas: HTMLCanvasElement,
  view: Window | null,
  listener: (width: number, height: number, pixelRatio: number) => void,
  entry?: ResizeObserverEntry,
): void {
  const ratio = view?.devicePixelRatio || 1;
  const deviceBox = entry?.devicePixelContentBoxSize?.[0];
  if (deviceBox) {
    const writingMode = view?.getComputedStyle?.(canvas).writingMode ?? '';
    const vertical = writingMode.startsWith('vertical-') || writingMode.startsWith('sideways-');
    listener(
      Math.max(0, Math.round(vertical ? deviceBox.blockSize : deviceBox.inlineSize)),
      Math.max(0, Math.round(vertical ? deviceBox.inlineSize : deviceBox.blockSize)),
      ratio,
    );
    return;
  }

  const cssWidth = entry?.contentRect?.width ?? canvas.clientWidth;
  const cssHeight = entry?.contentRect?.height ?? canvas.clientHeight;
  listener(
    Math.max(0, Math.round(cssWidth * ratio)),
    Math.max(0, Math.round(cssHeight * ratio)),
    ratio,
  );
}

/**
 * Reports an HTML canvas's current device-pixel size and pixel ratio, then
 * observes subsequent changes.
 *
 * The listener runs synchronously once, then directly from resize notifications.
 * Scheduling and backing-size policy remain the listener's responsibility.
 *
 * @returns An idempotent function that stops observation.
 */
export function observeCanvas(
  canvas: HTMLCanvasElement,
  listener: (width: number, height: number, pixelRatio: number) => void,
): () => void {
  const view = canvasView(canvas);
  const Observer =
    view?.ResizeObserver ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver);
  const viewport = view?.visualViewport;
  let active = true;
  let observer: ResizeObserver | undefined;
  let resolution: MediaQueryList | undefined;

  const report = (entry?: ResizeObserverEntry): void => {
    if (active) reportSize(canvas, view, listener, entry);
  };
  const onViewportResize = (): void => report();
  const onWindowResize = (): void => report();
  function watchResolution(): void {
    resolution?.removeEventListener('change', onResolutionChange);
    resolution = view?.matchMedia?.(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
    resolution?.addEventListener('change', onResolutionChange, { once: true });
  }
  function onResolutionChange(): void {
    if (!active) return;
    watchResolution();
    report();
  }
  const stop = (): void => {
    if (!active) return;
    active = false;
    try {
      observer?.disconnect();
    } finally {
      try {
        viewport?.removeEventListener('resize', onViewportResize);
      } finally {
        try {
          view?.removeEventListener?.('resize', onWindowResize);
        } finally {
          resolution?.removeEventListener('change', onResolutionChange);
          resolution = undefined;
        }
      }
    }
  };

  try {
    if (Observer) {
      const next = new Observer((entries: ResizeObserverEntry[]) =>
        report(entries[entries.length - 1]),
      );
      observer = next;
      try {
        next.observe(canvas, { box: 'device-pixel-content-box' });
      } catch {
        next.observe(canvas);
      }
    }

    viewport?.addEventListener('resize', onViewportResize);
    view?.addEventListener?.('resize', onWindowResize);
    watchResolution();
    report();
  } catch (error) {
    try {
      stop();
    } catch {
      // Preserve the setup or listener error.
    }
    throw error;
  }

  return stop;
}
