// The expression machine: each row of a mark runs the mark's channels, which store into the row's
// state words. All rows run the same instructions, so control flow stays uniform across a
// workgroup. A dispatch covers the row pages the mark lists: only the changed pages, when only some
// rows changed.
//
// Evaluation ignores transitions. During a transition, channels store into the settled words, and
// each frame `ease` computes what every row shows from its frozen and settled words by the mark's
// progress. Numbers and colors mix, positions move by their offset, rows whose visibility flipped
// fade, rows past the live ones (which left) fade out, and other words show as evaluated. Easing
// runs no channels. Every row here is a held row, whose words lie in pages listed by its mark's
// page tables. Resolving an edge's or face's vertices to held rows is a separate step
// (`lib/ends.wesl`), not a channel.

import package::lib::types::{
    NONE, MISSING, MISSING_COLOR, STACK, VISIBLE, PLACED, FADE_IN, FADE_OUT, ENTERING, PAGE_ROWS, FRESH, item,
    BLEND_KEEP, BLEND_NUMBER, BLEND_COLOR, BLEND_POSITION, STEP_REDUCE, STEP_ENDS,
    VERTEX_POSITION, VERTEX_ELEVATION, VERTEX_FLAGS, VERTEX_HALF, VERTEX_RANGE, HALF_UNITS, OWN_HEIGHT, SIZED,
    MARK_VERTICES, OP_CONST, OP_MISSING, OP_FIELD, OP_SELECTED, OP_HOVERED, OP_POINTER, OP_ELAPSED, OP_THEME, OP_ZOOM,
    OP_NEG, OP_NOT, OP_ABS, OP_SQRT, OP_SIN, OP_COS, OP_FLOOR, OP_LOG, OP_EXP,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MIN, OP_MAX, OP_MOD, OP_POW,
    OP_LT, OP_LE, OP_GT, OP_GE, OP_EQ, OP_NE, OP_AND, OP_OR,
    OP_SELECT, OP_SCALE, OP_COLORMAP, OP_STORE, OP_STORE_COLOR, OP_STORE_FLAG, OP_STORE_POSITION,
    OP_POSITION, OP_STORE_CODE, OP_REDUCE,
};
import package::lib::bind::{frame, program, mark, pages, theme_word};
import package::lib::state::{travel_words, pack_range, record_at};
import package::lib::read::{column_value, missing, missing_bits};
import package::lib::focus::{is_selected, is_hovered};
import package::lib::color::{scale, colormap};
import package::lib::project::{project, to_screen};
import package::lib::reduce::{ordered, unordered};
import package::lib::ends::resolve;

// Two words per fitted domain: the complement of its least value's order-preserving bits, then its
// greatest value's bits (see `lib/reduce.wesl`).
@group(2) @binding(4) var<storage, read_write> domains: array<atomic<u32>>;
// Each mark's row blocks a dispatch covers. At `mark.block`: the blocks its channels evaluate, with
// `FRESH` on those whose state words start over. At `mark.end_block`: the blocks whose ends are
// resolved.
@group(2) @binding(16) var<storage, read> blocks: array<u32>;
// The step a dispatch of `evaluate` runs: the mark's channels over its listed blocks, the
// reductions that fit its domains over every row, or end resolution over the blocks listed for it.
@group(2) @binding(17) var<uniform> step: u32;

// Whether the pipeline's marks read view state: selection, hover, the pointer, or the zoom. Only
// pipelines made for marks that do compile those reads.
override VIEWED: bool = true;

// The row invocation `id` evaluates: row `id.x` of the mark's `id.y`th listed page.
fn row_of(id: vec3u) -> u32 {
    return (blocks[mark.block + id.y] & ~FRESH) * PAGE_ROWS + id.x;
}

// Whether the state words of the row invocation `id` evaluates start over.
fn fresh(id: vec3u) -> bool {
    return (blocks[mark.block + id.y] & FRESH) != 0u;
}

// The mark's live row count. Rows past it left and are fading out.
fn live() -> u32 {
    return mark.held - mark.exits;
}

fn constant(i: u32) -> u32 {
    return program[mark.constants + i];
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
    let high = atomicLoad(&domains[d + 1u]);
    if high == 0u {
        return vec2f(0.0, 1.0);
    }
    return vec2f(unordered(~atomicLoad(&domains[d])), unordered(high));
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
    return pages[word_at(row, w)];
}

fn store(row: u32, w: u32, value: u32) {
    pages[word_at(row, w)] = value;
}

// Word `w` of `row` as drawn when the transition began.
fn was(row: u32, w: u32) -> u32 {
    return pages[word_in(mark.frozen, row, w)];
}

// Word `w` of `row` as its channels evaluated it: the value the transition settles on.
fn settled(row: u32, w: u32) -> u32 {
    return pages[word_in(mark.settled, row, w)];
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
    let at = word_at(row, VERTEX_POSITION);
    let hi = vec2f(bitcast<f32>(pages[at]), bitcast<f32>(pages[at + 1u]));
    let lo = vec2f(bitcast<f32>(pages[at + 2u]), bitcast<f32>(pages[at + 3u]));
    let z = bitcast<f32>(pages[word_at(row, VERTEX_ELEVATION)]);
    return distance(to_screen(project(hi, lo, z)), frame.pointer);
}

