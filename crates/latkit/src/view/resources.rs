//! A view's buffers, textures, and bind groups. A buffer that runs out of room grows
//! ([`Grown`]). Replacing a buffer increments the generation, and bind groups are rebuilt when a
//! generation they were built from changes. Every buffer and texture replaced, and all of them
//! when the view goes, are retired, so their memory is freed once the GPU is done with them.
//!
//! Every shader's pass group (group 2) uses the same bindings: 0 the arena pages (the data, and the
//! marks' per-row words), 2 extents, 4 domains, 5 probe words and query results, 6 depth,
//! 7 sprites, 8 the text atlas, 9 lists, 12 remap words, 13 labels, 15 icons, 16 the row blocks
//! each mark evaluates. Raster operations bind their own small immutable uniform.

use std::collections::HashMap;
use std::num::NonZeroU64;

use crate::gpu::grown::{self, Grown};
use crate::gpu::retired::Retired;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::words::Words;
use crate::gpu::work::Queue;
use crate::gpu::{Inner, Shared};

/// One uniform per mark, shared by every pass at the supported dynamic-offset alignment.
pub(crate) const MARK_STRIDE: u64 = 256;
const _: () = assert!(size_of::<wgsl::Mark>() as u64 <= MARK_STRIDE, "a mark's uniform fits its stride");
/// The depth format. Depth is reversed: nearer is greater.
pub(crate) const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// The bind groups every pipeline shares.
#[derive(Clone)]
pub(crate) struct Groups {
    pub(crate) view: wgpu::BindGroup,
    pub(crate) mark: wgpu::BindGroup,
}

/// The textures a frame draws into, with their views: multisampled color (resolved into the
/// target) when it multisamples, and depth.
struct Targets {
    color: Option<(wgpu::Texture, wgpu::TextureView)>,
    depth: (wgpu::Texture, wgpu::TextureView),
    size: [u32; 2],
    format: wgpu::TextureFormat,
    samples: u32,
}

impl Targets {
    fn retire(self, retired: &Retired) {
        if let Some((color, _)) = self.color {
            retired.retire(color);
        }
        retired.retire(self.depth.0);
    }
}

pub(crate) struct Resources {
    pub(crate) frame: wgpu::Buffer,
    eye: wgpu::Buffer,
    marks: Grown,
    program: Words,
    /// The rows each mark's focus draw lights.
    lit: Words,
    /// The row blocks each mark evaluates, and whose endpoints it resolves, this frame.
    blocks: Words,
    remap: Words,
    domains: Words,
    extents: Words,
    /// The probe's words, then the running query's results.
    probe: Words,
    sprites: Words,
    lists: Words,
    labels: Words,
    /// The labels' claim grid: a word per screen cell.
    cells: crate::gpu::texture::Texture,
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
    pick_targets: Option<Targets>,
    retired: Retired,
}

impl Resources {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Resources {
        let uniform = wgpu::BufferUsages::UNIFORM;
        let grown = |label, usage| Grown::new(device, retired, label, usage);
        Resources {
            frame: grown::buffer(device, "latkit frame", uniform, size_of::<wgsl::Frame>() as u64),
            eye: grown::buffer(device, "latkit eye", uniform, size_of::<wgsl::Eye>() as u64),
            marks: grown("latkit marks", uniform),
            program: Words::new(device, retired, "latkit program"),
            lit: Words::new(device, retired, "latkit lit"),
            blocks: Words::new(device, retired, "latkit blocks"),
            remap: Words::new(device, retired, "latkit remap"),
            domains: Words::new(device, retired, "latkit domains"),
            extents: Words::new(device, retired, "latkit extents"),
            probe: Words::allocated(device, retired, "latkit probe", u64::from(wgsl::PROBE_WORDS)),
            sprites: Words::new(device, retired, "latkit sprites"),
            lists: Words::new(device, retired, "latkit lists"),
            labels: Words::new(device, retired, "latkit labels"),
            cells: crate::gpu::texture::Texture::new(
                device,
                retired,
                "latkit label cells",
                wgpu::TextureFormat::Rgba32Uint,
            ),
            generation: 0,
            lists_generation: 0,
            groups: None,
            passes: HashMap::new(),
            passes_generation: (u64::MAX, 0, 0),
            targets: None,
            pick_targets: None,
            retired: retired.clone(),
        }
    }

    /// Writes this frame's row-block lists for every mark.
    pub(crate) fn write_blocks(&mut self, device: &wgpu::Device, queue: &Queue, blocks: &[u32]) {
        if self.blocks.ensure(device, (blocks.len() as u64).next_multiple_of(4)) {
            self.generation += 1;
        }
        if !blocks.is_empty() {
            self.blocks.write_padded(queue, 0, blocks);
        }
    }

