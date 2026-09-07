// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createElementClasses } from '../src/define.js';
import type { NetworkElement } from '../src/network.js';
import { parseNetwork, validateNetworkData } from '../src/network.js';
import {
  canvasOf,
  flushMicrotasks,
  harness,
  inline,
  jsonResponse,
  networkData,
  patchesOf,
  serializedNetwork,
  topology,
  type FakeNetwork,
} from './fixtures.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Connect an element, bring it near, and wait for its source to load. */
async function live(h: ReturnType<typeof harness>, element: HTMLElement): Promise<FakeNetwork> {
  document.body.append(element);
  h.near(element, true);
  await (element as NetworkElement).ready;
  await flushMicrotasks();
  return h.networks[0]!;
}

describe('parseNetwork', () => {
  it('decodes arrays and base64, defaults straight edges, and owns its arrays', () => {
    const edges = new Uint32Array([0, 1, 1, 2]);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(edges.buffer)));

    const data = parseNetwork({
      topology: { vertexCount: 3, vertexCoords: [0, 0, 1, 1, 2, 0], edges: { base64 } },
      fields: [{ id: 'load', scope: 'vertex', values: [1, null, 3] }],
    });

    expect(data.topology.edges).toEqual(edges);
    expect(data.topology.polylineStart).toEqual(new Uint32Array([0, 0, 0]));
    expect(data.topology.vertexCoords).toBeInstanceOf(Float32Array);
    expect(data.fields![0]!.values[1]).toBeNaN();
    expect(data.fields![0]!.components).toBe(1);
    expect('vertexCoords' in data.topology).toBe(true);
    expect(Object.hasOwn(data.topology, 'polylinePoints')).toBe(false);
  });

  it('decodes a pair field as a layout', () => {
    const data = parseNetwork(serializedNetwork());
    expect(data.fields![1]).toEqual({
      id: 'ring',
      scope: 'vertex',
      components: 2,
      values: new Float32Array([0, 1, 1, 0, 0, -1]),
    });
    expect(() =>
      parseNetwork({
        topology: { vertexCount: 3, edges: [0, 1] },
        fields: [{ id: 'xy', scope: 'vertex', components: 2, values: [1, 2, 3] }],
      }),
    ).toThrow('fields[0].values length 3 != 6');
    expect(() =>
      parseNetwork({
        topology: { vertexCount: 3, edges: [0, 1] },
        fields: [{ id: 'xyz', scope: 'vertex', components: 3, values: [] }],
      }),
    ).toThrow('fields[0].components must be 1 or 2');
  });

  it('names the failing path', () => {
    expect(() => parseNetwork(null)).toThrow('@latkit/embed: root must be an object');
    expect(() => parseNetwork({})).toThrow('root.topology is required');
    expect(() => parseNetwork({ topology: { vertexCount: 1.5, edges: [] } })).toThrow(
      'topology.vertexCount must be an integer',
    );
    expect(() => parseNetwork({ topology: { vertexCount: 2, edges: [0, -1] } })).toThrow(
      'topology.edges[1] is outside the u32 range',
    );
    expect(() =>
      parseNetwork({ topology: { vertexCount: 2, edges: [0, 1], coordinateSpace: 'polar' } }),
    ).toThrow('topology.coordinateSpace must be');
    expect(() => parseNetwork({ topology: { vertexCount: 2, edges: { base64: 'AAA' } } })).toThrow(
      'base64 byte length must be divisible by 4',
    );
    expect(() =>
      parseNetwork({ topology: { vertexCount: 2, edges: [0, 1] }, fields: [{ id: 'x' }] }),
    ).toThrow('fields[0].scope is required');
    expect(() =>
      parseNetwork({
        topology: { vertexCount: 2, edges: [0, 1] },
        fields: [{ id: 'x', scope: 'vertex', values: [1] }],
      }),
    ).toThrow('fields[0].values length 1 != 2');
    expect(() => parseNetwork({ topology: { vertexCount: 2, edges: [0, 2] } })).toThrow(
      'edge endpoint out of range',
    );
  });

  it('validates decoded data as the data property receives it', () => {
    expect(validateNetworkData(networkData())).toEqual(networkData());
    expect(() => validateNetworkData({ topology: topology(), fields: {} })).toThrow(
      'fields must be an array',
    );
    expect(() =>
      validateNetworkData({
        topology: topology(),
        fields: [{ id: 'a', scope: 'vertex', components: 1, values: [1, 2, 3] }],
      }),
    ).toThrow('fields[0].values must be a Float32Array');
    expect(() =>
      validateNetworkData({
        topology: topology(),
        fields: [{ id: 'a', scope: 'vertex', values: new Float32Array(3) }],
      }),
    ).toThrow('fields[0].components must be 1 or 2');
    expect(() =>
      validateNetworkData({
        topology: topology(),
        fields: [
          { id: 'a', scope: 'edge', components: 1, values: new Float32Array(3) },
          { id: 'a', scope: 'vertex', components: 1, values: new Float32Array(3) },
        ],
      }),
    ).toThrow('fields[1].id duplicates "a"');
  });
});

