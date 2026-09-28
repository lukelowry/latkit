import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../src/emitter.js';

type Events = {
  ping: number;
  empty: undefined;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEmitter', () => {
  it('ignores events with no listeners and supports unsubscribe/clear', () => {
    const events = createEmitter<Events>();
    const handler = vi.fn();

    events.emit('empty', undefined);
    const off = events.on('ping', handler);
    events.emit('ping', 1);
    off();
    events.emit('ping', 2);
    events.on('ping', handler);
    events.clear();
    events.emit('ping', 3);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(1);
  });

  it('continues through throwing handlers and rethrows asynchronously', () => {
    const queued: Array<() => void> = [];
    vi.stubGlobal('queueMicrotask', (cb: () => void) => {
      queued.push(cb);
    });
    const events = createEmitter<Events>();
    const error = new Error('listener failed');
    const after = vi.fn();
    events.on('ping', () => {
      throw error;
    });
    events.on('ping', after);

    events.emit('ping', 4);

    expect(after).toHaveBeenCalledWith(4);
    expect(queued).toHaveLength(1);
    expect(() => queued[0]!()).toThrow(error);
  });
});
