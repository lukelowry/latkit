//! Hooks: WGSL functions an application gives a mark, which latkit's draw shaders call. A custom
//! marker defines `fn marker(f: MarkerFragment) -> MarkerColor`, and a shade `fn shade(f:
//! ShadeFragment) -> vec4f`. A hook reads the structs of `lib/hooks.wesl` and its own declarations.
//!
//! Natively a hook's WGSL follows the shader's own. In a browser the build translated each shader
//! to GLSL ahead of time, with every hook it calls left a declaration. The page translates a hook
//! alone, in a module of the structs it reads and an entry calling it, and appends what the
//! translation declares, so a hook translates once however many pipelines call it.

use std::sync::Arc;

use crate::Error;

/// The hooks of one mark: a vertex mark's custom marker, and any mark's shade.
#[derive(Clone, Default, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Hooks {
    pub(crate) marker: Option<Arc<str>>,
    pub(crate) shade: Option<Arc<str>>,
}

/// A kind of hook.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Hook {
    Marker,
    Shade,
}

impl Hooks {
    pub(crate) fn is_empty(&self) -> bool {
        self.marker.is_none() && self.shade.is_none()
    }

    /// Each hook and its WGSL.
    pub(crate) fn each(&self) -> impl Iterator<Item = (Hook, &Arc<str>)> {
        [(Hook::Marker, &self.marker), (Hook::Shade, &self.shade)]
            .into_iter()
            .filter_map(|(hook, source)| source.as_ref().map(|source| (hook, source)))
    }

    /// The last hook a shader calls, which a failure of the whole pipeline is told for: the shade,
    /// else the marker.
    pub(crate) fn last(&self) -> Hook {
        if self.shade.is_some() { Hook::Shade } else { Hook::Marker }
    }

    /// Their WGSL, which natively follows the shader's.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn wgsl(&self) -> String {
        self.each().map(|(_, source)| &**source).collect::<Vec<_>>().join("\n")
    }

    /// Bytes of WGSL they add to a shader.
    pub(crate) fn size(&self) -> usize {
        self.each().map(|(_, source)| source.len()).sum()
    }

    /// A stamp of their WGSL, which tells the pipelines they complete apart.
    pub(crate) fn stamp(&self) -> u64 {
        crate::derive::stamp_of((&self.marker, &self.shade))
    }
}

impl Hook {
    /// The function it defines, and the mark option that gives it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Hook::Marker => "marker",
            Hook::Shade => "shade",
        }
    }

    /// The failure of a hook whose WGSL does not compile, for `message`.
    pub(crate) fn failure(self, message: &str) -> Error {
        let what = match self {
            Hook::Marker => "the custom marker",
            Hook::Shade => "the shade",
        };
        Error::invalid(format!("{what} does not compile: {message}")).at(self.name())
    }

    /// A module of the structs hooks read, `source`, and an entry calling the hook, which translates
    /// the hook alone.
    pub(crate) fn module(self, source: &str) -> String {
        let call = match self {
            Hook::Marker => "var f: MarkerFragment;\n    return marker(f).color;",
            Hook::Shade => "var f: ShadeFragment;\n    return shade(f);",
        };
        let module = format!(
            "{}\n{source}\n@fragment\nfn hook() -> @location(0) vec4f {{\n    {call}\n}}\n",
            super::shaders::HOOKS
        );
        super::specialize::portable(&module)
    }
}

/// The structs of `lib/hooks.wesl`, which the shaders a hook completes declare themselves.
#[cfg(any(target_arch = "wasm32", test))]
const DECLARED: [&str; 3] = ["MarkerColor", "MarkerFragment", "ShadeFragment"];

