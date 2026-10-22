// The expression machine: every row of a mark runs the mark's channels, which store into what the
// view binds as its state. All rows run the same instructions, so control flow stays uniform across a
// workgroup. A dispatch covers the row blocks the mark lists, only those whose rows changed when only
// those did.
//
// Evaluating knows nothing of transitions: while a mark eases, the view binds its settled mirror as
// the state, and each frame `ease` writes what every row shows from its frozen and settled state by
// the mark's progress: numbers and colors mix, positions move by their offset, a row whose visibility
// flipped fades, rows past `mark.rows` left and fade out, and the rest show as evaluated. No channel
// runs to ease.

import package::lib::types::{
    NONE, MISSING, MISSING_COLOR, STACK, VISIBLE, PLACED, FADE_IN, FADE_OUT, ENTERING, BLOCK_ROWS, item,
    BLEND_KEEP, BLEND_NUMBER, BLEND_COLOR, BLEND_POSITION, STEP_REDUCE,
    VERTEX_POSITION, VERTEX_FLAGS, VERTEX_HALF, VERTEX_RANGE, HALF_UNITS, OWN_HEIGHT, SIZED, MARK_VERTICES,
    OP_CONST, OP_MISSING, OP_FIELD, OP_ELAPSED, OP_THEME,
    OP_NEG, OP_NOT, OP_ABS, OP_SQRT, OP_SIN, OP_COS, OP_FLOOR, OP_LOG, OP_EXP,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MIN, OP_MAX, OP_MOD, OP_POW,
    OP_LT, OP_LE, OP_GT, OP_GE, OP_EQ, OP_NE, OP_AND, OP_OR,
    OP_SELECT, OP_SCALE, OP_COLORMAP, OP_STORE, OP_STORE_COLOR, OP_STORE_FLAG, OP_STORE_POSITION,
    OP_POSITION, OP_STORE_END, OP_STORE_CODE, OP_REDUCE,
};
import package::lib::bind::{frame, program, mark, state};
import package::lib::state::{travel_words, pack_range};
import package::lib::read::{column_value, bits_value, missing, missing_bits};
import package::lib::color::{scale, colormap};
import package::lib::reduce::{ordered, unordered};

// Each row's state as drawn when the mark's transition began.
@group(2) @binding(1) var<storage, read> frozen: array<u32>;
// Per fitted domain: the order-preserving bits of its least and greatest value.
@group(2) @binding(4) var<storage, read_write> domains: array<atomic<u32>>;
// Each row's state as its channels evaluated it, where it settles once the mark's transition ends:
// the state's mirror, which `ease` reads.
@group(2) @binding(14) var<storage, read_write> settled: array<u32>;
// Each mark's row blocks a dispatch covers: at `mark.block`, `mark.blocks` of them.
@group(2) @binding(16) var<storage, read> blocks: array<u32>;
// What a dispatch of `evaluate` runs: the mark's channels over its listed blocks, or over every row
// the reductions fitting its domains.
@group(2) @binding(17) var<uniform> step: u32;

// The row invocation `id` evaluates: row `id.x` of the mark's `id.y`th listed block.
fn row_of(id: vec3u) -> u32 {
    return blocks[mark.block + id.y] * BLOCK_ROWS + id.x;
}

fn constant(i: u32) -> u32 {
    return program[mark.constants + i];
}

fn constant_float(i: u32) -> f32 {
    return bitcast<f32>(constant(i));
}

// A domain record in constants: fitted flag, least, greatest, reduction index.
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

fn theme_word(slot: u32) -> u32 {
    return frame.theme[slot / 4u][slot % 4u];
}

// Where word `word` of `row` lives: a kind word, or past the kind words an extra word.
fn word_at(row: u32, word: u32) -> u32 {
    if word < mark.stride {
        return mark.state + row * mark.stride + word;
    }
    return mark.extra + row * mark.extras + (word - mark.stride);
}

fn easing() -> bool {
    return mark.frozen != NONE;
}

fn load(row: u32, word: u32) -> u32 {
    return state[word_at(row, word)];
}

fn store(row: u32, word: u32, value: u32) {
    state[word_at(row, word)] = value;
}

// Word `word` of `row` as it was drawn when the transition began.
fn was(row: u32, word: u32) -> u32 {
    if word < mark.stride {
        return frozen[mark.frozen + row * mark.stride + word];
    }
    return frozen[mark.frozen_extra + row * mark.extras + (word - mark.stride)];
}

// Whether `row` has nothing to ease from: it entered with this change.
fn entering(row: u32, flags: u32) -> bool {
    return (was(row, flags) & ENTERING) != 0u;
}

fn number(x: u32) -> f32 {
    return bitcast<f32>(x);
}

