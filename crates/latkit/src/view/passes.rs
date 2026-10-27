//! A frame's GPU passes.
//!
//! The compute pass freezes what rows showed for transitions starting this frame, expands paged
//! marks' drawn rows from their runs, evaluates dirty channels over the changed row blocks
//! (reducing fitted domains first), resolves endpoints, eases marks in transition, moves comets,
//! numbers segments, sums face normals when their corners moved, and measures extents when asked. The render pass draws the backdrop, then every mark's primitive and
//! ports in scene order with depth, then the labels and the overlay. A pending probe then reads
//! what the frame drew, through the same geometry.

use super::resources::MARK_STRIDE;
use super::sync::Source;
use super::variants::{CARRY, EASE, EXPAND_RUNS, GATHER, MarkVariants, NORMALS, TRAVEL};
use super::words::Kept;
use super::{Frame, View};
use crate::Space;
use crate::data::Field;
use crate::derive::stamp_of;
use crate::expr::compile::{Deps, Reads};
use crate::expr::cpu::Rows;
use crate::gpu::Inner;
use crate::gpu::pipelines::{Asked, Variant};
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::work::Count;
use crate::scene::mark::{MarkKind, Primitive};

const WORKGROUP: u32 = 256;
/// The most workgroups per dispatch dimension that every device supports.
const MAX_GROUPS: u32 = 65_535;

/// The scissor rectangle `[x, y, width, height]`, in target pixels, covering `area`. A plot's lines
/// draw only inside its axes.
fn scissor(area: super::camera::Area, frame: &Frame<'_>) -> [u32; 4] {
    let [w, h] = frame.size.map(f64::from);
    let r = f64::from(frame.pixel_ratio);
    let x0 = (area[0] * r).floor().clamp(0.0, w);
    let y0 = (area[1] * r).floor().clamp(0.0, h);
    let x1 = (area[2] * r).ceil().clamp(x0, w);
    let y1 = (area[3] * r).ceil().clamp(y0, h);
    [x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32]
}

/// Begins the main render pass: cleared to `background`, drawn into `view` and resolved into
/// `resolve` when multisampling, with depth stored only when `probing` reads it.
fn main_pass<'e>(
    encoder: &'e mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    resolve: Option<&wgpu::TextureView>,
    depth: &wgpu::TextureView,
    background: [f64; 4],
    probing: bool,
) -> wgpu::RenderPass<'e> {
    let [r, g, b, a] = background;
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("latkit"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: resolve,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }),
                store: if resolve.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store },
            },
        })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: depth,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(0.0),
                store: if probing { wgpu::StoreOp::Store } else { wgpu::StoreOp::Discard },
            }),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

/// The draws a frame recorded and the instances they draw. For a draw whose segment list counts its
/// instances on the GPU, the count is an upper bound.
#[derive(Clone, Copy, Default, Debug)]
pub(super) struct Drawn {
    pub(super) draws: u64,
    pub(super) instances: u64,
}

impl Drawn {
    /// Draws and counts `instances` instances of `corners` vertices each.
    pub(super) fn draw(&mut self, pass: &mut wgpu::RenderPass<'_>, corners: u32, instances: u32) {
        pass.draw(0..corners, 0..instances);
        self.count(instances);
    }

    fn count(&mut self, instances: u32) {
        self.draws += 1;
        self.instances += u64::from(instances);
    }
}

/// State that every mark's draw in the main pass shares: the device and target, the bind groups,
/// the lists buffer, and the plot area that lines clip to.
struct Marks<'a> {
    device: &'a wgpu::Device,
    format: wgpu::TextureFormat,
    samples: u32,
    groups: &'a super::resources::Groups,
    passes: &'a [(Shader, wgpu::BindGroup)],
    lists: &'a wgpu::Buffer,
    clip: Option<[u32; 4]>,
    size: [u32; 2],
}

