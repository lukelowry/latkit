//! Links every WESL entry, validates it with naga, and writes `OUT_DIR/shaders.rs`, containing:
//!
//! - Every constant and struct of `lib/types.wesl`, as Rust constants and `#[repr(C)]` mirrors
//!   whose sizes are checked against WGSL.
//! - The shared bind group layouts of `lib/bind.wesl` (group 0 per view, group 1 per mark).
//! - Per shader variant: its declarations, the constants pipelines specialize it with, its pass
//!   group layout (group 2), and whether it uses the shared groups.
//!
//! Natively, variants share most of their linked code, so each distinct top-level declaration is
//! stored once in `OUT_DIR/shaders.wgsl`. A variant is a list of declaration indices that join back
//! into exactly the module it linked.
//!
//! For the browser, every entry point of every specialization pipelines use is translated to GLSL
//! ES 3.00 here (see `src/gpu/glsl.rs`), so the page translates nothing. The translations go in
//! `OUT_DIR/shaders.bin` (see [`Store`]), which the browser build carries in its WebAssembly, with
//! the linked WGSL of the custom marker shaders, which translate once a page draws a custom marker. The channel shader's evaluating entries are
//! translated without their kernel, which the page writes in GLSL for each program and appends.
//!
//! It also writes the module of every specialization pipelines use, exactly as the runtime writes
//! it (see `src/gpu/specialize.rs`) and validated, with each entry's GLSL, and
//! `OUT_DIR/shaders.json` listing each one's file. The browser gate reads it to compile each
//! pipeline in Chrome.

use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};
use naga::{AddressSpace, ArraySize, ImageClass, ImageDimension, ScalarKind, TypeInner, VectorSize};

use crate::specialize::{Constant, SEPARATOR, evaluator, specialize};

/// A shader module and its variants. Each variant enables its listed WESL features.
struct Entry {
    module: &'static str,
    variants: &'static [(&'static str, &'static [&'static str])],
}

