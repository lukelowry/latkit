// Shared helpers for statically compiled expression kernels and row transitions.

import package::lib::types::{
    NONE, MISSING, MISSING_COLOR, STACK, VISIBLE, PLACED, FADE_IN, FADE_OUT, ENTERING, PAGE_ROWS, FRESH,
    BLEND_KEEP, BLEND_NUMBER, BLEND_COLOR, BLEND_POSITION,
    VERTEX_POSITION, VERTEX_ELEVATION, VERTEX_FLAGS, VERTEX_HALF, VERTEX_RANGE, HALF_UNITS, OWN_HEIGHT, SIZED,
    MARK_VERTICES, OP_SELECTED, OP_HOVERED, OP_RELATED, OP_POINTER,
};
import package::lib::bind::{frame, program, mark, word, pages, theme_word};
import package::lib::state::{travel_words, pack_range, record_at};
import package::lib::read::{column_value, missing, missing_bits};
import package::lib::focus::{is_selected, is_hovered, is_related};
import package::lib::color::{scale, colormap};
import package::lib::project::{project, to_screen};
import package::lib::reduce::{ordered, unordered};
import package::lib::words::{word_read, word_four, word_quad};
import package::lib::types::STATE_WORDS;

// Two words per fitted domain: the complement of its least value's order-preserving bits, then its
// greatest value's bits (see `lib/reduce.wesl`).
@group(2) @binding(4) var domains: texture_2d_array<u32>;

fn domain_word(at: u32) -> u32 { return word_read(domains, at); }

// Per-invocation registers. All consumers share one evaluated row; endpoint geometry never
// re-runs channels. The compiler's eight marker inputs plus a label fit within this capacity.
const ROW_WORDS: u32 = STATE_WORDS;
var<private> row_words: array<u32, ROW_WORDS>;
struct Reduction { index: u32, range: vec2u }

// Whether the pipeline's marks read view state: selection, hover, the pointer, or the zoom. Only
// pipelines made for marks that do compile those reads.
override VIEWED: bool = true;

// The mark's live row count. Rows past it left and are fading out.
fn live() -> u32 {
    return mark.held - mark.exits;
}

fn constant(i: u32) -> u32 {
    return program(mark.constants + i);
}

fn constant_float(i: u32) -> f32 {
    return bitcast<f32>(constant(i));
}

// The domain whose record starts at constant `at`: a fitted flag, least, greatest, and reduction
// index. A fitted domain reads its reduction, and is (0, 1) while no row has a value.
fn domain(at: u32) -> vec2f {
    if constant(at) == 0u {
        return vec2f(constant_float(at + 1u), constant_float(at + 2u));
    }
    let d = 2u * (mark.domains + constant(at + 3u));
    let high = domain_word(d + 1u);
    if high == 0u {
        return vec2f(0.0, 1.0);
    }
    return vec2f(unordered(~domain_word(d)), unordered(high));
}

// Where word `w` of `row` lies, given page table `table`. Words from `mark.stride` on are extra
// words.
fn word_in(table: u32, row: u32, w: u32) -> u32 {
    return record_at(table, mark.stride + mark.extras, row) + w;
}

fn easing() -> bool {
    return mark.frozen != NONE;
}

// Where channels store word `w` of `row`: in the settled words during a transition (which `ease`
// reads), else in the state words.
fn word_at(row: u32, w: u32) -> u32 {
    return word_in(select(mark.state, mark.settled, easing()), row, w);
}

fn load(row: u32, w: u32) -> u32 {
    return row_words[w];
}

fn store(row: u32, w: u32, value: u32) {
    row_words[w] = value;
}

// Word `w` of `row` as drawn when the transition began.
fn was(row: u32, w: u32) -> u32 {
    return word(word_in(mark.frozen, row, w));
}

// Word `w` of `row` as its channels evaluated it: the value the transition settles on.
fn settled(row: u32, w: u32) -> u32 {
    return word(word_in(mark.settled, row, w));
}

// Where the shown value of word `w` of `row` lies.
fn shown_at(row: u32, w: u32) -> u32 {
    return word_in(mark.state, row, w);
}

// Whether `row` entered with this change, leaving nothing to ease from.
fn entering(row: u32, flags: u32) -> bool {
    return (was(row, flags) & ENTERING) != 0u;
}

fn number(x: u32) -> f32 {
    return bitcast<f32>(x);
}

fn bits(x: f32) -> u32 {
    return bitcast<u32>(x);
}

fn truth(x: bool) -> u32 {
    return bits(f32(x));
}

// CSS pixels from a vertex to the pointer.
fn pointer_distance(row: u32) -> f32 {
    let hi = vec2f(number(load(row, VERTEX_POSITION)), number(load(row, VERTEX_POSITION + 1u)));
    let lo = vec2f(number(load(row, VERTEX_POSITION + 2u)), number(load(row, VERTEX_POSITION + 3u)));
    let z = number(load(row, VERTEX_ELEVATION));
    return distance(to_screen(project(hi, lo, z)), frame.pointer);
}

// The view state op `code` reads for `row`: whether it is selected, hovered, or one reference from
// a selected or hovered row, its distance to the pointer, or the zoom.
fn viewed(code: u32, row: u32) -> u32 {
    if !VIEWED {
        return MISSING;
    }
    switch code {
        case OP_SELECTED: { return truth(is_selected(row)); }
        case OP_HOVERED: { return truth(is_hovered(row)); }
        case OP_RELATED: { return truth(is_related(row)); }
        case OP_POINTER: { return bits(pointer_distance(row)); }
        default: { return bits(frame.zoom); }
    }
}

