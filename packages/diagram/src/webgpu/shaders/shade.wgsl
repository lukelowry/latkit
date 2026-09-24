// The host shade hook. A shade is `fn shade(f: Fragment) -> vec4f`, spliced right after this
// prelude into the group, wire, block, and port passes; the default returns f.color unchanged.
// It may read `u.host`, the 64-float block Shade.tick writes before each frame, and
// `u.pointer_px`, the pointer in canvas-local CSS px (POINTER_NONE, far off-canvas, when absent);
// `to_screen` takes `f.point` there.

struct Fragment {
  // The resolved color before the shade, straight (not premultiplied) alpha.
  color: vec4f,
  // PART_BLOCK, PART_PORT, PART_NET, or PART_GROUP, and the part's index.
  part: u32,
  index: u32,
  // The fragment's position in diagram units.
  point: vec2f,
  // The part's FOCUS_* flags.
  focus: u32,
  // blockShade for blocks and their ports, netShade for nets; 0 when unbound.
  value: f32,
  // Wires: distance along the net from its driver, in diagram units; else 0.
  along: f32,
  // Seconds, wrapping every hour.
  time: f32,
}
