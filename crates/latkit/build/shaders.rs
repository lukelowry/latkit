//! Links every WESL entry, validates it with naga, and writes `OUT_DIR/shaders.rs`, containing:
//!
//! - Every constant and struct of `lib/types.wesl`, as Rust constants and `#[repr(C)]` mirrors
//!   whose sizes are checked against WGSL.
//! - The shared bind group layouts of `lib/bind.wesl` (group 0 per view, group 1 per mark).
//! - Per shader variant: its declarations, the constants pipelines specialize it with, its pass
//!   group layout (group 2), and whether it uses the shared groups.
//!
//! Variants share most of their linked code, so each distinct top-level declaration is stored once
//! in `OUT_DIR/shaders.wgsl`. A variant is a list of declaration indices that join back into
//! exactly the module it linked.
//!
//! It also writes the module of every specialization pipelines use, exactly as the runtime writes
//! it (see `src/gpu/specialize.rs`) and validated, and `OUT_DIR/shaders.json` listing each one's
//! file and entry points. The browser gate reads it to time each pipeline in Chrome.

use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};
use naga::{AddressSpace, ArraySize, ImageClass, ImageDimension, ScalarKind, TypeInner, VectorSize};

use crate::specialize::{Constant, SEPARATOR, specialize};

/// A shader module and its variants. Each variant enables its listed WESL features.
struct Entry {
    module: &'static str,
    variants: &'static [(&'static str, &'static [&'static str])],
}

const ENTRIES: &[Entry] = &[
    Entry { module: "raster::words", variants: &[("main", &[]), ("gather", &["gather"])] },
    Entry { module: "raster::lengths", variants: &[("main", &[])] },
    Entry { module: "raster::order", variants: &[("main", &[]), ("scatter", &["scatter"])] },
    Entry { module: "raster::state", variants: &[("main", &[]), ("narrow", &["narrow"])] },
    Entry { module: "raster::pack", variants: &[("main", &[])] },
    Entry { module: "raster::bounds", variants: &[("main", &[])] },
    Entry { module: "raster::probe", variants: &[("main", &[])] },
    Entry { module: "raster::boxed", variants: &[("main", &[])] },
    Entry { module: "raster::query_pack", variants: &[("main", &[])] },
    Entry { module: "raster::lists", variants: &[("main", &[])] },
    Entry { module: "draw::backdrop", variants: &[("main", &[])] },
    Entry {
        module: "draw::points",
        variants: &[
            ("main", &[]),
            ("custom", &["custom"]),
            ("custom_focus", &["custom", "focused"]),
            ("focus", &["focused"]),
        ],
    },
    Entry { module: "draw::strokes", variants: &[("main", &[]), ("focus", &["focused"])] },
    Entry { module: "draw::areas", variants: &[("main", &[]), ("focus", &["focused"])] },
    Entry { module: "draw::glyphs", variants: &[("main", &[])] },
    Entry { module: "raster::metadata", variants: &[("main", &[])] },
    Entry { module: "raster::claims", variants: &[("main", &[])] },
    Entry { module: "raster::requests", variants: &[("main", &[])] },
    Entry { module: "raster::text_codes", variants: &[("main", &[])] },
    Entry { module: "draw::overlay", variants: &[("main", &[])] },
    Entry { module: "raster::compose", variants: &[("main", &[])] },
    Entry { module: "raster::fields", variants: &[("main", &[]), ("columns", &["columns"])] },
];

const FEATURES: &[&str] = &["custom", "focused", "columns", "scatter", "narrow", "gather"];

/// A placeholder custom marker function, appended to validate the custom variants.
const CUSTOM_MARKER: &str = "fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }";

const STATE_KERNEL: &str = r"
const ROW_WORDS: u32 = 32u;
fn channels(row: u32, clear: bool) {
    load_row(row, clear);
    if (mark.mask & 1u) != 0u { position(row, 0u, field_value(0u, row), field_value(1u, row)); }
    if (mark.mask & 2u) != 0u { store(row, 4u, bits(scale_value(number(field_value(2u, row).x), domain(0u), vec2f(2.0, 12.0)))); }
    finish_channels(row);
}
fn run(row: u32, start: u32, end: u32) -> Reduction {
    let x = number(field_value(2u, row).x);
    if !missing(x) { return Reduction(mark.domains, vec2u(~ordered_value(x), ordered_value(x))); }
    return Reduction(NONE, vec2u(0u));
}
";

