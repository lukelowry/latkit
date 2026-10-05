@group(0) @binding(0) var<uniform> u:Uniforms;
struct Background { @builtin(position) position:vec4f, @location(0) xy:vec2f }
@vertex fn background_vertex(@builtin(vertex_index) v:u32)->Background {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var out:Background;out.position=vec4f(p[v],0,1);out.xy=p[v];return out;
}
struct BackgroundOut { @location(0) color:vec4f, @builtin(frag_depth) depth:f32 }
@fragment fn background_fragment(v:Background)->BackgroundOut {
  var out:BackgroundOut;var color=u.surface;out.depth=0.999999;
  let globe=u.view.w>1.5;
  var world=vec3f(0.0);var normal=vec3f(0.0,0.0,1.0);
  let right=vec3f(u.rotation.x,u.rotation.y,0.0);
  let front=vec3f(u.rotation.y*u.rotation.w,-u.rotation.x*u.rotation.w,u.rotation.z);
  let eye=front*u.pose.y;
  let up=vec3f(-u.rotation.y*u.rotation.z,u.rotation.x*u.rotation.z,u.rotation.w);
  let direction=right*v.xy.x*u.view.x/(2.0*u.pose.x)+up*v.xy.y*u.view.y/(2.0*u.pose.x)-front*u.pose.y;
  if(globe){
    let hit=globePoint(v.xy,u);if(hit.w==0.0){discard;}world=hit.xyz;
    let n=world-vec3f(0,0,-1);let lat=n.y*u.geo.y+n.z*u.geo.x;
    let localX=n.z*u.geo.y-n.y*u.geo.x;
    normal=vec3f(localX*u.center.w-n.x*u.center.z,lat,-(localX*u.center.z+n.x*u.center.w));
    let clip=project_world(world,u);out.depth=clip.z/clip.w;
    color=vec4f(color.rgb*mix(u.surface.a,1.0,smoothstep(-u.pointer.w,u.pointer.w,dot(normal,u.sun.xyz))),1.0);
  } else {
    if(u.view.w<0.5){world=right*v.xy.x*u.view.x/(2.0*u.pose.x)+vec3f(-u.rotation.y,u.rotation.x,0)*v.xy.y*u.view.y/(2.0*u.pose.x);}
    else {if(abs(direction.z)<0.00001){discard;}let t=-eye.z/direction.z;if(t<0.0){discard;}world=eye+direction*t;}
  }
  if(u.flags.y>0u){
    var coord=world.xy+u.center.xy;var spacing=pow(10.0,floor(log2(80.0/u.pose.x)/log2(10.0)));
    if(globe){coord=vec2f(atan2(-normal.z,normal.x),asin(clamp(normal.y,-1.0,1.0)))*57.295779513;spacing=15.0;}
    let grid=abs(fract(coord/spacing-0.5)-0.5)/max(fwidth(coord/spacing),vec2f(0.000001));
    let line=1.0-min(min(grid.x,grid.y),1.0);color=vec4f(mix(color.rgb,u.grid.rgb,line*u.grid.a),1.0);
  }
  out.color=vec4f(color.rgb,1.0);return out;
}
