// One fragment evaluates one row and writes four of its words, the plane starting at
// `state_step.word`. Each plane is its own draw: ANGLE on D3D11 builds a pixel shader for the first
// color target only, and builds one for more targets on the browser's GPU thread at the first draw.
// Packing these planes back into the existing row layout preserves every page table and consumer,
// including shared endpoints, while scratch stays bounded to a row batch.
import package::lib::types::{
    StateStep, WORD_WIDTH, PAGE_ROWS, PAGE_BITS, PAGE_MASK, NONE, FRESH, ENTERING, FADE_IN, FADE_OUT,
    END_WORDS, END_COLUMN, END_SLOTS, END_STATE, BLEND_KEEP, BLEND_NUMBER, BLEND_COLOR, BLEND_POSITION,
    STATE_WORDS,
};
import package::lib::bind::{frame, program, mark, word};
import package::lib::words::{word_read, fullscreen};
import package::lib::state::{record_at, travel_words};
import package::lib::read::{bits_value, missing};
import package::lib::ends::held_of;
import package::lib::evaluate::{
    row_words, k_channels, k_output, live, load_row, k_load_words, k_run, was, settled, shown_at,
    ease_number, ease_color, ease_position, faded, easing, number, bits,
};

@group(2) @binding(12) var remap_words: texture_2d_array<u32>;
@group(2) @binding(16) var blocks: texture_2d_array<u32>;
@group(2) @binding(17) var<uniform> state_step: StateStep;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }

fn row_of(position: vec4f) -> vec2u {
    let local = u32(position.y) * WORD_WIDTH + u32(position.x);
    // The last raster row may be partial. Do not evaluate padding in a short retained page.
    if local >= state_step.rows { return vec2u(NONE, 0u); }
    let i = local + state_step.first;
    if state_step.block == NONE { return vec2u(i, 0u); }
    let block = word_read(blocks, state_step.block + i / PAGE_ROWS);
    return vec2u((block & ~FRESH) * PAGE_ROWS + i % PAGE_ROWS, block & FRESH);
}

fn output() -> vec4u {
    return k_output(state_step.word);
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
    let id = row_of(position);
    let row = id.x;
    if row >= mark.held { return output(); }
    if row < live() { k_channels(row, id.y != 0u && !easing(), state_step.channels); }
    else { shown(row); }
    return output();
}

@fragment
fn ends(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(position).x;
    shown(row);
    if row < mark.held { resolve_row(row); }
    return output();
}

@fragment
fn ease(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(position).x;
    shown(row);
    if row < mark.held { ease_row(row); }
    return output();
}

@fragment
fn travel(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(position).x;
    shown(row);
    if row < mark.held { travel_row(); }
    return output();
}

@fragment
fn carry(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(position).x;
    shown(row);
    let at = travel_words().x;
    if row < mark.held && at != NONE && easing() { row_words[at] = was(row, at); }
    return output();
}

@fragment
fn freeze(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(position).x;
    shown(row);
    if row < mark.held { freeze_row(row); }
    return output();
}

// Two fitted domains per invocation: domain `state_step.word / 2` and the next. Reduction output
// is separate from the row registers, so pointer-dependent domains see the same state even after
// another domain has been evaluated.
@fragment
fn reduce(@builtin(position) position: vec4f) -> @location(0) vec4u {
    let row = row_of(position).x;
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
