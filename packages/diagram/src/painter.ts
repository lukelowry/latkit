import {
  BufferData,
  GpuError,
  defaultShade,
  shadeShader,
  textShader,
  strokeShader,
  outputShader,
  premultipliedBlend,
} from '@latkit/gpu';
import type {
  Gpu,
  Preparation,
  Encoding,
  Camera2D,
  RGBA,
  Shade,
  TextRun,
  TextPage,
  TextureResource,
} from '@latkit/gpu';
import { intersects } from './spatial.js';
import type { Scene, Label, Rect } from './scene.js';
import type { Options } from './options.js';
import type { DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';

interface Bank {
  bounds: Rect;
  origin: Point;
  data: BufferData;
  count: number;
}
interface TextBank {
  bounds: Rect;
  maxSize: number;
  origin: Point;
  runs: readonly TextRun[];
  anchors: BufferData;
}
interface Geometry {
  banks: Bank[];
  text: TextBank[];
  focus: BufferData;
  keys: Map<string, number>;
  selected: Set<string>;
  hover: string | null;
  paddingPx: number;
}
interface Pipelines {
  shapes: GPURenderPipeline;
  text: GPURenderPipeline;
  grid: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}
export interface Overlay {
  readonly box?: readonly [number, number, number, number];
  readonly wire?: readonly Point[];
}
export interface Paint {
  pipelines: Pipelines;
  banks: { group: GPUBindGroup; count: number }[];
  text: { group: GPUBindGroup; pages: readonly TextPage[] }[];
  grid: GPUBindGroup;
  msaa?: GPUTextureView;
  background: RGBA;
  drawCalls: number;
}
const shader = /* wgsl */ `
struct View { camera:vec4f, viewport:vec4f, grid:vec4f, selected:vec4f, hovered:vec4f, dots:vec4f }
struct Item { position:vec4f, color:vec4f, outline:vec4f, style:vec4f, extra:vec4f }
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(2) var<storage,read> items:array<Item>;
@group(0) @binding(3) var<storage,read> focus:array<u32>;
@group(0) @binding(4) var<storage,read> anchors:array<vec2f>;
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) @interpolate(flat) index:u32, @location(2) @interpolate(flat) size:vec2f, @location(3) color:vec4f }
fn screen(p:vec2f)->vec2f { return (p+view.camera.xy)*view.camera.zw+view.viewport.xy*0.5; }
fn clip(p:vec2f)->vec4f { return vec4f(p/view.viewport.xy*vec2f(2.,-2.)+vec2f(-1.,1.),0.,1.); }
fn corner(v:u32)->vec2f { let c=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));return c[v]; }
@vertex fn shape_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Vertex {
  let item=items[i];let c=corner(v);let kind=u32(item.style.x);
  if(kind==4u||kind==5u){
    let a=screen(item.position.xy);let b=screen(item.position.zw);let delta=b-a;let len=max(length(delta),0.0001);
    let dir=delta/len;let normal=vec2f(-dir.y,dir.x);let width=select(item.style.y*0.5+2.,7.,kind==5u);
    let uv=vec2f(mix(-width,len+width,c.x),mix(-width,width,c.y));
    return Vertex(clip(a+dir*uv.x+normal*uv.y),uv,i,vec2f(len,width),vec4f(0.));
  }
  let a=screen(item.position.xy);let extent=item.position.zw*abs(view.camera.zw);
  let uv=(c*2.-1.)*(extent*0.5+vec2f(2.));
  return Vertex(clip(a+extent*vec2f(0.5,select(0.5,-0.5,view.camera.w<0.))+uv),uv,i,extent,vec4f(0.));
}
@fragment fn shape_fragment(v:Vertex)->@location(0) vec4f {
  let item=items[v.index];let kind=u32(item.style.x);var d=0.;var color=item.color;
  let flags=focus[u32(item.style.w)];
  var outline=item.outline;
  if(flags==1u){outline=view.selected;}else if(flags==2u){outline=view.hovered;}
  if(kind==4u){
    d=stroke_distance(v.uv,v.size.x)-item.style.y*0.5;
    if(item.style.z!=0.&&view.grid.z!=0.){
      let phase=v.uv.x+item.extra.x*min(abs(view.camera.z),abs(view.camera.w))-view.viewport.w*item.style.z/1000.;
      if(fract(phase/16.)>0.6){discard;}
    }
    if(flags!=0u){color=outline;}
  }else if(kind==5u){
    let x=v.uv.x-v.size.x;d=max(abs(v.uv.y)+x*0.7,-x-9.);
    if(flags!=0u){color=outline;}
  }else{
    let half=v.size*0.5;
    if(kind==2u){d=(length(v.uv/max(half,vec2f(0.001)))-1.)*min(half.x,half.y);}
    else if(kind==3u){d=(dot(abs(v.uv)/max(half,vec2f(0.001)),vec2f(1.))-1.)*min(half.x,half.y)*0.707;}
    else{
      let radius=select(0.,min(5.*min(abs(view.camera.z),abs(view.camera.w)),min(half.x,half.y)),kind==0u);
      let q=abs(v.uv)-half+radius;d=length(max(q,vec2f(0.)))+min(max(q.x,q.y),0.)-radius;
    }
    color=mix(color,outline,smoothstep(-2.,-0.8,d));
  }
  let shaded=shade(ShadeFragment(color,v.position.xy/view.viewport.z,item.extra.y));
  return outputColor(shaded,1.-smoothstep(-0.75,0.75,d));
}
@vertex fn text_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Vertex {
  let t=textVertex(v,i);return Vertex(clip(screen(t.position+anchors[t.anchor])),t.uv,i,vec2f(0.),t.color);
}
@fragment fn text_fragment(v:Vertex)->@location(0) vec4f {return textColor(v.uv,v.color)*smoothstep(3.,8.,view.grid.w*min(abs(view.camera.z),abs(view.camera.w)));}
@vertex fn grid_vertex(@builtin(vertex_index) v:u32)->Vertex {
  let p=vec2f(f32((v<<1u)&2u),f32(v&2u));return Vertex(vec4f(p*vec2f(2.,-2.)+vec2f(-1.,1.),0.,1.),p*view.viewport.xy,0u,vec2f(0.),vec4f(0.));
}
@fragment fn grid_fragment(v:Vertex)->@location(0) vec4f {
  if(view.grid.y==0.){discard;}
  let spacing=view.grid.x*abs(view.camera.zw);if(min(spacing.x,spacing.y)<5.){discard;}
  let world=(v.uv-view.viewport.xy*0.5)/view.camera.zw-view.camera.xy;
  let q=abs(fract(world/view.grid.x+0.5)-0.5)*spacing;
  return outputColor(view.dots,1.-smoothstep(0.5,1.25,length(q)));
}
`;
function buffer(values: Float32Array, label: string): BufferData {
  const b = new BufferData({ size: Math.max(4, values.byteLength), label });
  if (values.length) b.write({ data: values });
  return b;
}
function sync(values: Float32Array, label: string, previous?: BufferData): BufferData {
  if (!previous) return buffer(values, label);
  previous.resize(Math.max(4, values.byteLength));
  const before = new Uint32Array(previous.bytes.buffer, previous.bytes.byteOffset, values.length);
  const after = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let start = -1;
  for (let i = 0; i <= after.length; i++) {
    if (i < after.length && before[i] !== after[i]) {
      if (start < 0) start = i;
      before[i] = after[i];
    } else if (start >= 0) {
      previous.touch({ offset: start * 4, size: (i - start) * 4 });
      start = -1;
    }
  }
  return previous;
}
export class Painter {
  animating = false;
  private variants = new Map<string, Promise<Pipelines>>();
  private current?: { scene: Scene; geometry: Geometry };
  private multisample?: TextureResource;
  private dummy = buffer(new Float32Array(20), 'diagram empty');
  constructor(private readonly gpu: Gpu) {}
  async pipelines(format: GPUTextureFormat, msaa: 1 | 4, shade: Shade | null): Promise<Pipelines> {
    const key = format + ':' + msaa + ':' + (shade?.wgsl ?? defaultShade);
    const existing = this.variants.get(key);
    if (existing) return existing;
    const task = this.compile(format, msaa, shade);
    this.variants.set(key, task);
    void task.catch(() => this.variants.delete(key));
    if (this.variants.size > 8) this.variants.delete(this.variants.keys().next().value!);
    return task;
  }
  private async compile(
    format: GPUTextureFormat,
    msaa: 1 | 4,
    shade: Shade | null,
  ): Promise<Pipelines> {
    const d = this.gpu.device,
      V = GPUShaderStage.VERTEX,
      F = GPUShaderStage.FRAGMENT;
    const layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, buffer: { type: 'uniform' } },
        { binding: 2, visibility: V | F, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    });
    const module = d.createShaderModule({
      label: 'diagram',
      code:
        shadeShader({ group: 0, binding: 1 }) +
        textShader({ group: 1 }) +
        strokeShader() +
        outputShader() +
        shader +
        (shade?.wgsl ?? defaultShade),
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw new GpuError(
        'invalid-input',
        errors.map((m) => m.lineNum + ': ' + m.message).join('\n'),
      );
    const pipe = (vertex: string, fragment: string, text = false) =>
      this.gpu.renderPipeline({
        layout: d.createPipelineLayout({
          bindGroupLayouts: text ? [layout, this.gpu.textLayout] : [layout],
        }),
        vertex: { module, entryPoint: vertex },
        fragment: {
          module,
          entryPoint: fragment,
          targets: [{ format, blend: premultipliedBlend }],
        },
        primitive: { topology: 'triangle-list' },
        multisample: { count: msaa },
      });
    const [shapes, text, grid] = await Promise.all([
      pipe('shape_vertex', 'shape_fragment'),
      pipe('text_vertex', 'text_fragment', true),
      pipe('grid_vertex', 'grid_fragment'),
    ]);
    return { shapes, text, grid, layout };
  }
  private build(scene: Scene, options: Required<Options>, previous?: Geometry): Geometry {
    const keys = new Map<string, number>(),
      banks: Bank[] = [],
      texts: TextBank[] = [];
    let records: number[] = [],
      origin: Point = [0, 0],
      paddingPx = 16;
    let bankBounds: number[] = [Infinity, Infinity, -Infinity, -Infinity];
    const index = (item: DiagramItem) => {
      const key = itemKey(item);
      let id = keys.get(key);
      if (id === undefined) {
        id = keys.size;
        keys.set(key, id);
      }
      return id;
    };
    const flush = () => {
      if (records.length) {
        banks.push({
          origin,
          bounds: bankBounds as unknown as Rect,
          data: sync(
            Float32Array.from(records),
            'diagram instances',
            previous?.banks[banks.length]?.data,
          ),
          count: records.length / 20,
        });
        records = [];
        bankBounds = [Infinity, Infinity, -Infinity, -Infinity];
      }
    };
    const add = (
      item: DiagramItem,
      p: readonly number[],
      color: RGBA,
      outline: RGBA,
      kind: number,
      width = 0,
      flow = 0,
      shade = 1,
      along = 0,
    ) => {
      if (kind === 4) paddingPx = Math.max(paddingPx, width / 2 + 2);
      if (records.length >= 20 * 1024) flush();
      if (!records.length) origin = previous?.banks[banks.length]?.origin ?? [p[0], p[1]];
      const endX = kind >= 4 ? p[2] : p[0] + p[2],
        endY = kind >= 4 ? p[3] : p[1] + p[3];
      bankBounds[0] = Math.min(bankBounds[0], p[0], endX);
      bankBounds[1] = Math.min(bankBounds[1], p[1], endY);
      bankBounds[2] = Math.max(bankBounds[2], p[0], endX);
      bankBounds[3] = Math.max(bankBounds[3], p[1], endY);
      const pos =
        kind >= 4
          ? [p[0] - origin[0], p[1] - origin[1], p[2] - origin[0], p[3] - origin[1]]
          : [p[0] - origin[0], p[1] - origin[1], p[2], p[3]];
      records.push(
        ...pos,
        ...color,
        ...outline,
        kind,
        width,
        flow,
        index(item),
        along,
        shade,
        0,
        0,
      );
    };
    let textRuns: TextRun[] = [],
      textOrigin: Point = [0, 0],
      textAnchors: number[] = [];
    let textBounds: number[] = [Infinity, Infinity, -Infinity, -Infinity],
      maxSize = 0;
    const flushText = () => {
      if (textRuns.length) {
        const old = previous?.text[texts.length];
        const runs =
          old && JSON.stringify(old.runs) === JSON.stringify(textRuns) ? old.runs : textRuns;
        texts.push({
          origin: textOrigin,
          bounds: textBounds as unknown as Rect,
          maxSize,
          runs,
          anchors: sync(Float32Array.from(textAnchors), 'diagram text anchors', old?.anchors),
        });
        textRuns = [];
        textAnchors = [];
        textBounds = [Infinity, Infinity, -Infinity, -Infinity];
        maxSize = 0;
      }
    };
    const text = (label: Label, position: Point) => {
      if (!options.labels || !label.runs.length) return;
      if (textRuns.length >= 256) flushText();
      if (!textRuns.length) textOrigin = previous?.text[texts.length]?.origin ?? position;
      textBounds[0] = Math.min(textBounds[0], position[0]);
      textBounds[1] = Math.min(textBounds[1], position[1]);
      textBounds[2] = Math.max(textBounds[2], position[0] + label.width);
      textBounds[3] = Math.max(textBounds[3], position[1] + label.height);
      for (const run of label.runs) maxSize = Math.max(maxSize, run.size);
      const anchor = textAnchors.length / 2;
      textAnchors.push(position[0] - textOrigin[0], position[1] - textOrigin[1]);
      for (const run of label.runs) textRuns.push({ ...run, anchor });
    };
    for (const group of scene.groups) {
      const b = group.bounds;
      if (b[0] === b[2]) continue;
      const item: DiagramItem = { kind: 'group', id: group.id };
      add(
        item,
        [b[0], b[1], b[2] - b[0], b[3] - b[1]],
        options.groupColor,
        options.outlineColor,
        0,
      );
      text(group.label, [b[0] + options.nodePadding, b[1] + options.nodePadding]);
    }
    for (const edge of scene.edges)
      if (edge.visible && edge.paths.length) {
        let along = 0;
        for (const path of edge.paths)
          for (let i = 1; i < path.length; i++) {
            const a = path[i - 1],
              b = path[i];
            add(
              edge.hit,
              [...a, ...b],
              edge.color,
              edge.color,
              4,
              edge.width,
              edge.flow,
              edge.shade,
              along,
            );
            along += Math.hypot(b[0] - a[0], b[1] - a[1]);
          }
        for (const arrow of edge.arrows) {
          const p = arrow.point,
            d = arrow.direction;
          add(
            edge.hit,
            [p[0] - d[0] * 10, p[1] - d[1] * 10, ...p],
            edge.color,
            edge.color,
            5,
            1,
            0,
            edge.shade,
          );
        }
        if (options.junctions)
          for (const p of edge.junctions)
            add(edge.hit, [p[0] - 2, p[1] - 2, 4, 4], edge.color, edge.color, 2, 0, 0, edge.shade);
        if (edge.options.appearance === 'tag')
          for (const path of edge.paths) {
            const p = path.at(-1)!;
            add(
              edge.hit,
              [p[0], p[1] - edge.label.height - 3, edge.label.width + 6, edge.label.height + 6],
              options.backgroundColor,
              edge.color,
              0,
            );
            text(edge.label, [p[0] + 3, p[1] - edge.label.height]);
          }
        else text(edge.label, [edge.anchor[0] + 4, edge.anchor[1] - edge.label.height - 4]);
      }
    for (const node of scene.nodes)
      if (node.visible) {
        add(
          node.hit,
          [node.x, node.y, node.width, node.height],
          node.color,
          node.status ?? options.outlineColor,
          ['rounded', 'rectangle', 'ellipse', 'diamond'].indexOf(node.shape),
          0,
          0,
          node.shade,
        );
        text(node.label, [
          node.x + (node.width - node.label.width) / 2,
          node.y +
            (node.shape === 'diamond'
              ? node.height / 4
              : node.shape === 'ellipse'
                ? (node.height * (1 - Math.SQRT1_2)) / 2
                : 0) +
            options.nodePadding +
            (node.ports.some((p) => p.side === 'top') ? options.fontSizePx * 1.5 : 0),
        ]);
        for (const port of node.ports) {
          const p = port.position;
          add(
            { ...node.hit, kind: 'port', port: port.name },
            [p[0] - 3.5, p[1] - 3.5, 7, 7],
            port.color,
            port.status ?? port.color,
            2,
          );
          const left =
            port.side === 'right'
              ? p[0] - port.label.width - 8
              : port.side === 'left'
                ? p[0] + 8
                : p[0] - port.label.width / 2;
          const top =
            port.side === 'bottom'
              ? p[1] -
                port.label.height -
                6 -
                (node.shape === 'diamond'
                  ? ((port.label.width + 12) * node.height) / (2 * node.width)
                  : 0)
              : port.side === 'top'
                ? p[1] +
                  6 +
                  (node.shape === 'diamond'
                    ? ((port.label.width + 12) * node.height) / (2 * node.width)
                    : 0)
                : p[1] - port.label.height / 2;
          text(port.label, [left, top]);
        }
      }
    flush();
    flushText();
    const focus = new BufferData({ size: Math.max(4, keys.size * 4), label: 'diagram focus' });
    return { banks, text: texts, focus, keys, selected: new Set(), hover: null, paddingPx };
  }
  async prepare(
    frame: Preparation,
    scene: Scene,
    options: Required<Options>,
    camera: Camera2D,
    selected: readonly DiagramItem[],
    hover: DiagramItem | null,
    shade: Shade | null,
    pointer: Point | null,
    overlay: Overlay | null = null,
  ): Promise<Paint> {
    const pipelines = await this.pipelines(frame.format, options.msaa, shade);
    let geometry = this.current?.scene === scene ? this.current.geometry : undefined;
    if (!geometry) {
      geometry = this.build(scene, options, this.current?.geometry);
      this.current = { scene, geometry };
    }
    const next = new Set(selected.map(itemKey)),
      hoverKey = hover ? itemKey(hover) : null;
    const changed = new Set([
      ...geometry.selected,
      ...next,
      ...(geometry.hover ? [geometry.hover] : []),
      ...(hoverKey ? [hoverKey] : []),
    ]);
    const words = new Uint32Array(
      geometry.focus.bytes.buffer,
      geometry.focus.bytes.byteOffset,
      geometry.focus.size / 4,
    );
    for (const key of changed) {
      const id = geometry.keys.get(key);
      if (id !== undefined) {
        const value = next.has(key) ? 1 : key === hoverKey ? 2 : 0;
        if (words[id] !== value) {
          words[id] = value;
          geometry.focus.touch({ offset: id * 4, size: 4 });
        }
      }
    }
    geometry.selected = next;
    geometry.hover = hoverKey;
    const parameters = new Float32Array(64);
    this.animating =
      shade?.tick?.(parameters, {
        timeMs: frame.timeMs,
        pointerPx: pointer,
        viewport: frame.viewport,
      }) ?? false;
    const effect = frame.shade({ parameters, pointerPx: pointer }),
      focus = frame.buffer(geometry.focus);
    const group = (
      origin: Point,
      data: BufferData,
      anchors: BufferData = this.dummy,
      textSize = 0,
    ) => {
      const uniforms = Float32Array.of(
        origin[0] - camera.center[0],
        origin[1] - camera.center[1],
        camera.scale[0],
        camera.scale[1] * (camera.yDirection === 'down' ? 1 : -1),
        frame.viewport.width,
        frame.viewport.height,
        frame.viewport.pixelRatio,
        frame.timeMs,
        options.gridPitch,
        +options.grid,
        +(options.motion !== 'reduce'),
        textSize,
        ...options.selectedColor,
        ...options.hoverColor,
        ...options.gridColor,
      );
      return this.gpu.device.createBindGroup({
        layout: pipelines.layout,
        entries: [
          { binding: 0, resource: frame.uniforms(uniforms) },
          { binding: 1, resource: effect },
          { binding: 2, resource: frame.buffer(data) },
          { binding: 3, resource: focus },
          { binding: 4, resource: frame.buffer(anchors) },
        ],
      });
    };
    const dx = frame.viewport.width / (2 * camera.scale[0]) + geometry.paddingPx / camera.scale[0],
      dy = frame.viewport.height / (2 * camera.scale[1]) + geometry.paddingPx / camera.scale[1];
    const visible: Rect = [
      camera.center[0] - dx,
      camera.center[1] - dy,
      camera.center[0] + dx,
      camera.center[1] + dy,
    ];
    const banks = geometry.banks
      .filter((bank) => intersects(bank.bounds, visible))
      .map((bank) => ({
        group: group(bank.origin, bank.data),
        count: bank.count,
      }));
    if (overlay) {
      const records: number[] = [],
        origin = camera.center;
      const local = (p: Point): Point => [p[0] - origin[0], p[1] - origin[1]];
      const add = (p: readonly number[], kind: number, color: RGBA) =>
        records.push(...p, ...color, ...options.selectedColor, kind, 2, 0, 0, 0, 1, 0, 0);
      if (overlay.box) {
        const b = overlay.box;
        add([...local([b[0], b[1]]), b[2] - b[0], b[3] - b[1]], 1, [
          options.selectedColor[0],
          options.selectedColor[1],
          options.selectedColor[2],
          0.12,
        ]);
      }
      if (overlay.wire)
        for (let i = 1; i < overlay.wire.length; i++)
          add([...local(overlay.wire[i - 1]), ...local(overlay.wire[i])], 4, options.selectedColor);
      if (records.length)
        banks.push({
          group: group(origin, buffer(Float32Array.from(records), 'diagram gesture')),
          count: records.length / 20,
        });
    }
    const text: { group: GPUBindGroup; pages: readonly TextPage[] }[] = [];
    for (const bank of geometry.text)
      if (intersects(bank.bounds, visible) && bank.maxSize * Math.min(...camera.scale) >= 3)
        text.push({
          group: group(bank.origin, this.dummy, bank.anchors, bank.maxSize),
          pages: await frame.text({ runs: bank.runs }),
        });
    let msaa: GPUTextureView | undefined;
    if (options.msaa === 4) {
      const t = this.multisample?.texture;
      if (!t || t.width !== frame.width || t.height !== frame.height || t.format !== frame.format) {
        this.multisample?.destroy();
        this.multisample = this.gpu.texture({
          size: [frame.width, frame.height],
          format: frame.format,
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      msaa = frame.texture(this.multisample!).createView();
    }
    return {
      pipelines,
      banks,
      text,
      grid: group(
        [
          Math.floor(camera.center[0] / options.gridPitch) * options.gridPitch,
          Math.floor(camera.center[1] / options.gridPitch) * options.gridPitch,
        ],
        this.dummy,
      ),
      msaa,
      background: options.backgroundColor,
      drawCalls: 1 + banks.length + text.reduce((n, b) => n + b.pages.length, 0),
    };
  }
  encode(frame: Encoding, paint: Paint): void {
    const color = paint.background;
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: paint.msaa ?? frame.target,
          resolveTarget: paint.msaa ? frame.target : undefined,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]],
        },
      ],
    });
    pass.setPipeline(paint.pipelines.grid);
    pass.setBindGroup(0, paint.grid);
    pass.draw(3);
    pass.setPipeline(paint.pipelines.shapes);
    for (const bank of paint.banks) {
      pass.setBindGroup(0, bank.group);
      pass.draw(6, bank.count);
    }
    pass.setPipeline(paint.pipelines.text);
    for (const bank of paint.text) {
      pass.setBindGroup(0, bank.group);
      for (const page of bank.pages) {
        pass.setBindGroup(1, page.bindGroup);
        pass.draw(6, page.count);
      }
    }
    pass.end();
  }
  destroy(): void {
    this.multisample?.destroy();
    this.variants.clear();
    this.current = undefined;
  }
}
