//! A frame's GPU passes.
//!
//! Raster passes freeze the rows' current state for transitions starting this frame, expands
//! paged marks' drawn rows from their runs, evaluates dirty channels over the changed row blocks
//! (reducing fitted domains first), resolves endpoints, eases marks in transition, moves comets,
//! number segments, sort rows by height, and measure
//! extents when asked.
//!
//! The render pass draws the backdrop and a plot's grid lines, then every mark's primitive in scene
//! order with depth, then the labels and the rest of the overlay. A pending probe then
//! reads what the frame drew, through the same geometry.

use std::ops::Range;

use super::resources::MARK_STRIDE;
use super::sync::Source;
use super::variants::{Draw, MarkVariants, Stage};
use super::{Frame, View};
use crate::data::Field;
use crate::derive::stamp_of;
use crate::expr::compile::{Deps, Reads};
use crate::expr::cpu::Rows;
use crate::gpu::Inner;
use crate::gpu::pipelines::{Asked, Projection, Variant};
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::{MarkKind, Primitive};

/// The scissor rectangle `[x, y, width, height]`, in target pixels, covering `area`.
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
        self.draw_range(pass, corners, 0..instances);
    }

    /// Draws and counts instances `instances` of `corners` vertices each.
    pub(super) fn draw_range(&mut self, pass: &mut wgpu::RenderPass<'_>, corners: u32, instances: Range<u32>) {
        self.count(instances.len() as u32);
        pass.draw(0..corners, instances);
    }

    fn count(&mut self, instances: u32) {
        self.draws += 1;
        self.instances += u64::from(instances);
    }
}

/// State that every mark's draw in the main pass shares: the device and target, the bind groups,
/// the lists buffer, and the plot area that lines clip to.
#[derive(Clone, Copy)]
struct Marks<'a> {
    space: &'a crate::Space,
    device: &'a wgpu::Device,
    format: wgpu::TextureFormat,
    samples: u32,
    groups: &'a super::resources::Groups,
    passes: &'a [(Shader, wgpu::BindGroup)],
    /// The number of marks, after whose uniforms come their copies for opaque draws.
    count: usize,
}

impl Marks<'_> {
    fn backdrop(&self, pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, inner: &mut Inner) {
        let variant = Variant::draw(Shader::Backdrop, self.format, self.samples).projection(Projection::of(self.space));
        let group = &self.passes.iter().find(|(shader, _)| *shader == Shader::Backdrop).expect("listed").1;
        pass.set_bind_group(0, &self.groups.view, &[]);
        pass.set_bind_group(1, &self.groups.mark, &[0]);
        pass.set_bind_group(2, group, &[]);
        pass.set_pipeline(&inner.pipelines.render(self.device, variant));
        drawn.draw(pass, 3, 1);
    }

    fn opaque(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        marks: &[super::marks::Shown],
    ) {
        for (i, shown) in marks.iter().enumerate() {
            if shown.drawable() && shown.instances() > 0 {
                self.draw(pass, drawn, inner, i, shown, Draw::Opaque);
            }
        }
    }

    /// Draws mark `i`: every instance, only the rows its focus lights, glowing, or every
    /// instance's opaque pixels.
    fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        i: usize,
        shown: &super::marks::Shown,
        draw: Draw,
    ) {
        if shown.compiled.is_none() {
            return;
        }
        let variants = MarkVariants::shown(shown, self.space);
        let shader = variants.shader(draw);
        let asked = variants.draw(draw, self.format, self.samples);
        let pipeline = match asked {
            Asked::Shader(variant) => Some(inner.pipelines.render(self.device, variant)),
            Asked::Hooked(hooks, variant) => inner.pipelines.hooked(self.device, &hooks, variant),
            Asked::Kernel(source, variant) => Some(inner.pipelines.kernel(self.device, &source, variant)),
        };
        let Some(pipeline) = pipeline else { return };
        let corners = shown.kind().primitive().corners();
        let group = &self.passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        // An opaque draw shares the rows' program and binds the copy of the uniform that says so.
        let at = if draw == Draw::Opaque { self.count + i } else { i };
        pass.set_bind_group(1, &self.groups.mark, &[offset(at)]);
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(2, group, &[]);
        if draw == Draw::Lit {
            drawn.draw(pass, corners, shown.lit.rows * shown.lit.pieces);
        } else {
            shown.record(pass, drawn, corners);
        }
    }
}

