// One fragment evaluates one row and writes one texel of it: four of its words. A batch of rows is
// rasterized as the arena stores rows, each row's texels side by side, so one pass writes the batch
// and its pages copy home as they are. A pass has one color target: ANGLE on D3D11 builds a pixel
// shader for the first target only, and builds one for more targets on the browser's GPU thread at
// the first draw. Scratch stays bounded to a row batch.
import package::lib::types::{
    StateStep, WORD_WIDTH, PAGE_ROWS, PAGE_BITS, PAGE_MASK, NONE, FRESH, ENTERING, FADE_IN, FADE_OUT,
    END_WORDS, END_COLUMN, END_SLOTS, END_STATE, BLEND_KEEP, BLEND_NUMBER, BLEND_COLOR, BLEND_POSITION,
    STATE_WORDS, MARK_VERTICES, VERTEX_FLAGS, VERTEX_RANGE,
};
import package::lib::bind::{frame, program, mark, word, pages};
import package::lib::words::{word_read, word_quad, lane_word, fullscreen};
import package::lib::state::{record_at, travel_words};
import package::lib::read::{bits_value, missing};
import package::lib::ends::held_of;
import package::lib::evaluate::{
    row_words, k_channels, k_output, live, load_row, k_load_words, k_run, was, settled, shown_at, word_at,
    ease_number, ease_color, ease_position, faded, easing, number, bits,
};

@group(2) @binding(12) var remap_words: texture_2d_array<u32>;
@group(2) @binding(16) var blocks: texture_2d_array<u32>;
@group(2) @binding(17) var<uniform> state_step: StateStep;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }

// The texel a fragment writes, counted across the batch.
fn texel_of(position: vec4f) -> u32 {
    return u32(position.y) * WORD_WIDTH + u32(position.x);
}

// Row `local` of the batch, and whether its block is fresh. `NONE` past the batch's rows: the last
// raster row may be partial, and the padding of a short retained page is not evaluated.
fn row_of(local: u32) -> vec2u {
    if local >= state_step.rows { return vec2u(NONE, 0u); }
    let i = local + state_step.first;
    if state_step.block == NONE { return vec2u(i, 0u); }
    let block = word_read(blocks, state_step.block + i / PAGE_ROWS);
    return vec2u((block & ~FRESH) * PAGE_ROWS + i % PAGE_ROWS, block & FRESH);
}

// What a fragment writes: its row, whether the row's block is fresh, and the first of its four
// words in the row.
fn words_of(position: vec4f) -> vec3u {
    let per = (mark.stride + mark.extras) / 4u;
    let texel = texel_of(position);
    return vec3u(row_of(texel / per), 4u * (texel % per));
}

// The channels that store into the four words from `first`, or store a word that those read.
fn channels_of(first: u32) -> u32 {
    return lane_word(select(state_step.texels[0], state_step.texels[1], first >= 16u), (first / 4u) % 4u);
}

// Whether the four words from `first` hold a word `k_finish` writes: a vertex's flags or its size
// range, which follow the mark's uniforms whatever channels changed.
fn finished(first: u32) -> bool {
    let flags = VERTEX_FLAGS - VERTEX_FLAGS % 4u;
    let range = VERTEX_RANGE - VERTEX_RANGE % 4u;
    return mark.kind == MARK_VERTICES && (first == flags || first == range);
}

fn shown(row: u32) {
    if row >= mark.held { return; }
    k_load_words(shown_at(row, 0u));
}

fn resolve_row(row: u32) {
    if row >= live() { return; }
    for (var k = 0u; k < 2u; k++) {
        let e = mark.ends + END_WORDS * k;
        let column = program(e + END_COLUMN);
        var held = row;
        if column != NONE { held = held_of(program(e + END_SLOTS), bits_value(column, row)); }
        row_words[k] = select(held, NONE, program(e + END_STATE) == NONE);
    }
}

