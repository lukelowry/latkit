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
import { clearColor, validateRgba } from '../colors/color.js';
import { premultipliedBlend } from '../style/output.js';
import { shadeUniforms } from '../style/shade.js';
import { localPoint } from './input.js';
import { viewStyle } from './style.js';
import {
  BaseView,
  compose,
  rendererOf,
  route,
  type View,
  type ViewConfig,
  type ViewEvents,
} from './view.js';

export interface CompositionConfig extends ViewConfig {
  /**
   * Each view in a normalized region, top-left origin; later views draw over earlier ones. Pointer,
   * wheel, and keys reach the view under the pointer, in its own canvas points.
   */
  readonly views: readonly {
    readonly view: View<ViewConfig, ViewEvents>;
    readonly region: readonly [x: number, y: number, width: number, height: number];
  }[];
  /** Behind every region; `viewStyle.background` by default. */
  readonly background?: RGBA;
}
type Region = CompositionConfig['views'][number]['region'];

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

/** Event properties a panel's view reads, copied onto the event routed to it. */
const PROPERTIES = [
  'clientX',
  'clientY',
  'button',
  'buttons',
  'pointerId',
  'pointerType',
  'isPrimary',
  'altKey',
  'ctrlKey',
  'metaKey',
  'shiftKey',
  'deltaX',
  'deltaY',
  'deltaMode',
  'key',
  'code',
  'repeat',
  'detail',
] as const;
/** Events a composition routes to the panel they concern. */
const POINTER = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick'] as const;

/**
 * The canvas a composed view attaches its input to: its panel's part of the composition's canvas.
 * Pointer capture, focus, and the cursor act on the real canvas.
 */
class PanelSurface extends EventTarget {
  tabIndex = -1;
  readonly clientLeft = 0;
  readonly clientTop = 0;
  readonly style: { touchAction: string; cursor: string };
  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly region: Region,
  ) {
    super();
    const real = canvas.style;
    this.style = {
      touchAction: '',
      get cursor() {
        return real.cursor;
      },
      set cursor(value: string) {
        real.cursor = value;
      },
    };
  }
  get ownerDocument(): Document {
    return this.canvas.ownerDocument;
  }
  get clientWidth(): number {
    return this.canvas.clientWidth * this.region[2];
  }
  get clientHeight(): number {
    return this.canvas.clientHeight * this.region[3];
  }
  get offsetWidth(): number {
    return this.clientWidth;
  }
  get offsetHeight(): number {
    return this.clientHeight;
  }
  getBoundingClientRect(): DOMRect {
    const canvas = this.canvas,
      rect = canvas.getBoundingClientRect(),
      sx = rect.width / (canvas.offsetWidth || rect.width),
      sy = rect.height / (canvas.offsetHeight || rect.height);
    const left = rect.left + (canvas.clientLeft + this.region[0] * canvas.clientWidth) * sx,
      top = rect.top + (canvas.clientTop + this.region[1] * canvas.clientHeight) * sy,
      width = this.clientWidth * sx,
      height = this.clientHeight * sy;
    return {
      left,
      top,
      width,
      height,
      x: left,
      y: top,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    };
  }
  /** Whether a point of the composition's canvas, in CSS pixels, lies in this panel. */
  contains(point: readonly [number, number]): boolean {
    const x = point[0] / (this.canvas.clientWidth || 1),
      y = point[1] / (this.canvas.clientHeight || 1),
      r = this.region;
    return x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
  }
  getAttribute(): string | null {
    return null;
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  setPointerCapture(id: number): void {
    this.canvas.setPointerCapture(id);
  }
  releasePointerCapture(id: number): void {
    if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.canvas.hasPointerCapture(id);
  }
  focus(options?: FocusOptions): void {
    this.canvas.focus(options);
  }
  /** Deliver an event of the composition's canvas as this panel's own. */
  forward(event: Event, type: string = event.type): void {
    const routed = new Event(type, { cancelable: event.cancelable });
    for (const name of PROPERTIES)
      if (name in event)
        Object.defineProperty(routed, name, {
          value: (event as unknown as Record<string, unknown>)[name],
        });
    routed.preventDefault = () => event.preventDefault();
    this.dispatchEvent(routed);
  }
}

