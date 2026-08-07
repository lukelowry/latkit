// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurface } from '../src/input/surface.js';

function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.style.overscrollBehavior = '';
});

describe('createSurface', () => {
  it('configures the supplied canvas without taking over its layout or placement', () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.style.width = '40px';
    canvas.style.height = '30px';
    canvas.style.display = 'inline-block';
    container.append(canvas);
    const surface = createSurface(canvas);

    expect(surface.element).toBe(canvas);
    expect(canvas.parentElement).toBe(container);
    expect(canvas.style.width).toBe('40px');
    expect(canvas.style.height).toBe('30px');
    expect(canvas.style.display).toBe('inline-block');
    expect(surface.element.style.touchAction).toBe('none');
    expect(surface.element.style.userSelect).toBe('none');

    surface.destroy();
  });

  it('leaves contextmenu policy to the pointer adapter', () => {
    const canvas = document.createElement('canvas');
    const surface = createSurface(canvas);

    const ev = new MouseEvent('contextmenu', { cancelable: true });
    surface.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);

    surface.destroy();
  });

  it('reads rect and size fresh from the canvas', () => {
    const canvas = document.createElement('canvas');
    const surface = createSurface(canvas);
    let current = rect(100, 50, 10, 20);
    surface.element.getBoundingClientRect = () => current;

    expect(surface.rect().left).toBe(10);
    current = rect(240, 140, 30, 40);
    expect(surface.size()).toEqual({ w: 240, h: 140 });
    expect(surface.rect().top).toBe(40);

    surface.destroy();
  });

  it('destroy restores interaction styles and leaves the canvas attached', () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.style.touchAction = 'pan-y';
    canvas.style.userSelect = 'text';
    container.append(canvas);
    const surface = createSurface(canvas);

    surface.destroy();

    expect(container.contains(canvas)).toBe(true);
    expect(canvas.style.touchAction).toBe('pan-y');
    expect(canvas.style.userSelect).toBe('text');

    // The surface never owns contextmenu policy on the caller-owned canvas.
    const ev = new MouseEvent('contextmenu', { cancelable: true });
    surface.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
