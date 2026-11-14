// What an application's WGSL hooks see: a custom marker's `fn marker(f: MarkerFragment) ->
// MarkerColor` and a mark's `fn shade(f: ShadeFragment) -> vec4f`. A hook reads these structs and its
// own declarations only. In a browser latkit translates the hook alone and appends it to the shaders
// it translated ahead of time, so this module is all a hook links against.

// A marker's color, straight, and the signed distance in CSS pixels from the pixel to its outline,
// negative inside. Glows and status rings follow the outline.
struct MarkerColor {
    color: vec4f,
    distance: f32,
}

struct MarkerFragment {
    // The pixel's offset from the vertex, CSS pixels, y up.
    p: vec2f,
    // Half the marker's width and height.
    half: vec2f,
    color: vec4f,
    input: array<f32, 8>,
}

// A pixel of a mark, before it blends.
struct ShadeFragment {
    // The mark's color at the pixel, straight sRGB, after its options, the theme, and the selection.
    color: vec4f,
    // The pixel, in CSS pixels from the view's top left corner, y down.
    px: vec2f,
    // The pixel within its row's shape, in CSS pixels: from a vertex's center, y up, or along a line's
    // segment from its start and across from its middle. Zero on areas.
    local: vec2f,
    // The pointer, in CSS pixels from the view's top left corner, and 1 while it is over the view.
    pointer: vec3f,
    // Seconds since the view was created, or a picture's time.
    elapsed: f32,
    input: array<f32, 8>,
}