/// The per-mark uniform is bound at a dynamic offset within one frame's mark buffer.
const DYNAMIC: &[&str] = &["mark"];

/// The values pipelines use for each pipeline constant, as `lib/types.wesl` constants or booleans.
/// `PRIMITIVE` is the primitive a probe or label anchor reads, and `PATH` the path a stroke reads.
/// The booleans say whether channels read joins, samples, and the view.
const OVERRIDES: &[(&str, &[&str])] = &[
    ("PRIMITIVE", &["POINTS", "STROKES", "TRIANGLES"]),
    ("PATH", &["PATH_ENDS", "PATH_TRACE", "PATH_GEOMETRY", "PATH_POLES", "PATH_BENDS"]),
    ("JOINED", &["false", "true"]),
    ("TIMED", &["false", "true"]),
    ("VIEWED", &["false", "true"]),
    ("PROJECTION", &["PROJECTION_PLANAR", "PROJECTION_MERCATOR", "PROJECTION_GLOBE", "PROJECTION_DYNAMIC"]),
    ("PAINTED", &["false", "true"]),
    ("MARKER", &["MARKER_SHAPE", "MARKER_GAUGE", "MARKER_PIE", "MARKER_ICON"]),
];

pub(crate) fn generate() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("shaders");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let mut rust = String::from("// Generated by build/shaders.rs from the WESL shaders. Do not edit.\n\n");

    let types = link(&root, "lib::types", &[], true);
    let (types_module, _) = validate("lib::types", &types);
    mirror_consts(&types_module, &mut rust);
    mirror_structs(&types_module, &mut rust);

    let bind = link(&root, "lib::bind", &[], true);
    let (bind_module, _) = validate("lib::bind", &bind);
    for (group, name) in [(0, "VIEW_GROUP"), (1, "MARK_GROUP")] {
        let bindings = bindings(&bind_module, None, group);
        writeln!(rust, "pub(crate) static {name}: &[Binding] = &[{}];\n", bindings.join(", ")).unwrap();
    }

    let mut shaders = String::new();
    let mut sources = String::new();
    let mut manifest = Vec::new();
    let mut pieces = Pieces::default();
    for entry in ENTRIES {
        for &(variant, features) in entry.variants {
            let source = link(&root, entry.module, features, false);
            // Custom variants lack the application's marker, so validation appends a placeholder.
            let custom = features.contains(&"custom");
            let checked = if custom { format!("{source}\n{CUSTOM_MARKER}") } else { source.clone() };
            let (module, info) = validate(&format!("{}.{variant}", entry.module), &checked);
            check_shared(&module, &bind_module, entry.module);
            let names = constant_names(&module);
            let constants = constants(&module, &names, &source);
            let file = format!("{}.{variant}", entry.module.replace("::", "."));
            let (entries, specializations) = manifest_entries(
                entry.module,
                &file,
                &source,
                &constants,
                &module,
                &types_module,
                custom,
                &out,
                &mut pieces,
            );
            manifest.extend(entries);
            let name = shader_name(entry.module, variant);
            writeln!(shaders, "    {name},").unwrap();
            let pass = bindings(&module, (entry.module != "raster::state").then_some(&info), 2);
            let constants: Vec<String> = constants
                .iter()
                .map(|c| format!("Constant {{ name: {:?}, at: {}, bool: {} }}", c.name, c.at, c.bool))
                .collect();
            let shared = module.global_variables.iter().any(|(_, g)| g.binding.as_ref().is_some_and(|b| b.group < 2));
            let entry_constants =
                if custom || entry.module == "raster::state" { Vec::new() } else { entry_constants(&module) };
            let targets = module
                .entry_points
                .iter()
                .filter(|e| e.stage == naga::ShaderStage::Fragment)
                .filter_map(|e| e.function.result.as_ref())
                .map(|result| {
                    let location = |binding: &Option<naga::Binding>| match binding {
                        Some(naga::Binding::Location { location, .. }) => *location as usize + 1,
                        _ => 0,
                    };
                    match &module.types[result.ty].inner {
                        TypeInner::Struct { members, .. } => {
                            members.iter().map(|m| location(&m.binding)).max().unwrap_or(0)
                        }
                        _ => location(&result.binding),
                    }
                })
                .max()
                .unwrap_or(0);
            writeln!(
                sources,
                "        Shader::{name} => &ShaderSource {{ label: {label:?}, pieces: &{refs:?}, pass: &[{pass}], constants: &[{constants}], entry_constants: &[{entry_constants}], specializations: &[{specializations}], shared: {shared}, targets: {targets} }},",
                label = format!("latkit {}.{variant}", entry.module),
                refs = pieces.add(&source),
                pass = pass.join(", "),
                constants = constants.join(", "),
                entry_constants = entry_constants.join(", "),
                specializations = specializations.join(", "),
            )
            .unwrap();
        }
    }
    fs::write(out.join("shaders.wgsl"), &pieces.text).unwrap();
    writeln!(
        rust,
        "/// Each declaration's byte range in `shaders.wgsl`.\npub(crate) static PIECES: &[(u32, u32)] = &{:?};\n",
        pieces.ranges
    )
    .unwrap();
    writeln!(rust, "/// Every linked shader and variant.\n#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]\npub(crate) enum Shader {{\n{shaders}}}\n").unwrap();
    writeln!(rust, "impl Shader {{\n    pub(crate) fn source(self) -> &'static ShaderSource {{\n        match self {{\n{sources}        }}\n    }}\n}}").unwrap();
    fs::write(out.join("shaders.rs"), rust).unwrap();
    fs::write(out.join("shaders.json"), format!("[\n{}\n]\n", manifest.join(",\n"))).unwrap();
}

