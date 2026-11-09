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
/// resources only other entry points use are left out first. Fails if the entry is missing, is a
/// compute entry, or does not translate.
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
    Ok(format!("{version}\n{}\n{rest}", header.join("\n")))
}
