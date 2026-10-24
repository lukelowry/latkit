//! A frame's passes: compute evaluates dirty channels over the row blocks that changed, eases what
//! marks show toward what changed, reduces fitted domains, numbers segments, sums
//! face normals when their corners moved, and measures extents when asked; render draws the
//! backdrop, every mark's primitive and ports in scene order with depth, the labels, and the
//! overlay; a probe, when one waits, reads what the frame drew through the same geometry.

use super::resources::{EyeSlot, MARK_STRIDE};
use super::sync::{Source, table_of};
use super::words::Kept;
use super::{Frame, View};
use crate::Space;
use crate::data::Field;
use crate::derive::stamp_of;
use crate::expr::compile::{Deps, Reads};
use crate::expr::cpu::Rows;
use crate::gpu::Inner;
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::work::Count;
use crate::scene::mark::{MarkKind, Primitive};

const WORKGROUP: u32 = 256;
/// Workgroups one dimension of a dispatch holds on every device.
const MAX_GROUPS: u32 = 65_535;

/// The target pixels of `area`: a plot's lines draw only inside its axes.
fn scissor(area: super::camera::Area, frame: &Frame<'_>) -> [u32; 4] {
    let [w, h] = frame.size.map(f64::from);
    let r = f64::from(frame.pixel_ratio);
    let x0 = (area[0] * r).floor().clamp(0.0, w);
    let y0 = (area[1] * r).floor().clamp(0.0, h);
    let x1 = (area[2] * r).ceil().clamp(x0, w);
    let y1 = (area[3] * r).ceil().clamp(y0, h);
    [x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32]
}

/// The main render pass: cleared to `background`, multisampled into `view` and resolved into
/// `resolve` when there is one, its depth kept when `probing` reads it.
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

/// The draws a frame recorded, and the instances they draw: at most, for a draw its segment list
/// counts on the GPU.
#[derive(Clone, Copy, Default, Debug)]
pub(super) struct Drawn {
    pub(super) draws: u64,
    pub(super) instances: u64,
}

impl Drawn {
    /// Draws `instances` of `corners` corners each, counted.
    pub(super) fn draw(&mut self, pass: &mut wgpu::RenderPass<'_>, corners: u32, instances: u32) {
        pass.draw(0..corners, 0..instances);
        self.count(instances);
    }

    fn count(&mut self, instances: u32) {
        self.draws += 1;
        self.instances += u64::from(instances);
    }
}

/// What every mark's draw in the main pass shares: the device and target, the bind groups, the
/// lists buffer, and a plot's axes, which its lines clip to.
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
    /// Draws mark `i`, `shown`: every instance, or with `lit` the rows its focus lights, glowing.
    fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        i: usize,
        shown: &super::marks::Shown,
        lit: bool,
    ) {
        let Some(compiled) = &shown.compiled else { return };
        let custom = compiled.drawing.markers.custom.is_some();
        let areas = shown.path() == wgsl::PATH_GEOMETRY;
        let (shader, corners) = match (compiled.drawing.primitive, lit) {
            (Primitive::Points, false) if custom => (Shader::PointsCustom, 4),
            (Primitive::Points, false) => (Shader::Points, 4),
            (Primitive::Points, true) if custom => (Shader::PointsCustomFocus, 4),
            (Primitive::Points, true) => (Shader::PointsFocus, 4),
            (Primitive::Strokes, false) => (Shader::Strokes, 4),
            (Primitive::Strokes, true) => (Shader::StrokesFocus, 4),
            (Primitive::Triangles, false) if areas => (Shader::Areas, 3),
            (Primitive::Triangles, false) => (Shader::Triangles, 3),
            (Primitive::Triangles, true) if areas => (Shader::AreasFocus, 3),
            // A face lights by its color alone.
            (Primitive::Triangles, true) => return,
        };
        let pipeline = if let Some(source) = &compiled.drawing.markers.custom {
            inner.pipelines.custom(self.device, source, shader, self.format, self.samples)
        } else {
            let variant = Variant::draw(shader, self.format, self.samples).path(shown.path());
            Some(inner.pipelines.render_pipeline(self.device, variant))
        };
        let Some(pipeline) = pipeline else { return };
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

    /// Draws the ports of every row of mark `i`, `shown`, where its rows have them: after its rows, and
    /// again after the rows its focus lights, which they sit on.
    fn ports(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        i: usize,
        shown: &super::marks::Shown,
    ) {
        let ports = shown.port_count();
        if ports == 0 || !shown.compiled.as_ref().is_some_and(|c| c.drawing.primitive == Primitive::Points) {
            return;
        }
        let group = &self.passes.iter().find(|(s, _)| *s == Shader::PointsPorts).expect("listed").1;
        pass.set_bind_group(1, &self.groups.mark, &[offset(i)]);
        pass.set_pipeline(&inner.pipelines.render(self.device, Shader::PointsPorts, self.format, self.samples));
        pass.set_bind_group(2, group, &[]);
        drawn.draw(pass, 4, (shown.rows + shown.exits) * ports);
    }
}