const ENTRIES: &[Entry] = &[
    Entry { module: "raster::words", variants: &[("main", &[]), ("gather", &["gather"])] },
    Entry { module: "raster::lengths", variants: &[("main", &[])] },
    Entry { module: "raster::order", variants: &[("main", &[]), ("scatter", &["scatter"])] },
    Entry { module: "raster::state", variants: &[("main", &[])] },
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

const FEATURES: &[&str] = &["custom", "focused", "columns", "scatter", "gather"];

/// A placeholder custom marker function, appended to validate the custom variants.
const CUSTOM_MARKER: &str = "fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }";

/// The channel shader's entry points that run a mark's kernel.
const KERNEL_ENTRIES: [&str; 2] = ["evaluate", "reduce"];

/// The register counts kernels compile with (see `src/gpu/kernel.rs`).
const KERNEL_ROWS: [u32; 2] = [16, 32];

/// The functions of `lib/evaluate.wesl` that kernels call, which translation must not rename.
const KERNEL_CALLS: &[&str] = &[
    "k_set",
    "k_quad",
    "k_four",
    "k_load_row",
    "k_finish",
    "k_mask",
    "k_domains",
    "k_code",
    "k_elapsed",
    "k_constant",
    "k_constant_float",
    "k_field",
    "k_viewed",
    "k_theme",
    "k_number",
    "k_bits",
    "k_missing",
    "k_missing_bits",
    "k_scale",
    "k_domain",
    "k_color",
    "k_ordered",
    "k_fallback",
    "k_load",
    "k_store",
    "k_store_flag",
    "k_position",
];

/// A kernel calling every function kernels call, for `rows` registers. Its translation keeps them
/// all, and in the browser's copy the three functions a kernel writes become declarations that a
/// program's kernel defines. It also exercises precise positions, field reads, scale fitting, and
/// state metadata in the browser gate; program conformance tests cover all operations.
fn reference_kernel(rows: u32) -> String {
    format!(
        r"const ROW_WORDS: u32 = {rows}u;
fn k_load_words(at: u32) {{
    let q = k_quad(at);
    let f = k_four(at + 4u);
    k_set(0u, q.x); k_set(1u, q.y); k_set(4u, f.x); k_set(5u, f.w);
}}
fn k_output(plane: u32) -> vec4u {{
    switch plane {{
        case 0u: {{ return vec4u(k_load(0u, 0u), k_load(0u, 1u), k_load(0u, 2u), k_load(0u, 3u)); }}
        default: {{ return vec4u(0u); }}
    }}
}}
fn k_channels(row: u32, clear: bool, plane: u32) {{
    _ = k_run(row, plane, plane);
}}
fn k_run(row: u32, start: u32, end: u32) -> Reduction {{
    k_load_row(row, start == 0u);
    if (k_mask() & 1u) != 0u {{ k_position(row, 0u, k_field(0u, row), k_field(1u, row)); }}
    let x = k_number(k_field(2u, row).x) + k_constant_float(start);
    let scaled = k_scale(x, k_domain(0u), vec2f(2.0, 12.0));
    let color = k_color(k_code(1u) & 0xffffu, 2u, scaled, k_domain(4u));
    let shown = select(k_constant(3u), k_viewed(5u, row), k_missing_bits(k_theme(2u)));
    k_store(row, 4u, k_fallback(k_bits(scaled), 7u));
    k_store(row, 5u, color ^ shown ^ k_elapsed());
    k_store_flag(row, 10u, 1u, scaled > 0.5);
    if (k_load(row, 10u) & 2u) == 0u {{ k_store(row, 6u, k_bits(-x)); }}
    k_finish(row);
    if !k_missing(x) {{ return Reduction(k_domains() + end, vec2u(~k_ordered(x), k_ordered(x))); }}
    return Reduction(4294967295u, vec2u(0u));
}}"
    )
}

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

    // A browser build draws on its own WebGL2 device with the GLSL translated here, so it carries no
    // WGSL but the custom marker shaders', which go in the store.
    let browser = env::var("CARGO_CFG_TARGET_ARCH").is_ok_and(|arch| arch == "wasm32");
    let mut shaders = String::new();
    let mut sources = String::new();
    let mut manifest = Vec::new();
    let mut pieces = Pieces::default();
    let mut store = Store::default();
    for entry in ENTRIES {
        for &(variant, features) in entry.variants {
            let source = link(&root, entry.module, features, false);
            // Custom variants lack the application's marker, so validation appends a placeholder.
            let custom = features.contains(&"custom");
            let checked = if custom { format!("{source}\n{CUSTOM_MARKER}") } else { source.clone() };
            let (module, info) = validate(&format!("{}.{variant}", entry.module), &checked);
            check_shared(&module, &bind_module, entry.module);
            check_targets(&module, entry.module);
            let names = constant_names(&module);
            let constants = constants(&module, &names, &source);
            let file = format!("{}.{variant}", entry.module.replace("::", "."));
            let name = shader_name(entry.module, variant);
            let shader = Specializing {
                shader: entry.module,
                name: &name,
                file: &file,
                source: &source,
                constants: &constants,
                module: &module,
                types: &types_module,
                custom,
            };
            let (entries, specializations) = shader.specializations(&out, &mut pieces, &mut store, browser);
            manifest.extend(entries);
            let label = format!("latkit {}.{variant}", entry.module);
            if custom {
                store.add(&format!("wgsl {label}"), &source);
            }
            writeln!(shaders, "    {name},").unwrap();
            let pass = bindings(&module, (entry.module != "raster::state").then_some(&info), 2);
            let constants: Vec<String> = constants
                .iter()
                .map(|c| format!("Constant {{ name: {:?}, at: {}, bool: {} }}", c.name, c.at, c.bool))
                .collect();
            let shared = module.global_variables.iter().any(|(_, g)| g.binding.as_ref().is_some_and(|b| b.group < 2));
            let entry_constants =
                if custom || entry.module == "raster::state" { Vec::new() } else { entry_constants(&module) };
            // Natively, a shader's WGSL joins its declarations. The browser build's shaders are in
            // its store instead.
            let declarations = if browser {
                String::new()
            } else {
                format!(" pieces: &{:?}, specializations: &[{}],", pieces.add(&source), specializations.join(", "))
            };
            writeln!(
                sources,
                "        Shader::{name} => &ShaderSource {{ label: {label:?},{declarations} pass: &[{pass}], constants: &[{constants}], entry_constants: &[{entry_constants}], shared: {shared}, size: {size} }},",
                pass = pass.join(", "),
                constants = constants.join(", "),
                entry_constants = entry_constants.join(", "),
                size = source.len(),
            )
            .unwrap();
        }
    }
    fs::write(out.join("shaders.wgsl"), &pieces.text).unwrap();
    fs::write(out.join("shaders.bin"), store.finish()).unwrap();
    writeln!(
        rust,
        "/// Each declaration's byte range in `shaders.wgsl`.\n#[cfg(not(target_arch = \"wasm32\"))]\npub(crate) static PIECES: &[(u32, u32)] = &{:?};\n",
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

/// One linked shader variant, specialized for each combination of values pipelines use.
struct Specializing<'a> {
    /// Its WESL module, such as `raster::state`.
    shader: &'a str,
    /// Its `Shader` variant's name.
    name: &'a str,
    /// The stem of the files written for it.
    file: &'a str,
    source: &'a str,
    constants: &'a [Constant<'a>],
    module: &'a naga::Module,
    types: &'a naga::Module,
    /// Whether it lacks a custom marker's function, which validation appends a placeholder for.
    custom: bool,
}

