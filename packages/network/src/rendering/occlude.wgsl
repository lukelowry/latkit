@group(0) @binding(0) var<uniform> u:Uniforms;
struct Occluder { @builtin(position) position:vec4f, @location(0) ndc:vec2f }
@vertex fn occlude_vertex(@builtin(vertex_index) v:u32)->Occluder {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var out:Occluder;out.position=vec4f(p[v],0,1);out.ndc=p[v];return out;
}
/** The globe's depth where it covers a pixel, so what lies behind it hides; nothing elsewhere. */
@fragment fn occlude_fragment(v:Occluder)->@builtin(frag_depth) f32 {
  let hit=globePoint(v.ndc,u);if(hit.w==0.0){discard;}
  let clip=project_world(hit.xyz,u);return clip.z/clip.w;
}