fn fallback(x: u32, slot: u32) -> u32 {
    if slot != NONE && missing_bits(x) {
        return theme_word(slot);
    }
    return x;
}

// A number eased from the value `row` showed. A row that entered shows its new value at once, and
// its draw grows it in.
fn ease_number(row: u32, w: u32, now: u32, flags: u32) -> u32 {
    if !easing() || missing_bits(now) || entering(row, flags) {
        return now;
    }
    let start = was(row, w);
    if missing_bits(start) {
        return now;
    }
    return bits(mix(number(start), number(now), mark.motion));
}

fn ease_color(row: u32, w: u32, now: u32, flags: u32) -> u32 {
    let before = was(row, w);
    // A missing color, which blends an edge's ends, changes at once.
    if !easing() || entering(row, flags) || now == MISSING_COLOR || before == MISSING_COLOR {
        return now;
    }
    return pack4x8unorm(mix(unpack4x8unorm(before), unpack4x8unorm(now), mark.motion));
}

// A position's high word `w` (x or y), moved by the remaining offset from the old position, so the
// destination keeps its precision. Its low word, two words later, shows as evaluated.
fn ease_position(row: u32, w: u32, now: u32, flags: u32) -> u32 {
    if !easing() || entering(row, flags) || (was(row, flags) & PLACED) == 0u {
        return now;
    }
    let now_lo = number(settled(row, w + 2u));
    let offset = (number(was(row, w)) - number(now)) + (number(was(row, w + 2u)) - now_lo);
    return bits(number(now) + offset * (1.0 - mark.motion));
}

// The flags `row` shows during a transition: as evaluated, except that a row whose visibility
// flipped stays drawn and fades. It fades in if it became visible or entered, and out if it stopped
// being visible.
fn faded(row: u32, flags: u32) -> u32 {
    let now = settled(row, flags) & ~(FADE_IN | FADE_OUT);
    let fresh = entering(row, flags);
    let before = fresh || (was(row, flags) & VISIBLE) != 0u;
    let on = (now & VISIBLE) != 0u;
    if on && (fresh || !before) {
        return now | FADE_IN;
    }
    if !on && before {
        return now | VISIBLE | FADE_OUT;
    }
    return now;
}

// Sets or clears `bit` of the flags at word `w`. It also clears `ENTERING` and the fade bits, which
// only transitions set.
fn store_flag(row: u32, w: u32, bit: u32, on: bool) {
    let stored = load(row, w);
    store(row, w, select(stored & ~bit, stored | bit, on) & ~(ENTERING | FADE_IN | FADE_OUT));
}

// Stores a position (from data, or from the scene's layout) as the high and low parts of x and y, and sets `PLACED`. A missing x or y clears `PLACED` instead.
fn position(row: u32, w: u32, x: vec2u, y: vec2u) {
    let flags = w + VERTEX_FLAGS - VERTEX_POSITION;
    if missing_bits(x.x) || missing_bits(y.x) {
        store(row, flags, load(row, flags) & ~PLACED);
        return;
    }
    store(row, w, x.x);
    store(row, w + 1u, y.x);
    store(row, w + 2u, x.y);
    store(row, w + 3u, y.y);
    store(row, flags, load(row, flags) | PLACED);
}



fn load_words(at: u32) {
    let width = min(mark.stride + mark.extras, ROW_WORDS);
    for (var w = 0u; w < width; w += 4u) {
        let values = word_four(pages, at + w);
        row_words[w] = values.x;
        row_words[w + 1u] = values.y;
        row_words[w + 2u] = values.z;
        row_words[w + 3u] = values.w;
    }
}

fn load_row(row: u32, clear: bool) {
    // Private registers start at zero. Loading only live words avoids unrolling the maximum
    // record size for small marks and leaves unused output lanes deterministically zero.
    if clear { return; }
    load_words(word_at(row, 0u));
}



fn finish_channels(row: u32) {
    if mark.kind == MARK_VERTICES {
        let flags = VERTEX_FLAGS;
        let units = select(0u, HALF_UNITS, (mark.units & (1u << VERTEX_HALF)) != 0u);
        let own = select(0u, OWN_HEIGHT, (mark.flags & SIZED) != 0u);
        store(row, flags, (load(row, flags) & ~(HALF_UNITS | OWN_HEIGHT)) | units | own);
        store(row, VERTEX_RANGE, pack_range(vec2f(mark.size_min, mark.size_max)));
    }
}

// Replaced with straight-line code for the compiled program before module creation.
fn run(row: u32, start: u32, end: u32) -> Reduction { return Reduction(NONE, vec2u(0u)); }
fn channels(row: u32, clear: bool) { load_row(row, clear); finish_channels(row); }

// Kernel operations whose implementations live in other modules. These named exports keep
// their dependencies available without retaining unrelated geometry or an interpreter.
fn field_value(column: u32, row: u32) -> vec2u { return column_value(column, row); }
fn scale_value(value: f32, domain: vec2f, range: vec2f) -> f32 { return scale(value, domain, range); }
fn color_value(layer: u32, count: u32, value: f32, domain: vec2f) -> u32 { return colormap(layer, count, value, domain); }
fn ordered_value(value: f32) -> u32 { return ordered(value); }
