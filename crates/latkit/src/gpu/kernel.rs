//! Straight-line expression shaders. Programs keep constants and column addresses in textures;
//! only their operation shape becomes code. The CPU resolves the expression stack once, so a
//! fragment has ordinary SSA values instead of a dynamically indexed stack and opcode loop.
//!
//! A kernel is written in WGSL, or in GLSL ES 3.00 for the browser's WebGL2, where the build
//! translated the shader it completes ahead of time. Either way it calls only the `k_` functions of
//! `lib/evaluate.wesl`, whose names translation keeps.

use std::fmt::Write as _;
use std::sync::Arc;

use super::shaders::{
    MISSING, MISSING_COLOR, NONE, OP_ABS, OP_ADD, OP_AND, OP_COLORMAP, OP_CONST, OP_COS, OP_DIV, OP_ELAPSED, OP_EQ,
    OP_EXP, OP_FALLBACK, OP_FIELD, OP_FILL_POSITION, OP_FLOOR, OP_GE, OP_GT, OP_HOVERED, OP_LE, OP_LOG, OP_LT, OP_MAX,
    OP_MIN, OP_MISSING, OP_MOD, OP_MUL, OP_NE, OP_NEG, OP_NOT, OP_OR, OP_POINTER, OP_POSITION, OP_POW, OP_REDUCE,
    OP_RELATED, OP_SCALE, OP_SELECT, OP_SELECTED, OP_SIN, OP_SQRT, OP_STORE, OP_STORE_CODE, OP_STORE_COLOR,
    OP_STORE_FLAG, OP_STORE_POSITION, OP_SUB, OP_THEME, OP_ZOOM, PLACED, VERTEX_ELEVATION, VERTEX_FLAGS,
    VERTEX_POSITION,
};
use crate::expr::compile::Program;

/// The language a kernel is written in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Syntax {
    Wgsl,
    Glsl,
}

impl Syntax {
    /// The language of this build's kernels: GLSL in a browser, whose WebGL2 device takes shaders
    /// translated ahead of time, else WGSL.
    pub(crate) const BUILT: Syntax = if cfg!(target_arch = "wasm32") { Syntax::Glsl } else { Syntax::Wgsl };

    /// `name`'s header, returning `ty` (or nothing) and taking `params` of WGSL types.
    fn function(self, name: &str, params: &[(&str, &str)], ty: Option<&str>) -> String {
        match self {
            Syntax::Wgsl => {
                let params: Vec<String> = params.iter().map(|(name, ty)| format!("{name}: {ty}")).collect();
                let ty = ty.map(|ty| format!(" -> {ty}")).unwrap_or_default();
                format!("fn {name}({}){ty} {{\n", params.join(", "))
            }
            Syntax::Glsl => {
                let params: Vec<String> = params.iter().map(|(name, ty)| format!("{} {name}", self.ty(ty))).collect();
                format!("{} {name}({}) {{\n", ty.map_or("void", |ty| self.ty(ty)), params.join(", "))
            }
        }
    }

    /// The type WGSL calls `ty`.
    fn ty(self, ty: &str) -> &str {
        if self == Syntax::Wgsl {
            return ty;
        }
        match ty {
            "u32" => "uint",
            "f32" => "float",
            "vec2u" => "uvec2",
            "vec4u" => "uvec4",
            "vec2f" => "vec2",
            ty => ty,
        }
    }

    /// Declares `name` as `value`, of WGSL type `ty`.
    fn value(self, out: &mut String, name: &str, ty: &'static str, value: &str) {
        match self {
            Syntax::Wgsl => writeln!(out, "let {name} = {value};"),
            Syntax::Glsl => writeln!(out, "{} {name} = {value};", self.ty(ty)),
        }
        .unwrap();
    }

    /// `if_true` where `condition` holds, else `if_false`.
    fn select(self, if_false: &str, if_true: &str, condition: &str) -> String {
        match self {
            Syntax::Wgsl => format!("select({if_false}, {if_true}, {condition})"),
            Syntax::Glsl => format!("(({condition}) ? ({if_true}) : ({if_false}))"),
        }
    }

