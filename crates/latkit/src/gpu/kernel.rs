//! Straight-line expression shaders. Programs keep constants and column addresses in textures;
//! only their operation shape becomes code. The CPU resolves the expression stack once, so a
//! fragment has ordinary SSA values instead of a dynamically indexed stack and opcode loop.

use std::fmt::Write as _;
use std::sync::Arc;

use super::shaders::{
    NONE, OP_ABS, OP_ADD, OP_AND, OP_COLORMAP, OP_CONST, OP_COS, OP_DIV, OP_ELAPSED, OP_EQ, OP_EXP, OP_FALLBACK,
    OP_FIELD, OP_FILL_POSITION, OP_FLOOR, OP_GE, OP_GT, OP_HOVERED, OP_LE, OP_LOG, OP_LT, OP_MAX, OP_MIN, OP_MISSING,
    OP_MOD, OP_MUL, OP_NE, OP_NEG, OP_NOT, OP_OR, OP_POINTER, OP_POSITION, OP_POW, OP_REDUCE, OP_RELATED, OP_SCALE,
    OP_SELECT, OP_SELECTED, OP_SIN, OP_SQRT, OP_STORE, OP_STORE_CODE, OP_STORE_COLOR, OP_STORE_FLAG, OP_STORE_POSITION,
    OP_SUB, OP_THEME, OP_ZOOM, VERTEX_FLAGS, VERTEX_POSITION,
};
use crate::expr::compile::Program;

pub(crate) const EMPTY: &str = "const ROW_WORDS: u32 = 32u;\nfn channels(row: u32, clear: bool) {}\nfn run(row: u32, start: u32, end: u32) -> Reduction { return Reduction(NONE, vec2u(0u)); }";

/// Functions specializing the row helpers in an evaluation shader. Equal program shapes share
/// source (and pipelines), including programs whose constants, colors, or data differ.
pub(crate) fn source(program: &Program, width: u32) -> Arc<str> {
    assert!(width > 0 && width <= super::shaders::STATE_WORDS);
    let mut out = format!("const ROW_WORDS: u32 = {}u;\n", width.next_multiple_of(16));
    // Width is part of a kernel's shape. Constant register indices avoid a dynamically indexed
    // private array; aligned application rows fetch each state texel just once.
    out.push_str("fn load_words(at: u32) {\n");
    let fetch = if width.is_multiple_of(4) { "word_quad" } else { "word_four" };
    for first in (0..width).step_by(4) {
        writeln!(out, "let q{first} = {fetch}(pages, at + {first}u);").unwrap();
        for (lane, name) in ["x", "y", "z", "w"].iter().enumerate() {
            writeln!(out, "row_words[{}u] = q{first}.{name};", first + lane as u32).unwrap();
        }
    }
    out.push_str("}\n");
    for (index, &[start, end]) in program.ranges.iter().enumerate() {
        channel(&mut out, program, index, start, end);
    }
    out.push_str("fn channels(row: u32, clear: bool) {\nload_row(row, clear);\n");
    for index in 0..program.channels.len() {
        writeln!(out, "if (mark.mask & {}u) != 0u {{ let ignored = channel_{index}(row); }}", 1u32 << index).unwrap();
    }
    out.push_str("finish_channels(row);\n}\nfn run(row: u32, start: u32, end: u32) -> Reduction {\nswitch start {\n");
    for (index, &[start, end]) in program.ranges.iter().enumerate().skip(program.channels.len()) {
        if start != end {
            writeln!(out, "case {start}u: {{ return channel_{index}(row); }}").unwrap();
        }
    }
    out.push_str("default: { return Reduction(NONE, vec2u(0u)); }\n}\n}\n");
    out.into()
}

