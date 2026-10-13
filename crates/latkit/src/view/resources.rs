//! A view's buffers and bind groups. Buffers grow by half again; replacing one bumps the generation,
//! and bind groups are rebuilt when a generation they were built from changes.

use std::num::NonZeroU64;

use super::marks::Shown;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::{Inner, Shared};

/// Bytes between marks' uniforms: the dynamic offset alignment every device supports.
pub(crate) const MARK_STRIDE: u64 = 256;
/// Samples per pixel.
pub(crate) const SAMPLES: u32 = 4;

/// A storage buffer that grows by half again when it runs out of room.
struct Grown {
    buffer: wgpu::Buffer,
    label: &'static str,
    usage: wgpu::BufferUsages,
}

impl Grown {
    fn new(device: &wgpu::Device, label: &'static str, usage: wgpu::BufferUsages) -> Grown {
        Grown { buffer: create(device, label, usage, 256), label, usage }
    }

    /// Makes room for `bytes`; true when the buffer was replaced and its contents lost.
    fn ensure(&mut self, device: &wgpu::Device, bytes: u64) -> bool {
        if bytes <= self.buffer.size() {
            return false;
        }
        self.buffer = create(device, self.label, self.usage, (bytes + bytes / 2).next_multiple_of(256));
        true
    }
}