impl Specializing<'_> {
    /// Writes the module of each specialization pipelines use, as the runtime writes it, and
    /// validates it, then translates each entry point to GLSL for the browser's `store`, except a
    /// custom marker shader's. Returns each module as JSON for the browser gate and, natively, the
    /// `Specialization` of each pruned module for the runtime, with its declarations in `pieces`.
    fn specializations(
        &self,
        out: &Path,
        pieces: &mut Pieces,
        store: &mut Store,
        browser: bool,
    ) -> (Vec<String>, Vec<String>) {
        let mut manifest = Vec::new();
        let mut specializations = Vec::new();
        for values in combinations(self.shader, self.module, self.types) {
            let value = |name: &str| values.iter().find(|(n, _)| *n == name).map(|&(_, v)| v).expect("a value");
            let numbers: Vec<u32> = self.constants.iter().map(|c| value(c.name)).collect();
            let mut file = self.file.to_owned();
            for (name, value) in &values {
                write!(file, ".{name}={value}").unwrap();
            }
            let specialized = specialize(self.source.split(SEPARATOR), self.constants, value);
            if self.shader == "raster::state" {
                // Without a kernel for the entries that run none. Each kernel runs in a module
                // translated for its register count, which a program's kernel completes.
                let plain = Self::write(out, &format!("{file}.wgsl"), &specialized, "");
                for (entry, glsl) in plain.into_iter().filter(|(entry, _)| !KERNEL_ENTRIES.contains(&entry.as_str())) {
                    store.add(&format!("{} {entry} {numbers:?}", self.name), &glsl);
                }
                manifest.push(format!("  {{ \"file\": {:?} }}", format!("{file}.wgsl")));
                for rows in KERNEL_ROWS {
                    let kerneled = evaluator(&specialized, &reference_kernel(rows));
                    let name = format!("{file}.ROW_WORDS={rows}.wgsl");
                    for (entry, glsl) in Self::write(out, &name, &kerneled, "") {
                        if KERNEL_ENTRIES.contains(&entry.as_str()) {
                            store.add(&format!("{} {entry} {numbers:?} rows {rows}", self.name), &template(&glsl));
                        }
                    }
                    manifest.push(format!("  {{ \"file\": {name:?} }}"));
                }
                continue;
            }
            let file = format!("{file}.wgsl");
            if self.custom {
                Self::write(out, &file, &specialized, CUSTOM_MARKER);
            } else {
                let pruned = prune(&specialized);
                if !browser {
                    let refs = pieces.add(&pruned);
                    specializations.push(format!("Specialization {{ values: &{numbers:?}, pieces: &{refs:?} }}"));
                }
                for (entry, glsl) in Self::write(out, &file, &pruned, "") {
                    store.add(&format!("{} {entry} {numbers:?}", self.name), &glsl);
                }
            }
            manifest.push(format!("  {{ \"file\": {file:?} }}"));
        }
        (manifest, specializations)
    }

    /// Validates `wgsl` with `appended`, writes it to `file` with each entry's GLSL for the gate, and
    /// returns each entry point's name and GLSL.
    fn write(out: &Path, file: &str, wgsl: &str, appended: &str) -> Vec<(String, String)> {
        let (checked, _) = validate(file, &format!("{wgsl}\n{appended}"));
        assert!(checked.overrides.is_empty(), "{file}: a pipeline's module sets every constant itself");
        fs::write(out.join(file), wgsl).unwrap();
        let mut gate = Vec::new();
        let translated: Vec<(String, String)> = checked
            .entry_points
            .iter()
            .map(|entry| {
                let glsl = crate::glsl::translate(&checked, &entry.name)
                    .unwrap_or_else(|e| panic!("GLSL ES 3.00 {file} {}: {e}", entry.name));
                let name = format!("{file}.{}.glsl", entry.name);
                fs::write(out.join(&name), &glsl).unwrap();
                gate.push(gate_entry(&name, &entry.name, entry.stage, &glsl));
                (entry.name.clone(), glsl)
            })
            .collect();
        fs::write(out.join(format!("{file}.glsl.json")), format!("[{}]\n", gate.join(",\n"))).unwrap();
        translated
    }
}

