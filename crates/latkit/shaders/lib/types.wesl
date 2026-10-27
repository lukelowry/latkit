// Constants and structs shared with Rust. The build script mirrors each one in Rust.

// Sentinel for no index, slot, or page.
const NONE: u32 = 0xffffffffu;
// A missing number, as NaN bits. Any NaN or infinity reads as missing.
const MISSING: u32 = 0x7fc00000u;
// A missing color (transparent magenta), as an option given `missing()` holds. A color store
// replaces it with the option's theme color.
const MISSING_COLOR: u32 = 0x00ff00ffu;

// Expression machine opcodes. Each instruction is four words: opcode, a, b, c.
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
const OP_STORE_CODE: u32 = 36u;
const OP_REDUCE: u32 = 37u;
const OP_FLOOR: u32 = 38u;
const OP_MOD: u32 = 39u;
const OP_POW: u32 = 40u;
const OP_LOG: u32 = 41u;
const OP_EXP: u32 = 42u;
const OP_ZOOM: u32 = 43u;

// Depth of the expression machine's value stack.
const STACK: u32 = 16u;

// Column descriptors, `COLUMN_WORDS` words per column, start at `mark.columns` in the program.
const COLUMN_WORDS: u32 = 6u;
const COLUMN_FLAGS: u32 = 0u;
const COLUMN_ROWS: u32 = 1u;
// Where the column's page table starts in the program. A sampled column has cursors here instead.
const COLUMN_TABLE: u32 = 2u;
// Where the page table of an f64 column's low words starts; NONE for an f32 column.
const COLUMN_LOW: u32 = 3u;
// The bits column mapping each row to a row of another table; NONE when it reads its own table.
const COLUMN_JOIN: u32 = 4u;
// A sampled column's f32 interpolation fraction from the frame at the shown coordinate to the next.
const COLUMN_T: u32 = 5u;
// Column flags. SAMPLED: values are samples over the axis. STEP: a sampled column holds each
// frame's value instead of interpolating. BITS: values are raw u32 words, such as row indices.
const SAMPLED: u32 = 1u;
const STEP: u32 = 2u;
const BITS: u32 = 4u;

// Rows per page, also as a shift and a mask. Data columns, a paged table's slots, and each mark's
// rows are stored in pages, and marks evaluate their rows page by page.
const PAGE_BITS: u32 = 12u;
const PAGE_MASK: u32 = 4095u;
const PAGE_ROWS: u32 = 4096u;
// Items per step of a dispatch's second dimension: 256 workgroups of 256. Dispatches too large for
// one dimension use it (see `item`).
const DISPATCH_ROWS: u32 = 65536u;
// Flag on a listed row block whose state words start over. Evaluation zeroes those rows' words
// before any channel runs.
const FRESH: u32 = 0x80000000u;

// Words per run in a mark's run list at `mark.row_runs`, after the run count: the run's first drawn
// row, the held row it starts at, and its tile's fade flags (FADE_IN, FADE_OUT).
const RUN_WORDS: u32 = 3u;
// A drawn row's word, written by `expand_runs`: its held row in the low 30 bits, and flags for a
// tile fading in or out.
const DRAWN_ROW: u32 = 0x3fffffffu;
const DRAWN_ENTERING: u32 = 0x40000000u;
const DRAWN_LEAVING: u32 = 0x80000000u;

// The item index of invocation `id`. A dispatch too large for one dimension adds `DISPATCH_ROWS`
// items per step along the second.
fn item(id: vec3u) -> u32 {
    return id.y * DISPATCH_ROWS + id.x;
}

// How each word of a row eases during a transition. KEEP: no channel stores it, so it is left
// unchanged. SNAP: shows the evaluated value at once. NUMBER, COLOR: mixed from the old value.
// POSITION: a position's high word, moved by its offset from the old position.
const BLEND_KEEP: u32 = 0u;
const BLEND_SNAP: u32 = 1u;
const BLEND_NUMBER: u32 = 2u;
const BLEND_COLOR: u32 = 3u;
const BLEND_POSITION: u32 = 4u;

// Points per piece of a geometry column, as a shift and a mask. Each point is an x and a y word. A
// piece holds the points of a group of a page's rows, so rewriting a row rewrites only its group's
// piece. A row with more points than a piece spans consecutive pieces.
const POINT_BITS: u32 = 12u;
const POINT_MASK: u32 = 4095u;
// Words per page in a geometry column's table:
// 0: the block of the page's row table, two words per row. The first word is
//    `piece << POINT_BITS | first`, where `piece` indexes the page's pieces and `first` is the
//    row's first point in that piece. The second word is the row's point count.
// 1: where the page's piece list starts, relative to the column's table.
// 2: the page's point count.
// 3: the page's row count.
const PATH_PAGE_WORDS: u32 = 4u;

