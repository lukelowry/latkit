//! A view's buffers, textures, and bind groups. Grown buffers grow by half again; replacing one bumps
//! the generation, and bind groups are rebuilt when a generation they were built from changes.
//!
//! Every shader's pass group (group 2) binds by one convention: 0 state, 1 frozen state, 2 extents,
//! 3 normals, 4 domains, 5 probe words and what queries find, 6 depth, 7 sprites, 8 the text atlas,
//! 9 lists, 10 the shadow map, 11 a level of it, 12 remap words, 13 labels, 14 the settled state,
//! 15 icons, 16 row blocks, 17 the probe's step.

use std::collections::HashMap;
use std::num::NonZeroU64;

use super::rows::Sizes;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::work::Queue;
use crate::gpu::{Inner, Shared};

/// Bytes between marks' uniforms and between eyes: the dynamic offset alignment every device supports.
pub(crate) const MARK_STRIDE: u64 = 256;
const _: () = assert!(size_of::<wgsl::Mark>() as u64 <= MARK_STRIDE, "a mark's uniform fits its stride");
/// The depth format; depth is reversed, nearer is greater.
pub(crate) const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// The shadow map's format.
pub(crate) const SHADE: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// Texels across the shadow map.
pub(crate) const SHADE_SIZE: u32 = 1024;

/// The eyes a frame draws through, by index.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum EyeSlot {
    Main = 0,
    Light = 1,
}

impl EyeSlot {
    pub(crate) fn offset(self) -> u32 {
        (self as u64 * MARK_STRIDE) as u32
    }
}

/// The dynamic offset of the probe's step `step`, one of the `STEP_` codes.
pub(crate) fn step(step: u32) -> u32 {
    (u64::from(step) * MARK_STRIDE) as u32
}

/// The probe's steps, each at its own dynamic offset: a dispatch binds the one it takes.
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
        size: bytes.max(256).next_multiple_of(4),
        usage: usage | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

const ROWS: wgpu::BufferUsages = wgpu::BufferUsages::STORAGE.union(wgpu::BufferUsages::COPY_SRC);

/// The bind groups every pipeline shares.
#[derive(Clone)]
pub(crate) struct Groups {
    pub(crate) view: wgpu::BindGroup,
    pub(crate) mark: wgpu::BindGroup,
}

/// What a frame draws into: multisampled color resolved into the target when it multisamples, and
/// depth.
struct Targets {
    color: Option<wgpu::TextureView>,
    depth: wgpu::TextureView,
    size: [u32; 2],
    format: wgpu::TextureFormat,
    samples: u32,
}

/// The ground's shadow map, its levels, and a view of each level.
pub(crate) struct ShadowMap {
    pub(crate) view: wgpu::TextureView,
    pub(crate) levels: Vec<wgpu::TextureView>,
}