/// What a hook's translated [`module`](Hook::module) adds to the shaders it completes: the hook's
/// functions, types, and constants. The version, precisions, structs of `lib/hooks.wesl`, the
/// entry's output, and the entry are the shader's own. Fails if the hook reads a resource, which
/// no hook can bind.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn appended(glsl: &str) -> Result<String, String> {
    let mut kept = String::with_capacity(glsl.len());
    let mut items = glsl.split_inclusive('\n').peekable();
    while let Some(line) = items.next() {
        // Gather a top-level item: a line, or the lines up to where the braces that open on the
        // first close.
        let mut item = line.to_owned();
        let mut depth = line.matches('{').count() as i32 - line.matches('}').count() as i32;
        while depth > 0
            && let Some(next) = items.next()
        {
            depth += next.matches('{').count() as i32 - next.matches('}').count() as i32;
            item.push_str(next);
        }
        let head = item.trim_start();
        if head.starts_with("//@") {
            return Err("a hook reads no resources: it can't declare bindings".to_owned());
        }
        let own = head.starts_with("#version")
            || head.starts_with("precision ")
            || head.starts_with("layout(")
            || head.starts_with("out ")
            || head.starts_with("void main(")
            || DECLARED.iter().any(|name| head.starts_with(&format!("struct {name} {{")));
        if !own {
            kept.push_str(&item);
        }
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GLSL as the translator writes a hook's module: the structs it reads, the hook and its
    /// helpers, and the entry calling it.
    const TRANSLATED: &str = "#version 300 es

precision highp float;
precision highp int;

struct MarkerColor {
    vec4 color;
    float distance;
};
struct ShadeFragment {
    vec4 color;
    vec2 px;
    vec2 local;
    vec3 pointer;
    float elapsed;
    float input_[8];
};
struct Glow {
    float strength;
};
const float SPOT = 200.0;

layout(location = 0) out vec4 _fs2p_location0;

float near(vec2 a, vec3 b) {
    return 1.0 - smoothstep(0.0, SPOT, distance(a, b.xy));
}

vec4 shade(ShadeFragment f) {
    float n = near(f.px, f.pointer);
    if ((n > 0.5)) {
        return vec4(1.0);
    }
    return f.color;
}

void main() {
    ShadeFragment f_1 = ShadeFragment(vec4(0.0), vec2(0.0), vec2(0.0), vec3(0.0), 0.0, float[8](0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0));
    vec4 _e2 = shade(f_1);
    _fs2p_location0 = _e2;
    return;
}
";

    #[test]
    fn a_hook_appends_its_own_declarations_only() {
        let kept = appended(TRANSLATED).expect("no resources");
        for own in ["struct Glow {", "const float SPOT", "float near(", "vec4 shade(ShadeFragment f) {"] {
            assert!(kept.contains(own), "{own} is the hook's:\n{kept}");
        }
        for shader in ["#version", "precision", "struct ShadeFragment", "struct MarkerColor", "_fs2p", "void main"] {
            assert!(!kept.contains(shader), "{shader} is the shader's:\n{kept}");
        }
        let template = "#version 300 es\nstruct ShadeFragment {\n    vec4 color;\n};\nvec4 shade(ShadeFragment f);\nvoid main() {\n    vec4 c = shade(ShadeFragment(vec4(1.0)));\n}\n";
        let program = super::super::kernel::linked(template, &kept);
        assert!(program.contains("float near(") && program.contains("vec4 shade(ShadeFragment f) {"), "{program}");
        let bound = format!("#version 300 es\n//@uniform Frame 0 0\n{TRANSLATED}");
        assert!(appended(&bound).is_err(), "a hook can't bind a resource");
    }

    #[test]
    fn modules_call_the_hook_they_translate() {
        let module = Hook::Shade.module("fn shade(f: ShadeFragment) -> vec4f { return f.color; }");
        assert!(module.contains("struct ShadeFragment") && module.contains("return shade(f);"), "{module}");
        let parsed = naga::front::wgsl::parse_str(&module).expect("the module parses");
        assert_eq!(parsed.entry_points.len(), 1);
        let marker =
            Hook::Marker.module("fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }");
        naga::front::wgsl::parse_str(&marker).expect("the marker's module parses");
    }
}
