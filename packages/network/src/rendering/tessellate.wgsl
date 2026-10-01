@group(0) @binding(0) var<uniform> u:Uniforms;
@group(0) @binding(1) var<storage,read> a:array<vec4f>;
@group(0) @binding(2) var<storage,read> b:array<vec4f>;
@group(0) @binding(3) var<storage,read> segments:array<vec4u>;
@group(0) @binding(4) var<storage,read_write> instances:array<vec4u>;
struct Indirect { vertices:u32,count:atomic<u32>,firstVertex:u32,firstInstance:u32 }
@group(0) @binding(5) var<storage,read_write> indirect:Indirect;
@group(0) @binding(6) var<uniform> params:vec4u;
var<workgroup> starts:array<u32,64>;
var<workgroup> groupBase:u32;
fn curve_pixels(pair:mat2x3f)->f32 {
  let p=project_world(pair[0],u);let q=project_world(pair[1],u);
  let clip=stroke_clip(p,q);if(clip.x>clip.y){return 0.0;}
  let start=mix(p,q,clip.x);let end=mix(p,q,clip.y);
  return length((end.xy/end.w-start.xy/start.w)*u.view.xy*0.5);
}
@compute @workgroup_size(64)
fn tessellate(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32) {
  let i=id.x;var x=vec4f(0.0);var y=vec4f(0.0);var steps=0u;var split=0xffffffffu;
  if(i<params.x){
    if(i==0u){indirect.vertices=6u;}
    let segment=segments[i];x=a[segment.x*5u+4u];y=b[segment.y*5u+4u];
    if(x.w>0.5&&y.w>0.5){
      steps=clamp(u32(ceil(curve_angle(x.xyz,y.xyz,u)*57.295779513)),1u,180u);
      if(u.view.w<1.5){
        var previous=curve_world(x.xyz,y.xyz,0.0,u).x;
        for(var s=1u;s<=steps;s++){let next=curve_world(x.xyz,y.xyz,f32(s)/f32(steps),u).x;if(abs(next-previous)>180.0){split=s-1u;}previous=next;}
      }
    }
  }
  starts[lane]=steps+select(0u,1u,split!=0xffffffffu);
  workgroupBarrier();
  // Compact one workgroup at a time, avoiding a global atomic for every edge.
  if(lane==0u){var total=0u;for(var j=0u;j<64u;j++){let count=starts[j];starts[j]=total;total+=count;}groupBase=atomicAdd(&indirect.count,total);}
  workgroupBarrier();
  let base=groupBase+starts[lane];
  var phase=0.0;
  for(var s=0u;s<steps;s++){
    let t0=f32(s)/f32(steps);let t1=f32(s+1u)/f32(steps);
    let side=select(0u,1u,s==split);
    var secondPhase=phase;var nextPhase=phase;
    if(params.y>0u){
      let p=curve_world(x.xyz,y.xyz,t0,u);let q=curve_world(x.xyz,y.xyz,t1,u);
      nextPhase+=curve_pixels(curve_segment(p,q,side,u));
      secondPhase=nextPhase;
      if(side>0u){nextPhase+=curve_pixels(curve_segment(p,q,2u,u));}
    }
    let out=base+s+select(0u,1u,s>split);
    let phaseBits=bitcast<u32>(phase)&0xfffffffcu;
    instances[out]=vec4u(i,bitcast<u32>(t0),bitcast<u32>(t1),phaseBits|side);
    if(side>0u){instances[out+1u]=vec4u(i,bitcast<u32>(t0),bitcast<u32>(t1),(bitcast<u32>(secondPhase)&0xfffffffcu)|2u);}
    phase=nextPhase;
  }
}
