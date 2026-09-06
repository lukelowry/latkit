// The host shade hook. A shade is `fn shade(f: Fragment) -> vec4f`, compiled into the vertex and
// edge base passes right after this prelude; the default returns f.color unchanged. `host` is the
// 64-float block `Shade.tick` writes. A missing pointer sits at POINTER_NONE, far off-canvas.

struct Fragment {
  // What the pass would paint: the channel color after daylight, before anti-aliasing.
  color: vec4f,
  // Canvas-local CSS pixels, y down; compare against u.pointer_px directly.
  px: vec2f,
  // Projection world position of the fragment.
  world: vec3f,
  // ID_KIND_VERTEX or ID_KIND_EDGE, and the item's index.
  kind: u32,
  id: u32,
  // 0 unfocused, 1 hovered, 2 selected.
  focus: u32,
  // The item's vertexShade or edgeShade channel value; 0 while unbound.
  value: f32,
}

@group(0) @binding(4) var<uniform> host: array<vec4f, 16>;

const POINTER_NONE: f32 = -1e6;