/// Deduplicated top-level declarations: their concatenated text and each one's byte range.
#[derive(Default)]
struct Pieces {
    text: String,
    ranges: Vec<(u32, u32)>,
    index: HashMap<String, u16>,
}

impl Pieces {
    /// Splits `source` into declarations and returns their indices, storing new ones. The
    /// declarations join back into exactly `source`.
    fn add(&mut self, source: &str) -> Vec<u16> {
        let refs: Vec<u16> = source
            .split(SEPARATOR)
            .map(|piece| {
                *self.index.entry(piece.to_owned()).or_insert_with(|| {
                    let start = self.text.len() as u32;
                    self.text.push_str(piece);
                    self.ranges.push((start, self.text.len() as u32));
                    u16::try_from(self.ranges.len() - 1).expect("fewer than 65536 declarations")
                })
            })
            .collect();
        let joined: Vec<&str> = refs
            .iter()
            .map(|&r| &self.text[self.ranges[r as usize].0 as usize..self.ranges[r as usize].1 as usize])
            .collect();
        assert_eq!(joined.join(SEPARATOR), source, "a variant's declarations join back into the module it linked");
        refs
    }
}

/// The names of the constants `module` declares as `override`s.
fn constant_names(module: &naga::Module) -> Vec<String> {
    module.overrides.iter().map(|(_, o)| o.name.clone().expect("a named override")).collect()
}

/// Reflection follows only the stages used by one pipeline. Constants read solely by another
/// entry cannot create extra copies of this pipeline in the runtime cache.
fn entry_constants(module: &naga::Module) -> Vec<String> {
    module
        .entry_points
        .iter()
        .map(|entry| {
            let fragment = if entry.name == "vertex" { "fragment" } else { &entry.name };
            let mut reachable = module.clone();
            reachable.entry_points.retain(|stage| stage.name == "vertex" || stage.name == fragment);
            let reachable = crate::prune::module(reachable);
            let names = constant_names(&reachable);
            format!("({:?}, &{names:?})", entry.name)
        })
        .collect()
}

/// The constants pipelines specialize `module` with, linked as `source`: each one's type, and the
/// declaration that declares it, which each pipeline's module replaces with a `const`.
fn constants<'a>(module: &naga::Module, names: &'a [String], source: &str) -> Vec<Constant<'a>> {
    module
        .overrides
        .iter()
        .zip(names)
        .map(|((_, o), name)| {
            let bool = match module.types[o.ty].inner {
                TypeInner::Scalar(naga::Scalar::BOOL) => true,
                TypeInner::Scalar(naga::Scalar::U32) => false,
                ref other => panic!("the constant {name} is a {other:?}, not a bool or u32"),
            };
            let declares = format!("override {name}:");
            let at = source
                .split(SEPARATOR)
                .position(|piece| piece.starts_with(&declares))
                .unwrap_or_else(|| panic!("no declaration of its own for the constant {name}"));
            Constant { name, at: u16::try_from(at).expect("fewer than 65536 declarations"), bool }
        })
        .collect()
}