/// What a frame's compute pass does.
struct Work {
    evaluated: Vec<usize>,
    /// Marks whose ease pass writes what they show from their frozen and settled state.
    eased: Vec<usize>,
    segments: Vec<usize>,
    faces: Vec<usize>,
    measured: Vec<usize>,
    /// Marks whose comets carry their travel over to rows a transition moved, and that travel.
    carried: Vec<usize>,
    travelled: Vec<usize>,
    /// Marks whose drawn rows' words are expanded from their runs again.
    expanded: Vec<usize>,
}

/// Dispatches a workgroup for every `WORKGROUP` of `items`, if there are any; past one dimension's
/// workgroups, runs of `DISPATCH_ROWS` items along the second, as `item` in `lib/types.wesl` reads
/// them.
pub(super) fn dispatch(pass: &mut wgpu::ComputePass<'_>, items: u32) {
    let groups = items.div_ceil(WORKGROUP);
    if groups > MAX_GROUPS {
        pass.dispatch_workgroups(wgsl::DISPATCH_ROWS / WORKGROUP, items.div_ceil(wgsl::DISPATCH_ROWS), 1);
    } else if groups > 0 {
        pass.dispatch_workgroups(groups, 1, 1);
    }
}

/// Dispatches over `blocks` listed row blocks of a mark of `rows` held rows: a block's rows wide.
fn dispatch_blocks(pass: &mut wgpu::ComputePass<'_>, rows: u32, blocks: u32) {
    let wide = rows.min(wgsl::PAGE_ROWS).div_ceil(WORKGROUP);
    if wide > 0 && blocks > 0 {
        pass.dispatch_workgroups(wide, blocks, 1);
    }
}

/// Mark `index`'s dynamic offset in the marks' uniforms.
pub(super) fn offset(index: usize) -> u32 {
    (index as u64 * MARK_STRIDE) as u32
}

/// `input`'s least and greatest value over `rows`, as `lib/reduce.wesl` keeps them: the complement
/// of the least's ordered bits, then the greatest's; nothing where no row has one.
fn fit(rows: &Rows<'_>, input: &crate::Expr) -> [u32; 2] {
    let ordered = |x: f32| {
        let b = x.to_bits();
        if b & 0x8000_0000 != 0 { !b } else { b | 0x8000_0000 }
    };
    let (mut least, mut most) = (f32::INFINITY, f32::NEG_INFINITY);
    for x in rows.numbers(input, |v| v as f32) {
        if x.is_finite() {
            (least, most) = (least.min(x), most.max(x));
        }
    }
    if least > most { [0, 0] } else { [!ordered(least), ordered(most)] }
}

