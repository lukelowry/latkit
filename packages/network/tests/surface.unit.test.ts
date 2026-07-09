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
  it('creates and configures a canvas inside the container', () => {
    const container = document.createElement('div');
    const surface = createSurface(container);

    expect(surface.element.tagName).toBe('CANVAS');
    expect(container.firstElementChild).toBe(surface.element);
    expect(surface.element.style.touchAction).toBe('none');
    expect(surface.element.style.userSelect).toBe('none');

    surface.destroy();
  });

  it('suppresses contextmenu events on the canvas', () => {
    const container = document.createElement('div');
    const surface = createSurface(container);

    const ev = new MouseEvent('contextmenu', { cancelable: true });
    surface.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    surface.destroy();
  });

  it('reads rect and size fresh from the canvas', () => {
    const container = document.createElement('div');
    const surface = createSurface(container);
    let current = rect(100, 50, 10, 20);
    surface.element.getBoundingClientRect = () => current;

    expect(surface.rect().left).toBe(10);
    current = rect(240, 140, 30, 40);
    expect(surface.size()).toEqual({ w: 240, h: 140 });
    expect(surface.rect().top).toBe(40);

    surface.destroy();
  });

  it('destroy removes the contextmenu listener and detaches the canvas', () => {
    const container = document.createElement('div');
    const surface = createSurface(container);

    surface.destroy();

    expect(container.contains(surface.element)).toBe(false);

    // The listener was removed on destroy, so subsequent contextmenu
    // events on the detached canvas no longer cancel.
    const ev = new MouseEvent('contextmenu', { cancelable: true });
    surface.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