/// Writes the module of each specialization of a variant that pipelines use, as the runtime writes
/// it, and validates it, with the placeholder marker appended if `custom`. Returns each as JSON: its
/// file, together with the retained declarations used by the runtime.
#[expect(clippy::too_many_arguments, reason = "one variant's linked and validated forms")]
fn manifest_entries(
    shader: &str,
    file: &str,
    source: &str,
    constants: &[Constant<'_>],
    module: &naga::Module,
    types: &naga::Module,
    custom: bool,
    out: &Path,
    pieces: &mut Pieces,
) -> (Vec<String>, Vec<String>) {
    let append = if custom { CUSTOM_MARKER } else { "" };
    let mut specializations = Vec::new();
    let entries = combinations(shader, module, types)
        .iter()
        .map(|values| {
            let value = |name: &str| values.iter().find(|(n, _)| *n == name).map(|&(_, v)| v).expect("a value");
            let mut specialized = specialize(source.split(SEPARATOR), constants, value);
            // Expression programs supply these functions at runtime. This representative kernel
            // exercises precise positions, field reads, scale fitting, and state metadata in
            // the translation/browser gate; program conformance tests cover all operations.
            if shader == "raster::state" {
                specialized = crate::specialize::evaluator(&specialized, STATE_KERNEL);
            } else if !custom {
                specialized = prune(&specialized);
                let values: Vec<u32> = constants.iter().map(|c| value(c.name)).collect();
                let refs = pieces.add(&specialized);
                specializations.push(format!("Specialization {{ values: &{values:?}, pieces: &{refs:?} }}"));
            }
            let mut file = file.to_owned();
            for (name, value) in values {
                write!(file, ".{name}={value}").unwrap();
            }
            file.push_str(".wgsl");
            let (checked, _) = validate(&file, &format!("{specialized}\n{append}"));
            assert!(checked.overrides.is_empty(), "{file}: a pipeline's module sets every constant itself");
            fs::write(out.join(&file), &specialized).unwrap();
            glsl(&checked, &file, out);
            format!("  {{ \"file\": {file:?} }}")
        })
        .collect();
    (entries, specializations)
}

/// Naga folds constant expressions while parsing, but retains both sides of constant branches.
/// Remove those unreachable blocks and their unused functions at build time, so drivers compile
/// only the geometry a pipeline uses. The optimized module is validated again before emission.
fn prune(source: &str) -> String {
    let (module, _) = validate("before pruning", source);
    let module = crate::prune::module(module);
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .expect("pruned shader is valid");
    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::EXPLICIT_TYPES)
        .expect("pruned shader writes WGSL")
}

/// Emits each raster entry as GLSL ES 3.00 and its reflected bindings for the browser gate. A
/// shader that needs compute, storage buffers, or a newer GLSL version fails during the build.
fn glsl(linked: &naga::Module, name: &str, out: &Path) {
    use naga::back::glsl::{Options, PipelineOptions, Version, Writer};
    let options = Options {
        version: Version::Embedded { version: 300, is_webgl: true },
        writer_flags: naga::back::glsl::WriterFlags::ADJUST_COORDINATE_SPACE
            | naga::back::glsl::WriterFlags::FORCE_POINT_SIZE,
        ..Default::default()
    };
    let mut entries = Vec::new();
    for entry in &linked.entry_points {
        let module = crate::prune::entry(linked.clone(), &entry.name);
        let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
            .validate(&module)
            .unwrap_or_else(|e| panic!("{name} {}: {e}", entry.name));
        assert!(entry.stage != naga::ShaderStage::Compute, "raster shaders cannot dispatch compute");
        let pipeline = PipelineOptions { shader_stage: entry.stage, entry_point: entry.name.clone(), multiview: None };
        let mut source = String::new();
        let reflected =
            Writer::new(&mut source, &module, &info, &options, &pipeline, naga::proc::BoundsCheckPolicies::default())
                .unwrap_or_else(|e| panic!("GLSL ES 3.00 {name} {}: {e}", entry.name))
                .write()
                .unwrap_or_else(|e| panic!("GLSL ES 3.00 {name} {}: {e}", entry.name));
        let file = format!("{name}.{}.glsl", entry.name);
        fs::write(out.join(&file), &source).unwrap();
        let binding = |handle: naga::Handle<naga::GlobalVariable>, name: &str| {
            let b = module.global_variables[handle].binding.as_ref().expect("a bound resource");
            format!("{{\"name\":{name:?},\"group\":{},\"binding\":{}}}", b.group, b.binding)
        };
        let mut textures: Vec<_> = reflected.texture_mapping.iter().map(|(name, m)| binding(m.texture, name)).collect();
        let mut uniforms: Vec<_> = reflected.uniforms.iter().map(|(&handle, name)| binding(handle, name)).collect();
        textures.sort();
        uniforms.sort();
        entries.push(format!(
            "{{\"file\":{file:?},\"entry\":{:?},\"stage\":{:?},\"textures\":[{}],\"uniforms\":[{}]}}",
            entry.name,
            format!("{:?}", entry.stage),
            textures.join(","),
            uniforms.join(",")
        ));
    }
    fs::write(out.join(format!("{name}.glsl.json")), format!("[{}]\n", entries.join(",\n"))).unwrap();
}

