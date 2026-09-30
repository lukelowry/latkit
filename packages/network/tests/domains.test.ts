import { expect, it } from 'vitest';
import { createGpu, type Gpu, type Preparation } from '@latkit/gpu';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
async function draw(gpu: Gpu, prepare: (frame: Preparation) => Promise<void>): Promise<void> {
  const texture = gpu.device.createTexture({
    size: [16, 16],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  await gpu.render({
    timeMs: 0,
    views: [
      {
        renderer: { prepare, encode() {}, destroy() {} },
        target: {
          device: gpu.device,
          width: 16,
          height: 16,
          format: 'rgba8unorm',
          texture: () => texture,
        },
      },
    ],
  });
  await gpu.idle();
  texture.destroy();
}
import { PathSource, vectors } from './paths-fixture.js';
import { readGeometry, DEFAULT_LIMITS, type VertexBank } from '../src/geometry/connectivity.js';
import { readFields, resolveDomains, type FieldRead } from '../src/rendering/fields.js';
it('uses the whole selected type for automatic domains across native blocks and draw banks', async () => {
  const count = 20000,
    source = new PathSource(
      {
        node: {
          position: vectors(Array.from({ length: count * 2 }, (_, i) => i)),
          weight: {
            kind: 'numeric',
            offset: 0,
            length: count,
            values: Float32Array.from({ length: count }, (_, i) => i),
          },
        },
      },
      {},
      311,
    );
  const options = { position: 'position', size: { field: 'weight', range: [2, 0.5] as const } };
  const data = { source, coordinates: 'cartesian' as const, vertices: { node: options } };
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    const geometry = await readGeometry(data, frame, DEFAULT_LIMITS),
      reads = new Map<VertexBank, FieldRead>();
    expect(geometry.vertices).toHaveLength(2);
    for (const bank of geometry.vertices)
      reads.set(bank, await readFields(frame, source, bank, options, 'position', () => {}));
    await resolveDomains(frame, source, reads, () => options);
    for (const read of reads.values()) expect(read.domains.size).toEqual([0, count - 1]);
  });
  gpu.destroy();
});
