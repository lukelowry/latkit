@group(0) @binding(0) var<uniform> u:Uniforms;
/** The grid's color, and where its lines fall, as `kit.gridLines` writes it. */
struct Grid { color:vec4f, lines:vec4f }
@group(0) @binding(1) var<uniform> grid:Grid;
struct GridPoint { @builtin(position) position:vec4f, @location(0) ndc:vec2f }
struct GridOut { @location(0) color:vec4f, @builtin(frag_depth) depth:f32 }
@vertex fn grid_vertex(@builtin(vertex_index) v:u32)->GridPoint {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var out:GridPoint;out.position=vec4f(p[v],0,1);out.ndc=p[v];return out;
}
/**
 * The grid over the ground under each pixel, beneath the graph. On the globe it writes the globe's
 * depth too, so what lies behind the globe hides, as the occluder does without a grid.
 */
@fragment fn grid_fragment(v:GridPoint)->GridOut {
  let q=projectionOf(u);
  let g=projection_ground_point(v.ndc,q);
  let cover=grid_lines(g.relative,grid.lines)*grid.color.a;
  if(!g.hit){discard;}
  var out:GridOut;
  out.color=vec4f(grid.color.rgb*cover,cover);
  out.depth=1.0;
  if(q.view.w>1.5){let clip=projection_clip(g.world,q);out.depth=clip.z/clip.w;}
  return out;
}
