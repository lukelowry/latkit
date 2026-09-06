// Precomputed globe geometry. The globe draws the layout the topology carries; vertex placement
// on the plane families is the vertexPosition channel (vertex-channels.wgsl).

@group(1) @binding(0) var<storage, read> topology: array<u32>;

fn topo_f32(word: u32) -> f32 {
  return bitcast<f32>(topology[word]);
}

fn vertex_sphere(i: u32) -> vec3f {
  let o = topology[V_SPHERE] + i * 3u;
  return vec3f(topo_f32(o), topo_f32(o + 1u), topo_f32(o + 2u));
}
