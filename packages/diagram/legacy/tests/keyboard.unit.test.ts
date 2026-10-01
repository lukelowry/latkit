// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { attachKeyboard, type KeyIntent } from '../src/input/keyboard.js';
import { Interactor } from '../src/interact.js';
import { harness as interaction } from './fixtures/interact-harness.js';
import { twoArea } from './fixtures/netlists.js';

function harness(claim: (intent: KeyIntent) => boolean = () => true) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const intents: KeyIntent[] = [];
  const handle = attachKeyboard(canvas, (intent) => {
    intents.push(intent);
    return claim(intent);
  });
  const key = (type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent(type, { key: k, cancelable: true, ...init });
    canvas.dispatchEvent(event);
    return event;
  };
  const press = (k: string, init: KeyboardEventInit = {}) => key('keydown', k, init);
  return { canvas, intents, handle, press, key };
}

describe('attachKeyboard', () => {
  it('maps every key of the map onto its intent', () => {
    const h = harness();

    h.press('ArrowLeft');
    h.press('ArrowRight');
    h.press('ArrowUp', { shiftKey: true });
    h.press('ArrowDown');
    h.press('+');
    h.press('=');
    h.press('-');
    h.press('_');
    h.press('Home');
    h.press('Tab');
    h.press('Tab', { shiftKey: true });
    h.press('Enter');
    h.press('Escape');
    h.press('Delete');
    h.press('Backspace');

    expect(h.intents).toEqual([
      { kind: 'arrow', dx: -1, dy: 0, large: false },
      { kind: 'arrow', dx: 1, dy: 0, large: false },
      { kind: 'arrow', dx: 0, dy: -1, large: true },
      { kind: 'arrow', dx: 0, dy: 1, large: false },
      { kind: 'zoom', factor: 1.2 },
      { kind: 'zoom', factor: 1.2 },
      { kind: 'zoom', factor: 1 / 1.2 },
      { kind: 'zoom', factor: 1 / 1.2 },
      { kind: 'fit' },
      { kind: 'tab', back: false },
      { kind: 'tab', back: true },
      { kind: 'open' },
      { kind: 'escape' },
      { kind: 'delete' },
      { kind: 'delete' },
    ]);
    h.handle.destroy();
  });

  it('prevents the default only for keys the controller claims', () => {
    const h = harness((intent) => intent.kind !== 'tab');

    expect(h.press('ArrowLeft').defaultPrevented).toBe(true);
    // An unclaimed Tab moves focus off the canvas as the browser would.
    expect(h.press('Tab').defaultPrevented).toBe(false);
    expect(h.press('a').defaultPrevented).toBe(false);
    expect(h.intents.map((intent) => intent.kind)).toEqual(['arrow', 'tab']);
    h.handle.destroy();
  });

  it('leaves Ctrl, Meta, Alt, and composing keys to the host without emitting', () => {
    const h = harness();

    expect(h.press('ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(h.press('Delete', { metaKey: true }).defaultPrevented).toBe(false);
    expect(h.press('Enter', { altKey: true }).defaultPrevented).toBe(false);
    expect(h.press('+', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(h.press(' ', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(h.press('Enter', { isComposing: true }).defaultPrevented).toBe(false);
    expect(h.intents).toEqual([]);
    h.handle.destroy();
  });

  it('emits Space once when held and once when released', () => {
    const h = harness();

    expect(h.press(' ').defaultPrevented).toBe(true);
    expect(h.press(' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(h.press(' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(h.key('keyup', ' ').defaultPrevented).toBe(true);
    // A release without a claimed press is not the map's.
    expect(h.key('keyup', ' ').defaultPrevented).toBe(false);

    expect(h.intents).toEqual([
      { kind: 'space', down: true },
      { kind: 'space', down: false },
    ]);
    h.handle.destroy();
  });

  it('leaves an unclaimed Space to the page and never releases it', () => {
    const h = harness((intent) => intent.kind !== 'space');

    expect(h.press(' ').defaultPrevented).toBe(false);
    expect(h.press(' ', { repeat: true }).defaultPrevented).toBe(false);
    h.key('keyup', ' ');
    expect(h.intents).toEqual([{ kind: 'space', down: true }]);
    h.handle.destroy();
  });

  it('releases a held Space when the canvas loses focus', () => {
    const h = harness();

    h.press(' ');
    h.canvas.dispatchEvent(new FocusEvent('blur'));
    h.key('keyup', ' ');
    expect(h.intents).toEqual([
      { kind: 'space', down: true },
      { kind: 'space', down: false },
    ]);
    h.handle.destroy();
  });

  it('releases a held Space when destroyed, since no keyup can follow', () => {
    const held = harness();
    held.press(' ');
    held.handle.destroy();
    held.key('keyup', ' ');
    expect(held.intents).toEqual([
      { kind: 'space', down: true },
      { kind: 'space', down: false },
    ]);

    const released = harness();
    released.press(' ');
    released.key('keyup', ' ');
    released.handle.destroy();
    expect(released.intents).toHaveLength(2);

    const unclaimed = harness((intent) => intent.kind !== 'space');
    unclaimed.press(' ');
    unclaimed.handle.destroy();
    expect(unclaimed.intents).toEqual([{ kind: 'space', down: true }]);
  });

  it('hands an interactor back its drags when torn down with Space held', () => {
    const t = interaction(twoArea(), [400, 100, 96, 48, 96, 200]);
    const interactor = new Interactor(t.ctx);
    const canvas = document.createElement('canvas');
    const keys = attachKeyboard(canvas, (intent) => interactor.key(intent));
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }));
    // `keyboard: false`, or `interaction: 'none'`, with the key still down.
    keys.destroy();

    interactor.gesture({
      kind: 'press',
      sx: 456,
      sy: 124,
      button: 0,
      pointerType: 'mouse',
      shift: false,
      mod: false,
      targetPx: 8,
    });
    interactor.gesture({ kind: 'dragStart', sx: 456, sy: 124, time: 0 });
    interactor.gesture({ kind: 'dragMove', sx: 472, sy: 124, dx: 16, dy: 0, time: 0 });
    expect(t.camera.pans).toEqual([]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 16, 0]);
  });

  it('makes the canvas focusable only for as long as it is attached', () => {
    const h = harness();
    expect(h.canvas.tabIndex).toBe(0);
    h.handle.destroy();
    expect(h.canvas.hasAttribute('tabindex')).toBe(false);
    expect(h.press('ArrowLeft').defaultPrevented).toBe(false);
    expect(h.intents).toEqual([]);
  });

  it('keeps a tabindex the host set', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = -1;
    const handle = attachKeyboard(canvas, () => true);
    expect(canvas.tabIndex).toBe(-1);
    handle.destroy();
    expect(canvas.getAttribute('tabindex')).toBe('-1');
  });
});