// Words per end of an edge or face mark, at `mark.ends` in the program. An end's vertices are rows
// of the vertex mark that draws the end's table.
// STATE, STRIDE: that vertex mark's state page table (NONE when no vertex mark draws the table) and
//   its words per row.
// SLOTS: the end table, which maps a place to a held row (see `held_of`). NONE unless the table is
//   paged.
// NORMALS: the page table of the face normals summed at its rows; NONE when no face sums them.
// COLUMN: the program column of the reference field naming the end's rows; NONE when the end is the
//   row's own vertex, as for a pole.
// The end pass writes the held row of end `k` into the row's kind word `k`.
const END_WORDS: u32 = 5u;
const END_STATE: u32 = 0u;
const END_STRIDE: u32 = 1u;
const END_SLOTS: u32 = 2u;
const END_NORMALS: u32 = 3u;
const END_COLUMN: u32 = 4u;

// Words of the face normal sum at a vertex row: x, y, and z in fixed point.
const NORMAL_WORDS: u32 = 3u;

// Vertex state words. POSITION is four words: the high parts of x and y, then their low parts. HALF
// is two words: the marker's half width and half height.
const VERTEX_WORDS: u32 = 12u;
const VERTEX_POSITION: u32 = 0u;
const VERTEX_COLOR: u32 = 4u;
const VERTEX_STATUS: u32 = 5u;
const VERTEX_HALF: u32 = 6u;
const VERTEX_ELEVATION: u32 = 8u;
// How many groups contain a group row. Containers tint by it.
const VERTEX_DEPTH: u32 = 9u;
// The range of CSS pixels the marker's half size is clamped to, packed by `pack_range`. It is the
// vertex mark's range, so edges ending at the vertex stop at the outline it draws.
const VERTEX_RANGE: u32 = 10u;
const VERTEX_FLAGS: u32 = 11u;

// Edge state words. Every kind's flags word is its last word. FROM and TO are the held rows of the
// edge's two vertices, written by the end pass. TRAVEL is how far its comets have moved. No channel
// writes FROM, TO, or TRAVEL.
const EDGE_WORDS: u32 = 7u;
const EDGE_FROM: u32 = 0u;
const EDGE_TO: u32 = 1u;
const EDGE_COLOR: u32 = 2u;
const EDGE_WIDTH: u32 = 3u;
const EDGE_FLOW: u32 = 4u;
const EDGE_TRAVEL: u32 = 5u;
const EDGE_FLAGS: u32 = 6u;

// Words per port of a vertex mark, at `mark.port_info` in the program: its code, its shape, the
// program column of its reference field, and its label's atlas rectangle as two corner words. A
// code holds the side in bits 0-1, the port's index on that side in bits 2-9, the number of ports
// on that side in bits 10-17, and the `PORT_OUTPUT` bit.
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
// Height of a group's header band, in label sizes. The group's title sits in it.
const HEADER_BAND: f32 = 1.8;
// Largest arc a geodesic segment spans, in degrees.
const GEODESIC_STEP: f32 = 2.0;
// Most segments a path between two ends uses, along a great circle or bowed into a lane.
const MAX_PIECES: u32 = 64u;
// Fewest segments a path bowed into a lane uses.
const BOW_PIECES: u32 = 16u;
// Widest spread, in lanes, of a family of edges joining the same two vertices. Larger families pack
// their lanes closer.
const FAMILY_LANES: f32 = 8.0;

// Face state words. A, B, and C are the held rows of the corner vertices, written by the end pass.
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

// Label words among a labeled mark's extra words: text code (missing for no label) and color.
const LABEL_WORDS: u32 = 2u;
const LABEL_CODE: u32 = 0u;
const LABEL_COLOR: u32 = 1u;

// Each text run is set once, at a size of `TEXT_BASE` atlas texels, as a distance field reaching
// `TEXT_SPREAD` texels past the text's edge.
const TEXT_BASE: f32 = 32.0;
const TEXT_SPREAD: f32 = 8.0;
// Words per text run at the start of the fields buffer, for runs whose distance field the GPU
// computes: where its coverage starts, the coverage's width and height, where its column minima
// start, where its field starts, and the field's row pitch in words.
const FIELD_COVERAGE: u32 = 0u;
const FIELD_WIDTH: u32 = 1u;
const FIELD_HEIGHT: u32 = 2u;
const FIELD_COLUMNS: u32 = 3u;
const FIELD_AT: u32 = 4u;
const FIELD_ROW: u32 = 5u;
const FIELD_WORDS: u32 = 6u;

