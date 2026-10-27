//! A view's buffers, textures, and bind groups. A buffer that runs out of room grows
//! ([`Grown`]). Replacing a buffer increments the generation, and bind groups are rebuilt when a
//! generation they were built from changes.
//!
//! Every shader's pass group (group 2) uses the same bindings: 0 the arena pages (the data, and the
//! marks' per-row words), 2 extents, 4 domains, 5 probe words and query results, 6 depth,
//! 7 sprites, 8 the text atlas, 9 lists, 12 remap words, 13 labels, 15 icons, 16 the row blocks
//! each mark evaluates, 17 the probe step.

use std::collections::HashMap;
use std::num::NonZeroU64;

use crate::gpu::grown::{self, Grown};
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::work::Queue;
use crate::gpu::{Inner, Shared};

/// Bytes between marks' uniforms: the dynamic offset alignment every device supports.
pub(crate) const MARK_STRIDE: u64 = 256;
const _: () = assert!(size_of::<wgsl::Mark>() as u64 <= MARK_STRIDE, "a mark's uniform fits its stride");
/// The depth format; depth is reversed, nearer is greater.
pub(crate) const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// The dynamic offset of the probe's step `step`, one of the `STEP_` codes.
pub(crate) fn step(step: u32) -> u32 {
    (u64::from(step) * MARK_STRIDE) as u32
}

/// A uniform buffer holding each probe step's code at its own dynamic offset. A dispatch binds the
/// offset of its step.
fn steps(device: &wgpu::Device) -> wgpu::Buffer {
    use wgpu::util::DeviceExt as _;
    let mut contents = vec![0_u8; step(wgsl::STEPS) as usize];
    for code in 0..wgsl::STEPS {
        let at = step(code) as usize;
        contents[at..at + 4].copy_from_slice(&code.to_le_bytes());
    }
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("latkit steps"),
        contents: &contents,
        usage: wgpu::BufferUsages::UNIFORM,
    })
}

/// The labels buffer's usages: storage for the texts pass's atomics, and copy source for reading
/// back the texts it asks for.
const LABELS: wgpu::BufferUsages = wgpu::BufferUsages::STORAGE.union(wgpu::BufferUsages::COPY_SRC);

/// The bind groups every pipeline shares.
#[derive(Clone)]
pub(crate) struct Groups {
    pub(crate) view: wgpu::BindGroup,
    pub(crate) mark: wgpu::BindGroup,
}

/// The textures a frame draws into: multisampled color (resolved into the target) when it
/// multisamples, and depth.
struct Targets {
    color: Option<wgpu::TextureView>,
    depth: wgpu::TextureView,
    size: [u32; 2],
    format: wgpu::TextureFormat,
    samples: u32,
}

pub(crate) struct Resources {
    pub(crate) frame: wgpu::Buffer,
    eye: wgpu::Buffer,
    marks: Grown,
    program: Grown,
    /// The rows each mark's focus draw lights.
    lit: Grown,
    /// The row blocks each mark evaluates, and whose endpoints it resolves, this frame.
    blocks: Grown,
    remap: Grown,
    domains: Grown,
    extents: Grown,
    /// The probe's words, then the running query's results.
    probe: Grown,
    steps: wgpu::Buffer,
    sprites: Grown,
    lists: Grown,
    labels: wgpu::Buffer,
    /// Incremented whenever a buffer or texture above is replaced. `lists_generation` is also
    /// incremented when the lists buffer is replaced, which empties it.
    generation: u64,
    lists_generation: u64,
    /// The shared bind groups, with the (arena, colormaps, icons, own) generations they were built
    /// from.
    groups: Option<((u64, u64, u64, u64), Groups)>,
    /// Pass groups by shader, built at `passes_generation`: the arena, icons, and own generations.
    passes: HashMap<Shader, wgpu::BindGroup>,
    passes_generation: (u64, u64, u64),
    targets: Option<Targets>,
}

impl Resources {
    pub(crate) fn new(device: &wgpu::Device) -> Resources {
        let storage = wgpu::BufferUsages::STORAGE;
        let uniform = wgpu::BufferUsages::UNIFORM;
        Resources {
            frame: grown::buffer(device, "latkit frame", uniform, size_of::<wgsl::Frame>() as u64),
            eye: grown::buffer(device, "latkit eye", uniform, size_of::<wgsl::Eye>() as u64),
            marks: Grown::new(device, "latkit marks", uniform),
            // A copy source, so growing keeps its contents.
            program: Grown::new(device, "latkit program", storage | wgpu::BufferUsages::COPY_SRC),
            lit: Grown::new(device, "latkit lit", storage),
            blocks: Grown::new(device, "latkit blocks", storage),
            remap: Grown::new(device, "latkit remap", storage),
            domains: Grown::new(device, "latkit domains", storage),
            extents: Grown::new(device, "latkit extents", storage | wgpu::BufferUsages::COPY_SRC),
            probe: Grown::new(device, "latkit probe", storage | wgpu::BufferUsages::COPY_SRC),
            steps: steps(device),
            sprites: Grown::new(device, "latkit sprites", storage),
            lists: Grown::new(
                device,
                "latkit lists",
                storage | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_SRC,
            ),
            labels: grown::buffer(device, "latkit labels", LABELS, 256),
            generation: 0,
            lists_generation: 0,
            groups: None,
            passes: HashMap::new(),
            passes_generation: (u64::MAX, 0, 0),
            targets: None,
        }
    }

