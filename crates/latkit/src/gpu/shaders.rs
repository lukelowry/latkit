//! Code that `build/shaders.rs` generates from the WESL shaders: constants, `#[repr(C)]` mirrors of
//! shared structs, bind group layouts, and each shader's text.

#![allow(clippy::unreadable_literal)]

use super::specialize::{Constant, specialize};

/// A binding's resource type.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Uniform,
    Texture { array: bool, filterable: bool },
    Words { array: bool },
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

impl ShaderSource {
    /// The shader's WGSL for one pipeline, with each of its
    /// [`constants`](ShaderSource::constants) declared as a `const` of `value(name)`. The browser
    /// build carries only the custom marker shaders' WGSL, in its store.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn wgsl(&self, value: impl Fn(&str) -> u32) -> String {
        let linked = super::store::text(&format!("wgsl {}", self.label))
            .unwrap_or_else(|| panic!("the browser build stores no WGSL for {}", self.label));
        specialize(linked.split(super::specialize::SEPARATOR), self.constants, value)
    }

    /// The shader's WGSL for one pipeline: its declarations joined in order, with each of its
    /// [`constants`](ShaderSource::constants) declared as a `const` of `value(name)`. Each
    /// declaration is stored once and shared by every shader.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn wgsl(&self, value: impl Fn(&str) -> u32) -> String {
        if !self.specializations.is_empty() {
            let selected = self
                .specializations
                .iter()
                .find(|s| self.constants.iter().zip(s.values).all(|(c, &v)| value(c.name) == v))
                .expect("every pipeline specialization is built and validated");
            return selected
                .pieces
                .iter()
                .map(|&piece| {
                    let (start, end) = PIECES[piece as usize];
                    &WGSL[start as usize..end as usize]
                })
                .collect::<Vec<_>>()
                .join(super::specialize::SEPARATOR);
        }
        let pieces = self.pieces.iter().map(|&piece| {
            let (start, end) = PIECES[piece as usize];
            &WGSL[start as usize..end as usize]
        });
        specialize(pieces, self.constants, value)
    }

    /// The values of its [`constants`](ShaderSource::constants) for one pipeline, in order: the
    /// key of the pipeline's entries in the browser's store of translated shaders.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn values(&self, value: impl Fn(&str) -> u32) -> Vec<u32> {
        self.constants.iter().map(|constant| value(constant.name)).collect()
    }

    /// Whether pipelines specialize the shader with the constant `name`.
    pub(crate) fn reads(&self, entry: &str, name: &str) -> bool {
        match self.entry_constants.iter().find(|(key, _)| *key == entry) {
            Some((_, constants)) => constants.contains(&name),
            // Application programs supply their function bodies after reflection.
            None => self.constants.iter().any(|constant| constant.name == name),
        }
    }

    /// The size of its linked WGSL in bytes, a rough measure of compile time.
    pub(crate) fn size(&self) -> usize {
        self.size
    }
}

/// Every distinct top-level declaration of every linked shader, each stored once. [`PIECES`] gives
/// each one's byte range. The browser build has none.
#[cfg(not(target_arch = "wasm32"))]
static WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/shaders.wgsl"));

/// One linked shader: its declarations, entry points included, and the bindings of its pass group.
#[cfg_attr(target_arch = "wasm32", allow(dead_code, reason = "the browser build's shaders are in its store"))]
pub(crate) struct ShaderSource {
    pub(crate) label: &'static str,
    /// Its declarations, as indices into [`PIECES`], in order.
    pieces: &'static [u16],
    pub(crate) pass: &'static [Binding],
    /// The constants pipelines specialize it with.
    constants: &'static [Constant<'static>],
    /// Constants reached by a pipeline's vertex and selected fragment entry together.
    entry_constants: &'static [(&'static str, &'static [&'static str])],
    /// Built-in modules with constant branches removed before browser compilation. Kernels and
    /// application markers retain their helper declarations until their source is supplied.
    specializations: &'static [Specialization],
    /// Whether it reads the view and mark groups. A shader that does not gets empty groups in their
    /// place.
    pub(crate) shared: bool,
    /// The bytes of its linked WGSL.
    size: usize,
}

#[cfg_attr(target_arch = "wasm32", allow(dead_code, reason = "the browser build's shaders are in its store"))]
pub(crate) struct Specialization {
    pub(crate) values: &'static [u32],
    pub(crate) pieces: &'static [u16],
}

impl Binding {
    pub(crate) fn layout_entry(&self) -> wgpu::BindGroupLayoutEntry {
        let mut visibility = wgpu::ShaderStages::NONE;
        for (bit, stage) in [(VERTEX, wgpu::ShaderStages::VERTEX), (FRAGMENT, wgpu::ShaderStages::FRAGMENT)] {
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
            Kind::Texture { array, filterable } => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable },
                view_dimension: if array {
                    wgpu::TextureViewDimension::D2Array
                } else {
                    wgpu::TextureViewDimension::D2
                },
                multisampled: false,
            },
            Kind::Words { array } => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Uint,
                view_dimension: if array {
                    wgpu::TextureViewDimension::D2Array
                } else {
                    wgpu::TextureViewDimension::D2
                },
                multisampled: false,
            },
            Kind::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        };
        wgpu::BindGroupLayoutEntry { binding: self.slot, visibility, ty, count: None }
    }
}

include!(concat!(env!("OUT_DIR"), "/shaders.rs"));

// Data, draw order, and mark evaluation all use the same number of rows per page.
const _: () =
    assert!(1 << PAGE_BITS == PAGE_ROWS && PAGE_MASK + 1 == PAGE_ROWS && PAGE_ROWS as usize == crate::data::PAGE_ROWS);