    /// A `vec2u` of `x` and `y`.
    fn vec2u(self, x: &str, y: &str) -> String {
        format!("{}({x}, {y})", self.ty("vec2u"))
    }

    /// The float of `condition`: 1 where it holds, else 0.
    fn truth(self, condition: &str) -> String {
        format!("{}({condition})", self.ty("f32"))
    }

    /// The reduction that records nothing.
    fn nothing(self) -> String {
        format!("Reduction({NONE}u, {}(0u))", self.ty("vec2u"))
    }
}

/// The kernel of `program`, for rows `width` words wide, in this build's syntax. Equal program
/// shapes share source (and pipelines), including programs whose constants, colors, or data differ.
pub(crate) fn source(program: &Program, width: u32) -> Arc<str> {
    written(program, width, Syntax::BUILT).into()
}

/// The words a row of `width` words holds registers for, a multiple of 16. GLSL kernels name it in
/// their first line, so the browser picks the shader translated for it.
pub(crate) fn row_words(width: u32) -> u32 {
    width.next_multiple_of(16)
}

/// The register count a GLSL kernel names in its first line.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn glsl_row_words(kernel: &str) -> Option<u32> {
    kernel.lines().next()?.strip_prefix("// ROW_WORDS ")?.parse().ok()
}

/// The GLSL program of `template`, an entry translated ahead of time, completed by `appended`: an
/// evaluation entry's kernel, or a draw entry's hooks (see [`super::hooks`]). Functions `main`
/// never calls are left out. The translation keeps every function any kernel calls, and ANGLE
/// passes uncalled functions on to the driver's compiler, which then takes longer.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn linked(template: &str, appended: &str) -> String {
    let text = format!("{template}\n{appended}");
    // Top-level items: a line, or the lines up to where the braces that open on the first close.
    let mut items: Vec<&str> = Vec::new();
    let (mut start, mut depth) = (0, 0i32);
    for (at, line) in text.match_indices('\n').map(|(at, _)| at).zip(text.split('\n')) {
        depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
        if depth == 0 {
            items.push(&text[start..=at]);
            start = at + 1;
        }
    }
    items.push(&text[start..]);
    let mut functions: hashbrown::HashMap<&str, Vec<&str>> = hashbrown::HashMap::new();
    for &item in &items {
        if let Some(name) = function_named(item) {
            functions.entry(name).or_default().push(item);
        }
    }
    // A helper latkit writes into a shader and a hook alike, such as a packing function, is kept once.
    let mut defined: hashbrown::HashSet<&str> = hashbrown::HashSet::new();
    items.retain(|item| !(item.contains('{') && item.contains('}')) || defined.insert(item.trim()));
    let mut reached: hashbrown::HashSet<&str> = hashbrown::HashSet::from(["main"]);
    let mut next = vec!["main"];
    while let Some(name) = next.pop() {
        for item in functions.get(name).into_iter().flatten() {
            let body = item.split_once('{').map_or("", |(_, body)| body);
            for called in identifiers_called(body) {
                if functions.contains_key(called) && reached.insert(called) {
                    next.push(called);
                }
            }
        }
    }
    items.into_iter().filter(|item| function_named(item).is_none_or(|name| reached.contains(name))).collect()
}

/// The name of the function a top-level GLSL item declares or defines, if it is one.
#[cfg(any(target_arch = "wasm32", test))]
fn function_named(item: &str) -> Option<&str> {
    let head = item.split('(').next()?;
    let mut words = head.split_whitespace();
    let (ty, name) = (words.next()?, words.next()?);
    let declared = words.next().is_none()
        && !["const", "struct", "layout", "uniform", "precision", "in", "out", "flat", "invariant"].contains(&ty)
        && !ty.starts_with('#')
        && !ty.starts_with("//")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    declared.then_some(name)
}