impl Marks<'_> {
    /// Draws mark `i`: every instance, or with `lit`, only the rows its focus lights, glowing.
    fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        i: usize,
        shown: &super::marks::Shown,
        lit: bool,
    ) {
        if shown.compiled.is_none() {
            return;
        }
        let variants = MarkVariants::shown(shown);
        let (Some(shader), Some(asked)) = (variants.shader(lit), variants.draw(lit, self.format, self.samples)) else {
            return;
        };
        let pipeline = match asked {
            Asked::Shader(variant) => Some(inner.pipelines.render(self.device, variant)),
            Asked::Custom(source, variant) => inner.pipelines.custom(self.device, &source, variant),
        };
        let Some(pipeline) = pipeline else { return };
        let corners = shown.kind().primitive().corners();
        let group = &self.passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        pass.set_bind_group(1, &self.groups.mark, &[offset(i)]);
        let clip = self.clip.filter(|_| shown.kind() == MarkKind::Lines);
        if let Some([x, y, w, h]) = clip {
            pass.set_scissor_rect(x, y, w, h);
        }
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(2, group, &[]);
        if lit {
            drawn.draw(pass, corners, shown.lit.rows * shown.lit.pieces);
        } else {
            shown.record(pass, drawn, corners, self.lists);
        }
        if clip.is_some() {
            pass.set_scissor_rect(0, 0, self.size[0], self.size[1]);
        }
    }

    /// Draws the ports of every row of mark `i`, if its rows have ports. Called after its rows, and
    /// again after its lit rows, since ports sit on top of them.
    fn ports(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        i: usize,
        shown: &super::marks::Shown,
    ) {
        let ports = shown.port_count();
        if ports == 0 || shown.compiled.is_none() || shown.kind() != MarkKind::Vertices {
            return;
        }
        let group = &self.passes.iter().find(|(s, _)| *s == Shader::PointsPorts).expect("listed").1;
        pass.set_bind_group(1, &self.groups.mark, &[offset(i)]);
        let variant = Variant::draw(Shader::PointsPorts, self.format, self.samples);
        pass.set_pipeline(&inner.pipelines.render(self.device, variant));
        pass.set_bind_group(2, group, &[]);
        drawn.draw(pass, 4, (shown.rows + shown.exits) * ports);
    }
}

/// The marks each step of a frame's compute pass covers.
struct Work {
    /// Marks whose transitions start this frame, freezing what their rows showed.
    frozen: Vec<usize>,
    evaluated: Vec<usize>,
    /// Marks whose rows resolve changed endpoints.
    resolved: Vec<usize>,
    /// Marks whose ease pass writes their shown state from their frozen and settled words.
    eased: Vec<usize>,
    segments: Vec<usize>,
    faces: Vec<usize>,
    measured: Vec<usize>,
    /// Marks whose comets carry their travel over to rows a transition moved; `travelled`, marks
    /// whose comets move this frame.
    carried: Vec<usize>,
    travelled: Vec<usize>,
    /// Marks whose drawn rows' words are rebuilt from their runs.
    expanded: Vec<usize>,
}

/// Dispatches one workgroup per `WORKGROUP` items, if there are any. Past one dimension's limit, it
/// dispatches rows of `DISPATCH_ROWS` items along the second dimension, as `item` in
/// `lib/types.wesl` expects.
pub(super) fn dispatch(pass: &mut wgpu::ComputePass<'_>, items: u32) {
    let groups = items.div_ceil(WORKGROUP);
    if groups > MAX_GROUPS {
        pass.dispatch_workgroups(wgsl::DISPATCH_ROWS / WORKGROUP, items.div_ceil(wgsl::DISPATCH_ROWS), 1);
    } else if groups > 0 {
        pass.dispatch_workgroups(groups, 1, 1);
    }
}

/// The row blocks `shown` evaluates: those its dirty channels cover, and those whose state words
/// start over, flagged with `FRESH`.
fn listed(shown: &super::marks::Shown) -> Vec<u32> {
    let count = shown.live().div_ceil(wgsl::PAGE_ROWS);
    let mut fresh: Vec<u32> = shown.fresh.iter().copied().filter(|&b| b < count).collect();
    fresh.sort_unstable();
    fresh.dedup();
    let mut blocks = if shown.dirty != 0 || shown.reduce { shown.blocks.of(shown.live()) } else { Vec::new() };
    blocks.extend(&fresh);
    blocks.sort_unstable();
    blocks.dedup();
    for block in &mut blocks {
        if fresh.binary_search(block).is_ok() {
            *block |= wgsl::FRESH;
        }
    }
    blocks
}

