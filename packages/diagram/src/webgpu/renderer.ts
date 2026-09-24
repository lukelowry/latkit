/// <reference types="@webgpu/types" />

import type { Presentation } from '@latkit/gpu';
import { bakeColormap, COLORMAP_LUT_SIZE } from '@latkit/model';

import { DEFAULT_OPTIONS } from '../options.js';
import { DEFAULT_SHADE_WGSL } from '../shade.js';
import type { Atlas } from '../text/atlas.js';
import {
  GLYPH_WORDS,
  OVERLAY_WORDS,
  WIRE_WORDS,
  type DrawCounts,
  type Mirror,
  type Mirrors,
} from './buffers.js';
import { DISPLAY_GRID, W_FLAGS } from './uniforms.js';

import blockSrc from './shaders/block.wgsl?raw';
import commonSrc from './shaders/common.wgsl?raw';
import glyphSrc from './shaders/glyph.wgsl?raw';
import gridSrc from './shaders/grid.wgsl?raw';
import groupSrc from './shaders/group.wgsl?raw';
import overlaySrc from './shaders/overlay.wgsl?raw';
import portSrc from './shaders/port.wgsl?raw';
import shadeSrc from './shaders/shade.wgsl?raw';
import wireSrc from './shaders/wire.wgsl?raw';

/** The seven passes, named by their shader files. */
export type PassName = 'grid' | 'group' | 'wire' | 'block' | 'port' | 'glyph' | 'overlay';

/** The mirrors a pass binds as its group 1 instance buffer. */
type InstanceMirror = 'wires' | 'glyphs' | 'overlay';

/** One pass: its WGSL, whether the host shade is spliced in, and its instance buffer. */
export interface Pass {
  readonly name: PassName;
  /** The pass file, appended after the prelude. */
  readonly source: string;
  /** Whether the module carries `shade.wgsl` and the host shade, and builds per shade. */
  readonly shaded: boolean;
  /** The mirror bound as group 1 binding 0, or null for a pass that reads only group 0. */
  readonly instances: InstanceMirror | null;
}

/**
 * Every pass in draw order: painter's, each over the ones before it. Only the group, wire, block,
 * and port passes are shaded, so a shade change rebuilds four pipelines and leaves three.
 */
export const PASSES: readonly Pass[] = Object.freeze([
  { name: 'grid', source: gridSrc, shaded: false, instances: null },
  { name: 'group', source: groupSrc, shaded: true, instances: null },
  { name: 'wire', source: wireSrc, shaded: true, instances: 'wires' },
  { name: 'block', source: blockSrc, shaded: true, instances: null },
  { name: 'port', source: portSrc, shaded: true, instances: null },
  { name: 'glyph', source: glyphSrc, shaded: false, instances: 'glyphs' },
  { name: 'overlay', source: overlaySrc, shaded: false, instances: 'overlay' },
] satisfies Pass[]);

/**
 * A pass's shader module source: `common.wgsl`, then `shade.wgsl` and the host shade for a shaded
 * pass, then the pass file. Compilation line numbers count from the top of this text.
 *
 * @throws RangeError for an unknown pass name.
 */
export function passSource(name: PassName, shade: string = DEFAULT_SHADE_WGSL): string {
  const pass = PASSES.find((entry) => entry.name === name);
  if (!pass) throw new RangeError(`diagram: no render pass named ${String(name)}`);
  return pass.shaded
    ? `${commonSrc}\n${shadeSrc}\n${shade}\n${pass.source}`
    : `${commonSrc}\n${pass.source}`;
}

/** The atlas state a frame uploads; an `Atlas` is one. */
export type AtlasPixels = Pick<
  Atlas,
  'width' | 'height' | 'pixels' | 'version' | 'dirtyFrom' | 'dirtyTo' | 'clean'
>;

/** Premultiplied-alpha "over": every pass outputs premultiplied color onto a transparent clear. */
const PREMULTIPLIED_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** Transparent clear: the themed DOM behind the premultiplied canvas is the backdrop. */
const TRANSPARENT: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/** The smallest GPU buffer a mirror gets, in words, so no binding is ever empty. */
const MIN_WORDS = 4;

