// The GPU contract shared with Rust: build.rs mirrors every struct and constant here.

// No index, slot, or page.
const NONE: u32 = 0xffffffffu;
// A missing number: NaN bits. Any NaN or infinity reads as missing.
const MISSING: u32 = 0x7fc00000u;
// A missing color: transparent magenta, replaced by the theme's color on store.
const MISSING_COLOR: u32 = 0x00ff00ffu;

// Opcodes of the expression machine; an op is four words: code, a, b, c.
const OP_CONST: u32 = 0u;
const OP_MISSING: u32 = 1u;
const OP_FIELD: u32 = 2u;
const OP_SELECTED: u32 = 3u;
const OP_HOVERED: u32 = 4u;
const OP_POINTER: u32 = 5u;
const OP_ELAPSED: u32 = 6u;
const OP_THEME: u32 = 7u;
const OP_NEG: u32 = 8u;
const OP_NOT: u32 = 9u;
const OP_ABS: u32 = 10u;
const OP_SQRT: u32 = 11u;
const OP_SIN: u32 = 12u;
const OP_COS: u32 = 13u;
const OP_ADD: u32 = 14u;
const OP_SUB: u32 = 15u;
const OP_MUL: u32 = 16u;
const OP_DIV: u32 = 17u;
const OP_MIN: u32 = 18u;
const OP_MAX: u32 = 19u;
const OP_LT: u32 = 20u;
const OP_LE: u32 = 21u;
const OP_GT: u32 = 22u;
const OP_GE: u32 = 23u;
const OP_EQ: u32 = 24u;
const OP_NE: u32 = 25u;
const OP_AND: u32 = 26u;
const OP_OR: u32 = 27u;
const OP_SELECT: u32 = 28u;
const OP_SCALE: u32 = 29u;
const OP_COLORMAP: u32 = 30u;
const OP_STORE: u32 = 31u;
const OP_STORE_COLOR: u32 = 32u;
const OP_STORE_FLAG: u32 = 33u;
const OP_STORE_POSITION: u32 = 34u;
const OP_POSITION: u32 = 35u;
const OP_STORE_END: u32 = 36u;
const OP_REDUCE: u32 = 37u;
const OP_FLOOR: u32 = 38u;
const OP_MOD: u32 = 39u;
const OP_POW: u32 = 40u;
const OP_LOG: u32 = 41u;
const OP_EXP: u32 = 42u;

// Values the expression stack holds at once.
const STACK: u32 = 16u;

// Column descriptor words, eight per column in `meta`.
const COLUMN_WORDS: u32 = 8u;
const COLUMN_FLAGS: u32 = 0u;
const COLUMN_ROWS: u32 = 1u;
const COLUMN_TABLE: u32 = 2u;
const COLUMN_LOW: u32 = 3u;
const COLUMN_JOIN: u32 = 4u;
const COLUMN_T: u32 = 5u;
// Column flags.
const SAMPLED: u32 = 1u;
const STEP: u32 = 2u;
const BITS: u32 = 4u;

// Rows per data page, as a shift.
const PAGE_BITS: u32 = 16u;
const PAGE_MASK: u32 = 65535u;

// Vertex state words.
const VERTEX_WORDS: u32 = 10u;
const VERTEX_POSITION: u32 = 0u;
const VERTEX_COLOR: u32 = 4u;
const VERTEX_STATUS: u32 = 5u;
const VERTEX_HALF: u32 = 6u;
const VERTEX_ELEVATION: u32 = 8u;
const VERTEX_FLAGS: u32 = 9u;

// Edge state words.
const EDGE_WORDS: u32 = 6u;
const EDGE_FROM: u32 = 0u;
const EDGE_TO: u32 = 1u;
const EDGE_COLOR: u32 = 2u;
const EDGE_WIDTH: u32 = 3u;
const EDGE_FLOW: u32 = 4u;
const EDGE_FLAGS: u32 = 5u;

// Line state words.
const LINE_WORDS: u32 = 4u;
const LINE_COLOR: u32 = 0u;
const LINE_WIDTH: u32 = 1u;
const LINE_FLOW: u32 = 2u;
const LINE_FLAGS: u32 = 3u;

// Area state words.
const AREA_WORDS: u32 = 4u;
const AREA_COLOR: u32 = 0u;
const AREA_OUTLINE: u32 = 1u;
const AREA_WIDTH: u32 = 2u;
const AREA_FLAGS: u32 = 3u;