/// Every combination of `module`'s constants that pipelines use.
fn combinations<'a>(shader: &str, module: &'a naga::Module, types: &naga::Module) -> Vec<Vec<(&'a str, u32)>> {
    let mut combinations: Vec<Vec<(&str, u32)>> = vec![Vec::new()];
    for (_, o) in module.overrides.iter() {
        let name = o.name.as_deref().expect("a named override");
        let (_, values) = OVERRIDES.iter().find(|(n, _)| *n == name).unwrap_or_else(|| panic!("no values for {name}"));
        combinations = combinations
            .iter()
            .flat_map(|before| {
                values.iter().map(move |value| {
                    let mut next = before.clone();
                    let value = match *value {
                        "false" => 0,
                        "true" => 1,
                        name => type_constant(types, name),
                    };
                    next.push((name, value));
                    next
                })
            })
            .filter(|c| made(shader, c, types))
            .collect();
    }
    combinations
}

/// Whether any pipeline of `module` uses `constants`. Only channel evaluation (`raster::state`)
/// runs without joins or samples. Points read no path, so they keep the default `PATH_ENDS`;
/// area triangles always read geometry.
fn made(module: &str, constants: &[(&str, u32)], types: &naga::Module) -> bool {
    let value = |name: &str| constants.iter().find(|(n, _)| *n == name).map(|&(_, v)| v);
    // Every geometry pipeline is specialized for its scene. Only the shared expression
    // evaluator can project through any view at runtime (for pointer-dependent channels).
    if module != "raster::state" && value("PROJECTION") == Some(type_constant(types, "PROJECTION_DYNAMIC")) {
        return false;
    }
    if module != "raster::state" && (value("JOINED") == Some(0) || value("TIMED") == Some(0)) {
        return false;
    }
    let path = value("PATH");
    if module == "draw::areas" {
        return path == Some(type_constant(types, "PATH_GEOMETRY"));
    }
    match (value("PRIMITIVE"), path) {
        (Some(primitive), Some(path)) => {
            primitive == type_constant(types, "STROKES")
                || path == type_constant(types, "PATH_ENDS")
                || (primitive == type_constant(types, "TRIANGLES") && path == type_constant(types, "PATH_GEOMETRY"))
        }
        _ => true,
    }
}

/// The value of `lib/types.wesl`'s `u32` constant `name`.
fn type_constant(types: &naga::Module, name: &str) -> u32 {
    let (_, constant) = types.constants.iter().find(|(_, c)| c.name.as_deref() == Some(name)).expect("a constant");
    match types.global_expressions[constant.init] {
        naga::Expression::Literal(naga::Literal::U32(v)) => v,
        _ => panic!("{name} is not a u32"),
    }
}

fn shader_name(module: &str, variant: &str) -> String {
    let words = module.split("::").skip(1).chain((variant != "main").then_some(variant));
    words
        .flat_map(|w| w.split('_'))
        .map(|w| {
            let mut chars = w.chars();
            chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
        })
        .collect()
}

