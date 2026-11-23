//! Translating an entry point of a WGSL module to GLSL ES 3.00 for WebGL2. The build translates
//! latkit's shaders ahead of time with this, and custom markers translate with it when a page uses
//! one: in the npm package's translator, or here with the `wgsl` feature.
//!
//! A translation starts with a header after its `#version` line naming its bindings, one comment
//! per resource, for the WebGL2 device to bind by name:
//!
//! ```text
//! //@uniform <block> <group> <binding>
//! //@texture <sampler> <group> <binding> [<sampler group> <sampler binding>]
//! ```

use std::fmt::Write as _;

/// `module`'s entry point `entry` in GLSL ES 3.00, with the header of its bindings. Functions and
/// resources only other entry points use are left out first, and each function numbers its own names
/// the same way in every module (see [`canonical`]). Fails if the entry is missing, is a compute
/// entry, or does not translate.
pub(crate) fn translate(module: &naga::Module, entry: &str) -> Result<String, String> {
    use naga::back::glsl::{Options, PipelineOptions, Version, Writer, WriterFlags};
    let module = super::prune::entry(module.clone(), entry);
    let stage = match module.entry_points.first() {
        Some(point) if point.stage == naga::ShaderStage::Compute => {
            return Err(format!("{entry} is a compute entry point, which WebGL2 can't run"));
        }
        Some(point) => point.stage,
        None => return Err(format!("no entry point named {entry}")),
    };
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .map_err(|error| error.into_inner().to_string())?;
    let options = Options {
        version: Version::Embedded { version: 300, is_webgl: true },
        writer_flags: WriterFlags::ADJUST_COORDINATE_SPACE | WriterFlags::FORCE_POINT_SIZE,
        ..Default::default()
    };
    let pipeline = PipelineOptions { shader_stage: stage, entry_point: entry.to_owned(), multiview: None };
    let mut text = String::new();
    let reflected =
        Writer::new(&mut text, &module, &info, &options, &pipeline, naga::proc::BoundsCheckPolicies::default())
            .and_then(|mut writer| writer.write())
            .map_err(|error| error.to_string())?;
    let slot = |handle: naga::Handle<naga::GlobalVariable>| {
        let binding = module.global_variables[handle].binding.as_ref().expect("a bound resource");
        format!("{} {}", binding.group, binding.binding)
    };
    let mut header: Vec<String> =
        reflected.uniforms.iter().map(|(&handle, name)| format!("//@uniform {name} {}", slot(handle))).collect();
    for (name, mapping) in &reflected.texture_mapping {
        let mut line = format!("//@texture {name} {}", slot(mapping.texture));
        if let Some(sampler) = mapping.sampler {
            let _ = write!(line, " {}", slot(sampler));
        }
        header.push(line);
    }
    header.sort();
    let (version, rest) = text.split_once('\n').unwrap_or((&text, ""));
    Ok(canonical(&format!("{version}\n{}\n{rest}", header.join("\n"))))
}

/// GLSL `text` in chunks: split at blank lines and at each `struct` and `const` declaration, so
/// each function is a chunk of its own. The browser's shader store keeps each distinct chunk once.
pub(crate) fn chunks(text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let (mut start, mut at, mut blank) = (0, 0, false);
    for line in text.split_inclusive('\n') {
        let starts = blank || line.starts_with("struct ") || line.starts_with("const ");
        if starts && at > start {
            chunks.push(&text[start..at]);
            start = at;
        }
        blank = line.trim().is_empty();
        at += line.len();
    }
    if at > start {
        chunks.push(&text[start..at]);
    }
    chunks
}

/// Where the identifiers of GLSL `text` lie. A number's letters, as in `1e-6` and `2u`, are part of
/// the number.
fn identifiers(text: &str) -> Vec<std::ops::Range<usize>> {
    let bytes = text.as_bytes();
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        while at < bytes.len() && word(bytes[at]) {
            at += 1;
        }
        if at == start {
            at += 1;
        } else if !bytes[start].is_ascii_digit() {
            found.push(start..at);
        }
    }
    found
}

/// The base and number of a name the writer numbered to keep it unique in its module, as `p` and
/// `9` of `p_9_`.
fn numbered(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_suffix('_')?;
    let base = rest.trim_end_matches(|c: char| c.is_ascii_digit());
    let number = &rest[base.len()..];
    let base = base.strip_suffix('_')?;
    (!base.is_empty() && !number.is_empty()).then_some((base, number))
}

/// The number of a temporary, which the writer names by its expression, as `12` of `_e12`.
fn temporary(name: &str) -> Option<usize> {
    name.strip_prefix("_e")?.parse().ok()
}

/// `glsl` with each function's own names numbered the same way wherever the function is the same.
/// The writer keeps names unique across a module, so one function's argument `p` is `p_9_` in one
/// module and `p_5_` in another, and its temporaries take their expressions' numbers. Functions that
/// differ only so would each take room in the shader store, and a helper that a shader and a hook
/// both hold would not read as one. Here a numbered name that one function alone uses, and each of
/// a function's temporaries, is numbered in the order the function first uses it: `p_01_`, `_e0`.
/// Names that anything else uses keep their spelling.
fn canonical(glsl: &str) -> String {
    let chunks = chunks(glsl);
    // Each numbered name with each chunk that uses it, in name order. A name listed once is its
    // chunk's own.
    let mut users: Vec<(&str, usize)> = Vec::new();
    for (at, chunk) in chunks.iter().enumerate() {
        for range in identifiers(chunk) {
            let name = &chunk[range];
            if let Some((_, number)) = numbered(name) {
                // The writer numbers from 1 with no leading zero, which leaves those to the names here.
                assert!(!(number.len() > 1 && number.starts_with('0')), "a name ends as a renumbered name does");
                users.push((name, at));
            }
        }
    }
    users.sort_unstable();
    users.dedup();
    let own = |name: &str| {
        let first = users.partition_point(|&(other, _)| other < name);
        users.get(first + 1).is_none_or(|&(other, _)| other != name)
    };
    let mut out = String::with_capacity(glsl.len());
    for chunk in chunks {
        let head = chunk.lines().next().unwrap_or("");
        let function = !head.starts_with([' ', '/', '#']) && head.contains('(') && head.trim_end().ends_with('{');
        if !function {
            out.push_str(chunk);
            continue;
        }
        // Each temporary's new number plus one, by its old number, and each renumbered name with its
        // base and new number.
        let mut temporaries: Vec<usize> = Vec::new();
        let mut names: Vec<(&str, &str, usize)> = Vec::new();
        let (mut seen, mut at) = (0, 0);
        for range in identifiers(chunk) {
            let name = &chunk[range.clone()];
            if let Some(number) = temporary(name) {
                if temporaries.len() <= number {
                    temporaries.resize(number + 1, 0);
                }
                if temporaries[number] == 0 {
                    seen += 1;
                    temporaries[number] = seen;
                }
                out.push_str(&chunk[at..range.start]);
                let _ = write!(out, "_e{}", temporaries[number] - 1);
                at = range.end;
            } else if let Some((base, _)) = numbered(name).filter(|_| own(name)) {
                let known = names.iter().find(|&&(other, ..)| other == name).map(|&(.., number)| number);
                let number = known.unwrap_or_else(|| {
                    let number = names.iter().filter(|&&(_, other, _)| other == base).count() + 1;
                    names.push((name, base, number));
                    number
                });
                out.push_str(&chunk[at..range.start]);
                let _ = write!(out, "{base}_0{number}_");
                at = range.end;
            }
        }
        out.push_str(&chunk[at..]);
    }
    out
}
