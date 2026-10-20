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
const OP_ZOOM: u32 = 43u;
const OP_STORE_CODE: u32 = 44u;

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
// Rows a block holds: a page of every column. A dispatch over more items than one dimension holds
// steps a block at a time in its second, 256 workgroups of 256 wide.
const BLOCK_ROWS: u32 = 65536u;

// The item invocation `id` of a dispatch over items covers: blocks of BLOCK_ROWS along the second
// dimension, when the first holds too few.
fn item(id: vec3u) -> u32 {
    return id.y * BLOCK_ROWS + id.x;
}

// How a word of a row eases while its mark does: kept as it is (no channel stores it), shown as
// evaluated at once, a number or a color mixed, or a position's high word moved by its offset.
const BLEND_KEEP: u32 = 0u;
const BLEND_SNAP: u32 = 1u;
const BLEND_NUMBER: u32 = 2u;
const BLEND_COLOR: u32 = 3u;
const BLEND_POSITION: u32 = 4u;

// Points per block of a geometry's points, as a shift: a block of x and y words is a chunk.
const POINT_BITS: u32 = 15u;
const POINT_MASK: u32 = 32767u;

// Vertex state words.
const VERTEX_WORDS: u32 = 12u;
const VERTEX_POSITION: u32 = 0u;
const VERTEX_COLOR: u32 = 4u;
const VERTEX_STATUS: u32 = 5u;
const VERTEX_HALF: u32 = 6u;
const VERTEX_ELEVATION: u32 = 8u;
// How many groups hold a group row: containers tint by it.
const VERTEX_DEPTH: u32 = 9u;
// The CSS pixels its marker's half keeps within at any zoom, as two halves: the mark's, so every
// mark reading the vertex trims at the outline it draws.
const VERTEX_RANGE: u32 = 10u;
const VERTEX_FLAGS: u32 = 11u;

// Edge state words. Every kind's flags are its last word. A stroke's travel is how far its comets
// moved, which no channel writes.
const EDGE_WORDS: u32 = 7u;
const EDGE_FROM: u32 = 0u;
const EDGE_TO: u32 = 1u;
const EDGE_COLOR: u32 = 2u;
const EDGE_WIDTH: u32 = 3u;
const EDGE_FLOW: u32 = 4u;
const EDGE_TRAVEL: u32 = 5u;
const EDGE_FLAGS: u32 = 6u;

// A vertex mark's ports, beside its program: each port's code (its side in two bits, its place
// among the ports on that side and how many share it in eight each, and whether it is an output),
// its shape, the program column of its reference field, and its label's rectangle in the atlas.
const PORT_WORDS: u32 = 5u;
const PORT_CODE: u32 = 0u;
const PORT_SHAPE: u32 = 1u;
const PORT_COLUMN: u32 = 2u;
const PORT_UV: u32 = 3u;
const PORT_OUTPUT: u32 = 0x40000u;
const SIDE_LEFT: u32 = 0u;
const SIDE_RIGHT: u32 = 1u;
const SIDE_TOP: u32 = 2u;
const SIDE_BOTTOM: u32 = 3u;
// Length units across a port's marker: CSS pixels, or units in a diagram.
const PORT_SIZE: f32 = 7.0;
// A group's header band, in label sizes: its title sits in it.
const HEADER_BAND: f32 = 1.8;
// Angle a geodesic segment spans at most, in degrees.
const GEODESIC_STEP: f32 = 2.0;
// Pieces a path between two ends takes at most: along a great circle, or bowed into a lane.
const MAX_PIECES: u32 = 64u;
// Pieces a path bowed into a lane takes at least.
const BOW_PIECES: u32 = 16u;

// Face state words.
const FACE_WORDS: u32 = 5u;
const FACE_A: u32 = 0u;
const FACE_B: u32 = 1u;
const FACE_C: u32 = 2u;
const FACE_COLOR: u32 = 3u;
const FACE_FLAGS: u32 = 4u;

// Line state words.
const LINE_WORDS: u32 = 5u;
const LINE_COLOR: u32 = 0u;
const LINE_WIDTH: u32 = 1u;
const LINE_FLOW: u32 = 2u;
const LINE_TRAVEL: u32 = 3u;
const LINE_FLAGS: u32 = 4u;

// Area state words.
const AREA_WORDS: u32 = 2u;
const AREA_COLOR: u32 = 0u;
const AREA_FLAGS: u32 = 1u;

// Label words, among a labeled mark's extra words: the text's code, its priority as a level from 0
// to 255, and its color.
const LABEL_WORDS: u32 = 3u;
const LABEL_CODE: u32 = 0u;
const LABEL_PRIORITY: u32 = 1u;
const LABEL_COLOR: u32 = 2u;