impl super::marks::Shown {
    /// Whether its fitted domains fit over every row of the table it draws in part, on the CPU: it
    /// draws a table in part, and they read only its own data, nothing the view shows or derives.
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

    /// Segments of each row's path, for strokes whose rows all have as many.
    pub(crate) fn segments_per_row(&self) -> u32 {
        if self.compiled.is_none() {
            return 0;
        }
        match self.kind() {
            // A trace's points count the corners steps make.
            MarkKind::Lines => self.tables.traced().saturating_sub(1),
            _ => 1,
        }
    }

    /// Instances its primitive draws: rows and exits, or every segment of their paths; at most what
    /// its segment list keeps.
    pub(crate) fn instances(&self) -> u32 {
        if let Some(list) = &self.segments.list {
            return list.kept;
        }
        let rows = self.rows + self.exits;
        match self.compiled.as_ref().map(|c| c.drawing.primitive) {
            Some(Primitive::Strokes) => rows * self.segments_per_row(),
            Some(_) => rows,
            None => 0,
        }
    }

    /// Instances a probe or a measure reaches: live rows and their ports only.
    pub(crate) fn live_instances(&self) -> u32 {
        if let Some(list) = &self.segments.list {
            return list.kept;
        }
        match self.compiled.as_ref().map(|c| c.drawing.primitive) {
            Some(Primitive::Strokes) => self.rows * self.segments_per_row(),
            Some(Primitive::Points) => self.rows * (1 + self.port_count()),
            Some(_) => self.rows,
            None => 0,
        }
    }

    /// The code of the primitive it draws.
    pub(crate) fn primitive(&self) -> u32 {
        self.compiled.as_ref().map_or(0, |c| c.drawing.primitive.code())
    }

