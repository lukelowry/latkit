@group(0) @binding(0) var<uniform> u:Uniforms;
struct AxisVertex { @builtin(position) position:vec4f,@location(0) side:f32 }
@vertex fn axis_vertex(@builtin(vertex_index) v:u32)->AxisVertex {
  let corners=array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1));
  let c=corners[v];let north=vec3f(0.0,u.geo.y,u.geo.x)*1.25;
  let a=project_world(-north-vec3f(0,0,1),u);let b=project_world(north-vec3f(0,0,1),u);
  let delta=(b.xy/b.w-a.xy/a.w)*u.view.xy;
  let normal=vec2f(-delta.y,delta.x)/max(length(delta),0.001);
  var p=mix(a,b,c.x);p.x+=normal.x*c.y*2.0/u.view.x*p.w;p.y+=normal.y*c.y*2.0/u.view.y*p.w;
  var out:AxisVertex;out.position=p;out.side=c.y;return out;
}
@fragment fn axis_fragment(v:AxisVertex)->@location(0) vec4f {
  let alpha=(1.0-smoothstep(0.4,1.0,abs(v.side)))*0.65;return vec4f(vec3f(0.6,0.75,0.86)*alpha,alpha);
}
