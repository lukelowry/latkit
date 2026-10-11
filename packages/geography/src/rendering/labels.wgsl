@group(0) @binding(1) var<storage, read> anchors: array<vec4f>;

struct Label { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f }
/** Area and line labels, placed in CSS pixels; a hidden anchor draws nothing. */
@vertex fn label_vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Label {
  let text = textVertex(v, i);
  let anchor = latkitAnchor(anchors[text.anchor]);
  let p = anchor.position + text.position;
  var out: Label;
  out.position = vec4f(p.x * 2.0 / scene.projection.view.x - 1.0, 1.0 - p.y * 2.0 / scene.projection.view.y, 0.0, 1.0);
  if (!anchor.shown) { out.position = vec4f(2.0, 2.0, 2.0, 1.0); }
  out.uv = text.uv;
  out.color = text.color;
  return out;
}
/** A halo of the ground keeps borders from cutting through the text. */
@fragment fn label_fragment(v: Label) -> @location(0) vec4f {
  return textColor(v.uv, v.color, vec4f(u.halo.rgb, 1.0), u.halo.a);
}
