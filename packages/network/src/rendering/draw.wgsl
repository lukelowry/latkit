override NETWORK_CURVES:bool=false;
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage,read> a: array<vec4f>;
@group(0) @binding(2) var<storage,read> b: array<vec4f>;
@group(0) @binding(3) var<storage,read> segments: array<vec4u>;
@group(0) @binding(4) var<storage,read> styles: array<vec4f>;
/** The dense address of the bank's first row, its rows, and whether it reads dash phases. */
@group(0) @binding(5) var<uniform> item: vec4u;
@group(0) @binding(7) var<storage,read> focused:array<u32>;
@group(0) @binding(8) var<storage,read> curveInstances:array<vec4u>;
@group(0) @binding(9) var<storage,read> dashPhases:array<f32>;
struct Varying {
  @builtin(position) position:vec4f,
  @location(0) @interpolate(linear) uv:vec2f,
  @location(1) @interpolate(flat) dimensions:vec4f,
  @location(2) color:vec4f,
  @location(3) @interpolate(flat) identity:vec4u,
  @location(4) world:vec3f,
  /** Its shade, whether it lifts off the globe, how far along its edge it starts, and its opacity. */
  @location(5) @interpolate(flat) extra:vec4f,
  /** Each true end's place on screen and the marker radius it clears; a negative radius at a bend. */
  @location(6) @interpolate(flat) discA:vec3f,
  @location(7) @interpolate(flat) discB:vec3f,
  /** Its flow: speed, how far it has moved, and the comets' head radius, in CSS pixels. */
  @location(8) @interpolate(flat) flow:vec3f,
}
fn corner(v:u32)->vec2f {
  let c=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  return c[v];
}
/** Focus of a drawn row: 2 selected, 1 hovered; two bits per row, vertices then edges then paths. */
fn focus(dense:u32)->u32 {
  let word=dense>>4u;
  if(word>=arrayLength(&focused)){return 0u;}
  return (focused[word]>>((dense&15u)*2u))&3u;
}
/** How far a vertex has grown toward the hover scale, from 0 to 1. */
fn growth(dense:u32)->f32 {
  if(dense==u.grown.x){return u.growth.x;}
  if(dense==u.grown.y){return u.growth.y;}
  return 0.0;
}
fn screen(p:vec4f)->vec2f{return vec2f((p.x/p.w+1.0)*u.view.x*0.5,(1.0-p.y/p.w)*u.view.y*0.5);}
fn hidden()->Varying { var out:Varying;out.position=vec4f(2.0,2.0,2.0,1.0);return out; }
/** Where a shadow falls below what casts it, and how far past it it fades, in CSS pixels. */
const SHADOW_REACH:f32=10.0;
struct MarkerVarying {
  @builtin(position) position:vec4f,
  /** Where in the square, in CSS pixels from the vertex with y up. */
  @location(0) @interpolate(linear) p:vec2f,
  /** Its radius, its halo's width, and its opacity. */
  @location(1) @interpolate(flat) size:vec3f,
  @location(2) @interpolate(flat) color:vec4f,
  /** Its focus: 2 selected, 1 hovered. */
  @location(3) @interpolate(flat) focus:u32,
  @location(4) @interpolate(flat) shade:f32,
  @location(5) @interpolate(flat) inputs0:vec4f,
  @location(6) @interpolate(flat) inputs1:vec4f,
}
/** A vertex's square, reaching its halo and shadow; its marker decides what in it draws. */
@vertex fn marker_vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->MarkerVarying {
  var out:MarkerVarying;
  let base=i*5u;let p=a[base];let info=a[base+3u];
  if(info.w<=0.001||p.w<=0.0){out.position=vec4f(2.0,2.0,2.0,1.0);return out;}
  let dense=item.x+i;let f=focus(dense);
  let halo=select(select(0.0,u.halo.x,f==1u),u.halo.y,f==2u);
  let radius=max(0.1,info.x)*(1.0+(u.hoverScale-1.0)*growth(dense));
  // Its outline's own edge bounds it, as fill costs: an axis-aligned edge needs no margin to read smooth.
  let reach=radius+halo+select(0.0,SHADOW_REACH,u.shadows!=0u);
  let q=corner(v);
  out.position=p+vec4f(q.x*reach*2.0/u.view.x*p.w,q.y*reach*2.0/u.view.y*p.w,0.0,0.0);
  // A focused marker draws over its neighbors as it grows.
  if(f>0u){out.position.z=max(0.0,out.position.z-0.00002*p.w);}
  out.p=q*reach;out.size=vec3f(radius,halo,info.w);out.color=a[base+2u];out.focus=f;out.shade=info.y;
  let inputs=item.y*5u+i*2u;
  if(arrayLength(&a)>=inputs+2u){out.inputs0=a[inputs];out.inputs1=a[inputs+1u];}
  return out;
}
/**
 * The marker, a halo of the hover or selected color around its own outline, and its shadow below,
 * each antialiased by its distance in CSS pixels.
 */
