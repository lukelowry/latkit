// A bank's rows written as drawn geometry: five vec4 per vertex, two per edge or path row.
// Each page fits one 256-byte uniform slot.
struct VertexPage {
  rows: u32,
  /** The output row of the page's first. */
  first: u32,
  /** The x and y the page's values are relative to, less the camera center. */
  origin: vec2f,
  /** The type's color, for rows without one. */
  color: vec4f,
  x: LatkitChannel,
  y: LatkitChannel,
  z: LatkitChannel,
  size: LatkitChannel,
  tint: LatkitChannel,
  visible: LatkitChannel,
  shade: LatkitChannel,
}
struct LinePage {
  rows: u32,
  first: u32,
  /** The type's color; a negative alpha colors each line by its ends. */
  color: vec4f,
  tint: LatkitChannel,
  width: LatkitChannel,
  visible: LatkitChannel,
  shade: LatkitChannel,
  dash: LatkitChannel,
}
@group(1) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(1) var<uniform> vertexPage: VertexPage;
@group(1) @binding(1) var<uniform> linePage: LinePage;
@group(1) @binding(2) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(64)
fn vertices(@builtin(global_invocation_id) id: vec3u) {
  let row=id.x; if (row>=vertexPage.rows) { return; }
  let out=(vertexPage.first+row)*5u;
  let x=channelNumber(vertexPage.x,row,0u); let y=channelNumber(vertexPage.y,row,0u);
  let placed=finiteValue(x) && finiteValue(y);
  let height=channelNumber(vertexPage.z,row,0u)*u.geo.z;
  var world=vec3f(x+vertexPage.origin.x,y+vertexPage.origin.y,height);
  var normal=vec3f(0.0,0.0,1.0);
  var facing=true;
  if(u.view.w>1.5){
    // Angles from the page origin, turned by the origin's own from the camera center.
    let lon0=vertexPage.origin.x*0.017453292519943295; let dlat0=vertexPage.origin.y*0.017453292519943295;
    let sinLat0=u.geo.x*cos(dlat0)+u.geo.y*sin(dlat0); let cosLat0=u.geo.y*cos(dlat0)-u.geo.x*sin(dlat0);
    let dl=x*0.017453292519943295; let lat=y*0.017453292519943295;
    let sl=sin(dl)*cos(lon0)+cos(dl)*sin(lon0);
    let cl=cos(dl)*cos(lon0)-sin(dl)*sin(lon0);
    let sa=sin(lat)*cosLat0+cos(lat)*sinLat0;
    let ca=cos(lat)*cosLat0-sin(lat)*sinLat0;
    let nx=ca*sl; let ny=sa*u.geo.y-ca*cl*u.geo.x;
    let nz=sa*u.geo.x+ca*cl*u.geo.y;
    world=vec3f(nx*(1.0+height),ny*(1.0+height),nz*(1.0+height)-1.0);
    let cy=-u.rotation.w*u.pose.y; let cz=1.0+u.rotation.z*u.pose.y;
    facing=dot(vec3f(nx,ny,nz),vec3f(-u.rotation.y*cy,u.rotation.x*cy,cz))>1.0;
    let absSl=sl*u.center.w+cl*u.center.z;
    let absCl=cl*u.center.w-sl*u.center.z;
    normal=vec3f(ca*absCl,sa,-ca*absSl);
  } else if(u.geo.w>0.5) {
    let lon=(x+vertexPage.origin.x+u.center.x)*0.017453292519943295;
    let lat=(y+vertexPage.origin.y+u.center.y)*0.017453292519943295;
    normal=vec3f(cos(lat)*cos(lon),sin(lat),-cos(lat)*sin(lon));
  }
  let visible=placed && facing && channelNumber(vertexPage.visible,row,0u)>0.0;
  let pos=project_world(world,u);
  var ground=world; if(u.view.w>1.5) { ground=(world+vec3f(0,0,1))/(1.0+height)-vec3f(0,0,1); } else { ground.z=0.0; }
  var c=channelColor(vertexPage.tint,row,0u,vertexPage.color); c=vec4f(c.rgb*daylight(normal,u),c.a);
  output[out]=pos;
  output[out+1u]=project_world(ground,u);
  output[out+2u]=c;
  output[out+3u]=vec4f(channelNumber(vertexPage.size,row,0u),channelNumber(vertexPage.shade,row,0u),bitcast<f32>(fieldRow(row)),select(0.0,1.0,visible));
  output[out+4u]=vec4f(world,select(0.0,1.0,placed));
}
/** Half its width, its shade, its row, and flags: 1 shown, 2 dashed. */
@compute @workgroup_size(64)
fn edges(@builtin(global_invocation_id) id: vec3u) {
  let row=id.x; if(row>=linePage.rows){return;}
  let out=(linePage.first+row)*2u;
  let flags=select(0u,1u,channelNumber(linePage.visible,row,0u)>0.0)|select(0u,2u,channelNumber(linePage.dash,row,0u)>0.0);
  output[out]=channelColor(linePage.tint,row,0u,linePage.color);
  output[out+1u]=vec4f(channelNumber(linePage.width,row,0u)*0.5,channelNumber(linePage.shade,row,0u),bitcast<f32>(fieldRow(row)),bitcast<f32>(flags));
}
