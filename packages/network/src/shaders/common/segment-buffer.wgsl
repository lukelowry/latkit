@group(2) @binding(0) var<storage, read> segments: array<u32>;

struct SegmentRecord {
  edge_id: u32,
  from_vertex: u32,
  to_vertex: u32,
  height_t: vec2f,
  a: vec2f,
  b: vec2f,
}

fn segment_word(record_word: u32) -> u32 {
  return segments[segments[SEG_RECORDS] + record_word];
}

fn segment_f32(record_word: u32) -> f32 {
  return bitcast<f32>(segment_word(record_word));
}

fn segment_record(i: u32) -> SegmentRecord {
  let o = i * SEGMENT_RECORD_WORDS;
  var seg: SegmentRecord;
  seg.edge_id = segment_word(o);
  seg.from_vertex = segment_word(o + 1u);
  seg.to_vertex = segment_word(o + 2u);
  seg.height_t = unpack2x16unorm(segment_word(o + 3u));
  seg.a = vec2f(segment_f32(o + 4u), segment_f32(o + 5u));
  seg.b = vec2f(segment_f32(o + 6u), segment_f32(o + 7u));
  return seg;
}

fn segment_sphere_endpoint(i: u32, endpoint: u32) -> vec3f {
  let o = segments[SEG_SPHERE_ENDPOINTS] + i * SEGMENT_SPHERE_ENDPOINT_WORDS + endpoint * 3u;
  return vec3f(bitcast<f32>(segments[o]), bitcast<f32>(segments[o + 1u]), bitcast<f32>(segments[o + 2u]));
}