/// The names in `body` followed by an opening parenthesis: the functions and constructors it calls.
#[cfg(any(target_arch = "wasm32", test))]
fn identifiers_called(body: &str) -> Vec<&str> {
    let bytes = body.as_bytes();
    let (mut called, mut at) = (Vec::new(), 0);
    while at < bytes.len() {
        if !(bytes[at].is_ascii_alphabetic() || bytes[at] == b'_') {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
            at += 1;
        }
        if bytes[at..].iter().find(|&&b| b != b' ') == Some(&b'(') {
            called.push(&body[start..at]);
        }
    }
    called
}

fn written(program: &Program, width: u32, syntax: Syntax) -> String {
    assert!(width > 0 && width <= super::shaders::STATE_WORDS);
    let mut out = match syntax {
        Syntax::Wgsl => format!("const ROW_WORDS: u32 = {}u;\n", row_words(width)),
        Syntax::Glsl => format!("// ROW_WORDS {}\n", row_words(width)),
    };
    // Width is part of a kernel's shape. Constant register indices avoid a dynamically indexed
    // private array; aligned application rows fetch each state texel just once.
    out.push_str(&syntax.function("k_load_words", &[("at", "u32")], None));
    let fetch = if width.is_multiple_of(4) { "k_quad" } else { "k_four" };
    for first in (0..width).step_by(4) {
        syntax.value(&mut out, &format!("q{first}"), "vec4u", &format!("{fetch}(at + {first}u)"));
        for (lane, name) in ["x", "y", "z", "w"].iter().enumerate() {
            writeln!(out, "k_set({}u, q{first}.{name});", first + lane as u32).unwrap();
        }
    }
    out.push_str("}\n");
    // The four words from `word`, a plane's first, at constant indices: each plane's words, kept
    // where `word` starts it. Selecting values, not branching, keeps the driver's compile short.
    let vec4u = syntax.ty("vec4u");
    out.push_str(&syntax.function("k_output", &[("first", "u32")], Some("vec4u")));
    for first in (0..width).step_by(4) {
        let words: Vec<String> = (first..first + 4).map(|word| format!("k_load(0u, {word}u)")).collect();
        let plane = format!("{vec4u}({})", words.join(", "));
        if first == 0 {
            match syntax {
                Syntax::Wgsl => writeln!(out, "var words = {plane};"),
                Syntax::Glsl => writeln!(out, "{vec4u} words = {plane};"),
            }
            .unwrap();
        } else {
            writeln!(out, "words = {};", syntax.select("words", &plane, &format!("first == {first}u"))).unwrap();
        }
    }
    out.push_str("return words;\n}\n");
    for (index, &[start, end]) in program.ranges.iter().enumerate() {
        channel(&mut out, program, index, start, end, syntax);
    }
    // The channels a pass evaluates: those that changed, of those its plane's words depend on.
    let channels = program.channels.len();
    out.push_str(&syntax.function("k_channels", &[("row", "u32"), ("clear", "bool"), ("plane", "u32")], None));
    out.push_str("k_load_row(row, clear);\n");
    for index in 0..channels {
        let call = match syntax {
            Syntax::Wgsl => format!("_ = k_channel_{index}(row);"),
            Syntax::Glsl => format!("k_channel_{index}(row);"),
        };
        writeln!(out, "if ((k_mask() & plane & {}u) != 0u) {{ {call} }}", 1u32 << index).unwrap();
    }
    out.push_str("k_finish(row);\n}\n");
    // Reduction `start`, chosen by tests rather than returns from a switch.
    out.push_str(&syntax.function("k_run", &[("row", "u32"), ("start", "u32"), ("end", "u32")], Some("Reduction")));
    match syntax {
        Syntax::Wgsl => writeln!(out, "var found = {};", syntax.nothing()),
        Syntax::Glsl => writeln!(out, "Reduction found = {};", syntax.nothing()),
    }
    .unwrap();
    for (index, &[start, end]) in program.ranges.iter().enumerate().skip(channels) {
        if start != end {
            writeln!(out, "if (start == {start}u) {{ found = k_channel_{index}(row); }}").unwrap();
        }
    }
    out.push_str("return found;\n}\n");
    out
}

