override NETWORK_CURVES:bool=false;
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage,read> a: array<vec4f>;
@group(0) @binding(2) var<storage,read> b: array<vec4f>;
@group(0) @binding(3) var<storage,read> segments: array<vec4u>;
@group(0) @binding(4) var<storage,read> styles: array<vec4f>;
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
  @location(5) @interpolate(flat) extra:vec4f,
  @location(6) @interpolate(flat) discA:vec3f,
  @location(7) @interpolate(flat) discB:vec3f,
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
fn screen(p:vec4f)->vec2f{return vec2f((p.x/p.w+1.0)*u.view.x*0.5,(1.0-p.y/p.w)*u.view.y*0.5);}
fn hidden()->Varying { var out:Varying;out.position=vec4f(2.0,2.0,2.0,1.0);return out; }
@vertex fn vertex_main(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Varying {
  let base=i*5u;let p=a[base];let info=a[base+3u];
  if(info.w<0.5||p.w<=0.0){return hidden();}
  let row=bitcast<u32>(info.z);let f=focus(item.x+i);
  let halo=select(select(0.0,u.halo.x,f==1u),u.halo.y,f==2u);
  let radius=max(0.1,info.x)+halo;let q=corner(v);
  var out:Varying;
  out.position=p+vec4f(q.x*radius*2.0/u.view.x*p.w,q.y*radius*2.0/u.view.y*p.w,0.0,0.0);
  out.uv=q;out.dimensions=vec4f(1.0,radius,info.x,0.0);
  out.color=a[base+2u];out.identity=vec4u(0u,row,f,0u);out.world=a[base+4u].xyz;
  out.extra=vec4f(info.y,0.0,0.0,0.0);return out;
}
@vertex fn edge_main(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Varying {
  var interval=vec2f(0.0,1.0);var split=0u;var phase=0.0;var primitive=i;
  if(NETWORK_CURVES){let instance=curveInstances[i];primitive=instance.x;interval=vec2f(bitcast<f32>(instance.y),bitcast<f32>(instance.z));split=instance.w&3u;phase=bitcast<f32>(instance.w&0xfffffffcu);}
  let segment=segments[primitive];
  var prefix=0.0;if(item.z>0u){prefix=dashPhases[primitive];}
  let ab=segment.x*5u;let bb=segment.y*5u;let es=segment.z*2u;
  var p=a[ab];var q=b[bb];let ai=a[ab+3u];let bi=b[bb+3u];let info=styles[es+1u];
  if(a[ab+4u].w<0.5||b[bb+4u].w<0.5||info.w<0.5){return hidden();}
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
  let width=u.style.y+halo;
  let sa=screen(p);let sb=screen(q);let delta=sb-sa;let lengthPx=max(0.001,length(delta));
  // Earlier segments of a dashed edge, in world units, at this piece's own screen scale.
  phase+=prefix*lengthPx/max(length(wb-wa)*(clipping.y-clipping.x),0.000001);
  let dir=delta/lengthPx;let perpendicular=vec2f(-dir.y,dir.x);let c=corner(v);
  let t=(c.x+1.0)*0.5;let offset=(dir*c.x+perpendicular*c.y)*width;
  var pos=mix(p,q,t);
  pos.x+=offset.x*2.0/u.view.x*pos.w;pos.y-=offset.y*2.0/u.view.y*pos.w;
  var color=styles[es];if(color.a<0.0){color=(a[ab+2u]+b[bb+2u])*0.5;}
  var out:Varying;out.position=pos;out.uv=vec2f(mix(-width,lengthPx+width,t),c.y*width);
  out.dimensions=vec4f(lengthPx,width,u.style.y,info.x);out.color=color;
  out.identity=vec4u(1u,row,f,0u);out.world=mix(wa,wb,mix(clipping.x,clipping.y,t));
  out.extra=vec4f(info.y,select(0.0,1.0,segment.w>0u||NETWORK_CURVES),phase,0.0);
  out.discA=vec3f(sa,select(0.0,ai.x,u.style.w>0.5&&ai.w>0.5&&interval.x==0.0));
  out.discB=vec3f(sb,select(0.0,bi.x,u.style.w>0.5&&bi.w>0.5&&interval.y==1.0));return out;
}
@vertex fn pole_main(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Varying {
  let base=i*5u;let p=a[base+1u];let q=a[base];let info=a[base+3u];
  if(info.w<0.5||p.w<=0.0||q.w<=0.0){return hidden();}
  let sa=screen(p);let sb=screen(q);let d=sb-sa;let l=max(0.001,length(d));let n=vec2f(-d.y,d.x)/l;
  let c=corner(v);let t=(c.x+1.0)*0.5;var pos=mix(p,q,t);
  pos.x+=n.x*c.y*2.0/u.view.x*pos.w;pos.y-=n.y*c.y*2.0/u.view.y*pos.w;
  var out:Varying;out.position=pos;out.uv=vec2f(t*l,c.y);out.dimensions=vec4f(l,1.0,1.0,0.0);
  out.color=vec4f(a[base+2u].rgb,0.5);out.identity=vec4u(2u,bitcast<u32>(info.z),0u,0u);out.world=a[base+4u].xyz;return out;
}
struct PaintOut { @location(0) color:vec4f, @builtin(frag_depth) depth:f32 }
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
      if(v.dimensions.w>0.0&&!stroke_dash(v.uv.x+v.extra.z,u.style.z)){discard;}
    }
  }
  let aa=max(fwidth(distanceTo),0.01);let alpha=1.0-smoothstep(outer-aa,outer+aa,distanceTo);
  if(alpha<=0.001){discard;}
  var color=v.color;
  if(v.identity.z>0u){
    let tint=select(u.hoverColor,u.selectedColor,v.identity.z==2u);
    color=mix(color,tint,smoothstep(core-aa,core+aa,distanceTo)*tint.a);
  }
  color=shade(ShadeFragment(color,px,v.extra.x));
  var result:PaintOut;result.color=outputColor(color,alpha);result.depth=v.position.z;
  if(u.view.w>1.5&&v.extra.y>0.5){
    let sphere=v.world+vec3f(0,0,1);let radius=length(sphere);
    let world=sphere*max(1.0,radius)/max(radius,0.000001)-vec3f(0,0,1);
    let clip=project_world(world,u);result.depth=clamp(clip.z/clip.w-0.0000001,0.0,1.0);
  }
  return result;
}