interface Panel {
  readonly view: View<ViewConfig, ViewEvents>;
  readonly renderer: Renderer;
  readonly region: Region;
  readonly release: () => void;
  readonly off: () => void;
  surface?: PanelSurface;
  unroute?: () => void;
}
/** One panel's part of a prepared frame. */
interface PanelFrame {
  readonly candidate: PreparedFrame;
  readonly info: FrameInfo;
  readonly x: number;
  readonly y: number;
  readonly view: GPUTextureView;
  readonly group: GPUBindGroup;
}

class CompositionView extends BaseView<
  CompositionConfig,
  ViewEvents,
  CompositionConfig,
  readonly PanelFrame[]
> {
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
  /** Each panel renderer's memo slots, kept apart from a sibling's of the same kind. */
  private readonly slots = new WeakMap<Renderer, Map<unknown, object>>();
  /** The canvas whose input the panels receive, while one is attached. */
  private canvas?: HTMLCanvasElement;
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
        const panel: Panel = {
          view,
          renderer,
          region: [...region] as unknown as Region,
          release,
          off: renderer.on?.('invalidate', () => this.invalidate()) ?? (() => {}),
        };
        panels.push(panel);
        if (this.canvas) this.route(panel, this.canvas);
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
  private route(panel: Panel, canvas: HTMLCanvasElement): void {
    panel.surface = new PanelSurface(canvas, panel.region);
    panel.unroute = route(panel.view, panel.surface as unknown as HTMLCanvasElement);
  }
  private unpanel(panel: Panel): void {
    panel.unroute?.();
    panel.off();
    panel.release();
  }
  protected configure(next: CompositionConfig, previous: CompositionConfig): void {
    if (previous.views !== next.views) {
      const panels = this.compose(next);
      for (const panel of this.panels) this.unpanel(panel);
      this.panels = panels;
    }
    this.invalidate();
  }
  /** Route pointer, wheel, menu, and key events to the panel they concern. */
  protected attach(canvas: HTMLCanvasElement): () => void {
    const controller = new AbortController(),
      { signal } = controller,
      tab = canvas.getAttribute('tabindex'),
      touch = canvas.style.touchAction;
    if (tab === null) canvas.tabIndex = 0;
    canvas.style.touchAction = 'none';
    this.canvas = canvas;
    for (const panel of this.panels) this.route(panel, canvas);
    let pressed: Panel | undefined, hovered: Panel | undefined, focused: Panel | undefined;
    const under = (event: MouseEvent): Panel | undefined => {
      const point = localPoint(canvas, event);
      // Later panels draw over earlier ones, so the last that contains the point is under it.
      for (let i = this.panels.length - 1; i >= 0; i--)
        if (this.panels[i].surface?.contains(point)) return this.panels[i];
      return undefined;
    };
    const leave = (event: Event) => {
      hovered?.surface?.forward(event, 'pointerleave');
      hovered = undefined;
    };
    for (const type of POINTER)
      canvas.addEventListener(
        type,
        (event) => {
          const panel = (type !== 'pointerdown' && pressed) || under(event);
          if (panel !== hovered) {
            leave(event);
            hovered = panel;
          }
          if (type === 'pointerdown') pressed = focused = panel;
          panel?.surface?.forward(event);
          if (type === 'pointerup' || type === 'pointercancel') pressed = undefined;
        },
        { signal },
      );
    canvas.addEventListener('wheel', (event) => under(event)?.surface?.forward(event), {
      signal,
      passive: false,
    });
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        event.preventDefault();
        (pressed ?? under(event))?.surface?.forward(event);
      },
      { signal },
    );
    canvas.addEventListener('pointerleave', (event) => !pressed && leave(event), { signal });
    canvas.addEventListener('lostpointercapture', (event) => pressed?.surface?.forward(event), {
      signal,
    });
    // Keys reach the panel pressed last; leaving the canvas ends what that panel was doing.
    for (const type of ['keydown', 'keyup'] as const)
      canvas.addEventListener(
        type,
        (event) => (focused ?? this.panels[0])?.surface?.forward(event),
        { signal },
      );
    canvas.addEventListener('blur', (event) => focused?.surface?.forward(event), { signal });
    return () => {
      controller.abort();
      for (const panel of this.panels) {
        panel.unroute?.();
        panel.unroute = panel.surface = undefined;
      }
      this.canvas = undefined;
      canvas.style.touchAction = touch;
      if (tab === null) canvas.removeAttribute('tabindex');
    };
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
  protected discard(prepared: readonly PanelFrame[]): void {
    for (const panel of prepared) panel.candidate.discard();
  }
  /** Prepare every panel at once, as the Gpu prepares views; one failure discards the rest. */
  protected async prepare(frame: Preparation): Promise<readonly PanelFrame[]> {
    this.live();
    const pipeline = await this.compositor(frame.format);
    frame.signal.throwIfAborted();
    const layouts = this.panels.map((panel, i) => this.layout(frame, pipeline, panel, i));
    const results = await Promise.allSettled(
      layouts.map(({ info }, i) =>
        this.captures[i].prepare({
          ...this.scoped(frame, this.panels[i].renderer),
          ...info,
          // The same shared uniform layout, with the panel's actual viewport.
          shade: (request = {}) => frame.uniforms(shadeUniforms(request, info)),
        }),
      ),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      for (const result of results) if (result.status === 'fulfilled') result.value.discard();
      throw failed.reason;
    }
    return layouts.map((layout, i) => ({
      ...layout,
      candidate: (results[i] as PromiseFulfilledResult<PreparedFrame>).value,
    }));
  }
  /** A frame whose memos, and theirs in turn, are one panel renderer's own. */
  private scoped(frame: Preparation, renderer: Renderer): Preparation {
    let slots = this.slots.get(renderer);
    if (!slots) this.slots.set(renderer, (slots = new Map<unknown, object>()));
    const own = slots;
    const key = (slot: unknown) => {
      let found = own.get(slot);
      if (!found) own.set(slot, (found = { slot }));
      return found;
    };
    return {
      ...frame,
      memo: (slot, deps, build) =>
        frame.memo(key(slot), deps, (inner, previous) =>
          build(this.scoped(inner, renderer), previous),
        ),
    };
  }
  private async compositor(format: GPUTextureFormat): Promise<GPURenderPipeline> {
    if (this.pipeline && this.format === format) return this.pipeline;
    const module = await this.gpu.shaderModule(shader, 'composition');
    this.pipeline = await this.gpu.renderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [{ format, blend: premultipliedBlend }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.format = format;
    return this.pipeline;
  }
  /** Where a panel draws in this frame, and the texture it draws into. */
  private layout(
    frame: Preparation,
    pipeline: GPURenderPipeline,
    panel: Panel,
    i: number,
  ): Omit<PanelFrame, 'candidate'> {
    const r = panel.region,
      x = Math.floor(r[0] * frame.width),
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
    return { info, x, y, view: binding.view, group: binding.group };
  }
  protected encode(frame: Encoding, prepared: readonly PanelFrame[]): void {
    this.live();
    for (const panel of prepared)
      panel.candidate.encode({ ...panel.info, encoder: frame.encoder, target: panel.view });
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: frame.target,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: clearColor(this.frameConfig.background ?? viewStyle.background),
        },
      ],
    });
    pass.setPipeline(this.pipeline!);
    for (const panel of prepared) {
      pass.setViewport(panel.x, panel.y, panel.info.width, panel.info.height, 0, 1);
      pass.setBindGroup(0, panel.group);
      pass.draw(3);
    }
    pass.end();
  }
  protected submitted(_frame: FrameInfo, prepared: readonly PanelFrame[]): void {
    for (const panel of prepared) panel.candidate.submitted();
  }
  protected release(): void {
    for (const panel of this.panels) this.unpanel(panel);
    this.panels = [];
    children.delete(this.own);
    for (const texture of this.textures) texture?.destroy();
    this.textures = [];
    this.bindings = [];
  }
}