// The view state op `code` reads for `row`: whether it is selected or hovered, its distance to the
// pointer, or the zoom.
fn viewed(code: u32, row: u32) -> u32 {
    if !VIEWED {
        return MISSING;
    }
    switch code {
        case OP_SELECTED: { return truth(is_selected(row)); }
        case OP_HOVERED: { return truth(is_hovered(row)); }
        case OP_POINTER: { return bits(pointer_distance(row)); }
        default: { return bits(frame.zoom); }
    }
}

fn unary(code: u32, a: f32) -> f32 {
    switch code {
        case OP_NEG: { return -a; }
        case OP_NOT: { return f32(a <= 0.5); }
        case OP_ABS: { return abs(a); }
        case OP_SQRT: { return sqrt(a); }
        case OP_SIN: { return sin(a); }
        case OP_COS: { return cos(a); }
        case OP_FLOOR: { return floor(a); }
        case OP_LOG: { return log(a); }
        default: { return exp(a); }
    }
}

fn binary(code: u32, a: f32, b: f32) -> f32 {
    switch code {
        case OP_ADD: { return a + b; }
        case OP_SUB: { return a - b; }
        case OP_MUL: { return a * b; }
        case OP_DIV: { return a / b; }
        case OP_MIN: { return min(a, b); }
        case OP_MAX: { return max(a, b); }
        case OP_MOD: { return a - b * floor(a / b); }
        case OP_POW: { return pow(a, b); }
        case OP_LT: { return f32(a < b); }
        case OP_LE: { return f32(a <= b); }
        case OP_GT: { return f32(a > b); }
        case OP_GE: { return f32(a >= b); }
        case OP_EQ: { return f32(a == b); }
        case OP_NE: { return f32(a != b); }
        case OP_AND: { return f32(a > 0.5 && b > 0.5); }
        default: { return f32(a > 0.5 || b > 0.5); }
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
    if !easing() || entering(row, flags) {
        return now;
    }
    return pack4x8unorm(mix(unpack4x8unorm(was(row, w)), unpack4x8unorm(now), mark.motion));
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

// Stores a position (from data, or in a diagram from its sheet) as the high and low parts of x and
// y, and sets `PLACED`. A missing x or y clears `PLACED` instead.
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

fn run(row: u32, start: u32, end: u32) {
    var stack: array<u32, STACK>;
    var sp = 0u;
    for (var pc = start; pc < end; pc++) {
        let at = mark.code + pc * 4u;
        let code = program[at];
        let a = program[at + 1u];
        let b = program[at + 2u];
        let c = program[at + 3u];
        switch code {
            case OP_CONST: { stack[sp] = constant(a); sp++; }
            case OP_MISSING: { stack[sp] = MISSING; sp++; }
            case OP_FIELD: { stack[sp] = column_value(a, row).x; sp++; }
            case OP_SELECTED, OP_HOVERED, OP_POINTER, OP_ZOOM: { stack[sp] = viewed(code, row); sp++; }
            case OP_ELAPSED: { stack[sp] = bits(frame.elapsed); sp++; }
            case OP_THEME: { stack[sp] = theme_word(a); sp++; }
            case OP_NEG, OP_NOT, OP_ABS, OP_SQRT, OP_SIN, OP_COS, OP_FLOOR, OP_LOG, OP_EXP: {
                stack[sp - 1u] = bits(unary(code, number(stack[sp - 1u])));
            }
            case OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MIN, OP_MAX, OP_MOD, OP_POW, OP_LT, OP_LE, OP_GT, OP_GE,
                OP_EQ, OP_NE, OP_AND, OP_OR: {
                sp--;
                stack[sp - 1u] = bits(binary(code, number(stack[sp - 1u]), number(stack[sp])));
            }
            case OP_SELECT: {
                sp -= 2u;
                stack[sp - 1u] = select(stack[sp + 1u], stack[sp], number(stack[sp - 1u]) > 0.5);
            }
            case OP_SCALE: {
                let range = vec2f(constant_float(b), constant_float(b + 1u));
                stack[sp - 1u] = bits(scale(number(stack[sp - 1u]), domain(a), range));
            }
            case OP_COLORMAP: {
                stack[sp - 1u] = colormap(a & 0xffffu, a >> 16u, number(stack[sp - 1u]), domain(b));
            }
            case OP_STORE: {
                sp--;
                store(row, a, fallback(stack[sp], b));
            }
            case OP_STORE_COLOR: {
                sp--;
                store(row, a, select(stack[sp], theme_word(b), stack[sp] == MISSING_COLOR));
            }
            case OP_STORE_CODE: {
                sp--;
                store(row, a, stack[sp]);
            }
            case OP_STORE_FLAG: {
                sp--;
                store_flag(row, a, b, number(stack[sp]) > 0.5);
            }
            case OP_STORE_POSITION: {
                sp -= 2u;
                position(row, a, vec2u(stack[sp], 0u), vec2u(stack[sp + 1u], 0u));
            }
            case OP_POSITION: {
                position(row, a, column_value(b, row), column_value(c, row));
            }
            case OP_REDUCE: {
                sp--;
                let x = number(stack[sp]);
                if !missing(x) {
                    let d = 2u * (mark.domains + a);
                    atomicMax(&domains[d], ~ordered(x));
                    atomicMax(&domains[d + 1u], ordered(x));
                }
            }
            default: {}
        }
    }
}

// A row that left fades out during the transition. It shows its frozen words, except its comet
// travel, which keeps advancing.
fn fade_exit(row: u32, flags: u32) {
    let travel = travel_words().x;
    for (var w = 0u; w < mark.stride; w++) {
        if w != travel {
            pages[shown_at(row, w)] = was(row, w);
        }
    }
    pages[shown_at(row, flags)] = (was(row, flags) & ~FADE_IN) | FADE_OUT;
}

@compute @workgroup_size(256)
fn evaluate(@builtin(global_invocation_id) id: vec3u) {
    // Ends are resolved over the blocks listed for them. A row that left keeps the ends it had.
    if step == STEP_ENDS {
        let row = blocks[mark.end_block + id.y] * PAGE_ROWS + id.x;
        if row < live() {
            resolve(row);
        }
        return;
    }
    // Reductions run over every live block, which a domain change lists. Channels run over the
    // listed blocks, and only the channels the mask selects. One loop runs either, because a
    // backend compiles each call of the machine in full.
    let reducing = step == STEP_REDUCE;
    let row = row_of(id);
    if row >= live() {
        return;
    }
    // A row whose words start over is zeroed first, so a word no channel writes reads as zero.
    if !reducing && fresh(id) {
        for (var w = 0u; w < mark.stride + mark.extras; w++) {
            pages[shown_at(row, w)] = 0u;
        }
    }
    let first = select(0u, mark.channels, reducing);
    let end = select(mark.channels, mark.channels + mark.reductions, reducing);
    for (var k = first; k < end; k++) {
        if reducing || (mark.mask & (1u << k)) != 0u {
            let range = mark.ranges + 2u * k;
            run(row, program[range], program[range + 1u]);
        }
    }
    // The flags word is the last kind word of every mark's rows.
    let flags = mark.stride - 1u;
    if !reducing && mark.kind == MARK_VERTICES {
        let units = select(0u, HALF_UNITS, (mark.units & (1u << VERTEX_HALF)) != 0u);
        let own = select(0u, OWN_HEIGHT, (mark.flags & SIZED) != 0u);
        store(row, flags, (load(row, flags) & ~(HALF_UNITS | OWN_HEIGHT)) | units | own);
        store(row, VERTEX_RANGE, pack_range(vec2f(mark.size_min, mark.size_max)));
    }
}

// Writes what every row shows, each frame of a transition. Each word a channel stores moves from
// its frozen value toward its settled value by the mark's progress, as its blend says, and the
// flags show fading rows. Rows that left fade out. No channel runs.
@compute @workgroup_size(256)
fn ease(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    let flags = mark.stride - 1u;
    if row >= live() {
        if row < mark.held {
            fade_exit(row, flags);
        }
        return;
    }
    for (var w = 0u; w < mark.stride + mark.extras; w++) {
        let blend = program[mark.blends + w];
        if blend == BLEND_KEEP {
            continue;
        }
        let now = settled(row, w);
        var shown = now;
        switch blend {
            case BLEND_NUMBER: { shown = ease_number(row, w, now, flags); }
            case BLEND_COLOR: { shown = ease_color(row, w, now, flags); }
            case BLEND_POSITION: { shown = ease_position(row, w, now, flags); }
            default: {}
        }
        pages[shown_at(row, w)] = shown;
    }
    pages[shown_at(row, flags)] = faded(row, flags);
}

// Advances each stroke row's comets by its flow times the frame's time step, so a changed flow
// continues from where the comets are. Travel wraps at the comet spacing, so it keeps its precision
// however long comets run.
@compute @workgroup_size(256)
fn travel(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    let words = travel_words();
    if row >= mark.held || words.x == NONE {
        return;
    }
    let at = shown_at(row, words.x);
    let flow = number(pages[shown_at(row, words.y)]);
    let spacing = max(frame.flow_spacing, 1e-6);
    var moved = number(pages[at]) + select(flow, 0.0, missing(flow)) * frame.flow_step;
    moved -= spacing * floor(moved / spacing);
    // A result outside [0, spacing], such as NaN from a word never written, reads as no travel.
    pages[at] = bits(select(0.0, moved, moved >= 0.0 && moved <= spacing));
}

// When a transition moves rows, their comets continue from where they were: each row takes the
// travel from its frozen words.
@compute @workgroup_size(256)
fn carry(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    let travel = travel_words().x;
    if row >= mark.held || travel == NONE || !easing() {
        return;
    }
    pages[shown_at(row, travel)] = was(row, travel);
}
