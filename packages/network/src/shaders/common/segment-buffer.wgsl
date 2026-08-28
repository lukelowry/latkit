@group(2) @binding(0) var<storage, read> segments: array<u32>;

struct SegmentRecord {
  edge_id: u32,
  from_vertex: u32,
  to_vertex: u32,
  height_t: vec2f,
  a: vec2f,
  b: vec2f,
}

fn segment_record_base(i: u32) -> u32 {
  return segments[SEG_RECORDS] + i * SEGMENT_RECORD_WORDS;
}

// Cheap first word of a record, so hidden edges cull before the full load.
fn segment_edge_id(i: u32) -> u32 {
  return segments[segment_record_base(i)];
}

fn segment_record(i: u32) -> SegmentRecord {
  let o = segment_record_base(i);
  var seg: SegmentRecord;
  seg.edge_id = segments[o];
  seg.from_vertex = segments[o + 1u];
  seg.to_vertex = segments[o + 2u];
  seg.height_t = unpack2x16unorm(segments[o + 3u]);
  seg.a = vec2f(bitcast<f32>(segments[o + 4u]), bitcast<f32>(segments[o + 5u]));
  seg.b = vec2f(bitcast<f32>(segments[o + 6u]), bitcast<f32>(segments[o + 7u]));
  return seg;
}

fn segment_sphere_endpoint(i: u32, endpoint: u32) -> vec3f {
  let o = segments[SEG_SPHERE_ENDPOINTS] + i * SEGMENT_SPHERE_ENDPOINT_WORDS + endpoint * 3u;
  return vec3f(bitcast<f32>(segments[o]), bitcast<f32>(segments[o + 1u]), bitcast<f32>(segments[o + 2u]));
}
