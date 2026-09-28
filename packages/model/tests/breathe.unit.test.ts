import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { breathe } from '../src/breathe.js';

afterEach(() => vi.unstubAllGlobals());

describe('cooperative scheduling', () => {
  it('uses the native scheduler when available', async () => {
    const yieldTask = vi.fn(async () => {});
    vi.stubGlobal('scheduler', { yield: yieldTask });
    await breathe();
    expect(yieldTask).toHaveBeenCalledOnce();
  });

  it('crosses a task boundary for concurrent callers and again for their continuations', async () => {
    vi.stubGlobal('scheduler', undefined);
    const order: number[] = [];
    const first = Promise.all([0, 1, 2].map((i) => breathe().then(() => order.push(i))));
    await Promise.resolve();
    expect(order).toEqual([]);
    await first;
    expect(order).toEqual([0, 1, 2]);

    const next = breathe().then(() => order.push(3));
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2]);
    await next;
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('finishes every yield and lets a Node process exit naturally', async () => {
    const source = new URL('../src/breathe.ts', import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          const { breathe } = await import(${JSON.stringify(source)});
          globalThis.scheduler = undefined;
          await Promise.all([breathe(), breathe(), breathe()]);
          await breathe();
          console.log('completed');
        `,
      ],
      { timeout: 3000 },
    );
    expect(stdout.trim()).toBe('completed');
  });
});
