import { failure } from '@latkit/model';
import { children } from '../frame/tree.js';
import type { Gpu } from '../gpu.js';
import type {
  Renderer,
  Preparation,
  Encoding,
  FrameInfo,
  CapturedFrame,
  PreparedFrame,
} from '../frame/render.js';
import type { TextureResource } from '../memory/textures.js';
import type { RGBA } from '../colors/color.js';
import { validateRgba } from '../colors/color.js';
import { premultipliedBlend } from '../style/output.js';
import { shadeUniforms } from '../style/shade.js';
import { viewStyle } from './style.js';
import {
  BaseView,
  compose,
  rendererOf,
  type View,
  type ViewConfig,
  type ViewEvents,
} from './view.js';

export interface CompositionConfig extends ViewConfig {
  /** Each view in a normalized region, top-left origin; later views draw over earlier ones. */
  readonly views: readonly {
    readonly view: View<ViewConfig, ViewEvents>;
    readonly region: readonly [x: number, y: number, width: number, height: number];
  }[];
  /** Behind every region; `viewStyle.background` by default. */
  readonly background?: RGBA;
}

/** Several views presented as one. */
export type Composition = View<CompositionConfig>;

/** Present several views as one: on a canvas, in images, or in video. Borrows its views. */
export function createComposition(gpu: Gpu, config: CompositionConfig): Composition {
  return new CompositionView(gpu, config);
}

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

interface Panel {
  readonly renderer: Renderer;
  readonly region: CompositionConfig['views'][number]['region'];
  readonly release: () => void;
  readonly off: () => void;
}

