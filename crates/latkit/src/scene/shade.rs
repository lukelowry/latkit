use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;

use crate::Expr;

/// A mark's shade: WGSL that colors each pixel of its rows before it blends. `source` defines
/// `fn shade(f: ShadeFragment) -> vec4f`, which returns the pixel's straight color. It reads the
/// mark's color at the pixel as `f.color`, the pixel in CSS pixels from the view's top left as
/// `f.px`, the pixel within its row's shape as `f.local`, the pointer as `f.pointer` (its `z` is 1
/// while it is over the view), seconds since the view was created as `f.elapsed`, and up to eight
/// `inputs` as `f.input[i]`. A shade that reads `f.elapsed` draws every frame, and one that reads
/// `f.pointer` draws as the pointer moves. It changes color only: hits and picks follow the rows'
/// shapes. The source may declare its own functions, types, and constants. Of latkit's shader code,
/// it sees only `ShadeFragment`. It compiles once, when a view first draws it.
///
/// ```
/// # use latkit::{Edges, Shade, field};
/// // Lines brighten near the pointer.
/// let spotlight = Shade::new(
///     "fn shade(f: ShadeFragment) -> vec4f {
///         let near = (1.0 - smoothstep(0.0, 200.0, distance(f.px, f.pointer.xy))) * f.pointer.z;
///         return vec4f(mix(f.color.rgb, vec3f(1.0, 0.8, 0.4), 0.6 * near), f.color.a);
///     }",
/// );
/// let lines = Edges::of("grid", "Line").ends("from", "to").shade(spotlight);
/// ```
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shade {
    /// The WGSL source of the `shade` function.
    pub source: Arc<str>,
    /// Each row's inputs, at most eight.
    #[serde(default)]
    pub inputs: Vec<Expr>,
}

impl Shade {
    /// A shade defined by `source`, with no inputs.
    pub fn new(source: impl Into<Arc<str>>) -> Shade {
        Shade { source: source.into(), inputs: Vec::new() }
    }

    /// The same shade, reading `input` as its next input, `f.input[i]`.
    #[must_use]
    pub fn input(mut self, input: impl Into<Expr>) -> Shade {
        self.inputs.push(input.into());
        self
    }

    /// Whether the source reads `member` of the fragment, such as `elapsed`. The struct is reached
    /// only through its members, so a read names one.
    pub(crate) fn reads(&self, member: &str) -> bool {
        let named = format!(".{member}");
        self.source.match_indices(&named).any(|(at, _)| {
            let after = self.source[at + named.len()..].chars().next();
            !after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Shade;

    #[test]
    fn a_shade_reads_the_members_its_source_names() {
        let shade = Shade::new("fn shade(f: ShadeFragment) -> vec4f { return f.color * sin(f.elapsed); }");
        assert!(shade.reads("elapsed") && shade.reads("color"));
        assert!(!shade.reads("pointer"));
        assert!(!Shade::new("fn shade(f: ShadeFragment) -> vec4f { let x = f.elapsed_ish; }").reads("elapsed"));
    }
}