/// For each plane of four words of `program`'s rows, `width` words wide, the channels a pass
/// writing it evaluates (see [`planes`]).
pub(crate) fn plane_channels(program: &Program, width: u32) -> Arc<[u32]> {
    planes(program, width).into()
}

/// The words channel `index` of `program` writes and reads.
fn words(program: &Program, index: usize) -> (Vec<u32>, Vec<u32>) {
    let [start, end] = program.ranges[index];
    let (mut writes, mut reads) = (Vec::new(), Vec::new());
    for &[op, a, ..] in &program.code[start as usize..end as usize] {
        let flags = a + VERTEX_FLAGS - VERTEX_POSITION;
        match op {
            OP_STORE | OP_STORE_COLOR | OP_STORE_CODE => writes.push(a),
            OP_STORE_FLAG => {
                writes.push(a);
                reads.push(a);
            }
            OP_STORE_POSITION | OP_POSITION | OP_FILL_POSITION => {
                writes.extend([a, a + 1, a + 2, a + 3, flags]);
                reads.push(flags);
            }
            // The distance to the pointer reads the row's position.
            OP_POINTER => reads.extend((VERTEX_POSITION..VERTEX_POSITION + 4).chain([VERTEX_ELEVATION])),
            _ => {}
        }
    }
    (writes, reads)
}

/// For each plane of four words of a row `width` words wide, the channels that evaluate when it is
/// written: those that store into it, and those that store words they read. The words the shader
/// derives after the channels read only the flags, which are in the plane of the channels storing
/// them. A row of one plane evaluates every channel.
fn planes(program: &Program, width: u32) -> Vec<u32> {
    let channels = program.channels.len();
    let count = width.div_ceil(4) as usize;
    if count <= 1 {
        return vec![u32::MAX; count];
    }
    let words: Vec<(Vec<u32>, Vec<u32>)> = (0..channels).map(|index| words(program, index)).collect();
    let writers = |word: u32| -> u32 {
        words.iter().enumerate().filter(|(_, (writes, _))| writes.contains(&word)).fold(0, |m, (i, _)| m | 1 << i)
    };
    (0..count as u32)
        .map(|plane| {
            let mut mask = (plane * 4..plane * 4 + 4).fold(0, |mask, word| mask | writers(word));
            loop {
                let more = (0..channels)
                    .filter(|&i| mask & 1 << i != 0)
                    .flat_map(|i| words[i].1.iter().copied())
                    .fold(mask, |mask, word| mask | writers(word));
                if more == mask {
                    break mask;
                }
                mask = more;
            }
        })
        .collect()
}

