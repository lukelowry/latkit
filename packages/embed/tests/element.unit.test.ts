// @vitest-environment jsdom

import { GpuUnavailableError } from '@latkit/gpu';
import type { Borders } from '@latkit/network';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkData } from '../src/data/types.js';
import type { DeviceLease } from '../src/device-pool.js';
import {
  createNetworkElementClass,
  register,
  type ElementDependencies,
  type NetworkElement,
} from '../src/element.js';
import type { InputRevision } from '../src/source.js';
import {
  deferred,
  fakeNetwork,
  flushMicrotasks,
  networkData,
  networkDataWithFields,
  type FakeNetwork,
} from './fixtures.js';

let tagId = 0;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('NetworkElement', () => {
  it('registers the public tag idempotently', () => {
    register();
    const constructor = customElements.get('latkit-network');

    register();

    expect(constructor).toBeTypeOf('function');
    expect(customElements.get('latkit-network')).toBe(constructor);
  });

  it('activates lazily, loads a real topology boundary, and swaps fallback for canvas', async () => {
    const h = harness();
    h.element.innerHTML = '<p>WebGPU fallback</p>';
    const loaded = vi.fn();
    h.element.addEventListener('load', loaded);
    document.body.append(h.element);

    expect(h.dependencies.acquireDevice).not.toHaveBeenCalled();
    expect(stage(h.element).hidden).toBe(true);
    expect(fallback(h.element).hidden).toBe(false);

    h.near(true);
    await h.element.ready;

    expect(h.dependencies.resolveInput).toHaveBeenCalledOnce();
    expect(h.dependencies.acquireDevice).toHaveBeenCalledOnce();
    expect(h.networks[0]!.load).toHaveBeenCalledWith(h.data);
    expect(h.networks[0]!.setColormap).toHaveBeenCalledOnce();
    expect(h.networks[0]!.setProjection).toHaveBeenCalledWith('flat');
    expect(h.networks[0]!.fadeIn).toHaveBeenCalledOnce();
    expect(h.networks[0]!.pause).toHaveBeenCalledOnce();
    expect(h.networks[0]!.pause.mock.invocationCallOrder[0]).toBeLessThan(
      h.networks[0]!.load.mock.invocationCallOrder[0]!,
    );
    expect(h.networks[0]!.fadeIn.mock.invocationCallOrder[0]).toBeLessThan(
      h.networks[0]!.resume.mock.invocationCallOrder[0]!,
    );
    expect(stage(h.element).hidden).toBe(false);
    expect(fallback(h.element).hidden).toBe(true);
    expect(canvas(h.element).getAttribute('aria-label')).toBe(
      'Network with 3 vertices and 3 edges',
    );
    expect(loaded).toHaveBeenCalledOnce();
  });

  it('binds every canonical Network channel from its matching HTML attribute', async () => {
    const data = networkDataWithFields();
    const h = harness(async () => data);
    h.element.setAttribute('colormap', 'plasma');
    h.element.setAttribute('projection', 'tilt');
    h.element.setAttribute('vertex-color', 'load');
    h.element.setAttribute('vertex-height', 'load');
    h.element.setAttribute('vertex-size', 'capacity');
    h.element.setAttribute('edge-color', 'flow');
    h.element.setAttribute('edge-dash', 'flow');
    document.body.append(h.element);
    h.near(true);

    await h.element.ready;

    expect(h.networks[0]!.setChannel.mock.calls.map((call) => String(call[0]))).toEqual([
      'vertexColor',
      'vertexHeight',
      'vertexSize',
      'edgeColor',
      'edgeDash',
    ]);
    expect(h.networks[0]!.setProjection).toHaveBeenCalledWith('tilt');
    expect(h.dependencies.warn).not.toHaveBeenCalled();
  });

  it('updates only changed view state without replacing the activation', async () => {
    const data = networkDataWithFields();
    const h = harness(async () => data);
    document.body.append(h.element);
    h.near(true);
    const ready = h.element.ready;
    await ready;
    const network = h.networks[0]!;
    network.setColormap.mockClear();
    network.setChannel.mockClear();
    network.setProjection.mockClear();

    h.element.setAttribute('colormap', 'magma');
    expect(network.setColormap).toHaveBeenCalledOnce();
    expect(network.setChannel).not.toHaveBeenCalled();
    expect(network.setProjection).not.toHaveBeenCalled();

    h.element.setAttribute('projection', 'tilt');
    expect(network.setProjection).toHaveBeenCalledWith('tilt');
    expect(network.setChannel).not.toHaveBeenCalled();

    h.element.setAttribute('vertex-size', 'capacity');
    expect(network.setChannel).toHaveBeenCalledWith(
      'vertexSize',
      data.fields![1]!.values,
      [40, 80],
    );

    h.element.setAttribute('vertex-color', '');
    expect(network.clearChannel).toHaveBeenCalledWith('vertexColor');
    h.element.removeAttribute('vertex-color');
    expect(network.setChannel).toHaveBeenCalledWith(
      'vertexColor',
      data.fields![0]!.values,
      [10, 30],
    );
    expect(h.element.ready).toBe(ready);
    expect(h.dependencies.createNetwork).toHaveBeenCalledOnce();
  });

  it('reapplies explicit same-identity mutable values', async () => {
    const h = harness(async () => networkDataWithFields());
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;
    const values = new Float32Array([1, 2, 3]);
    const customMap = (value: number) => [value, value, value] as const;
    const borders = validBorders();

    h.element.setChannel('vertexSize', values, [1, 3]);
    h.element.setColormap(customMap);
    h.element.setBorders(borders);
    network.setChannel.mockClear();
    network.setColormap.mockClear();
    network.setBorders.mockClear();

    values[0] = 3;
    h.element.setChannel('vertexSize', values, [1, 3]);
    h.element.setColormap(customMap);
    h.element.setBorders(borders);

    expect(network.setChannel).toHaveBeenCalledWith('vertexSize', values, [1, 3]);
    expect(network.setColormap).toHaveBeenCalledWith(customMap);
    expect(network.setBorders).toHaveBeenCalledWith(borders);
  });

  it('warns once per invalid attribute value without failing activation', async () => {
    const h = harness(async () => networkDataWithFields());
    h.element.setAttribute('edge-color', 'missing');
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    expect(h.dependencies.warn).toHaveBeenCalledOnce();
    expect(h.dependencies.warn).toHaveBeenCalledWith(
      'Unknown field "missing" for edge-color; leaving edgeColor unbound.',
    );

    h.element.setAttribute('edge-color', 'flow');
    h.element.setAttribute('edge-color', 'missing');
    expect(h.dependencies.warn).toHaveBeenCalledOnce();
    expect(stage(h.element).hidden).toBe(false);
  });

  it('uses data before src and activates the current URL when data returns to null', async () => {
    const h = harness();
    h.element.setAttribute('src', 'first.json');
    h.element.data = networkData();
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    const firstInput = h.inputs[0]!;
    expect(firstInput.source.kind).toBe('data');

    h.element.setAttribute('src', 'second.json');
    await flushMicrotasks();
    expect(h.inputs).toHaveLength(1);

    h.element.data = null;
    await h.element.ready;

    expect(h.inputs[1]!.source).toEqual({ kind: 'url', value: 'second.json' });
    expect(h.networks[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.leases[0]!.release).toHaveBeenCalledOnce();
  });

  it('rejects superseded readiness and prevents stale source results from committing', async () => {
    const first = deferred<NetworkData>();
    const second = deferred<NetworkData>();
    const h = harness((input) =>
      (input.source as { value?: string }).value === 'first.json' ? first.promise : second.promise,
    );
    h.element.setAttribute('src', 'first.json');
    document.body.append(h.element);
    h.near(true);
    const staleReady = h.element.ready;
    const staleRejection = expect(staleReady).rejects.toMatchObject({ name: 'AbortError' });

    h.element.setAttribute('src', 'second.json');
    const currentReady = h.element.ready;
    second.resolve(networkData());
    await currentReady;
    first.resolve(networkData());
    await staleRejection;
    await flushMicrotasks();

    expect(h.dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(h.networks).toHaveLength(1);
  });

  it('keeps fallback content for expected WebGPU unavailability without warning', async () => {
    const h = harness();
    vi.mocked(h.dependencies.acquireDevice).mockRejectedValueOnce(new GpuUnavailableError('api'));
    const errors: unknown[] = [];
    h.element.addEventListener('error', (event) => {
      errors.push((event as unknown as CustomEvent<{ error: unknown }>).detail.error);
    });
    document.body.append(h.element);
    const ready = h.element.ready;

    h.near(true);
    await expect(ready).rejects.toBeInstanceOf(GpuUnavailableError);

    expect(errors).toHaveLength(1);
    expect(h.dependencies.warn).not.toHaveBeenCalled();
    expect(stage(h.element).hidden).toBe(true);
    expect(fallback(h.element).hidden).toBe(false);
  });

  it('pauses offscreen, resumes on return, and releases activation resources on disconnect', async () => {
    const h = harness();
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    h.near(false);
    h.near(true);
    expect(h.networks[0]!.pause).toHaveBeenCalledTimes(2);
    expect(h.networks[0]!.resume).toHaveBeenCalledTimes(2);

    h.element.remove();
    expect(h.networks[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.leases[0]!.release).toHaveBeenCalledOnce();
    expect(h.observeCleanup).toHaveBeenCalledOnce();
  });

  it('reuses an input revision but installs new readiness after reconnect', async () => {
    const h = harness();
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const firstInput = h.inputs[0];
    const shadow = h.element.shadowRoot;
    const projectionControl = shadow!.querySelector('[part="projection"]');

    h.element.remove();
    document.body.append(h.element);
    const reconnectedReady = h.element.ready;
    h.near(true);
    await reconnectedReady;

    expect(h.inputs[1]).toBe(firstInput);
    expect(h.networks).toHaveLength(2);
    expect(h.element.shadowRoot).toBe(shadow);
    expect(shadow!.querySelector('[part="projection"]')).toBe(projectionControl);
  });

  it('captures a data property assigned before custom-element upgrade', async () => {
    const setup = dependencies();
    const tag = nextTag();
    const element = document.createElement(tag) as HTMLElement & { data: NetworkData };
    const assigned = networkData();
    element.data = assigned;
    document.body.append(element);

    customElements.define(tag, createNetworkElementClass(HTMLElement, setup.value));
    const upgraded = element as unknown as NetworkElement;
    setup.near(true);
    await upgraded.ready;

    expect(setup.inputs[0]!.source).toEqual({ kind: 'data', value: assigned });
  });

  it('installs new activation readiness during device-loss recovery', async () => {
    const data = networkDataWithFields();
    const h = harness(async () => data);
    h.element.setAttribute('vertex-height', 'load');
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    h.element.setAttribute('projection', 'tilt');

    h.networks[0]!.emit('deviceLost', 'unknown', 'test loss');
    await flushMicrotasks();
    const recoveryReady = h.element.ready;
    await recoveryReady;

    expect(h.networks).toHaveLength(2);
    expect(h.networks[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.leases[0]!.release).toHaveBeenCalledOnce();
    expect(h.networks[1]!.setProjection).toHaveBeenCalledWith('tilt');
    expect(h.networks[1]!.setChannel).toHaveBeenCalledWith(
      'vertexHeight',
      data.fields![0]!.values,
      [10, 30],
      [0, 1],
    );
  });

  it('falls back permanently after exhausting device-loss recovery', async () => {
    const h = harness();
    const errors: unknown[] = [];
    h.element.addEventListener('error', (event) => {
      errors.push((event as unknown as CustomEvent<{ error: unknown }>).detail.error);
    });
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    for (let recovery = 0; recovery < 2; recovery++) {
      h.networks[recovery]!.emit('deviceLost', 'unknown', `loss ${recovery + 1}`);
      await flushMicrotasks();
      await h.element.ready;
    }

    h.networks[2]!.emit('deviceLost', 'unknown', 'loss 3');
    await flushMicrotasks();

    await expect(h.element.ready).rejects.toThrow('repeatedly lost');
    expect(h.networks).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(h.dependencies.warn).toHaveBeenCalledOnce();
    expect(stage(h.element).hidden).toBe(true);
    expect(fallback(h.element).hidden).toBe(false);
  });

  it('retains and applies the complete Network-style configuration before activation', async () => {
    const h = harness();
    const values = new Float32Array([0, 5, 10]);
    const customColormap = (value: number) => [value, 0.25, 1 - value] as const;
    const customBorders = validBorders();

    h.element.setOptions({
      msaa: 4,
      edges: false,
      vertexScale: 1.25,
      edgeScale: 0.75,
      heightScale: 1.5,
      vertexLodPx: 3,
      dashPeriodPx: 16,
      nightFloor: 0.25,
      baseColor: [0.1, 0.2, 0.3, 1],
      colormap: customColormap,
    });
    h.element.setBorders(customBorders);
    h.element.setChannel('vertexHeight', values, [0, 10], [0, 2]);
    h.element.setChannelRange('vertexHeight', [2, 8]);
    expect(h.element.setProjection('tilt')).toBe(false);

    expect(h.element.getAttribute('msaa')).toBe('4');
    expect(h.element.getAttribute('edges')).toBe('false');
    expect(h.element.getAttribute('vertex-scale')).toBe('1.25');
    expect(h.element.getAttribute('edge-scale')).toBe('0.75');
    expect(h.element.getAttribute('height-scale')).toBe('1.5');
    expect(h.element.getAttribute('vertex-lod-px')).toBe('3');
    expect(h.element.getAttribute('dash-period-px')).toBe('16');
    expect(h.element.getAttribute('base-color')).toBe('0.1 0.2 0.3 1');
    expect(h.element.getAttribute('vertex-height')).toBe('');
    expect(h.element.getAttribute('vertex-height-domain')).toBe('2 8');
    expect(h.element.getAttribute('vertex-height-range')).toBeNull();

    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    expect(h.dependencies.createNetwork).toHaveBeenCalledWith(
      h.leases[0]!.device,
      canvas(h.element),
      expect.objectContaining({
        msaa: 4,
        edges: false,
        vertexScale: 1.25,
        edgeScale: 0.75,
        heightScale: 1.5,
        vertexLodPx: 3,
        dashPeriodPx: 16,
        nightFloor: 0.25,
        baseColor: [0.1, 0.2, 0.3, 1],
      }),
    );
    expect(h.networks[0]!.setOptions).not.toHaveBeenCalled();
    expect(h.networks[0]!.setColormap).toHaveBeenCalledWith(customColormap);
    expect(h.networks[0]!.setBorders).toHaveBeenCalledWith(customBorders);
    expect(h.networks[0]!.setChannel).toHaveBeenCalledWith('vertexHeight', values, [0, 10], [0, 2]);
    expect(h.networks[0]!.setChannelRange).toHaveBeenCalledWith('vertexHeight', [2, 8]);
    expect(h.networks[0]!.setProjection).toHaveBeenCalledWith('tilt');
  });

  it('validates complete configuration calls before mutating reflected or direct state', async () => {
    const h = harness();

    expect(() =>
      h.element.setOptions({
        edges: false,
        baseColor: [0, 0, Number.NaN, 1],
      }),
    ).toThrow(RangeError);
    expect(h.element.hasAttribute('edges')).toBe(false);
    expect(h.element.hasAttribute('base-color')).toBe(false);

    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;
    network.setChannel.mockClear();

    expect(() => h.element.setChannel('vertexSize', new Float32Array([1, 2]))).toThrow(
      'length 2 != 3',
    );
    expect(h.element.hasAttribute('vertex-size')).toBe(false);
    expect(network.setChannel).not.toHaveBeenCalled();
    expect(() => h.element.setChannelRange('vertexColor', [2, 1])).toThrow(RangeError);
    expect(h.element.hasAttribute('vertex-color-domain')).toBe(false);
  });

  it('ignores channel range arguments that Network ignores', async () => {
    const h = harness();
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;
    const vertexValues = new Float32Array([1, 2, 3]);
    const edgeValues = new Float32Array([1, 0, 1]);
    const invalidRange = [Number.NaN, Number.NEGATIVE_INFINITY] as const;

    expect(() =>
      h.element.setChannel('vertexColor', vertexValues, undefined, [2, 1]),
    ).not.toThrow();
    expect(network.setChannel).toHaveBeenLastCalledWith('vertexColor', vertexValues, undefined);

    expect(() =>
      h.element.setChannel('edgeDash', edgeValues, invalidRange, invalidRange),
    ).not.toThrow();
    expect(network.setChannel).toHaveBeenLastCalledWith('edgeDash', edgeValues);

    network.setChannelRange.mockClear();

    expect(() =>
      h.element.setChannel('vertexVisible', vertexValues, invalidRange, invalidRange),
    ).not.toThrow();
    expect(network.setChannel).toHaveBeenLastCalledWith('vertexVisible', vertexValues);
    expect(h.element.getAttribute('vertex-visible-domain')).toBeNull();

    expect(() =>
      h.element.setChannel('edgeVisible', edgeValues, invalidRange, invalidRange),
    ).not.toThrow();
    expect(network.setChannel).toHaveBeenLastCalledWith('edgeVisible', edgeValues);
    expect(h.element.getAttribute('edge-visible-domain')).toBeNull();

    expect(() => h.element.setChannelRange('vertexVisible', invalidRange)).not.toThrow();
    expect(() => h.element.setChannelRange('edgeVisible', invalidRange)).not.toThrow();
    expect(network.setChannelRange).not.toHaveBeenCalled();
  });

  it('keeps direct values across range changes and replaces them on same-value field reassertion', async () => {
    const h = harness();
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;
    const values = new Float32Array([2, 4, 6]);

    h.element.setChannel('vertexSize', values, [0, 8]);
    network.setChannel.mockClear();
    network.setChannelRange.mockClear();
    network.clearChannel.mockClear();

    h.element.setChannelRange('vertexSize', [1, 7]);
    expect(network.setChannel).not.toHaveBeenCalled();
    expect(network.setChannelRange).toHaveBeenCalledWith('vertexSize', [1, 7]);

    h.element.setAttribute('vertex-size', '');
    expect(network.clearChannel).toHaveBeenCalledWith('vertexSize');
    expect(network.setChannel).not.toHaveBeenCalled();
  });

  it('keeps pending readiness while construction state is unresolved and replaces live msaa', async () => {
    const source = deferred<NetworkData>();
    const h = harness(async () => source.promise);
    document.body.append(h.element);
    h.near(true);
    await flushMicrotasks();
    const pending = h.element.ready;

    h.element.setAttribute('msaa', '4');
    expect(h.element.ready).toBe(pending);
    source.resolve(networkData());
    await pending;

    h.element.setAttribute('msaa', '1');
    const replacement = h.element.ready;
    expect(replacement).not.toBe(pending);
    await replacement;

    expect(h.networks).toHaveLength(2);
    expect(h.networks[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.dependencies.createNetwork).toHaveBeenLastCalledWith(
      h.leases[1]!.device,
      canvas(h.element),
      expect.objectContaining({ msaa: 1 }),
    );
  });

  it('forwards commands only while live and keeps programmatic selection event-free', async () => {
    const h = harness();
    const selected = vi.fn();
    h.element.addEventListener('select', selected);

    h.element.fit(true);
    expect(h.element.reveal({ kind: 'vertex', index: 1 })).toBe(false);
    h.element.panBy(1, 2);
    h.element.rotateBy(3, 4);
    expect(h.element.getPose()).toBeNull();
    expect(h.element.setPose({ bearing: 45 })).toBe(false);
    h.element.zoomBy(1.5);
    h.element.fadeIn(300);
    h.element.select('vertex', 1);
    h.element.clearSelection();

    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;
    network.fit.mockClear();
    network.fadeIn.mockClear();

    h.element.fit(true);
    h.element.fit([{ kind: 'vertex', index: 1 }], true);
    expect(h.element.reveal({ kind: 'vertex', index: 1 }, { paddingPx: 32, animate: true })).toBe(
      true,
    );
    h.element.panBy(12, -8);
    h.element.rotateBy(6, -2);
    expect(h.element.getPose()).toEqual({ centerX: 1, centerY: 2, pitch: 3, bearing: 4 });
    expect(h.element.setPose({ bearing: 90 }, { animate: true })).toBe(true);
    h.element.zoomBy(1.25);
    h.element.fadeIn(240);
    h.element.select('vertex', 1);
    h.element.clearSelection();

    expect(network.fit).toHaveBeenCalledWith(true);
    expect(network.fit).toHaveBeenCalledWith([{ kind: 'vertex', index: 1 }], true);
    expect(network.reveal).toHaveBeenCalledWith(
      { kind: 'vertex', index: 1 },
      { paddingPx: 32, animate: true },
    );
    expect(network.panBy).toHaveBeenCalledWith(12, -8);
    expect(network.rotateBy).toHaveBeenCalledWith(6, -2);
    expect(network.getPose).toHaveBeenCalledOnce();
    expect(network.setPose).toHaveBeenCalledWith({ bearing: 90 }, { animate: true });
    expect(network.zoomBy).toHaveBeenCalledWith(1.25);
    expect(network.fadeIn).toHaveBeenCalledWith(240);
    expect(network.select).toHaveBeenCalledWith('vertex', 1);
    expect(network.clearSelection).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
    expect(() => h.element.select('edge', 3)).toThrow(RangeError);
  });

  it('forwards exact frozen, bubbling, composed Network DOM events after state updates', async () => {
    const h = harness(async () => networkDataWithFields());
    const events: CustomEvent<unknown>[] = [];
    for (const type of ['hover', 'select', 'zoom'] as const) {
      document.body.addEventListener(type, (event) => events.push(event as CustomEvent<unknown>));
    }
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    h.networks[0]!.emit('hover', 'vertex', 1);
    h.networks[0]!.emit('select', 'edge', 2);
    h.networks[0]!.emit('zoom', false);

    expect(events.map((event) => [event.type, event.detail])).toEqual([
      ['hover', { kind: 'vertex', index: 1 }],
      ['select', { kind: 'edge', index: 2 }],
      ['zoom', { atFitView: false }],
    ]);
    for (const event of events) {
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      expect(Object.isFrozen(event.detail)).toBe(true);
    }
    expect(caption(h.element).textContent).toContain('Selected: Edge 2');
  });

  it('combines durable consumer pause with viewport pause without redundant calls', async () => {
    const h = harness();
    h.element.pause();
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;

    expect(network.pause).toHaveBeenCalledOnce();
    h.element.resume();
    expect(network.resume).toHaveBeenCalledOnce();
    h.near(false);
    expect(network.pause).toHaveBeenCalledTimes(2);
    h.element.pause();
    h.near(true);
    expect(network.resume).toHaveBeenCalledOnce();
    h.element.resume();
    expect(network.resume).toHaveBeenCalledTimes(2);
  });

  it('preserves direct bindings, selection, projection, and pause through one loss path', async () => {
    const h = harness(async () => networkDataWithFields());
    const losses: CustomEvent[] = [];
    h.element.addEventListener('deviceLost', (event) => losses.push(event));
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    const dash = new Float32Array([1, 0, 1]);
    h.element.setChannel('edgeDash', dash);
    h.element.setProjection('globe');
    h.element.select('vertex', 2);
    h.element.pause();
    h.networks[0]!.emit('deviceLost', 'destroyed', 'shared loss');
    const recovery = h.element.ready;
    await recovery;

    expect(losses).toHaveLength(1);
    expect(losses[0]!.detail).toEqual({
      reason: 'destroyed',
      message: 'shared loss',
      recovering: true,
    });
    expect(h.networks).toHaveLength(2);
    expect(h.networks[1]!.setChannel).toHaveBeenCalledWith('edgeDash', dash);
    expect(h.networks[1]!.setProjection).toHaveBeenCalledWith('globe');
    expect(h.networks[1]!.select).toHaveBeenCalledWith('vertex', 2);
    expect(h.networks[1]!.pause).toHaveBeenCalledOnce();

    h.networks[0]!.emit('deviceLost', 'destroyed', 'stale duplicate');
    expect(losses).toHaveLength(1);
    expect(h.networks).toHaveLength(2);
  });

  it('forwards asynchronous pipeline failures as a DOM event', async () => {
    const h = harness();
    const failures: CustomEvent[] = [];
    h.element.addEventListener('pipelineError', (event) => failures.push(event));
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    const cause = new Error('shader no good');
    h.networks[0]!.emit('pipelineError', 'globe', cause);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.detail).toEqual({ pipeline: 'globe', cause });
  });

  it('installs rejected current readiness after a post-live mutation failure', async () => {
    const h = harness();
    const errors: unknown[] = [];
    h.element.addEventListener('error', (event) => errors.push(event.detail.error));
    document.body.append(h.element);
    h.near(true);
    const liveReady = h.element.ready;
    await liveReady;
    const failure = new Error('runtime mutation failed');
    h.networks[0]!.setOptions.mockImplementationOnce(() => {
      throw failure;
    });

    h.element.setAttribute('edges', 'false');
    const failedReady = h.element.ready;

    expect(failedReady).not.toBe(liveReady);
    await expect(failedReady).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    expect(h.networks[0]!.destroy).toHaveBeenCalledOnce();
    expect(stage(h.element).hidden).toBe(true);
    expect(fallback(h.element).hidden).toBe(false);
  });

  it('waits for relevant packaged borders and ignores a stale failed participation', async () => {
    const borders = deferred<ReturnType<typeof validBorders>>();
    const h = harness();
    vi.mocked(h.dependencies.loadNaturalEarthBorders).mockImplementationOnce((signal) =>
      abortable(borders.promise, signal),
    );
    h.element.setAttribute('border-source', 'natural-earth');
    document.body.append(h.element);
    h.near(true);
    await flushMicrotasks();
    const ready = h.element.ready;
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    h.element.setAttribute('borders', 'false');
    await ready;
    borders.reject(new Error('stale border failure'));
    await flushMicrotasks();

    expect(h.dependencies.warn).not.toHaveBeenCalled();
    expect(h.networks[0]!.setBorders).toHaveBeenLastCalledWith(null);
  });

  it('stops initial border participation when the element leaves the viewport', async () => {
    const borders = deferred<ReturnType<typeof validBorders>>();
    const h = harness();
    vi.mocked(h.dependencies.loadNaturalEarthBorders).mockImplementationOnce((signal) =>
      abortable(borders.promise, signal),
    );
    h.element.setAttribute('border-source', 'natural-earth');
    document.body.append(h.element);
    h.near(true);
    await flushMicrotasks();
    const ready = h.element.ready;

    h.near(false);
    await expect(ready).resolves.toBeUndefined();

    expect(h.dependencies.loadNaturalEarthBorders).toHaveBeenCalledOnce();
    expect(h.dependencies.warn).not.toHaveBeenCalled();
    expect(h.networks[0]!.setBorders).toHaveBeenLastCalledWith(null);
  });

  it('defers a newly enabled packaged border source until an offscreen element returns', async () => {
    const borders = deferred<ReturnType<typeof validBorders>>();
    const payload = validBorders();
    const h = harness();
    vi.mocked(h.dependencies.loadNaturalEarthBorders).mockImplementationOnce((signal) =>
      abortable(borders.promise, signal),
    );
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;

    h.near(false);
    h.element.setAttribute('border-source', 'natural-earth');
    await flushMicrotasks();
    expect(h.dependencies.loadNaturalEarthBorders).not.toHaveBeenCalled();

    h.near(true);
    await flushMicrotasks();
    expect(h.dependencies.loadNaturalEarthBorders).toHaveBeenCalledOnce();
    borders.resolve(payload);
    await flushMicrotasks();
    expect(h.networks[0]!.setBorders).toHaveBeenLastCalledWith(payload);
  });

  it('keeps border asset failure nonfatal only while the source remains relevant', async () => {
    const h = harness();
    const failure = new Error('border HTTP failure');
    vi.mocked(h.dependencies.loadNaturalEarthBorders).mockRejectedValueOnce(failure);
    h.element.setAttribute('border-source', 'natural-earth');
    document.body.append(h.element);
    h.near(true);

    await expect(h.element.ready).resolves.toBeUndefined();
    expect(h.dependencies.warn).toHaveBeenCalledWith(
      'Natural Earth borders could not be loaded; continuing without them.',
      failure,
    );
    expect(h.networks[0]!.setBorders).toHaveBeenLastCalledWith(null);
  });

  it('ignores callbacks from a disconnected observer generation after reconnect', async () => {
    const h = harness();
    document.body.append(h.element);
    h.element.remove();
    document.body.append(h.element);

    h.notifyObserver(0, true);
    await flushMicrotasks();
    expect(h.dependencies.acquireDevice).not.toHaveBeenCalled();

    h.notifyObserver(1, true);
    await h.element.ready;
    expect(h.dependencies.acquireDevice).toHaveBeenCalledOnce();
  });

  it('does not replace a live input revision for the identical direct source object', async () => {
    const h = harness();
    const data = networkData();
    h.element.data = data;
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const ready = h.element.ready;

    h.element.data = data;

    expect(h.element.ready).toBe(ready);
    expect(h.networks).toHaveLength(1);
    expect(h.inputs).toHaveLength(1);
  });

  it('clears topology-scoped direct channels and selection on an effective source change', async () => {
    const h = harness();
    const first = networkData();
    const second = networkDataWithFields();
    h.element.data = first;
    h.element.setOptions({ edges: false });
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const direct = new Float32Array([1, 0, 1]);
    h.element.setChannel('edgeDash', direct);
    h.element.select('vertex', 1);

    h.element.data = second;
    await h.element.ready;

    expect(h.networks).toHaveLength(2);
    expect(h.networks[1]!.setChannel).not.toHaveBeenCalledWith('edgeDash', direct);
    expect(h.networks[1]!.select).not.toHaveBeenCalled();
    expect(h.dependencies.createNetwork).toHaveBeenLastCalledWith(
      h.leases[1]!.device,
      canvas(h.element),
      expect.objectContaining({ edges: false }),
    );
  });

  it('lets same-value declarative assignments replace custom colormap and border overrides', async () => {
    const h = harness();
    h.element.setAttribute('colormap', 'magma');
    h.element.setAttribute('border-source', 'none');
    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    const network = h.networks[0]!;
    const customMap = (value: number) => [value, value, value] as const;
    const borders = validBorders();
    h.element.setColormap(customMap);
    h.element.setBorders(borders);
    network.setColormap.mockClear();
    network.setBorders.mockClear();

    h.element.setAttribute('colormap', 'magma');
    h.element.setAttribute('border-source', 'none');

    expect(network.setColormap).toHaveBeenCalledOnce();
    expect(network.setColormap).not.toHaveBeenCalledWith(customMap);
    expect(network.setBorders).toHaveBeenCalledWith(null);
  });

  it('exposes immutable unavailable projections before live and resets them on disconnect', async () => {
    const h = harness();
    const unavailable = h.element.projections;
    expect(unavailable).toEqual({ flat: false, tilt: false, globe: false });
    expect(Object.isFrozen(unavailable)).toBe(true);
    expect(h.element.geographic).toBe(false);

    document.body.append(h.element);
    h.near(true);
    await h.element.ready;
    expect(h.element.projections).toEqual({ flat: true, tilt: true, globe: true });
    expect(h.element.geographic).toBe(true);

    h.element.remove();
    expect(h.element.projections).toEqual({ flat: false, tilt: false, globe: false });
    expect(Object.isFrozen(h.element.projections)).toBe(true);
    expect(h.element.geographic).toBe(false);
  });
});

interface Harness extends ReturnType<typeof dependencies> {
  readonly element: NetworkElement;
  near(value: boolean): void;
  notifyObserver(index: number, value: boolean): void;
}

function harness(resolve?: (input: InputRevision) => Promise<NetworkData>): Harness {
  const setup = dependencies(resolve);
  const tag = nextTag();
  customElements.define(tag, createNetworkElementClass(HTMLElement, setup.value));
  const element = document.createElement(tag) as NetworkElement;
  return {
    ...setup,
    element,
    near(value) {
      setup.near(value);
    },
    notifyObserver(index, value) {
      setup.notifyObserver(index, value);
    },
  };
}

function dependencies(resolve?: (input: InputRevision) => Promise<NetworkData>): {
  readonly value: ElementDependencies;
  readonly dependencies: ElementDependencies;
  readonly data: NetworkData['topology'];
  readonly inputs: InputRevision[];
  readonly networks: FakeNetwork[];
  readonly leases: Array<DeviceLease & { release: ReturnType<typeof vi.fn> }>;
  readonly observeCleanup: ReturnType<typeof vi.fn>;
  near(value: boolean): void;
  notifyObserver(index: number, value: boolean): void;
} {
  const decoded = networkData();
  const inputs: InputRevision[] = [];
  const networks: FakeNetwork[] = [];
  const leases: Array<DeviceLease & { release: ReturnType<typeof vi.fn> }> = [];
  const observers: Array<(near: boolean) => void> = [];
  const observeCleanup = vi.fn();

  const resolveDependency: ElementDependencies['resolveInput'] = async (input) => {
    inputs.push(input);
    if (resolve) return resolve(input);
    return input.source.kind === 'data' ? (input.source.value as NetworkData) : decoded;
  };
  const acquireDevice: ElementDependencies['acquireDevice'] = async () => {
    const release = vi.fn();
    const lease = {
      device: { destroy: vi.fn() } as unknown as GPUDevice,
      release,
    };
    leases.push(lease);
    return lease;
  };
  const createNetworkDependency: ElementDependencies['createNetwork'] = async () => {
    const network = fakeNetwork();
    networks.push(network);
    return network.value;
  };
  const observeNear: ElementDependencies['observeNear'] = (_host, update) => {
    observers.push(update);
    return observeCleanup;
  };
  const warn = vi.fn();
  const loadNaturalEarthBorders: ElementDependencies['loadNaturalEarthBorders'] = async () => ({
    vertices: new Uint8Array(24),
    indices: new Uint32Array([0, 1]),
  });
  const value: ElementDependencies = {
    resolveInput: vi.fn(resolveDependency),
    acquireDevice: vi.fn(acquireDevice),
    createNetwork: vi.fn(createNetworkDependency),
    loadNaturalEarthBorders: vi.fn(loadNaturalEarthBorders),
    observeNear: vi.fn(observeNear),
    warn,
  };

  return {
    value,
    dependencies: value,
    data: decoded.topology,
    inputs,
    networks,
    leases,
    observeCleanup,
    near(near) {
      observers.at(-1)?.(near);
    },
    notifyObserver(index, near) {
      observers[index]?.(near);
    },
  };
}

function nextTag(): string {
  return `test-latkit-network-${++tagId}`;
}

function stage(element: NetworkElement): HTMLElement {
  return element.shadowRoot!.querySelector<HTMLElement>('[part="stage"]')!;
}

function fallback(element: NetworkElement): HTMLSlotElement {
  return element.shadowRoot!.querySelector<HTMLSlotElement>('slot')!;
}

function canvas(element: NetworkElement): HTMLCanvasElement {
  return element.shadowRoot!.querySelector<HTMLCanvasElement>('canvas')!;
}

function caption(element: NetworkElement): HTMLOutputElement {
  return element.shadowRoot!.querySelector<HTMLOutputElement>('[part="caption"]')!;
}

function validBorders(): Borders {
  return {
    vertices: new Uint8Array(24),
    indices: new Uint32Array([0, 1]),
  };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Border participation aborted', 'AbortError'),
      );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