/// Dispatches over `blocks` listed row blocks of a mark with `rows` held rows: x spans one block's
/// rows, and y the blocks.
pub(super) fn dispatch_blocks(pass: &mut wgpu::ComputePass<'_>, rows: u32, blocks: u32) {
    let wide = rows.min(wgsl::PAGE_ROWS).div_ceil(WORKGROUP);
    if wide > 0 && blocks > 0 {
        pass.dispatch_workgroups(wide, blocks, 1);
    }
}

/// Mark `index`'s dynamic offset in the marks' uniforms.
pub(super) fn offset(index: usize) -> u32 {
    (index as u64 * MARK_STRIDE) as u32
}

/// The least and greatest finite value of `input` over `rows`, encoded as `lib/reduce.wesl` keeps
/// them: the complement of the least's key, then the greatest's. `[0, 0]` when no row has a finite
/// value.
fn fit(rows: &Rows<'_>, input: &crate::Expr) -> [u32; 2] {
    use crate::order::number32;
    let (mut least, mut most) = (f32::INFINITY, f32::NEG_INFINITY);
    for x in rows.numbers(input, |v| v as f32) {
        if x.is_finite() {
            (least, most) = (least.min(x), most.max(x));
        }
    }
    if least > most { [0, 0] } else { [!number32(least), number32(most)] }
}

impl super::marks::Shown {
    /// Whether its fitted domains are computed on the CPU over every row of its paged table: it has
    /// a drawing, and the domains read only its own data, nothing the view shows or derives.
    pub(crate) fn fits_data(&self) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        let program = &compiled.program;
        let viewed = Deps::TIME | Deps::POINTER | Deps::FOCUS | Deps::CAMERA | Deps::DOMAIN;
        let derived = |reads: &Reads| {
            program
                .columns
                .iter()
                .enumerate()
                .any(|(c, column)| column.derived && reads.columns & Reads::column(c) != 0)
        };
        self.drawing().is_some()
            && !program.domains.is_empty()
            && program.domains.iter().all(|reads| !reads.deps.intersects(viewed) && !derived(reads))
    }

    /// Segments per row, for strokes whose rows all have the same count.
    pub(crate) fn segments_per_row(&self) -> u32 {
        if self.compiled.is_none() {
            return 0;
        }
        match self.kind() {
            // A trace's point count includes the corners its steps make.
            MarkKind::Lines => self.tables.traced().saturating_sub(1),
            _ => 1,
        }
    }

    /// Instances its primitive draws: rows and exits, or every segment of their paths. With a
    /// segment list, the entries the list keeps, an upper bound.
    pub(crate) fn instances(&self) -> u32 {
        if let Some(list) = &self.segments.list {
            return list.kept;
        }
        let rows = self.rows + self.exits;
        match self.compiled.as_ref().map(|_| self.kind().primitive()) {
            Some(Primitive::Strokes) => rows * self.segments_per_row(),
            Some(_) => rows,
            None => 0,
        }
    }

    /// Instances that probes and measures cover: live rows and their ports, not exits.
    pub(crate) fn live_instances(&self) -> u32 {
        if let Some(list) = &self.segments.list {
            return list.kept;
        }
        match self.compiled.as_ref().map(|_| self.kind().primitive()) {
            Some(Primitive::Strokes) => self.rows * self.segments_per_row(),
            Some(Primitive::Points) => self.rows * (1 + self.port_count()),
            Some(_) => self.rows,
            None => 0,
        }
    }

    /// Records the draw of its instances, indirect from its segment list when it has one.
    pub(super) fn record(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        corners: u32,
        lists: &wgpu::Buffer,
    ) {
        match &self.segments.list {
            Some(list) => {
                pass.draw_indirect(lists, u64::from(list.header + wgsl::LIST_DRAW) * 4);
                drawn.count(list.kept);
            }
            None => drawn.draw(pass, corners, self.instances()),
        }
    }
}