// Most text codes a mark asks the host to set per texts pass.
const WANTED: u32 = 64u;

// Row state flags, in the last word of each row's kind words.
const VISIBLE: u32 = 1u;
// The row has a position, from its data or, in a diagram, from its sheet.
const PLACED: u32 = 2u;
const DASH: u32 = 4u;
// During a transition, a row that appears fades in, and one that disappears or left fades out.
const FADE_IN: u32 = 8u;
const FADE_OUT: u32 = 16u;
// The row entered with this change, so it has no old state to ease from.
const ENTERING: u32 = 32u;
// The vertex's size is in position units, or it has its own height. Any mark reading the vertex
// needs these to compute its size in pixels.
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

// Path kinds, the source of a stroke's points. ENDS: two vertices, joined straight, along a great
// circle, or through bends. TRACE: samples across the axis. GEOMETRY: a geometry column's points.
// Faces use ENDS for their three vertices; areas use GEOMETRY, three points per triangle.
const PATH_ENDS: u32 = 0u;
const PATH_TRACE: u32 = 1u;
const PATH_GEOMETRY: u32 = 2u;
// A pole, from each row's own vertex down to the ground below it.
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
// A vertex mark whose blocks and groups drop shadows onto a diagram's sheet.
const SHADOW: u32 = 256u;
// A vertex mark whose rows contain other rows. Its rows draw as containers.
const GROUP: u32 = 512u;

// Focus bits per row. SELECTED, HOVERED, and END (an end of a selected or hovered edge) make a row
// lit, and the focus draw redraws lit rows over everything. FIT marks the rows a fit measures.
const SELECTED: u32 = 1u;
const HOVERED: u32 = 2u;
const FIT: u32 = 4u;
const END: u32 = 8u;
const LIT: u32 = 11u;

// Words per mark in the extents buffer, as order-preserving bits (`ordered`): the complements of
// the least x, y, and z, then the greatest x, y, and z.
const EXTENT_WORDS: u32 = 6u;

// Probe buffer words. KEY: the least hit key (distance, then the mark drawn last). INSTANCE: the
// hit instance plus one. DEPTH, X, Y: where the hit lies. UNDER: the nearest depth drawn around the
// probe. ROW, SEGMENT: the hit's held row and part.
const PROBE_KEY: u32 = 0u;
const PROBE_INSTANCE: u32 = 1u;
const PROBE_DEPTH: u32 = 2u;
const PROBE_X: u32 = 3u;
const PROBE_Y: u32 = 4u;
const PROBE_UNDER: u32 = 5u;
const PROBE_ROW: u32 = 6u;
const PROBE_SEGMENT: u32 = 7u;
// Where a located row lies on screen, and whether it shows. Query results follow the probe's
// `PROBE_WORDS` words.
const PROBE_LOCATE_X: u32 = 8u;
const PROBE_LOCATE_Y: u32 = 9u;
const PROBE_LOCATED: u32 = 10u;
const PROBE_WORDS: u32 = 12u;

// Probe program steps, chosen by its step uniform: the hover's three, the queries' three, then the
// depth under the probe.
const STEP_NEAREST: u32 = 0u;
const STEP_TOPMOST: u32 = 1u;
const STEP_DESCRIBE: u32 = 2u;
const STEP_HITS: u32 = 3u;
const STEP_BOXED: u32 = 4u;
const STEP_LOCATE: u32 = 5u;
const STEP_UNDER: u32 = 6u;
const STEPS: u32 = 7u;

// Steps of the expression machine's `evaluate`, chosen by its step uniform: run a mark's channels,
// run the reductions that fit its domains, or resolve its rows' ends to held rows.
const STEP_CHANNELS: u32 = 0u;
const STEP_REDUCE: u32 = 1u;
const STEP_ENDS: u32 = 2u;
// Words per query hit: held row, distance in 1/64 CSS pixel, part, screen x and y, and depth.
const HIT_WORDS: u32 = 6u;

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
// The color a colormap gives a missing value.
const THEME_MISSING: u32 = 8u;
// A fully transparent color, which a missing status draws.
const THEME_CLEAR: u32 = 9u;
// A group container's fill color.
const THEME_GROUP: u32 = 10u;
// Diagram style. OUTLINE: the border color of blocks and groups, clear for none. CORNER, PORT_SIZE,
// LIFT: the corner radius, port width, and how far a block's shadow falls, in length units.
const THEME_OUTLINE: u32 = 11u;
const THEME_CORNER: u32 = 12u;
const THEME_PORT_SIZE: u32 = 13u;
const THEME_LIFT: u32 = 14u;
const THEME_SLOTS: u32 = 16u;

