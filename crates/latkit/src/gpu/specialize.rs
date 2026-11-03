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
    out
}

/// The separator between a linked shader's top-level declarations.
pub(crate) const SEPARATOR: &str = "\n\n";