impl View {
    /// Evaluates the dirty channels of marks `work` over their dirty row blocks, first reducing the
    /// fitted domains that changed. Channels write a mark's state, or its settled words while it
    /// eases. `state` is the expression machine's pass group.
    fn evaluate(
        &mut self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        group: &wgpu::BindGroup,
        state: &wgpu::BindGroup,
        work: &[usize],
    ) {
        if work.is_empty() {
            return;
        }
        let device = &self.gpu.0.device;
        let step = super::resources::step;
        for &i in work {
            let shown = &mut self.marks[i];
            let into = state;
            pass.set_pipeline(&inner.pipelines.compute(device, Variant::channels(shown.reads())));
            pass.set_bind_group(1, group, &[offset(i)]);
            let rows = shown.live();
            // A changed domain dirties every block, so the reductions run over the listed blocks. A
            // paged table whose domains read only its data fits them on the CPU, over every row.
            if shown.reduce && rows > 0 && !shown.fits_data() {
                debug_assert_eq!(shown.blocks, super::marks::Blocks::All, "a changed domain dirties every block");
                pass.set_bind_group(2, into, &[step(wgsl::STEP_REDUCE)]);
                dispatch_blocks(pass, rows, shown.block_count);
            }
            pass.set_bind_group(2, into, &[step(wgsl::STEP_CHANNELS)]);
            dispatch_blocks(pass, rows, shown.block_count);
            let blocks = shown.blocks.of(rows);
            let evaluated = blocks.iter().map(|&b| u64::from((rows - b * wgsl::PAGE_ROWS).min(wgsl::PAGE_ROWS)));
            self.gpu.0.counters.add(Count::Evaluated, evaluated.sum());
            shown.dirty = 0;
            shown.blocks = super::marks::Blocks::default();
            shown.reduce = false;
            shown.fresh.clear();
        }
        pass.set_bind_group(2, state, &[step(wgsl::STEP_CHANNELS)]);
    }

    /// Records the frame's compute pass: freezes starting transitions, evaluates dirty channels, and
    /// sums face normals when their inputs changed. With `measure`, it also measures the extents of
    /// every measured mark and returns their readback. With `travel`, comets move by the frame's
    /// step.
    pub(super) fn compute(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        measure: bool,
        travel: bool,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let Work { frozen, evaluated: work, resolved, eased, segments, faces, measured, carried, travelled, expanded } =
            self.work(measure, travel);
        let all = [&frozen, &work, &resolved, &eased, &segments, &faces, &measured, &carried, &travelled, &expanded];
        if all.iter().all(|marks| marks.is_empty()) {
            return None;
        }
        self.start_domains(encoder, &work);
        let resources = self.resources.as_mut().expect("created before passes");
        let extent_bytes = self.marks.len() as u64 * u64::from(wgsl::EXTENT_WORDS) * 4;
        if !measured.is_empty() {
            encoder.clear_buffer(resources.extents(), 0, Some(extent_bytes));
        }
        inner.arena.written();
        if !faces.is_empty() {
            // Faces sum their normals from zero into the pages of the vertex marks they attach to.
            let words = u64::from(wgsl::PAGE_ROWS * wgsl::NORMAL_WORDS) * 4;
            for shown in &self.marks {
                for &block in shown.words.pages(Kept::Normals).blocks.iter() {
                    gpu.0.queue.clear_buffer(encoder, inner.arena.buffer(), u64::from(block) * 4, words);
                }
            }
        }
        let groups = resources.groups(&gpu.0, inner);
        let freeze_group = (!frozen.is_empty()).then(|| resources.pass(device, inner, Shader::Freeze));
        let evaluate_group = resources.pass(device, inner, Shader::Evaluate);
        let normals_group = (!faces.is_empty()).then(|| resources.pass(device, inner, Shader::Normals));
        let bounds_group = (!measured.is_empty()).then(|| resources.pass(device, inner, Shader::Bounds));
        let lists_group =
            (!segments.is_empty() || !expanded.is_empty()).then(|| resources.pass(device, inner, Shader::Lists));
        for &i in &segments {
            let list = self.marks[i].segments.list.expect("listed");
            gpu.0.queue.write_buffer(
                resources.lists(),
                u64::from(list.header) * 4,
                bytemuck::cast_slice(&list.header_words(self.marks[i].kind().primitive().corners())),
            );
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit compute"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[]);
            let held = super::marks::Shown::held;
            // Starting transitions freeze what their rows showed as the frame began, before any
            // pass writes it, and after packing placed their page tables.
            if let Some(group) = &freeze_group {
                pass.set_bind_group(2, group, &[]);
                self.over_marks(&mut pass, inner, &groups.mark, GATHER, &frozen, held);
            }
            // Each drawn row's word first, exits included: every later pass reads it.
            if let Some(group) = &lists_group {
                pass.set_bind_group(2, group, &[]);
                self.over_marks(&mut pass, inner, &groups.mark, EXPAND_RUNS, &expanded, |s| s.rows + s.exits);
            }
            pass.set_bind_group(2, &evaluate_group, &[super::resources::step(wgsl::STEP_CHANNELS)]);
            self.over_marks(&mut pass, inner, &groups.mark, CARRY, &carried, held);
            self.evaluate(&mut pass, inner, &groups.mark, &evaluate_group, &work);
            // Before anything that reads where rows' endpoints are held.
            self.resolve_ends(&mut pass, inner, &groups.mark, &evaluate_group, &resolved);
            // After evaluating, so marks ease toward this frame's values.
            self.over_marks(&mut pass, inner, &groups.mark, EASE, &eased, held);
            // After evaluating, so comets travel at this frame's flow.
            self.over_marks(&mut pass, inner, &groups.mark, TRAVEL, &travelled, held);
            if let Some(group) = &lists_group {
                pass.set_bind_group(2, group, &[]);
                self.count_segments(&mut pass, inner, &groups.mark, &segments);
            }
            if let Some(group) = &normals_group {
                pass.set_bind_group(2, group, &[]);
                self.over_marks(&mut pass, inner, &groups.mark, NORMALS, &faces, |s| s.rows);
            }
            if let Some(group) = &bounds_group {
                pass.set_bind_group(2, group, &[]);
                for &i in &measured {
                    let Some(bounds) = MarkVariants::shown(&self.marks[i]).bounds() else { continue };
                    pass.set_pipeline(&inner.pipelines.compute(device, bounds));
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    dispatch(&mut pass, self.marks[i].live_instances());
                }
            }
        }
        let resources = self.resources.as_ref().expect("created before passes");
        (!measured.is_empty()).then(|| {
            Readback::new(&inner.readbacks, device, encoder, resources.extents(), 0, extent_bytes, &self.waker)
        })
    }