fn channel(out: &mut String, program: &Program, index: usize, start: u32, end: u32) {
    writeln!(out, "fn channel_{index}(row: u32) -> Reduction {{").unwrap();
    let mut stack: Vec<String> = Vec::new();
    for pc in start..end {
        let [op, a, b, c] = program.code[pc as usize];
        let value = format!("v{pc}");
        let popped = match op {
            OP_SELECT => 3,
            OP_ADD | OP_SUB | OP_MUL | OP_DIV | OP_MIN | OP_MAX | OP_MOD | OP_POW | OP_LT | OP_LE | OP_GT | OP_GE
            | OP_EQ | OP_NE | OP_AND | OP_OR | OP_FALLBACK | OP_STORE_POSITION => 2,
            OP_NEG | OP_NOT | OP_ABS | OP_SQRT | OP_SIN | OP_COS | OP_FLOOR | OP_LOG | OP_EXP | OP_SCALE
            | OP_COLORMAP | OP_STORE | OP_STORE_COLOR | OP_STORE_CODE | OP_STORE_FLAG | OP_REDUCE => 1,
            _ => 0,
        };
        let args = stack.split_off(stack.len().checked_sub(popped).expect("a validated expression stack"));
        let x = args.first().map_or("", String::as_str);
        let y = args.get(1).map_or("", String::as_str);
        let z = args.get(2).map_or("", String::as_str);
        let expression = match op {
            OP_CONST => Some(format!("constant({a}u)")),
            OP_MISSING => Some("MISSING".into()),
            OP_FIELD => Some(format!("field_value({a}u, row).x")),
            OP_SELECTED | OP_HOVERED | OP_RELATED | OP_POINTER | OP_ZOOM => Some(format!("viewed({op}u, row)")),
            OP_ELAPSED => Some("bits(frame.elapsed)".into()),
            OP_THEME => Some(format!("theme_word({a}u)")),
            OP_NEG | OP_NOT | OP_ABS | OP_SQRT | OP_SIN | OP_COS | OP_FLOOR | OP_LOG | OP_EXP => {
                Some(format!("bits({})", unary(op, x)))
            }
            OP_ADD | OP_SUB | OP_MUL | OP_DIV | OP_MIN | OP_MAX | OP_MOD | OP_POW | OP_LT | OP_LE | OP_GT | OP_GE
            | OP_EQ | OP_NE | OP_AND | OP_OR => Some(format!("bits({})", binary(op, x, y))),
            OP_SELECT => Some(format!("select({z}, {y}, number({x}) > 0.5)")),
            OP_FALLBACK => Some(format!(
                "select({x}, {y}, {})",
                if a == 1 { format!("{x} == MISSING_COLOR") } else { format!("missing_bits({x})") }
            )),
            OP_SCALE => Some(format!(
                "bits(scale_value(number({x}), domain({a}u), vec2f(constant_float({b}u), constant_float({}u))))",
                b + 1
            )),
            // The view resolves a colormap's layer after compilation. Keep this operand a
            // texture read; embedding it would invalidate a cached kernel when layers move.
            OP_COLORMAP => Some(format!(
                "color_value(program(mark.code + {}u) & 0xffffu, {}u, number({x}), domain({b}u))",
                pc * 4 + 1,
                a >> 16
            )),
            OP_STORE => {
                writeln!(out, "store(row, {a}u, fallback({x}, {b}u));").unwrap();
                None
            }
            OP_STORE_COLOR => {
                if b == NONE {
                    writeln!(out, "store(row, {a}u, {x});").unwrap();
                } else {
                    writeln!(out, "store(row, {a}u, select({x}, theme_word({b}u), {x} == MISSING_COLOR));").unwrap();
                }
                None
            }
            OP_STORE_CODE => {
                writeln!(out, "store(row, {a}u, {x});").unwrap();
                None
            }
            OP_STORE_FLAG => {
                writeln!(out, "store_flag(row, {a}u, {b}u, number({x}) > 0.5);").unwrap();
                None
            }
            OP_STORE_POSITION => {
                writeln!(out, "position(row, {a}u, vec2u({x}, 0u), vec2u({y}, 0u));").unwrap();
                None
            }
            OP_POSITION => {
                writeln!(out, "position(row, {a}u, field_value({b}u, row), field_value({c}u, row));").unwrap();
                None
            }
            OP_FILL_POSITION => {
                writeln!(out, "if (load(row, {}u) & PLACED) == 0u {{ position(row, {a}u, field_value({b}u, row), field_value({c}u, row)); }}", a + VERTEX_FLAGS - VERTEX_POSITION).unwrap();
                None
            }
            OP_REDUCE => {
                writeln!(out, "if !missing(number({x})) {{ return Reduction(mark.domains + {a}u, vec2u(~ordered_value(number({x})), ordered_value(number({x})))); }}").unwrap();
                None
            }
            _ => unreachable!("compiler emitted unknown operation {op}"),
        };
        if let Some(expression) = expression {
            writeln!(out, "let {value} = {expression};").unwrap();
            stack.push(value);
        }
    }
    assert!(stack.is_empty(), "a channel stores its result");
    out.push_str("return Reduction(NONE, vec2u(0u));\n}\n");
}

fn unary(op: u32, x: &str) -> String {
    let a = format!("number({x})");
    match op {
        OP_NEG => format!("-{a}"),
        OP_NOT => format!("f32({a} <= 0.5)"),
        _ => {
            let call = match op {
                OP_ABS => "abs",
                OP_SQRT => "sqrt",
                OP_SIN => "sin",
                OP_COS => "cos",
                OP_FLOOR => "floor",
                OP_LOG => "log",
                OP_EXP => "exp",
                _ => unreachable!(),
            };
            format!("{call}({a})")
        }
    }
}

fn binary(op: u32, x: &str, y: &str) -> String {
    let (a, b) = (format!("number({x})"), format!("number({y})"));
    match op {
        OP_MIN | OP_MAX | OP_POW => {
            let call = match op {
                OP_MIN => "min",
                OP_MAX => "max",
                _ => "pow",
            };
            format!("{call}({a}, {b})")
        }
        OP_MOD => format!("{a} - {b} * floor({a} / {b})"),
        OP_AND => format!("f32({a} > 0.5 && {b} > 0.5)"),
        OP_OR => format!("f32({a} > 0.5 || {b} > 0.5)"),
        _ => {
            let operator = match op {
                OP_ADD => "+",
                OP_SUB => "-",
                OP_MUL => "*",
                OP_DIV => "/",
                OP_LT => "<",
                OP_LE => "<=",
                OP_GT => ">",
                OP_GE => ">=",
                OP_EQ => "==",
                OP_NE => "!=",
                _ => unreachable!(),
            };
            let expression = format!("{a} {operator} {b}");
            if matches!(op, OP_ADD | OP_SUB | OP_MUL | OP_DIV) { expression } else { format!("f32({expression})") }
        }
    }
}
