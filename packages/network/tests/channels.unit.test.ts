import { describe, expect, it, vi } from 'vitest';
import { createSeries, type Domain } from '@latkit/model';
import { channelLayout, createChannels } from '../src/channels.js';
import { createUniforms, ITEM_EDGE_VISIBLE, ITEM_VERTEX_VISIBLE } from '../src/webgpu/uniforms.js';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeSegments } from '../src/segments/index.js';
import { prepareScene } from '../src/scene.js';
import { encodeTopology } from '../src/topology/index.js';
import { singleEdgeTopology } from './fixtures/topology.js';

describe('channelLayout', () => {
  it('gives every channel a slot in registry order, sized by its scope and components', () => {
    const { offsets, words } = channelLayout(3, 2);

    expect(words).toBe(5 * 3 + 4 * 2 + 2 * 3);
    expect(offsets).toEqual({
      vertexColor: 0,
      vertexHeight: 3,
      vertexSize: 6,
      edgeColor: 9,
      edgeDash: 11,
      vertexVisible: 13,
      edgeVisible: 16,
      vertexShade: 18,
      edgeShade: 21,
      vertexPosition: 23,
    });
    expect(channelLayout(0, 0).words).toBe(0);
  });
});

describe('createChannels', () => {
  const layout = new Float32Array([0, 0, 10, 0, 20, 10]);

  function make(loaded = true, attached = true) {
    const uniforms = createUniforms();
    const renderer = { writeChannel: vi.fn() };
    const display = {
      dashPeriodPx: 18,
      heightRange: [0, 1] as Domain,
      sizeRange: [0.5, 2] as Domain,
    };
    let bound = attached;
    const channels = createChannels(uniforms, {
      loaded: () => loaded,
      vertexCount: () => 3,
      edgeCount: () => 2,
      dashPeriodPx: () => display.dashPeriodPx,
      heightRange: () => display.heightRange,
      sizeRange: () => display.sizeRange,
      renderer: () => (bound ? renderer : null),
    });
    channels.reset(loaded ? layout : null);
    renderer.writeChannel.mockClear();
    return { uniforms, renderer, channels, display, bind: (next: boolean) => (bound = next) };
  }

  it('writes the static slot offsets for the loaded topology on reset', () => {
    const { uniforms } = make();

    expect(uniforms.channel.vColorOffset).toBe(0);
    expect(uniforms.channel.vHeightOffset).toBe(3);
    expect(uniforms.channel.vSizeOffset).toBe(6);
    expect(uniforms.channel.eColorOffset).toBe(9);
    expect(uniforms.channel.eDashOffset).toBe(11);
    expect(uniforms.channel.vVisibleOffset).toBe(13);
    expect(uniforms.channel.eVisibleOffset).toBe(16);
    expect(uniforms.channel.vPositionOffset).toBe(23);

    const { uniforms: unloaded } = make(false);
    expect(unloaded.channel.eVisibleOffset).toBe(0);
    expect(unloaded.channel.vPositionOffset).toBe(0);
  });

  it('seeds the position channel from the topology layout on reset and keeps it bound', () => {
    const uniforms = createUniforms();
    const renderer = { writeChannel: vi.fn() };
    const channels = createChannels(uniforms, {
      loaded: () => true,
      vertexCount: () => 3,
      edgeCount: () => 2,
      dashPeriodPx: () => 12,
      heightRange: () => [0, 1],
      sizeRange: () => [0.5, 2],
      renderer: () => renderer,
    });

    channels.reset(layout);
    expect(renderer.writeChannel).toHaveBeenCalledExactlyOnceWith('vertexPosition', layout);
    const seeded = channels.values('vertexPosition');
    expect(seeded).toEqual(layout);
    expect(seeded).not.toBe(layout);
    expect(channels.domain('vertexPosition')).toBeNull();

    // A rebind moves vertices in place: the same snapshot, new contents, one upload.
    const moved = new Float32Array([1, 1, 11, 1, 21, 11]);
    channels.set('vertexPosition', moved, [0, 1]);
    expect(channels.values('vertexPosition')).toBe(seeded);
    expect(seeded).toEqual(moved);

    channels.reset(null);
    expect(channels.values('vertexPosition')).toBeNull();
  });

  it('validates channel lengths without scanning values', () => {
    const { channels } = make();

    expect(() => channels.set('vertexColor', new Float32Array(2), [0, 1])).toThrow(
      'network channel vertexColor length 2 != 3',
    );
    expect(() => channels.set('edgeColor', new Float32Array(3), [0, 1])).toThrow(
      'network channel edgeColor length 3 != 2',
    );
    expect(() => channels.set('vertexPosition', new Float32Array(3))).toThrow(
      'network channel vertexPosition length 3 != 6',
    );
  });

  it('reports a clear error when a channel is bound before topology is loaded', () => {
    const { channels } = make(false);

    expect(() => channels.set('vertexColor', new Float32Array(3), [0, 1])).toThrow(
      'network topology must be loaded before binding channels',
    );
  });

  it('stores height domain/output ranges, applies domain overrides, and reverts to data domain', () => {
    const { channels, uniforms, renderer } = make();

    channels.set('vertexHeight', new Float32Array([2, 6, 10]), [2, 10]);
    expect(uniforms.channel.vHeightMode).toBe(1);
    expect(uniforms.channel.vHeightMin).toBe(2);
    expect(uniforms.channel.vHeightScale).toBeCloseTo(1 / 8);
    expect(uniforms.channel.vHeightOutMin).toBe(0);
    expect(uniforms.channel.vHeightOutSpan).toBe(1);

    channels.setDomain('vertexHeight', [4, 6]);
    expect(uniforms.channel.vHeightMin).toBe(4);
    expect(uniforms.channel.vHeightScale).toBeCloseTo(1 / 2);

    channels.setDomain('vertexHeight', null);
    expect(uniforms.channel.vHeightMin).toBe(2);
    expect(uniforms.channel.vHeightScale).toBeCloseTo(1 / 8);

    renderer.writeChannel.mockClear();
    channels.setDomain('vertexHeight', [2, 10]);
    expect(renderer.writeChannel).not.toHaveBeenCalled();
    channels.setDomain('edgeColor', null);
    expect(uniforms.channel.eColorScale).toBe(0);
  });

  it('owns caller-supplied domains, reads the display height range, and owns later overrides', () => {
    const { channels, uniforms, display } = make();
    const domain: [number, number] = [1, 3];
    display.heightRange = [0, 2];

    channels.set('vertexHeight', new Float32Array([1, 2, 3]), domain);
    domain[0] = 100;

    expect(uniforms.channel.vHeightMin).toBe(1);
    expect(uniforms.channel.vHeightScale).toBeCloseTo(1 / 2);
    expect(uniforms.channel.vHeightOutMin).toBe(0);
    expect(uniforms.channel.vHeightOutSpan).toBe(2);

    const override: [number, number] = [2, 4];
    channels.setDomain('vertexHeight', override);
    override[0] = 20;
    override[1] = 40;
    channels.set('vertexHeight', new Float32Array([3, 4, 5]), [3, 5]);

    expect(uniforms.channel.vHeightMin).toBe(2);
    expect(uniforms.channel.vHeightScale).toBeCloseTo(1 / 2);
  });

  it('rejects invalid replacement domains before mutating CPU, GPU, or uniform state', () => {
    const { channels, uniforms, renderer } = make();
    const original = new Float32Array([1, 2, 3]);
    channels.set('vertexHeight', original, [1, 3]);
    const retained = channels.values('vertexHeight');
    expect(retained).not.toBe(original);
    expect(retained).toEqual(original);

    const invalid: ReadonlyArray<
      readonly [label: string, domain: unknown, ErrorType: typeof Error]
    > = [
      ['short domain', [1], TypeError],
      ['nonnumeric domain', [1, '3'], TypeError],
      ['nonfinite domain', [1, Infinity], RangeError],
      ['reversed domain', [3, 1], RangeError],
    ];

    for (const [label, domain, ErrorType] of invalid) {
      renderer.writeChannel.mockClear();
      const uniformState = new Uint8Array(uniforms.raw).slice();
      const replacement = new Float32Array([4, 5, 6]);

      expect(() => channels.set('vertexHeight', replacement, domain as Domain), label).toThrow(
        ErrorType,
      );
      expect(channels.values('vertexHeight'), label).toBe(retained);
      expect(new Uint8Array(uniforms.raw), label).toEqual(uniformState);
      expect(renderer.writeChannel, label).not.toHaveBeenCalled();
    }
  });

  it('validates domain overrides atomically while edgeDash remains range-free', () => {
    const { channels, uniforms, renderer } = make();
    channels.set('vertexColor', new Float32Array([0, 0.5, 1]), [0, 1]);
    renderer.writeChannel.mockClear();

    const invalid: ReadonlyArray<readonly [unknown, typeof Error]> = [
      [[0], TypeError],
      [[0, '1'], TypeError],
      [[0, Number.NaN], RangeError],
      [[1, 0], RangeError],
    ];
    for (const [range, ErrorType] of invalid) {
      const uniformState = new Uint8Array(uniforms.raw).slice();
      expect(() => channels.setDomain('vertexColor', range as Domain)).toThrow(ErrorType);
      expect(new Uint8Array(uniforms.raw)).toEqual(uniformState);
    }
    expect(renderer.writeChannel).not.toHaveBeenCalled();

    expect(() => channels.setDomain('edgeDash', [Number.NaN, -Infinity] as Domain)).not.toThrow();
  });

  it('uploads every bind into the channel slot and refreshes the snapshot in place', () => {
    const { channels, renderer, uniforms } = make();

    const first = new Float32Array([0, 0.5, 1]);
    channels.set('vertexColor', first);
    expect(renderer.writeChannel).toHaveBeenCalledExactlyOnceWith('vertexColor', first);
    const snapshot = channels.values('vertexColor');
    renderer.writeChannel.mockClear();
    const replacement = new Float32Array([1, 0.5, 0]);
    channels.set('vertexColor', replacement);

    expect(renderer.writeChannel).toHaveBeenCalledExactlyOnceWith('vertexColor', replacement);
    // The CPU snapshot is refreshed in place rather than reallocated per update.
    expect(channels.values('vertexColor')).toBe(snapshot);
    expect(channels.values('vertexColor')).toEqual(replacement);
    expect(channels.values('vertexColor')).not.toBe(replacement);
    expect(uniforms.channel.vColorMin).toBe(0);
    expect(uniforms.channel.vColorScale).toBe(1);
  });

  it('stores float64 values as float32 and rejects other arrays', () => {
    const { channels, renderer } = make();
    channels.set('vertexColor', Float64Array.of(0, 0.5, 1));
    const uploaded = renderer.writeChannel.mock.calls[0]![1] as Float32Array;
    expect(uploaded).toBeInstanceOf(Float32Array);
    expect(uploaded).toEqual(Float32Array.of(0, 0.5, 1));
    expect(channels.values('vertexColor')).toEqual(Float32Array.of(0, 0.5, 1));
    expect(() => channels.set('vertexColor', Int32Array.of(0, 1, 2) as never)).toThrow(TypeError);
    expect(() => channels.set('vertexColor', [0, 1, 2] as never)).toThrow(TypeError);
  });

  it('leaves CPU and uniform state unchanged when the upload fails', () => {
    const { channels, renderer, uniforms } = make();
    const original = new Float32Array([0, 0.5, 1]);
    channels.set('vertexColor', original, [0, 1]);
    const retained = channels.values('vertexColor');

    const beforeReplacement = new Uint8Array(uniforms.raw).slice();
    renderer.writeChannel.mockImplementationOnce(() => {
      throw new Error('upload failed');
    });
    expect(() => channels.set('vertexColor', new Float32Array([1, 0.5, 0]), [10, 20])).toThrow(
      'upload failed',
    );
    expect(channels.values('vertexColor')).toBe(retained);
    expect(new Uint8Array(uniforms.raw)).toEqual(beforeReplacement);
  });

  it('keeps snapshots while detached and uploads them all into the next renderer', () => {
    const { channels, renderer, bind } = make(true, false);

    channels.set('vertexHeight', new Float32Array([1, 2, 3]), null);
    channels.set('edgeDash', new Float32Array([1, 0]));
    expect(renderer.writeChannel).not.toHaveBeenCalled();
    expect(channels.values('vertexHeight')).toEqual(new Float32Array([1, 2, 3]));

    bind(true);
    const next = { writeChannel: vi.fn() };
    channels.upload(next);
    expect(next.writeChannel.mock.calls).toEqual([
      ['vertexPosition', channels.values('vertexPosition')],
      ['vertexHeight', channels.values('vertexHeight')],
      ['edgeDash', channels.values('edgeDash')],
    ]);

    channels.set('edgeDash', new Float32Array([0, 1]));
    expect(renderer.writeChannel).toHaveBeenCalledOnce();
  });

  it('falls back to a neutral height domain when no finite values are present', () => {
    const { channels, uniforms } = make();

    channels.set('vertexHeight', new Float32Array([Number.NaN, Infinity, -Infinity]), null);

    expect(uniforms.channel.vHeightMin).toBe(0);
    expect(uniforms.channel.vHeightScale).toBe(1);
  });

  it('clears a channel idempotently to neutral uniforms and forgets range state', () => {
    const { channels, uniforms, renderer } = make();

    channels.set('vertexSize', new Float32Array([Number.NaN, 2, 3]), [1, 3]);
    channels.setDomain('vertexSize', [1.5, 2.5]);
    renderer.writeChannel.mockClear();

    channels.clear('vertexSize');
    expect(uniforms.channel.vSizeMode).toBe(0);
    expect(uniforms.channel.vSizeMin).toBe(0);
    expect(uniforms.channel.vSizeScale).toBe(0);
    expect(renderer.writeChannel).not.toHaveBeenCalled();

    channels.clear('vertexSize');
    expect(channels.values('vertexSize')).toBeNull();
  });

  it('resets all channels to neutral uniforms', () => {
    const { channels, uniforms } = make();

    channels.set('vertexHeight', new Float32Array([1, 2, 3]), null);
    channels.set('edgeColor', new Float32Array([4, 5]), [4, 5]);

    channels.reset(null);

    expect(uniforms.channel.vHeightMode).toBe(0);
    expect(uniforms.channel.vHeightScale).toBe(0);
    expect(uniforms.channel.vHeightOutSpan).toBe(0);
    expect(uniforms.channel.eColorMode).toBe(0);
    expect(channels.values('vertexHeight')).toBeNull();
  });

  it('keeps dash range-free and controls dash period as the off mode', () => {
    const { channels, uniforms } = make();

    channels.set('edgeDash', new Float32Array([1, 0]), [100, 200]);
    expect(uniforms.geometry.eDashPeriodPx).toBe(18);

    channels.clear('edgeDash');
    expect(uniforms.geometry.eDashPeriodPx).toBe(0);
  });

  it('refreshes the dash period only while edgeDash is bound', () => {
    const { channels, uniforms, display } = make();

    display.dashPeriodPx = 6;
    channels.refreshDashPeriod();
    expect(uniforms.geometry.eDashPeriodPx).toBe(0);

    channels.set('edgeDash', new Float32Array([1, 0]), [100, 200]);
    expect(uniforms.geometry.eDashPeriodPx).toBe(6);

    display.dashPeriodPx = 9;
    channels.refreshDashPeriod();
    expect(uniforms.geometry.eDashPeriodPx).toBe(9);
  });

  it('reports the effective domain of bound normalized channels and refreshes the height range', () => {
    const { channels, uniforms, display } = make();

    expect(channels.domain('vertexColor')).toBeNull();
    channels.set('vertexColor', new Float32Array([0, 0.5, 1]), [2, 4]);
    expect(channels.domain('vertexColor')).toEqual([2, 4]);
    channels.setDomain('vertexColor', [3, 5]);
    expect(channels.domain('vertexColor')).toEqual([3, 5]);
    channels.set('edgeDash', new Float32Array([1, 0]));
    expect(channels.domain('edgeDash')).toBeNull();

    display.heightRange = [1, 3];
    channels.refreshHeightRange();
    expect(uniforms.channel.vHeightOutSpan).toBe(0);
    channels.set('vertexHeight', new Float32Array([1, 2, 3]));
    expect(uniforms.channel.vHeightOutMin).toBe(1);
    expect(uniforms.channel.vHeightOutSpan).toBe(2);
    display.heightRange = [0, 4];
    channels.refreshHeightRange();
    expect(uniforms.channel.vHeightOutSpan).toBe(4);
    expect(channels.domain('vertexHeight')).toEqual([1, 3]);
  });

  it('treats visibility as a raw range-free channel and toggles packed flags', () => {
    const { channels, uniforms } = make();

    channels.set('vertexVisible', new Float32Array([1, 0, Number.NaN]), [10, -10]);
    expect(uniforms.channel.itemFlags & ITEM_VERTEX_VISIBLE).toBe(ITEM_VERTEX_VISIBLE);
    expect(uniforms.channel.vVisibleOffset).toBe(13);
    expect(() =>
      channels.setDomain('vertexVisible', [Number.NaN, -Infinity] as Domain),
    ).not.toThrow();

    channels.set('edgeVisible', new Float32Array([0, 1]));
    expect(uniforms.channel.itemFlags & ITEM_EDGE_VISIBLE).toBe(ITEM_EDGE_VISIBLE);
    expect(uniforms.channel.eVisibleOffset).toBe(16);

    channels.clear('vertexVisible');
    expect(uniforms.channel.itemFlags & ITEM_VERTEX_VISIBLE).toBe(0);
    expect(uniforms.channel.itemFlags & ITEM_EDGE_VISIBLE).toBe(ITEM_EDGE_VISIBLE);

    channels.reset(null);
    expect(uniforms.channel.itemFlags).toBe(0);
  });

  it('owns bound value snapshots for the renderer and picker and drops them on clear', () => {
    const { channels } = make();

    const heights = new Float32Array([1, 2, 3]);
    channels.set('vertexHeight', heights, null);
    const retainedHeights = channels.values('vertexHeight');
    expect(retainedHeights).not.toBe(heights);
    expect(retainedHeights).toEqual(heights);
    heights[0] = 99;
    expect(retainedHeights?.[0]).toBe(1);

    const dashes = new Float32Array([1, 0]);
    channels.set('edgeDash', dashes);
    const retainedDashes = channels.values('edgeDash');
    expect(retainedDashes).not.toBe(dashes);
    expect(retainedDashes).toEqual(dashes);

    const replacement = new Float32Array([0, 1]);
    channels.set('edgeDash', replacement);
    const retainedReplacement = channels.values('edgeDash');
    replacement[0] = 1;
    expect(retainedReplacement).toEqual(new Float32Array([0, 1]));

    channels.clear('vertexHeight');
    expect(channels.values('vertexHeight')).toBeNull();

    channels.reset(null);
    expect(channels.values('edgeDash')).toBeNull();
  });
});