// A label's words in the labels buffer, per labeled row: the box placement measured it in, CSS
// pixels; its key; its state; and how present it is. Draws place a label from its anchor every
// frame; placement only decides whether it shows.
const CANDIDATE_WORDS: u32 = 7u;
const CANDIDATE_BOX: u32 = 0u;
const CANDIDATE_KEY: u32 = 4u;
const CANDIDATE_STATE: u32 = 5u;
const CANDIDATE_ALPHA: u32 = 6u;
// Text is set once per run at this size, in atlas texels, as a distance field reaching this far
// past the text's edge.
const TEXT_BASE: f32 = 32.0;
const TEXT_SPREAD: f32 = 8.0;
// Candidate states: in view and wanting room, placed, dropped, placed in the frame before, and
// measured by an estimate while its text is not set.
const WANTS: u32 = 1u;
const PLACED_LABEL: u32 = 2u;
const DROPPED: u32 = 4u;
const STICKY: u32 = 8u;
const ESTIMATED: u32 = 16u;
// A run table entry whose text is not set yet holds this flag as its first corner and the run's
// estimated size as its second, so its label can be placed before it is set.
const TEXT_ESTIMATE: u32 = 0x80000000u;
// A cell a placed label holds.
const OCCUPIED: u32 = 0u;
// CSS pixels a cell of the label grid covers.
const CELL: f32 = 8.0;
// Codes a mark asks the host to set at most per frame.
const WANTED: u32 = 64u;

// State flags.
const VISIBLE: u32 = 1u;
// The row has a position: from its data, or in a diagram from its sheet.
const PLACED: u32 = 2u;
const DASH: u32 = 4u;
// While a mark eases, a row that appears fades in and one that disappears or left fades out.
const FADE_IN: u32 = 8u;
const FADE_OUT: u32 = 16u;
// A row that entered with this change: it has no state to ease from.
const ENTERING: u32 = 32u;
// A vertex whose size is in position units, and one with its own height: what any reader of its
// slot needs to know its size in pixels.
const HALF_UNITS: u32 = 64u;
const OWN_HEIGHT: u32 = 128u;

// Mark kinds.
const MARK_VERTICES: u32 = 0u;
const MARK_EDGES: u32 = 1u;
const MARK_FACES: u32 = 2u;
const MARK_LINES: u32 = 3u;
const MARK_AREAS: u32 = 4u;

// Primitives.
const POINTS: u32 = 0u;
const STROKES: u32 = 1u;
const TRIANGLES: u32 = 2u;
const GLYPHS: u32 = 3u;

// What a stroke's segments run between: two vertices (straight, along a great circle, or through
// bends), samples across the axis, or a geometry column's points. A triangle's corners come from
// three vertices, or from a geometry column three points at a time.
const PATH_ENDS: u32 = 0u;
const PATH_TRACE: u32 = 1u;
const PATH_GEOMETRY: u32 = 2u;
// A pole: from each row's own vertex down to the ground under it.
const PATH_POLES: u32 = 3u;

// Mark flags.
const SIZED: u32 = 1u;
const ARROWS: u32 = 2u;
const ENDS_COLOR: u32 = 4u;
const GEODESIC: u32 = 8u;
const STATUS: u32 = 16u;
const LABELED: u32 = 32u;
const STEP_BEFORE: u32 = 64u;
const STEP_AFTER: u32 = 128u;
const CASTS: u32 = 256u;
// A vertex mark whose rows hold rows: drawn as containers.
const GROUP: u32 = 512u;

// Focus bits per row: selected, hovered, and an end of a selected or hovered edge, which the focus
// draw lights over the rest; FIT marks the rows a fit measures.
const SELECTED: u32 = 1u;
const HOVERED: u32 = 2u;
const FIT: u32 = 4u;
const END: u32 = 8u;
const LIT: u32 = 11u;

// Ordered words per mark in the extents buffer: least x, y, z as complements, then greatest.
const EXTENT_WORDS: u32 = 6u;

// Probe words: the least key (distance, then the mark drawn last), the instance plus one, where the
// hit lies (its depth and screen point), the nearest depth drawn under the probe, and the instance's
// row and segment.
const PROBE_KEY: u32 = 0u;
const PROBE_INSTANCE: u32 = 1u;
const PROBE_DEPTH: u32 = 2u;
const PROBE_X: u32 = 3u;
const PROBE_Y: u32 = 4u;
const PROBE_UNDER: u32 = 5u;
const PROBE_ROW: u32 = 6u;
const PROBE_SEGMENT: u32 = 7u;
// Where a located row lies on screen, and whether it shows.
const PROBE_LOCATE_X: u32 = 8u;
const PROBE_LOCATE_Y: u32 = 9u;
const PROBE_LOCATED: u32 = 10u;
const PROBE_WORDS: u32 = 12u;