// The unit of comet spacing and length: the space's length unit, position units, or CSS pixels.
const FLOW_LENGTHS: u32 = 0u;
const FLOW_UNITS: u32 = 1u;
const FLOW_PX: u32 = 2u;

// Backdrop grids.
const GRID_OFF: u32 = 0u;
const GRID_LINES: u32 = 1u;
const GRID_DOTS: u32 = 2u;

// List header words. ITEMS: the item count. COUNTS, SUMS, ENTRIES: where the per-item counts, the
// block sums, and the entries start. The scan turns the counts in place into each item's first
// entry, followed by the total.
const LIST_ITEMS: u32 = 0u;
const LIST_COUNTS: u32 = 1u;
const LIST_SUMS: u32 = 2u;
const LIST_ENTRIES: u32 = 3u;
// Indirect draw arguments: vertices, instances (the kept entries), first vertex, first instance.
const LIST_DRAW: u32 = 4u;
// Indirect dispatch arguments: workgroups over the kept entries, 1, 1.
const LIST_DISPATCH: u32 = 8u;
// How many entries the list keeps. Entries past it are counted but not written.
const LIST_KEPT: u32 = 11u;
const LIST_HEADER: u32 = 12u;
// Counts per workgroup of the scan.
const SCAN_WORKGROUP: u32 = 256u;


// Per-frame values every draw and dispatch reads.
struct Frame {
    center_hi: vec2f,
    center_lo: vec2f,
    pointer: vec2f,
    // The probe's point in CSS pixels. `query` holds the running query's box (`boxed`), point and
    // radius (`hits`), or drawn row (`locate`).
    probe: vec2f,
    query: vec4f,
    // Direction toward the key light that shades faces. It turns with the camera.
    light: vec4f,
    space: u32,
    globe: f32,
    mercator_y: f32,
    probe_radius: f32,
    elapsed: f32,
    selecting: u32,
    // 1 while a fit measures only the rows marked FIT.
    fitting: u32,
    // 1 when the target stores linear color (an sRGB format), so outputs convert from sRGB.
    linear: u32,
    glow: f32,
    dim: f32,
    dash: f32,
    // Comets: spacing and tail length in `flow_unit`, head width in CSS pixels, and the seconds
    // they travel this frame.
    flow_spacing: f32,
    flow_length: f32,
    flow_width: f32,
    flow_unit: u32,
    flow_step: f32,
    // How far a lane bows at its middle, as a fraction of its edge's length.
    bow: f32,
    // Scale factor for a hovered vertex sized in CSS pixels.
    grow: f32,
    shading: f32,
    arrow: f32,
    halo: f32,
    // CSS pixels between a group's members and its outline. It is also the title's inset.
    group_padding: f32,
    // CSS pixels per length unit: per position unit in a diagram, 1 elsewhere. The theme lengths
    // above are already in CSS pixels, except comet spacing and length.
    unit: f32,
    zoom: f32,
    // A plane's grid: kind, pitch in position units, and the world distance from the center at
    // which it has faded out (0 for no fade). `graticule` is 1 if the earth draws a graticule.
    grid_kind: u32,
    grid_pitch: f32,
    grid_fade: f32,
    graticule: u32,
    hover: vec4f,
    selected: vec4f,
    flow: vec4f,
    background: vec4f,
    // The earth's ground color.
    ground: vec4f,
    grid_color: vec4f,
    // Direction toward the sun in earth-fixed coordinates (x toward 0° longitude on the equator, z
    // toward the north pole), with night's brightness in w. All zero when daylight is off.
    sun: vec4f,
    // Color of the atmosphere around the globe; clear when the earth has none.
    atmosphere: vec4f,
    // Shadow color of a diagram's blocks and groups.
    shadow: vec4f,
    theme: array<vec4u, 4>,
}

// The view's camera, which every pass projects through.
struct Eye {
    clip_from_world: mat4x4f,
    world_from_clip: mat4x4f,
    // The camera's position in world units.
    position: vec4f,
    // The target's size in CSS pixels.
    size: vec2f,
    px_per_unit: vec2f,
    // Target pixels per CSS pixel.
    pixel_ratio: f32,
}