impl ShadowMap {
    fn new(device: &wgpu::Device, size: u32) -> ShadowMap {
        let count = size.max(1).ilog2() + 1;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("latkit shadows"),
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
            mip_level_count: count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADE,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let levels = (0..count)
            .map(|level| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: level,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        ShadowMap { view: texture.create_view(&wgpu::TextureViewDescriptor::default()), levels }
    }
}

/// Buffers a layout of rows replaced, kept until their rows are copied out.
pub(crate) struct OldRows {
    pub(crate) state: wgpu::Buffer,
    pub(crate) frozen: Option<wgpu::Buffer>,
    pub(crate) settled: Option<wgpu::Buffer>,
}

pub(crate) struct Resources {
    pub(crate) frame: wgpu::Buffer,
    eyes: wgpu::Buffer,
    marks: Grown,
    program: Grown,
    focus: wgpu::Buffer,
    /// The rows each mark's focus draw lights.
    lit: Grown,
    state: wgpu::Buffer,
    frozen: Option<wgpu::Buffer>,
    /// The state's mirror that channels of marks easing toward a change store into, while one does:
    /// where their rows settle.
    settled: Option<wgpu::Buffer>,
    retired: Option<OldRows>,
    /// The row blocks each mark's evaluation covers this frame.
    blocks: Grown,
    remap: Grown,
    domains: Grown,
    extents: Grown,
    normals: Grown,
    /// The probe's words, then what the running query finds.
    probe: Grown,
    steps: wgpu::Buffer,
    sprites: Grown,
    lists: Grown,
    labels: wgpu::Buffer,
    empty: wgpu::Buffer,
    /// What the settled state binds without one: writable, so it never shares a buffer bound
    /// read-only.
    scratch: wgpu::Buffer,
    pub(crate) shadows: ShadowMap,
    /// Changes whenever one of the buffers or textures above is replaced; and whenever the lists
    /// buffer is, emptied.
    generation: u64,
    lists_generation: u64,
    /// Built from (arena, colormaps, icons, own) generations.
    groups: Option<((u64, u64, u64, u64), Groups)>,
    /// Pass groups, built at `passes_generation`.
    passes: HashMap<Shader, wgpu::BindGroup>,
    passes_generation: (u64, u64),
    targets: Option<Targets>,
}

impl Resources {
    pub(crate) fn new(device: &wgpu::Device) -> Resources {
        let storage = wgpu::BufferUsages::STORAGE;
        let uniform = wgpu::BufferUsages::UNIFORM;
        Resources {
            frame: create(device, "latkit frame", uniform, size_of::<wgsl::Frame>() as u64),
            eyes: create(device, "latkit eyes", uniform, 2 * MARK_STRIDE),
            marks: Grown::new(device, "latkit marks", uniform),
            program: Grown::new(device, "latkit program", storage),
            focus: create(device, "latkit focus", storage, 256),
            lit: Grown::new(device, "latkit lit", storage),
            state: create(device, "latkit state", ROWS, 256),
            frozen: None,
            settled: None,
            retired: None,
            blocks: Grown::new(device, "latkit blocks", storage),
            remap: Grown::new(device, "latkit remap", storage),
            domains: Grown::new(device, "latkit domains", storage),
            extents: Grown::new(device, "latkit extents", storage | wgpu::BufferUsages::COPY_SRC),
            normals: Grown::new(device, "latkit normals", storage),
            probe: Grown::new(device, "latkit probe", storage | wgpu::BufferUsages::COPY_SRC),
            steps: steps(device),
            sprites: Grown::new(device, "latkit sprites", storage),
            lists: Grown::new(
                device,
                "latkit lists",
                storage | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_SRC,
            ),
            labels: create(device, "latkit labels", ROWS, 256),
            empty: create(device, "latkit empty", ROWS, 256),
            scratch: create(device, "latkit scratch", ROWS, 256),
            shadows: ShadowMap::new(device, 1),
            generation: 0,
            lists_generation: 0,
            groups: None,
            passes: HashMap::new(),
            passes_generation: (u64::MAX, 0),
            targets: None,
        }
    }

    /// Lays rows out into new buffers of `sizes`, returning the buffers they replaced so their rows
    /// can be copied over; the frozen mirror, while one exists, is replaced alike.
    pub(crate) fn replace_rows(&mut self, device: &wgpu::Device, sizes: Sizes) -> OldRows {
        let words = |n: u64| (n + 1) * 4;
        let state = create(device, "latkit state", ROWS, words(sizes.state));
        self.focus = create(device, "latkit focus", wgpu::BufferUsages::STORAGE, words(sizes.focus));
        let frozen = self.frozen.as_ref().map(|_| create(device, "latkit frozen", ROWS, words(sizes.state)));
        let settled = self.settled.as_ref().map(|_| create(device, "latkit settled", ROWS, words(sizes.state)));
        let old = OldRows {
            state: std::mem::replace(&mut self.state, state),
            frozen: std::mem::replace(&mut self.frozen, frozen),
            settled: std::mem::replace(&mut self.settled, settled),
        };
        self.generation += 1;
        old
    }

    /// Keeps the buffers rows moved out of until the frame that reads them is submitted.
    pub(crate) fn retire(&mut self, old: OldRows) {
        self.retired = Some(old);
    }

    /// Drops buffers a previous frame retired.
    pub(crate) fn forget_retired(&mut self) {
        self.retired = None;
    }

    pub(crate) fn retired_state(&self) -> Option<&wgpu::Buffer> {
        self.retired.as_ref().map(|old| &old.state)
    }

    /// Makes the frozen mirror of the state buffer exist.
    pub(crate) fn ensure_frozen(&mut self, device: &wgpu::Device) {
        if self.frozen.is_none() {
            self.frozen = Some(create(device, "latkit frozen", ROWS, self.state.size()));
            self.generation += 1;
        }
    }