fn ease_row(row: u32) {
    let flags = mark.stride - 1u;
    if row >= live() {
        let travel = travel_words().x;
        for (var w = 0u; w < mark.stride; w++) {
            if w != travel { row_words[w] = was(row, w); }
        }
        row_words[flags] = (was(row, flags) & ~FADE_IN) | FADE_OUT;
        return;
    }
    for (var w = 0u; w < mark.stride + mark.extras; w++) {
        let blend = program(mark.blends + w);
        if blend == BLEND_KEEP { continue; }
        let now = settled(row, w);
        var value = now;
        switch blend {
            case BLEND_NUMBER: { value = ease_number(row, w, now, flags); }
            case BLEND_COLOR: { value = ease_color(row, w, now, flags); }
            case BLEND_POSITION: { value = ease_position(row, w, now, flags); }
            default: {}
        }
        row_words[w] = value;
    }
    row_words[flags] = faded(row, flags);
}

fn travel_row() {
    let words = travel_words();
    if words.x == NONE { return; }
    let flow = number(row_words[words.y]);
    let spacing = max(frame.flow_spacing, 1e-6);
    var moved = number(row_words[words.x]) + select(flow, 0.0, missing(flow)) * frame.flow_step;
    moved -= spacing * floor(moved / spacing);
    row_words[words.x] = bits(select(0.0, moved, moved >= 0.0 && moved <= spacing));
}

fn remap(at: u32) -> u32 { return word_read(remap_words, at); }

fn freeze_row(row: u32) {
    let header = mark.remap;
    let sources = remap(header + 2u);
    var source = select(NONE, row, row < remap(header + 1u));
    if sources != NONE { source = remap(sources + row); }
    let width = mark.stride + mark.extras;
    if source == NONE {
        for (var w = 0u; w < width; w++) { row_words[w] = select(0u, ENTERING, w == mark.stride - 1u); }
        return;
    }
    let at = remap(remap(header) + (source >> PAGE_BITS)) + (source & PAGE_MASK) * width;
    let ends = remap(header + 3u);
    for (var w = 0u; w < width; w++) {
        var value = word(at + w);
        let moves = select(NONE, remap(ends + min(w, mark.stride - 1u)), ends != NONE && w < mark.stride);
        if moves != NONE && value != NONE { value = select(NONE, remap(moves + 1u + value), value < remap(moves)); }
        row_words[w] = value;
    }
}

@fragment
fn evaluate(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = words_of(position);
    let row = at.x;
    if row >= mark.held { return vec4u(0u); }
    // A row that left keeps what it shows.
    if row >= live() { return word_quad(pages, shown_at(row, at.z)); }
    let clear = at.y != 0u && !easing();
    let channels = channels_of(at.z);
    // No changed channel writes these words, so they stay as they are: one read.
    if !clear && (channels & mark.mask) == 0u && !finished(at.z) { return word_quad(pages, word_at(row, at.z)); }
    k_channels(row, clear, channels);
    return k_output(at.z);
}

@fragment
fn ends(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = words_of(position);
    shown(at.x);
    if at.x < mark.held { resolve_row(at.x); }
    return k_output(at.z);
}

@fragment
fn ease(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = words_of(position);
    shown(at.x);
    if at.x < mark.held { ease_row(at.x); }
    return k_output(at.z);
}

@fragment
fn travel(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = words_of(position);
    shown(at.x);
    if at.x < mark.held { travel_row(); }
    return k_output(at.z);
}

@fragment
fn carry(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = words_of(position);
    shown(at.x);
    let travel = travel_words().x;
    if at.x < mark.held && travel != NONE && easing() { row_words[travel] = was(at.x, travel); }
    return k_output(at.z);
}

@fragment
fn freeze(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let at = words_of(position);
    shown(at.x);
    if at.x < mark.held { freeze_row(at.x); }
    return k_output(at.z);
}

// Two fitted domains per invocation: domain `state_step.word / 2` and the next. One fragment is
// one row. Reduction output is separate from the row registers, so pointer-dependent domains see
// the same state even after another domain has been evaluated.
@fragment
fn reduce(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(texel_of(position)).x;
    if row >= live() { return vec4u(0u); }
    load_row(row, false);
    let first = state_step.word / 2u;
    return vec4u(domain_range(row, first), domain_range(row, first + 1u));
}

// The range `row` gives fitted domain `domain`, or nothing past the mark's last.
fn domain_range(row: u32, domain: u32) -> vec2u {
    if domain >= mark.reductions { return vec2u(0u); }
    let range = mark.ranges + 2u * (mark.channels + domain);
    return k_run(row, program(range), program(range + 1u)).range;
}
