// Each bound type's style words, written from its field pages; after the field shader.
struct Page {
  /** Color, width, flow, and shade field slots. */
  fields: vec4u,
  /** Rows, first slot, slot stride, and the color word: 0 the color, 1 the status. */
  place: vec4u,
  origin: vec4f,
  base: vec4f,
  color: LatkitScale,
  width: LatkitScale,
  flow: LatkitScale,
}
@group(1) @binding(0) var<uniform> page: Page;
@group(1) @binding(1) var<storage, read_write> styles: array<vec4u>;
@compute @workgroup_size(64) fn style_main(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= page.place.x) { return; }
  let at = page.place.y + row * page.place.z;
  if (page.fields.x != 0xffffffffu) {
    let color = pack4x8unorm(fieldColor(page.fields.x, row, 0u, page.color, page.base));
    if (page.place.w == 0u) { styles[at].x = color; } else { styles[at].y = color; }
  }
  if (page.fields.y != 0xffffffffu || page.fields.z != 0xffffffffu) {
    styles[at].z = pack2x16float(vec2f(
      fieldScaled(page.fields.y, row, 0u, page.width, -1.0),
      fieldScaled(page.fields.z, row, 0u, page.flow, 0.0)));
  }
  if (page.fields.w != 0xffffffffu) {
    styles[at].w = bitcast<u32>(fieldNumber(page.fields.w, row, 0u, page.origin.x, 0.0));
  }
}
