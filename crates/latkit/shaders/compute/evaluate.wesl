// The expression machine: every row of a mark runs the mark's channels, which store into its state.
// All rows run the same instructions, so control flow stays uniform across a workgroup.
//
// While the mark eases (`mark.frozen` set), every store blends from the row's frozen state by the
// mark's progress: numbers and colors mix, positions move by their offset, references snap, and a
// row whose visibility flips fades. Rows past `mark.rows` left; they only fade.

import package::lib::types::{
    NONE, MISSING, MISSING_COLOR, STACK, VISIBLE, PLACED, FADE_IN, FADE_OUT, ENTERING,
    VERTEX_POSITION, VERTEX_ELEVATION, VERTEX_FLAGS, VERTEX_HALF, HALF_UNITS, OWN_HEIGHT, SIZED, MARK_VERTICES,
    OP_CONST, OP_MISSING, OP_FIELD, OP_SELECTED, OP_HOVERED, OP_POINTER, OP_ELAPSED, OP_THEME, OP_ZOOM,
    OP_NEG, OP_NOT, OP_ABS, OP_SQRT, OP_SIN, OP_COS, OP_FLOOR, OP_LOG, OP_EXP,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MIN, OP_MAX, OP_MOD, OP_POW,
    OP_LT, OP_LE, OP_GT, OP_GE, OP_EQ, OP_NE, OP_AND, OP_OR,
    OP_SELECT, OP_SCALE, OP_COLORMAP, OP_STORE, OP_STORE_COLOR, OP_STORE_FLAG, OP_STORE_POSITION,
    OP_POSITION, OP_STORE_END, OP_STORE_CODE, OP_REDUCE,
};
import package::lib::bind::{frame, program, mark, state};
import package::lib::state::travel_words;
import package::lib::read::{column_value, bits_value, missing, missing_bits};
import package::lib::focus::{is_selected, is_hovered};
import package::lib::color::{scale, colormap};
import package::lib::project::{project, to_screen};
import package::lib::reduce::{ordered, unordered};

// Each row's state as drawn when the mark's transition began.
@group(2) @binding(1) var<storage, read> frozen: array<u32>;
// Per fitted domain: the order-preserving bits of its least and greatest value.
@group(2) @binding(4) var<storage, read_write> domains: array<atomic<u32>>;

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

fn pointer_distance(row: u32) -> f32 {
    let at = word_at(row, VERTEX_POSITION);
    let hi = vec2f(bitcast<f32>(state[at]), bitcast<f32>(state[at + 1u]));
    let lo = vec2f(bitcast<f32>(state[at + 2u]), bitcast<f32>(state[at + 3u]));
    let z = bitcast<f32>(state[word_at(row, VERTEX_ELEVATION)]);
    return distance(to_screen(project(hi, lo, z)), frame.pointer);
}

fn number(x: u32) -> f32 {
    return bitcast<f32>(x);
}

fn word(x: f32) -> u32 {
    return bitcast<u32>(x);
}

