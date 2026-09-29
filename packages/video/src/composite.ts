import type { RenderTarget } from '@latkit/gpu';
const shader = `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(uv * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.), uv);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f { return textureSample(image, filtering, v.uv); }
`;
export async function compositor(
  device: GPUDevice,
  format: GPUTextureFormat,
  targets: readonly RenderTarget[],
) {
  const module = device.createShaderModule({ code: shader });
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex' },
    fragment: {
      module,
      entryPoint: 'fragment',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const groups = targets.map((target) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: target.texture().createView() },
        { binding: 1, resource: sampler },
      ],
    }),
  );
  return (
    texture: GPUTexture,
    panels: readonly { x: number; y: number; width: number; height: number }[],
    background: readonly [number, number, number],
  ): void => {
    const commands = device.createCommandEncoder();
    const pass = commands.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [...background, 1],
        },
      ],
    });
    pass.setPipeline(pipeline);
    panels.forEach((panel, i) => {
      pass.setViewport(panel.x, panel.y, panel.width, panel.height, 0, 1);
      pass.setBindGroup(0, groups[i]!);
      pass.draw(3);
    });
    pass.end();
    device.queue.submit([commands.finish()]);
  };
}
