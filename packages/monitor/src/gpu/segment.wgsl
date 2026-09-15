// Coordinates and independent color coordinates are normalized in f64 before upload.
// Values are [vertical coordinate, color coordinate], frame-major within one slab.
struct Uniforms {
  viewport: vec2f,
  line_width: f32,
  element_count: u32,
  focus_color: vec4f,
};
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> values: array<vec2f>;
@group(0) @binding(2) var<storage, read> xnorm: array<f32>;
@group(0) @binding(3) var cm_lut: texture_2d<f32>;
@group(0) @binding(4) var cm_samp: sampler;
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec2f,
  @location(1) frag_px: vec2f,
  @location(2) seg_p0: vec2f,
  @location(3) seg_p1: vec2f,
  @location(4) hw_px: f32,
};
fn non_finite(v: f32) -> bool {
  return (bitcast<u32>(v) & 0x7fffffffu) >= 0x7f800000u;
}
fn colormap(t: f32) -> vec3f {
  // Texel centers match bakeColormap's samples at i / (size - 1).
  let width = f32(textureDimensions(cm_lut).x);
  return textureSampleLevel(cm_lut, cm_samp, vec2f((clamp(t, 0.0, 1.0) * (width - 1.0) + 0.5) / width, 0.5), 0.0).rgb;
}
@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let frame = ii / U.element_count;
  let element = ii % U.element_count;
  let v0 = values[frame * U.element_count + element];
  let v1 = values[(frame + 1u) * U.element_count + element];
  var o: VSOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  if (non_finite(v0.x) || non_finite(v1.x)) { return o; }
  var a = vec2f(xnorm[frame], 1.0 - v0.x);
  var b = vec2f(xnorm[frame + 1u], 1.0 - v1.x);
  var ca = v0.y;
  var cb = v1.y;
  let hw = max(U.line_width * 0.5, 0.5);
  let margin = vec2f(hw + 1.0) / U.viewport;
  // Clip segments, preserving crossings. Never flatten outside samples onto the axis.
  for (var axis = 0u; axis < 2u; axis++) {
    for (var side = 0u; side < 2u; side++) {
      let edge = select(-margin[axis], 1.0 + margin[axis], side == 1u);
      let outside_a = select(a[axis] < edge, a[axis] > edge, side == 1u);
      let outside_b = select(b[axis] < edge, b[axis] > edge, side == 1u);
      if (outside_a && outside_b) { return o; }
      if (outside_a || outside_b) {
        let t = (edge - a[axis]) / (b[axis] - a[axis]);
        var point = mix(a, b, t);
        point[axis] = edge;
        let color = mix(ca, cb, t);
        if (outside_a) { a = point; ca = color; }
        else { b = point; cb = color; }
      }
    }
  }
  let p0 = a * U.viewport;
  let p1 = b * U.viewport;
  let dir = p1 - p0;
  let along = select(vec2f(1.0, 0.0), dir / max(length(dir), 1e-6), length(dir) > 1e-6);
  let normal = vec2f(-along.y, along.x);
  let pad = hw + 1.0;
  var p: vec2f;
  switch (vi) {
    case 0u: { p = p0 - along * pad - normal * pad; }
    case 1u: { p = p0 - along * pad + normal * pad; }
    case 2u: { p = p1 + along * pad - normal * pad; }
    default: { p = p1 + along * pad + normal * pad; }
  }
  let n = p / U.viewport;
  o.pos = vec4f(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0, 0.0, 1.0);
  o.color = vec2f(ca, cb);
  o.frag_px = p;
  o.seg_p0 = p0;
  o.seg_p1 = p1;
  o.hw_px = hw;
  return o;
}
fn feather(in: VSOut, focus: bool) -> vec4f {
  let pa = in.frag_px - in.seg_p0;
  let ba = in.seg_p1 - in.seg_p0;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  var alpha = clamp(in.hw_px - length(pa - ba * h) + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) { discard; }
  // Use the sample position along the segment, excluding round-cap padding.
  var color = colormap(mix(in.color.x, in.color.y, h));
  if (focus) {
    if (U.focus_color.a >= 0.0) { color = U.focus_color.rgb; alpha *= U.focus_color.a; }
    else { color = mix(color, vec3f(1.0), 0.35); }
  }
  return vec4f(color * alpha, alpha);
}
@fragment fn fs_history(in: VSOut) -> @location(0) vec4f {
  return feather(in, false);
}
@fragment fn fs_focus(in: VSOut) -> @location(0) vec4f {
  return feather(in, true);
}