fn link(root: &Path, module: &str, features: &[&str], keep_main: bool) -> String {
    let mut options =
        wesl::CompileOptions { mangler: wesl::ManglerKind::None, validate: false, keep_main, ..Default::default() };
    for feature in FEATURES {
        options.features.set(*feature, features.contains(feature));
    }
    let path = format!("package::{module}").parse().unwrap();
    let mut linked = wesl::Compiler::new(options)
        .compile_module(root, &path)
        .unwrap_or_else(|e| panic!("WESL {module} {features:?}: {e}"))
        .syntax;
    if module == "raster::state" {
        // Kernels are supplied at runtime. Retain the helper library's public declarations
        // explicitly; ordinary reachability stripping still removes unrelated imported code.
        let helpers = wesl::Compiler::new(wesl::CompileOptions {
            mangler: wesl::ManglerKind::None,
            validate: false,
            keep_main: true,
            ..Default::default()
        })
        .compile_module(root, &"package::lib::evaluate".parse().unwrap())
        .expect("kernel helpers")
        .syntax;
        let mut names: std::collections::HashSet<String> =
            linked.global_declarations.iter().map(ToString::to_string).collect();
        for declaration in helpers.global_declarations {
            if names.insert(declaration.to_string()) {
                linked.global_declarations.push(declaration);
            }
        }
    }
    // The linker orders the declarations it imports differently on each run. WGSL takes them in any
    // order, so sorting them makes every build of the shaders, and of the packages, the same.
    linked.global_declarations.sort_by_cached_key(ToString::to_string);
    linked.to_string()
}

fn validate(name: &str, source: &str) -> (naga::Module, ModuleInfo) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|e| panic!("WGSL {name}:\n{}\n{source}", e.emit_to_string(source)));
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .unwrap_or_else(|e| panic!("WGSL {name}:\n{}", e.emit_to_string(source)));
    (module, info)
}

/// Writes every `u32`, `i32`, and `f32` constant as a Rust constant.
fn mirror_consts(module: &naga::Module, rust: &mut String) {
    for (_, constant) in module.constants.iter() {
        let Some(name) = &constant.name else { continue };
        let value = match module.global_expressions[constant.init] {
            naga::Expression::Literal(naga::Literal::U32(v)) => format!("u32 = {v:#x}"),
            naga::Expression::Literal(naga::Literal::I32(v)) => format!("i32 = {v}"),
            naga::Expression::Literal(naga::Literal::F32(v)) => format!("f32 = {v:?}"),
            _ => continue,
        };
        writeln!(rust, "#[allow(dead_code)]\npub(crate) const {name}: {value};").unwrap();
    }
    rust.push('\n');
}

/// Writes every struct as a `#[repr(C)]` mirror with explicit padding and a size assertion.
fn mirror_structs(module: &naga::Module, rust: &mut String) {
    for (_, ty) in module.types.iter() {
        let (Some(name), TypeInner::Struct { members, span }) = (&ty.name, &ty.inner) else { continue };
        writeln!(
            rust,
            "#[repr(C)]\n#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]\npub(crate) struct {name} {{"
        )
        .unwrap();
        let mut at = 0;
        let mut pads = 0;
        for member in members {
            pad(rust, &mut at, member.offset, &mut pads);
            let (field_type, size) = rust_type(module, member.ty);
            writeln!(rust, "    pub(crate) {}: {field_type},", member.name.as_deref().unwrap()).unwrap();
            at = member.offset + size;
        }
        pad(rust, &mut at, *span, &mut pads);
        writeln!(rust, "}}\n\nconst _: () = assert!(size_of::<{name}>() == {span});\n").unwrap();
    }
}

fn pad(rust: &mut String, at: &mut u32, to: u32, pads: &mut u32) {
    if to > *at {
        assert_eq!((to - *at) % 4, 0, "padding is whole words");
        writeln!(rust, "    pub(crate) _pad{pads}: [u32; {}],", (to - *at) / 4).unwrap();
        *pads += 1;
        *at = to;
    }
}

