// Each bound type's style words, written from its field pages; after the field shader.
struct Page {
  /** Rows, first slot, slot stride, and the color word: 0 the color, 1 the status. */
  place: vec4u,
  /** The color of rows the field leaves without one; zero draws the view's. */
  missing: vec4f,
  color: LatkitChannel,
  width: LatkitChannel,
  flow: LatkitChannel,
  shade: LatkitChannel,
}
@group(1) @binding(0) var<uniform> page: Page;
@group(1) @binding(1) var<storage, read_write> styles: array<vec4u>;
@compute @workgroup_size(64) fn style_main(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= page.place.x) { return; }
  let at = page.place.y + row * page.place.z;
  if (page.color.slot != 0xffffffffu) {
    let color = pack4x8unorm(channelColor(page.color, row, 0u, page.missing));
    if (page.place.w == 0u) { styles[at].x = color; } else { styles[at].y = color; }
  }
  if (page.width.slot != 0xffffffffu || page.flow.slot != 0xffffffffu) {
    styles[at].z = pack2x16float(vec2f(channelNumber(page.width, row, 0u), channelNumber(page.flow, row, 0u)));
  }
  if (page.shade.slot != 0xffffffffu) {
    styles[at].w = bitcast<u32>(channelNumber(page.shade, row, 0u));
  }
}