/// The marks each step of a frame's raster preparation covers.
struct Work {
    /// Marks whose transitions start this frame, freezing their rows' current state.
    frozen: Vec<usize>,
    evaluated: Vec<usize>,
    /// Marks whose rows resolve changed endpoints.
    resolved: Vec<usize>,
    /// Marks whose ease pass writes their shown state from their frozen and settled words.
    eased: Vec<usize>,
    segments: Vec<usize>,
    measured: Vec<usize>,
    /// Marks whose comets carry their travel over to rows a transition moved. `travelled` lists
    /// marks whose comets move this frame.
    carried: Vec<usize>,
    travelled: Vec<usize>,
    /// Marks whose drawn rows' words are rebuilt from their runs.
    expanded: Vec<usize>,
    /// Marks whose height orders sort.
    ordered: Vec<usize>,
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

/// Uniform `index`'s dynamic offset in the marks' uniforms: mark `index`'s, or past the last mark,
/// the copy for an opaque draw.
pub(super) fn offset(index: usize) -> u32 {
    (index as u64 * MARK_STRIDE) as u32
}

/// The minimum and maximum finite value of `input` over `rows`, encoded as `lib/reduce.wesl` keeps
/// them: the complement of the minimum's key, then the maximum's key. `[0, 0]` when no row has a
/// finite value.
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
        let count = compiled.program.domains.len();
        self.drawing().is_some() && count > 0 && (0..count).all(|d| self.reads_only_data(d))
    }

    /// Whether fitted domain `d` reads only the mark's data, nothing the view shows or derives, so
    /// the CPU can fit it over every row.
    pub(crate) fn reads_only_data(&self, d: usize) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        let program = &compiled.program;
        let Some(reads) = program.domains.get(d) else { return false };
        let viewed = Deps::TIME | Deps::POINTER | Deps::FOCUS | Deps::CAMERA | Deps::DOMAIN;
        let derived = program
            .columns
            .iter()
            .enumerate()
            .any(|(c, column)| column.derived && reads.columns & Reads::column(c) != 0);
        !reads.deps.intersects(viewed) && !derived
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

    /// Instances that probes and measures cover: live rows, not exits.
    pub(crate) fn live_instances(&self) -> u32 {
        if let Some(list) = &self.segments.list {
            return list.kept;
        }
        match self.compiled.as_ref().map(|_| self.kind().primitive()) {
            Some(Primitive::Strokes) => self.rows * self.segments_per_row(),
            Some(_) => self.rows,
            None => 0,
        }
    }

    /// A current count trims draws and queries recorded after list preparation. Earlier
    /// reservations keep their capacity because preparation can invalidate the previous count.
    pub(super) fn counted_instances(&self, capacity: u32) -> u32 {
        let segments = &self.segments;
        if segments.list.is_some() && segments.built != 0 && segments.found.stamp() == segments.built {
            capacity.min(segments.found.value)
        } else if segments.list.is_some() && !self.curved() {
            capacity.min(self.segment_capacity())
        } else {
            capacity
        }
    }

    /// Records a bounded instance draw. Listed shaders reject the unused tail before geometry reads.
    pub(super) fn record(&self, pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, corners: u32) {
        drawn.draw(pass, corners, self.counted_instances(self.instances()));
    }
}

impl View {
    /// Records row preparation: transition snapshots, changed channels, endpoint resolution,
    /// segment lists, and height order. Extents and their readback are included when requested.
    /// Only a frame taking `input` waits to sort heights again (see `View::height_orders_due`).
    pub(super) fn prepare_rows(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        measure: bool,
        travel: bool,
        input: bool,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let Work {
            frozen,
            evaluated: work,
            resolved,
            eased,
            segments,
            measured,
            carried,
            travelled,
            expanded,
            ordered,
        } = self.work(measure, travel, input);
        let all = [&frozen, &work, &resolved, &eased, &segments, &measured, &carried, &travelled, &expanded, &ordered];
        if all.iter().all(|marks| marks.is_empty()) {
            return None;
        }
        self.start_domains(&work);
        inner.arena.written();
        self.state_rows(encoder, inner, "freeze", &frozen);
        self.state_rows(encoder, inner, "carry", &carried);
        self.state_rows(encoder, inner, "evaluate", &work);
        self.state_rows(encoder, inner, "ends", &resolved);
        self.state_rows(encoder, inner, "ease", &eased);
        self.state_rows(encoder, inner, "travel", &travelled);
        self.record_lists(encoder, inner, &expanded, &segments, &ordered);
        let resources = self.resources.as_mut().expect("frame resources");
        let extent_words = self.marks.len() as u32 * wgsl::EXTENT_WORDS;
        let groups = resources.groups(&gpu.0, inner);
        if !measured.is_empty() {
            use crate::gpu::raster::{At, Raster};
            let mut raster = Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
            raster.fill(inner.arena.words(), At::new(resources.extents(), 0), extent_words, 0);
            for &i in &measured {
                let shown = &self.marks[i];
                let Some(variant) = MarkVariants::shown(shown, &self.scene.space).bounds() else { continue };
                let input = crate::gpu::listing::Inputs {
                    pages: inner.arena.words(),
                    lists: resources.lists(),
                    view: &groups.view,
                    mark: &groups.mark,
                    offset: offset(i),
                    path: shown.path(),
                    projection: Projection::of(&self.scene.space),
                    measured: shown.measures_paths(),
                };
                inner.bounds.record(
                    &mut raster,
                    &input,
                    variant,
                    shown.live_instances(),
                    At::new(resources.extents(), i as u32 * wgsl::EXTENT_WORDS),
                );
            }
        }
        let resources = self.resources.as_ref().expect("frame resources");
        (!measured.is_empty()).then(|| {
            Readback::words(&inner.readbacks, device, encoder, resources.extents(), 0, extent_words, &self.waker)
        })
    }