fn channel(out: &mut String, program: &Program, index: usize, start: u32, end: u32, syntax: Syntax) {
    out.push_str(&syntax.function(&format!("k_channel_{index}"), &[("row", "u32")], Some("Reduction")));
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
        let number = |v: &str| format!("k_number({v})");
        let expression = match op {
            OP_CONST => Some(format!("k_constant({a}u)")),
            OP_MISSING => Some(format!("{MISSING}u")),
            OP_FIELD => Some(format!("k_field({a}u, row).x")),
            OP_SELECTED | OP_HOVERED | OP_RELATED | OP_POINTER | OP_ZOOM => Some(format!("k_viewed({op}u, row)")),
            OP_ELAPSED => Some("k_elapsed()".into()),
            OP_THEME => Some(format!("k_theme({a}u)")),
            OP_NEG | OP_NOT | OP_ABS | OP_SQRT | OP_SIN | OP_COS | OP_FLOOR | OP_LOG | OP_EXP => {
                Some(format!("k_bits({})", unary(op, &number(x), syntax)))
            }
            OP_ADD | OP_SUB | OP_MUL | OP_DIV | OP_MIN | OP_MAX | OP_MOD | OP_POW | OP_LT | OP_LE | OP_GT | OP_GE
            | OP_EQ | OP_NE | OP_AND | OP_OR => Some(format!("k_bits({})", binary(op, &number(x), &number(y), syntax))),
            OP_SELECT => Some(syntax.select(z, y, &format!("{} > 0.5", number(x)))),
            OP_FALLBACK => {
                let missing = if a == 1 { format!("{x} == {MISSING_COLOR}u") } else { format!("k_missing_bits({x})") };
                Some(syntax.select(x, y, &missing))
            }
            OP_SCALE => Some(format!(
                "k_bits(k_scale({}, k_domain({a}u), {}(k_constant_float({b}u), k_constant_float({}u))))",
                number(x),
                syntax.ty("vec2f"),
                b + 1
            )),
            // The view resolves a colormap's layer after compilation. Keep this operand a
            // texture read; embedding it would invalidate a cached kernel when layers move.
            OP_COLORMAP => {
                Some(format!("k_color(k_code({}u) & 0xffffu, {}u, {}, k_domain({b}u))", pc * 4 + 1, a >> 16, number(x)))
            }
            OP_STORE => {
                writeln!(out, "k_store(row, {a}u, k_fallback({x}, {b}u));").unwrap();
                None
            }
            OP_STORE_COLOR => {
                if b == NONE {
                    writeln!(out, "k_store(row, {a}u, {x});").unwrap();
                } else {
                    let color = syntax.select(x, &format!("k_theme({b}u)"), &format!("{x} == {MISSING_COLOR}u"));
                    writeln!(out, "k_store(row, {a}u, {color});").unwrap();
                }
                None
            }
            OP_STORE_CODE => {
                writeln!(out, "k_store(row, {a}u, {x});").unwrap();
                None
            }
            OP_STORE_FLAG => {
                writeln!(out, "k_store_flag(row, {a}u, {b}u, {} > 0.5);", number(x)).unwrap();
                None
            }
            OP_STORE_POSITION => {
                let (px, py) = (syntax.vec2u(x, "0u"), syntax.vec2u(y, "0u"));
                writeln!(out, "k_position(row, {a}u, {px}, {py});").unwrap();
                None
            }
            OP_POSITION => {
                writeln!(out, "k_position(row, {a}u, k_field({b}u, row), k_field({c}u, row));").unwrap();
                None
            }
            OP_FILL_POSITION => {
                let flags = a + VERTEX_FLAGS - VERTEX_POSITION;
                writeln!(
                    out,
                    "if ((k_load(row, {flags}u) & {PLACED}u) == 0u) {{ k_position(row, {a}u, k_field({b}u, row), k_field({c}u, row)); }}"
                )
                .unwrap();
                None
            }
            OP_REDUCE => {
                let value = number(x);
                let range = syntax.vec2u(&format!("~k_ordered({value})"), &format!("k_ordered({value})"));
                writeln!(out, "if (!k_missing({value})) {{ return Reduction(k_domains() + {a}u, {range}); }}").unwrap();
                None
            }
            _ => unreachable!("compiler emitted unknown operation {op}"),
        };
        if let Some(expression) = expression {
            syntax.value(out, &value, "u32", &expression);
            stack.push(value);
        }
    }
    assert!(stack.is_empty(), "a channel stores its result");
    writeln!(out, "return {};\n}}", syntax.nothing()).unwrap();
}

