//! A view's buffers, targets, and bind groups. Buffers grow by half again; replacing one bumps the
//! generation, and bind groups are rebuilt when a generation they were built from changes.
//!
//! Every shader's pass group (group 2) binds by one convention: 0 state, 1 previous state, 2 extents,
//! 3 normals, 4 domains, 5 probe, 6 depth, 7 sprites, 8 the text atlas.

use std::collections::HashMap;
use std::num::NonZeroU64;

use super::marks::Shown;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::{Inner, Shared};
use crate::scene::mark::MarkKind;

/// Bytes between marks' uniforms: the dynamic offset alignment every device supports.
pub(crate) const MARK_STRIDE: u64 = 256;
/// Samples per pixel.
pub(crate) const SAMPLES: u32 = 4;
/// The depth format; depth is reversed, nearer is greater.
pub(crate) const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

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

/// The bind groups every pipeline shares.
#[derive(Clone)]
pub(crate) struct Groups {
    pub(crate) view: wgpu::BindGroup,
    pub(crate) mark: wgpu::BindGroup,
}

/// What a frame draws into: multisampled color resolved into the target, and depth.
struct Targets {
    color: wgpu::TextureView,
    depth: wgpu::TextureView,
    size: [u32; 2],
    format: wgpu::TextureFormat,
}

pub(crate) struct Resources {
    pub(crate) frame: wgpu::Buffer,
    marks: Grown,
    program: Grown,
    focus: Grown,
    state: Grown,
    domains: Grown,
    extents: Grown,
    normals: Grown,
    probe: wgpu::Buffer,
    sprites: Grown,
    /// Changes whenever one of the buffers or targets above is replaced.
    generation: u64,
    /// Built from (arena, colormaps, own) generations.
    groups: Option<((u64, u64, u64), Groups)>,
    /// Pass groups, built at `passes_generation`.
    passes: HashMap<Shader, wgpu::BindGroup>,
    passes_generation: u64,
    targets: Option<Targets>,
}

impl Resources {
    pub(crate) fn new(device: &wgpu::Device) -> Resources {
        let storage = wgpu::BufferUsages::STORAGE;
        let probe_bytes = u64::from(wgsl::PROBE_WORDS) * 4;
        Resources {
            frame: create(device, "latkit frame", wgpu::BufferUsages::UNIFORM, size_of::<wgsl::Frame>() as u64),
            marks: Grown::new(device, "latkit marks", wgpu::BufferUsages::UNIFORM),
            program: Grown::new(device, "latkit program", storage),
            focus: Grown::new(device, "latkit focus", storage),
            state: Grown::new(device, "latkit state", storage),
            domains: Grown::new(device, "latkit domains", storage),
            extents: Grown::new(device, "latkit extents", storage | wgpu::BufferUsages::COPY_SRC),
            normals: Grown::new(device, "latkit normals", storage),
            probe: create(device, "latkit probe", storage | wgpu::BufferUsages::COPY_SRC, probe_bytes),
            sprites: Grown::new(device, "latkit sprites", storage),
            generation: 0,
            groups: None,
            passes: HashMap::new(),
            passes_generation: u64::MAX,
            targets: None,
        }
    }