fn word(x: f32) -> u32 {
    return bitcast<u32>(x);
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

// A number eased from what `row` showed; a row that entered shows its own at once, and appears as
// its draw grows it in.
fn ease_number(row: u32, w: u32, now: u32, flags: u32) -> u32 {
    if !easing() || missing_bits(now) || entering(row, flags) {
        return now;
    }
    let start = was(row, w);
    if missing_bits(start) {
        return now;
    }
    return word(mix(number(start), number(now), mark.motion));
}

fn ease_color(row: u32, w: u32, now: u32, flags: u32) -> u32 {
    if !easing() || entering(row, flags) {
        return now;
    }
    return pack4x8unorm(mix(unpack4x8unorm(was(row, w)), unpack4x8unorm(now), mark.motion));
}

// A position's high word `w` (x or y) eased by its offset from what the row showed, so the
// destination keeps its precision; its low word, two after it, shows as evaluated.
fn ease_position(row: u32, w: u32, now: u32, flags: u32) -> u32 {
    if !easing() || entering(row, flags) || (was(row, flags) & PLACED) == 0u {
        return now;
    }
    let now_lo = number(settled[word_at(row, w + 2u)]);
    let offset = (number(was(row, w)) - number(now)) + (number(was(row, w + 2u)) - now_lo);
    return word(number(now) + offset * (1.0 - mark.motion));
}

// The flags `row` shows while its mark eases: as evaluated, but a row whose visibility flipped stays
// drawn and fades, in where it became visible or entered, out where it stopped being.
fn faded(row: u32, flags: u32) -> u32 {
    let now = settled[word_at(row, flags)] & ~(FADE_IN | FADE_OUT);
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

// Sets or clears `bit` of the flags at word `w`; whether the row fades is the ease's to show.
fn store_flag(row: u32, w: u32, bit: u32, on: bool) {
    let stored = load(row, w);
    store(row, w, select(stored & ~bit, stored | bit, on) & ~(ENTERING | FADE_IN | FADE_OUT));
}

// A position, from data or in a diagram from its sheet, as high and low parts of x and y; a row
// without one is not placed.
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
            case OP_ELAPSED: { stack[sp] = word(frame.elapsed); sp++; }
            case OP_THEME: { stack[sp] = theme_word(a); sp++; }
            case OP_NEG, OP_NOT, OP_ABS, OP_SQRT, OP_SIN, OP_COS, OP_FLOOR, OP_LOG, OP_EXP: {
                stack[sp - 1u] = word(unary(code, number(stack[sp - 1u])));
            }
            case OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MIN, OP_MAX, OP_MOD, OP_POW, OP_LT, OP_LE, OP_GT, OP_GE,
                OP_EQ, OP_NE, OP_AND, OP_OR: {
                sp--;
                stack[sp - 1u] = word(binary(code, number(stack[sp - 1u]), number(stack[sp])));
            }
            case OP_SELECT: {
                sp -= 2u;
                stack[sp - 1u] = select(stack[sp + 1u], stack[sp], number(stack[sp - 1u]) > 0.5);
            }
            case OP_SCALE: {
                let range = vec2f(constant_float(b), constant_float(b + 1u));
                stack[sp - 1u] = word(scale(number(stack[sp - 1u]), domain(a), range));
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
            case OP_STORE_END: {
                // Without a column, the end is the row itself, as a pole's.
                let end_row = select(bits_value(b, row), row, b == NONE);
                let first = program[mark.ends + c];
                store(row, a, select(first + end_row, NONE, end_row == NONE || first == NONE));
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

// A row that left fades out with its mark's transition; its frozen state is what it showed, but for
// its comets, which travel on.
fn fade_exit(row: u32, flags: u32) {
    let travel = travel_words().x;
    for (var w = 0u; w < mark.stride; w++) {
        if w != travel {
            state[word_at(row, w)] = was(row, w);
        }
    }
    state[word_at(row, flags)] = (was(row, flags) & ~FADE_IN) | FADE_OUT;
}

@compute @workgroup_size(256)
fn evaluate(@builtin(global_invocation_id) id: vec3u) {
    // Reductions run over every row; channels over the listed blocks, those the mask names. One
    // loop runs either, since a backend compiles each call of the machine whole.
    let reducing = step == STEP_REDUCE;
    var row: u32;
    if reducing {
        row = item(id);
    } else {
        row = row_of(id);
    }
    if row >= mark.rows {
        return;
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

// Each frame a mark eases toward its settled state: every word a channel stores shows the frozen
// state moved toward the settled one by the mark's progress, as the program says each eases, and the
// flags show rows fading; rows that left fade out. No channel runs.
@compute @workgroup_size(256)
fn ease(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    let flags = mark.stride - 1u;
    if row >= mark.rows {
        if row < mark.rows + mark.exits {
            fade_exit(row, flags);
        }
        return;
    }
    for (var w = 0u; w < mark.stride + mark.extras; w++) {
        let blend = program[mark.blends + w];
        if blend == BLEND_KEEP {
            continue;
        }
        let now = settled[word_at(row, w)];
        var shown = now;
        switch blend {
            case BLEND_NUMBER: { shown = ease_number(row, w, now, flags); }
            case BLEND_COLOR: { shown = ease_color(row, w, now, flags); }
            case BLEND_POSITION: { shown = ease_position(row, w, now, flags); }
            default: {}
        }
        state[word_at(row, w)] = shown;
    }
    state[word_at(row, flags)] = faded(row, flags);
}

// Comets travel on by each stroke row's flow over the frame's step, so a flow that changes carries
// on from where its comets are. Wrapped at their spacing, travel keeps its precision however long
// they run.
@compute @workgroup_size(256)
fn travel(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    let words = travel_words();
    if row >= mark.rows + mark.exits || words.x == NONE {
        return;
    }
    let at = word_at(row, words.x);
    let flow = number(state[word_at(row, words.y)]);
    let spacing = max(frame.flow_spacing, 1e-6);
    var moved = number(state[at]) + select(flow, 0.0, missing(flow)) * frame.flow_step;
    moved -= spacing * floor(moved / spacing);
    // Words a row never held read as no travel.
    state[at] = word(select(0.0, moved, moved >= 0.0 && moved <= spacing));
}

// Where a transition moved rows, their comets carry on from where they were: each row takes the
// travel its frozen state holds.
@compute @workgroup_size(256)
fn carry(@builtin(global_invocation_id) id: vec3u) {
    let row = item(id);
    let travel = travel_words().x;
    if row >= mark.rows + mark.exits || travel == NONE || !easing() {
        return;
    }
    state[word_at(row, travel)] = was(row, travel);
}
