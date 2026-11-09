//! Writing a shader's WGSL for one pipeline. Shaders declare what pipelines specialize them with as
//! WGSL `override`s, and each pipeline's module declares them as `const`s of its values instead.
//! So no pipeline passes constants, which browsers handle differently, and their compilers fold
//! the specialized branches away. The build writes and validates every specialization pipelines
//! use with this same code.

use std::fmt::Write as _;

/// A constant pipelines specialize a shader with: its name, the index of the declaration that
/// declares it, and whether it is a `bool` (else a `u32`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Constant<'a> {
    pub(crate) name: &'a str,
    pub(crate) at: u16,
    pub(crate) bool: bool,
}

/// Joins a shader's declarations `pieces`, with each of `constants` declared as a `const` of
/// `value(name)` in place of its `override`.
pub(crate) fn specialize<'a>(
    pieces: impl IntoIterator<Item = &'a str>,
    constants: &[Constant<'_>],
    value: impl Fn(&str) -> u32,
) -> String {
    let mut out = String::new();
    for (at, piece) in pieces.into_iter().enumerate() {
        if at > 0 {
            out.push_str(SEPARATOR);
        }
        match constants.iter().find(|constant| usize::from(constant.at) == at) {
            Some(Constant { name, bool: true, .. }) => {
                let _ = write!(out, "const {name}: bool = {};", value(name) != 0);
            }
            Some(Constant { name, .. }) => {
                let _ = write!(out, "const {name}: u32 = {}u;", value(name));
            }
            None => out.push_str(piece),
        }
    }
    portable(&out)
}

/// Lowers the four-byte normalized packing operations, absent from GLSL ES 3.00, to exact
/// integer arithmetic. Applied to built-in and application marker source alike, on every
/// backend. Identifiers are matched as tokens, so unpacking and longer names never collide.
pub(crate) fn portable(source: &str) -> String {
    const PACK: &str = "pack4x8unorm";
    const UNPACK: &str = "unpack4x8unorm";
    let mut out = String::with_capacity(source.len());
    let mut packed = false;
    let mut unpacked = false;
    let mut rest = source;
    while let Some(at) = rest.find(|c: char| c.is_ascii_alphabetic() || c == '_') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest.find(|c: char| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(rest.len());
        let token = &rest[..end];
        let called = rest[end..].trim_start().starts_with('(');
        if called && matches!(token, PACK | UNPACK) {
            out.push_str("latkit_");
            packed |= token == PACK;
            unpacked |= token == UNPACK;
        }
        out.push_str(token);
        rest = &rest[end..];
    }
    out.push_str(rest);
    if packed && !source.contains("fn latkit_pack4x8unorm") {
        out.push_str("\nfn latkit_pack4x8unorm(color: vec4f) -> u32 {\n    let bytes = vec4u(round(clamp(color, vec4f(0.0), vec4f(1.0)) * 255.0));\n    return bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);\n}\n");
    }
    if unpacked && !source.contains("fn latkit_unpack4x8unorm") {
        out.push_str("\nfn latkit_unpack4x8unorm(color: u32) -> vec4f {\n    return vec4f(vec4u(color, color >> 8u, color >> 16u, color >> 24u) & vec4u(255u)) / 255.0;\n}\n");
    }
    out
}

/// The separator between a linked shader's top-level declarations.
pub(crate) const SEPARATOR: &str = "\n\n";

/// The declarations of the evaluation shader a WGSL kernel replaces: its register count and the
/// functions it writes for a program.
pub(crate) const KERNEL: [&str; 5] =
    ["const ROW_WORDS:", "fn k_load_words(", "fn k_channels(", "fn k_run(", "fn k_output("];

/// Replaces the evaluation shader's declarations that `kernel` declares (see [`KERNEL`]) with
/// `kernel`'s straight-line code. This operates on linked, validated WGSL declarations, before
/// creating a module.
pub(crate) fn evaluator(source: &str, kernel: &str) -> String {
    let mut out = String::with_capacity(source.len() + kernel.len());
    for piece in source.split(SEPARATOR) {
        if KERNEL.iter().any(|declares| piece.starts_with(declares) && kernel.contains(declares)) {
            continue;
        }
        if !out.is_empty() {
            out.push_str(SEPARATOR);
        }
        out.push_str(piece);
    }
    out.push_str(SEPARATOR);
    out.push_str(kernel);
    out
}
