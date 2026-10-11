@group(0) @binding(0) var<uniform> u:Uniforms;
@group(0) @binding(1) var<storage,read> a:array<vec4f>;
@group(0) @binding(2) var<storage,read> b:array<vec4f>;
@group(0) @binding(3) var<storage,read> segments:array<vec4u>;
@group(0) @binding(4) var<storage,read_write> pieces:array<vec4u>;
/** The pieces past each curve's first that each curved draw took from its pool this frame. */
@group(0) @binding(5) var<storage,read_write> taken:array<atomic<u32>>;
/**
 * A curved draw: its segments and the first of them, whether they read dash prefixes (1) and run
 * straight (2), its first piece, the pieces it has room for, and the record it counts into.
 */
struct Curves { count:u32, first:u32, flags:u32, base:u32, capacity:u32, record:u32 }
@group(0) @binding(6) var<uniform> params:Curves;
/** Each curved draw's segments and room, which `finish` counts its pieces from. */
@group(0) @binding(7) var<storage,read> draws:array<vec2u>;
struct Indirect { vertices:u32, instances:u32, firstVertex:u32, firstInstance:u32 }
@group(0) @binding(8) var<storage,read_write> indirect:array<Indirect>;

/** A piece that draws nothing: its curve's, where none of the curve shows. */
const HIDDEN_PIECE=vec4u(0xffffffffu,0u,0u,0u);
const NONE=0xffffffffu;
/** How far a piece may stray from its curve on screen, in CSS pixels. */
const SAG_PX:f32=0.25;
/** The most pieces a curve draws in. */
const MOST_PIECES:u32=64u;
var<workgroup> starts:array<u32,64>;
var<workgroup> pool:u32;

fn curve_pixels(pair:mat2x3f)->f32 {
  let p=project_world(pair[0],u);let q=project_world(pair[1],u);
  let clip=stroke_clip(p,q);if(clip.x>clip.y){return 0.0;}
  let start=mix(p,q,clip.x);let end=mix(p,q,clip.y);
  return length((end.xy/end.w-start.xy/start.w)*u.view.xy*0.5);
}
/** The pieces a curve needs so none strays past SAG_PX: its angle against the globe's radius on screen. */
fn pieces_for(e:Ends)->u32 {
  let radius=projection_pixels(projectionOf(u))*57.295779513;
  return clamp(u32(ceil(curve_angle(e.a,e.b,u)*sqrt(radius/(8.0*SAG_PX)))),1u,MOST_PIECES);
}
/**
 * Whether any of a curve can show: its ends, placed as the prepare pass placed them, and for a curve
 * of several pieces a point past its middle, lie beyond no one side of the view. One piece strays
 * under SAG_PX from the line between its ends, which the margin holds.
 */
fn shows(e:Ends,ca:vec4f,cb:vec4f,steps:u32,straight:bool)->bool {
  var c=array<vec4f,3>(ca,cb,ca);
  if(steps>1u){
    // As far past the chord's middle again as the curve's middle: the curve lies within these three.
    let middle=curve_world(e,0.5,straight,u);
    c[2]=project_world(middle*2.0-(e.a+e.b)*0.5,u);
  }
  // A margin of 128 CSS pixels for widths, lanes, and comets.
  let pad=vec2f(1.0)+256.0/u.view.xy;
  for(var axis=0u;axis<2u;axis++){
    var above=true;var below=true;
    for(var i=0u;i<3u;i++){
      let p=c[i];let reach=p.w*pad[axis];
      above=above&&p.w>0.0&&p[axis]>reach;
      below=below&&p.w>0.0&&p[axis]< -reach;
    }
    if(above||below){return false;}
  }
  return true;
}
@compute @workgroup_size(64)
fn tessellate(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32) {
  let straight=(params.flags&2u)!=0u;
  let i=params.first+id.x;
  var e:Ends;var steps=0u;var split=NONE;
  if(id.x<params.count){
    let segment=segments[i];let ab=segment.x*5u;let bb=segment.y*5u;
    let x=a[ab+4u];let y=b[bb+4u];
    // Only a straight route reads its ends' longitudes and latitudes.
    if(straight){e=Ends(x.xyz,y.xyz,a[ab+1u].xy,b[bb+1u].xy);}
    else{e=Ends(x.xyz,y.xyz,vec2f(0.0),vec2f(0.0));}
    if(x.w>0.5&&y.w>0.5){steps=pieces_for(e);}
    if(steps>0u&&!shows(e,a[ab],b[bb],steps,straight)){steps=0u;}
    if(steps>0u){
      // A flat map's longitudes jump a turn where a curve crosses the antimeridian: it splits there.
      if(u.view.w<1.5){
        var previous=curve_world(e,0.0,straight,u).x;
        for(var s=1u;s<=steps;s++){let next=curve_world(e,f32(s)/f32(steps),straight,u).x;if(abs(next-previous)>180.0){split=s-1u;}previous=next;}
      }
    }
  }
  // Every segment owns its first piece; the rest come from its draw's pool, a workgroup at a time.
  starts[lane]=select(0u,steps-1u+select(0u,1u,split!=NONE),steps>0u);
  workgroupBarrier();
  if(lane==0u){
    var total=0u;for(var j=0u;j<64u;j++){let n=starts[j];starts[j]=total;total+=n;}
    pool=atomicAdd(&taken[params.record],total);
    // Once the pool is full, this workgroup's curves draw a piece each, still lifted onto the globe.
    if(pool+total>params.capacity-params.count){atomicSub(&taken[params.record],total);pool=NONE;}
  }
  workgroupBarrier();
  if(id.x>=params.count){return;}
  let own=params.base+id.x;
  if(steps==0u){pieces[own]=HIDDEN_PIECE;return;}
  let whole=pool==NONE;
  let n=select(steps,1u,whole);let cut=select(split,NONE,whole);
  var next=params.base+params.count+pool+starts[lane];
  var phase=0.0;
  for(var s=0u;s<n;s++){
    let t0=f32(s)/f32(n);let t1=f32(s+1u)/f32(n);
    let side=select(0u,1u,s==cut);
    var second=phase;var after=phase;
    if((params.flags&1u)!=0u){
      let p=curve_world(e,t0,straight,u);let q=curve_world(e,t1,straight,u);
      after+=curve_pixels(curve_segment(p,q,side,u));
      second=after;
      if(side>0u){after+=curve_pixels(curve_segment(p,q,2u,u));}
    }
    var at=own;if(s>0u){at=next;next++;}
    pieces[at]=vec4u(i,bitcast<u32>(t0),bitcast<u32>(t1),(bitcast<u32>(phase)&0xfffffffcu)|side);
    if(side>0u){pieces[next]=vec4u(i,bitcast<u32>(t0),bitcast<u32>(t1),(bitcast<u32>(second)&0xfffffffcu)|2u);next++;}
    phase=after;
  }
}
/** Each curved draw's pieces, as its indirect draw counts them; its pool empties for the next frame. */
@compute @workgroup_size(64)
fn finish(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&draws)){return;}
  let draw=draws[id.x];
  indirect[id.x]=Indirect(6u,draw.x+min(atomicLoad(&taken[id.x]),draw.y-draw.x),0u,0u);
  atomicStore(&taken[id.x],0u);
}
