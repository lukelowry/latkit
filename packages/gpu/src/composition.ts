import { children, renderers } from './renderers.js';
import type { Gpu } from './gpu.js';
import type { Renderer, Preparation, Encoding, FrameInfo, Invalidation } from './render.js';
import type { TextureResource } from './resources.js';
import type { RGBA } from './colors/color.js';
import { validateRgba } from './colors/color.js';
import { GpuError } from './error.js';
import { premultipliedBlend } from './output.js';
import { shadeUniforms } from './shade.js';

export interface CompositionView {
  readonly renderer: Renderer;
  /** Normalized output rectangle, top-left origin. Later views draw over earlier views. */
  readonly region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}
export interface CompositionOptions {
  readonly gpu: Gpu;
  readonly views: readonly CompositionView[];
  readonly background?: RGBA;
}
/** Borrows its child renderers; owns only panel textures and composition resources. */
export function createComposition(options: CompositionOptions): Renderer {
  const { gpu } = options;
  const views = options.views.map((view) => ({
    renderer: view.renderer,
    region: { ...view.region },
  }));
  if (!views.length || new Set(views.map((v) => v.renderer)).size !== views.length)
    throw new GpuError('invalid-input', 'Composition requires distinct renderer views');
  for (const { region: r } of views)
    if (
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x + r.width > 1 ||
      r.y + r.height > 1
    )
      throw new GpuError('invalid-input', 'Composition regions must fit the unit rectangle');
  renderers(views.map((view) => view.renderer));
  const background: RGBA = [...(options.background ?? [0, 0, 0, 1])];
  validateRgba(background);
  const listeners = new Set<(change: Invalidation) => void>();
  let closed = false,
    format: GPUTextureFormat | undefined,
    pipeline: GPURenderPipeline | undefined;
  const textures: (TextureResource | undefined)[] = [];
  const bindings: (
    | {
        texture: GPUTexture;
        view: GPUTextureView;
        group: GPUBindGroup;
        pipeline: GPURenderPipeline;
      }
    | undefined
  )[] = [];
  let prepared: {
    info: FrameInfo;
    x: number;
    y: number;
    view: GPUTextureView;
    group: GPUBindGroup;
  }[] = [];
  const sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const subscriptions = views.map((v) =>
    v.renderer.on?.('invalidate', (change) => {
      if (!closed) for (const listener of listeners) listener(change);
    }),
  );
  const live = () => {
    if (closed) throw new GpuError('closed', 'Composition is destroyed');
  };
  const shader = gpu.device.createShaderModule({
    label: 'composition',
    code: `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(uv * vec2f(2., -2.) + vec2f(-1., 1.), 0., 1.), uv);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f { return textureSample(image, filtering, v.uv); }
`,
  });
  const composition: Renderer = {
    get pending() {
      const pending = views.flatMap((v) => (v.renderer.pending ? [v.renderer.pending] : []));
      return pending.length ? Promise.all(pending).then(() => {}) : undefined;
    },
    get animating() {
      return !closed && views.some((v) => v.renderer.animating);
    },
    on(_event, listener) {
      live();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prepare(frame: Preparation) {
      live();
      prepared = [];
      if (!pipeline || format !== frame.format) {
        pipeline = await gpu.renderPipeline({
          layout: 'auto',
          vertex: { module: shader, entryPoint: 'vertex' },
          fragment: {
            module: shader,
            entryPoint: 'fragment',
            targets: [{ format: frame.format, blend: premultipliedBlend }],
          },
          primitive: { topology: 'triangle-list' },
        });
        format = frame.format;
      }
      for (let i = 0; i < views.length; i++) {
        frame.signal.throwIfAborted();
        live();
        const { renderer, region: r } = views[i];
        const x = Math.floor(r.x * frame.width),
          y = Math.floor(r.y * frame.height);
        const width = Math.floor((r.x + r.width) * frame.width) - x;
        const height = Math.floor((r.y + r.height) * frame.height) - y;
        if (width < 1 || height < 1)
          throw new GpuError('invalid-input', 'Composition panel is smaller than one pixel');
        let resource = textures[i];
        if (!resource || resource.texture.width !== width || resource.texture.height !== height) {
          const next = gpu.texture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          resource?.destroy();
          textures[i] = resource = next;
        }
        const texture = frame.texture(resource);
        let binding = bindings[i];
        if (!binding || binding.texture !== texture || binding.pipeline !== pipeline) {
          const view = texture.createView();
          binding = bindings[i] = {
            texture,
            view,
            pipeline,
            group: gpu.device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: sampler },
              ],
            }),
          };
        }
        const info: FrameInfo = {
          width,
          height,
          format: 'rgba8unorm',
          timeMs: frame.timeMs,
          at: frame.at,
          viewport: {
            width: width / frame.viewport.pixelRatio,
            height: height / frame.viewport.pixelRatio,
            pixelRatio: frame.viewport.pixelRatio,
          },
        };
        await renderer.prepare({
          ...frame,
          ...info,
          // The same shared uniform layout, with the panel's actual viewport.
          shade: (request = {}) => frame.uniforms(shadeUniforms(request, info)),
        });
        prepared.push({ info, x, y, view: binding.view, group: binding.group });
      }
    },
    encode(frame: Encoding) {
      live();
      if (prepared.length !== views.length)
        throw new GpuError('invalid-input', 'Composition is not prepared');
      for (let i = 0; i < views.length; i++)
        views[i].renderer.encode({
          ...prepared[i].info,
          encoder: frame.encoder,
          target: prepared[i].view,
        });
      const pass = frame.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: frame.target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [
              background[0] * background[3],
              background[1] * background[3],
              background[2] * background[3],
              background[3],
            ],
          },
        ],
      });
      pass.setPipeline(pipeline!);
      for (const panel of prepared) {
        pass.setViewport(panel.x, panel.y, panel.info.width, panel.info.height, 0, 1);
        pass.setBindGroup(0, panel.group);
        pass.draw(3);
      }
      pass.end();
    },
    submitted() {
      for (let i = 0; i < views.length; i++) views[i].renderer.submitted?.(prepared[i].info);
    },
    destroy() {
      if (closed) return;
      closed = true;
      for (const off of subscriptions) off?.();
      for (const texture of textures) texture?.destroy();
      listeners.clear();
      prepared = [];
      bindings.length = 0;
      children.delete(composition);
    },
  };
  children.set(
    composition,
    views.map((view) => view.renderer),
  );
  return composition;
}
