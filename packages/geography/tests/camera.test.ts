import { afterEach, expect, it, vi } from 'vitest';
import { createGpu, kit } from '@latkit/gpu';
import { createGeography } from '../src/index.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

function device() {
  const fake = fakeDevice();
  fake.device.createShaderModule = vi.fn(
    () =>
      ({
        getCompilationInfo: () => Promise.resolve({ messages: [] }),
      }) as unknown as GPUShaderModule,
  );
  fake.device.createPipelineLayout = vi.fn(() => ({}) as GPUPipelineLayout);
  const original = fake.device.createCommandEncoder.bind(fake.device);
  fake.device.createCommandEncoder = vi.fn(() => {
    const encoder = original();
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      drawIndirect: vi.fn(),
      end: vi.fn(),
    };
    encoder.clearBuffer = vi.fn();
    encoder.beginComputePass = vi.fn(() => pass as unknown as GPUComputePassEncoder);
    encoder.beginRenderPass = vi.fn(() => pass as unknown as GPURenderPassEncoder);
    return encoder;
  });
  return fake;
}
afterEach(() => {
  vi.restoreAllMocks();
});

it('orbits as a network does: turning each presented frame by orbitRate, and holding still under reduced motion', async () => {
  const gpu = await createGpu({ device: device().device });
  const texture = gpu.device.createTexture({
    size: [400, 300],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const surface = {
    device: gpu.device,
    width: 400,
    height: 300,
    format: 'rgba8unorm' as const,
    texture: () => texture,
  };
  const geography = createGeography(gpu, {
    motion: 'full',
    orbitRate: -2,
    camera: { projection: 'globe', orbit: true, fit: false },
  });
  const draw = (timeMs: number) =>
    gpu.render({ timeMs, views: [{ renderer: kit.rendererOf(geography), target: surface }] });
  try {
    await draw(0);
    await draw(50);
    // Twelve degrees a second at rate 1; this one turns twice as fast, the other way.
    expect(geography.camera.bearing).toBeCloseTo(-1.2, 5);
    expect(geography.camera.orbit).toBe(true);
    // Reduced motion holds the camera still, and a camera asking to orbit under it does not.
    geography.set({ motion: 'reduce' });
    await draw(100);
    await draw(150);
    expect(geography.camera.bearing).toBeCloseTo(-1.2, 5);
    geography.set({ camera: { orbit: true } });
    expect(geography.camera.orbit).toBe(false);
  } finally {
    geography.destroy();
    gpu.destroy();
  }
});
