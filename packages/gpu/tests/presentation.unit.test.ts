/// <reference types="@webgpu/types" />

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createPresentation, observeCanvas, type Presentation } from '../src/index.js';

interface ContextHarness {
  readonly context: GPUCanvasContext;
  readonly configure: ReturnType<typeof vi.fn>;
  readonly unconfigure: ReturnType<typeof vi.fn>;
}

interface CanvasHarness {
  readonly canvas: HTMLCanvasElement;
  readonly attributes: Map<string, string>;
}

function makeContext(): ContextHarness {
  const configure = vi.fn();
  const unconfigure = vi.fn();
  const context = {
    configure,
    unconfigure,
  } as unknown as GPUCanvasContext;
  return { context, configure, unconfigure };
}

function makeCanvas(
  context: GPUCanvasContext | null,
  view: Partial<Window & typeof globalThis> | null = null,
): CanvasHarness {
  const attributes = new Map<string, string>();
  const canvas = {
    width: 300,
    height: 150,
    clientWidth: 200,
    clientHeight: 100,
    ownerDocument: { defaultView: view },
    getContext: vi.fn((kind: string) => (kind === 'webgpu' ? context : null)),
    getAttribute: vi.fn((name: string) => attributes.get(name) ?? null),
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
      if (name === 'width') canvas.width = Number.parseInt(value, 10) || 300;
      if (name === 'height') canvas.height = Number.parseInt(value, 10) || 150;
    }),
    removeAttribute: vi.fn((name: string) => {
      attributes.delete(name);
      if (name === 'width') canvas.width = 300;
      if (name === 'height') canvas.height = 150;
    }),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, attributes };
}