    /// Writes this frame's row-block lists for every mark.
    pub(crate) fn write_blocks(&mut self, device: &wgpu::Device, queue: &Queue, blocks: &[u32]) {
        if self.blocks.ensure(device, (blocks.len() as u64 + 1) * 4) {
            self.generation += 1;
        }
        if !blocks.is_empty() {
            queue.write_buffer(&self.blocks.buffer, 0, bytemuck::cast_slice(blocks));
        }
    }

    /// Writes the rows every mark's focus draw lights.
    pub(crate) fn write_lit(&mut self, device: &wgpu::Device, queue: &Queue, rows: &[u32]) {
        if self.lit.ensure(device, (rows.len() as u64 + 1) * 4) {
            self.generation += 1;
        }
        if !rows.is_empty() {
            queue.write_buffer(&self.lit.buffer, 0, bytemuck::cast_slice(rows));
        }
    }

    pub(crate) fn write_remap(&mut self, device: &wgpu::Device, queue: &Queue, words: &[u32]) {
        if self.remap.ensure(device, (words.len() as u64 + 1) * 4) {
            self.generation += 1;
        }
        queue.write_buffer(&self.remap.buffer, 0, bytemuck::cast_slice(words));
    }

    /// Makes room for every mark's uniforms, domains, and extents.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, marks: u64, domains: u64) {
        let words = |n: u64| (n + 1) * 4;
        let count = marks + 1;
        let mut replaced = self.domains.ensure(device, words(domains));
        replaced |= self.extents.ensure(device, words(u64::from(wgsl::EXTENT_WORDS) * count));
        replaced |= self.marks.ensure(device, MARK_STRIDE * count);
        if replaced {
            self.generation += 1;
        }
    }

    /// Makes room for `words` of program; true when the buffer was replaced and must be rewritten.
    pub(crate) fn fit_program(&mut self, device: &wgpu::Device, words: u64) -> bool {
        let replaced = self.program.ensure(device, (words + 1) * 4);
        if replaced {
            self.generation += 1;
        }
        replaced
    }

    /// Makes room for `words` of program, keeping its first `kept` words. A replaced buffer has
    /// them copied over in `encoder`, so this frame's writes must follow the copy. Returns whether
    /// it was replaced.
    pub(crate) fn grow_program(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        words: u64,
        kept: u64,
    ) -> bool {
        let old = self.program.buffer.clone();
        if !self.program.ensure(device, (words + 1) * 4) {
            return false;
        }
        if kept > 0 {
            encoder.copy_buffer_to_buffer(&old, 0, &self.program.buffer, 0, kept * 4);
        }
        self.generation += 1;
        true
    }

    /// Copies `words` program words from word `from` to word `to` in `encoder`, through a temporary
    /// buffer, since a buffer cannot be copied into itself.
    pub(crate) fn move_program(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        from: u32,
        to: u32,
        words: u32,
    ) {
        let size = u64::from(words) * 4;
        let between = grown::buffer(device, "latkit program move", wgpu::BufferUsages::COPY_SRC, size);
        let program = &self.program.buffer;
        encoder.copy_buffer_to_buffer(program, u64::from(from) * 4, &between, 0, size);
        encoder.copy_buffer_to_buffer(&between, 0, program, u64::from(to) * 4, size);
    }

    /// Makes room for `words` probe words, including the running query's results.
    pub(crate) fn fit_probe(&mut self, device: &wgpu::Device, words: u32) {
        if self.probe.ensure(device, u64::from(words.max(wgsl::PROBE_WORDS)) * 4) {
            self.generation += 1;
        }
    }

    /// Makes room for `count` sprites.
    pub(crate) fn fit_sprites(&mut self, device: &wgpu::Device, count: usize) {
        if self.sprites.ensure(device, (count as u64 + 1) * size_of::<wgsl::Sprite>() as u64) {
            self.generation += 1;
        }
    }

    /// Makes room for `words` in the lists buffer. Replacing it empties it and changes the lists
    /// generation, so every list is counted again.
    pub(crate) fn fit_lists(&mut self, device: &wgpu::Device, words: u64) {
        if self.lists.ensure(device, (words + 1) * 4) {
            self.generation += 1;
            self.lists_generation += 1;
        }
    }

    /// Replaces the labels buffer with `words` of zeros.
    pub(crate) fn replace_labels(&mut self, device: &wgpu::Device, words: u64) {
        self.labels = grown::buffer(device, "latkit labels", LABELS, (words + 1) * 4);
        self.generation += 1;
    }

    pub(crate) fn labels(&self) -> &wgpu::Buffer {
        &self.labels
    }

    pub(crate) fn eye(&self) -> &wgpu::Buffer {
        &self.eye
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

    pub(crate) fn probe(&self) -> &wgpu::Buffer {
        &self.probe.buffer
    }

    pub(crate) fn sprites(&self) -> &wgpu::Buffer {
        &self.sprites.buffer
    }

    /// Changes whenever the lists buffer is replaced (which empties it), so every list is counted
    /// again.
    pub(crate) fn lists_generation(&self) -> u64 {
        self.lists_generation
    }

    pub(crate) fn lists(&self) -> &wgpu::Buffer {
        &self.lists.buffer
    }

    /// The view and mark bind groups, rebuilt when a buffer or texture they bind was replaced.
    pub(crate) fn groups(&mut self, gpu: &Shared, inner: &mut Inner) -> Groups {
        let key = (inner.arena.generation, inner.colormaps.generation, inner.icons.generation, self.generation);
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
                entry(1, self.program.buffer.as_entire_binding()),
                entry(2, wgpu::BindingResource::TextureView(&inner.colormaps.view)),
                entry(3, wgpu::BindingResource::Sampler(&gpu.sampler)),
                entry(4, self.eye.as_entire_binding()),
                entry(5, self.lit.buffer.as_entire_binding()),
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

    /// `shader`'s pass group, cached until a generation it binds changes.
    pub(crate) fn pass(&mut self, device: &wgpu::Device, inner: &mut Inner, shader: Shader) -> wgpu::BindGroup {
        let generation = (inner.arena.generation, inner.icons.generation, self.generation);
        if self.passes_generation != generation {
            self.passes.clear();
            self.passes_generation = generation;
        }
        if let Some(group) = self.passes.get(&shader) {
            return group.clone();
        }
        let group = self.bind(device, inner, shader);
        self.passes.insert(shader, group.clone());
        group
    }

    /// Builds `shader`'s pass group from the bindings its WGSL declares.
    fn bind(&self, device: &wgpu::Device, inner: &mut Inner, shader: Shader) -> wgpu::BindGroup {
        let layout = inner.pipelines.pass_layout(device, shader);
        let entries: Vec<wgpu::BindGroupEntry<'_>> = shader
            .source()
            .pass
            .iter()
            .map(|binding| {
                let resource = match binding.slot {
                    0 => inner.arena.buffer().as_entire_binding(),
                    2 => self.extents.buffer.as_entire_binding(),
                    4 => self.domains.buffer.as_entire_binding(),
                    5 => self.probe.buffer.as_entire_binding(),
                    6 => wgpu::BindingResource::TextureView(
                        &self.targets.as_ref().expect("a frame drew before probing").depth,
                    ),
                    7 => self.sprites.buffer.as_entire_binding(),
                    8 => wgpu::BindingResource::TextureView(&inner.atlas.view),
                    9 => self.lists.buffer.as_entire_binding(),
                    12 => self.remap.buffer.as_entire_binding(),
                    13 => self.labels.as_entire_binding(),
                    15 => wgpu::BindingResource::TextureView(&inner.icons.view),
                    16 => self.blocks.buffer.as_entire_binding(),
                    17 => wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.steps,
                        offset: 0,
                        size: NonZeroU64::new(4),
                    }),
                    other => unreachable!("no resource for pass binding {other}"),
                };
                wgpu::BindGroupEntry { binding: binding.slot, resource }
            })
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(shader.source().label),
            layout: &layout,
            entries: &entries,
        })
    }

    /// The color and depth textures for a frame of `size` and `format` at `samples` per pixel.
    /// Color is `None` without multisampling, when marks draw straight into the target.
    pub(crate) fn targets(
        &mut self,
        device: &wgpu::Device,
        size: [u32; 2],
        format: wgpu::TextureFormat,
        samples: u32,
    ) -> (Option<wgpu::TextureView>, wgpu::TextureView) {
        if self.targets.as_ref().is_none_or(|t| t.size != size || t.format != format || t.samples != samples) {
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
                        sample_count: samples,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage,
                        view_formats: &[],
                    })
                    .create_view(&wgpu::TextureViewDescriptor::default())
            };
            let color =
                (samples > 1).then(|| texture("latkit samples", format, wgpu::TextureUsages::RENDER_ATTACHMENT));
            let depth = texture(
                "latkit depth",
                DEPTH,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            );
            self.targets = Some(Targets { color, depth, size, format, samples });
            self.generation += 1;
        }
        let targets = self.targets.as_ref().expect("created");
        (targets.color.clone(), targets.depth.clone())
    }

    /// Samples per pixel of the frame's targets.
    pub(crate) fn samples(&self) -> u32 {
        self.targets.as_ref().map_or(1, |t| t.samples)
    }
}
