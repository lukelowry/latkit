struct Page {
  slots0: vec4u,
  slots1: vec4u,
  counts: vec4u,
  origin: vec4f,
  angles: vec4f,
  color: LatkitScale,
  size: LatkitScale,
  height: LatkitScale,
  raw: vec4f,
}
@group(1) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(1) var<uniform> page: Page;
@group(1) @binding(2) var<storage, read_write> output: array<vec4f>;

fn scalar(slot: u32, row: u32, fallback: f32) -> f32 {
  if (slot == 0xffffffffu || !fieldValid(slot, row, 0u)) { return fallback; }
  if (latkitFields.fields[slot].kind == 3u) { return select(0.0, 1.0, fieldBool(slot, row, 0u)); }
  let v = fieldFloat(slot, row, 0u, 0u);
  return select(fallback, v, finite(v));
}
fn raw_scalar(slot:u32,row:u32,origin:f32,fallback:f32)->f32{
  if(slot==0xffffffffu||!fieldValid(slot,row,0u)){return fallback;}
  if(latkitFields.fields[slot].kind==3u){return select(0.0,1.0,fieldBool(slot,row,0u));}
  let v=fieldFloat(slot,row,0u,0u);return select(fallback,v+origin,finite(v));
}
fn scaled(slot: u32, row: u32, scale: LatkitScale, fallback: f32) -> f32 {
  if (slot == 0xffffffffu) { return fallback; }
  return scaleMapped(fieldFloat(slot,row,0u,0u),fieldValid(slot,row,0u),scale,fallback);
}
fn color(row:u32, base:vec4f) -> vec4f {
  let t = scaled(page.slots1.x,row,page.color,-1.0);
  if (t < 0.0) { return base; }
  return colormapColor(t);
}
@compute @workgroup_size(64)
fn vertices(@builtin(global_invocation_id) id: vec3u) {
  let row=id.x; if (row>=page.counts.x) { return; }
  let out=(page.counts.y+row)*5u;
  let xs=page.slots0.x; let ys=page.slots0.y;
  let vector=page.counts.z==2u;
  let valid=fieldValid(xs,row,0u) && (vector || fieldValid(ys,row,0u));
  var x=scalar(xs,row,3.402823e38); var y=scalar(ys,row,3.402823e38);
  if(vector && valid) { y=fieldFloat(xs,row,0u,1u); }
  let height=scaled(page.slots0.w,row,page.height,0.0)*u.geo.z;
  var world=vec3f(x+page.origin.x,y+page.origin.y,height);
  var normal=vec3f(0.0,0.0,1.0);
  var facing=true;
  if(u.view.w>1.5){
    let dl=x*0.017453292519943295; let lat=y*0.017453292519943295;
    let sl=sin(dl)*page.origin.w+cos(dl)*page.origin.z;
    let cl=cos(dl)*page.origin.w-sin(dl)*page.origin.z;
    let sa=sin(lat)*page.angles.y+cos(lat)*page.angles.x;
    let ca=cos(lat)*page.angles.y-sin(lat)*page.angles.x;
    let nx=ca*sl; let ny=sa*u.geo.y-ca*cl*u.geo.x;
    let nz=sa*u.geo.x+ca*cl*u.geo.y;
    world=vec3f(nx*(1.0+height),ny*(1.0+height),nz*(1.0+height)-1.0);
    let cy=-u.rotation.w*u.pose.y; let cz=1.0+u.rotation.z*u.pose.y;
    facing=dot(vec3f(nx,ny,nz),vec3f(-u.rotation.y*cy,u.rotation.x*cy,cz))>1.0;
    let absSl=sl*u.center.w+cl*u.center.z;
    let absCl=cl*u.center.w-sl*u.center.z;
    normal=vec3f(ca*absCl,sa,-ca*absSl);
  } else if(u.geo.w>0.5) {
    let lon=(x+page.origin.x+u.center.x)*0.017453292519943295;
    let lat=(y+page.origin.y+u.center.y)*0.017453292519943295;
    normal=vec3f(cos(lat)*cos(lon),sin(lat),-cos(lat)*sin(lon));
  }
  let visible=page.counts.w==0u && valid && finite(x) && finite(y) && facing && raw_scalar(page.slots1.y,row,page.raw.x,1.0)>0.0;
  let pos=project_world(world,u);
  var ground=world; if(u.view.w>1.5) { ground=(world+vec3f(0,0,1))/(1.0+height)-vec3f(0,0,1); } else { ground.z=0.0; }
  var c=color(row,u.vertexColor); c=vec4f(c.rgb*daylight(normal,u),c.a);
  output[out]=pos;
  output[out+1u]=project_world(ground,u);
  output[out+2u]=c;
  output[out+3u]=vec4f(select(u.style.x*scaled(page.slots0.z,row,page.size,1.0),0.0,page.counts.w>0u),raw_scalar(page.slots1.z,row,page.raw.y,0.0),bitcast<f32>(fieldRow(row)),select(0.0,1.0,visible));
  output[out+4u]=vec4f(world,select(0.0,1.0,valid && finite(x) && finite(y)));
}
@compute @workgroup_size(64)
fn edges(@builtin(global_invocation_id) id: vec3u) {
  let row=id.x; if(row>=page.counts.x){return;}
  let out=(page.counts.y+row)*2u;
  output[out]=color(row,u.edgeColor);
  output[out+1u]=vec4f(raw_scalar(page.slots1.w,row,page.raw.z,0.0),raw_scalar(page.slots1.z,row,page.raw.y,0.0),
    bitcast<f32>(fieldRow(row)),select(0.0,1.0,raw_scalar(page.slots1.y,row,page.raw.x,1.0)>0.0));
}