fn rust_type(module: &naga::Module, ty: naga::Handle<naga::Type>) -> (String, u32) {
    let scalar = |s: naga::Scalar| match (s.kind, s.width) {
        (ScalarKind::Float, 4) => "f32",
        (ScalarKind::Uint, 4) => "u32",
        (ScalarKind::Sint, 4) => "i32",
        other => panic!("no mirror for scalar {other:?}"),
    };
    let size = |v: VectorSize| v as u32;
    match &module.types[ty].inner {
        TypeInner::Scalar(s) => (scalar(*s).into(), 4),
        TypeInner::Vector { size: n, scalar: s } => (format!("[{}; {}]", scalar(*s), size(*n)), 4 * size(*n)),
        TypeInner::Matrix { columns, rows, scalar: s } => {
            assert_eq!(*rows, VectorSize::Quad, "matrix columns are padded to four rows");
            (format!("[[{}; 4]; {}]", scalar(*s), size(*columns)), 16 * size(*columns))
        }
        TypeInner::Array { base, size: ArraySize::Constant(n), stride } => {
            let (element, element_size) = rust_type(module, *base);
            assert_eq!(element_size, *stride, "array elements are not padded");
            (format!("[{element}; {n}]"), stride * n.get())
        }
        TypeInner::Struct { span, .. } => (module.types[ty].name.clone().expect("a named struct"), *span),
        other => panic!("no mirror for {other:?}"),
    }
}

/// The bindings of `group` as `Binding` literals. With `info`, each binding is visible to the
/// stages whose entry points use it. Without `info`, every stage sees it.
fn bindings(module: &naga::Module, info: Option<&ModuleInfo>, group: u32) -> Vec<String> {
    let mut found = BTreeMap::new();
    for (handle, global) in module.global_variables.iter() {
        let Some(binding) = &global.binding else { continue };
        if binding.group != group {
            continue;
        }
        let stages = match info {
            Some(info) => module
                .entry_points
                .iter()
                .enumerate()
                .filter(|(i, _)| !info.get_entry_point(*i)[handle].is_empty())
                .map(|(_, e)| match e.stage {
                    naga::ShaderStage::Vertex => "VERTEX",
                    naga::ShaderStage::Fragment => "FRAGMENT",
                    other => panic!("unexpected stage {other:?}"),
                })
                .collect::<Vec<_>>(),
            None => vec!["VERTEX", "FRAGMENT"],
        };
        let kind = match (global.space, &module.types[global.ty].inner) {
            (AddressSpace::Uniform, TypeInner::Struct { span, .. }) => {
                assert!(span.is_multiple_of(16), "WebGL2 uniform {:?} must occupy whole 16-byte slots", global.name);
                "Kind::Uniform".to_owned()
            }
            (AddressSpace::Handle, TypeInner::Sampler { .. }) => "Kind::Sampler".to_owned(),
            (
                AddressSpace::Handle,
                TypeInner::Image {
                    dim: ImageDimension::D2,
                    arrayed,
                    class: ImageClass::Sampled { kind: ScalarKind::Uint, multi: false },
                },
            ) => format!("Kind::Words {{ array: {arrayed} }}"),
            (AddressSpace::Handle, TypeInner::Image { dim: ImageDimension::D2, arrayed, class }) => {
                let filterable = matches!(class, ImageClass::Sampled { kind: ScalarKind::Float, multi: false })
                    && info.is_none_or(|info| {
                        module.entry_points.iter().enumerate().any(|(i, _)| {
                            info.get_entry_point(i).sampling_set.iter().any(|sample| sample.image == handle)
                        })
                    });
                format!("Kind::Texture {{ array: {arrayed}, filterable: {filterable} }}")
            }
            other => panic!("unsupported binding {:?}: {other:?}", global.name),
        };
        let mut stages = stages;
        stages.sort_unstable();
        stages.dedup();
        let stages = if stages.is_empty() { "0".to_owned() } else { stages.join(" | ") };
        let dynamic = global.name.as_deref().is_some_and(|name| DYNAMIC.contains(&name));
        let entry =
            format!("Binding {{ slot: {}, kind: {kind}, stages: {stages}, dynamic: {dynamic} }}", binding.binding);
        assert!(found.insert(binding.binding, entry).is_none(), "binding {group}.{} declared twice", binding.binding);
    }
    found.into_values().collect()
}

/// Asserts that every group 0 and 1 binding a shader declares matches the shared declaration.
fn check_shared(module: &naga::Module, shared: &naga::Module, name: &str) {
    for (_, global) in module.global_variables.iter() {
        let Some(binding) = &global.binding else { continue };
        if binding.group > 1 {
            continue;
        }
        let same = shared
            .global_variables
            .iter()
            .any(|(_, s)| s.binding.as_ref() == Some(binding) && s.name == global.name && s.space == global.space);
        assert!(
            same,
            "{name}: {:?} at group {} binding {} is not the shared declaration",
            global.name, binding.group, binding.binding
        );
    }
}