fn create(device: &wgpu::Device, label: &str, usage: wgpu::BufferUsages, bytes: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: bytes.max(256),
        usage: usage | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// The bind groups a frame binds.
#[derive(Clone)]
pub(crate) struct Groups {
    pub(crate) view: wgpu::BindGroup,
    pub(crate) mark: wgpu::BindGroup,
    pub(crate) draw: wgpu::BindGroup,
    pub(crate) evaluate: wgpu::BindGroup,
    pub(crate) bounds: wgpu::BindGroup,
}

pub(crate) struct Resources {
    pub(crate) frame: wgpu::Buffer,
    marks: Grown,
    program: Grown,
    focus: Grown,
    state: Grown,
    domains: Grown,
    extents: Grown,
    /// Changes whenever one of the buffers above is replaced.
    generation: u64,
    /// Built from (arena, colormaps, own) generations.
    groups: Option<((u64, u64, u64), Groups)>,
    samples: Option<(wgpu::TextureView, [u32; 2], wgpu::TextureFormat)>,
}

impl Resources {
    pub(crate) fn new(device: &wgpu::Device) -> Resources {
        let storage = wgpu::BufferUsages::STORAGE;
        Resources {
            frame: create(device, "latkit frame", wgpu::BufferUsages::UNIFORM, size_of::<wgsl::Frame>() as u64),
            marks: Grown::new(device, "latkit marks", wgpu::BufferUsages::UNIFORM),
            program: Grown::new(device, "latkit program", storage),
            focus: Grown::new(device, "latkit focus", storage),
            state: Grown::new(device, "latkit state", storage),
            domains: Grown::new(device, "latkit domains", storage),
            extents: Grown::new(device, "latkit extents", storage | wgpu::BufferUsages::COPY_SRC),
            generation: 0,
            groups: None,
            samples: None,
        }
    }

    /// Makes room for every mark's rows, uniforms, focus words, domains, and extents. True when the
    /// state buffer was replaced, so every row must evaluate again.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, marks: &[Shown]) -> bool {
        let words = |n: u64| (n + 1) * 4;
        let state: u64 = marks.iter().map(|m| u64::from(m.rows) * u64::from(m.stride())).sum();
        let focus: u64 = marks.iter().map(|m| u64::from(m.rows)).sum();
        let domains: u64 = marks.iter().map(|m| 2 * u64::from(m.reductions())).sum();
        let count = marks.len() as u64 + 1;
        let mut replaced = self.focus.ensure(device, words(focus));
        replaced |= self.domains.ensure(device, words(domains));
        replaced |= self.extents.ensure(device, words(4 * count));
        replaced |= self.marks.ensure(device, MARK_STRIDE * count);
        let state = self.state.ensure(device, words(state));
        if replaced || state {
            self.generation += 1;
        }
        state
    }

    /// Makes room for `words` of program; true when the buffer was replaced and must be rewritten.
    pub(crate) fn fit_program(&mut self, device: &wgpu::Device, words: u64) -> bool {
        let replaced = self.program.ensure(device, (words + 1) * 4);
        if replaced {
            self.generation += 1;
        }
        replaced
    }

    pub(crate) fn program(&self) -> &wgpu::Buffer {
        &self.program.buffer
    }

    pub(crate) fn program_words(&self) -> u64 {
        self.program.buffer.size() / 4
    }

    pub(crate) fn marks(&self) -> &wgpu::Buffer {
        &self.marks.buffer
    }

    pub(crate) fn domains(&self) -> &wgpu::Buffer {
        &self.domains.buffer
    }

    pub(crate) fn extents(&self) -> &wgpu::Buffer {
        &self.extents.buffer
    }

    /// The bind groups, rebuilt when a buffer or texture they bind was replaced.
    pub(crate) fn groups(&mut self, gpu: &Shared, inner: &mut Inner) -> Groups {
        let key = (inner.arena.generation, inner.colormaps.generation, self.generation);
        if let Some((built, groups)) = &self.groups
            && *built == key
        {
            return groups.clone();
        }
        let device = &gpu.device;
        let entry = |binding: u32, resource| wgpu::BindGroupEntry { binding, resource };
        let group = |label, layout: &wgpu::BindGroupLayout, entries: &[wgpu::BindGroupEntry<'_>]| {
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries })
        };
        let view = group(
            "latkit view",
            &inner.pipelines.view_layout,
            &[
                entry(0, self.frame.as_entire_binding()),
                entry(1, inner.arena.buffer().as_entire_binding()),
                entry(2, self.program.buffer.as_entire_binding()),
                entry(3, self.focus.buffer.as_entire_binding()),
                entry(4, wgpu::BindingResource::TextureView(&inner.colormaps.view)),
                entry(5, wgpu::BindingResource::Sampler(&gpu.sampler)),
            ],
        );
        let binding = wgpu::BufferBinding {
            buffer: &self.marks.buffer,
            offset: 0,
            size: NonZeroU64::new(size_of::<wgsl::Mark>() as u64),
        };
        let mark =
            group("latkit marks", &inner.pipelines.mark_layout, &[entry(0, wgpu::BindingResource::Buffer(binding))]);
        let state = || self.state.buffer.as_entire_binding();
        let draw_layout = inner.pipelines.pass_layout(device, Shader::Vertices);
        let draw = group("latkit draw", &draw_layout, &[entry(0, state()), entry(1, state())]);
        let evaluate_layout = inner.pipelines.pass_layout(device, Shader::Evaluate);
        let evaluate = group(
            "latkit evaluate",
            &evaluate_layout,
            &[entry(0, state()), entry(1, self.domains.buffer.as_entire_binding())],
        );
        let bounds_layout = inner.pipelines.pass_layout(device, Shader::Bounds);
        let bounds = group(
            "latkit bounds",
            &bounds_layout,
            &[entry(0, state()), entry(2, self.extents.buffer.as_entire_binding())],
        );
        let groups = Groups { view, mark, draw, evaluate, bounds };
        self.groups = Some((key, groups.clone()));
        groups
    }

    /// The multisampled texture a frame of `size` and `format` draws into before resolving.
    pub(crate) fn samples(
        &mut self,
        device: &wgpu::Device,
        size: [u32; 2],
        format: wgpu::TextureFormat,
    ) -> &wgpu::TextureView {
        let fresh = self.samples.as_ref().is_none_or(|(_, s, f)| *s != size || *f != format);
        if fresh {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("latkit samples"),
                size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: SAMPLES,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            self.samples = Some((texture.create_view(&wgpu::TextureViewDescriptor::default()), size, format));
        }
        &self.samples.as_ref().expect("created").0
    }
}