fn truth(x: bool) -> u32 {
    return word(f32(x));
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

// Stores position `now` (high and low parts of x and y) at word `w`, eased by its offset from what
// the row showed so the destination keeps its precision.
fn store_position(row: u32, w: u32, now: vec4f, flags: u32) {
    var hi = now.xy;
    if easing() && !entering(row, flags) && (was(row, flags) & PLACED) != 0u {
        let from_hi = vec2f(number(was(row, w)), number(was(row, w + 1u)));
        let from_lo = vec2f(number(was(row, w + 2u)), number(was(row, w + 3u)));
        hi += ((from_hi - now.xy) + (from_lo - now.zw)) * (1.0 - mark.motion);
    }
    state[word_at(row, w)] = word(hi.x);
    state[word_at(row, w + 1u)] = word(hi.y);
    state[word_at(row, w + 2u)] = word(now.z);
    state[word_at(row, w + 3u)] = word(now.w);
}

// Sets or clears `bit` of the flags at word `w`. While easing, a row whose visibility flips stays
// drawn and fades.
fn store_flag(row: u32, w: u32, bit: u32, on: bool) {
    let at = word_at(row, w);
    var flags = select(state[at] & ~bit, state[at] | bit, on);
    if bit == VISIBLE {
        flags &= ~(FADE_IN | FADE_OUT);
        if easing() {
            let before = entering(row, w) || (was(row, w) & VISIBLE) != 0u;
            let fresh = entering(row, w);
            if on && (fresh || !before) {
                flags |= FADE_IN;
            } else if !on && before {
                flags |= VISIBLE | FADE_OUT;
            }
        }
    }
    state[at] = flags & ~ENTERING;
}

// A position, from data or in a diagram from its sheet; a row without one is not placed.
fn position(row: u32, w: u32, x: vec2u, y: vec2u) {
    let flags = w + VERTEX_FLAGS - VERTEX_POSITION;
    let at = word_at(row, flags);
    if missing_bits(x.x) || missing_bits(y.x) {
        state[at] &= ~PLACED;
        return;
    }
    store_position(row, w, vec4f(number(x.x), number(y.x), number(x.y), number(y.y)), flags);
    state[at] |= PLACED;
}

fn run(row: u32, start: u32, end: u32, flags: u32) {
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
            case OP_SELECTED: { stack[sp] = truth(is_selected(row)); sp++; }
            case OP_HOVERED: { stack[sp] = truth(is_hovered(row)); sp++; }
            case OP_POINTER: { stack[sp] = word(pointer_distance(row)); sp++; }
            case OP_ELAPSED: { stack[sp] = word(frame.elapsed); sp++; }
            case OP_ZOOM: { stack[sp] = word(frame.zoom); sp++; }
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
                let now = fallback(stack[sp], b);
                state[word_at(row, a)] = ease_number(row, a, now, flags);
            }
            case OP_STORE_COLOR: {
                sp--;
                let now = select(stack[sp], theme_word(b), stack[sp] == MISSING_COLOR);
                state[word_at(row, a)] = ease_color(row, a, now, flags);
            }
            case OP_STORE_CODE: {
                sp--;
                state[word_at(row, a)] = stack[sp];
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
                let end_row = bits_value(b, row);
                let first = program[mark.ends + c];
                state[word_at(row, a)] = select(first + end_row, NONE, end_row == NONE || first == NONE);
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
    // The flags word is the last kind word of every mark's rows.
    let flags = mark.stride - 1u;
    if id.x >= mark.rows {
        if id.x < mark.rows + mark.exits && easing() {
            fade_exit(id.x, flags);
        }
        return;
    }
    for (var k = 0u; k < mark.channels; k++) {
        if (mark.mask & (1u << k)) != 0u {
            let range = mark.ranges + 2u * k;
            run(id.x, program[range], program[range + 1u], flags);
        }
    }
    if mark.kind == MARK_VERTICES {
        let at = word_at(id.x, flags);
        let units = select(0u, HALF_UNITS, (mark.units & (1u << VERTEX_HALF)) != 0u);
        let own = select(0u, OWN_HEIGHT, (mark.flags & SIZED) != 0u);
        state[at] = (state[at] & ~(HALF_UNITS | OWN_HEIGHT)) | units | own;
    }
}

// Comets travel on by each stroke row's flow over the frame's step, so a flow that changes carries
// on from where its comets are. Wrapped at their spacing, travel keeps its precision however long
// they run.
@compute @workgroup_size(256)
fn travel(@builtin(global_invocation_id) id: vec3u) {
    let words = travel_words();
    if id.x >= mark.rows + mark.exits || words.x == NONE {
        return;
    }
    let at = word_at(id.x, words.x);
    let flow = number(state[word_at(id.x, words.y)]);
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
    let travel = travel_words().x;
    if id.x >= mark.rows + mark.exits || travel == NONE || !easing() {
        return;
    }
    state[word_at(id.x, travel)] = was(id.x, travel);
}

@compute @workgroup_size(256)
fn reduce(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows {
        return;
    }
    let flags = mark.stride - 1u;
    for (var k = mark.channels; k < mark.channels + mark.reductions; k++) {
        let range = mark.ranges + 2u * k;
        run(id.x, program[range], program[range + 1u], flags);
    }
}