describe('latkit-network', () => {
  it('renders a shadow canvas that fills the host and a slot for fallback content', () => {
    const h = harness();
    const element = h.network();
    element.innerHTML = '<p>fallback</p>';
    element.setAttribute('aria-label', 'Transfer network');
    document.body.append(element);

    const canvas = canvasOf(element);
    expect(canvas.getAttribute('part')).toBe('canvas');
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.getAttribute('aria-label')).toBe('Transfer network');
    expect(element.shadowRoot!.querySelector('slot')).not.toBeNull();
    expect(element.shadowRoot!.querySelector('style')!.textContent).toContain(':host([attached])');
    expect(element.getAttribute('state')).toBe('idle');
    expect(element.hasAttribute('attached')).toBe(false);
    expect(h.networks).toHaveLength(0);
  });

  it('activates lazily: inline JSON loads, attaches near the viewport, and reports readiness', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    inline(element, serializedNetwork());
    const loaded = vi.fn();
    element.addEventListener('load', loaded);
    document.body.append(element);
    expect(h.observing.has(element)).toBe(true);
    expect(h.networks).toHaveLength(0);

    const network = await live(h, element);

    expect(element.state).toBe('ready');
    expect(element.getAttribute('state')).toBe('ready');
    expect(network.load).toHaveBeenCalledOnce();
    expect(network.load.mock.calls[0]![0]).toMatchObject({ vertexCount: 3 });
    expect(network.attach).toHaveBeenCalledExactlyOnceWith(canvasOf(element));
    expect(network.resume).toHaveBeenCalled();
    expect(element.hasAttribute('attached')).toBe(true);
    expect(element.network).toBe(network.value);
    expect(loaded).toHaveBeenCalledOnce();
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });

  it('fetches src relative to the document, prefers the data property, and rejects bad responses', async () => {
    const h = harness({
      fetch: vi.fn((url: URL) =>
        Promise.resolve(
          url.pathname.endsWith('/missing.json')
            ? jsonResponse({}, 404)
            : jsonResponse(serializedNetwork()),
        ),
      ),
    });
    const element = h.network() as NetworkElement;
    element.setAttribute('src', 'data/network.json');
    const failed = vi.fn();
    element.addEventListener('error', failed);

    const network = await live(h, element);
    expect(vi.mocked(h.deps.fetch).mock.calls[0]![0].href).toBe(
      new URL('data/network.json', document.baseURI).href,
    );
    expect(network.load).toHaveBeenCalledOnce();

    element.setAttribute('src', 'data/missing.json');
    await expect(element.ready).rejects.toThrow('returned HTTP 404');
    expect(element.state).toBe('error');
    expect(failed).toHaveBeenCalledOnce();
    expect(network.load).toHaveBeenCalledOnce();

    element.data = networkData();
    await element.ready;
    expect(element.state).toBe('ready');
    expect(network.load).toHaveBeenCalledTimes(2);
    expect(network.load.mock.calls[1]![0]).toBe(element.data!.topology);
    expect(h.deps.fetch).toHaveBeenCalledTimes(2);

    element.data = { topology: { vertexCount: 1 } } as never;
    await expect(element.ready).rejects.toThrow('invalid data property');
  });

  it('stays idle without a source and honors a data value assigned before upgrade', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    document.body.append(element);
    h.near(element, true);
    await flushMicrotasks();
    expect(element.state).toBe('idle');
    expect(h.networks[0]!.load).not.toHaveBeenCalled();
    expect(h.networks[0]!.attach).toHaveBeenCalledOnce();

    // A framework may assign `data` before the element is defined; it lands as an own property
    // that the constructor must adopt on upgrade.
    const tag = `test-network-upgrade-${Date.now()}`;
    const pending = document.createElement(tag);
    (pending as { data?: unknown }).data = networkData();
    customElements.define(tag, createElementClasses(HTMLElement, h.deps).network);
    document.body.append(pending);
    expect(Object.hasOwn(pending, 'data')).toBe(false);
    expect((pending as NetworkElement).data).toEqual(networkData());
    h.near(pending, true);
    await (pending as NetworkElement).ready;
    expect(h.networks[1]!.load).toHaveBeenCalledOnce();
  });

  it('maps attributes onto the controller: options, colormap, channels, domains, projection', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.data = networkData();
    element.setAttribute('graticule', '');
    element.setAttribute('vertex-scale', '2');
    element.setAttribute('vertex-base-color', '0.1 0.2 0.3 1');
    element.setAttribute('motion', 'reduce');
    element.setAttribute('colormap', 'viridis');
    element.setAttribute('vertex-color', 'load');
    element.setAttribute('vertex-color-domain', '0 100');
    element.setAttribute('edge-color', 'flow');
    element.setAttribute('vertex-visible', 'capacity');
    element.setAttribute('vertex-position', 'ring');
    element.setAttribute('projection', 'tilt');

    const network = await live(h, element);

    const patches = patchesOf(network.setOptions);
    expect(patches).toMatchObject({
      graticule: true,
      vertexScale: 2,
      vertexBaseColor: [0.1, 0.2, 0.3, 1],
      motion: 'reduce',
    });
    expect(patches.colormap).toBeTypeOf('function');
    expect(network.setChannel).toHaveBeenCalledWith(
      'vertexColor',
      networkData().fields![0]!.values,
      [0, 100],
    );
    expect(network.setChannel).toHaveBeenCalledWith(
      'edgeColor',
      networkData().fields![2]!.values,
      null,
    );
    expect(network.setChannel).toHaveBeenCalledWith(
      'vertexVisible',
      networkData().fields![1]!.values,
      null,
    );
    expect(network.setChannel).toHaveBeenCalledWith(
      'vertexPosition',
      networkData().fields![3]!.values,
      null,
    );
    expect(network.setChannelDomain).toHaveBeenCalledWith('vertexColor', [0, 100]);
    expect(network.setProjection).toHaveBeenCalledWith('tilt', true);
    // After a load, channels bind before the projection applies, so a withdrawn globe falls back.
    const calls = network.setChannel.mock.invocationCallOrder;
    expect(Math.max(...calls)).toBeLessThan(network.setProjection.mock.invocationCallOrder.at(-1)!);
    expect(h.deps.warn).not.toHaveBeenCalled();

    network.setOptions.mockClear();
    network.setChannel.mockClear();
    element.setAttribute('vertex-scale', 'big');
    element.removeAttribute('graticule');
    element.setAttribute('vertex-color', 'missing');
    element.setAttribute('vertex-position', 'load');
    element.setAttribute('edge-color', '');
    element.setAttribute('vertex-color-domain', '5 1');
    element.setAttribute('colormap', 'nope');
    element.setAttribute('projection', 'orbit');
    await flushMicrotasks();

    expect(network.setOptions).toHaveBeenCalledWith({ vertexScale: 1 });
    expect(network.setOptions).toHaveBeenCalledWith({ graticule: false });
    expect(network.setChannel).toHaveBeenCalledWith('vertexColor', null);
    expect(network.setChannel).toHaveBeenCalledWith('vertexPosition', null);
    expect(network.setChannel).toHaveBeenCalledWith('edgeColor', null);
    expect(network.setChannelDomain).toHaveBeenLastCalledWith('vertexColor', null);
    expect(vi.mocked(h.deps.warn).mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid vertex-scale "big"'),
        expect.stringContaining('No vertex field "missing"'),
        expect.stringContaining('No vertex pair field "load" for vertex-position'),
        expect.stringContaining('Invalid vertex-color-domain "5 1"'),
        expect.stringContaining('Unknown colormap "nope"'),
        expect.stringContaining('Unknown projection "orbit"'),
      ]),
    );
  });

  it('reads msaa when the controller is created and warns about later changes', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.setAttribute('msaa', '4');
    element.data = networkData();
    await live(h, element);
    expect(h.deps.createNetwork).toHaveBeenCalledWith({ msaa: 4 });
    expect(h.deps.warn).not.toHaveBeenCalled();

    element.setAttribute('msaa', '1');
    await flushMicrotasks();
    expect(h.deps.warn).toHaveBeenCalledWith(expect.stringContaining('msaa is read'));

    const plain = h.network() as NetworkElement;
    plain.setAttribute('msaa', '2');
    document.body.append(plain);
    h.near(plain, true);
    await flushMicrotasks();
    expect(h.deps.createNetwork).toHaveBeenLastCalledWith({});
    expect(h.deps.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid msaa "2"'));
  });

  it('loads the packaged borders for a geographic topology while the borders attribute is on', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.setAttribute('borders', '');
    element.data = networkData();

    const network = await live(h, element);

    expect(network.setOptions).toHaveBeenCalledWith({ borders: true });
    expect(h.deps.loadBorders).toHaveBeenCalledOnce();
    const anyBytes: unknown = expect.any(Uint8Array);
    expect(network.setBorders).toHaveBeenCalledWith(
      expect.objectContaining({ vertices: anyBytes }),
    );

    element.removeAttribute('borders');
    await flushMicrotasks();
    expect(network.setBorders).toHaveBeenLastCalledWith(null);

    network.geographic = false;
    element.setAttribute('borders', 'true');
    await flushMicrotasks();
    expect(h.deps.loadBorders).toHaveBeenCalledOnce();
  });

  it('forwards controller events as composed DOM events and mirrors attachment', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.data = networkData();
    const seen: Array<[string, unknown]> = [];
    for (const type of [
      'hover',
      'select',
      'fit',
      'orbit',
      'deviceLost',
      'pipelineError',
    ] as const) {
      element.addEventListener(type, (event) => seen.push([type, event.detail]));
    }
    const failed = vi.fn();
    element.addEventListener('error', failed);
    const network = await live(h, element);

    network.emit('hover', { kind: 'vertex', index: 1 });
    network.emit('select', null);
    network.emit('fit', true);
    network.emit('orbit', false);
    network.emit('pipelineError', { family: 'globe', cause: 'x' });
    network.emit('deviceLost', { reason: 'unknown', message: 'lost', recovering: true });
    expect(seen).toEqual([
      ['hover', { kind: 'vertex', index: 1 }],
      ['select', null],
      ['fit', true],
      ['orbit', false],
      ['pipelineError', { family: 'globe', cause: 'x' }],
      ['deviceLost', { reason: 'unknown', message: 'lost', recovering: true }],
    ]);
    expect(element.state).toBe('ready');
    expect(failed).not.toHaveBeenCalled();

    network.emit('attached', false);
    expect(element.hasAttribute('attached')).toBe(false);
    network.emit('deviceLost', { reason: 'unavailable', message: 'gone', recovering: false });
    expect(element.state).toBe('error');
    expect(failed).toHaveBeenCalledOnce();
  });

  it('reflects the first paint as a `painted` attribute and event', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.data = networkData();
    const painted: boolean[] = [];
    element.addEventListener('painted', (event) => painted.push(event.detail));
    const network = await live(h, element);

    expect(element.hasAttribute('painted')).toBe(false);
    network.emit('painted', true);
    expect(element.hasAttribute('painted')).toBe(true);
    network.emit('painted', false);
    expect(element.hasAttribute('painted')).toBe(false);
    expect(painted).toEqual([true, false]);
  });

  it('parses inset, interaction, and fit attributes through the option registry', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.data = networkData();
    element.setAttribute('interaction', 'inspect');
    element.setAttribute('fit-padding-px', '96 32 160 32');
    element.setAttribute('fit-pitch', '50');
    element.setAttribute('fit-bearing', '-18');
    const network = await live(h, element);

    expect(patchesOf(network.setOptions)).toMatchObject({
      interaction: 'inspect',
      fitPaddingPx: [96, 32, 160, 32],
      fitPitch: 50,
      fitBearing: -18,
    });

    element.setAttribute('fit-padding-px', '24');
    await flushMicrotasks();
    expect(network.setOptions).toHaveBeenLastCalledWith({ fitPaddingPx: 24 });

    element.setAttribute('fit-padding-px', '1 2');
    await flushMicrotasks();
    expect(network.setOptions).toHaveBeenLastCalledWith({ fitPaddingPx: null });
    expect(h.deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid fit-padding-px "1 2"'),
    );
  });

  it('detaches on disconnect, reattaches on reconnect without refetching, and pauses when far', async () => {
    const h = harness({ fetch: vi.fn(() => Promise.resolve(jsonResponse(serializedNetwork()))) });
    const element = h.network() as NetworkElement;
    element.setAttribute('src', 'network.json');
    const network = await live(h, element);

    h.near(element, false);
    expect(network.pause).toHaveBeenCalledOnce();
    h.near(element, true);
    expect(network.resume).toHaveBeenCalledTimes(2);
    expect(network.attach).toHaveBeenCalledOnce();

    element.remove();
    expect(network.detach).toHaveBeenCalledOnce();
    expect(element.hasAttribute('attached')).toBe(false);
    expect(h.observing.has(element)).toBe(false);

    document.body.append(element);
    h.near(element, true);
    await flushMicrotasks();
    expect(network.attach).toHaveBeenCalledTimes(2);
    expect(network.load).toHaveBeenCalledOnce();
    expect(h.deps.fetch).toHaveBeenCalledOnce();
    expect(element.hasAttribute('attached')).toBe(true);
  });

  it('reports an attach failure once and retries after a reconnect', async () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.data = networkData();
    const failure = new Error('No Core WebGPU adapter is available');
    const failed = vi.fn();
    element.addEventListener('error', (event) => failed(event.detail.error));
    expect(element.network).toBe(h.networks[0]!.value);
    h.networks[0]!.failAttach(failure);
    document.body.append(element);

    h.near(element, false);
    expect(h.networks[0]!.attach).not.toHaveBeenCalled();
    h.near(element, true);
    await element.ready;
    await flushMicrotasks();

    expect(element.state).toBe('error');
    expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
    h.near(element, false);
    h.near(element, true);
    await flushMicrotasks();
    expect(h.networks[0]!.attach).toHaveBeenCalledOnce();

    element.remove();
    document.body.append(element);
    h.near(element, true);
    await flushMicrotasks();
    expect(h.networks[0]!.attach).toHaveBeenCalledTimes(2);
    expect(element.hasAttribute('attached')).toBe(true);
  });

  it('exposes the controller before activation and applies present attributes to it', () => {
    const h = harness();
    const element = h.network() as NetworkElement;
    element.setAttribute('daylight', 'false');

    const network = element.network;

    expect(network).toBe(h.networks[0]!.value);
    expect(h.networks[0]!.setOptions).toHaveBeenCalledWith({ daylight: false });
    expect(element.network).toBe(network);
  });
});