/** One GPU buffer shadowing a mirror. */
interface Shadow {
  readonly mirror: Mirror;
  buffer: GPUBuffer | null;
  /** The buffer's size in bytes. */
  bytes: number;
  /** The mirror version the buffer was allocated for; -1 until the first upload. */
  version: number;
}

/** A pipeline per pass, in `PASSES` order, and the shade the shaded ones compiled against. */
interface Pipelines {
  readonly shade: string;
  readonly ordered: readonly GPURenderPipeline[];
}

/**
 * Draws a diagram from its mirrors: uploads what changed in them and in the atlas, then encodes one
 * frame of seven instanced passes over a fullscreen grid, painter's order, premultiplied over a
 * transparent clear.
 *
 * @remarks
 * Each pass module is `common.wgsl` + (`shade.wgsl` + the host shade for the group, wire, block,
 * and port passes) + the pass file. Pipelines build asynchronously; a failure calls
 * `onPipelineError` and `render` returns false until a later `setShade` succeeds. Every pass shares
 * bind group 0 (uniforms, structure, layout, channels, focus, colormap, atlas, sampler); the wire,
 * glyph, and overlay passes add their instance buffer as group 1, so no pipeline binds more than
 * five storage buffers. GPU buffers start at version -1, so a new renderer uploads every mirror.
 */
export class Renderer {
  /** Called whenever a pipeline build lands and frames can draw with it. */
  onPipelinesReady?: () => void;
  /** Called when the build a renderer starts with fails; a failed `setShade` rejects instead. */
  onPipelineError?: (cause: unknown) => void;

  private readonly presentation: Presentation<HTMLCanvasElement>;
  private readonly mirrors: Mirrors;
  private readonly sharedLayout: GPUBindGroupLayout;
  private readonly instanceLayout: GPUBindGroupLayout;
  private readonly baseLayout: GPUPipelineLayout;
  private readonly instancedLayout: GPUPipelineLayout;
  private readonly colormap: GPUTexture;
  private readonly sampler: GPUSampler;
  private readonly shadows: { readonly [K in keyof Mirrors]: Shadow };

  private atlasTexture: GPUTexture | null = null;
  private atlasVersion = -1;
  private atlasWidth = 0;
  private atlasHeight = 0;
  private shared: GPUBindGroup | null = null;
  private readonly instanceGroups: Record<InstanceMirror, GPUBindGroup | null> = {
    wires: null,
    glyphs: null,
    overlay: null,
  };

  /** The shade the renderer draws with, or is building toward. */
  private shade: string;
  /** The pipelines frames draw with; null until a build lands. */
  private pipelines: Pipelines | null = null;
  /** The build toward `shade` while it is in flight. */
  private building: Promise<void> | null = null;
  /** Bumped by every build, so one that lands after a newer one began stands down. */
  private generation = 0;
  /** The unshaded pipelines, built once and shared by every shade. */
  private unshaded: Promise<readonly GPURenderPipeline[]> | null = null;
  private destroyed = false;

