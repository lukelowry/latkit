// Instanced segment shader over a value slab: instance i maps to
// (frame, element) = (i / element_count, i % element_count). The vertex stage reads
// the two endpoint values from the storage slab, projects them, and samples the
// colormap LUT at the same normalized value that drives y — each segment gradients
// between the exact colors of its two samples, matching the network's vertex color
// under the same colormap + range. Non-finite endpoints collapse the quad off-clip:
// no fragments, a gap — the data is never transformed.
//
// The fragment computes the signed distance to the finite segment and feathers the
// alpha over the last pixel; round caps are intrinsic to the SDF, so consecutive
// segments at any angle close their joints automatically. Output is premultiplied
// (rgb * a, a) and the pipeline blends one / one-minus-src-alpha, required for AA
// fringes to composite onto prior segments in the persistent history texture.

struct Uniforms {
  size: vec2f,        // viewport, device px
  line_width: f32,    // device px
  element_count: u32,
  range_min: f32,
  range_scale: f32,   // 1 / (max - min); drives y and the LUT coordinate together
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> values: array<f32>;  // window slab, [frame][element]
@group(0) @binding(2) var<storage, read> xnorm: array<f32>;   // per-frame x in [0,1], window-local
@group(0) @binding(3) var cm_lut: texture_2d<f32>;
@group(0) @binding(4) var cm_samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) frag_px: vec2f,
  @location(2) seg_p0: vec2f,
  @location(3) seg_p1: vec2f,
  @location(4) hw_px: f32,
};

// Bit test, immune to fast-math NaN folding: exponent all-ones is inf or NaN.
fn non_finite(v: f32) -> bool {
  return (bitcast<u32>(v) & 0x7fffffffu) >= 0x7f800000u;
}

fn px_to_ndc(px: vec2f, vp: vec2f) -> vec2f {
  let n = px / vp;
  return vec2f(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0);
}

fn lut(t: f32) -> vec3f {
  return textureSampleLevel(cm_lut, cm_samp, vec2f(t, 0.5), 0.0).rgb;
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let frame = ii / U.element_count;
  let element = ii % U.element_count;
  let v0 = values[frame * U.element_count + element];
  let v1 = values[(frame + 1u) * U.element_count + element];

  var o: VSOut;
  if (non_finite(v0) || non_finite(v1)) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0); // collapse off-clip: no fragments, a gap
    return o;
  }

  let t0 = clamp((v0 - U.range_min) * U.range_scale, 0.0, 1.0);
  let t1 = clamp((v1 - U.range_min) * U.range_scale, 0.0, 1.0);
  let p0 = vec2f(xnorm[frame] * U.size.x, (1.0 - t0) * U.size.y);
  let p1 = vec2f(xnorm[frame + 1u] * U.size.x, (1.0 - t1) * U.size.y);

  let dir = p1 - p0;
  let len = max(length(dir), 1e-6);
  let along = dir / len;
  let normal = vec2f(-along.y, along.x);
  // Half-width clamped so degenerate widths still rasterize a single-pixel core.
  let hw = max(U.line_width * 0.5, 0.5);
  let pad = hw + 1.0; // round caps clear the endpoints, plus 1 px of AA fringe
  var p: vec2f;
  switch (vi) {
    case 0u: { p = p0 - along * pad - normal * pad; }
    case 1u: { p = p0 - along * pad + normal * pad; }
    case 2u: { p = p1 + along * pad - normal * pad; }
    default: { p = p1 + along * pad + normal * pad; }
  }
  o.pos = vec4f(px_to_ndc(p, U.size), 0.0, 1.0);
  o.color = select(lut(t1), lut(t0), vi < 2u);
  o.frag_px = p;
  o.seg_p0 = p0;
  o.seg_p1 = p1;
  o.hw_px = hw;
  return o;
}

// Distance from p to the line segment ab, in pixels.
fn segment_distance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let denom = max(dot(ba, ba), 1e-6);
  let h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
  return length(pa - ba * h);
}

fn feather(in: VSOut, color: vec3f) -> vec4f {
  let dist = segment_distance(in.frag_px, in.seg_p0, in.seg_p1);
  let alpha = clamp(in.hw_px - dist + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) { discard; }
  return vec4f(color * alpha, alpha); // premultiplied
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  return feather(in, in.color);
}

// Focus overlay: the same segment, brightened toward white; the pass draws one
// element's trace widened at present time and never touches the history texture.
@fragment fn fs_focus(in: VSOut) -> @location(0) vec4f {
  return feather(in, mix(in.color, vec3f(1.0, 1.0, 1.0), 0.35));
}
