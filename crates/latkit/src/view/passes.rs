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
use super::still::Cut;
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

/// The rectangle that scissor rectangles `a` and `b` share, empty when they share none.
fn overlap(a: [u32; 4], b: [u32; 4]) -> [u32; 4] {
    let (x, y) = (a[0].max(b[0]), a[1].max(b[1]));
    let (right, bottom) = ((a[0] + a[2]).min(b[0] + b[2]), (a[1] + a[3]).min(b[1] + b[3]));
    [x, y, right.saturating_sub(x), bottom.saturating_sub(y)]
}

/// Begins a render pass: cleared to `background`, drawn into `view` and resolved into `resolve`
/// when multisampling, with depth as `depth_ops` say.
fn main_pass<'e>(
    encoder: &'e mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    resolve: Option<&wgpu::TextureView>,
    depth: &wgpu::TextureView,
    background: [f64; 4],
    depth_ops: wgpu::Operations<f32>,
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
            depth_ops: Some(depth_ops),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

/// Depth that starts cleared, or as the pass before left it when `kept`, and is stored for what
/// reads it later when `stored`.
fn depth_ops(kept: bool, stored: bool) -> wgpu::Operations<f32> {
    wgpu::Operations {
        load: if kept { wgpu::LoadOp::Load } else { wgpu::LoadOp::Clear(0.0) },
        store: if stored { wgpu::StoreOp::Store } else { wgpu::StoreOp::Discard },
    }
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
    scene: &'a crate::Scene,
    device: &'a wgpu::Device,
    format: wgpu::TextureFormat,
    samples: u32,
    groups: &'a super::resources::Groups,
    passes: &'a [(Shader, wgpu::BindGroup)],
    /// The number of marks, after whose uniforms come their copies for opaque draws, then for
    /// comets draws.
    count: usize,
    /// Whether depth varies, so opaque pixels draw first.
    layered: bool,
    /// Where each mark's records start in the screen store, for a recorded stroke mark this frame
    /// draws, for its draws and for its lit draw (see [`View::place`]).
    firsts: &'a [Vec<Option<u32>>; 2],
}