    pub(crate) fn drop_frozen(&mut self) {
        if self.frozen.take().is_some() {
            self.generation += 1;
        }
    }

    pub(crate) fn frozen(&self) -> Option<&wgpu::Buffer> {
        self.frozen.as_ref()
    }

    /// Makes the settled mirror of the state buffer exist.
    pub(crate) fn ensure_settled(&mut self, device: &wgpu::Device) {
        if self.settled.is_none() {
            self.settled = Some(create(device, "latkit settled", ROWS, self.state.size()));
            self.generation += 1;
        }
    }

    pub(crate) fn drop_settled(&mut self) {
        if self.settled.take().is_some() {
            self.generation += 1;
        }
    }

    pub(crate) fn settled(&self) -> Option<&wgpu::Buffer> {
        self.settled.as_ref()
    }

    /// Writes the row blocks every mark's evaluation covers this frame.
    pub(crate) fn write_blocks(&mut self, device: &wgpu::Device, queue: &Queue, blocks: &[u32]) {
        if self.blocks.ensure(device, (blocks.len() as u64 + 1) * 4) {
            self.generation += 1;
        }
        if !blocks.is_empty() {
            queue.write_buffer(&self.blocks.buffer, 0, bytemuck::cast_slice(blocks));
        }
    }

    /// Copies `rows` rows of a region's kind and extra words from `source` (the state buffer when
    /// `None`) at `from` into the frozen mirror at `to`.
    pub(crate) fn copy_frozen(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        source: Option<&wgpu::Buffer>,
        from: super::rows::Region,
        to: super::rows::Region,
        rows: u32,
    ) {
        let Some(frozen) = &self.frozen else { return };
        let source = source.unwrap_or(&self.state);
        let mut copy = |a: u32, b: u32, words: u32| {
            if words > 0 {
                encoder.copy_buffer_to_buffer(source, u64::from(a) * 4, frozen, u64::from(b) * 4, u64::from(words) * 4);
            }
        };
        if from.stride == to.stride {
            copy(from.state, to.state, rows * to.stride);
        }
        if from.extras == to.extras {
            copy(from.extra, to.extra, rows * to.extras);
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

    /// Makes room for every mark's uniforms, domains, extents, and normals for `vertices` slots.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, marks: u64, domains: u64, vertices: u64) {
        let words = |n: u64| (n + 1) * 4;
        let count = marks + 1;
        let mut replaced = self.domains.ensure(device, words(domains));
        replaced |= self.extents.ensure(device, words(u64::from(wgsl::EXTENT_WORDS) * count));
        replaced |= self.marks.ensure(device, MARK_STRIDE * count);
        replaced |= self.normals.ensure(device, words(3 * vertices));
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

    /// Makes room for `words` probe words, what the running query finds included.
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

    /// Makes the lists buffer hold `words`; replacing it, emptied, changes the lists generation, so
    /// every list counts again.
    pub(crate) fn fit_lists(&mut self, device: &wgpu::Device, words: u64) {
        if self.lists.ensure(device, (words + 1) * 4) {
            self.generation += 1;
            self.lists_generation += 1;
        }
    }

    /// Replaces the labels buffer with `words` of zeros.
    pub(crate) fn replace_labels(&mut self, device: &wgpu::Device, words: u64) {
        self.labels = create(device, "latkit labels", ROWS, (words + 1) * 4);
        self.generation += 1;
    }

    pub(crate) fn labels(&self) -> &wgpu::Buffer {
        &self.labels
    }

    /// Makes the shadow map exist at full size.
    pub(crate) fn ensure_shadows(&mut self, device: &wgpu::Device) {
        if self.shadows.levels.len() == 1 {
            self.shadows = ShadowMap::new(device, SHADE_SIZE);
            self.generation += 1;
        }
    }

    pub(crate) fn eyes(&self) -> &wgpu::Buffer {
        &self.eyes
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
        &self.focus
    }

    pub(crate) fn focus_words(&self) -> u64 {
        self.focus.size() / 4
    }

    pub(crate) fn state(&self) -> &wgpu::Buffer {
        &self.state
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
        &self.probe.buffer
    }

    pub(crate) fn sprites(&self) -> &wgpu::Buffer {
        &self.sprites.buffer
    }

    /// Changes whenever the lists buffer is replaced, emptied, so every list counts again.
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
        let eye =
            wgpu::BufferBinding { buffer: &self.eyes, offset: 0, size: NonZeroU64::new(size_of::<wgsl::Eye>() as u64) };
        let view = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("latkit view"),
            layout: &inner.pipelines.view_layout,
            entries: &[
                entry(0, self.frame.as_entire_binding()),
                entry(1, inner.arena.buffer().as_entire_binding()),
                entry(2, self.program.buffer.as_entire_binding()),
                entry(3, self.focus.as_entire_binding()),
                entry(4, wgpu::BindingResource::TextureView(&inner.colormaps.view)),
                entry(5, wgpu::BindingResource::Sampler(&gpu.sampler)),
                entry(6, wgpu::BindingResource::Buffer(eye)),
                entry(7, self.lit.buffer.as_entire_binding()),
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
        let generation = (self.generation, inner.icons.generation);
        if self.passes_generation != generation {
            self.passes.clear();
            self.passes_generation = generation;
        }
        if let Some(group) = self.passes.get(&shader) {
            return group.clone();
        }
        let group = self.bind(device, inner, shader, &self.state);
        self.passes.insert(shader, group.clone());
        group
    }

    /// The expression machine's group for a mark easing: its channels store into the settled mirror
    /// where the state binds, and the writable stand-in binds where the mirror does.
    pub(crate) fn settling_group(&self, device: &wgpu::Device, inner: &mut Inner) -> Option<wgpu::BindGroup> {
        let settled = self.settled.as_ref()?;
        Some(self.bind_into(device, inner, Shader::Evaluate, settled, &self.scratch))
    }

    /// The freeze pass's group: state read from the buffer rows moved out of when they moved.
    pub(crate) fn freeze_group(&mut self, device: &wgpu::Device, inner: &mut Inner, moved: bool) -> wgpu::BindGroup {
        match self.retired.as_ref().filter(|_| moved) {
            Some(old) => self.bind(device, inner, Shader::Freeze, &old.state),
            None => self.pass(device, inner, Shader::Freeze),
        }
    }

    /// A shadow map level's group, reading the level below it.
    pub(crate) fn level_group(&self, device: &wgpu::Device, inner: &mut Inner, below: usize) -> wgpu::BindGroup {
        let layout = inner.pipelines.pass_layout(device, Shader::Shade);
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("latkit shadow level"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 11,
                resource: wgpu::BindingResource::TextureView(&self.shadows.levels[below]),
            }],
        })
    }

