import { describe, expect, it, vi } from 'vitest';
import { createChannels, packBound, type Channel } from '../src/channels.js';
import type { ChannelRange } from '../src/range.js';
import { createUniforms, ITEM_EDGE_VISIBLE, ITEM_VERTEX_VISIBLE } from '../src/webgpu/uniforms.js';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeSegments } from '../src/segments/index.js';
import { prepareScene } from '../src/scene.js';
import { encodeTopology } from '../src/topology/index.js';
import { singleEdgeTopology } from './fixtures/topology.js';

describe('packBound', () => {
  it('packs bound channels in registry order with vertex and edge slot sizes', () => {
    const bound = new Set<Channel>(['edgeDash', 'vertexSize', 'vertexColor']);

    const { slot, words } = packBound(bound, 3, 2);

    expect(words).toBe(8);
    expect(slot.get('vertexColor')).toEqual({ offset: 0, count: 3 });
    expect(slot.get('vertexSize')).toEqual({ offset: 3, count: 3 });
    expect(slot.get('edgeDash')).toEqual({ offset: 6, count: 2 });
    expect(slot.has('vertexHeight')).toBe(false);
  });
});

describe('createChannels', () => {
  function make(loaded = true) {
    const uniforms = createUniforms();
    const renderer = {
      relayout: vi.fn(
        (bound: ReadonlySet<Channel>, vertexCount: number, edgeCount: number) =>
          packBound(bound, vertexCount, edgeCount).slot,
      ),
      writeChannel: vi.fn(),
    };
    const display = { dashPeriodPx: 18 };
    const channels = createChannels(uniforms, renderer, {
      loaded: () => loaded,
      vertexCount: () => 3,
      edgeCount: () => 2,
      dashPeriodPx: () => display.dashPeriodPx,
    });
    return { uniforms, renderer, channels, display };
  }

  it('validates channel lengths without scanning values', () => {
    const { channels } = make();

    expect(() => channels.set('vertexColor', new Float32Array(2), [0, 1])).toThrow(
      'network channel vertexColor length 2 != 3',
    );
    expect(() => channels.set('edgeColor', new Float32Array(3), [0, 1])).toThrow(
      'network channel edgeColor length 3 != 2',
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

    channels.set('vertexHeight', new Float32Array([2, 6, 10]), [2, 10], [0, 1]);
    expect(uniforms.channel.vHeightMode).toBe(1);
    expect(uniforms.channel.heightCenter).toBe(2);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 8);
    expect(uniforms.channel.heightOutMin).toBe(0);
    expect(uniforms.channel.heightOutScale).toBe(1);

    channels.setRange('vertexHeight', [4, 6]);
    expect(uniforms.channel.heightCenter).toBe(4);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 2);

    channels.setRange('vertexHeight', null);
    expect(uniforms.channel.heightCenter).toBe(2);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 8);

    channels.setRange('vertexHeight', [2, 10]);
    expect(renderer.writeChannel).not.toHaveBeenCalled();
    channels.setRange('edgeColor', null);
    expect(uniforms.channel.eColorScale).toBe(0);
  });

  it('owns caller-supplied domains, output ranges, and later domain overrides', () => {
    const { channels, uniforms } = make();
    const domain: [number, number] = [1, 3];
    const output: [number, number] = [0, 2];

    channels.set('vertexHeight', new Float32Array([1, 2, 3]), domain, output);
    domain[0] = 100;
    output[1] = 100;

    expect(uniforms.channel.heightCenter).toBe(1);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 2);
    expect(uniforms.channel.heightOutMin).toBe(0);
    expect(uniforms.channel.heightOutScale).toBe(2);

    const override: [number, number] = [2, 4];
    channels.setRange('vertexHeight', override);
    override[0] = 20;
    override[1] = 40;
    channels.set('vertexHeight', new Float32Array([3, 4, 5]), [3, 5], [0, 2]);

    expect(uniforms.channel.heightCenter).toBe(2);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 2);
  });

  it('rejects invalid replacement ranges before mutating CPU, GPU, or uniform state', () => {
    const { channels, uniforms, renderer } = make();
    const original = new Float32Array([1, 2, 3]);
    channels.set('vertexHeight', original, [1, 3], [0, 2]);
    const retained = channels.values('vertexHeight');
    expect(retained).not.toBe(original);
    expect(retained).toEqual(original);

    const invalid: ReadonlyArray<
      readonly [label: string, domain: unknown, output: unknown, ErrorType: typeof Error]
    > = [
      ['short domain', [1], [0, 2], TypeError],
      ['nonnumeric domain', [1, '3'], [0, 2], TypeError],
      ['nonfinite domain', [1, Infinity], [0, 2], RangeError],
      ['reversed domain', [3, 1], [0, 2], RangeError],
      ['short output', [1, 3], [0], TypeError],
      ['nonfinite output', [1, 3], [0, Number.NaN], RangeError],
      ['reversed output', [1, 3], [2, 0], RangeError],
    ];

    for (const [label, domain, output, ErrorType] of invalid) {
      renderer.relayout.mockClear();
      renderer.writeChannel.mockClear();
      const uniformState = new Uint8Array(uniforms.raw).slice();
      const replacement = new Float32Array([4, 5, 6]);

      expect(
        () =>
          channels.set('vertexHeight', replacement, domain as ChannelRange, output as ChannelRange),
        label,
      ).toThrow(ErrorType);
      expect(channels.values('vertexHeight'), label).toBe(retained);
      expect(new Uint8Array(uniforms.raw), label).toEqual(uniformState);
      expect(renderer.relayout, label).not.toHaveBeenCalled();
      expect(renderer.writeChannel, label).not.toHaveBeenCalled();
    }
  });

  it('validates domain overrides atomically while edgeDash remains range-free', () => {
    const { channels, uniforms, renderer } = make();
    channels.set('vertexColor', new Float32Array([0, 0.5, 1]), [0, 1]);
    renderer.relayout.mockClear();
    renderer.writeChannel.mockClear();

    const invalid: ReadonlyArray<readonly [unknown, typeof Error]> = [
      [[0], TypeError],
      [[0, '1'], TypeError],
      [[0, Number.NaN], RangeError],
      [[1, 0], RangeError],
    ];
    for (const [range, ErrorType] of invalid) {
      const uniformState = new Uint8Array(uniforms.raw).slice();
      expect(() => channels.setRange('vertexColor', range as ChannelRange)).toThrow(ErrorType);
      expect(new Uint8Array(uniforms.raw)).toEqual(uniformState);
    }
    expect(renderer.relayout).not.toHaveBeenCalled();
    expect(renderer.writeChannel).not.toHaveBeenCalled();

    expect(() =>
      channels.setRange('edgeDash', [Number.NaN, -Infinity] as ChannelRange),
    ).not.toThrow();
  });

  it('updates existing channel values without reallocating storage', () => {
    const { channels, renderer, uniforms } = make();

    channels.set('vertexColor', new Float32Array([0, 0.5, 1]));
    renderer.relayout.mockClear();
    renderer.writeChannel.mockClear();
    channels.set('vertexColor', new Float32Array([1, 0.5, 0]));

    expect(renderer.relayout).not.toHaveBeenCalled();
    expect(renderer.writeChannel).toHaveBeenCalledOnce();
    expect(uniforms.channel.vColorMin).toBe(0);
    expect(uniforms.channel.vColorScale).toBe(1);
  });

  it('leaves CPU and uniform state unchanged when renderer mutations fail', () => {
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

    const beforeClear = new Uint8Array(uniforms.raw).slice();
    renderer.relayout.mockImplementationOnce(() => {
      throw new Error('relayout failed');
    });
    expect(() => channels.clear('vertexColor')).toThrow('relayout failed');
    expect(channels.values('vertexColor')).toBe(retained);
    expect(new Uint8Array(uniforms.raw)).toEqual(beforeClear);
  });

  it('falls back to a neutral height domain when no finite values are present', () => {
    const { channels, uniforms } = make();

    channels.set('vertexHeight', new Float32Array([Number.NaN, Infinity, -Infinity]), null);

    expect(uniforms.channel.heightCenter).toBe(0);
    expect(uniforms.channel.heightScale).toBe(1);
  });

  it('clears a channel idempotently to neutral uniforms and forgets range state', () => {
    const { channels, uniforms } = make();

    channels.set('vertexSize', new Float32Array([Number.NaN, 2, 3]), [1, 3]);
    channels.setRange('vertexSize', [1.5, 2.5]);

    channels.clear('vertexSize');
    expect(uniforms.channel.vSizeMode).toBe(0);
    expect(uniforms.channel.vSizeMin).toBe(0);
    expect(uniforms.channel.vSizeScale).toBe(0);

    channels.clear('vertexSize');
    expect(channels.values('vertexSize')).toBeNull();
  });

  it('resets all channels to neutral uniforms', () => {
    const { channels, uniforms } = make();

    channels.set('vertexHeight', new Float32Array([1, 2, 3]), null, [1, 3]);
    channels.set('edgeColor', new Float32Array([4, 5]), [4, 5]);

    channels.reset();

    expect(uniforms.channel.vHeightMode).toBe(0);
    expect(uniforms.channel.heightScale).toBe(0);
    expect(uniforms.channel.heightOutScale).toBe(0);
    expect(uniforms.channel.eColorMode).toBe(0);
    expect(channels.values('vertexHeight')).toBeNull();
  });

  it('keeps dash range-free and controls dash period as the off mode', () => {
    const { channels, uniforms } = make();

    channels.set('edgeDash', new Float32Array([1, 0]), [100, 200]);
    expect(uniforms.geometry.dashPeriod).toBe(18);

    channels.clear('edgeDash');
    expect(uniforms.geometry.dashPeriod).toBe(0);
  });

  it('refreshes the dash period only while edgeDash is bound', () => {
    const { channels, uniforms, display } = make();

    display.dashPeriodPx = 6;
    channels.refreshDashPeriod();
    expect(uniforms.geometry.dashPeriod).toBe(0);

    channels.set('edgeDash', new Float32Array([1, 0]), [100, 200]);
    expect(uniforms.geometry.dashPeriod).toBe(6);

    display.dashPeriodPx = 9;
    channels.refreshDashPeriod();
    expect(uniforms.geometry.dashPeriod).toBe(9);
  });

  it('treats visibility as a raw range-free channel and toggles packed flags', () => {
    const { channels, uniforms } = make();

    channels.set('vertexVisible', new Float32Array([1, 0, Number.NaN]), [10, -10]);
    expect(uniforms.channel.itemFlags & ITEM_VERTEX_VISIBLE).toBe(ITEM_VERTEX_VISIBLE);
    expect(uniforms.channel.vVisibleOffset).toBe(0);
    expect(() =>
      channels.setRange('vertexVisible', [Number.NaN, -Infinity] as ChannelRange),
    ).not.toThrow();

    channels.set('edgeVisible', new Float32Array([0, 1]));
    expect(uniforms.channel.itemFlags & ITEM_EDGE_VISIBLE).toBe(ITEM_EDGE_VISIBLE);
    expect(uniforms.channel.eVisibleOffset).toBe(3);

    channels.clear('vertexVisible');
    expect(uniforms.channel.itemFlags & ITEM_VERTEX_VISIBLE).toBe(0);
    expect(uniforms.channel.itemFlags & ITEM_EDGE_VISIBLE).toBe(ITEM_EDGE_VISIBLE);

    channels.reset();
    expect(uniforms.channel.itemFlags).toBe(0);
  });

  it('owns bound value snapshots for the renderer and picker and drops them on clear', () => {
    const { channels } = make();

    const heights = new Float32Array([1, 2, 3]);
    channels.set('vertexHeight', heights, null, [0, 3]);
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

    channels.reset();
    expect(channels.values('edgeDash')).toBeNull();
  });
});