// One mark's parameters, at a 256-byte aligned dynamic offset.
struct Mark {
    index: u32,
    kind: u32,
    primitive: u32,
    // Drawn rows, and the rows after them that left and are fading out.
    rows: u32,
    exits: u32,
    // Held rows: the rows the mark keeps evaluated on the GPU, leaving rows included. For a table
    // drawn whole, these are its rows. For a paged table, they are the rows of its slots. Every
    // per-row word belongs to a held row, in pages of `PAGE_ROWS` held rows listed by page tables
    // in the program.
    held: u32,
    // Where the program lists the drawn rows as runs of held rows, and where the lists buffer holds
    // each drawn row's word expanded from them. `drawn` is NONE when drawn row `i` is held row `i`,
    // as for a table drawn whole.
    row_runs: u32,
    drawn: u32,
    // Fade progress of tiles entering and leaving, from 0 to 1.
    reveal: f32,
    // The page table of each row's words: `stride` kind words, then `extras` extra words.
    state: u32,
    stride: u32,
    extras: u32,
    // During a transition, the page tables of each row's words as shown when it began (`frozen`)
    // and as its channels now evaluate them (`settled`); NONE otherwise. `motion` is its eased
    // progress, from 0 to 1.
    frozen: u32,
    settled: u32,
    motion: f32,
    // Where the program holds each row word's blend (`BLEND_*`), one word per row word.
    blends: u32,
    // Where the blocks buffer lists the row blocks a dispatch covers: at `block` those its channels
    // evaluate, and at `end_block` those whose ends the end pass resolves.
    block: u32,
    end_block: u32,
    // The page table of each row's focus word.
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
    // Marker inputs: how many, the extra word of the first, and where the marker's palette starts
    // in the program.
    inputs: u32,
    input: u32,
    palette: u32,
    // The program column a line traces, or NONE.
    trace: u32,
    // Segments per row when every row has the same count; NONE when the segment list numbers them.
    per_row: u32,
    // Where the mark's segment list header starts in the lists buffer, and where the running
    // query's results for the mark start in the probe buffer.
    list: u32,
    query: u32,
    // Where the mark's remap words start, while `gather` freezes its transition.
    remap: u32,
    // The rows the focus draw lights: where they start in the focused buffer, how many, and the
    // instances per row (one for a point, the most segments of any lit path).
    focused: u32,
    focused_rows: u32,
    pieces: u32,
    // Program columns, NONE when absent: the geometry a stroke's path follows (a route or
    // bends), that geometry at the start of the transition, and each edge's lane among edges
    // joining the same two vertices.
    geometry: u32,
    frozen_geometry: u32,
    lane: u32,
    // Where the program lists the mark's ports (`PORT_WORDS` each), and how many each row has.
    port_info: u32,
    ports: u32,
    // `label`: the extra word holding the label's code, or NONE. In the labels buffer: `runs`, the
    // run table (two corner words per code, both 0 until the text is set); `wanted`, a count
    // followed by the codes to set, each once; `seen`, a bit per code the texts pass met: a set
    // text shown in view, or one not set that it asked for. The two sizes are in length units.
    label: u32,
    runs: u32,
    wanted: u32,
    seen: u32,
    label_size: f32,
    port_label_size: f32,
    // The range of CSS pixels the mark's size is clamped to at any zoom: a vertex's half size, or a
    // stroke's width.
    size_min: f32,
    size_max: f32,
    // A vertex mark's page table of the face normals summed at its rows; NONE when no face reads
    // them.
    normals: u32,
}

// An overlay sprite in CSS pixels: a line, box, fill, or run of text, drawn over the marks.
struct Sprite {
    // A line's ends, or opposite corners of a rectangle (top left and bottom right for text).
    a: vec2f,
    b: vec2f,
    // A text's rectangle in the atlas, texels.
    uv: vec4f,
    color: vec4f,
    width: f32,
    kind: u32,
}

// One panel of a shot, composed into output bytes: RGBA rows for an image, or NV12 planes for a
// video encoder. Sizes are in the shot's pixels.
struct Compose {
    // The panel's top-left position in the picture, and its size.
    origin: vec2u,
    size: vec2u,
    // The picture's size.
    picture: vec2u,
    // Where NV12's interleaved chroma plane starts, in words.
    chroma: u32,
    // Whether pixels keep their alpha, for an image of a transparent shot.
    alpha: u32,
    // The color where no panel draws, as straight-alpha sRGB.
    background: vec4f,
}
