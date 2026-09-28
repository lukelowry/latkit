import { describe, expect, it, vi } from 'vitest';
import { createChannels } from '@latkit/gpu';
import { createSeries, type Domain } from '@latkit/model';

import { CHANNELS, channelRecord, initialDomain, type Channel } from '../src/channels.js';
import { createUniforms, ITEM_EDGE_VISIBLE, ITEM_VERTEX_VISIBLE } from '../src/webgpu/uniforms.js';
import { Renderer } from '../src/webgpu/renderer.js';
import { encodeSegments } from '../src/segments/index.js';
import { prepareScene } from '../src/scene.js';
import { encodeTopology } from '../src/topology/index.js';
import { singleEdgeTopology } from './fixtures/topology.js';

/** 3 vertices, 2 edges. */
const COUNTS = { vertex: 3, edge: 2 };

/** The network's channels as the controller builds them, over a store that records its writes. */
function make(loaded = true) {
  const uniforms = createUniforms();
  const display = {
    dashPeriodPx: 18,
    heightRange: [0, 1] as Domain,
    sizeRange: [0.5, 2] as Domain,
  };
  const store = { reserve: vi.fn(), writeWords: vi.fn() };
  const channels = createChannels<Channel, 'vertex' | 'edge'>({
    name: 'network',
    structure: 'topology',
    channels: CHANNELS,
    store: () => store,
    record: channelRecord(uniforms, {
      dashPeriodPx: () => display.dashPeriodPx,
      heightRange: () => display.heightRange,
      sizeRange: () => display.sizeRange,
    }),
    shown: vi.fn(),
    error: vi.fn(),
    initialDomain,
  });
  channels.load(loaded ? COUNTS : null);
  return { uniforms, display, store, channels };
}

describe('CHANNELS', () => {
  it('names every channel in slot order, each scalar channel able to follow a series', () => {
    expect(Object.keys(CHANNELS)).toEqual([
      'vertexColor',
      'vertexHeight',
      'vertexSize',
      'edgeColor',
      'edgeDash',
      'vertexVisible',
      'edgeVisible',
      'vertexShade',
      'edgeShade',
      'vertexPosition',
    ]);
    expect(CHANNELS.vertexPosition).toEqual({
      scope: 'vertex',
      map: 'position',
      label: 'Vertex Position',
      normalized: false,
      components: 2,
      series: false,
    });
    for (const [key, definition] of Object.entries(CHANNELS))
      expect(definition.series, key).toBe(definition.components === 1);
    expect(Object.isFrozen(CHANNELS)).toBe(true);
    for (const definition of Object.values(CHANNELS))
      expect(Object.isFrozen(definition)).toBe(true);
  });
});