// Overlay sprites.
const SPRITE_LINE: u32 = 0u;
const SPRITE_TEXT: u32 = 1u;
const SPRITE_BOX: u32 = 2u;
const SPRITE_FILL: u32 = 3u;

// Spaces.
const SPACE_EARTH: u32 = 0u;
const SPACE_PLANE: u32 = 1u;
const SPACE_PLOT: u32 = 2u;
const SPACE_DIAGRAM: u32 = 3u;

// Built-in markers and shapes.
const MARKER_SHAPE: u32 = 0u;
const MARKER_GAUGE: u32 = 1u;
const MARKER_PIE: u32 = 2u;
const MARKER_BLOCK: u32 = 3u;
const MARKER_ICON: u32 = 4u;
const MARKER_CUSTOM: u32 = 5u;
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
const THEME_TEXT: u32 = 7u;
const THEME_MISSING: u32 = 8u;
// Nothing: a fully transparent color, what a missing status draws.
const THEME_CLEAR: u32 = 9u;
// What a group's container is filled with.
const THEME_SURFACE: u32 = 10u;
const THEME_SLOTS: u32 = 16u;

// Backdrop grids.
const GRID_OFF: u32 = 0u;
const GRID_LINES: u32 = 1u;
const GRID_DOTS: u32 = 2u;

// A list's header: its item count; where its counts (scanned in place to where each item's entries
// start, then the total), block sums, and entries start; the indirect arguments a draw and a
// dispatch over its entries read; and how many entries it keeps.
const LIST_ITEMS: u32 = 0u;
const LIST_COUNTS: u32 = 1u;
const LIST_SUMS: u32 = 2u;
const LIST_ENTRIES: u32 = 3u;
// Draw arguments: vertices, instances (the total), first vertex, first instance.
const LIST_DRAW: u32 = 4u;
// Dispatch arguments: workgroups over the total, 1, 1.
const LIST_DISPATCH: u32 = 8u;
// Entries the list keeps: past them, entries are counted but not written.
const LIST_KEPT: u32 = 11u;
const LIST_HEADER: u32 = 12u;
// Counts a workgroup of the scan takes.
const SCAN_WORKGROUP: u32 = 256u;


// How shadows fall: the light, how they darken and soften, and the ground the map covers.
struct Shade {
    color: vec4f,
    // The direction toward the light, in world units, and how much shadows spread per unit of height.
    light: vec4f,
    // The ground the map covers: least x and y, greatest x and y, in world units.
    rect: vec4f,
    // World units flat marks cast from, world units per texel of the map, its levels, and whether
    // anything casts.
    lift: f32,
    texel: f32,
    levels: f32,
    on: u32,
}

// What every draw and dispatch of a frame reads.
struct Frame {
    center_hi: vec2f,
    center_lo: vec2f,
    pointer: vec2f,
    // Where a probe looks, CSS pixels, and the box a query covers.
    probe: vec2f,
    query: vec4f,
    // The direction toward the key light faces are lit by, which turns with the camera.
    light: vec4f,
    space: u32,
    globe: f32,
    mercator_y: f32,
    probe_radius: f32,
    elapsed: f32,
    selecting: u32,
    // 1 while a fit measures only the rows marked FIT.
    fitting: u32,
    // 1 when the target stores linear color (an sRGB format): outputs convert from sRGB.
    linear: u32,
    glow: f32,
    dim: f32,
    dash: f32,
    // Comets: the distance between them and how far a tail trails its head, in the theme's lengths
    // or with `flow_units` in position units; how wide a head is, in CSS pixels; and the seconds
    // they travel this frame.
    flow_spacing: f32,
    flow_length: f32,
    flow_width: f32,
    flow_units: u32,
    flow_step: f32,
    // How far a lane bows, in its edge's lengths at its middle.
    lane_bow: f32,
    hover_scale: f32,
    shading: f32,
    arrow: f32,
    halo: f32,
    // CSS pixels between a group's members and its outline: its title's inset.
    group_padding: f32,
    // CSS pixels per length unit: per position unit in a diagram, where every length is a unit; 1
    // elsewhere. Lengths in the frame above are already in pixels.
    unit: f32,
    zoom: f32,
    // The label grid: where its cells start in the labels buffer, and its columns and rows; and how
    // far labels fade per frame.
    cells: u32,
    cell_columns: u32,
    cell_rows: u32,
    label_fade: f32,
    // A plane's grid: its kind, pitch in position units, and the world distance from the center it
    // fades out by, 0 for none; and whether the earth draws its graticule.
    grid_kind: u32,
    grid_pitch: f32,
    grid_fade: f32,
    graticule: u32,
    hover: vec4f,
    selected: vec4f,
    flow: vec4f,
    background: vec4f,
    surface: vec4f,
    grid_color: vec4f,
    // The direction toward the sun in the earth's frame (x toward 0° longitude on the equator, z
    // toward the north pole), and how bright night stays; no direction where daylight is off.
    sun: vec4f,
    // The air glowing around the globe; clear where the earth has none.
    atmosphere: vec4f,
    shade: Shade,
    theme: array<vec4u, 4>,
}

