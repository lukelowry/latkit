// Each values row's look, written once for every draw of the rows that read it: its color, then
// its width, its shade, whether shown (1) and dashed (2), and how fast its comets move.
struct Page {
  rows: u32,
  /** The record of the page's first row. */
  first: u32,
  color: vec4f,
  tint: LatkitChannel,
  width: LatkitChannel,
  visible: LatkitChannel,
  shade: LatkitChannel,
  dash: LatkitChannel,
  flow: LatkitChannel,
}
@group(1) @binding(0) var<uniform> page: Page;
@group(1) @binding(1) var<storage, read_write> records: array<vec4f>;

@compute @workgroup_size(64)
fn records_main(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= page.rows) { return; }
  let out = (page.first + row) * 2u;
  records[out] = channelColor(page.tint, row, 0u, page.color);
  records[out + 1u] = vec4f(
    channelNumber(page.width, row, 0u),
    channelNumber(page.shade, row, 0u),
    select(0.0, 1.0, channelOn(page.visible, row, 0u)) + select(0.0, 2.0, channelOn(page.dash, row, 0u)),
    channelNumber(page.flow, row, 0u),
  );
}
