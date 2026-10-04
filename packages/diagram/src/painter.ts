import { kit, type Gpu, type RGBA, type TextLayout } from '@latkit/gpu';
import { intersects, labelBounds, itemSlots } from './scene.js';
import type { Values } from './values.js';
import type { Scene, Rect } from './scene.js';
import { STYLE_EFFECTS, type Style } from './config.js';
import type { DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { DragDraw } from './drag.js';

const PAINT_STYLE = (Object.keys(STYLE_EFFECTS) as (keyof Style)[]).filter(
  (key) => STYLE_EFFECTS[key] === 'paint',
);

interface Bank {
  bounds: Rect;
  origin: Point;
  data: kit.BufferData;
  count: number;
}
interface TextBank {
  bounds: Rect;
  maxSize: number;
  origin: Point;
  runs: readonly kit.TextRun[];
  anchors: kit.BufferData;
}
interface Geometry {
  banks: Bank[];
  text: TextBank[];
  focus: kit.BufferData;
  keys: ReadonlyMap<string, number>;
  states: Map<string, number>;
  paddingPx: number;
}
export interface Pipelines {
  shapes: GPURenderPipeline;
  text: GPURenderPipeline;
  grid: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}
export interface Overlay {
  readonly box?: readonly [number, number, number, number];
  readonly wire?: readonly Point[];
  readonly compatible?: readonly DiagramItem[];
  readonly target?: DiagramItem | null;
  readonly muted?: string;
  readonly invalid?: boolean;
}
/** What one frame draws. */
export interface DrawState {
  readonly scene: Scene;
  readonly values: Values;
  readonly style: Style;
  readonly camera: kit.Camera2D;
  /** Replaced whenever it changes. */
  readonly selection: readonly DiagramItem[];
  readonly hover: DiagramItem | null;
  readonly pipelines: Pipelines;
  /** The shade's uniforms for this frame. */
  readonly shade: GPUBufferBinding;
  readonly overlay: Overlay | null;
  /** A drag drawn over the scene: what it moves, how far, and its rerouted wires. */
  readonly drag: DragDraw | null;
  /** Flow animates; false under reduced motion. */
  readonly motion: boolean;
}
export interface Paint {
  pipelines: Pipelines;
  banks: { group: GPUBindGroup; count: number }[];
  text: { group: GPUBindGroup; pages: readonly kit.TextPage[] }[];
  grid: GPUBindGroup;
  msaa?: GPUTextureView;
  background: RGBA;
  drawCalls: number;
}
const shader = /* wgsl */ `
struct View {
  camera:vec4f, viewport:vec4f, grid:vec4f, selected:vec4f, hovered:vec4f, dots:vec4f,
  metrics:vec4f, background:vec4f, detail:vec4f,
  /** A drag's offset in diagram units, for items flagged as moving. */
  drag:vec4f, vertexColor:vec4f, edgeColor:vec4f
}
struct Item {
  position:vec4f, color:vec4f, outline:vec4f, style:vec4f, extra:vec4f,
  status:vec4f, marker:vec4f
}
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(2) var<storage,read> items:array<Item>;
@group(0) @binding(3) var<storage,read> focus:array<u32>;
/** Each label's position and the focus slot of the item it labels. */
@group(0) @binding(4) var<storage,read> anchors:array<vec4f>;
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) @interpolate(flat) index:u32, @location(2) @interpolate(flat) size:vec2f, @location(3) color:vec4f }
fn screen(p:vec2f)->vec2f { return (p+view.camera.xy)*view.camera.zw+view.viewport.xy*0.5; }
fn clip(p:vec2f)->vec4f { return vec4f(p/view.viewport.xy*vec2f(2.,-2.)+vec2f(-1.,1.),0.,1.); }
fn corner(v:u32)->vec2f { let c=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));return c[v]; }
fn aa(d:f32)->f32 { return clamp(0.5-d*view.viewport.z,0.,1.); }
fn width(item:Item)->f32 { return select(item.style.y,view.detail.w,item.style.y<0.); }
fn baseColor(c:vec4f)->vec4f { if(c.a>=0.){return c;} return select(view.vertexColor,view.edgeColor,c.x>0.5); }
fn chosen(color:vec4f)->vec4f { return select(view.selected,color,view.metrics.w!=0.); }
/** Moving items follow the drag; rerouted ones hide while their new wires draw. */
fn dragged(flags:u32)->vec2f { return select(vec2f(0.),view.drag.xy,(flags&64u)!=0u); }
fn hidden(i:u32)->Vertex { return Vertex(vec4f(2.,2.,2.,1.),vec2f(0.),i,vec2f(0.),vec4f(0.)); }
@vertex fn shape_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Vertex {
  let item=items[i];let c=corner(v);let kind=u32(item.style.x);
  let flags=focus[u32(item.style.w)];
  if((flags&128u)!=0u){return hidden(i);}
  let offset=dragged(flags);
  let pad=max(6.,max(view.metrics.y,view.metrics.z)+2.);
  if(kind==4u||kind==5u){
    let start=screen(item.position.xy+offset);let tip=screen(item.position.zw+offset);let delta=tip-start;let direction=delta/max(length(delta),0.0001);
    let b=tip-direction*select(0.,view.detail.z*0.5+3.,kind==5u);
    let a=select(start,b-direction*8.,kind==5u);
    let len=max(length(b-a),0.0001);let dir=direction;let normal=vec2f(-dir.y,dir.x);let width=select(width(item)*0.5+pad,10.+pad,kind==5u);
    let uv=vec2f(mix(-width,len+width,c.x),mix(-width,width,c.y));
    return Vertex(clip(a+dir*uv.x+normal*uv.y),uv,i,vec2f(len,width),vec4f(0.));
  }
  let a=screen(item.position.xy+offset);
  let extent=select(item.position.zw*abs(view.camera.zw),item.position.zw,kind>6u);
  let center=select(a+extent*vec2f(0.5,select(0.5,-0.5,view.camera.w<0.)),a,kind>=6u);
  let uv=(c*2.-1.)*(extent*0.5+vec2f(pad));
  return Vertex(clip(center+uv),uv,i,extent,vec4f(0.));
}
@fragment fn shape_fragment(v:Vertex)->@location(0) vec4f {
  let item=items[v.index];let kind=u32(item.style.x);var d=0.;var color=baseColor(item.color);
  let flags=focus[u32(item.style.w)];
  let selected=(flags&1u)!=0u;let hovered=(flags&2u)!=0u;
  let compatible=(flags&4u)!=0u;let targeted=(flags&8u)!=0u;
  let scale=min(abs(view.camera.z),abs(view.camera.w));
  var opacity=select(1.,0.22,(flags&32u)!=0u);
  if((flags&16u)!=0u){opacity*=0.8;}
  if(view.detail.x!=0. && (kind==5u||kind>=6u)){opacity*=smoothstep(0.2,0.55,scale);}
  if(kind==4u){
    let extra=select(select(0.,0.5,hovered),1.,selected||targeted);
    d=stroke_distance(v.uv,v.size.x)-width(item)*0.5-extra;
    if(item.style.z!=0.){
      let phase=v.uv.x+item.extra.x*scale-select(0.,view.viewport.w*item.style.z/1000.,view.grid.z!=0.);
      if(view.grid.z!=0. && fract(phase/14.)>0.62){discard;}
      if(view.grid.z==0.){
        let q=vec2f(fract(phase/18.)*18.-9.,abs(v.uv.y));
        d=min(d,max(abs(q.y+q.x*0.65)-0.8,max(-q.x-3.,q.x-3.)));
      }
    }
    if(hovered){color=mix(color,view.hovered,0.65);}
    if(selected||targeted){color=chosen(color);}
  }else if(kind==5u){
    let x=v.uv.x-v.size.x;d=max(abs(v.uv.y)+x*0.55,-x-8.);
    if(selected||targeted){color=chosen(color);}else if(hovered){color=view.hovered;}
  }else{
    let half=v.size*0.5;
    if(kind==6u){
      let normal=vec2f(item.marker.x,item.marker.y*sign(view.camera.w));
      let q=vec2f(dot(v.uv,normal),dot(v.uv,vec2f(-normal.y,normal.x)));
      if(item.marker.z==1.){
        d=max(abs(q.y)*0.894427+(q.x-half.x)*0.447214,-q.x-half.x);
      }else if(item.marker.z==2.){
        d=(abs(v.uv.x)+abs(v.uv.y)-half.x)*0.707107;
      }else{d=length(v.uv)-half.x;}
      if(item.extra.w==0.){color=mix(view.background,baseColor(item.color),smoothstep(-1.8,-0.8,d));}
    }else if(kind==2u||kind==7u){d=(length(v.uv/max(half,vec2f(0.001)))-1.)*min(half.x,half.y);}
    else if(kind==3u){d=(dot(abs(v.uv)/max(half,vec2f(0.001)),vec2f(1.))-1.)*min(half.x,half.y)*0.707107;}
    else{
      let radius=select(0.,min(item.extra.z*scale,min(half.x,half.y)),kind==0u);
      let q=abs(v.uv)-half+radius;d=length(max(q,vec2f(0.)))+min(max(q.x,q.y),0.)-radius;
    }
    if(kind<6u){color=mix(color,baseColor(item.outline),smoothstep(-view.metrics.x-0.65,-view.metrics.x+0.65,d));}
    if(item.status.a>0.){
      let ring=aa(abs(d+view.metrics.x+1.4)-1.);
      color=mix(color,item.status,ring*item.status.a);
    }
  }
  let shaded=shade(ShadeFragment(color,v.position.xy/view.viewport.z,item.extra.y));
  var result=outputColor(shaded,aa(d));
  var accent=view.hovered;var ring=0.;
  if(hovered){ring=0.35*(1.-smoothstep(0.,view.metrics.z,d));}
  if(compatible){accent=chosen(baseColor(item.color));ring=max(ring,0.28*(1.-smoothstep(0.,5.,d)));}
  if(selected||targeted){accent=chosen(baseColor(item.color));ring=max(ring,aa(d-view.metrics.y)*smoothstep(-0.5,0.5,d));}
  let halo=outputColor(accent,ring);
  result=result+halo*(1.-result.a);
  return result*opacity;
}
@vertex fn text_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Vertex {
  let t=textVertex(v,i);let anchor=anchors[t.anchor];let flags=focus[u32(anchor.z)];
  if((flags&128u)!=0u){return hidden(i);}
  return Vertex(clip(screen(t.position+anchor.xy+dragged(flags))),t.uv,i,vec2f(0.),t.color);
}
@fragment fn text_fragment(v:Vertex)->@location(0) vec4f {return textColor(v.uv,v.color)*smoothstep(4.,8.,view.grid.w*min(abs(view.camera.z),abs(view.camera.w)));}
@vertex fn grid_vertex(@builtin(vertex_index) v:u32)->Vertex {
  let p=vec2f(f32((v<<1u)&2u),f32(v&2u));return Vertex(vec4f(p*vec2f(2.,-2.)+vec2f(-1.,1.),0.,1.),p*view.viewport.xy,0u,vec2f(0.),vec4f(0.));
}
fn dots(world:vec2f, pitch:f32)->f32 {
  let q=abs(fract(world/pitch+0.5)-0.5)*pitch*abs(view.camera.zw);
  return 1.-smoothstep(0.4,1.15,length(q));
}
@fragment fn grid_fragment(v:Vertex)->@location(0) vec4f {
  if(view.grid.y==0.){discard;}
  let scale=min(abs(view.camera.z),abs(view.camera.w));
  let level=max(ceil(log2(view.detail.y/(view.grid.x*scale))/2.),0.);
  let pitch=view.grid.x*exp2(level*2.);
  let world=(v.uv-view.viewport.xy*0.5)/view.camera.zw-view.camera.xy;
  let fade=smoothstep(view.detail.y,view.detail.y*2.,pitch*scale);
  return outputColor(view.dots,max(dots(world,pitch)*fade*0.7,dots(world,pitch*4.)*0.7));
}
`;
function buffer(values: Float32Array, label: string): kit.BufferData {
  const b = new kit.BufferData({ size: Math.max(4, values.byteLength), label });
  if (values.length) b.write({ data: values });
  return b;
}
function sync(values: Float32Array, label: string, previous?: kit.BufferData): kit.BufferData {
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
function sameText(a: readonly kit.TextRun[], b: readonly kit.TextRun[]): boolean {
  return (
    a.length === b.length &&
    a.every((run, i) => {
      const next = b[i];
      return (
        run.text === next.text &&
        run.size === next.size &&
        run.anchor === next.anchor &&
        run.direction === next.direction &&
        run.position[0] === next.position[0] &&
        run.position[1] === next.position[1] &&
        run.font?.family === next.font?.family &&
        run.font?.weight === next.font?.weight &&
        run.font?.style === next.font?.style &&
        run.font?.revision === next.font?.revision &&
        (run.color === next.color ||
          (!!run.color && !!next.color && run.color.every((v, j) => v === next.color![j])))
      );
    })
  );
}
/** Build the pipelines for one target format, MSAA, and shade; the view caches each variant. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    V = GPUShaderStage.VERTEX,
    F = GPUShaderStage.FRAGMENT;
  const layout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, buffer: { type: 'uniform' } },
      { binding: 2, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: V, buffer: { type: 'read-only-storage' } },
    ],
  });
  const module = await gpu.shaderModule(
    kit.shadeShader({ group: 0, binding: 1 }) +
      kit.textShader({ group: 1 }) +
      kit.strokeShader() +
      kit.outputShader() +
      shader +
      shade,
    'diagram',
  );
  const pipe = (vertex: string, fragment: string, text = false) =>
    gpu.renderPipeline({
      layout: d.createPipelineLayout({
        bindGroupLayouts: text ? [layout, gpu.textLayout] : [layout],
      }),
      vertex: { module, entryPoint: vertex },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{ format, blend: kit.premultipliedBlend }],
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
export class Painter {
  private current?: { scene: Scene; values: Values; style: Style; geometry: Geometry };
  private focused?: {
    readonly geometry: Geometry;
    readonly selection: readonly DiagramItem[];
    readonly hover: DiagramItem | null;
    readonly overlay: Overlay | null;
    readonly drag: DragDraw['marks'] | null;
  };
  private readonly attachments: kit.Attachments;
  private dummy = buffer(new Float32Array(28), 'diagram empty');
  private gestureBuffer = buffer(new Float32Array(0), 'diagram gesture');
  private dragBuffer = buffer(new Float32Array(0), 'diagram drag');
  private dragAnchors = buffer(new Float32Array(0), 'diagram drag anchors');
  private emptyFocus = buffer(new Float32Array(1), 'diagram overlay focus');
  constructor(private readonly gpu: Gpu) {
    this.attachments = new kit.Attachments(gpu);
  }
  private build(scene: Scene, values: Values, options: Style, previous?: Geometry): Geometry {
    const keys = itemSlots(scene),
      banks: Bank[] = [],
      texts: TextBank[] = [];
    const records = new Float32Array(28 * 1024);
    let used = 0,
      origin: Point = [0, 0],
      paddingPx = 16;
    let bankBounds: number[] = [Infinity, Infinity, -Infinity, -Infinity];
    const flush = () => {
      if (used) {
        banks.push({
          origin,
          bounds: bankBounds as unknown as Rect,
          data: sync(
            records.subarray(0, used),
            'diagram instances',
            previous?.banks[banks.length]?.data,
          ),
          count: used / 28,
        });
        used = 0;
        bankBounds = [Infinity, Infinity, -Infinity, -Infinity];
      }
    };
    const add = (
      slot: number,
      p: readonly number[],
      color: RGBA,
      outline: RGBA,
      kind: number,
      width = 0,
      flow = 0,
      shade = 1,
      along = 0,
      radius = options.cornerRadius,
      status: RGBA = [0, 0, 0, 0],
      marker: readonly number[] = [0, 0, 0, 0],
      connected = true,
    ) => {
      if (kind === 4) paddingPx = Math.max(paddingPx, width / 2 + 2);
      if (used === records.length) flush();
      if (!used) origin = previous?.banks[banks.length]?.origin ?? [p[0], p[1]];
      const endX = kind === 4 || kind === 5 ? p[2] : p[0] + p[2],
        endY = kind === 4 || kind === 5 ? p[3] : p[1] + p[3];
      bankBounds[0] = Math.min(bankBounds[0], p[0], endX);
      bankBounds[1] = Math.min(bankBounds[1], p[1], endY);
      bankBounds[2] = Math.max(bankBounds[2], p[0], endX);
      bankBounds[3] = Math.max(bankBounds[3], p[1], endY);
      records[used] = p[0] - origin[0];
      records[used + 1] = p[1] - origin[1];
      records[used + 2] = kind === 4 || kind === 5 ? p[2] - origin[0] : p[2];
      records[used + 3] = kind === 4 || kind === 5 ? p[3] - origin[1] : p[3];
      records.set(color, used + 4);
      records.set(outline, used + 8);
      records[used + 12] = kind;
      records[used + 13] = width;
      records[used + 14] = flow;
      records[used + 15] = slot;
      records[used + 16] = along;
      records[used + 17] = shade;
      records[used + 18] = radius;
      records[used + 19] = +connected;
      records.set(status, used + 20);
      records.set(marker, used + 24);
      used += 28;
    };
    let textRuns: kit.TextRun[] = [],
      textOrigin: Point = [0, 0],
      textAnchors: number[] = [];
    let textBounds: number[] = [Infinity, Infinity, -Infinity, -Infinity],
      maxSize = 0;
    const flushText = () => {
      if (textRuns.length) {
        const old = previous?.text[texts.length];
        const runs = old && sameText(old.runs, textRuns) ? old.runs : textRuns;
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
    const text = (label: TextLayout, position: Point, slot: number) => {
      if (!options.labels || !label.runs.length) return;
      if (textRuns.length >= 256) flushText();
      if (!textRuns.length) textOrigin = previous?.text[texts.length]?.origin ?? position;
      textBounds[0] = Math.min(textBounds[0], position[0]);
      textBounds[1] = Math.min(textBounds[1], position[1]);
      textBounds[2] = Math.max(textBounds[2], position[0] + label.width);
      textBounds[3] = Math.max(textBounds[3], position[1] + label.height);
      for (const run of label.runs) maxSize = Math.max(maxSize, run.size);
      const anchor = textAnchors.length / 4;
      textAnchors.push(position[0] - textOrigin[0], position[1] - textOrigin[1], slot, 0);
      for (const run of label.runs) textRuns.push({ ...run, anchor });
    };
    for (const [groupIndex, group] of scene.groups.entries()) {
      const b = group.bounds;
      if (b[0] === b[2]) continue;
      const slot = scene.slots.groups + groupIndex;
      add(
        slot,
        [b[0], b[1], b[2] - b[0], b[3] - b[1]],
        options.groupColor,
        options.outlineColor,
        0,
      );
      text(group.label, [b[0] + options.vertexPadding, b[1] + options.vertexPadding], slot);
    }
    for (const [edgeIndex, edge] of scene.edges.entries())
      if (edge.visible && edge.paths.length) {
        const visual = values.items[scene.slots.edges + edgeIndex];
        for (let pathIndex = 0; pathIndex < edge.paths.length; pathIndex++) {
          const path = edge.paths[pathIndex];
          let along = edge.offsets[pathIndex] ?? 0;
          for (let i = 1; i < path.length; i++) {
            const a = path[i - 1],
              b = path[i];
            add(
              scene.slots.edges + edgeIndex,
              [...a, ...b],
              visual.color,
              visual.color,
              4,
              visual.width,
              visual.flow,
              visual.shade,
              along,
            );
            along += Math.hypot(b[0] - a[0], b[1] - a[1]);
          }
        }
        for (const arrow of edge.arrows) {
          const p = arrow.point,
            d = arrow.direction;
          add(
            scene.slots.edges + edgeIndex,
            [p[0] - d[0] * 10, p[1] - d[1] * 10, ...p],
            visual.color,
            visual.color,
            5,
            1,
            0,
            visual.shade,
          );
        }
        if (options.junctions)
          for (const p of edge.junctions)
            add(
              scene.slots.edges + edgeIndex,
              [p[0], p[1], 4, 4],
              visual.color,
              visual.color,
              7,
              0,
              0,
              visual.shade,
            );
      }
    for (const [edgeIndex, edge] of scene.edges.entries())
      if (edge.visible && edge.paths.length && options.labels && edge.label.runs.length) {
        const visual = values.items[scene.slots.edges + edgeIndex];
        for (const position of edge.labels) {
          const box = labelBounds(edge, position);
          add(
            scene.slots.edges + edgeIndex,
            [box[0], box[1], box[2] - box[0], box[3] - box[1]],
            options.background,
            edge.options.appearance === 'tag' ? visual.color : options.background,
            0,
          );
          text(edge.label, [box[0] + 3, box[1] + 3], scene.slots.edges + edgeIndex);
        }
      }
    for (const [vertexIndex, vertex] of scene.vertices.entries())
      if (vertex.visible) {
        const visual = values.items[vertexIndex];
        add(
          vertexIndex,
          [vertex.x, vertex.y, vertex.width, vertex.height],
          visual.color,
          options.outlineColor,
          ['rounded', 'rectangle', 'ellipse', 'diamond'].indexOf(vertex.shape),
          0,
          0,
          visual.shade,
          0,
          vertex.radius,
          visual.status,
        );
        text(
          vertex.label,
          [
            vertex.x + (vertex.width - vertex.label.width) / 2,
            vertex.options.labelPosition !== 'header'
              ? vertex.y + (vertex.height - vertex.label.height) / 2
              : vertex.y +
                (vertex.shape === 'diamond'
                  ? vertex.height / 4
                  : vertex.shape === 'ellipse'
                    ? (vertex.height * (1 - Math.SQRT1_2)) / 2
                    : 0) +
                options.vertexPadding +
                (vertex.ports.some((p) => p.side === 'top') ? options.fontSizePx * 1.5 : 0),
          ],
          vertexIndex,
        );
        for (const [portIndex, port] of vertex.ports.entries()) {
          const portVisual = values.items[vertex.portSlot + portIndex];
          const p = port.position,
            slot = vertex.portSlot + portIndex;
          add(
            slot,
            [p[0], p[1], options.portSize, options.portSize],
            portVisual.color,
            portVisual.color,
            6,
            0,
            0,
            visual.shade,
            0,
            0,
            portVisual.status,
            [
              port.normal[0] * (port.direction === 'in' ? -1 : 1),
              port.normal[1] * (port.direction === 'in' ? -1 : 1),
              port.marker === 'diamond'
                ? 2
                : port.marker === 'directional' && port.direction !== undefined
                  ? 1
                  : 0,
              0,
            ],
            port.connected,
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
                (vertex.shape === 'diamond'
                  ? ((port.label.width + 12) * vertex.height) / (2 * vertex.width)
                  : 0)
              : port.side === 'top'
                ? p[1] +
                  6 +
                  (vertex.shape === 'diamond'
                    ? ((port.label.width + 12) * vertex.height) / (2 * vertex.width)
                    : 0)
                : p[1] - port.label.height / 2;
          text(port.label, [left, top], slot);
        }
      }
    flush();
    flushText();
    const reuseFocus =
      previous &&
      previous.keys.size === keys.size &&
      [...keys].every(([key, index]) => previous.keys.get(key) === index);
    const focus = reuseFocus
      ? previous.focus
      : new kit.BufferData({ size: Math.max(4, keys.size * 4), label: 'diagram focus' });
    return {
      banks,
      text: texts,
      focus,
      keys,
      states: reuseFocus ? previous.states : new Map<string, number>(),
      paddingPx,
    };
  }
  async prepare(frame: kit.Preparation, state: DrawState): Promise<Paint> {
    const { scene, values, style: options, camera, pipelines, shade: effect, overlay } = state;
    let geometry =
      this.current?.scene === scene &&
      this.current.values === values &&
      PAINT_STYLE.every((key) => this.current!.style[key] === options[key])
        ? this.current.geometry
        : undefined;
    if (!geometry) {
      geometry = this.build(scene, values, options, this.current?.geometry);
      this.current = { scene, values, style: options, geometry };
    }
    this.focus(geometry, state);
    const focus = frame.buffer(geometry.focus),
      accent = options.selectedColor ?? options.hoverColor;
    const group = (
      origin: Point,
      data: kit.BufferData,
      anchors: kit.BufferData = this.dummy,
      textSize = 0,
      focusBuffer = focus,
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
        +state.motion,
        textSize,
        ...accent,
        ...options.hoverColor,
        ...options.gridColor,
        options.outlineWidthPx,
        options.selectedWidthPx,
        options.hoverWidthPx,
        +(options.selectedColor === null),
        ...options.background,
        +(options.detail === 'auto'),
        options.gridMinSpacingPx,
        options.portSize,
        options.edgeWidthPx,
        ...(state.drag?.delta ?? [0, 0]),
        0,
        0,
        ...options.vertexBaseColor,
        ...options.edgeBaseColor,
      );
      return this.gpu.device.createBindGroup({
        layout: pipelines.layout,
        entries: [
          { binding: 0, resource: frame.uniforms(uniforms) },
          { binding: 1, resource: effect },
          { binding: 2, resource: frame.buffer(data) },
          { binding: 3, resource: focusBuffer },
          { binding: 4, resource: frame.buffer(anchors) },
        ],
      });
    };
    const padding = Math.max(
      geometry.paddingPx,
      Math.max(values.maxWidth, options.edgeWidthPx) / 2 + 6,
      options.portSize / 2 + 6,
      options.hoverWidthPx + 2,
      options.selectedWidthPx + 2,
    );
    const dx = frame.viewport.width / (2 * camera.scale[0]) + padding / camera.scale[0],
      dy = frame.viewport.height / (2 * camera.scale[1]) + padding / camera.scale[1];
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
    /** The labels of rerouted wires, drawn where their new routes put them. */
    const dragText: { runs: kit.TextRun[]; anchors: number[]; maxSize: number } = {
      runs: [],
      anchors: [],
      maxSize: 0,
    };
    if (state.drag?.wires.length) {
      const records: number[] = [],
        origin = camera.center;
      const segment = (
        a: Point,
        b: Point,
        kind: number,
        color: RGBA,
        width: number,
        flow: number,
        along: number,
        shade: number,
      ) =>
        records.push(
          a[0] - origin[0],
          a[1] - origin[1],
          b[0] - origin[0],
          b[1] - origin[1],
          ...color,
          ...color,
          kind,
          width,
          flow,
          0,
          along,
          shade,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        );
      for (const { edge, paths, offsets, arrows } of state.drag.wires) {
        const visual = values.items[geometry.keys.get(itemKey(edge.hit))!];
        paths.forEach((path, j) => {
          let along = offsets[j] ?? 0;
          for (let i = 1; i < path.length; i++) {
            segment(
              path[i - 1],
              path[i],
              4,
              visual.color,
              visual.width,
              visual.flow,
              along,
              visual.shade,
            );
            along += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
          }
        });
        for (const { point: p, direction: d } of arrows)
          segment([p[0] - d[0] * 10, p[1] - d[1] * 10], p, 5, visual.color, 1, 0, 0, visual.shade);
        const label = edge.label;
        if (!options.labels || !label.runs.length || edge.options.appearance === 'tag') continue;
        // Above the middle of the route's longest segment, as layout first tries.
        let a: Point | undefined,
          b: Point | undefined,
          longest = -1;
        for (const path of paths)
          for (let i = 1; i < path.length; i++) {
            const length = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
            if (length > longest) [a, b, longest] = [path[i - 1], path[i], length];
          }
        if (!a || !b) continue;
        const x = (a[0] + b[0]) / 2 - label.width / 2,
          y = (a[1] + b[1]) / 2 - 4 - label.height;
        records.push(
          x - 3 - origin[0],
          y - 3 - origin[1],
          label.width + 6,
          label.height + 6,
          ...options.background,
          ...options.background,
          0,
          0,
          0,
          0,
          0,
          visual.shade,
          options.cornerRadius,
          1,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        );
        const anchor = dragText.anchors.length / 4;
        dragText.anchors.push(x - origin[0], y - origin[1], 0, 0);
        for (const run of label.runs) {
          dragText.runs.push({ ...run, anchor });
          dragText.maxSize = Math.max(dragText.maxSize, run.size);
        }
      }
      if (records.length)
        banks.unshift({
          group: group(
            origin,
            sync(Float32Array.from(records), 'diagram drag', this.dragBuffer),
            this.dummy,
            0,
            frame.buffer(this.emptyFocus),
          ),
          count: records.length / 28,
        });
    }
    if (overlay) {
      const records: number[] = [],
        origin = camera.center;
      const local = (p: Point): Point => [p[0] - origin[0], p[1] - origin[1]];
      const add = (p: readonly number[], kind: number, color: RGBA) =>
        records.push(
          ...p,
          ...color,
          ...accent,
          kind,
          1.5,
          kind === 4 ? 24 : 0,
          0,
          0,
          1,
          options.cornerRadius,
          1,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        );
      if (overlay.box) {
        const b = overlay.box;
        add([...local([b[0], b[1]]), b[2] - b[0], b[3] - b[1]], 1, [
          accent[0],
          accent[1],
          accent[2],
          0.12,
        ]);
      }
      if (overlay.wire)
        for (let i = 1; i < overlay.wire.length; i++)
          add(
            [...local(overlay.wire[i - 1]), ...local(overlay.wire[i])],
            4,
            overlay.invalid ? [0.95, 0.3, 0.24, 1] : accent,
          );
      if (records.length)
        banks.push({
          group: group(
            origin,
            sync(Float32Array.from(records), 'diagram gesture', this.gestureBuffer),
            this.dummy,
            0,
            frame.buffer(this.emptyFocus),
          ),
          count: records.length / 28,
        });
    }
    const text: { group: GPUBindGroup; pages: readonly kit.TextPage[] }[] = [];
    for (const bank of geometry.text)
      if (intersects(bank.bounds, visible) && bank.maxSize * Math.min(...camera.scale) >= 3)
        text.push({
          group: group(bank.origin, this.dummy, bank.anchors, bank.maxSize),
          pages: await frame.text({ runs: bank.runs }),
        });
    if (dragText.runs.length && dragText.maxSize * Math.min(...camera.scale) >= 3) {
      this.dragAnchors = sync(
        Float32Array.from(dragText.anchors),
        'diagram drag anchors',
        this.dragAnchors,
      );
      text.push({
        group: group(
          camera.center,
          this.dummy,
          this.dragAnchors,
          dragText.maxSize,
          frame.buffer(this.emptyFocus),
        ),
        pages: await frame.text({ runs: dragText.runs }),
      });
    }
    const msaa = this.attachments.prepare(frame, { msaa: options.msaa }).color;
    const gridLevel = Math.max(
      0,
      Math.ceil(
        Math.log(
          Math.max(1, options.gridMinSpacingPx / (options.gridPitch * Math.min(...camera.scale))),
        ) / Math.log(4),
      ),
    );
    const gridPeriod = options.gridPitch * 4 ** (gridLevel + 1);
    return {
      pipelines,
      banks,
      text,
      grid: group(
        [
          Math.floor(camera.center[0] / gridPeriod) * gridPeriod,
          Math.floor(camera.center[1] / gridPeriod) * gridPeriod,
        ],
        this.dummy,
      ),
      msaa,
      background: options.background,
      drawCalls: 1 + banks.length + text.reduce((n, b) => n + b.pages.length, 0),
    };
  }
  encode(frame: kit.Encoding, paint: Paint): void {
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: paint.msaa ?? frame.target,
          resolveTarget: paint.msaa ? frame.target : undefined,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: kit.clearColor(paint.background),
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
  /** Write each item's selection, hover, and gesture flags where they changed. */
  private focus(geometry: Geometry, state: DrawState): void {
    const { selection, hover, overlay } = state,
      drag = state.drag?.marks ?? null,
      last = this.focused;
    if (
      last?.geometry === geometry &&
      last.selection === selection &&
      last.hover === hover &&
      last.overlay === overlay &&
      last.drag === drag
    )
      return;
    this.focused = { geometry, selection, hover, overlay, drag };
    const states = new Map<string, number>();
    const flag = (key: string, bit: number) => states.set(key, (states.get(key) ?? 0) | bit);
    for (const item of selection) flag(itemKey(item), 1);
    if (hover && !overlay?.wire) flag(itemKey(hover), 2);
    for (const item of overlay?.compatible ?? []) flag(itemKey(item), 4);
    if (overlay?.target) flag(itemKey(overlay.target), 8);
    if (overlay?.muted) flag(overlay.muted, 32);
    for (const key of drag?.moving ?? []) flag(key, 64);
    for (const key of drag?.rerouted ?? []) flag(key, 128);
    const changed = new Set([...geometry.states.keys(), ...states.keys()]);
    const words = new Uint32Array(
      geometry.focus.bytes.buffer,
      geometry.focus.bytes.byteOffset,
      geometry.focus.size / 4,
    );
    for (const key of changed) {
      const id = geometry.keys.get(key);
      if (id !== undefined) {
        const value = states.get(key) ?? 0;
        if (words[id] !== value) {
          words[id] = value;
          geometry.focus.touch({ offset: id * 4, size: 4 });
        }
      }
    }
    geometry.states = states;
  }
  destroy(): void {
    this.attachments.destroy();
    this.current = undefined;
    this.focused = undefined;
  }
}