  /**
   * Allocate the shared layouts, the colormap, and the sampler, and start building every pass
   * against `shadeWgsl`, or the identity shade.
   */
  constructor(
    presentation: Presentation<HTMLCanvasElement>,
    mirrors: Mirrors,
    shadeWgsl: string | null,
  ) {
    this.presentation = presentation;
    this.mirrors = mirrors;
    this.shade = shadeWgsl ?? DEFAULT_SHADE_WGSL;
    const { device } = presentation;

    // Every stage reads group 0: vertex stages place parts from it, fragment stages color them.
    const stages = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: stages,
      buffer: { type: 'read-only-storage' },
    });
    this.sharedLayout = device.createBindGroupLayout({
      label: 'diagram-shared-layout',
      entries: [
        { binding: 0, visibility: stages, buffer: { type: 'uniform' } },
        storage(1),
        storage(2),
        storage(3),
        storage(4),
        { binding: 5, visibility: stages, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 6, visibility: stages, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 7, visibility: stages, sampler: { type: 'filtering' } },
      ],
    });
    // Only vertex stages read instance buffers: they hand fragments everything as varyings.
    this.instanceLayout = device.createBindGroupLayout({
      label: 'diagram-instance-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    this.baseLayout = device.createPipelineLayout({
      label: 'diagram-base-pipeline-layout',
      bindGroupLayouts: [this.sharedLayout],
    });
    this.instancedLayout = device.createPipelineLayout({
      label: 'diagram-instanced-pipeline-layout',
      bindGroupLayouts: [this.sharedLayout, this.instanceLayout],
    });

    this.colormap = device.createTexture({
      label: 'diagram colormap',
      size: [COLORMAP_LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      label: 'diagram sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.writeColormap(bakeColormap(DEFAULT_OPTIONS.colormap));

    const shadow = (mirror: Mirror): Shadow => ({ mirror, buffer: null, bytes: 0, version: -1 });
    this.shadows = {
      uniforms: shadow(mirrors.uniforms),
      structure: shadow(mirrors.structure),
      layout: shadow(mirrors.layout),
      channels: shadow(mirrors.channels),
      focus: shadow(mirrors.focus),
      wires: shadow(mirrors.wires),
      glyphs: shadow(mirrors.glyphs),
      overlay: shadow(mirrors.overlay),
    };

    // A failure here reaches onPipelineError; nothing awaits the constructor's build.
    this.run(this.shade, true).catch(() => {});
  }

  /**
   * Rebuild the shaded pipelines with a host shade, or the identity with null. Resolves once they
   * draw with it; rejects, keeping the previous shade, when it does not compile.
   */
  async setShade(wgsl: string | null): Promise<void> {
    const next = wgsl ?? DEFAULT_SHADE_WGSL;
    if (this.destroyed) return;
    if (next === this.shade) {
      if (this.building) return this.building;
      if (this.pipelines?.shade === next) return;
      return this.run(next, false);
    }
    const previous = this.shade;
    this.shade = next;
    if (this.pipelines?.shade === next) {
      // Back to the shade already drawing: the build toward the other one stands down.
      this.generation++;
      this.building = null;
      return;
    }
    try {
      await this.run(next, false);
    } catch (error) {
      if (!this.destroyed && this.shade === next && this.building === null) {
        this.shade = previous;
        // Frames keep drawing what they drew; the previous shade rebuilds only when this build
        // superseded it before it landed.
        if (this.pipelines?.shade !== previous) this.run(previous, true).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Replace the colormap lookup texture.
   *
   * @param lut - `COLORMAP_LUT_SIZE` rgba8 texels, as `bakeColormap` returns.
   * @throws RangeError when `lut` holds fewer bytes than the texture.
   */
  writeColormap(lut: Uint8Array): void {
    if (lut.byteLength < COLORMAP_LUT_SIZE * 4) {
      throw new RangeError(
        `diagram colormap needs ${COLORMAP_LUT_SIZE * 4} bytes, got ${lut.byteLength}`,
      );
    }
    if (this.destroyed) return;
    this.presentation.device.queue.writeTexture(
      { texture: this.colormap },
      lut as Uint8Array<ArrayBuffer>,
      { bytesPerRow: COLORMAP_LUT_SIZE * 4 },
      [COLORMAP_LUT_SIZE, 1],
    );
  }

  /**
   * Upload dirty mirror ranges (reallocating grown buffers and rebinding) and the atlas, then
   * encode and submit one frame. False while pipelines are not ready (nothing submitted).
   *
   * @remarks
   * The uniform block uploads whole every frame; every other mirror uploads its dirty ranges, one
   * `writeBuffer` each, or all of it into a new buffer when its version changed. Mirrors and the
   * atlas are cleaned after their upload. The grid draws only with `DISPLAY_GRID` set; the wire,
   * glyph, and overlay counts are capped at the entries their mirrors hold.
   *
   * @throws Error when a mirror outgrows the device's buffer limits.
   */
  render(counts: DrawCounts, atlas: AtlasPixels): boolean {
    const pipelines = this.pipelines;
    if (this.destroyed || !pipelines) return false;
    const { device, context } = this.presentation;
    const { shadows } = this;

    let rebind = this.upload(shadows.uniforms, true);
    rebind = this.upload(shadows.structure, false) || rebind;
    rebind = this.upload(shadows.layout, false) || rebind;
    rebind = this.upload(shadows.channels, false) || rebind;
    rebind = this.upload(shadows.focus, false) || rebind;
    rebind = this.uploadAtlas(atlas) || rebind;
    if (rebind || !this.shared) this.shared = this.createSharedGroup();
    this.syncInstances('wires');
    this.syncInstances('glyphs');
    this.syncInstances('overlay');

    const encoder = device.createCommandEncoder({ label: 'diagram-frame' });
    const pass = encoder.beginRenderPass({
      label: 'diagram-frame',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: TRANSPARENT,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setBindGroup(0, this.shared);
    for (let i = 0; i < PASSES.length; i++) {
      const def = PASSES[i]!;
      const instances = this.instanceCount(def.name, counts);
      if (instances === 0) continue;
      pass.setPipeline(pipelines.ordered[i]!);
      if (def.instances) pass.setBindGroup(1, this.instanceGroups[def.instances]);
      // A fullscreen triangle for the grid, a quad per instance for everything else.
      pass.draw(def.name === 'grid' ? 3 : 6, instances);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    return true;
  }

  /** Release every GPU resource; idempotent. Builds still in flight stand down when they land. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.building = null;
    this.pipelines = null;
    for (const shadow of Object.values(this.shadows)) {
      shadow.buffer?.destroy();
      shadow.buffer = null;
    }
    this.atlasTexture?.destroy();
    this.atlasTexture = null;
    this.colormap.destroy();
    this.shared = null;
    this.instanceGroups.wires = null;
    this.instanceGroups.glyphs = null;
    this.instanceGroups.overlay = null;
  }

  /** Start building every pass against `shade` as the current build. */
  private run(shade: string, report: boolean): Promise<void> {
    const generation = ++this.generation;
    const outcome = this.build(shade).then(
      (pipelines) => {
        if (this.destroyed || generation !== this.generation) return;
        this.building = null;
        this.pipelines = pipelines;
        this.onPipelinesReady?.();
      },
      (cause: unknown) => {
        if (!this.destroyed && generation === this.generation) {
          this.building = null;
          if (report) {
            // A failed build is a shader bug or a bad host shade; the session stays alive and
            // frames keep skipping until a shade builds.
            console.error('diagram: failed to build the render pipelines', cause);
            this.onPipelineError?.(cause);
          }
        }
        throw cause;
      },
    );
    this.building = outcome;
    return outcome;
  }

  /** Every pass's pipeline against `shade`, reusing the unshaded ones once they built. */
  private async build(shade: string): Promise<Pipelines> {
    const shaded = this.compile(true, shade);
    if (!this.unshaded) {
      const pending = this.compile(false, DEFAULT_SHADE_WGSL);
      this.unshaded = pending;
      // A failed unshaded build is retried by the next shade rather than cached.
      pending.catch(() => {
        if (this.unshaded === pending) this.unshaded = null;
      });
    }
    const [withShade, withoutShade] = await Promise.all([shaded, this.unshaded]);
    const ordered: GPURenderPipeline[] = [];
    let a = 0;
    let b = 0;
    for (const pass of PASSES) ordered.push(pass.shaded ? withShade[a++]! : withoutShade[b++]!);
    return { shade, ordered };
  }

  /**
   * The pipelines of the shaded or the unshaded passes, in `PASSES` order. Every pipeline is
   * dispatched before the one await, so driver compilation overlaps.
   */
  private async compile(shaded: boolean, shade: string): Promise<readonly GPURenderPipeline[]> {
    const { device, format } = this.presentation;
    const passes = PASSES.filter((pass) => pass.shaded === shaded);
    const modules = passes.map((pass) =>
      device.createShaderModule({
        label: `diagram-${pass.name}`,
        code: passSource(pass.name, shade),
      }),
    );
    const pending = passes.map((pass, i) =>
      device.createRenderPipelineAsync({
        label: `diagram-${pass.name}`,
        layout: pass.instances ? this.instancedLayout : this.baseLayout,
        vertex: { module: modules[i]!, entryPoint: 'vs' },
        fragment: {
          module: modules[i]!,
          entryPoint: 'fs',
          targets: [{ format, blend: PREMULTIPLIED_OVER }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      }),
    );
    try {
      return await Promise.all(pending);
    } catch (cause) {
      throw await shaderFailure(modules, cause);
    }
  }

  /**
   * Bring a mirror's GPU buffer up to date: a new buffer holding its whole backing store and a
   * full upload when its version changed (or it outgrew the buffer), else one write per dirty
   * range; then clean it. Returns whether the buffer was replaced, so its bind group must be
   * rebuilt.
   */
  private upload(shadow: Shadow, whole: boolean): boolean {
    const { mirror } = shadow;
    const { device } = this.presentation;
    const used = mirror.words * 4;
    let replaced = false;
    if (!shadow.buffer || shadow.version !== mirror.version || shadow.bytes < used) {
      // Sized for the backing store, not the words in use: growth within capacity keeps the
      // version, so the buffer must already hold it.
      const bytes = align16(Math.max(mirror.capacity, mirror.words, MIN_WORDS) * 4);
      this.assertFits(mirror, bytes);
      const buffer = device.createBuffer({
        label: mirror.label,
        size: bytes,
        usage:
          (mirror.usage === 'uniform' ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
          GPUBufferUsage.COPY_DST,
      });
      shadow.buffer?.destroy();
      shadow.buffer = buffer;
      shadow.bytes = bytes;
      shadow.version = mirror.version;
      replaced = true;
      whole = true;
    }
    if (whole) {
      this.write(shadow.buffer, mirror, 0, mirror.words);
    } else {
      const ranges = mirror.dirtyRanges;
      for (let i = 0; i < mirror.dirtyCount; i++) {
        this.write(shadow.buffer, mirror, ranges[2 * i]!, ranges[2 * i + 1]!);
      }
    }
    mirror.clean();
    return replaced;
  }

  /** Copy a mirror's words `[from, to)` into its buffer at the same offset; nothing when empty. */
  private write(buffer: GPUBuffer, mirror: Mirror, from: number, to: number): void {
    const end = Math.min(to, mirror.words);
    if (end <= from) return;
    this.presentation.device.queue.writeBuffer(
      buffer,
      from * 4,
      mirror.u32.buffer,
      from * 4,
      (end - from) * 4,
    );
  }

  /** Upload an instance mirror and rebind its group 1 when its buffer was replaced. */
  private syncInstances(name: InstanceMirror): void {
    const shadow = this.shadows[name];
    if (!this.upload(shadow, false) && this.instanceGroups[name]) return;
    this.instanceGroups[name] = this.presentation.device.createBindGroup({
      label: `diagram-${name}-group`,
      layout: this.instanceLayout,
      entries: [{ binding: 0, resource: { buffer: shadow.buffer! } }],
    });
  }

  /**
   * Bring the atlas texture up to date: a new texture and a full upload when the atlas's version
   * or size changed, else its dirty rows; then clean it. Returns whether the texture was replaced.
   */
  private uploadAtlas(atlas: AtlasPixels): boolean {
    const { device } = this.presentation;
    // Never zero-sized: an empty atlas still binds a one-row texture.
    const width = Math.max(atlas.width, 1);
    const height = Math.max(atlas.height, 1);
    let replaced = false;
    let from = atlas.dirtyFrom;
    let to = atlas.dirtyTo;
    if (
      !this.atlasTexture ||
      this.atlasVersion !== atlas.version ||
      this.atlasWidth !== width ||
      this.atlasHeight !== height
    ) {
      const texture = device.createTexture({
        label: 'diagram atlas',
        size: [width, height],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.atlasTexture?.destroy();
      this.atlasTexture = texture;
      this.atlasVersion = atlas.version;
      this.atlasWidth = width;
      this.atlasHeight = height;
      replaced = true;
      from = 0;
      to = atlas.height;
    }
    from = Math.max(0, from);
    to = Math.min(to, atlas.height, Math.floor(atlas.pixels.length / Math.max(atlas.width, 1)));
    if (atlas.width > 0 && to > from) {
      device.queue.writeTexture(
        { texture: this.atlasTexture, origin: [0, from] },
        atlas.pixels as Uint8Array<ArrayBuffer>,
        { offset: from * atlas.width, bytesPerRow: atlas.width, rowsPerImage: to - from },
        [atlas.width, to - from],
      );
    }
    atlas.clean();
    return replaced;
  }

  /** Bind group 0 over the current buffers and textures. */
  private createSharedGroup(): GPUBindGroup {
    const { shadows } = this;
    return this.presentation.device.createBindGroup({
      label: 'diagram-shared-group',
      layout: this.sharedLayout,
      entries: [
        { binding: 0, resource: { buffer: shadows.uniforms.buffer! } },
        { binding: 1, resource: { buffer: shadows.structure.buffer! } },
        { binding: 2, resource: { buffer: shadows.layout.buffer! } },
        { binding: 3, resource: { buffer: shadows.channels.buffer! } },
        { binding: 4, resource: { buffer: shadows.focus.buffer! } },
        { binding: 5, resource: this.colormap.createView() },
        { binding: 6, resource: this.atlasTexture!.createView() },
        { binding: 7, resource: this.sampler },
      ],
    });
  }

  /** Instances a pass draws this frame; 0 skips it. */
  private instanceCount(name: PassName, counts: DrawCounts): number {
    const { mirrors } = this;
    switch (name) {
      case 'grid':
        return (mirrors.uniforms.u32[W_FLAGS]! & DISPLAY_GRID) !== 0 ? 1 : 0;
      case 'group':
        return whole(counts.groups);
      case 'wire':
        return Math.min(whole(counts.wires), Math.floor(mirrors.wires.words / WIRE_WORDS));
      case 'block':
        return whole(counts.blocks);
      case 'port':
        return whole(counts.ports);
      case 'glyph':
        return Math.min(whole(counts.glyphs), Math.floor(mirrors.glyphs.words / GLYPH_WORDS));
      case 'overlay':
        return Math.min(whole(counts.overlay), Math.floor(mirrors.overlay.words / OVERLAY_WORDS));
    }
  }

  /** Throws when a mirror's buffer would exceed the device's limits. */
  private assertFits(mirror: Mirror, bytes: number): void {
    const limits = this.presentation.device.limits as Partial<GPUSupportedLimits> | undefined;
    const binding =
      mirror.usage === 'uniform'
        ? limits?.maxUniformBufferBindingSize
        : limits?.maxStorageBufferBindingSize;
    if (binding !== undefined && bytes > binding) {
      throw new Error(
        `${mirror.label} needs ${bytes} bytes, over the device's ${mirror.usage} binding limit ${binding}`,
      );
    }
    const buffer = limits?.maxBufferSize;
    if (buffer !== undefined && bytes > buffer) {
      throw new Error(
        `${mirror.label} needs ${bytes} bytes, over the device's buffer limit ${buffer}`,
      );
    }
  }
}

/** A count as a non-negative integer; NaN and negatives draw nothing. */
function whole(count: number): number {
  return count > 0 ? Math.floor(count) : 0;
}

/** `bytes` rounded up to a multiple of 16. */
function align16(bytes: number): number {
  return Math.ceil(bytes / 16) * 16;
}

/**
 * The pipeline failure with every shader compilation error it can find attached, so a host shade
 * fault names its line. Line numbers count from the top of the assembled module.
 */
async function shaderFailure(modules: readonly GPUShaderModule[], cause: unknown): Promise<Error> {
  const lines: string[] = [];
  for (const module of modules) {
    const info = await module.getCompilationInfo?.();
    for (const message of info?.messages ?? []) {
      if (message.type === 'error') {
        lines.push(`${module.label}:${message.lineNum}:${message.linePos} ${message.message}`);
      }
    }
  }
  const detail =
    lines.length > 0 ? lines.join('\n') : cause instanceof Error ? cause.message : String(cause);
  return new Error(`diagram shader build failed:\n${detail}`, { cause });
}
