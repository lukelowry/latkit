//! The GPU contract generated from the WESL shaders by `build/shaders.rs`: constants, `#[repr(C)]`
//! mirrors of shared structs, bind group layouts, and each shader's text.

#![allow(clippy::unreadable_literal, clippy::pub_underscore_fields)]

/// How a binding is read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Uniform,
    Storage { read_only: bool },
    Texture { array: bool, filterable: bool },
    Depth { multisampled: bool },
    Sampler,
}

/// One binding of a bind group layout.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Binding {
    pub(crate) slot: u32,
    pub(crate) kind: Kind,
    pub(crate) stages: u32,
    pub(crate) dynamic: bool,
}

const VERTEX: u32 = 1;
const FRAGMENT: u32 = 2;
const COMPUTE: u32 = 4;

/// One linked shader: its WGSL, entry points, and the bindings of its pass group.
pub(crate) struct ShaderSource {
    pub(crate) label: &'static str,
    pub(crate) wgsl: &'static str,
    pub(crate) pass: &'static [Binding],
    /// The pipeline constants it declares.
    pub(crate) overrides: &'static [&'static str],
}

impl Binding {
    pub(crate) fn layout_entry(&self) -> wgpu::BindGroupLayoutEntry {
        let mut visibility = wgpu::ShaderStages::NONE;
        for (bit, stage) in [
            (VERTEX, wgpu::ShaderStages::VERTEX),
            (FRAGMENT, wgpu::ShaderStages::FRAGMENT),
            (COMPUTE, wgpu::ShaderStages::COMPUTE),
        ] {
            if self.stages & bit != 0 {
                visibility |= stage;
            }
        }
        let ty = match self.kind {
            Kind::Uniform => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: self.dynamic,
                min_binding_size: None,
            },
            Kind::Storage { read_only } => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: self.dynamic,
                min_binding_size: None,
            },
            Kind::Texture { array, filterable } => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable },
                view_dimension: if array {
                    wgpu::TextureViewDimension::D2Array
                } else {
                    wgpu::TextureViewDimension::D2
                },
                multisampled: false,
            },
            Kind::Depth { multisampled } => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled,
            },
            Kind::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        };
        wgpu::BindGroupLayoutEntry { binding: self.slot, visibility, ty, count: None }
    }
}

include!(concat!(env!("OUT_DIR"), "/shaders.rs"));