    fn bind(&self, device: &wgpu::Device, inner: &mut Inner, shader: Shader, state: &wgpu::Buffer) -> wgpu::BindGroup {
        self.bind_into(device, inner, shader, state, self.settled.as_ref().unwrap_or(&self.scratch))
    }

    /// `shader`'s pass group, `state` bound as the state and `settled` as the settled mirror.
    fn bind_into(
        &self,
        device: &wgpu::Device,
        inner: &mut Inner,
        shader: Shader,
        state: &wgpu::Buffer,
        settled: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        let layout = inner.pipelines.pass_layout(device, shader);
        let entries: Vec<wgpu::BindGroupEntry<'_>> = shader
            .source()
            .pass
            .iter()
            .map(|binding| {
                let resource = match binding.slot {
                    0 => state.as_entire_binding(),
                    1 => self.frozen.as_ref().unwrap_or(&self.empty).as_entire_binding(),
                    2 => self.extents.buffer.as_entire_binding(),
                    3 => self.normals.buffer.as_entire_binding(),
                    4 => self.domains.buffer.as_entire_binding(),
                    5 => self.probe.buffer.as_entire_binding(),
                    6 => wgpu::BindingResource::TextureView(
                        &self.targets.as_ref().expect("a frame drew before probing").depth,
                    ),
                    7 => self.sprites.buffer.as_entire_binding(),
                    8 => wgpu::BindingResource::TextureView(&inner.atlas.view),
                    9 => self.lists.buffer.as_entire_binding(),
                    10 => wgpu::BindingResource::TextureView(&self.shadows.view),
                    12 => self.remap.buffer.as_entire_binding(),
                    13 => self.labels.as_entire_binding(),
                    14 => settled.as_entire_binding(),
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

    /// The color and depth a frame of `size` and `format` draws into with `samples` per pixel: color
    /// is `None` without multisampling, when marks draw straight into the target.
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