describe('Renderer channel relayout guard', () => {
  it('throws when compact channel storage exceeds WebGPU limits', () => {
    const renderer = Object.create(Renderer.prototype) as Renderer;
    (renderer as any).bound = true;
    (renderer as any).presentation = {
      device: { limits: { maxStorageBufferBindingSize: 7, maxBufferSize: 1024 } },
    };

    expect(() => renderer.relayout(new Set<Channel>(['vertexColor']), 2, 0)).toThrow(
      'network channel storage 8 exceeds WebGPU limits',
    );
  });

  it('uploads channel values using byte offsets and byte lengths', () => {
    const writeBuffer = vi.fn();
    const renderer = Object.create(Renderer.prototype) as Renderer;
    const channelBuf = {};
    (renderer as any).presentation = { device: { queue: { writeBuffer } } };
    (renderer as any).channelBuf = channelBuf;
    (renderer as any).slots = new Map<Channel, { offset: number; count: number }>([
      ['vertexColor', { offset: 2, count: 3 }],
    ]);
    const source = new Float32Array([0, 1, 2, 3, 4]);
    const values = source.subarray(1, 4);

    renderer.writeChannel('vertexColor', values);

    expect(writeBuffer).toHaveBeenCalledWith(
      channelBuf,
      8,
      source.buffer,
      values.byteOffset,
      values.byteLength,
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