describe('network channel records', () => {
  it('writes every slot offset for the loaded topology', () => {
    const { uniforms, channels } = make();

    expect(channels.words).toBe(5 * 3 + 4 * 2 + 2 * 3);
    expect(uniforms.channel.vColorOffset).toBe(0);
    expect(uniforms.channel.vHeightOffset).toBe(3);
    expect(uniforms.channel.vSizeOffset).toBe(6);
    expect(uniforms.channel.eColorOffset).toBe(9);
    expect(uniforms.channel.eDashOffset).toBe(11);
    expect(uniforms.channel.vVisibleOffset).toBe(13);
    expect(uniforms.channel.eVisibleOffset).toBe(16);
    expect(uniforms.channel.vShadeOffset).toBe(18);
    expect(uniforms.channel.eShadeOffset).toBe(21);
    expect(uniforms.channel.vPositionOffset).toBe(23);

    const { uniforms: unloaded } = make(false);
    expect(unloaded.channel.eVisibleOffset).toBe(0);
    expect(unloaded.channel.vPositionOffset).toBe(0);
  });

  it('maps a colormap channel through its domain and turns its mode on and off', () => {
    const { uniforms, channels } = make();

    channels.set('vertexColor', Float32Array.of(0, 0.5, 1), [2, 4]);
    expect(uniforms.channel.vColorMode).toBe(1);
    expect(uniforms.channel.vColorMin).toBe(2);
    expect(uniforms.channel.vColorScale).toBe(0.5);

    channels.set('edgeColor', Float32Array.of(4, 5), [4, 5]);
    expect(uniforms.channel.eColorMode).toBe(1);
    expect(uniforms.channel.eColorMin).toBe(4);

    channels.set('vertexColor', null);
    expect(uniforms.channel.vColorMode).toBe(0);
    expect(uniforms.channel.vColorScale).toBe(0);
  });

  it('adds the display height range to a bound height, and zeros to an unbound one', () => {
    const { uniforms, channels, display } = make();

    channels.set('vertexHeight', Float32Array.of(2, 6, 10), [2, 10]);
    expect(uniforms.channel.vHeightMode).toBe(1);
    expect(uniforms.channel.vHeightMin).toBe(2);
    expect(uniforms.channel.vHeightScale).toBeCloseTo(1 / 8);
    expect(uniforms.channel.vHeightOutMin).toBe(0);
    expect(uniforms.channel.vHeightOutSpan).toBe(1);

    display.heightRange = [1, 3];
    channels.refresh('vertexHeight');
    expect(uniforms.channel.vHeightOutMin).toBe(1);
    expect(uniforms.channel.vHeightOutSpan).toBe(2);

    channels.set('vertexHeight', null);
    expect(uniforms.channel.vHeightMode).toBe(0);
    expect(uniforms.channel.vHeightOutSpan).toBe(0);
    channels.refresh('vertexHeight');
    expect(uniforms.channel.vHeightOutSpan).toBe(0);
  });

  it('starts a height at its own finite extent, and every other channel at [0, 1]', () => {
    const { uniforms, channels } = make();

    channels.set('vertexHeight', Float32Array.of(2, Number.NaN, 10));
    expect(channels.domain('vertexHeight')).toEqual([2, 10]);
    channels.set('vertexHeight', Float32Array.of(Number.NaN, Infinity, -Infinity));
    expect(uniforms.channel.vHeightMin).toBe(0);
    expect(uniforms.channel.vHeightScale).toBe(1);
    channels.set('vertexSize', Float32Array.of(5, 6, 7));
    expect(channels.domain('vertexSize')).toEqual([0, 1]);
    expect(initialDomain('edgeColor', Float32Array.of(4, 9))).toEqual([0, 1]);
  });

  it('keeps the size output range live even while the size channel is unbound', () => {
    const { uniforms, channels, display } = make();
    expect(uniforms.channel.vSizeOutMin).toBe(0.5);
    expect(uniforms.channel.vSizeOutSpan).toBe(1.5);

    display.sizeRange = [1, 4];
    channels.refresh('vertexSize');
    expect(uniforms.channel.vSizeMode).toBe(0);
    expect(uniforms.channel.vSizeScale).toBe(0);
    expect(uniforms.channel.vSizeOutMin).toBe(1);
    expect(uniforms.channel.vSizeOutSpan).toBe(3);
  });

  it('runs the dash period as the dash mode, refreshed only while bound', () => {
    const { uniforms, channels, display } = make();

    display.dashPeriodPx = 6;
    channels.refresh('edgeDash');
    expect(uniforms.geometry.eDashPeriodPx).toBe(0);

    channels.set('edgeDash', Float32Array.of(1, 0), [100, 200]);
    expect(uniforms.geometry.eDashPeriodPx).toBe(6);
    expect(channels.domain('edgeDash')).toBeNull();

    display.dashPeriodPx = 9;
    channels.refresh('edgeDash');
    expect(uniforms.geometry.eDashPeriodPx).toBe(9);

    channels.set('edgeDash', null);
    expect(uniforms.geometry.eDashPeriodPx).toBe(0);
  });

  it('toggles the packed visibility flags', () => {
    const { uniforms, channels } = make();

    channels.set('vertexVisible', Float32Array.of(1, 0, Number.NaN));
    expect(uniforms.channel.itemFlags & ITEM_VERTEX_VISIBLE).toBe(ITEM_VERTEX_VISIBLE);
    channels.set('edgeVisible', Float32Array.of(0, 1));
    expect(uniforms.channel.itemFlags & ITEM_EDGE_VISIBLE).toBe(ITEM_EDGE_VISIBLE);

    channels.set('vertexVisible', null);
    expect(uniforms.channel.itemFlags & ITEM_VERTEX_VISIBLE).toBe(0);
    expect(uniforms.channel.itemFlags & ITEM_EDGE_VISIBLE).toBe(ITEM_EDGE_VISIBLE);

    channels.load(null);
    expect(uniforms.channel.itemFlags).toBe(0);
  });

  it('writes positions into their slot and refuses a series for them', () => {
    const { store, channels } = make();
    const layout = Float32Array.of(0, 0, 10, 0, 20, 10);

    channels.set('vertexPosition', layout);
    expect(store.writeWords).toHaveBeenLastCalledWith(23, layout);
    expect(() =>
      channels.set('vertexPosition', {
        series: createSeries({ signals: ['x'], elementCount: 3 }),
        signal: 0,
      }),
    ).toThrow(new TypeError('network channel vertexPosition cannot follow a series'));
    expect(() => channels.set('vertexColor', new Float32Array(2))).toThrow(
      'network channel vertexColor length 2 != 3',
    );
    expect(() => make(false).channels.set('vertexColor', new Float32Array(3))).toThrow(
      'network topology must be loaded before binding channels',
    );
  });
});

describe('Renderer channel storage', () => {
  it('writes float words at word offsets, byte offsets, and byte lengths', () => {
    const writeBuffer = vi.fn();
    const renderer = Object.create(Renderer.prototype) as Renderer;
    const channelBuf = {};
    (renderer as any).presentation = { device: { queue: { writeBuffer } } };
    (renderer as any).channelBuf = channelBuf;
    const source = new Float32Array([0, 1, 2, 3, 4]);
    const values = source.subarray(1, 4);

    renderer.writeWords(6, values);

    expect(writeBuffer).toHaveBeenCalledWith(
      channelBuf,
      6 * 4,
      source.buffer,
      values.byteOffset,
      values.byteLength,
    );
  });

  it('refuses a write before a topology binds', () => {
    const renderer = Object.create(Renderer.prototype) as Renderer;
    (renderer as any).channelBuf = null;

    expect(() => renderer.writeWords(0, new Float32Array(3))).toThrow(
      'network channel storage is not bound',
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
    expect(() => renderer.bindTopology(scene, 16)).toThrow(
      'exceeds WebGPU storage buffer binding limit',
    );
    expect(previousTopologyBuffer.destroy).not.toHaveBeenCalled();
    expect(previousSegmentBuffer.destroy).not.toHaveBeenCalled();
    expect(previousChannelBuffer.destroy).not.toHaveBeenCalled();
    expect((renderer as any).bound).toBe(true);
  });
});
