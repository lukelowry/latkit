//! A frame's passes: compute evaluates dirty channels, reduces fitted domains, numbers segments, sums
//! face normals when their corners moved, and measures extents when asked; render draws the
//! backdrop, every mark's primitive and ports in scene order with depth, the labels, and the
//! overlay; a probe, when one waits, reads what the frame drew through the same geometry.

use super::resources::{EyeSlot, MARK_STRIDE};
use super::{Frame, View};
use crate::Space;
use crate::derive::stamp_of;
use crate::gpu::Inner;
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::work::Count;
use crate::scene::mark::{MarkKind, Primitive};

const WORKGROUP: u32 = 256;

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
            pass.draw(0..corners, 0..shown.lit.rows * shown.lit.pieces);
        } else {
            shown.record(pass, corners, self.lists);
        }
        if clip.is_some() {
            pass.set_scissor_rect(0, 0, self.size[0], self.size[1]);
        }
    }
}

/// What a frame's compute pass does.
struct Work {
    evaluated: Vec<usize>,
    segments: Vec<usize>,
    faces: Vec<usize>,
    measured: Vec<usize>,
    /// Marks whose comets carry their travel over to rows a transition moved, and that travel.
    carried: Vec<usize>,
    travelled: Vec<usize>,
}

/// Dispatches a workgroup for every `WORKGROUP` of `items`, if there are any.
pub(super) fn dispatch(pass: &mut wgpu::ComputePass<'_>, items: u32) {
    if items > 0 {
        pass.dispatch_workgroups(items.div_ceil(WORKGROUP), 1, 1);
    }
}

/// Mark `index`'s dynamic offset in the marks' uniforms.
pub(super) fn offset(index: usize) -> u32 {
    (index as u64 * MARK_STRIDE) as u32
}

impl super::marks::Shown {
    /// Segments of each row's path, for strokes whose rows all have as many.
    pub(crate) fn segments_per_row(&self) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        match self.kind() {
            MarkKind::Lines => {
                let segments = self.tables.traced().saturating_sub(1);
                // Steps turn each segment between samples into two, where a trace draws only samples.
                let steps = compiled.drawing.flags & (wgsl::STEP_BEFORE | wgsl::STEP_AFTER) != 0;
                let levels = self.tables.plan().is_some_and(|p| p.level > 0);
                if steps && !levels { 2 * segments } else { segments }
            }
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
    pub(crate) fn record(&self, pass: &mut wgpu::RenderPass<'_>, corners: u32, lists: &wgpu::Buffer) {
        match &self.segments.list {
            Some(list) => pass.draw_indirect(lists, u64::from(list.header + wgsl::LIST_DRAW) * 4),
            None => pass.draw(0..corners, 0..self.instances()),
        }
    }
}

impl View {
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
        let Work { evaluated: work, segments, faces, measured, carried, travelled } = self.work(measure, travel);
        if [&work, &segments, &faces, &measured, &carried, &travelled].iter().all(|marks| marks.is_empty()) {
            return None;
        }
        let resources = self.resources.as_mut().expect("created before passes");
        for &i in &work {
            let shown = &self.marks[i];
            if shown.reduce {
                let bytes = u64::from(shown.reductions()) * 8;
                encoder.clear_buffer(resources.domains(), u64::from(shown.domains) * 8, Some(bytes));
            }
        }
        let extent_bytes = self.marks.len() as u64 * u64::from(wgsl::EXTENT_WORDS) * 4;
        if !measured.is_empty() {
            encoder.clear_buffer(resources.extents(), 0, Some(extent_bytes));
        }
        if !faces.is_empty() {
            encoder.clear_buffer(resources.normals(), 0, None);
        }
        let groups = resources.groups(&gpu.0, inner);
        let evaluate_group = resources.pass(device, inner, Shader::Evaluate);
        let normals_group = (!faces.is_empty()).then(|| resources.pass(device, inner, Shader::Normals));
        let bounds_group = (!measured.is_empty()).then(|| resources.pass(device, inner, Shader::Bounds));
        let lists_group = (!segments.is_empty()).then(|| resources.pass(device, inner, Shader::Lists));
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
            pass.set_bind_group(2, &evaluate_group, &[]);
            self.every_row(&mut pass, inner, &groups.mark, "carry", &carried);
            if !work.is_empty() {
                let evaluate = inner.pipelines.compute(device, Shader::Evaluate, "evaluate");
                let reduce = inner.pipelines.compute(device, Shader::Evaluate, "reduce");
                for &i in &work {
                    let shown = &mut self.marks[i];
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    if shown.reduce && shown.rows > 0 {
                        pass.set_pipeline(&reduce);
                        dispatch(&mut pass, shown.rows);
                    }
                    pass.set_pipeline(&evaluate);
                    dispatch(&mut pass, shown.rows + shown.exits);
                    gpu.0.counters.add(Count::Evaluated, u64::from(shown.rows + shown.exits));
                    shown.dirty = 0;
                    shown.reduce = false;
                }
            }
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
        self.count_found(encoder, inner, &segments);
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
            if shown.rows + shown.exits == 0 && shown.tables.synced() {
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
            if shown.dirty & shown.shape_channels() != 0 {
                shown.shape_version += 1;
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
        Work { evaluated: work, segments, faces, measured, carried, travelled }
    }

    /// Runs the expression machine's entry point `entry` over every row and exit of each of `marks`.
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
            dispatch(pass, self.marks[i].rows + self.marks[i].exits);
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
            super::lists::scan(pass, &mut inner.pipelines, device, items, false);
            let write = Variant::compute(Shader::Lists, "write_segments").path(path);
            pass.set_pipeline(&inner.pipelines.compute_pipeline(device, write));
            dispatch(pass, items);
        }
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