// What one pass draws through: the view, or the light casting shadows.
struct Eye {
    clip_from_world: mat4x4f,
    world_from_clip: mat4x4f,
    // The camera's position in world units.
    position: vec4f,
    // The target's size in CSS pixels; the light's map counts CSS pixels of the view it serves.
    size: vec2f,
    px_per_unit: vec2f,
    // Target pixels per CSS pixel.
    pixel_ratio: f32,
    // World units casters are raised by: the shadow's lift in the light's eye, 0 elsewhere.
    lift: f32,
}

// One mark's parameters, at a 256-byte aligned dynamic offset.
struct Mark {
    index: u32,
    kind: u32,
    primitive: u32,
    // Rows drawn and evaluated, and rows past them that left and fade out.
    rows: u32,
    exits: u32,
    // Each row's kind words: where row 0's start and how many; then its extra words.
    state: u32,
    stride: u32,
    extra: u32,
    extras: u32,
    // While the mark eases, where row 0's frozen kind and extra words start; NONE otherwise.
    frozen: u32,
    frozen_extra: u32,
    motion: f32,
    // While the mark eases toward what its channels evaluated, where row 0's settled kind and extra
    // words start in the settled mirror; NONE otherwise. Where the program holds how each word of a
    // row eases, a word each.
    settled: u32,
    settled_extra: u32,
    blends: u32,
    // The row blocks a dispatch over the mark's rows covers: at `block` in the blocks buffer,
    // `blocks` of them.
    block: u32,
    blocks: u32,
    focus: u32,
    domains: u32,
    columns: u32,
    ranges: u32,
    code: u32,
    constants: u32,
    ends: u32,
    channels: u32,
    reductions: u32,
    mask: u32,
    units: u32,
    flags: u32,
    marker: u32,
    shape: u32,
    corner: f32,
    hole: f32,
    // Marker inputs: how many, the extra word of the first, and where their colors start in the constants.
    inputs: u32,
    input: u32,
    palette: u32,
    // The program column a line traces, or NONE.
    trace: u32,
    // Segments of each row when every row has as many; NONE when the mark's list numbers them.
    per_row: u32,
    // Where the header of the mark's list of segments starts in the lists buffer, and of the list
    // a query builds over its instances.
    list: u32,
    query: u32,
    // Where the mark's remap words start, while its transition is being frozen.
    remap: u32,
    // The rows its focus draw lights, at `focused` in the focused buffer, how many, and the
    // instances each takes: a point one, a path as many as its longest piece count.
    focused: u32,
    focused_rows: u32,
    pieces: u32,
    // Program columns: the geometry a stroke's path runs through (a route or bends), the geometry
    // it ran through when its transition began, and each row's lane among edges joining the same
    // two vertices; NONE without.
    geometry: u32,
    frozen_geometry: u32,
    lane: u32,
    // Each port of a vertex mark's rows, and how many each row has.
    port_info: u32,
    ports: u32,
    // The extra word of the label's code, or NONE; the labels buffer's offsets of its candidates, its
    // run table (two words per code), its wanted codes (a count, then codes), and its seen codes (a
    // bit per code shown in view); the id of its first candidate, unique across marks; the size
    // labels and port labels are set at, in length units.
    label: u32,
    candidates: u32,
    runs: u32,
    wanted: u32,
    seen: u32,
    label_id: u32,
    label_size: f32,
    port_label_size: f32,
    // The most labels shown, or NONE; and where the labels buffer holds the select that caps them.
    label_max: u32,
    label_select: u32,
    // The CSS pixels the mark's size keeps within at any zoom: a vertex's half, a stroke's width.
    size_min: f32,
    size_max: f32,
}

// A line or a run of text drawn over the marks, in CSS pixels.
struct Sprite {
    // A line's ends, or a text's top left and bottom right.
    a: vec2f,
    b: vec2f,
    // A text's rectangle in the atlas, texels.
    uv: vec4f,
    color: vec4f,
    width: f32,
    kind: u32,
}

// One panel of a shot composed into the bytes a consumer takes: RGBA rows for an image, or NV12
// planes for an encoder. Pixels are the shot's.
struct Compose {
    // Where the panel's top left lands in the picture, and its size.
    origin: vec2u,
    size: vec2u,
    // The picture's size.
    picture: vec2u,
    // Where NV12's interleaved chroma plane starts, in words.
    chroma: u32,
    // Whether pixels keep their alpha: an image of a transparent shot.
    alpha: u32,
    // What shows where no panel draws: straight sRGB.
    background: vec4f,
}