function makeDevice(maxTextureDimension2D = 8192): {
  readonly device: GPUDevice;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn();
  return {
    device: { destroy, limits: { maxTextureDimension2D } } as unknown as GPUDevice,
    destroy,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('presentation surface', () => {
  it('keeps its public types native and compact', () => {
    type Configuration = NonNullable<Parameters<typeof createPresentation>[2]>;
    expectTypeOf<Configuration['format']>().toEqualTypeOf<GPUTextureFormat | undefined>();
    expectTypeOf<Configuration['usage']>().toEqualTypeOf<GPUTextureUsageFlags | undefined>();
    expectTypeOf<Presentation['context']>().toEqualTypeOf<GPUCanvasContext>();
    expectTypeOf<Presentation['device']>().toEqualTypeOf<GPUDevice>();
    expectTypeOf<Presentation['canvas']>().toEqualTypeOf<GPUCanvasContext['canvas']>();
  });
});

describe('createPresentation', () => {
  it('rejects a canvas without a WebGPU context', () => {
    const { device } = makeDevice();
    const { canvas } = makeCanvas(null);

    expect(() => createPresentation(device, canvas)).toThrow('WebGPU canvas context unavailable');
  });

  it('uses the preferred format and forwards native configuration without mutation', () => {
    const { device, destroy } = makeDevice();
    const h = makeContext();
    const { canvas } = makeCanvas(h.context);
    const getPreferredCanvasFormat = vi.fn(() => 'bgra8unorm' as GPUTextureFormat);
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat } });
    const options = Object.freeze({
      usage: 17,
      colorSpace: 'display-p3' as PredefinedColorSpace,
      alphaMode: 'opaque' as GPUCanvasAlphaMode,
    });

    const presentation = createPresentation(device, canvas, options);

    expect(presentation).toMatchObject({
      canvas,
      device,
      context: h.context,
      format: 'bgra8unorm',
    });
    expect(getPreferredCanvasFormat).toHaveBeenCalledOnce();
    expect(h.configure).toHaveBeenCalledWith({
      device,
      format: 'bgra8unorm',
      usage: 17,
      colorSpace: 'display-p3',
      alphaMode: 'opaque',
    });
    expect(options).toEqual({ usage: 17, colorSpace: 'display-p3', alphaMode: 'opaque' });

    presentation.destroy();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('accepts an explicit format without browser globals and defaults alpha mode', () => {
    vi.stubGlobal('navigator', undefined);
    const { device } = makeDevice();
    const h = makeContext();
    const { canvas } = makeCanvas(h.context);

    const presentation = createPresentation(device, canvas, { format: 'rgba8unorm' });

    expect(h.configure).toHaveBeenCalledWith({
      device,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied',
    });
    presentation.destroy();
  });

  it('uses the global GPU preferred format independently of the canvas realm', () => {
    const globalPreferredFormat = vi.fn(() => 'rgba8unorm' as GPUTextureFormat);
    const canvasPreferredFormat = vi.fn(() => 'bgra8unorm' as GPUTextureFormat);
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: globalPreferredFormat } });
    const { device } = makeDevice();
    const h = makeContext();
    const { canvas } = makeCanvas(h.context, {
      navigator: { gpu: { getPreferredCanvasFormat: canvasPreferredFormat } },
    } as unknown as Partial<Window & typeof globalThis>);

    const presentation = createPresentation(device, canvas);

    expect(presentation.format).toBe('rgba8unorm');
    expect(globalPreferredFormat).toHaveBeenCalledOnce();
    expect(canvasPreferredFormat).not.toHaveBeenCalled();
    presentation.destroy();
  });

  it('cleans failed configuration without relabeling the original error', () => {
    const failure = new Error('configuration failed');
    const { device, destroy } = makeDevice();
    const h = makeContext();
    h.configure.mockImplementation(() => {
      throw failure;
    });
    h.unconfigure.mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    const { canvas } = makeCanvas(h.context);

    let caught: unknown;
    try {
      createPresentation(device, canvas, { format: 'bgra8unorm' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(h.unconfigure).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('restores exact HTML attributes and destroys idempotently', () => {
    const { device, destroy } = makeDevice();
    const h = makeContext();
    const { canvas, attributes } = makeCanvas(h.context);
    attributes.set('width', '00420');

    const presentation = createPresentation(device, canvas, { format: 'bgra8unorm' });

    expect(presentation.resize(800, 450)).toBe(true);
    expect(presentation.resize(800, 450)).toBe(false);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(450);

    presentation.destroy();
    presentation.destroy();

    expect(attributes.get('width')).toBe('00420');
    expect(attributes.has('height')).toBe(false);
    expect(h.unconfigure).toHaveBeenCalledOnce();
    expect(presentation.resize(1, 1)).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('restores OffscreenCanvas dimensions even when unconfigure fails', () => {
    const failure = new Error('unconfigure failed');
    const { device } = makeDevice();
    const h = makeContext();
    h.unconfigure.mockImplementation(() => {
      throw failure;
    });
    const canvas = {
      width: 640,
      height: 360,
      getContext: vi.fn(() => h.context),
    } as unknown as OffscreenCanvas;
    const presentation = createPresentation(device, canvas, { format: 'bgra8unorm' });
    presentation.resize(1280, 720);

    expect(() => presentation.destroy()).toThrow(failure);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(() => presentation.destroy()).not.toThrow();
  });

  it('rejects invalid backing dimensions before mutating the canvas', () => {
    const { device } = makeDevice();
    const h = makeContext();
    const { canvas } = makeCanvas(h.context);
    const presentation = createPresentation(device, canvas, { format: 'bgra8unorm' });

    expect(() => presentation.resize(1.5, 2)).toThrow(RangeError);
    expect(() => presentation.resize(-1, 2)).toThrow(RangeError);
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    presentation.destroy();
  });

  it('fits backing dimensions within the device limit without changing aspect ratio', () => {
    const { device } = makeDevice(1024);
    const h = makeContext();
    const { canvas } = makeCanvas(h.context);
    const presentation = createPresentation(device, canvas, { format: 'bgra8unorm' });

    expect(presentation.resize(2048, 1024)).toBe(true);
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(512);
    expect(presentation.resize(2048, 1024)).toBe(false);

    expect(presentation.resize(0, 0)).toBe(true);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    presentation.destroy();
  });

  it('normalizes an invalid initial backing size before configuring the context', () => {
    const { device } = makeDevice(1024);
    const h = makeContext();
    const canvas = {
      width: 2048,
      height: 1024,
      getContext: vi.fn(() => h.context),
    } as unknown as OffscreenCanvas;
    h.configure.mockImplementation(() => {
      expect(canvas.width).toBe(1024);
      expect(canvas.height).toBe(512);
    });

    const presentation = createPresentation(device, canvas, { format: 'bgra8unorm' });

    expect(h.configure).toHaveBeenCalledOnce();
    presentation.destroy();
    expect(canvas.width).toBe(2048);
    expect(canvas.height).toBe(1024);
  });
});

describe('observeCanvas', () => {
  function observerView(options: { rejectDeviceBox?: boolean; vertical?: boolean } = {}): {
    readonly view: Partial<Window & typeof globalThis>;
    readonly observe: ReturnType<typeof vi.fn>;
    readonly disconnect: ReturnType<typeof vi.fn>;
    readonly addViewport: ReturnType<typeof vi.fn>;
    readonly removeViewport: ReturnType<typeof vi.fn>;
    readonly addWindow: ReturnType<typeof vi.fn>;
    readonly removeWindow: ReturnType<typeof vi.fn>;
    readonly matchMedia: ReturnType<typeof vi.fn>;
    readonly removeResolution: ReturnType<typeof vi.fn>;
    fire(entry?: ResizeObserverEntry): void;
    fireViewport(): void;
    fireWindow(): void;
    fireResolution(): void;
  } {
    let resizeCallback: ResizeObserverCallback | undefined;
    let viewportCallback: EventListener | undefined;
    let windowCallback: EventListener | undefined;
    let resolutionCallback: EventListener | undefined;
    const observe = vi.fn((_target: Element, observerOptions?: ResizeObserverOptions) => {
      if (options.rejectDeviceBox && observerOptions?.box === 'device-pixel-content-box') {
        throw new TypeError('unsupported box');
      }
    });
    const disconnect = vi.fn();
    const addViewport = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      viewportCallback = listener as EventListener;
    });
    const removeViewport = vi.fn();
    const addWindow = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      windowCallback = listener as EventListener;
    });
    const removeWindow = vi.fn();
    const removeResolution = vi.fn();
    const matchMedia = vi.fn(() => ({
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        resolutionCallback = listener as EventListener;
      }),
      removeEventListener: removeResolution,
    }));
    const view = {
      devicePixelRatio: 2,
      getComputedStyle: vi.fn(() => ({
        writingMode: options.vertical ? 'vertical-rl' : 'horizontal-tb',
      })),
      addEventListener: addWindow,
      removeEventListener: removeWindow,
      matchMedia,
      ResizeObserver: class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
      visualViewport: {
        addEventListener: addViewport,
        removeEventListener: removeViewport,
      },
    } as unknown as Partial<Window & typeof globalThis>;

    return {
      view,
      observe,
      disconnect,
      addViewport,
      removeViewport,
      addWindow,
      removeWindow,
      matchMedia,
      removeResolution,
      fire(entry) {
        resizeCallback?.(entry ? [entry] : [], {} as ResizeObserver);
      },
      fireViewport() {
        viewportCallback?.({ type: 'resize' } as Event);
      },
      fireWindow() {
        windowCallback?.({ type: 'resize' } as Event);
      },
      fireResolution() {
        resolutionCallback?.({ type: 'change' } as Event);
      },
    };
  }

  it('reports the initial size, exact device pixels, and visual viewport changes', () => {
    const h = observerView();
    const { canvas } = makeCanvas(null, h.view);
    const listener = vi.fn();

    const stop = observeCanvas(canvas, listener);
    expect(listener).toHaveBeenNthCalledWith(1, 400, 200, 2);

    h.fire({
      devicePixelContentBoxSize: [{ inlineSize: 421, blockSize: 211 }],
    } as unknown as ResizeObserverEntry);
    expect(listener).toHaveBeenNthCalledWith(2, 421, 211, 2);

    Object.assign(canvas, { clientWidth: 220, clientHeight: 110 });
    h.fireViewport();
    expect(listener).toHaveBeenNthCalledWith(3, 440, 220, 2);

    Object.assign(h.view, { devicePixelRatio: 1.5 });
    h.fireResolution();
    expect(listener).toHaveBeenNthCalledWith(4, 330, 165, 1.5);
    expect(h.matchMedia).toHaveBeenLastCalledWith('(resolution: 1.5dppx)');

    stop();
    stop();
    expect(h.disconnect).toHaveBeenCalledOnce();
    expect(h.removeViewport).toHaveBeenCalledOnce();
    expect(h.removeWindow).toHaveBeenCalledOnce();
    expect(h.removeResolution).toHaveBeenCalledTimes(2);
  });

  it('falls back to the content box and plain observation', () => {
    const h = observerView({ rejectDeviceBox: true });
    const { canvas } = makeCanvas(null, h.view);
    const listener = vi.fn();

    const stop = observeCanvas(canvas, listener);
    h.fire({ contentRect: { width: 123.25, height: 45.25 } } as ResizeObserverEntry);

    expect(h.observe.mock.calls).toEqual([[canvas, { box: 'device-pixel-content-box' }], [canvas]]);
    expect(listener).toHaveBeenLastCalledWith(247, 91, 2);
    stop();
  });

  it('maps logical device-pixel axes to physical canvas dimensions', () => {
    const h = observerView({ vertical: true });
    const { canvas } = makeCanvas(null, h.view);
    const listener = vi.fn();

    const stop = observeCanvas(canvas, listener);
    h.fire({
      devicePixelContentBoxSize: [{ inlineSize: 211, blockSize: 421 }],
    } as unknown as ResizeObserverEntry);

    expect(listener).toHaveBeenLastCalledWith(421, 211, 2);
    stop();
  });

  it('removes installed observers when the initial listener fails', () => {
    const h = observerView();
    const { canvas } = makeCanvas(null, h.view);
    const failure = new Error('listener failed');

    expect(() =>
      observeCanvas(canvas, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(h.disconnect).toHaveBeenCalledOnce();
    expect(h.removeViewport).toHaveBeenCalledOnce();
    expect(h.removeWindow).toHaveBeenCalledOnce();
  });
});