    /// Prepares the fitted domains that marks `work` reduce. Domains computed on the CPU over a
    /// paged table's rows are written. The rest are cleared for the GPU to fit.
    fn start_domains(&mut self, work: &[usize]) {
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
            if let Some((_, words)) = fitted.iter().find(|(m, _)| *m == i) {
                resources.domains().write_padded(&self.gpu.0.queue, shown.domains * 2, words);
            }
        }
    }

    /// Chooses the marks each raster step covers this frame: freezing, evaluation, endpoint
    /// resolution, easing, segment counting, measuring, comet carry, run expansion,
    /// height order sorting, and with `travel`, comet travel.
    fn work(&mut self, measure: bool, travel: bool, input: bool) -> Work {
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
        let measured = (0..self.marks.len())
            .filter(|&i| measure && self.marks[i].drawable() && self.marks[i].measured())
            .collect();
        let flowing = |i: &usize| self.marks[*i].drawable() && self.marks[*i].mark.flows();
        let carried = (0..self.marks.len()).filter(|i| self.marks[*i].carry && flowing(i)).collect();
        let travelled = (0..self.marks.len()).filter(|i| travel && flowing(i)).collect();
        let expanded = self.drawn_rows_due();
        // After the versions above move and the segment lists are stamped.
        let ordered = self.height_orders_due(input);
        Work { frozen, evaluated: work, resolved, eased, segments, measured, carried, travelled, expanded, ordered }
    }

    /// Writes the blocks buffer, which each mark's uniform points into. For each mark, it lists the
    /// row blocks it evaluates this frame (every block when a channel changed for every row,
    /// otherwise the changed pages), then the row blocks whose endpoints it resolves.
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

    /// The words of mark `i`'s fitted domains, as `lib/reduce.wesl` keeps them, each computed on
    /// the CPU over every row of its paged table. So a domain stays fixed however little of the
    /// table the camera shows. Each is cached by the stamp of its inputs, so a camera move refits
    /// none.
    fn data_domains(&mut self, i: usize) -> Vec<u32> {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return Vec::new() };
        let count = compiled.program.domains.len();
        let fitted: Vec<(u64, [u32; 2])> =
            (0..count).map(|d| self.domain_on_cpu(i, d, shown.fitted.get(d).copied()).unwrap_or((0, [0, 0]))).collect();
        let words = fitted.iter().flat_map(|(_, w)| *w).collect();
        self.marks[i].fitted = fitted;
        words
    }

    /// Fitted domain `d` of mark `i`, computed on the CPU over every row of its table, as
    /// `lib/reduce.wesl` keeps it, with the stamp of its inputs. `kept` is the last such fit, which
    /// is reused while the stamp holds. `None` while the mark's table is missing.
    pub(super) fn domain_on_cpu(&self, i: usize, d: usize, kept: Option<(u64, [u32; 2])>) -> Option<(u64, [u32; 2])> {
        let shown = &self.marks[i];
        let program = &shown.compiled.as_ref()?.program;
        let (reads, input) = (program.domains.get(d)?, program.fitted.get(d)?);
        let source = Source::of(shown.mark.style(), &self.snapshots, &self.derived)?;
        let table = source.table;
        let versions: Vec<Option<crate::data::Version>> = (0..program.columns.len())
            .filter(|&c| reads.columns & Reads::column(c) != 0)
            .map(|c| {
                let column = &program.columns[c];
                source.table_of(column, &self.snapshots)?.1.field_named(&column.name).map(Field::version)
            })
            .collect();
        let sampled = reads.deps.intersects(Deps::SAMPLES).then_some(self.at.to_bits());
        let stamp = stamp_of((versions, table.structure, sampled));
        match kept {
            Some((at, words)) if at == stamp => Some((stamp, words)),
            _ => Some((stamp, fit(&Rows::new(table, &self.snapshots).at(self.at), input))),
        }
    }

    /// Records the main render pass, counting draws in `drawn`: the backdrop, every drawable mark
    /// in scene order, and the lit rows. Once the text pipelines are ready, it also builds the
    /// distance fields of text set this frame, and draws the labels and the overlay's
    /// `[under, sprites]` sprites, the first `under` before the marks. Depth is stored when
    /// `probing` reads it. While the camera is unplaced, it only clears.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        drawn: &mut Drawn,
        frame: &Frame<'_>,
        [under, sprites]: [u32; 2],
        probing: bool,
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let texts = self.can_use(Stage::Text);
        if texts {
            let Inner { atlas, pipelines, .. } = &mut *inner;
            atlas.lay(device, &gpu.0.queue, encoder, pipelines);
        }
        let background =
            if self.signal.transparent() { [0.0; 4] } else { self.scene.theme.background.to_array().map(f64::from) };
        let clip = self.drawn_area().map(|area| scissor(area, frame)).filter(|s| s[2] > 0 && s[3] > 0);
        let samples = gpu.samples_for(frame.pixel_ratio);
        let resources = self.resources.as_mut().expect("created before passes");
        let (color, depth) = resources.targets(device, frame.size, frame.format, samples);
        let groups = resources.groups(&gpu.0, inner);
        // The pass groups of the shaders this frame draws with, each built once per resource
        // generation: the backdrop, text, and overlay, and each mark's.
        let mut shaders = vec![Shader::Backdrop, Shader::Glyphs, Shader::Overlay];
        for shown in &self.marks {
            let variants = MarkVariants::shown(shown, &self.scene.space);
            for draw in [Draw::Rows, Draw::Lit] {
                let shader = variants.shader(draw);
                if !shaders.contains(&shader) {
                    shaders.push(shader);
                }
            }
        }
        let passes: Vec<(Shader, wgpu::BindGroup)> =
            shaders.into_iter().map(|shader| (shader, resources.pass(device, inner, shader))).collect();
        let pick_targets = (probing && samples > 1).then(|| resources.pick_targets(device));
        let group = |shader: Shader| &passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        let (view, resolve) = match &color {
            Some(color) => (color, Some(frame.target)),
            None => (frame.target, None),
        };
        let marks = Marks {
            space: &self.scene.space,
            device,
            format: frame.format,
            samples,
            groups: &groups,
            passes: &passes,
            count: self.marks.len(),
        };
        if let Some((pick_color, pick_depth)) = &pick_targets {
            let mut pass = main_pass(encoder, pick_color, None, pick_depth, [0.0; 4], true);
            if !self.unplaced() {
                let marks = Marks { samples: 1, ..marks };
                marks.backdrop(&mut pass, drawn, inner);
                if let Some([x, y, w, h]) = clip {
                    pass.set_scissor_rect(x, y, w, h);
                }
                if self.layered() {
                    marks.opaque(&mut pass, drawn, inner, &self.marks);
                }
            }
        }
        let mut pass = main_pass(encoder, view, resolve, &depth, background, probing);
        // Until a fit places the camera, frames show only the background.
        if self.unplaced() {
            return;
        }
        marks.backdrop(&mut pass, drawn, inner);
        let overlay = |pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, inner: &mut Inner, sprites: Range<u32>| {
            pass.set_pipeline(&inner.pipelines.render(device, Variant::draw(Shader::Overlay, frame.format, samples)));
            pass.set_bind_group(2, group(Shader::Overlay), &[]);
            drawn.draw_range(pass, 4, sprites);
        };
        if texts && under > 0 {
            overlay(&mut pass, drawn, inner, 0..under);
        }

        // Marks and their labels draw only where no guide on a side takes room.
        if let Some([x, y, w, h]) = clip {
            pass.set_scissor_rect(x, y, w, h);
        }
        // Where depth varies, opaque pixels draw first and keep their depth: those of points and
        // strokes, and areas whole. Every other pixel then blends over them in mark order,
        // only in front of what is drawn: antialiased edges, marks too thin to cover a pixel, and
        // translucent rows, such as those a selection dims. Within a mark whose rows stand at
        // different heights, they blend lowest first, which is farthest first where they overlap.
        // So the nearest opaque pixel shows whatever the order of the marks, a partly covered pixel
        // blends over what lies behind it, never over the background, and a nearer thin row blends
        // over the rows behind it.
        let layered = self.layered();
        if layered {
            marks.opaque(&mut pass, drawn, inner, &self.marks);
        }
        for (i, shown) in self.marks.iter().enumerate() {
            if !shown.drawable() || shown.instances() == 0 || (layered && shown.kind().opaque_whole()) {
                continue;
            }
            marks.draw(&mut pass, drawn, inner, i, shown, Draw::Rows);
        }
        // Lit rows draw again, glowing, over every mark but labels, and where depth varies, over all
        // but the opaque rows nearer than them. They draw once their pipelines have compiled.
        for (i, shown) in self.marks.iter().enumerate() {
            if self.can_use(Stage::Lit) && shown.drawable() && shown.lit.rows > 0 {
                marks.draw(&mut pass, drawn, inner, i, shown, Draw::Lit);
            }
        }
        if !texts {
            return;
        }
        self.draw_labels(&mut pass, drawn, inner, frame.format, samples, &groups, group(Shader::Glyphs));
        if clip.is_some() {
            pass.set_scissor_rect(0, 0, frame.size[0], frame.size[1]);
        }
        if sprites > under {
            overlay(&mut pass, drawn, inner, under..sprites);
        }
    }

    /// Reduce candidate priorities on the GPU, then describe the selected row and depth.
    pub(super) fn probe(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> Readback {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before probes");
        let groups = resources.groups(&gpu.0, inner);
        let input = |i: usize| crate::gpu::probing::ProbeInputs {
            geometry: crate::gpu::listing::Inputs {
                pages: inner.arena.words(),
                lists: resources.lists(),
                view: &groups.view,
                mark: &groups.mark,
                offset: offset(i),
                path: self.marks[i].path(),
                projection: Projection::of(&self.scene.space),
                measured: self.marks[i].measures_paths(),
            },
            depth: resources.pick_depth(),
            output: resources.probe(),
            variant: MarkVariants::shown(&self.marks[i], &self.scene.space).probe(Shader::Probe),
        };
        let mut raster =
            crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
        inner.probing.begin(&mut raster, self.marks.len() as u32);
        for (i, shown) in self.marks.iter().enumerate().filter(|(_, m)| m.probed()) {
            inner.probing.nearest(&mut raster, &input(i), shown.counted_instances(shown.live_instances()), i as u32);
        }
        if let Some(i) = self.marks.iter().position(super::marks::Shown::drawable) {
            inner.probing.finish(&mut raster, &input(i), self.marks.len() as u32);
        } else {
            let mut reset = [0_u32; wgsl::PROBE_WORDS as usize];
            reset[wgsl::PROBE_KEY as usize] = wgsl::NONE;
            resources.probe().write(&gpu.0.queue, 0, &reset);
        }
        Readback::words(&inner.readbacks, device, encoder, resources.probe(), 0, wgsl::PROBE_WORDS, &self.waker)
    }

    pub(super) fn probe_pass(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        kind: super::query::Kind,
        marks: &[(usize, u32, u32)],
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before queries");
        if resources.samples() > 1 {
            resources.pick_targets(device);
        }
        let groups = resources.groups(&gpu.0, inner);
        let mut raster =
            crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
        for &(i, room, at) in marks {
            let shown = &self.marks[i];
            let input = crate::gpu::probing::ProbeInputs {
                geometry: crate::gpu::listing::Inputs {
                    pages: inner.arena.words(),
                    lists: resources.lists(),
                    view: &groups.view,
                    mark: &groups.mark,
                    offset: offset(i),
                    path: shown.path(),
                    projection: Projection::of(&self.scene.space),
                    measured: shown.measures_paths(),
                },
                depth: resources.pick_depth(),
                output: resources.probe(),
                variant: MarkVariants::shown(shown, &self.scene.space).probe(Shader::Probe),
            };
            let instances = shown.counted_instances(shown.live_instances());
            match kind {
                super::query::Kind::Hits => inner.probing.hits(&mut raster, &input, instances, room, at),
                super::query::Kind::Boxed => {
                    inner.probing.boxed(&mut raster, &input, instances, shown.live(), at);
                }
                super::query::Kind::Locate => inner.probing.locate(&mut raster, &input),
            }
        }
    }
}