impl Marks<'_> {
    /// Draws the backdrop: whole, or with `depth`, only its depth, under a still that holds its
    /// color.
    fn backdrop(&self, pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, inner: &mut Inner, depth: bool) {
        let draw = if depth { Draw::Depth } else { Draw::Rows };
        let variant = Variant::draw(Shader::Backdrop, self.format, self.samples)
            .mode(draw)
            .projection(Projection::of(&self.scene.space));
        let group = &self.passes.iter().find(|(shader, _)| *shader == Shader::Backdrop).expect("listed").1;
        pass.set_bind_group(0, &self.groups.view, &[]);
        pass.set_bind_group(1, &self.groups.mark, &[0]);
        pass.set_bind_group(2, group, &[]);
        pass.set_pipeline(&inner.pipelines.render(self.device, variant));
        drawn.draw(pass, 3, 1);
    }

    /// Draws the still over the whole target. It reads neither shared group, so the empty group
    /// stands in for both, and the shared groups are set again after it.
    fn still(&self, pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, inner: &mut Inner) {
        let group = &self.passes.iter().find(|(shader, _)| *shader == Shader::Still).expect("listed").1;
        pass.set_bind_group(0, &inner.pipelines.empty, &[]);
        pass.set_bind_group(1, &inner.pipelines.empty, &[]);
        pass.set_bind_group(2, group, &[]);
        pass.set_pipeline(
            &inner.pipelines.render(self.device, Variant::draw(Shader::Still, self.format, self.samples)),
        );
        drawn.draw(pass, 3, 1);
        pass.set_bind_group(0, &self.groups.view, &[]);
        pass.set_bind_group(1, &self.groups.mark, &[0]);
    }

    /// Draws the opaque pixels of marks `range`.
    fn opaque(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        marks: &[super::marks::Shown],
        range: Range<usize>,
    ) {
        for i in range {
            let shown = &marks[i];
            if shown.drawable() && shown.instances() > 0 {
                self.draw(pass, drawn, inner, i, shown, Draw::Opaque);
            }
        }
    }

    /// Draws the rows of marks `range` in order, each followed by its comets while `comets` says
    /// they show. Where depth varies, areas drew whole with the opaque pixels.
    fn rows(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        marks: &[super::marks::Shown],
        range: Range<usize>,
        comets: bool,
    ) {
        for i in range {
            let shown = &marks[i];
            if !shown.drawable() || shown.instances() == 0 {
                continue;
            }
            if !(self.layered && shown.kind().opaque_whole()) {
                self.draw(pass, drawn, inner, i, shown, Draw::Rows);
            }
            if comets && shown.mark.flows() {
                self.draw(pass, drawn, inner, i, shown, Draw::Comets);
            }
        }
    }

    /// Draws a frame that starts from the still at `cut`: the still, then within `clip` the comets
    /// of the mark whose rows it holds, then the marks after the cut, each with its comets. A still
    /// holding every opaque pixel keeps its depth. Otherwise depth starts over: on the globe, the
    /// backdrop draws its depth again under it, which elsewhere is the cleared depth, and the marks
    /// after the cut draw their opaque pixels. While comets rest from a camera that just moved
    /// (`comets` false, see `View::comets_travel`), they draw none.
    #[expect(clippy::too_many_arguments, reason = "a pass over the frame's shared state")]
    fn over_still(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        marks: &[super::marks::Shown],
        cut: Cut,
        comets: bool,
        clip: Option<[u32; 4]>,
    ) {
        if !cut.opaque && Projection::of(&self.scene.space) == Projection::Globe {
            self.backdrop(pass, drawn, inner, true);
        }
        self.still(pass, drawn, inner);
        if let Some([x, y, w, h]) = clip {
            pass.set_scissor_rect(x, y, w, h);
        }
        if self.layered && !cut.opaque {
            self.opaque(pass, drawn, inner, marks, cut.rows..marks.len());
        }
        if let Some(first) = cut.comets.filter(|_| comets) {
            self.draw(pass, drawn, inner, first, &marks[first], Draw::Comets);
        }
        self.rows(pass, drawn, inner, marks, cut.rows..marks.len(), comets);
    }

    /// Draws depth again at one sample a pixel into `targets`, over the scissor rectangle `read` a
    /// probe reads, where a frame multisamples: the backdrop's, and where depth varies, that of the
    /// opaque pixels of `marks` within `clip`.
    #[expect(clippy::too_many_arguments, reason = "a pass over the frame's shared state")]
    fn replay(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        (color, depth): &(wgpu::TextureView, wgpu::TextureView),
        read: [u32; 4],
        clip: Option<[u32; 4]>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        marks: &[super::marks::Shown],
    ) {
        let mut pass = main_pass(encoder, color, None, depth, [0.0; 4], depth_ops(false, true));
        let replayed = Marks { samples: 1, ..*self };
        let shows = |[_, _, w, h]: [u32; 4]| w > 0 && h > 0;
        if shows(read) {
            let [x, y, w, h] = read;
            pass.set_scissor_rect(x, y, w, h);
            replayed.backdrop(&mut pass, drawn, inner, false);
            let [x, y, w, h] = clip.map_or(read, |clip| overlap(clip, read));
            if self.layered && shows([x, y, w, h]) {
                pass.set_scissor_rect(x, y, w, h);
                replayed.opaque(&mut pass, drawn, inner, marks, 0..marks.len());
            }
        }
    }

    /// Draws mark `i`: every instance, only the rows its focus lights, glowing, every instance's
    /// opaque pixels, or every instance's comets.
    fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut Drawn,
        inner: &mut Inner,
        i: usize,
        shown: &super::marks::Shown,
        draw: Draw,
    ) {
        let Some(compiled) = &shown.compiled else { return };
        // A marker of none draws nothing: its rows show only their labels.
        if compiled.drawing.markers.marker == crate::gpu::shaders::MARKER_NONE {
            return;
        }
        let variants = MarkVariants::shown(shown, self.scene);
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
        // An opaque draw and a comets draw share the rows' program and bind the copy of the uniform
        // that says which they are.
        let at = match draw {
            Draw::Opaque => self.count + i,
            Draw::Comets => 2 * self.count + i,
            Draw::Rows | Draw::Lit | Draw::Depth => i,
        };
        pass.set_bind_group(1, &self.groups.mark, &[offset(at)]);
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(2, group, &[]);
        // A recorded mark's instances are numbered from its first record for the draw, which they
        // read. Other marks place their own instances, from 0.
        let first = match variants.screen() {
            Some(_) => self.firsts[usize::from(draw == Draw::Lit)][i].expect("a recorded mark draws only once placed"),
            None => 0,
        };
        // A comets draw with comet slots draws a slot an instance, each naming its record.
        if draw == Draw::Lit {
            drawn.draw_range(pass, corners, first..first + shown.lit.rows * shown.lit.pieces);
        } else if draw == Draw::Comets && shown.comets.list.is_some() {
            drawn.draw(pass, corners, shown.comets.drawn());
        } else {
            shown.record(pass, drawn, corners, first);
        }
    }
}