    /// Prepares the fitted domains that marks `work` reduce. Domains computed on the CPU over a
    /// paged table's rows are written; the rest are cleared for the GPU to fit.
    fn start_domains(&mut self, encoder: &mut wgpu::CommandEncoder, work: &[usize]) {
        let mut fitted: Vec<(usize, Vec<u32>)> = Vec::new();
        for &i in work {
            if self.marks[i].reduce && self.marks[i].fits_data() {
                fitted.push((i, self.data_domains(i)));
            }
        }
        let resources = self.resources.as_mut().expect("created before passes");
        for &i in work {
            let shown = &self.marks[i];
            if !shown.reduce {
                continue;
            }
            let at = u64::from(shown.domains) * 8;
            match fitted.iter().find(|(m, _)| *m == i) {
                Some((_, words)) => self.gpu.0.queue.write_buffer(resources.domains(), at, bytemuck::cast_slice(words)),
                None => encoder.clear_buffer(resources.domains(), at, Some(u64::from(shown.reductions()) * 8)),
            }
        }
    }

    /// Chooses the marks each compute step covers this frame: freezing, evaluation, endpoint
    /// resolution, easing, segment counting, face normals, measuring, comet carry, run expansion,
    /// and with `travel`, comet travel.
    fn work(&mut self, measure: bool, travel: bool) -> Work {
        let frozen = (0..self.marks.len()).filter(|&i| self.marks[i].remap != wgsl::NONE).collect();
        for shown in &mut self.marks {
            // A mark without rows has nothing to evaluate and no endpoints to resolve.
            if shown.held() == 0 && shown.tables.synced() {
                shown.dirty = 0;
                shown.reduce = false;
                shown.unresolved = super::marks::Blocks::default();
                shown.fresh.clear();
            }
        }
        let work: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].block_count > 0).collect();
        let resolved: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].end_block_count > 0).collect();
        for &i in &work {
            let shown = &mut self.marks[i];
            shown.version += 1;
            if shown.dirty & shown.placing_channels() != 0 {
                shown.place_version += 1;
            }
        }
        // A mark in transition rewrites its shown state when the clock moves and when it evaluates.
        let eased: Vec<usize> = (0..self.marks.len())
            .filter(|&i| {
                let shown = &self.marks[i];
                shown.drawable() && shown.transition.is_some() && (shown.easing || work.contains(&i))
            })
            .collect();
        for shown in &mut self.marks {
            if shown.easing {
                shown.version += 1;
                shown.easing = false;
            }
        }
        let segments = self.segments_due();
        let faces = if self.normals_due() {
            (0..self.marks.len()).filter(|&i| self.marks[i].drawable() && self.marks[i].faces()).collect()
        } else {
            Vec::new()
        };
        let measured = (0..self.marks.len())
            .filter(|&i| measure && self.marks[i].drawable() && self.marks[i].measured())
            .collect();
        let flowing = |i: &usize| self.marks[*i].drawable() && self.marks[*i].mark.flows();
        let carried = (0..self.marks.len()).filter(|i| self.marks[*i].carry && flowing(i)).collect();
        let travelled = (0..self.marks.len()).filter(|i| travel && flowing(i)).collect();
        let expanded = self.drawn_rows_due();
        Work { frozen, evaluated: work, resolved, eased, segments, faces, measured, carried, travelled, expanded }
    }

    /// Writes the blocks buffer, which each mark's uniform points into. For each mark, it lists the
    /// row blocks it evaluates this frame (every block when a channel changed for every row, else
    /// the changed pages), then the row blocks whose endpoints it resolves.
    pub(super) fn lay_out_blocks(&mut self) {
        let mut words = Vec::new();
        for shown in &mut self.marks {
            let evaluates = shown.drawable() && (shown.dirty != 0 || shown.reduce || !shown.fresh.is_empty());
            let blocks = if evaluates { listed(shown) } else { Vec::new() };
            shown.block = words.len() as u32;
            shown.block_count = blocks.len() as u32;
            words.extend(blocks);
            let ends = if shown.drawable() { shown.unresolved.of(shown.live()) } else { Vec::new() };
            shown.end_block = words.len() as u32;
            shown.end_block_count = ends.len() as u32;
            words.extend(ends);
        }
        let gpu = self.gpu.clone();
        let resources = self.resources.as_mut().expect("created before passes");
        resources.write_blocks(&gpu.0.device, &gpu.0.queue, &words);
    }

    /// Runs `variant` over each of `marks`, one invocation per item `items` counts for the mark.
    fn over_marks(
        &self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        mark: &wgpu::BindGroup,
        variant: Variant,
        marks: &[usize],
        items: impl Fn(&super::marks::Shown) -> u32,
    ) {
        if marks.is_empty() {
            return;
        }
        pass.set_pipeline(&inner.pipelines.compute(&self.gpu.0.device, variant));
        for &i in marks {
            pass.set_bind_group(1, mark, &[offset(i)]);
            dispatch(pass, items(&self.marks[i]));
        }
    }

    /// Records the count, scan, and write steps of each of `marks`' segment lists.
    fn count_segments(
        &self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        mark: &wgpu::BindGroup,
        marks: &[usize],
    ) {
        let device = &self.gpu.0.device;
        for &i in marks {
            let items = self.marks[i].rows + self.marks[i].exits;
            let [count, write] = MarkVariants::shown(&self.marks[i]).segments();
            pass.set_bind_group(1, mark, &[offset(i)]);
            pass.set_pipeline(&inner.pipelines.compute(device, count));
            dispatch(pass, items);
            super::lists::scan(pass, &mut inner.pipelines, device, items);
            pass.set_pipeline(&inner.pipelines.compute(device, write));
            dispatch(pass, items);
        }
    }

    /// The words of mark `i`'s fitted domains, as `lib/reduce.wesl` keeps them, each computed on
    /// the CPU over every row of its paged table. So a domain stays fixed however little of the
    /// table the camera shows. Each is cached by the stamp of its inputs, so a camera move refits
    /// none.
    fn data_domains(&mut self, i: usize) -> Vec<u32> {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return Vec::new() };
        let program = &compiled.program;
        let Some(source) = Source::of(shown.mark.style(), &self.snapshots, &self.derived) else {
            return vec![0; 2 * program.domains.len()];
        };
        let table = source.table;
        let rows = Rows::new(table, &self.snapshots).at(self.at);
        let mut fitted = Vec::with_capacity(program.domains.len());
        for (d, (reads, input)) in program.domains.iter().zip(&program.fitted).enumerate() {
            let versions: Vec<Option<crate::data::Version>> = (0..program.columns.len())
                .filter(|&c| reads.columns & Reads::column(c) != 0)
                .map(|c| {
                    let column = &program.columns[c];
                    source.table_of(column, &self.snapshots)?.1.field_named(&column.name).map(Field::version)
                })
                .collect();
            let sampled = reads.deps.intersects(Deps::SAMPLES).then_some(self.at.to_bits());
            let stamp = stamp_of((versions, table.structure, sampled));
            let words = match shown.fitted.get(d) {
                Some(&(kept, words)) if kept == stamp => words,
                _ => fit(&rows, input),
            };
            fitted.push((stamp, words));
        }
        let words = fitted.iter().flat_map(|(_, w)| *w).collect();
        self.marks[i].fitted = fitted;
        words
    }

    /// Whether face normals need summing again: a face or vertex mark wrote its state since the
    /// last sum, or the globe turned.
    fn normals_due(&mut self) -> bool {
        let faces = self.marks.iter().any(|m| m.drawable() && m.faces());
        if !faces {
            return false;
        }
        let versions: Vec<u64> = self
            .marks
            .iter()
            .filter(|m| matches!(m.kind(), MarkKind::Vertices | MarkKind::Faces))
            .map(|m| m.version + u64::from(m.dirty != 0))
            .collect();
        let turned = match (&self.scene.space, self.camera) {
            (Space::Earth(_), crate::Camera::Map { center, .. }) => Some([center[0].to_bits(), center[1].to_bits()]),
            _ => None,
        };
        let stamp = stamp_of((versions, turned, self.marks.len()));
        if !self.normals.due(stamp) {
            return false;
        }
        self.normals.mark(stamp);
        true
    }

    /// Records the main render pass, counting draws in `drawn`: the backdrop, every drawable mark
    /// in scene order, and the lit rows. Once the text pipelines are ready, it also builds the
    /// distance fields of text set this frame, and draws the labels and `sprites` overlay sprites.
    /// Depth is stored when `probing` reads it.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        drawn: &mut Drawn,
        frame: &Frame<'_>,
        sprites: u32,
        probing: bool,
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let texts = self.texts();
        if texts {
            let Inner { atlas, pipelines, .. } = &mut *inner;
            atlas.lay(device, &gpu.0.queue, encoder, pipelines);
        }
        let background =
            if self.signal.transparent() { [0.0; 4] } else { self.scene.theme.background.to_array().map(f64::from) };
        let plot = matches!(self.scene.space, Space::Plot(_));
        let scissor = scissor(self.area(), frame);
        let samples = gpu.samples_for(frame.pixel_ratio);
        let resources = self.resources.as_mut().expect("created before passes");
        let (color, depth) = resources.targets(device, frame.size, frame.format, samples);
        let groups = resources.groups(&gpu.0, inner);
        let lists = resources.lists().clone();
        let mut passes: Vec<(Shader, wgpu::BindGroup)> = Vec::new();
        for shader in [
            Shader::Backdrop,
            Shader::Points,
            Shader::PointsCustom,
            Shader::PointsPorts,
            Shader::Strokes,
            Shader::Triangles,
            Shader::Areas,
            Shader::PointsFocus,
            Shader::PointsCustomFocus,
            Shader::StrokesFocus,
            Shader::AreasFocus,
            Shader::Glyphs,
            Shader::GlyphsPorts,
            Shader::Overlay,
        ] {
            passes.push((shader, resources.pass(device, inner, shader)));
        }
        let group = |shader: Shader| &passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        let (view, resolve) = match &color {
            Some(color) => (color, Some(frame.target)),
            None => (frame.target, None),
        };
        let mut pass = main_pass(encoder, view, resolve, &depth, background, probing);
        pass.set_bind_group(0, &groups.view, &[]);
        pass.set_bind_group(1, &groups.mark, &[0]);
        pass.set_pipeline(&inner.pipelines.render(device, Variant::draw(Shader::Backdrop, frame.format, samples)));
        pass.set_bind_group(2, group(Shader::Backdrop), &[]);
        drawn.draw(&mut pass, 3, 1);
        let marks = Marks {
            device,
            format: frame.format,
            samples,
            groups: &groups,
            passes: &passes,
            lists: &lists,
            clip: (plot && scissor[2] > 0 && scissor[3] > 0).then_some(scissor),
            size: frame.size,
        };
        for (i, shown) in self.marks.iter().enumerate() {
            if !shown.drawable() || shown.instances() == 0 {
                continue;
            }
            marks.draw(&mut pass, drawn, inner, i, shown, false);
            marks.ports(&mut pass, drawn, inner, i, shown);
        }
        // Lit rows draw again, glowing, over every mark but labels; only their own ports cover
        // them. They draw once their pipelines have compiled.
        for (i, shown) in self.marks.iter().enumerate() {
            if self.answers() && shown.drawable() && shown.lit.rows > 0 {
                marks.draw(&mut pass, drawn, inner, i, shown, true);
                marks.ports(&mut pass, drawn, inner, i, shown);
            }
        }
        if !texts {
            return;
        }
        let glyphs = [Shader::Glyphs, Shader::GlyphsPorts].map(group);
        self.draw_labels(&mut pass, drawn, inner, frame.format, samples, &groups, glyphs);
        if sprites > 0 {
            pass.set_pipeline(&inner.pipelines.render(device, Variant::draw(Shader::Overlay, frame.format, samples)));
            pass.set_bind_group(2, group(Shader::Overlay), &[]);
            drawn.draw(&mut pass, 4, sprites);
        }
    }

    /// Records the probe pass: finds the drawn row nearest the probe point and the nearest depth
    /// drawn there, and returns their readback.
    pub(super) fn probe(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> Readback {
        let probed: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].probed()).collect();
        // Any drawn mark's probe program can read the depth under the probe; the first one does.
        let under: Vec<usize> = self.marks.iter().position(super::marks::Shown::drawable).into_iter().collect();
        let mut reset = [0_u32; wgsl::PROBE_WORDS as usize];
        reset[wgsl::PROBE_KEY as usize] = wgsl::NONE;
        let probe = self.resources.as_ref().expect("created before passes").probe();
        self.gpu.0.queue.write_buffer(probe, 0, bytemuck::cast_slice(&reset));
        // Each step runs over every mark before the next: the nearest key, then its topmost
        // instance, then where that lies.
        let steps = [wgsl::STEP_NEAREST, wgsl::STEP_TOPMOST, wgsl::STEP_DESCRIBE].map(|step| (step, &probed[..]));
        self.probe_pass(encoder, inner, "latkit probe", &[&steps[..], &[(wgsl::STEP_UNDER, &under[..])]].concat());
        let resources = self.resources.as_ref().expect("created before passes");
        let (device, bytes) = (&self.gpu.0.device, u64::from(wgsl::PROBE_WORDS) * 4);
        Readback::new(&inner.readbacks, device, encoder, resources.probe(), 0, bytes, &self.waker)
    }

    /// Records a compute pass named `label` that runs each of `steps` of the probe program in turn:
    /// a `STEP_` code, over each of the marks listed with it.
    pub(super) fn probe_pass(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        label: &str,
        steps: &[(u32, &[usize])],
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before passes");
        let shader = crate::gpu::pipelines::probe(resources.samples());
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, shader);
        let mut pass =
            encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some(label), timestamp_writes: None });
        pass.set_bind_group(0, &groups.view, &[]);
        for &(step, marks) in steps {
            pass.set_bind_group(2, &group, &[super::resources::step(step)]);
            for &i in marks {
                let shown = &self.marks[i];
                pass.set_pipeline(&inner.pipelines.compute(device, MarkVariants::shown(shown).probe(shader)));
                pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                // A step that reads one result runs once; the rest run over every instance probes
                // cover.
                if matches!(step, wgsl::STEP_DESCRIBE | wgsl::STEP_LOCATE | wgsl::STEP_UNDER) {
                    pass.dispatch_workgroups(1, 1, 1);
                } else {
                    dispatch(&mut pass, shown.live_instances());
                }
            }
        }
    }
}