/// An entry's GLSL as the browser gate reads it: its file, entry, stage, and bindings.
fn gate_entry(file: &str, entry: &str, stage: naga::ShaderStage, glsl: &str) -> String {
    let (mut textures, mut uniforms) = (Vec::new(), Vec::new());
    for line in glsl.lines().filter_map(|line| line.strip_prefix("//@")) {
        let words: Vec<&str> = line.split(' ').collect();
        let binding = format!("{{\"name\":{:?},\"group\":{},\"binding\":{}}}", words[1], words[2], words[3]);
        match words[0] {
            "uniform" => uniforms.push(binding),
            _ => textures.push(binding),
        }
    }
    format!(
        "{{\"file\":{file:?},\"entry\":{entry:?},\"stage\":{:?},\"textures\":[{}],\"uniforms\":[{}]}}",
        format!("{stage:?}"),
        textures.join(","),
        uniforms.join(",")
    )
}

/// The GLSL of a kernel entry translated with [`reference_kernel`], with the functions a kernel
/// writes left as declarations, which the kernel a page appends defines. Asserts that the
/// functions kernels call kept their names.
fn template(glsl: &str) -> String {
    let defines = |name: &str| {
        glsl.lines().any(|line| {
            !line.starts_with([' ', '/', '#'])
                && line.split('(').next().is_some_and(|head| head.ends_with(&format!(" {name}")))
        })
    };
    for name in KERNEL_CALLS {
        assert!(defines(name), "translation renamed {name}, which kernels call:\n{glsl}");
    }
    assert!(glsl.contains("struct Reduction {"), "translation renamed Reduction, which kernels return");
    let mut out = String::with_capacity(glsl.len());
    let mut lines = glsl.split_inclusive('\n');
    while let Some(line) = lines.next() {
        let head = line.split('(').next().unwrap_or("");
        let written =
            ["k_load_words", "k_channels", "k_run", "k_output"].iter().any(|name| head.ends_with(&format!(" {name}")));
        if written && !line.starts_with(' ') && line.trim_end().ends_with('{') {
            out.push_str(line.trim_end().trim_end_matches('{').trim_end());
            out.push_str(";\n");
            // Skip the body, which ends at the first closing brace in the first column.
            for line in lines.by_ref() {
                if line.starts_with('}') {
                    break;
                }
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Deduplicated text for the browser: each translated entry's GLSL, and the custom marker shaders'
/// WGSL, by key. Texts are split into chunks at blank lines and at each `struct` and `const`
/// declaration, and each distinct chunk is stored once. Chunks are packed in their first order into
/// blocks of about [`BLOCK`] bytes, each compressed with deflate on its own, so a page inflates only
/// the blocks the shaders it compiles use.
///
/// `shaders.bin`, all little-endian: the index's compressed and inflated sizes and its deflate
/// stream, then the block count, and each block's compressed and inflated sizes followed by its
/// deflate stream. The inflated index holds the chunk count, each chunk's block, start, and length,
/// then the text count, and each text's key length, key, chunk count, and chunk indices.
#[derive(Default)]
struct Store {
    chunks: Vec<String>,
    index: HashMap<String, u32>,
    texts: Vec<(String, Vec<u32>)>,
}

/// The inflated bytes of a store block, at most, unless one chunk is longer.
const BLOCK: usize = 32 << 10;

impl Store {
    fn add(&mut self, key: &str, text: &str) {
        let mut chunks = Vec::new();
        let mut chunk = String::new();
        let mut blank = false;
        for line in text.split_inclusive('\n') {
            let starts = blank || line.starts_with("struct ") || line.starts_with("const ");
            if starts && !chunk.is_empty() {
                chunks.push(std::mem::take(&mut chunk));
            }
            blank = line.trim().is_empty();
            chunk.push_str(line);
        }
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        let ids = chunks
            .into_iter()
            .map(|chunk| {
                let next = self.chunks.len() as u32;
                *self.index.entry(chunk).or_insert_with_key(|chunk| {
                    self.chunks.push(chunk.clone());
                    next
                })
            })
            .collect::<Vec<u32>>();
        let joined: String = ids.iter().map(|&id| self.chunks[id as usize].as_str()).collect();
        assert_eq!(joined, text, "a text's chunks join back into it");
        assert!(!self.texts.iter().any(|(k, _)| k == key), "the store has {key} once");
        self.texts.push((key.to_owned(), ids));
    }

    fn finish(self) -> Vec<u8> {
        let compress = |bytes: &[u8]| {
            let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        };
        let mut blocks: Vec<String> = vec![String::new()];
        let mut index = Vec::new();
        index.extend((self.chunks.len() as u32).to_le_bytes());
        for chunk in &self.chunks {
            let mut at = blocks.len() - 1;
            if !blocks[at].is_empty() && blocks[at].len() + chunk.len() > BLOCK {
                blocks.push(String::new());
                at += 1;
            }
            for word in [at as u32, blocks[at].len() as u32, chunk.len() as u32] {
                index.extend(word.to_le_bytes());
            }
            blocks[at].push_str(chunk);
        }
        index.extend((self.texts.len() as u32).to_le_bytes());
        for (key, ids) in &self.texts {
            index.extend(u16::try_from(key.len()).unwrap().to_le_bytes());
            index.extend(key.as_bytes());
            index.extend((ids.len() as u32).to_le_bytes());
            for id in ids {
                index.extend(id.to_le_bytes());
            }
        }
        let mut out = Vec::new();
        let packed = compress(&index);
        out.extend((packed.len() as u32).to_le_bytes());
        out.extend((index.len() as u32).to_le_bytes());
        out.extend(packed);
        out.extend((blocks.len() as u32).to_le_bytes());
        for block in &blocks {
            let packed = compress(block.as_bytes());
            out.extend((packed.len() as u32).to_le_bytes());
            out.extend((block.len() as u32).to_le_bytes());
            out.extend(packed);
        }
        out
    }
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

/// Asserts that each fragment entry of `module` writes at most one color target. ANGLE on D3D11
/// builds a pixel shader for the first target when a program links, and one for more targets on
/// the browser's GPU thread when a frame first draws with it, stalling the page.
fn check_targets(module: &naga::Module, name: &str) {
    for entry in module.entry_points.iter().filter(|e| e.stage == naga::ShaderStage::Fragment) {
        let Some(result) = &entry.function.result else { continue };
        if let TypeInner::Struct { members, .. } = &module.types[result.ty].inner {
            let targets = members.iter().filter(|m| matches!(m.binding, Some(naga::Binding::Location { .. }))).count();
            assert!(targets <= 1, "{name}.{} writes {targets} color targets; raster shaders write one", entry.name);
        }
    }
}

/// Every combination of `module`'s constants that pipelines use. Asserts there is at least one,
/// since a shader the browser build translates for no pipeline crashes the first page that draws
/// with it.
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
            .collect();
    }
    // Filtered once complete, so a constant missing means the shader has none, never one not yet
    // added.
    combinations.retain(|c| made(shader, c, types));
    assert!(!combinations.is_empty(), "{shader}: no pipeline uses any combination of its constants");
    combinations
}

/// Whether any pipeline of `module` uses `constants`, all of the constants it has. Only channel
/// evaluation (`raster::state`) runs without joins or samples. Points read no path, so they keep
/// the default `PATH_ENDS`; area triangles always read geometry, and their focus variant reads no
/// path.
fn made(module: &str, constants: &[(&str, u32)], types: &naga::Module) -> bool {
    let value = |name: &str| constants.iter().find(|(n, _)| *n == name).map(|&(_, v)| v);
    // Every geometry pipeline is specialized for its scene. Only the shared expression
    // evaluator projects through any view at runtime (for pointer-dependent channels), and always
    // does.
    let dynamic = value("PROJECTION").map(|p| p == type_constant(types, "PROJECTION_DYNAMIC"));
    if dynamic == Some(module != "raster::state") {
        return false;
    }
    if module != "raster::state" && (value("JOINED") == Some(0) || value("TIMED") == Some(0)) {
        return false;
    }
    let path = value("PATH");
    if module == "draw::areas" {
        return path.is_none_or(|path| path == type_constant(types, "PATH_GEOMETRY"));
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