class CompositionView extends BaseView<CompositionConfig, ViewEvents> {
  private panels: Panel[] = [];
  private readonly own: Renderer;
  private readonly sampler: GPUSampler;
  private format?: GPUTextureFormat;
  private pipeline?: GPURenderPipeline;
  private textures: (TextureResource | undefined)[] = [];
  private bindings: (
    { texture: GPUTexture; view: GPUTextureView; group: GPUBindGroup } | undefined
  )[] = [];
  private captures: CapturedFrame[] = [];
  private prepared: {
    candidate: PreparedFrame;
    info: FrameInfo;
    x: number;
    y: number;
    view: GPUTextureView;
    group: GPUBindGroup;
  }[] = [];
  constructor(gpu: Gpu, config: CompositionConfig) {
    super(gpu, config);
    this.own = rendererOf(this);
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.check(config);
    this.panels = this.compose(config);
    this.start();
  }
  protected check(config: CompositionConfig): void {
    if (!config.views?.length) throw failure('invalid-input', 'A composition needs views');
    if (new Set(config.views.map((v) => v.view)).size !== config.views.length)
      throw failure('invalid-input', 'Composition requires distinct views');
    for (const { region: r } of config.views)
      if (
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[0] < 0 ||
        r[1] < 0 ||
        r[2] <= 0 ||
        r[3] <= 0 ||
        r[0] + r[2] > 1 ||
        r[1] + r[3] > 1
      )
        throw failure('invalid-input', 'Composition regions must fit the unit rectangle');
    if (config.background) validateRgba(config.background);
  }
  private compose(config: CompositionConfig): Panel[] {
    const panels: Panel[] = [];
    try {
      for (const { view, region } of config.views) {
        const renderer = rendererOf(view),
          release = compose(view);
        panels.push({
          renderer,
          region: [...region] as unknown as Panel['region'],
          release,
          off: renderer.on?.('invalidate', () => this.invalidate()) ?? (() => {}),
        });
      }
    } catch (error) {
      for (const panel of panels) this.unpanel(panel);
      throw error;
    }
    children.set(
      this.own,
      panels.map((panel) => panel.renderer),
    );
    return panels;
  }
  private unpanel(panel: Panel): void {
    panel.off();
    panel.release();
  }
  protected configure(previous: CompositionConfig, next: CompositionConfig): void {
    if (previous.views !== next.views) {
      const panels = this.compose(next);
      for (const panel of this.panels) this.unpanel(panel);
      this.panels = panels;
    }
    this.invalidate();
  }
  protected get pending(): Promise<void> | undefined {
    const pending = this.panels.flatMap((p) => (p.renderer.pending ? [p.renderer.pending] : []));
    return pending.length ? Promise.all(pending).then(() => {}) : undefined;
  }
  protected get animating(): boolean {
    return this.panels.some((p) => p.renderer.animating);
  }
  protected captureChildren(): readonly CapturedFrame[] {
    this.captures = [];
    try {
      for (const panel of this.panels) this.captures.push(panel.renderer.capture());
    } catch (error) {
      for (const capture of this.captures) capture.release();
      throw error;
    }
    return this.captures;
  }
  protected discard(): void {
    for (const panel of this.prepared) panel.candidate.discard();
    this.prepared = [];
  }
  protected async prepare(frame: Preparation): Promise<void> {
    this.live();
    this.prepared = [];
    if (!this.pipeline || this.format !== frame.format) {
      const module = await this.gpu.shaderModule(shader, 'composition');
      this.pipeline = await this.gpu.renderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: frame.format, blend: premultipliedBlend }],
        },
        primitive: { topology: 'triangle-list' },
      });
      this.format = frame.format;
    }
    const pipeline = this.pipeline;
    for (let i = 0; i < this.panels.length; i++) {
      frame.signal.throwIfAborted();
      this.live();
      const { region: r } = this.panels[i];
      const x = Math.floor(r[0] * frame.width),
        y = Math.floor(r[1] * frame.height);
      const width = Math.floor((r[0] + r[2]) * frame.width) - x;
      const height = Math.floor((r[1] + r[3]) * frame.height) - y;
      if (width < 1 || height < 1)
        throw failure('invalid-input', 'Composition panel is smaller than one pixel');
      let resource = this.textures[i];
      if (!resource || resource.texture.width !== width || resource.texture.height !== height) {
        const next = this.gpu.texture({
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        resource?.destroy();
        this.textures[i] = resource = next;
      }
      const texture = frame.texture(resource);
      let binding = this.bindings[i];
      if (!binding || binding.texture !== texture) {
        const view = texture.createView();
        binding = this.bindings[i] = {
          texture,
          view,
          group: this.gpu.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: view },
              { binding: 1, resource: this.sampler },
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
        presented: frame.presented,
        viewport: {
          width: width / frame.viewport.pixelRatio,
          height: height / frame.viewport.pixelRatio,
          pixelRatio: frame.viewport.pixelRatio,
        },
      };
      const candidate = await this.captures[i].prepare({
        ...frame,
        ...info,
        // The same shared uniform layout, with the panel's actual viewport.
        shade: (request = {}) => frame.uniforms(shadeUniforms(request, info)),
      });
      this.prepared.push({ candidate, info, x, y, view: binding.view, group: binding.group });
    }
  }
  protected encode(frame: Encoding): void {
    this.live();
    if (this.prepared.length !== this.panels.length)
      throw failure('invalid-input', 'Composition is not prepared');
    for (let i = 0; i < this.panels.length; i++)
      this.prepared[i].candidate.encode({
        ...this.prepared[i].info,
        encoder: frame.encoder,
        target: this.prepared[i].view,
      });
    const background = this.frameConfig.background ?? viewStyle.background;
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
    pass.setPipeline(this.pipeline!);
    for (const panel of this.prepared) {
      pass.setViewport(panel.x, panel.y, panel.info.width, panel.info.height, 0, 1);
      pass.setBindGroup(0, panel.group);
      pass.draw(3);
    }
    pass.end();
  }
  protected submitted(): void {
    for (let i = 0; i < this.panels.length; i++) this.prepared[i].candidate.submitted();
  }
  protected release(): void {
    for (const panel of this.panels) this.unpanel(panel);
    this.panels = [];
    children.delete(this.own);
    for (const texture of this.textures) texture?.destroy();
    this.textures = [];
    this.prepared = [];
    this.bindings = [];
  }
}
