// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { createInputRevision, resolveInput, selectSource } from '../src/source.js';
import { networkData, serializedNetwork } from './fixtures.js';

describe('network element sources', () => {
  it('selects direct data before src and src before inline data', () => {
    const host = document.createElement('div');
    host.setAttribute('src', 'network.json');
    const direct = networkData();

    expect(selectSource(host, direct)).toEqual({ kind: 'data', value: direct });
    expect(selectSource(host, null)).toEqual({ kind: 'url', value: 'network.json' });
    host.removeAttribute('src');
    expect(selectSource(host, null)).toEqual({ kind: 'inline' });
  });

  it('identifies invalid direct-property data at the element boundary', async () => {
    const host = document.createElement('div');
    const input = createInputRevision({ kind: 'data', value: {} });

    await expect(resolveInput(input, host, new AbortController().signal)).rejects.toThrow(
      '@latkit/embed: invalid data property',
    );
  });

  it('reads exactly one direct inline JSON script and caches decoded data', async () => {
    const host = document.createElement('div');
    const nested = document.createElement('div');
    nested.innerHTML = '<script type="application/json">not direct</script>';
    const script = document.createElement('script');
    script.type = 'application/json';
    script.textContent = JSON.stringify(serializedNetwork());
    host.append(nested, script);
    const input = createInputRevision({ kind: 'inline' });

    const first = await resolveInput(input, host, new AbortController().signal);
    script.textContent = 'invalid after resolution';
    const second = await resolveInput(input, host, new AbortController().signal);

    expect(second).toBe(first);
    expect(first.topology.vertexCount).toBe(3);
  });

  it('rejects missing or ambiguous direct inline scripts', async () => {
    const host = document.createElement('div');
    const input = createInputRevision({ kind: 'inline' });

    await expect(resolveInput(input, host, new AbortController().signal)).rejects.toThrow(
      'found 0',
    );

    host.innerHTML =
      '<script type="application/json">{}</script><script type="application/json">{}</script>';
    await expect(resolveInput(input, host, new AbortController().signal)).rejects.toThrow(
      'found 2',
    );
  });

  it('fetches URL data once with the activation signal and requires an OK response', async () => {
    const host = document.createElement('div');
    const controller = new AbortController();
    const fetcher = vi.fn(async () => response(serializedNetwork()));
    const input = createInputRevision({ kind: 'url', value: '/network.json' });

    const first = await resolveInput(input, host, controller.signal, fetcher);
    const second = await resolveInput(input, host, controller.signal, fetcher);

    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(new URL('/network.json', host.baseURI), {
      signal: controller.signal,
    });

    const failed = createInputRevision({ kind: 'url', value: '/missing.json' });
    await expect(
      resolveInput(failed, host, controller.signal, async () => response({}, 404)),
    ).rejects.toThrow('HTTP 404');
  });

  it('rejects cancellation before returning a cached decoded source', async () => {
    const host = document.createElement('div');
    const input = createInputRevision({ kind: 'data', value: networkData() });
    const active = new AbortController();
    const decoded = await resolveInput(input, host, active.signal);
    const cancelled = new AbortController();
    cancelled.abort(new DOMException('stale', 'AbortError'));

    await expect(resolveInput(input, host, cancelled.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(input.decoded).toBe(decoded);
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
