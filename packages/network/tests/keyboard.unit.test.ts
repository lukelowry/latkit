// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { attachKeyboard, type KeyIntent } from '../src/input/keyboard.js';

function harness(navigable: () => boolean = () => true) {
  const canvas = document.createElement('canvas');
  const intents: KeyIntent[] = [];
  const handle = attachKeyboard(canvas, (intent) => intents.push(intent), navigable);
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    canvas.dispatchEvent(event);
    return event;
  };
  return { canvas, intents, handle, press };
}

describe('attachKeyboard', () => {
  it('maps the navigation keys onto camera intents and claims only those keys', () => {
    const h = harness();

    expect(h.press('ArrowLeft').defaultPrevented).toBe(true);
    h.press('ArrowUp', { shiftKey: true });
    h.press('+');
    h.press('-');
    h.press('Home');
    h.press('Escape');
    expect(h.press('a').defaultPrevented).toBe(false);
    expect(h.press('ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(false);

    expect(h.intents).toEqual([
      { kind: 'pan', dx: 48, dy: 0 },
      { kind: 'rotate', dx: 0, dy: -48 },
      { kind: 'zoom', factor: 1.2 },
      { kind: 'zoom', factor: 1 / 1.2 },
      { kind: 'fit' },
      { kind: 'clear' },
    ]);
    h.handle.destroy();
  });

  it('steps the selection instead of the camera while not navigable, and leaves the rest to the page', () => {
    let navigable = false;
    const h = harness(() => navigable);

    expect(h.press('ArrowRight').defaultPrevented).toBe(true);
    h.press('ArrowDown');
    expect(h.press('ArrowDown', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(h.press('+').defaultPrevented).toBe(false);
    expect(h.press('Home').defaultPrevented).toBe(false);
    h.press('Escape');
    expect(h.intents).toEqual([
      { kind: 'step', dx: 1, dy: 0 },
      { kind: 'step', dx: 0, dy: 1 },
      { kind: 'clear' },
    ]);

    // The map follows the live predicate.
    navigable = true;
    h.press('ArrowRight');
    expect(h.intents.at(-1)).toEqual({ kind: 'pan', dx: -48, dy: 0 });
    h.handle.destroy();
  });

  it('makes the canvas focusable only for as long as it is attached', () => {
    const h = harness();
    expect(h.canvas.tabIndex).toBe(0);
    h.handle.destroy();
    expect(h.canvas.hasAttribute('tabindex')).toBe(false);
    expect(h.press('ArrowLeft').defaultPrevented).toBe(false);
  });
});