    /// Records the draw of its instances: as many as its segment list holds, when it has one.
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
    /// Evaluates the dirty channels of marks `work`, each over its dirty pages of rows, its fitted
    /// domains reduced first where they changed: into its state, or while it eases into its settled
    /// words. `state` is the expression machine's pass group.
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
            pass.set_pipeline(&inner.pipelines.compute_pipeline(device, Variant::channels(shown.reads())));
            pass.set_bind_group(1, group, &[offset(i)]);
            let rows = shown.live();
            // A domain changing evaluates every block, so the reductions run over the blocks listed;
            // a table drawn in part fits domains reading only its data on the CPU, over every row.
            if shown.reduce && rows > 0 && !shown.fits_data() {
                debug_assert_eq!(shown.blocks, super::marks::Blocks::All, "a domain changing changes every row");
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
        }
        pass.set_bind_group(2, state, &[step(wgsl::STEP_CHANNELS)]);
    }

    /// Evaluates dirty channels, and sums face normals when what they rest on changed; with
    /// `measure`, also measures every measured mark's extents and reads them back. With `travel`,
    /// comets travel on by the frame's step.
    pub(super) fn compute(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        measure: bool,
        travel: bool,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let Work { evaluated: work, eased, segments, faces, measured, carried, travelled, expanded } =
            self.work(measure, travel);
        let all = [&work, &eased, &segments, &faces, &measured, &carried, &travelled, &expanded];
        if all.iter().all(|marks| marks.is_empty()) {
            return None;
        }
        // Domains a table drawn in part fits over all its rows, on the CPU; the GPU fits the rest.
        let mut fitted: Vec<(usize, Vec<u32>)> = Vec::new();
        for &i in &work {
            if self.marks[i].reduce && self.marks[i].fits_data() {
                fitted.push((i, self.data_domains(i)));
            }
        }
        let resources = self.resources.as_mut().expect("created before passes");
        for &i in &work {
            let shown = &self.marks[i];
            if !shown.reduce {
                continue;
            }
            let at = u64::from(shown.domains) * 8;
            match fitted.iter().find(|(m, _)| *m == i) {
                Some((_, words)) => gpu.0.queue.write_buffer(resources.domains(), at, bytemuck::cast_slice(words)),
                None => encoder.clear_buffer(resources.domains(), at, Some(u64::from(shown.reductions()) * 8)),
            }
        }
        let extent_bytes = self.marks.len() as u64 * u64::from(wgsl::EXTENT_WORDS) * 4;
        if !measured.is_empty() {
            encoder.clear_buffer(resources.extents(), 0, Some(extent_bytes));
        }
        inner.arena.written();
        if !faces.is_empty() {
            // Faces sum their normals afresh into the pages of the vertex marks they attach to.
            let words = u64::from(wgsl::PAGE_ROWS * wgsl::NORMAL_WORDS) * 4;
            for shown in &self.marks {
                for &block in shown.words.pages(Kept::Normals).blocks.iter() {
                    encoder.clear_buffer(inner.arena.buffer(), u64::from(block) * 4, Some(words));
                }
            }
        }
        let groups = resources.groups(&gpu.0, inner);
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
                bytemuck::cast_slice(&list.header_words(self.marks[i].corners())),
            );
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit compute"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            // Each drawn row's word first: every pass after reads it.
            if let Some(group) = &lists_group {
                pass.set_bind_group(2, group, &[]);
                self.expand_runs(&mut pass, inner, &groups.mark, &expanded);
            }
            pass.set_bind_group(2, &evaluate_group, &[super::resources::step(wgsl::STEP_CHANNELS)]);
            self.every_row(&mut pass, inner, &groups.mark, "carry", &carried);
            self.evaluate(&mut pass, inner, &groups.mark, &evaluate_group, &work);
            // After evaluating, so what a mark shows eases toward what it evaluated this frame.
            self.every_row(&mut pass, inner, &groups.mark, "ease", &eased);
            // After evaluating, so comets travel at the flow this frame shows.
            self.every_row(&mut pass, inner, &groups.mark, "travel", &travelled);
            if let Some(group) = &lists_group {
                pass.set_bind_group(2, group, &[]);
                self.count_segments(&mut pass, inner, &groups.mark, &segments);
            }
            if let Some(group) = &normals_group {
                pass.set_pipeline(&inner.pipelines.compute(device, Shader::Normals, "accumulate"));
                pass.set_bind_group(2, group, &[]);
                for &i in &faces {
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    dispatch(&mut pass, self.marks[i].rows);
                }
            }
            if let Some(group) = &bounds_group {
                pass.set_bind_group(2, group, &[]);
                for &i in &measured {
                    let entry = match self.marks[i].kind() {
                        MarkKind::Vertices => "points",
                        MarkKind::Areas => "areas",
                        _ => "strokes",
                    };
                    let variant = Variant::compute(Shader::Bounds, entry).path(self.marks[i].path());
                    pass.set_pipeline(&inner.pipelines.compute_pipeline(device, variant));
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

    /// What this frame's compute pass does: the marks it evaluates, the segment lists it counts, the
    /// faces whose normals it sums, the marks it measures, and with `travel` the marks whose comets
    /// travel.
    fn work(&mut self, measure: bool, travel: bool) -> Work {
        for shown in &mut self.marks {
            // A mark without rows has nothing to evaluate.
            if shown.held() == 0 && shown.tables.synced() {
                shown.dirty = 0;
                shown.reduce = false;
            }
        }
        let work: Vec<usize> = (0..self.marks.len())
            .filter(|&i| self.marks[i].drawable() && (self.marks[i].dirty != 0 || self.marks[i].reduce))
            .collect();
        for &i in &work {
            let shown = &mut self.marks[i];
            shown.version += 1;
            if shown.dirty & shown.placing_channels() != 0 {
                shown.place_version += 1;
            }
        }
        // A mark easing toward a change writes what it shows as the clock moves, and as it evaluates.
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
        Work { evaluated: work, eased, segments, faces, measured, carried, travelled, expanded }
    }

    /// Lists the row blocks each mark evaluates this frame where its uniform finds them: every block of
    /// a mark some channel of which changed for every row, else the blocks of the pages that changed.
    pub(super) fn lay_out_blocks(&mut self) {
        let mut words = Vec::new();
        for shown in &mut self.marks {
            let evaluates = shown.drawable() && (shown.dirty != 0 || shown.reduce);
            let blocks = if evaluates { shown.blocks.of(shown.live()) } else { Vec::new() };
            shown.block = words.len() as u32;
            shown.block_count = blocks.len() as u32;
            words.extend(blocks);
        }
        let gpu = self.gpu.clone();
        let resources = self.resources.as_mut().expect("created before passes");
        resources.write_blocks(&gpu.0.device, &gpu.0.queue, &words);
    }

    /// Writes each drawn row's word of each of `marks`, those that left included, from its runs.
    fn expand_runs(
        &self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        mark: &wgpu::BindGroup,
        marks: &[usize],
    ) {
        if marks.is_empty() {
            return;
        }
        pass.set_pipeline(&inner.pipelines.compute(&self.gpu.0.device, Shader::Lists, "expand_runs"));
        for &i in marks {
            pass.set_bind_group(1, mark, &[offset(i)]);
            dispatch(pass, self.marks[i].rows + self.marks[i].exits);
        }
    }

    /// Runs the expression machine's entry point `entry` over every held row of each of `marks`, those
    /// that left included.
    fn every_row(
        &self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        mark: &wgpu::BindGroup,
        entry: &'static str,
        marks: &[usize],
    ) {
        if marks.is_empty() {
            return;
        }
        pass.set_pipeline(&inner.pipelines.compute(&self.gpu.0.device, Shader::Evaluate, entry));
        for &i in marks {
            pass.set_bind_group(1, mark, &[offset(i)]);
            dispatch(pass, self.marks[i].held());
        }
    }

    /// Records the count → scan → write of each of `marks`' segment lists.
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
            let path = self.marks[i].path();
            pass.set_bind_group(1, mark, &[offset(i)]);
            let count = Variant::compute(Shader::Lists, "count_segments").path(path);
            pass.set_pipeline(&inner.pipelines.compute_pipeline(device, count));
            dispatch(pass, items);
            super::lists::scan(pass, &mut inner.pipelines, device, items);
            let write = Variant::compute(Shader::Lists, "write_segments").path(path);
            pass.set_pipeline(&inner.pipelines.compute_pipeline(device, write));
            dispatch(pass, items);
        }
    }

    /// The words of mark `i`'s fitted domains as `lib/reduce.wesl` keeps them, each fitted over every
    /// row of the table it draws in part, so a domain stays put however little of the table the
    /// camera shows. Each is kept by what it read: a camera move fits none again.
    fn data_domains(&mut self, i: usize) -> Vec<u32> {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return Vec::new() };
        let program = &compiled.program;
        let style = shown.mark.style();
        let table = self.source(&style.data).and_then(|d| Some((d, d.table(&style.table)?)));
        let Some((data, table)) = table else { return vec![0; 2 * program.domains.len()] };
        let source = Source { data, table, derived: self.derived.beside(&style.data, &style.table), paged: Vec::new() };
        let rows = Rows::new(table, &self.sources).at(self.at);
        let mut fitted = Vec::with_capacity(program.domains.len());
        for (d, (reads, input)) in program.domains.iter().zip(&program.fitted).enumerate() {
            let versions: Vec<Option<crate::data::Version>> = (0..program.columns.len())
                .filter(|&c| reads.columns & Reads::column(c) != 0)
                .map(|c| {
                    let column = &program.columns[c];
                    table_of(column, &source, &self.sources)?.1.field_named(&column.name).map(Field::version)
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

    /// Whether face normals must be summed again: a face mark or a vertex mark wrote its state since
    /// they were, or the globe turned under them.
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

    /// Draws the backdrop, every drawable mark in scene order, then `sprites` overlay sprites, counted
    /// in `drawn`, once the text set this frame has its fields. Depth is kept when `probing` reads it.
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
        pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
        pass.set_bind_group(1, &groups.mark, &[0]);
        pass.set_pipeline(&inner.pipelines.render(device, Shader::Backdrop, frame.format, samples));
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
        // The rows focus lights draw again over every mark but labels, glowing: nothing covers them but
        // the ports they carry. They draw once what draws them compiled.
        for (i, shown) in self.marks.iter().enumerate() {
            if self.answers() && shown.drawable() && shown.lit.rows > 0 {
                marks.draw(&mut pass, drawn, inner, i, shown, true);
                marks.ports(&mut pass, drawn, inner, i, shown);
            }
        }
        if !texts {
            return;
        }
        let glyphs = [Shader::Glyphs, Shader::GlyphsPorts].map(|shader| (shader, group(shader)));
        self.draw_labels(&mut pass, drawn, inner, frame.format, samples, &groups, glyphs);
        if sprites > 0 {
            pass.set_pipeline(&inner.pipelines.render(device, Shader::Overlay, frame.format, samples));
            pass.set_bind_group(2, group(Shader::Overlay), &[]);
            drawn.draw(&mut pass, 4, sprites);
        }
    }

    /// Finds the row nearest the probe among what the frame drew, and the nearest depth drawn there,
    /// and reads them back.
    pub(super) fn probe(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> Readback {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let probed: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].probed()).collect();
        // Every mark drawn has its probe program, which reads the depth under the probe as well as any.
        let under = self.marks.iter().position(super::marks::Shown::drawable);
        let resources = self.resources.as_mut().expect("created before passes");
        let shader = crate::gpu::pipelines::probe(resources.samples());
        let mut reset = [0_u32; wgsl::PROBE_WORDS as usize];
        reset[wgsl::PROBE_KEY as usize] = wgsl::NONE;
        gpu.0.queue.write_buffer(resources.probe(), 0, bytemuck::cast_slice(&reset));
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, shader);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit probe"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            // Each step over every mark before the next: the nearest key, then its topmost instance,
            // then where that lies.
            for step in [wgsl::STEP_NEAREST, wgsl::STEP_TOPMOST, wgsl::STEP_DESCRIBE] {
                pass.set_bind_group(2, &group, &[super::resources::step(step)]);
                for &i in &probed {
                    self.probe_step(&mut pass, inner, shader, &groups.mark, i, step);
                }
            }
            if let Some(i) = under {
                pass.set_bind_group(2, &group, &[super::resources::step(wgsl::STEP_UNDER)]);
                self.probe_step(&mut pass, inner, shader, &groups.mark, i, wgsl::STEP_UNDER);
            }
        }
        let resources = self.resources.as_ref().expect("created before passes");
        Readback::new(
            &inner.readbacks,
            device,
            encoder,
            resources.probe(),
            0,
            u64::from(wgsl::PROBE_WORDS) * 4,
            &self.waker,
        )
    }

    /// Records step `step` of mark `i`'s probe program, `shader`, the step's pass group bound: over
    /// every instance it reaches, or once for a step that reads one thing.
    pub(super) fn probe_step(
        &self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        shader: Shader,
        mark: &wgpu::BindGroup,
        i: usize,
        step: u32,
    ) {
        let shown = &self.marks[i];
        let variant = Variant::probe(shader, shown.primitive()).path(shown.path());
        pass.set_pipeline(&inner.pipelines.compute_pipeline(&self.gpu.0.device, variant));
        pass.set_bind_group(1, mark, &[offset(i)]);
        if matches!(step, wgsl::STEP_DESCRIBE | wgsl::STEP_LOCATE | wgsl::STEP_UNDER) {
            pass.dispatch_workgroups(1, 1, 1);
        } else {
            dispatch(pass, shown.live_instances());
        }
    }
}
