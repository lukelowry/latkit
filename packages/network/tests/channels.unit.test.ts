import { describe, expect, it, vi } from 'vitest';
import { createChannels, packBound, type Channel } from '../src/channels.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeSegments } from '../src/segments/index.js';
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
    const channels = createChannels(uniforms, renderer, {
      loaded: () => loaded,
      vertexCount: () => 3,
      edgeCount: () => 2,
    });
    return { uniforms, renderer, channels };
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
    expect(channels.dataRange('vertexHeight')).toEqual([2, 10]);
    expect(channels.outputRange('vertexHeight')).toEqual([0, 1]);

    channels.setRange('vertexHeight', [4, 6]);
    expect(uniforms.channel.heightCenter).toBe(4);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 2);

    channels.setRange('vertexHeight', null);
    expect(uniforms.channel.heightCenter).toBe(2);
    expect(uniforms.channel.heightScale).toBeCloseTo(1 / 8);

    channels.setRange('vertexHeight', [2, 10]);
    expect(renderer.writeChannel).toHaveBeenCalledTimes(1);
    channels.setRange('edgeColor', null);
    expect(uniforms.channel.eColorScale).toBe(0);
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

  it('falls back to a neutral height domain when no finite values are present', () => {
    const { channels, uniforms } = make();

    channels.set('vertexHeight', new Float32Array([Number.NaN, Infinity, -Infinity]), null);

    expect(channels.dataRange('vertexHeight')).toEqual([0, 1]);
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
    expect(channels.dataRange('vertexSize')).toBeNull();
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
    expect(channels.dataRange('vertexHeight')).toBeNull();
  });

  it('keeps dash range-free and controls dash period as the off mode', () => {
    const { channels, uniforms } = make();

    channels.set('edgeDash', new Float32Array([1, 0]), [100, 200]);
    expect(uniforms.geometry.dashPeriod).toBeGreaterThan(0);
    expect(channels.dataRange('edgeDash')).toBeNull();

    channels.clear('edgeDash');
    expect(uniforms.geometry.dashPeriod).toBe(0);
  });

  it('retains bound values for the picker and drops them on clear', () => {
    const { channels } = make();

    // The CPU picker reads raw values through values(); the retained array
    // must be exactly what was bound, for every pick-affecting channel.
    const heights = new Float32Array([1, 2, 3]);
    channels.set('vertexHeight', heights, null, [0, 3]);
    expect(channels.values('vertexHeight')).toBe(heights);

    const dashes = new Float32Array([1, 0]);
    channels.set('edgeDash', dashes);
    expect(channels.values('edgeDash')).toBe(dashes);

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
    (renderer as any).gpu = {
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
    (renderer as any).gpu = { device: { queue: { writeBuffer } } };
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
    (renderer as any).gpu = {
      device: { limits: { maxStorageBufferBindingSize: 1 } },
    };

    const topology = singleEdgeTopology();
    expect(() => renderer.bindTopology(encodeTopology(topology), encodeSegments(topology))).toThrow(
      'exceeds WebGPU storage buffer binding limit',
    );
    expect(previousTopologyBuffer.destroy).not.toHaveBeenCalled();
    expect(previousSegmentBuffer.destroy).not.toHaveBeenCalled();
    expect(previousChannelBuffer.destroy).not.toHaveBeenCalled();
    expect((renderer as any).bound).toBe(true);
  });
});