    /// Writes the rows every mark's focus draw lights.
    pub(crate) fn write_lit(&mut self, device: &wgpu::Device, queue: &Queue, rows: &[u32]) {
        if self.lit.ensure(device, (rows.len() as u64).next_multiple_of(4)) {
            self.generation += 1;
        }
        if !rows.is_empty() {
            self.lit.write_padded(queue, 0, rows);
        }
    }

    pub(crate) fn write_remap(&mut self, device: &wgpu::Device, queue: &Queue, words: &[u32]) {
        if self.remap.ensure(device, (words.len() as u64).next_multiple_of(4)) {
            self.generation += 1;
        }
        self.remap.write_padded(queue, 0, words);
    }

    /// Makes room for every mark's uniforms, domains, and extents.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, marks: u64, domains: u64) {
        let count = marks + 1;
        let mut replaced = self.domains.ensure(device, (domains * 2).max(4));
        replaced |= self.extents.ensure(device, u64::from(wgsl::EXTENT_WORDS) * count);
        replaced |= self.marks.ensure(device, MARK_STRIDE * count);
        if replaced {
            self.generation += 1;
        }
    }

    /// Makes room for `words` of program. Returns true when the texture was replaced and must be
    /// rewritten.
    pub(crate) fn fit_program(&mut self, device: &wgpu::Device, words: u64) -> bool {
        let replaced = self.program.ensure(device, words + 1);
        if replaced {
            self.generation += 1;
        }
        replaced
    }

    /// Makes room for `words` of program, keeping its contents. A replaced texture has its words
    /// copied over in `encoder`, so this frame's writes must follow the copy. Returns whether
    /// it was replaced.
    pub(crate) fn grow_program(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        words: u64,
    ) -> bool {
        if !self.program.grow(device, encoder, words + 1) {
            return false;
        }
        self.generation += 1;
        true
    }

    /// Copies `words` program words from word `from` to word `to` in `encoder`, through retained scratch
    /// texture, so a texture is never copied into itself.
    pub(crate) fn move_program(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        from: u32,
        to: u32,
        words: u32,
    ) {
        self.program.move_words(device, encoder, from, to, words);
    }

    /// Makes room for `words` probe words, including the running query's results.
    pub(crate) fn fit_probe(&mut self, device: &wgpu::Device, words: u32) {
        if self.probe.ensure(device, u64::from(words.max(wgsl::PROBE_WORDS))) {
            self.generation += 1;
        }
    }

    /// Makes room for `count` sprites.
    pub(crate) fn fit_sprites(&mut self, device: &wgpu::Device, count: usize) {
        if self.sprites.ensure(device, (count as u64 + 1) * size_of::<wgsl::Sprite>() as u64 / 4) {
            self.generation += 1;
        }
    }

    /// Makes room for `words` in the lists buffer. Replacing it empties it and changes the lists
    /// generation, so every list is counted again.
    pub(crate) fn fit_lists(&mut self, device: &wgpu::Device, words: u64) {
        if self.lists.ensure(device, words + 4) {
            self.generation += 1;
            self.lists_generation += 1;
        }
    }

    /// Replaces the labels buffer with `words` of zeros.
    pub(crate) fn replace_labels(&mut self, device: &wgpu::Device, words: u64) {
        self.labels = Words::allocated(device, &self.retired, "latkit labels", words.max(4));
        self.generation += 1;
    }

    pub(crate) fn labels(&self) -> &Words {
        &self.labels
    }

    /// Makes room for `words` in the labels' claim grid, and returns it.
    pub(crate) fn label_cells(&mut self, device: &wgpu::Device, size: [u32; 2]) {
        if self.cells.ensure(device, size) {
            self.generation += 1;
        }
    }

    pub(crate) fn cells(&self) -> &crate::gpu::texture::Texture {
        &self.cells
    }

    pub(crate) fn eye(&self) -> &wgpu::Buffer {
        &self.eye
    }

    pub(crate) fn program(&self) -> &Words {
        &self.program
    }

    pub(crate) fn program_words(&self) -> u64 {
        self.program.capacity()
    }

    pub(crate) fn marks(&self) -> &wgpu::Buffer {
        &self.marks.buffer
    }

    pub(crate) fn domains(&self) -> &Words {
        &self.domains
    }

    pub(crate) fn state_inputs<'a>(
        &'a self,
        pages: &'a Words,
        groups: &'a Groups,
        offset: u32,
        reads: crate::gpu::pipelines::Reads,
    ) -> crate::gpu::state::Inputs<'a> {
        crate::gpu::state::Inputs {
            pages,
            domains: &self.domains,
            remap: &self.remap,
            blocks: &self.blocks,
            view: &groups.view,
            mark: &groups.mark,
            offset,
            reads,
        }
    }

    pub(crate) fn extents(&self) -> &Words {
        &self.extents
    }

    pub(crate) fn probe(&self) -> &Words {
        &self.probe
    }

    pub(crate) fn sprites(&self) -> &Words {
        &self.sprites
    }

    /// Changes whenever the lists buffer is replaced (which empties it), so every list is counted
    /// again.
    pub(crate) fn lists_generation(&self) -> u64 {
        self.lists_generation
    }

    pub(crate) fn lists(&self) -> &Words {
        &self.lists
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
                entry(1, self.program.binding()),
                entry(2, wgpu::BindingResource::TextureView(&inner.colormaps.view)),
                entry(3, wgpu::BindingResource::Sampler(&gpu.sampler)),
                entry(4, self.eye.as_entire_binding()),
                entry(5, self.lit.binding()),
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
                    0 => inner.arena.words().binding(),
                    2 => self.extents.binding(),
                    4 => self.domains.binding(),
                    5 => self.probe.binding(),
                    6 => wgpu::BindingResource::TextureView(
                        &self.targets.as_ref().expect("a frame drew before probing").depth.1,
                    ),
                    7 => self.sprites.binding(),
                    8 => wgpu::BindingResource::TextureView(&inner.atlas.view),
                    9 => self.lists.binding(),
                    12 => self.remap.binding(),
                    13 => self.labels.binding(),
                    14 => wgpu::BindingResource::TextureView(&self.cells.view),
                    15 => wgpu::BindingResource::TextureView(&inner.icons.view),
                    16 => self.blocks.binding(),
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
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: samples,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                (texture, view)
            };
            let color =
                (samples > 1).then(|| texture("latkit samples", format, wgpu::TextureUsages::RENDER_ATTACHMENT));
            let depth = texture(
                "latkit depth",
                DEPTH,
                wgpu::TextureUsages::RENDER_ATTACHMENT
                    | if samples == 1 { wgpu::TextureUsages::TEXTURE_BINDING } else { wgpu::TextureUsages::empty() },
            );
            // A canvas being resized changes size every frame, so the old textures go at once.
            if let Some(old) = self.targets.replace(Targets { color, depth, size, format, samples }) {
                old.retire(&self.retired);
            }
            self.generation += 1;
        }
        let targets = self.targets.as_ref().expect("created");
        (targets.color.as_ref().map(|(_, view)| view.clone()), targets.depth.1.clone())
    }

    /// WebGL2 cannot sample a multisampled depth attachment. On frames that need a probe,
    /// opaque depth is replayed once at pixel centers into this single-sample target.
    pub(crate) fn pick_targets(&mut self, device: &wgpu::Device) -> (wgpu::TextureView, wgpu::TextureView) {
        let current = self.targets.as_ref().expect("a draw target");
        let (size, format) = (current.size, current.format);
        if self.pick_targets.as_ref().is_none_or(|p| p.size != size || p.format != format) {
            let make = |label, format, usage| {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                (texture, view)
            };
            let depth = make(
                "latkit pick depth",
                DEPTH,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            );
            let color = Some(make("latkit pick target", format, wgpu::TextureUsages::RENDER_ATTACHMENT));
            if let Some(old) = self.pick_targets.replace(Targets { color, depth, size, format, samples: 1 }) {
                old.retire(&self.retired);
            }
        }
        let targets = self.pick_targets.as_ref().expect("created");
        (targets.color.as_ref().expect("a color attachment").1.clone(), targets.depth.1.clone())
    }

    pub(crate) fn pick_depth(&self) -> &wgpu::TextureView {
        if self.samples() > 1 {
            &self.pick_targets.as_ref().expect("depth replayed").depth.1
        } else {
            &self.targets.as_ref().expect("drawn").depth.1
        }
    }

    /// Samples per pixel of the frame's targets.
    pub(crate) fn samples(&self) -> u32 {
        self.targets.as_ref().map_or(1, |t| t.samples)
    }
}

impl Drop for Resources {
    fn drop(&mut self) {
        for buffer in [&self.frame, &self.eye] {
            self.retired.retire(buffer.clone());
        }
        if let Some(targets) = self.pick_targets.take() {
            targets.retire(&self.retired);
        }
        if let Some(targets) = self.targets.take() {
            targets.retire(&self.retired);
        }
    }
}