// Label state words, after a labeled mark's own words.
const LABEL_WORDS: u32 = 3u;
const LABEL_TEXT: u32 = 0u;
const LABEL_PRIORITY: u32 = 1u;
const LABEL_SIZE: u32 = 2u;

// State flags.
const VISIBLE: u32 = 1u;
// The row's position comes from its data.
const PINNED: u32 = 2u;
const DASH: u32 = 4u;
// A layout placed the row.
const PLACED: u32 = 8u;

// Mark flags.
const SIZED: u32 = 1u;
const ARROWS: u32 = 2u;
const ENDS_COLOR: u32 = 4u;

// Focus bits per row.
const SELECTED: u32 = 1u;
const HOVERED: u32 = 2u;

// Spaces.
const SPACE_EARTH: u32 = 0u;
const SPACE_PLANE: u32 = 1u;
const SPACE_PLOT: u32 = 2u;

// Built-in markers and shapes.
const MARKER_SHAPE: u32 = 0u;
const MARKER_GAUGE: u32 = 1u;
const MARKER_PIE: u32 = 2u;
const MARKER_BLOCK: u32 = 3u;
const SHAPE_ELLIPSE: u32 = 0u;
const SHAPE_RECTANGLE: u32 = 1u;
const SHAPE_ROUNDED: u32 = 2u;
const SHAPE_DIAMOND: u32 = 3u;

// Colormap kinds.
const COLORMAP_SEQUENTIAL: u32 = 0u;
const COLORMAP_DIVERGING: u32 = 1u;
const COLORMAP_CYCLIC: u32 = 2u;
const COLORMAP_CATEGORICAL: u32 = 3u;

// Theme slots: colors are packed RGBA8, sizes are f32 bits.
const THEME_VERTEX: u32 = 0u;
const THEME_VERTEX_RADIUS: u32 = 1u;
const THEME_EDGE: u32 = 2u;
const THEME_EDGE_WIDTH: u32 = 3u;
const THEME_LINE: u32 = 4u;
const THEME_LINE_WIDTH: u32 = 5u;
const THEME_AREA: u32 = 6u;
const THEME_OUTLINE: u32 = 7u;
const THEME_TEXT: u32 = 8u;
const THEME_MISSING: u32 = 9u;
const THEME_SLOTS: u32 = 16u;

// Backdrop grids.
const GRID_OFF: u32 = 0u;
const GRID_LINES: u32 = 1u;
const GRID_DOTS: u32 = 2u;

// What every draw and dispatch of a frame reads.
struct Frame {
    clip_from_world: mat4x4f,
    world_from_clip: mat4x4f,
    center_hi: vec2f,
    center_lo: vec2f,
    size: vec2f,
    px_per_unit: vec2f,
    pointer: vec2f,
    pick_origin: vec2f,
    pixel_ratio: f32,
    space: u32,
    globe: f32,
    mercator_y: f32,
    pick_scale: f32,
    pick_radius: f32,
    elapsed: f32,
    selecting: u32,
    glow: f32,
    dim: f32,
    dash: f32,
    flow_spacing: f32,
    edge_spacing: f32,
    hover_scale: f32,
    // 1 when the target stores linear color (an sRGB format): outputs convert from sRGB.
    linear: u32,
    hover: vec4f,
    selected: vec4f,
    flow: vec4f,
    // Backdrop: background, surface (Earth), grid line color.
    background: vec4f,
    surface: vec4f,
    grid_color: vec4f,
    // Grid kind, pitch in position units, and whether it is shown.
    grid_kind: u32,
    grid_pitch: f32,
    grid_pad0: f32,
    grid_pad1: f32,
    theme: array<vec4u, 4>,
}

// One mark's parameters, at a 256-byte aligned dynamic offset.
struct Mark {
    index: u32,
    rows: u32,
    state: u32,
    stride: u32,
    previous: u32,
    remap: u32,
    columns: u32,
    ranges: u32,
    code: u32,
    constants: u32,
    channels: u32,
    reductions: u32,
    mask: u32,
    domains: u32,
    ends: u32,
    focus: u32,
    units: u32,
    flags: u32,
    marker: u32,
    shape: u32,
    inputs: u32,
    vertices: u32,
    // Eased progress of the mark's transition: 1 when none runs.
    motion: f32,
    hole: f32,
    corner: f32,
    pie: array<vec4f, 8>,
}