    /// Makes room for every mark's rows, uniforms, focus words, domains, extents, and normals. Returns
    /// whether the state buffer was replaced, so every row must evaluate again, and whether the focus
    /// buffer was, so focus must be written again.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, marks: &[Shown]) -> (bool, bool) {
        let words = |n: u64| (n + 1) * 4;
        let state: u64 = marks.iter().map(|m| u64::from(m.rows) * u64::from(m.stride())).sum();
        let focus: u64 = marks.iter().map(|m| u64::from(m.rows)).sum();
        let domains: u64 = marks.iter().map(|m| 2 * u64::from(m.reductions())).sum();
        let vertices: u64 = marks.iter().filter(|m| m.kind() == MarkKind::Vertices).map(|m| u64::from(m.rows)).sum();
        let count = marks.len() as u64 + 1;
        let focus = self.focus.ensure(device, words(focus));
        let mut replaced = focus;
        replaced |= self.domains.ensure(device, words(domains));
        replaced |= self.extents.ensure(device, words(u64::from(wgsl::EXTENT_WORDS) * count));
        replaced |= self.marks.ensure(device, MARK_STRIDE * count);
        replaced |= self.normals.ensure(device, words(3 * vertices));
        let state = self.state.ensure(device, words(state));
        if replaced || state {
            self.generation += 1;
        }
        (state, focus)
    }

    /// Makes room for `words` of program; true when the buffer was replaced and must be rewritten.
    pub(crate) fn fit_program(&mut self, device: &wgpu::Device, words: u64) -> bool {
        let replaced = self.program.ensure(device, (words + 1) * 4);
        if replaced {
            self.generation += 1;
        }
        replaced
    }

    /// Makes room for `count` sprites.
    pub(crate) fn fit_sprites(&mut self, device: &wgpu::Device, count: usize) {
        if self.sprites.ensure(device, (count as u64 + 1) * size_of::<wgsl::Sprite>() as u64) {
            self.generation += 1;
        }
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

    pub(crate) fn focus(&self) -> &wgpu::Buffer {
        &self.focus.buffer
    }

    pub(crate) fn focus_words(&self) -> u64 {
        self.focus.buffer.size() / 4
    }

    pub(crate) fn domains(&self) -> &wgpu::Buffer {
        &self.domains.buffer
    }

    pub(crate) fn extents(&self) -> &wgpu::Buffer {
        &self.extents.buffer
    }

    pub(crate) fn normals(&self) -> &wgpu::Buffer {
        &self.normals.buffer
    }

    pub(crate) fn probe(&self) -> &wgpu::Buffer {
        &self.probe
    }

    pub(crate) fn sprites(&self) -> &wgpu::Buffer {
        &self.sprites.buffer
    }

    /// The view and mark bind groups, rebuilt when a buffer or texture they bind was replaced.
    pub(crate) fn groups(&mut self, gpu: &Shared, inner: &mut Inner) -> Groups {
        let key = (inner.arena.generation, inner.colormaps.generation, self.generation);
        if let Some((built, groups)) = &self.groups
            && *built == key
        {
            return groups.clone();
        }
        let device = &gpu.device;
        let entry = |binding: u32, resource| wgpu::BindGroupEntry { binding, resource };
        let view = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("latkit view"),
            layout: &inner.pipelines.view_layout,
            entries: &[
                entry(0, self.frame.as_entire_binding()),
                entry(1, inner.arena.buffer().as_entire_binding()),
                entry(2, self.program.buffer.as_entire_binding()),
                entry(3, self.focus.buffer.as_entire_binding()),
                entry(4, wgpu::BindingResource::TextureView(&inner.colormaps.view)),
                entry(5, wgpu::BindingResource::Sampler(&gpu.sampler)),
            ],
        });
        let binding = wgpu::BufferBinding {
            buffer: &self.marks.buffer,
            offset: 0,
            size: NonZeroU64::new(size_of::<wgsl::Mark>() as u64),
        };
        let mark = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("latkit marks"),
            layout: &inner.pipelines.mark_layout,
            entries: &[entry(0, wgpu::BindingResource::Buffer(binding))],
        });
        let groups = Groups { view, mark };
        self.groups = Some((key, groups.clone()));
        groups
    }

    /// `shader`'s pass group, binding what its WGSL declares.
    pub(crate) fn pass(&mut self, device: &wgpu::Device, inner: &mut Inner, shader: Shader) -> wgpu::BindGroup {
        if self.passes_generation != self.generation {
            self.passes.clear();
            self.passes_generation = self.generation;
        }
        if let Some(group) = self.passes.get(&shader) {
            return group.clone();
        }
        let layout = inner.pipelines.pass_layout(device, shader);
        let entries: Vec<wgpu::BindGroupEntry<'_>> = shader
            .source()
            .pass
            .iter()
            .map(|binding| {
                let resource = match binding.slot {
                    0 | 1 => self.state.buffer.as_entire_binding(),
                    2 => self.extents.buffer.as_entire_binding(),
                    3 => self.normals.buffer.as_entire_binding(),
                    4 => self.domains.buffer.as_entire_binding(),
                    5 => self.probe.as_entire_binding(),
                    6 => wgpu::BindingResource::TextureView(
                        &self.targets.as_ref().expect("a frame drew before probing").depth,
                    ),
                    7 => self.sprites.buffer.as_entire_binding(),
                    8 => wgpu::BindingResource::TextureView(&inner.atlas.view),
                    other => unreachable!("no resource for pass binding {other}"),
                };
                wgpu::BindGroupEntry { binding: binding.slot, resource }
            })
            .collect();
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(shader.source().label),
            layout: &layout,
            entries: &entries,
        });
        self.passes.insert(shader, group.clone());
        group
    }

    /// The multisampled color and the depth textures a frame of `size` and `format` draws into.
    pub(crate) fn targets(
        &mut self,
        device: &wgpu::Device,
        size: [u32; 2],
        format: wgpu::TextureFormat,
    ) -> (&wgpu::TextureView, &wgpu::TextureView) {
        if self.targets.as_ref().is_none_or(|t| t.size != size || t.format != format) {
            let texture = |label, format, usage| {
                device
                    .create_texture(&wgpu::TextureDescriptor {
                        label: Some(label),
                        size: wgpu::Extent3d {
                            width: size[0].max(1),
                            height: size[1].max(1),
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: SAMPLES,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage,
                        view_formats: &[],
                    })
                    .create_view(&wgpu::TextureViewDescriptor::default())
            };
            let color = texture("latkit samples", format, wgpu::TextureUsages::RENDER_ATTACHMENT);
            let depth = texture(
                "latkit depth",
                DEPTH,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            );
            self.targets = Some(Targets { color, depth, size, format });
            self.generation += 1;
        }
        let targets = self.targets.as_ref().expect("created");
        (&targets.color, &targets.depth)
    }
}