describe('series-bound channels', () => {
  function make() {
    const uniforms = createUniforms();
    const renderer = { writeChannel: vi.fn() };
    const channels = createChannels(uniforms, {
      loaded: () => true,
      vertexCount: () => 3,
      edgeCount: () => 2,
      dashPeriodPx: () => 12,
      heightRange: () => [0, 1],
      sizeRange: () => [0.5, 2],
      renderer: () => renderer,
    });
    channels.reset(new Float32Array(6));
    renderer.writeChannel.mockClear();
    return { uniforms, renderer, channels };
  }

  function series(elements: number, values: number[], sparse?: Uint32Array) {
    const time = Float64Array.from({ length: values.length / elements }, (_, i) => i);
    return createSeries({
      elementCount: elements,
      signalCount: 1,
      time,
      values: Float64Array.from(values),
      ...(sparse && { elements: sparse }),
    });
  }

  it('shows nothing until a frame is shown, following the recorded range', () => {
    const { uniforms, renderer, channels } = make();
    const recording = series(3, [2, 4, 6, 1, 9, 3]);

    channels.set('vertexColor', { series: recording, signal: 0 });

    expect(channels.values('vertexColor')).toEqual(new Float32Array(3).fill(NaN));
    expect(renderer.writeChannel).toHaveBeenCalledExactlyOnceWith(
      'vertexColor',
      new Float32Array(3).fill(NaN),
    );
    expect(uniforms.channel.vColorMode).toBe(1);
    expect(channels.domain('vertexColor')).toEqual([1, 9]);
    expect(channels.words).toBe(5 * 3 + 4 * 2 + 2 * 3);

    const frame = Float32Array.of(1, 9, 3);
    channels.moveTo('vertexColor', 100, frame);
    expect(uniforms.channel.vColorOffset).toBe(100);
    expect(channels.values('vertexColor')).toBe(frame);
  });

  it('refreshes a followed recorded range, and keeps an explicit domain', () => {
    const { channels } = make();
    const live = createSeries({ elementCount: 3, signalCount: 1 });
    channels.set('vertexColor', { series: live, signal: 0 });
    channels.set('vertexHeight', { series: live, signal: 0 }, [0, 100]);
    expect(channels.domain('vertexColor')).toEqual([0, 1]);

    live.append({
      elementCount: 3,
      signalCount: 1,
      time: Float64Array.of(0),
      values: Float64Array.of(-2, 5, 8),
    });
    expect(channels.refreshRecorded('vertexColor')).toBe(true);
    expect(channels.domain('vertexColor')).toEqual([-2, 8]);
    expect(channels.refreshRecorded('vertexHeight')).toBe(false);
    expect(channels.domain('vertexHeight')).toEqual([0, 100]);
  });

  it('holds the shown frame in the channel slot', () => {
    const { uniforms, renderer, channels } = make();
    channels.set('edgeColor', { series: series(2, [1, 2]), signal: 0 });
    const window = Float32Array.of(7, 8);
    channels.moveTo('edgeColor', 64, window);

    channels.hold('edgeColor');

    expect(uniforms.channel.eColorOffset).toBe(9);
    expect(renderer.writeChannel).toHaveBeenLastCalledWith('edgeColor', Float32Array.of(7, 8));
    const held = channels.values('edgeColor')!;
    expect(held).not.toBe(window);
    window[0] = 0;
    expect(held).toEqual(Float32Array.of(7, 8));
  });

  it('gives an array bound after a series its own snapshot, back in the channel slot', () => {
    const { uniforms, channels } = make();
    channels.set('vertexSize', { series: series(3, [1, 2, 3]), signal: 0 });
    const window = Float32Array.of(1, 2, 3);
    channels.moveTo('vertexSize', 64, window);

    channels.set('vertexSize', Float32Array.of(4, 5, 6));

    expect(uniforms.channel.vSizeOffset).toBe(6);
    expect(window).toEqual(Float32Array.of(1, 2, 3));
    expect(channels.values('vertexSize')).toEqual(Float32Array.of(4, 5, 6));
    expect(channels.domain('vertexSize')).toEqual([0, 1]);
  });

  it('accepts a sparse series inside the scope, and rejects what does not fit', () => {
    const { channels } = make();
    channels.set('edgeShade', { series: series(1, [5], Uint32Array.of(1)), signal: 0 });
    expect(channels.values('edgeShade')).toEqual(Float32Array.of(NaN, NaN));

    expect(() => channels.set('vertexColor', { series: series(2, [1, 2]), signal: 0 })).toThrow(
      'network channel vertexColor series elements do not fit 3 items',
    );
    expect(() =>
      channels.set('edgeColor', { series: series(1, [5], Uint32Array.of(2)), signal: 0 }),
    ).toThrow('do not fit 2 items');
    expect(() => channels.set('vertexColor', { series: series(3, [1, 2, 3]), signal: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      channels.set('vertexPosition', { series: series(3, [1, 2, 3]), signal: 0 }),
    ).toThrow(new TypeError('network channel vertexPosition cannot follow a series'));
    expect(() => channels.set('vertexColor', [1, 2, 3] as unknown as Float32Array)).toThrow(
      TypeError,
    );
  });

  it('clears a series-bound channel back to its own slot', () => {
    const { uniforms, channels } = make();
    channels.set('vertexColor', { series: series(3, [1, 2, 3]), signal: 0 });
    channels.moveTo('vertexColor', 64, Float32Array.of(1, 2, 3));

    expect(channels.clear('vertexColor')).toBe(true);
    expect(uniforms.channel.vColorOffset).toBe(0);
    expect(uniforms.channel.vColorMode).toBe(0);
    expect(channels.values('vertexColor')).toBeNull();
  });
});

describe('Renderer channel storage', () => {
  it('uploads channel values using the static slot offsets, byte offsets, and byte lengths', () => {
    const writeBuffer = vi.fn();
    const renderer = Object.create(Renderer.prototype) as Renderer;
    const channelBuf = {};
    (renderer as any).presentation = { device: { queue: { writeBuffer } } };
    (renderer as any).channelBuf = channelBuf;
    (renderer as any).channelOffsets = channelLayout(3, 2).offsets;
    const source = new Float32Array([0, 1, 2, 3, 4]);
    const values = source.subarray(1, 4);

    renderer.writeChannel('vertexSize', values);

    expect(writeBuffer).toHaveBeenCalledWith(
      channelBuf,
      6 * 4,
      source.buffer,
      values.byteOffset,
      values.byteLength,
    );
  });

  it('refuses a channel write before a topology binds', () => {
    const renderer = Object.create(Renderer.prototype) as Renderer;
    (renderer as any).channelOffsets = null;
    (renderer as any).channelBuf = null;

    expect(() => renderer.writeChannel('vertexColor', new Float32Array(3))).toThrow(
      'network channel vertexColor has no storage slot',
    );
  });

  it('preserves the previously bound topology when a new topology exceeds GPU limits', () => {
    const renderer = Object.create(Renderer.prototype) as Renderer;
    const previousTopologyBuffer = { destroy: vi.fn() };
    const previousSegmentBuffer = { destroy: vi.fn() };
    const previousChannelBuffer = { destroy: vi.fn() };
    (renderer as any).bound = true;
    (renderer as any).topologyBuffer = previousTopologyBuffer;
    (renderer as any).segmentBuffer = previousSegmentBuffer;
    (renderer as any).channelBuf = previousChannelBuffer;
    (renderer as any).presentation = {
      device: { limits: { maxStorageBufferBindingSize: 1 } },
    };

    const topology = singleEdgeTopology();
    const scene = prepareScene(encodeTopology(topology), encodeSegments(topology));
    expect(() => renderer.bindTopology(scene)).toThrow(
      'exceeds WebGPU storage buffer binding limit',
    );
    expect(previousTopologyBuffer.destroy).not.toHaveBeenCalled();
    expect(previousSegmentBuffer.destroy).not.toHaveBeenCalled();
    expect(previousChannelBuffer.destroy).not.toHaveBeenCalled();
    expect((renderer as any).bound).toBe(true);
  });
});