@fragment fn marker_fragment(v:MarkerVarying)->PaintOut {
  let m=marker(markerFragment(v.p,v.size.x,v.color,u.background,v.inputs0,v.inputs1));
  var top=m;
  if(v.focus>0u){
    let tint=select(u.hoverColor,u.selectedColor,v.focus==2u);
    top=over(m,MarkerColor(tint,max(m.distance-v.size.y,-m.distance)));
  }
  let cover=top.color.a*coverage(top.distance);
  var shadow=0.0;
  if(u.shadows!=0u){
    let below=marker(markerFragment(v.p+vec2f(0.0,2.0),v.size.x,v.color,u.background,v.inputs0,v.inputs1));
    shadow=shadowAlpha(below.distance-v.size.y)*(1.0-cover);
  }
  let alpha=(cover+shadow)*v.size.z;
  if(alpha<=0.001){discard;}
  let color=shade(ShadeFragment(vec4f(top.color.rgb,1.0),v.position.xy/u.view.z,v.shade));
  var result:PaintOut;result.color=vec4f(color.rgb*cover*v.size.z,alpha);result.depth=v.position.z;
  return result;
}
@vertex fn edge_main(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Varying {
  var interval=vec2f(0.0,1.0);var split=0u;var phase=0.0;var primitive=i;
  if(NETWORK_CURVES){let instance=curveInstances[i];primitive=instance.x;interval=vec2f(bitcast<f32>(instance.y),bitcast<f32>(instance.z));split=instance.w&3u;phase=bitcast<f32>(instance.w&0xfffffffcu);}
  let segment=segments[primitive];
  var prefix=0.0;if(item.z>0u){prefix=dashPhases[primitive];}
  let ab=segment.x*5u;let bb=segment.y*5u;let es=segment.z*3u;
  var p=a[ab];var q=b[bb];let ai=a[ab+3u];let bi=b[bb+3u];
  let info=styles[es+1u];let motion=styles[es+2u];
  if(a[ab+4u].w<0.5||b[bb+4u].w<0.5||motion.w<=0.001){return hidden();}
  var wa=a[ab+4u].xyz;var wb=b[bb+4u].xyz;
  if(NETWORK_CURVES){
    let start=wa;wa=curve_world(start,wb,interval.x,u);wb=curve_world(start,wb,interval.y,u);
    let pair=curve_segment(wa,wb,split,u);wa=pair[0];wb=pair[1];
    p=project_world(wa,u);q=project_world(wb,u);
  }
  let clipping=stroke_clip(p,q);if(clipping.x>clipping.y){return hidden();}
  let start=p;p=mix(start,q,clipping.x);q=mix(start,q,clipping.y);
  let row=bitcast<u32>(info.z);let f=focus(item.x+segment.z);
  let halo=select(select(0.0,u.halo.z,f==1u),u.halo.w,f==2u);
  let width=info.x+halo;
  // A flowing line's quad reaches its comets' heads.
  let head=max(info.x*1.6,2.0);
  let flowing=motion.y!=0.0&&u.flowSpacingPx>0.0;
  let reach=select(width,max(width,head+1.0),flowing);
  let sa=screen(p);let sb=screen(q);let delta=sb-sa;let lengthPx=max(0.001,length(delta));
  // Earlier segments of a dashed edge, in world units, at this piece's own screen scale.
  phase+=prefix*lengthPx/max(length(wb-wa)*(clipping.y-clipping.x),0.000001);
  let dir=delta/lengthPx;let perpendicular=vec2f(-dir.y,dir.x);let c=corner(v);
  // Edges joining the same two vertices draw apart, each in its lane across the line between them.
  if(!NETWORK_CURVES&&motion.x!=0.0){
    let shift=perpendicular*motion.x*u.edgeSpacingPx;
    p.x+=shift.x*2.0/u.view.x*p.w;p.y-=shift.y*2.0/u.view.y*p.w;
    q.x+=shift.x*2.0/u.view.x*q.w;q.y-=shift.y*2.0/u.view.y*q.w;
  }
  let t=(c.x+1.0)*0.5;let offset=(dir*c.x+perpendicular*c.y)*reach;
  var pos=mix(p,q,t);
  pos.x+=offset.x*2.0/u.view.x*pos.w;pos.y-=offset.y*2.0/u.view.y*pos.w;
  var color=styles[es];if(color.a<0.0){color=(a[ab+2u]+b[bb+2u])*0.5;}
  var out:Varying;out.position=pos;out.uv=vec2f(mix(-reach,lengthPx+reach,t),c.y*reach);
  out.dimensions=vec4f(lengthPx,width,info.x,info.w);out.color=color;
  out.identity=vec4u(1u,row,f,0u);out.world=mix(wa,wb,mix(clipping.x,clipping.y,t));
  out.extra=vec4f(info.y,select(0.0,1.0,segment.w>0u||NETWORK_CURVES),phase,motion.w);
  // A marker at a true end hides the line under it, and comets fade before reaching it.
  let markerA=select(0.0,ai.x,u.markers!=0u);let markerB=select(0.0,bi.x,u.markers!=0u);
  out.discA=vec3f(sa,select(-1.0,markerA,ai.w>0.5&&interval.x==0.0));
  out.discB=vec3f(sb,select(-1.0,markerB,bi.w>0.5&&interval.y==1.0));
  out.flow=vec3f(select(0.0,motion.y,flowing),motion.z,head);
  return out;
}
@vertex fn pole_main(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Varying {
  let base=i*5u;let q=a[base];let info=a[base+3u];let world=a[base+4u].xyz;
  // The ground below: the sphere's surface on a globe, the plane otherwise.
  var ground=vec3f(world.xy,0.0);
  if(u.view.w>1.5){ground=normalize(world+vec3f(0.0,0.0,1.0))-vec3f(0.0,0.0,1.0);}
  let p=project_world(ground,u);
  if(info.w<=0.001||p.w<=0.0||q.w<=0.0){return hidden();}
  let sa=screen(p);let sb=screen(q);let d=sb-sa;let l=max(0.001,length(d));let n=vec2f(-d.y,d.x)/l;
  let c=corner(v);let t=(c.x+1.0)*0.5;var pos=mix(p,q,t);
  pos.x+=n.x*c.y*2.0/u.view.x*pos.w;pos.y-=n.y*c.y*2.0/u.view.y*pos.w;
  var out:Varying;out.position=pos;out.uv=vec2f(t*l,c.y);out.dimensions=vec4f(l,1.0,1.0,0.0);
  out.color=vec4f(a[base+2u].rgb,0.5);out.identity=vec4u(2u,bitcast<u32>(info.z),0u,0u);out.world=world;
  out.extra=vec4f(0.0,0.0,0.0,info.w);out.discA=vec3f(0.0,0.0,-1.0);out.discB=vec3f(0.0,0.0,-1.0);
  return out;
}
struct PaintOut { @location(0) color:vec4f, @builtin(frag_depth) depth:f32 }
/** How much of a comet covers a pixel `along` its line and `across` it, faded toward its tail. */
fn comet(along:f32,across:f32,row:u32,flow:vec3f,aa:f32)->f32 {
  let spacing=max(u.flowSpacingPx,1.0);
  // Each row's comets start at a place of its own, so lines never march in step.
  let m=along-flow.y+fract(f32(row)*0.618034)*spacing;
  let k=(m-spacing*floor(m/spacing)-spacing*0.5)*sign(flow.x);
  let tail=min(spacing*0.4,flow.z*8.0);let t=clamp(-k/tail,0.0,1.0);
  let d=length(vec2f(k-clamp(k,-tail,0.0),across))-flow.z*(1.0-0.5*t);
  let fade=1.0-t*t;
  return (1.0-smoothstep(-aa,aa,d))*fade;
}
/** Comets fade in from a true end, clear of its marker. */
fn clearOf(px:vec2f,end:vec3f)->f32 {
  if(end.z<0.0){return 1.0;}
  return smoothstep(end.z+1.0,end.z+8.0,distance(px,end.xy));
}
@fragment fn fragment_main(v:Varying)->PaintOut {
  let px=v.position.xy/u.view.z;
  var distanceTo=length(v.uv);
  var outer=1.0;var core=v.dimensions.z/v.dimensions.y;
  if(v.identity.x>0u){
    distanceTo=stroke_distance(v.uv,v.dimensions.x);
    outer=v.dimensions.y;core=v.dimensions.z;
    if(v.identity.x==1u){
      if(v.discA.z>0.0&&distance(px,v.discA.xy)<v.discA.z){discard;}
      if(v.discB.z>0.0&&distance(px,v.discB.xy)<v.discB.z){discard;}
      if(v.dimensions.w>0.0&&!stroke_dash(v.uv.x+v.extra.z,u.dashPeriodPx)){discard;}
    }
  }
  let aa=max(fwidth(distanceTo),0.01);
  let line=1.0-smoothstep(outer-aa,outer+aa,distanceTo);
  var lit=0.0;
  if(v.identity.x==1u&&v.flow.x!=0.0){
    lit=comet(v.uv.x+v.extra.z,v.uv.y,v.identity.y,v.flow,aa)*clearOf(px,v.discA)*clearOf(px,v.discB)*u.flowColor.a;
  }
  let alpha=max(line,lit);
  if(alpha<=0.001){discard;}
  var color=v.color;
  if(v.identity.z>0u){
    let tint=select(u.hoverColor,u.selectedColor,v.identity.z==2u);
    color=mix(color,tint,smoothstep(core-aa,core+aa,distanceTo)*tint.a);
  }
  color=vec4f(mix(color.rgb,u.flowColor.rgb,lit),mix(color.a,1.0,lit));
  color=shade(ShadeFragment(color,px,v.extra.x));
  var result:PaintOut;result.color=outputColor(color,alpha*v.extra.w);result.depth=v.position.z;
  if(u.view.w>1.5&&v.extra.y>0.5){
    let sphere=v.world+vec3f(0,0,1);let radius=length(sphere);
    let world=sphere*max(1.0,radius)/max(radius,0.000001)-vec3f(0,0,1);
    let clip=project_world(world,u);result.depth=clamp(clip.z/clip.w-0.0000001,0.0,1.0);
  }
  return result;
}
