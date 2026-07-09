/// <reference types="@webgpu/types" />

import { beforeEach, describe, expect, it } from 'vitest';
import { FrameResources } from '../src/webgpu/frame-resources.js';
import { FakeGpuDevice, installWebGpuConstants } from './fixtures/fake-webgpu.js';

beforeEach(() => {
  installWebGpuConstants();
});

describe('FrameResources', () => {
  it('throws when views are requested before allocation', () => {
    const resources = new FrameResources();

    expect(() => resources.depthView).toThrow('network depth target requested before allocation');
    expect(() =>
      resources.colorAttachment(4, {} as GPUTextureView, { r: 0, g: 0, b: 0, a: 0 }),
    ).toThrow('network MSAA target requested before allocation');
  });

  it('allocates MSAA/depth textures, reuses same-size targets, and destroys old targets on resize', () => {
    const device = new FakeGpuDevice();
    const resources = new FrameResources();
    const swapView = {} as GPUTextureView;
    const clear = { r: 0.1, g: 0.2, b: 0.3, a: 0.4 };

    resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 4, 100, 50);
    expect(device.textures.map((texture) => texture.descriptor.label)).toEqual([
      'network-msaa',
      'network-depth',
    ]);
    const attachment = resources.colorAttachment(4, swapView, clear);
    expect(attachment.view).toBeDefined();
    expect(attachment).toMatchObject({
      resolveTarget: swapView,
      loadOp: 'clear',
      clearValue: clear,
      storeOp: 'discard',
    });

    resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 4, 100, 50);
    expect(device.textures).toHaveLength(2);

    const old = [...device.textures];
    resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 4, 120, 60);

    expect(device.textures).toHaveLength(4);
    expect(old.every((texture) => texture.destroyed)).toBe(true);
  });

  it('uses the swapchain view directly for single-sample rendering', () => {
    const device = new FakeGpuDevice();
    const resources = new FrameResources();
    const swapView = {} as GPUTextureView;
    const clear = { r: 0, g: 0, b: 0, a: 0 };

    resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 1, 100, 50);

    expect(device.textures.map((texture) => texture.descriptor.label)).toEqual(['network-depth']);
    expect(resources.colorAttachment(1, swapView, clear)).toEqual({
      view: swapView,
      loadOp: 'clear',
      clearValue: clear,
      storeOp: 'store',
    });
  });

  it('cleans newly-created textures on allocation failure and preserves old targets', () => {
    const device = new FakeGpuDevice();
    const resources = new FrameResources();
    resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 4, 100, 50);
    const old = [...device.textures];
    device.failTextureLabels.add('network-depth');

    expect(() =>
      resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 4, 120, 60),
    ).toThrow('failed texture network-depth');

    expect(old.every((texture) => texture.destroyed)).toBe(false);
    const latestMsaa = [...device.textures]
      .reverse()
      .find((texture) => texture.descriptor.label === 'network-msaa');
    expect(latestMsaa?.destroyed).toBe(true);
  });

  it('destroys all allocated targets and resets to the unallocated state', () => {
    const device = new FakeGpuDevice();
    const resources = new FrameResources();
    resources.ensureSize(device as unknown as GPUDevice, 'bgra8unorm', 4, 100, 50);

    resources.destroy();

    expect(device.textures.every((texture) => texture.destroyed)).toBe(true);
    expect(() => resources.depthView).toThrow('network depth target requested before allocation');
  });
});
