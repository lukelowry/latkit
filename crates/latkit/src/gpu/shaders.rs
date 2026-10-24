//! The GPU contract generated from the WESL shaders by `build/shaders.rs`: constants, `#[repr(C)]`
//! mirrors of shared structs, bind group layouts, and each shader's text.

#![allow(clippy::unreadable_literal)]

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

impl ShaderSource {
    /// The shader's WGSL: its declarations, each stored once for every shader, joined in order.
    pub(crate) fn wgsl(&self) -> String {
        let mut out = String::new();
        for (i, &piece) in self.pieces.iter().enumerate() {
            if i > 0 {
                out.push_str("\n\n");
            }
            let (start, end) = PIECES[piece as usize];
            out.push_str(&WGSL[start as usize..end as usize]);
        }
        out
    }

    /// Bytes of its WGSL: what a browser compiles for each of its pipelines, and so about how long
    /// one takes.
    pub(crate) fn size(&self) -> usize {
        self.pieces
            .iter()
            .map(|&piece| {
                let (start, end) = PIECES[piece as usize];
                (end - start) as usize
            })
            .sum()
    }
}

/// Every distinct top-level declaration of every linked shader, each once; [`PIECES`] says where each
/// lies.
static WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/shaders.wgsl"));

/// One linked shader: its declarations, entry points, and the bindings of its pass group.
pub(crate) struct ShaderSource {
    pub(crate) label: &'static str,
    /// Its declarations, as indices into [`PIECES`], in order.
    pieces: &'static [u16],
    pub(crate) pass: &'static [Binding],
    /// The pipeline constants it declares.
    pub(crate) overrides: &'static [&'static str],
    /// Whether it reads the view and mark groups; one that does not binds its pass group alone.
    pub(crate) shared: bool,
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

// One page of rows: the data's, a table's order's, and a mark's, which it evaluates at a time.
const _: () =
    assert!(1 << PAGE_BITS == PAGE_ROWS && PAGE_MASK + 1 == PAGE_ROWS && PAGE_ROWS as usize == crate::data::PAGE_ROWS);