/// The marks each step of a frame's raster preparation covers.
pub(super) struct Work {
    /// Marks whose transitions start this frame, freezing their rows' current state.
    frozen: Vec<usize>,
    evaluated: Vec<usize>,
    /// Marks whose rows resolve changed endpoints.
    resolved: Vec<usize>,
    /// Marks whose ease pass writes their shown state from their frozen and settled words.
    eased: Vec<usize>,
    /// Marks whose segment lists build, and those whose lists only measure their distances along
    /// again on screen.
    segments: Vec<usize>,
    lengths: Vec<usize>,
    measured: Vec<usize>,
    /// Marks whose comets carry their travel over to rows a transition moved. `travelled` lists
    /// marks whose rows' travel catches up this frame.
    carried: Vec<usize>,
    travelled: Vec<usize>,
    /// Marks whose drawn rows' words are rebuilt from their runs.
    expanded: Vec<usize>,
    /// Marks whose height orders sort at once, and this frame's part of the background sort.
    ordered: Vec<usize>,
    sorting: Option<super::lists::SortStep>,
}

impl Work {
    /// Whether the work rewrites what mark `i` draws its rows from: its words, endpoints, or lists.
    /// Measuring draws nothing, travel moves only comets, and a background sort changes what a mark
    /// draws only when its order lands.
    pub(super) fn redraws(&self, i: usize) -> bool {
        self.sorting.is_some_and(|step| step.mark == i && step.lands)
            || [
                &self.frozen,
                &self.evaluated,
                &self.resolved,
                &self.eased,
                &self.segments,
                &self.lengths,
                &self.expanded,
                &self.ordered,
            ]
            .iter()
            .any(|marks| marks.contains(&i))
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

/// The shaders whose pass groups a frame binds, each group built once per resource generation: the
/// backdrop, text, and overlay, the still when the view keeps one, and each mark's.
fn pass_shaders(marks: &[super::marks::Shown], scene: &crate::Scene, still: bool) -> Vec<Shader> {
    let mut shaders = vec![Shader::Backdrop, Shader::Glyphs, Shader::Overlay];
    if still {
        shaders.push(Shader::Still);
    }
    for shown in marks {
        let variants = MarkVariants::shown(shown, scene);
        for draw in [Draw::Rows, Draw::Lit] {
            let shader = variants.shader(draw);
            if !shaders.contains(&shader) {
                shaders.push(shader);
            }
        }
    }
    shaders
}

/// Uniform `index`'s dynamic offset in the marks' uniforms: mark `index`'s, or past the last mark,
/// the copies for its opaque draw, then for its comets.
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

    /// Records a bounded instance draw, numbering its instances from `first`. Listed shaders reject
    /// the unused tail before geometry reads.
    pub(super) fn record(&self, pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, corners: u32, first: u32) {
        drawn.draw_range(pass, corners, first..first + self.counted_instances(self.instances()));
    }
}

impl View {
    /// Records row preparation, the frame's `work`: transition snapshots, changed channels,
    /// endpoint resolution, segment lists, and height order. Extents and their readback are
    /// included when the work measures.
    pub(super) fn prepare_rows(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        work: Work,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let Work {
            frozen,
            evaluated: work,
            resolved,
            eased,
            segments,
            lengths,
            measured,
            carried,
            travelled,
            expanded,
            ordered,
            sorting,
        } = work;
        let all = [
            &frozen, &work, &resolved, &eased, &segments, &lengths, &measured, &carried, &travelled, &expanded,
            &ordered,
        ];
        if all.iter().all(|marks| marks.is_empty()) && sorting.is_none() {
            return None;
        }
        self.start_domains(&work);
        inner.arena.written();
        // Comets catch up first, while their rows still hold the flows they traveled at.
        self.state_rows(encoder, inner, "travel", &travelled);
        self.state_rows(encoder, inner, "freeze", &frozen);
        self.state_rows(encoder, inner, "carry", &carried);
        self.state_rows(encoder, inner, "evaluate", &work);
        self.state_rows(encoder, inner, "ends", &resolved);
        self.state_rows(encoder, inner, "ease", &eased);
        self.record_lists(encoder, inner, &expanded, [&segments, &lengths], (&ordered, sorting));
        let resources = self.resources.as_mut().expect("frame resources");
        let extent_words = self.marks.len() as u32 * wgsl::EXTENT_WORDS;
        let groups = resources.groups(&gpu.0, inner);
        if !measured.is_empty() {
            use crate::gpu::raster::{At, Raster};
            let mut raster = Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
            raster.fill(inner.arena.words(), At::new(resources.extents(), 0), extent_words, 0);
            for &i in &measured {
                let shown = &self.marks[i];
                let Some(variant) = MarkVariants::shown(shown, &self.scene).bounds() else { continue };
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
    /// resolution, easing, segment counting and lengths, measuring with `measure`, comet carry, run
    /// expansion, height order sorting, and with `travel`, writing how far comets have traveled.
    /// Only a frame taking `input` sorts heights in the background (see `View::height_orders_due`).
    pub(super) fn work(&mut self, measure: bool, travel: bool, input: bool) -> Work {
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
        let lengths = self.lengths_due(&segments);
        let measured = (0..self.marks.len())
            .filter(|&i| measure && self.marks[i].drawable() && self.marks[i].measured())
            .collect();
        let flowing = |i: &usize| self.marks[*i].drawable() && self.marks[*i].mark.flows();
        let carried = (0..self.marks.len()).filter(|i| self.marks[*i].carry && flowing(i)).collect();
        let travelled = (0..self.marks.len()).filter(|i| travel && flowing(i)).collect();
        let expanded = self.drawn_rows_due();
        // After the versions above move and the segment lists are stamped.
        let (ordered, sorting) = self.height_orders_due(input);
        Work {
            frozen,
            evaluated: work,
            resolved,
            eased,
            segments,
            lengths,
            measured,
            carried,
            travelled,
            expanded,
            ordered,
            sorting,
        }
    }

    /// Writes the blocks buffer, which each mark's uniform points into. For each mark, it lists the
    /// row blocks it evaluates this frame (every block when a channel changed for every row,
    /// otherwise the changed pages), then the row blocks whose endpoints it resolves. A mark in a
    /// transition that eases only some blocks lists those, and the blocks it freezes, after them.
    pub(super) fn lay_out_blocks(&mut self) {
        let mut words = Vec::new();
        for shown in &mut self.marks {
            let evaluates = shown.drawable() && (shown.dirty != 0 || shown.reduce || !shown.fresh.is_empty());
            let blocks = if evaluates { listed(shown) } else { Vec::new() };
            shown.block = words.len() as u32;
            shown.block_count = blocks.len() as u32;
            // Rows that evaluate while a transition runs write its settled words, so it eases them.
            let every = (shown.dirty != 0 || shown.reduce) && shown.blocks == super::marks::Blocks::All;
            if let Some(transition) = shown.transition.as_mut().filter(|_| !blocks.is_empty()) {
                let evaluated: Vec<u32> = blocks.iter().map(|block| block & !wgsl::FRESH).collect();
                let evaluated = if every { super::marks::Blocks::All } else { super::marks::Blocks::Listed(evaluated) };
                transition.blocks.merge(&evaluated);
            }
            words.extend(blocks);
            let ends = if shown.drawable() { shown.unresolved.of(shown.live()) } else { Vec::new() };
            shown.end_block = words.len() as u32;
            shown.end_block_count = ends.len() as u32;
            words.extend(ends);
            let held = shown.held();
            let mut list = |blocks: Option<&super::marks::Blocks>| match blocks.and_then(|b| b.listed().map(|_| b)) {
                Some(blocks) => {
                    let at = words.len() as u32;
                    words.extend(blocks.of(held));
                    at
                }
                None => wgsl::NONE,
            };
            shown.ease_block = list(shown.transition.as_ref().map(|transition| &transition.blocks));
            shown.freeze_block = list(Some(&shown.frozen));
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

    /// Which marks this frame's passes draw: every mark when it starts from no still, or where depth
    /// varies, replays depth for a probe (`replays`). Else those after the cut it starts from, the
    /// mark whose comets it draws over the still, and when it draws the still (`made`), the marks
    /// before the cut. While the camera is unplaced, it draws none.
    fn drawn_marks(&self, from: Option<Cut>, made: Option<Cut>, replays: bool) -> Vec<bool> {
        let count = self.marks.len();
        let mut drawn = vec![!self.unplaced() && (from.is_none() || replays); count];
        if let Some(cut) = from {
            drawn[cut.rows.min(count)..].fill(true);
            if let Some(comets) = cut.comets {
                drawn[comets] = true;
            }
        }
        if let Some(cut) = made {
            let opaque = if cut.opaque && self.layered() { count } else { cut.rows };
            drawn[..opaque.max(cut.rows).min(count)].fill(true);
        }
        drawn
    }

    /// Writes where each segment the frame's draws draw lies on screen (see `lib/screen.wesl`):
    /// those of every recorded stroke mark in `drawn`, then those of the rows each one's focus
    /// lights, where the lit draw draws them, each mark's records after the last's. Then counts the
    /// comet slots due from the records (see [`View::count_comets`]). Returns where each mark's
    /// records start, for its draws and for its lit draw, which number their instances from there.
    fn place(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        drawn: &[bool],
    ) -> [Vec<Option<u32>>; 2] {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let lights = !self.unplaced() && self.can_use(Stage::Lit);
        let mut records = 0;
        let placed: [Vec<Option<(u32, u32, Variant)>>; 2] = [false, true].map(|lit| {
            (self.marks.iter().zip(drawn))
                .map(|(shown, &drawn)| {
                    let variant = MarkVariants::shown(shown, &self.scene).screen()?;
                    let (count, drawn) = if lit {
                        (shown.lit.rows * shown.lit.pieces, lights && shown.drawable() && shown.lit.rows > 0)
                    } else {
                        (shown.counted_instances(shown.instances()), drawn && shown.compiled.is_some())
                    };
                    drawn.then(|| {
                        records += count;
                        (records - count, count, variant)
                    })
                })
                .collect()
        });
        inner.screen.fit(device, records);
        let resources = self.resources.as_mut().expect("created before passes");
        let groups = resources.groups(&gpu.0, inner);
        let Inner { screen, pipelines, arena, .. } = inner;
        let mut raster = crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines, encoder };
        for (lit, list) in [false, true].into_iter().zip(&placed) {
            for (i, &(first, count, variant)) in list.iter().enumerate().filter_map(|(i, p)| p.as_ref().map(|p| (i, p)))
            {
                if count == 0 || !self.marks[i].drawable() {
                    continue;
                }
                let input = crate::gpu::listing::Inputs {
                    pages: arena.words(),
                    lists: resources.lists(),
                    view: &groups.view,
                    mark: &groups.mark,
                    offset: offset(i),
                    path: self.marks[i].path(),
                    projection: Projection::of(&self.scene.space),
                    measured: self.marks[i].measures_paths(),
                };
                screen.place(&mut raster, &input, variant, [count, first], lit);
            }
        }
        let firsts = placed.map(|list| list.iter().map(|p| p.map(|(first, ..)| first)).collect::<Vec<_>>());
        self.count_comets(encoder, inner, drawn, &firsts[0]);
        firsts
    }

    /// Counts again, from the records [`View::place`] just wrote, the comet slots due (see
    /// `View::comet_slots_due`) of the marks `drawn`, whose records start at `firsts`, and reads back
    /// how many each counted where more than the marks' drawing changed.
    fn count_comets(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        drawn: &[bool],
        firsts: &[Option<u32>],
    ) {
        let due = self.comet_slots_due(drawn, firsts, self.still.view());
        if due.is_empty() {
            return;
        }
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let count = self.marks.len();
        let resources = self.resources.as_mut().expect("created before passes");
        for &(i, ..) in &due {
            let list = self.marks[i].comets.list.expect("comet slots");
            resources.lists().write(&gpu.0.queue, list.header, &list.header_words());
        }
        let groups = resources.groups(&gpu.0, inner);
        let Inner { screen, pipelines, arena, listing, .. } = &mut *inner;
        let mut raster = crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines, encoder };
        for &(i, first, _) in &due {
            let shown = &self.marks[i];
            let list = shown.comets.list.expect("comet slots");
            // The copy of the mark's uniform for its comets draw says where its slots lie.
            let input = crate::gpu::listing::Inputs {
                pages: arena.words(),
                lists: resources.lists(),
                view: &groups.view,
                mark: &groups.mark,
                offset: offset(2 * count + i),
                path: shown.path(),
                projection: Projection::of(&self.scene.space),
                measured: shown.measures_paths(),
            };
            let regions = [list.counts, list.entries];
            listing.comet_slots(&mut raster, &input, screen, first, [list.items, list.kept], regions);
        }
        let read: Vec<usize> = due.iter().filter(|&&(.., read)| read).map(|&(i, ..)| i).collect();
        self.comet_slots_found(encoder, inner, &read);
    }

    /// Records the main render pass, counting draws in `drawn`: the backdrop, every drawable mark
    /// in scene order with its comets, and the lit rows. Once the text pipelines are ready, it also
    /// builds the distance fields of text set this frame, and draws the labels and the overlay's
    /// `[under, sprites]` sprites, the first `under` before the marks. `depth` is the area where
    /// a probe or query of this frame reads depth, if any does: depth is then stored, and where the
    /// frame multisamples, drawn again over that area at one sample a pixel, which WebGL2 can
    /// read. A frame that starts from the still draws it, then the marks after its cut, each with
    /// its comets. When the still does not hold that cut yet, the frame draws it first, in a pass
    /// of its own (see `View::choose_still`). Before any pass, it places the stroke and point marks
    /// they draw on screen (see [`View::place`]). While the camera is unplaced, it only clears.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        drawn: &mut Drawn,
        frame: &Frame<'_>,
        [under, sprites]: [u32; 2],
        depth: Option<super::camera::Area>,
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
        let samples = self.samples(frame.pixel_ratio);
        let (unplaced, layered) = (self.unplaced(), self.layered());
        let from = self.still.from.filter(|_| !unplaced);
        let held = self.still.held();
        let resources = self.resources.as_mut().expect("created before passes");
        let read = depth.map(|area| scissor(area, frame));
        let (color, depth) = resources.targets(device, frame.size, frame.format, samples);
        let still = resources.still(device, from.is_some() || held.is_some());
        let pick_targets = read.filter(|_| samples > 1).map(|read| (resources.pick_targets(device), read));
        // The still is drawn first when it does not hold the cut yet.
        let made = from.filter(|&cut| still.as_ref().is_some_and(|(_, fresh)| *fresh || held != Some(cut)));
        let firsts = self.place(encoder, inner, &self.drawn_marks(from, made, pick_targets.is_some() && layered));
        let resources = self.resources.as_mut().expect("created before passes");
        let groups = resources.groups(&gpu.0, inner);
        let passes: Vec<(Shader, wgpu::BindGroup)> = pass_shaders(&self.marks, &self.scene, still.is_some())
            .into_iter()
            .map(|shader| (shader, resources.pass(device, inner, shader)))
            .collect();
        let group = |shader: Shader| &passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        let (view, resolve) = match &color {
            Some(color) => (color, Some(frame.target)),
            None => (frame.target, None),
        };
        let marks = Marks {
            scene: &self.scene,
            device,
            format: frame.format,
            samples,
            groups: &groups,
            passes: &passes,
            count: self.marks.len(),
            layered,
            firsts: &firsts,
        };
        // Until a fit places the camera, the replayed depth only clears.
        if let Some((targets, read)) = &pick_targets {
            let read = if unplaced { [0; 4] } else { *read };
            marks.replay(encoder, targets, read, clip, drawn, inner, &self.marks);
        }
        let overlay = |pass: &mut wgpu::RenderPass<'_>, drawn: &mut Drawn, inner: &mut Inner, sprites: Range<u32>| {
            pass.set_pipeline(&inner.pipelines.render(device, Variant::draw(Shader::Overlay, frame.format, samples)));
            pass.set_bind_group(2, group(Shader::Overlay), &[]);
            drawn.draw_range(pass, 4, sprites);
        };
        // Where depth varies, opaque pixels draw first and keep their depth: those of points and
        // strokes, and areas whole. Every other pixel then blends over them in mark order,
        // only in front of what is drawn: antialiased edges, marks too thin to cover a pixel, and
        // translucent rows, such as those a selection dims. Within a mark whose rows stand at
        // different heights, they blend lowest first, which is farthest first where they overlap.
        // So the nearest opaque pixel shows whatever the order of the marks, a partly covered pixel
        // blends over what lies behind it, never over the background, and a nearer thin row blends
        // over the rows behind it. Each mark's comets draw after its rows, while they show. Marks and
        // their labels draw only where no guide on a side takes room. `start` draws the opaque pixels
        // of the marks before `opaque`, and the rows of those before `rows`, with their comets where
        // `comets` says.
        let count = self.marks.len();
        let comets = self.comets_shown > 0.0;
        let start = |pass: &mut wgpu::RenderPass<'_>,
                     drawn: &mut Drawn,
                     inner: &mut Inner,
                     [opaque, rows]: [usize; 2],
                     comets: bool| {
            marks.backdrop(pass, drawn, inner, false);
            if under > 0 {
                overlay(pass, drawn, inner, 0..under);
            }
            if let Some([x, y, w, h]) = clip {
                pass.set_scissor_rect(x, y, w, h);
            }
            if layered {
                marks.opaque(pass, drawn, inner, &self.marks, 0..opaque);
            }
            marks.rows(pass, drawn, inner, &self.marks, 0..rows, comets);
        };
        // The still holds what its cut's frames draw first, with its depth: the first frame from a cut
        // draws it in a pass of its own. Until a fit places the camera, frames show only the
        // background.
        if let (Some(cut), Some((still, _))) = (made, &still) {
            let (target, resolved) = color.as_ref().map_or((still, None), |color| (color, Some(still)));
            let mut pass = main_pass(encoder, target, resolved, &depth, background, depth_ops(false, true));
            // The still holds no comets: frames draw those over it.
            start(&mut pass, drawn, inner, [if cut.opaque { count } else { cut.rows }, cut.rows], false);
        }
        self.still.drew(made);
        // A still holding every opaque pixel keeps its depth for the frames after it, as it does for
        // probes.
        let keeps = from.is_some_and(|cut| cut.opaque);
        let mut pass = main_pass(encoder, view, resolve, &depth, background, depth_ops(keeps, keeps || read.is_some()));
        if unplaced {
            return;
        }
        match from {
            Some(cut) => marks.over_still(&mut pass, drawn, inner, &self.marks, cut, comets, clip),
            None => start(&mut pass, drawn, inner, [count, count], comets),
        }
        // Lit rows draw again, glowing, over every mark but labels, and where depth varies, over all
        // but the opaque rows nearer than them. They draw once their pipelines have compiled.
        for (i, shown) in self.marks.iter().enumerate() {
            if self.can_use(Stage::Lit) && shown.drawable() && shown.lit.rows > 0 {
                marks.draw(&mut pass, drawn, inner, i, shown, Draw::Lit);
            }
        }
        if texts {
            self.draw_labels(&mut pass, drawn, inner, frame.format, samples, &groups, group(Shader::Glyphs));
        }
        if clip.is_some() {
            pass.set_scissor_rect(0, 0, frame.size[0], frame.size[1]);
        }
        if sprites > under {
            overlay(&mut pass, drawn, inner, under..sprites);
        }
    }

    /// Reduce candidate priorities on the GPU, then describe the selected row and depth.
    pub(super) fn probe(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        probe: &super::probe::Probe,
    ) -> Readback {
        let around = match probe {
            super::probe::Probe::Hover(point) => Some((*point, self.probe_radius())),
            super::probe::Probe::Step(_) => None,
        };
        let reached: Vec<_> = (0..self.marks.len()).map(|i| self.reached(i, around)).collect();
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
            variant: MarkVariants::shown(&self.marks[i], &self.scene).probe(Shader::Probe),
        };
        let mut raster =
            crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
        inner.probing.begin(&mut raster, self.marks.len() as u32);
        for (i, _) in self.marks.iter().enumerate().filter(|(_, m)| m.probed()) {
            let (reach, count) = reached[i];
            inner.probing.nearest(&mut raster, &input(i), count, i as u32, reach);
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

    /// Records a query of `kind` over `marks`, each with its room and where its results go. A
    /// query `around` a point within a radius covers only the instances that can reach it.
    pub(super) fn probe_pass(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        kind: super::query::Kind,
        marks: &[(usize, u32, u32)],
        around: Option<([f32; 2], f32)>,
    ) {
        let reached: Vec<_> = marks.iter().map(|&(i, ..)| self.reached(i, around)).collect();
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before queries");
        if resources.samples() > 1 {
            resources.pick_targets(device);
        }
        let groups = resources.groups(&gpu.0, inner);
        let mut raster =
            crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
        for (&(i, room, at), &(reach, reached)) in marks.iter().zip(&reached) {
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
                variant: MarkVariants::shown(shown, &self.scene).probe(Shader::Probe),
            };
            let instances = shown.counted_instances(shown.live_instances());
            match kind {
                super::query::Kind::Hits => inner.probing.hits(&mut raster, &input, reached, room, at, reach),
                super::query::Kind::Boxed => {
                    inner.probing.boxed(&mut raster, &input, instances, shown.live(), at);
                }
                super::query::Kind::Locate => inner.probing.locate(&mut raster, &input),
            }
        }
    }
}
