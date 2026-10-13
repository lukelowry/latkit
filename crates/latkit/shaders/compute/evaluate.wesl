// The expression machine: every row of a mark runs the mark's channels, which store into its state.
// All rows run the same instructions, so control flow stays uniform across a workgroup.

import package::lib::types::{
    NONE, MISSING, MISSING_COLOR, STACK, PINNED, VERTEX_POSITION, VERTEX_ELEVATION, VERTEX_FLAGS,
    OP_CONST, OP_MISSING, OP_FIELD, OP_SELECTED, OP_HOVERED, OP_POINTER, OP_ELAPSED, OP_THEME,
    OP_NEG, OP_NOT, OP_ABS, OP_SQRT, OP_SIN, OP_COS, OP_FLOOR, OP_LOG, OP_EXP,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MIN, OP_MAX, OP_MOD, OP_POW,
    OP_LT, OP_LE, OP_GT, OP_GE, OP_EQ, OP_NE, OP_AND, OP_OR,
    OP_SELECT, OP_SCALE, OP_COLORMAP, OP_STORE, OP_STORE_COLOR, OP_STORE_FLAG, OP_STORE_POSITION,
    OP_POSITION, OP_STORE_END, OP_REDUCE,
};
import package::lib::bind::{frame, program, mark, state};
import package::lib::read::{column_value, bits_value, missing, missing_bits};
import package::lib::focus::{is_selected, is_hovered};
import package::lib::color::{scale, colormap};
import package::lib::project::{project, to_screen};
import package::lib::reduce::{ordered, unordered};

// Per fitted domain: the order-preserving bits of its least and greatest value.
@group(2) @binding(1) var<storage, read_write> domains: array<atomic<u32>>;

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

fn row_word(row: u32) -> u32 {
    return mark.state + row * mark.stride;
}

fn pointer_distance(row: u32) -> f32 {
    let at = row_word(row) + VERTEX_POSITION;
    let hi = vec2f(bitcast<f32>(state[at]), bitcast<f32>(state[at + 1u]));
    let lo = vec2f(bitcast<f32>(state[at + 2u]), bitcast<f32>(state[at + 3u]));
    let z = bitcast<f32>(state[row_word(row) + VERTEX_ELEVATION]);
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

fn run(row: u32, start: u32, end: u32) {
    var stack: array<u32, STACK>;
    var sp = 0u;
    let base = row_word(row);
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
                state[base + a] = fallback(stack[sp], b);
            }
            case OP_STORE_COLOR: {
                sp--;
                state[base + a] = select(stack[sp], theme_word(b), stack[sp] == MISSING_COLOR);
            }
            case OP_STORE_FLAG: {
                sp--;
                let flags = base + a;
                state[flags] = select(state[flags] & ~b, state[flags] | b, number(stack[sp]) > 0.5);
            }
            case OP_STORE_POSITION: {
                sp -= 2u;
                let x = number(stack[sp]);
                let y = number(stack[sp + 1u]);
                let flags = base + VERTEX_FLAGS;
                if missing(x) || missing(y) {
                    state[flags] &= ~PINNED;
                } else {
                    state[base + a] = word(x);
                    state[base + a + 1u] = word(y);
                    state[base + a + 2u] = 0u;
                    state[base + a + 3u] = 0u;
                    state[flags] |= PINNED;
                }
            }
            case OP_POSITION: {
                let x = column_value(b, row);
                let y = column_value(c, row);
                let flags = base + VERTEX_FLAGS;
                if missing_bits(x.x) || missing_bits(y.x) {
                    state[flags] &= ~PINNED;
                } else {
                    state[base + a] = x.x;
                    state[base + a + 1u] = y.x;
                    state[base + a + 2u] = x.y;
                    state[base + a + 3u] = y.y;
                    state[flags] |= PINNED;
                }
            }
            case OP_STORE_END: {
                let end_row = bits_value(b, row);
                let first = program[mark.ends + c];
                state[base + a] = select(first + end_row, NONE, end_row == NONE || first == NONE);
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

@compute @workgroup_size(256)
fn evaluate(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows {
        return;
    }
    for (var k = 0u; k < mark.channels; k++) {
        if (mark.mask & (1u << k)) != 0u {
            let range = mark.ranges + 2u * k;
            run(id.x, program[range], program[range + 1u]);
        }
    }
}

@compute @workgroup_size(256)
fn reduce(@builtin(global_invocation_id) id: vec3u) {
    if id.x >= mark.rows {
        return;
    }
    for (var k = mark.channels; k < mark.channels + mark.reductions; k++) {
        let range = mark.ranges + 2u * k;
        run(id.x, program[range], program[range + 1u]);
    }
}