    /// Draws the backdrop, every drawable mark in scene order, then `sprites` overlay sprites. Depth is
    /// kept when `probing` reads it.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        frame: &Frame<'_>,
        sprites: u32,
        probing: bool,
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let background =
            if self.signal.transparent() { [0.0; 4] } else { self.scene.theme.background.to_array().map(f64::from) };
        let plot = matches!(self.scene.space, Space::Plot(_));
        let scissor = scissor(self.area(), frame);
        let samples = super::resources::samples(frame.pixel_ratio);
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
        pass.draw(0..3, 0..1);
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
            marks.draw(&mut pass, inner, i, shown, false);
            let ports = shown.port_count();
            if shown.compiled.as_ref().is_some_and(|c| c.drawing.primitive == Primitive::Points) && ports > 0 {
                pass.set_pipeline(&inner.pipelines.render(device, Shader::PointsPorts, frame.format, samples));
                pass.set_bind_group(2, group(Shader::PointsPorts), &[]);
                pass.draw(0..4, 0..(shown.rows + shown.exits) * ports);
            }
        }
        // The rows focus lights draw again over every mark but labels, glowing: nothing covers them.
        for (i, shown) in self.marks.iter().enumerate() {
            if shown.drawable() && shown.lit.rows > 0 {
                marks.draw(&mut pass, inner, i, shown, true);
            }
        }
        let glyphs = [Shader::Glyphs, Shader::GlyphsPorts].map(|shader| (shader, group(shader)));
        self.draw_labels(&mut pass, inner, frame.format, samples, &groups, glyphs);
        if sprites > 0 {
            pass.set_pipeline(&inner.pipelines.render(device, Shader::Overlay, frame.format, samples));
            pass.set_bind_group(2, group(Shader::Overlay), &[]);
            pass.draw(0..4, 0..sprites);
        }
    }

    /// Finds the row nearest the probe among what the frame drew, and the nearest depth drawn there,
    /// and reads them back.
    pub(super) fn probe(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> Readback {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let probed: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].probed()).collect();
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
            pass.set_bind_group(2, &group, &[]);
            for entry in ["nearest", "topmost", "describe"] {
                for &i in &probed {
                    let variant = Variant::probe(shader, entry, self.marks[i].primitive()).path(self.marks[i].path());
                    pass.set_pipeline(&inner.pipelines.compute_pipeline(device, variant));
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    if entry == "describe" {
                        pass.dispatch_workgroups(1, 1, 1);
                    } else {
                        dispatch(&mut pass, self.marks[i].live_instances());
                    }
                }
            }
            pass.set_pipeline(&inner.pipelines.compute(device, shader, "under"));
            pass.set_bind_group(1, &groups.mark, &[0]);
            pass.dispatch_workgroups(1, 1, 1);
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
}
