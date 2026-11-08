//! Infer automatic layouts from the resources actually used by each shader stage.
use super::resource::Layout;
use std::collections::BTreeMap;

pub(super) type Entries = Vec<(u32, wgpu::BindGroupLayoutEntry)>;

#[cfg(feature = "wgsl")]
pub(super) fn reflect(
    module: &naga::Module,
    reflection: &naga::back::glsl::ReflectionInfo,
    stage: naga::ShaderStage,
) -> Result<Entries, String> {
    let visibility = match stage {
        naga::ShaderStage::Vertex => wgpu::ShaderStages::VERTEX,
        naga::ShaderStage::Fragment => wgpu::ShaderStages::FRAGMENT,
        _ => return Err("WebGL2 supports vertex and fragment stages".into()),
    };
    let mut handles: Vec<_> = reflection.uniforms.keys().copied().collect();
    for texture in reflection.texture_mapping.values() {
        handles.push(texture.texture);
        handles.extend(texture.sampler);
    }
    handles.sort_unstable();
    handles.dedup();
    handles
        .into_iter()
        .map(|handle| {
            let variable = &module.global_variables[handle];
            let slot = variable.binding.as_ref().ok_or("shader resource has no binding")?;
            let inner = &module.types[variable.ty].inner;
            let ty = if variable.space == naga::AddressSpace::Uniform {
                wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(u64::from(inner.size(module.to_ctx()))),
                }
            } else {
                match *inner {
                    naga::TypeInner::Sampler { comparison } => wgpu::BindingType::Sampler(if comparison {
                        wgpu::SamplerBindingType::Comparison
                    } else {
                        wgpu::SamplerBindingType::Filtering
                    }),
                    naga::TypeInner::Image { dim, arrayed, class } => {
                        let view_dimension = match (dim, arrayed) {
                            (naga::ImageDimension::D2, false) => wgpu::TextureViewDimension::D2,
                            (naga::ImageDimension::D2, true) => wgpu::TextureViewDimension::D2Array,
                            (naga::ImageDimension::D3, false) => wgpu::TextureViewDimension::D3,
                            (naga::ImageDimension::Cube, false) => wgpu::TextureViewDimension::Cube,
                            _ => return Err("texture dimension is unavailable in WebGL2".into()),
                        };
                        let (sample_type, multisampled) = match class {
                            naga::ImageClass::Sampled { kind, multi } => (
                                match kind {
                                    naga::ScalarKind::Float => wgpu::TextureSampleType::Float { filterable: true },
                                    naga::ScalarKind::Sint => wgpu::TextureSampleType::Sint,
                                    naga::ScalarKind::Uint => wgpu::TextureSampleType::Uint,
                                    _ => return Err("unsupported texture scalar type".into()),
                                },
                                multi,
                            ),
                            naga::ImageClass::Depth { multi } => (wgpu::TextureSampleType::Depth, multi),
                            _ => return Err("WebGL2 has no storage textures".into()),
                        };
                        wgpu::BindingType::Texture { sample_type, view_dimension, multisampled }
                    }
                    _ => return Err("unsupported shader resource".into()),
                }
            };
            Ok((slot.group, wgpu::BindGroupLayoutEntry { binding: slot.binding, visibility, ty, count: None }))
        })
        .collect()
}

pub(super) fn merge(stages: impl Iterator<Item = Entries>) -> Result<Vec<Layout>, String> {
    let mut groups: Vec<BTreeMap<u32, wgpu::BindGroupLayoutEntry>> = Vec::new();
    for (group, entry) in stages.flatten() {
        if group >= 4 {
            return Err("WebGL2 supports at most four bind groups".into());
        }
        groups.resize_with(groups.len().max(group as usize + 1), BTreeMap::new);
        if let Some(previous) = groups[group as usize].get_mut(&entry.binding) {
            match (&mut previous.ty, entry.ty) {
                (
                    wgpu::BindingType::Buffer { ty, has_dynamic_offset, min_binding_size },
                    wgpu::BindingType::Buffer { ty: other, has_dynamic_offset: dynamic, min_binding_size: size },
                ) if *ty == other && *has_dynamic_offset == dynamic => {
                    *min_binding_size = (*min_binding_size).max(size);
                }
                (a, b) if *a == b => {}
                _ => return Err("shader stages disagree about a resource binding".into()),
            }
            previous.visibility |= entry.visibility;
        } else {
            groups[group as usize].insert(entry.binding, entry);
        }
    }
    Ok(groups.into_iter().map(|g| Layout(g.into_values().collect())).collect())
}