fn unary(op: u32, a: &str, syntax: Syntax) -> String {
    match op {
        OP_NEG => format!("-{a}"),
        OP_NOT => syntax.truth(&format!("{a} <= 0.5")),
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

fn binary(op: u32, a: &str, b: &str, syntax: Syntax) -> String {
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
        OP_AND => syntax.truth(&format!("{a} > 0.5 && {b} > 0.5")),
        OP_OR => syntax.truth(&format!("{a} > 0.5 || {b} > 0.5")),
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
            if matches!(op, OP_ADD | OP_SUB | OP_MUL | OP_DIV) { expression } else { syntax.truth(&expression) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expr::compile::{Channel, Reads};

    fn program(code: &[&[[u32; 4]]]) -> Program {
        let mut program = Program::default();
        for channel in code {
            let start = program.code.len() as u32;
            program.code.extend_from_slice(channel);
            program.ranges.push([start, program.code.len() as u32]);
            program.channels.push(Channel { name: "c".into(), reads: Reads::default(), eases: false });
        }
        program
    }

    #[test]
    fn a_plane_evaluates_the_channels_its_words_depend_on() {
        // Channel 0 places the vertex (words 0 to 3, flags at 10), channel 1 stores word 5 from the
        // pointer's distance, which reads the position, and channel 2 stores word 6.
        let program = program(&[
            &[[OP_FIELD, 0, 0, 0], [OP_FIELD, 1, 0, 0], [OP_STORE_POSITION, 0, 0, 0]],
            &[[OP_POINTER, 0, 0, 0], [OP_STORE_CODE, 5, 0, 0]],
            &[[OP_CONST, 0, 0, 0], [OP_STORE_CODE, 6, 0, 0]],
        ]);
        assert_eq!(planes(&program, 12), vec![0b001, 0b111, 0b001]);
        assert_eq!(planes(&program, 4), vec![u32::MAX], "one plane takes every channel");
    }

    #[test]
    fn linking_a_kernel_leaves_out_what_main_never_calls() {
        let template = "#version 300 es\n//@uniform B 0 0\nprecision highp float;\n\nstruct Reduction {\n    uint index;\n    uvec2 range;\n};\nuint k_load(uint row, uint w) {\n    return w;\n}\n\nuint unused(uint x) {\n    return x;\n}\n\nvoid k_channels(uint row_1, bool clear, uint plane);\n\nvoid main() {\n    k_channels(0u, false, 0u);\n    return;\n}\n";
        let kernel = "// ROW_WORDS 16\nReduction k_run(uint row, uint start, uint end) {\nswitch (start) {\ndefault: { return Reduction(0u, uvec2(0u)); }\n}\nreturn Reduction(0u, uvec2(0u));\n}\nvoid k_channels(uint row, bool clear, uint plane) {\nif ((k_load(row, 1u) & 1u) != 0u) { }\n}\n";
        let linked = linked(template, kernel);
        assert!(linked.contains("uint k_load(uint row, uint w) {"), "{linked}");
        assert!(linked.contains("void k_channels(uint row_1, bool clear, uint plane);"), "{linked}");
        assert!(linked.contains("void k_channels(uint row, bool clear, uint plane) {"), "{linked}");
        assert!(!linked.contains("unused") && !linked.contains("k_run"), "{linked}");
        assert!(linked.contains("struct Reduction {") && linked.contains("//@uniform B 0 0"), "{linked}");
    }

    #[test]
    fn both_syntaxes_call_only_the_kernel_interface() {
        let program = program(&[
            &[
                [OP_FIELD, 0, 0, 0],
                [OP_CONST, 1, 0, 0],
                [OP_CONST, 2, 0, 0],
                [OP_SELECT, 0, 0, 0],
                [OP_STORE, 4, NONE, 0],
            ],
            &[[OP_FIELD, 2, 0, 0], [OP_SCALE, 0, 3, 0], [OP_COLORMAP, 1 << 16, 0, 0], [OP_STORE_COLOR, 7, 2, 0]],
        ]);
        let wgsl = written(&program, 12, Syntax::Wgsl);
        let glsl = written(&program, 12, Syntax::Glsl);
        assert!(wgsl.starts_with("const ROW_WORDS: u32 = 16u;"), "{wgsl}");
        assert_eq!(glsl_row_words(&glsl), Some(16), "{glsl}");
        for text in [&wgsl, &glsl] {
            for name in ["k_load_words(", "k_channels(", "k_run(", "k_output(", "(k_mask() & plane & 2u)"] {
                assert!(text.contains(name), "{name} in {text}");
            }
        }
        assert!(glsl.contains("uint v0 = k_field(0u, row).x;") && !glsl.contains("let "), "{glsl}");
        assert!(glsl.contains("? (") && !glsl.contains("select("), "{glsl}");
        assert!(wgsl.contains("select(") && !wgsl.contains("uvec"), "{wgsl}");
    }
}
