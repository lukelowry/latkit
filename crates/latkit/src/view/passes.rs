//! A frame's passes: compute evaluates dirty channels, reduces fitted domains, stands groups around
//! their members, numbers segments, sums face normals when their corners moved, and measures extents
//! when asked; render draws the backdrop, every mark's
//! primitive in scene order with depth, and the overlay; a probe, when one waits, reads what the
//! frame drew through the same geometry.

use super::resources::{EyeSlot, MARK_STRIDE};
use super::{Target, View};
use crate::Space;
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::{MarkKind, Primitive};

const WORKGROUP: u32 = 256;

/// The target pixels of `area`: a plot's lines draw only inside its axes.
fn scissor(area: super::camera::Area, target: &Target<'_>) -> [u32; 4] {
    let [w, h] = target.size.map(f64::from);
    let r = f64::from(target.pixel_ratio);
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

/// What a frame's compute pass does.
struct Work {
    evaluated: Vec<usize>,
    grouped: Option<(Vec<usize>, u32)>,
    segments: Vec<usize>,
    faces: Vec<usize>,
    measured: Vec<usize>,
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
        if let Some(list) = &self.segments {
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
        if let Some(list) = &self.segments {
            return list.kept;
        }
        match self.compiled.as_ref().map(|c| c.drawing.primitive) {
            Some(Primitive::Strokes) => self.rows * self.segments_per_row(),
            Some(Primitive::Points) => self.rows * (1 + self.graph.port_count()),
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
        match &self.segments {
            Some(list) => pass.draw_indirect(lists, u64::from(list.header + wgsl::LIST_DRAW) * 4),
            None => pass.draw(0..corners, 0..self.instances()),
        }
    }
}

impl View {
    /// Evaluates dirty channels, and sums face normals when what they rest on changed; with
    /// `measure`, also measures every measured mark's extents and reads them back.
    pub(super) fn compute(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        measure: bool,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let Work { evaluated: work, grouped, segments, faces, measured } = self.work(measure);
        if work.is_empty() && faces.is_empty() && measured.is_empty() && segments.is_empty() && grouped.is_none() {
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
        let slots = (resources.stand_ins().size() / 4) as u32;
        if grouped.is_some() {
            encoder.clear_buffer(resources.stand_ins(), 0, None);
        }
        let groups_group = grouped
            .as_ref()
            .filter(|(marks, _)| !marks.is_empty())
            .map(|_| resources.pass(device, inner, Shader::Groups));
        for &i in &segments {
            let list = self.marks[i].segments.expect("listed");
            gpu.0.queue.write_buffer(
                resources.lists(),
                u64::from(list.header) * 4,
                bytemuck::cast_slice(&list.header_words(4)),
            );
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit compute"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            if !work.is_empty() {
                let evaluate = inner.pipelines.compute(device, Shader::Evaluate, "evaluate");
                let reduce = inner.pipelines.compute(device, Shader::Evaluate, "reduce");
                pass.set_bind_group(2, &evaluate_group, &[]);
                for &i in &work {
                    let shown = &mut self.marks[i];
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    if shown.reduce && shown.rows > 0 {
                        pass.set_pipeline(&reduce);
                        dispatch(&mut pass, shown.rows);
                    }
                    pass.set_pipeline(&evaluate);
                    dispatch(&mut pass, shown.rows + shown.exits);
                    shown.dirty = 0;
                    shown.reduce = false;
                }
            }
            if let (Some(group), Some((marks, levels))) = (&groups_group, &grouped) {
                pass.set_bind_group(2, group, &[]);
                self.stand_groups(&mut pass, inner, &groups.mark, marks, *levels, slots);
            }
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
                    let entry = if self.marks[i].kind() == MarkKind::Vertices { "points" } else { "strokes" };
                    pass.set_pipeline(&inner.pipelines.compute(device, Shader::Bounds, entry));
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    dispatch(&mut pass, self.marks[i].live_instances());
                }
            }
        }
        self.count_found(encoder, inner, &segments);
        let resources = self.resources.as_ref().expect("created before passes");
        (!measured.is_empty())
            .then(|| Readback::new(&inner.readbacks, device, encoder, resources.extents(), 0, extent_bytes))
    }

    /// What this frame's compute pass does: the marks it evaluates, the groups it stands, the segment
    /// lists it counts, the faces whose normals it sums, and the marks it measures.
    fn work(&mut self, measure: bool) -> Work {
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
        let grouped = self.groups_due();
        let segments = self.segments_due();
        let faces = if self.normals_due() {
            (0..self.marks.len()).filter(|&i| self.marks[i].drawable() && self.marks[i].faces()).collect()
        } else {
            Vec::new()
        };
        let measured = (0..self.marks.len())
            .filter(|&i| measure && self.marks[i].drawable() && self.marks[i].measured())
            .collect();
        Work { evaluated: work, grouped, segments, faces, measured }
    }

    /// Records the groups pass: clears the stand-ins of `slots` vertex slots, then stands each group
    /// mark's rows around their members, once per level of groups they hold.
    fn stand_groups(
        &self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        mark: &wgpu::BindGroup,
        marks: &[usize],
        levels: u32,
        slots: u32,
    ) {
        let device = &self.gpu.0.device;
        pass.set_bind_group(1, mark, &[0]);
        pass.set_pipeline(&inner.pipelines.compute(device, Shader::Groups, "clear"));
        dispatch(pass, slots);
        pass.set_pipeline(&inner.pipelines.compute(device, Shader::Groups, "bound"));
        // Each level settles the groups holding the ones settled before.
        for _ in 0..levels {
            for &i in marks {
                pass.set_bind_group(1, mark, &[offset(i)]);
                dispatch(pass, self.marks[i].rows);
            }
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
            pass.set_bind_group(1, mark, &[offset(i)]);
            pass.set_pipeline(&inner.pipelines.compute(device, Shader::Lists, "count_segments"));
            dispatch(pass, items);
            super::lists::scan(pass, &mut inner.pipelines, device, items, false);
            pass.set_pipeline(&inner.pipelines.compute(device, Shader::Lists, "write_segments"));
            dispatch(pass, items);
        }
    }

    /// The group marks to stand around their members this frame, and the levels of groups they
    /// hold: when a vertex mark wrote its state, the zoom turned sizes in pixels into other units,
    /// or the slots moved. With no group marks left, the stand-ins are cleared once.
    fn groups_due(&mut self) -> Option<(Vec<usize>, u32)> {
        let marks: Vec<usize> =
            (0..self.marks.len()).filter(|&i| self.marks[i].drawable() && self.marks[i].graph.depth > 0).collect();
        if marks.is_empty() {
            return self.groups_drawn.take().map(|_| (marks, 0));
        }
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::generation);
        let mut stamp: Vec<u64> = self
            .marks
            .iter()
            .filter(|m| m.kind() == MarkKind::Vertices)
            .map(|m| m.version + u64::from(m.dirty != 0))
            .collect();
        stamp.extend([
            u64::from(self.px_per_unit.to_bits()),
            u64::from(self.scene.theme.group_padding.to_bits()),
            generation,
        ]);
        stamp.extend(marks.iter().map(|&i| i as u64));
        if self.groups_drawn.as_ref() == Some(&stamp) {
            return None;
        }
        self.groups_drawn = Some(stamp);
        let levels = marks.iter().map(|&i| self.marks[i].graph.depth).max().unwrap_or(0);
        Some((marks, levels))
    }

    /// Whether face normals must be summed again: a face mark or a vertex mark wrote its state since
    /// they were, or the globe turned under them.
    fn normals_due(&mut self) -> bool {
        let faces = self.marks.iter().any(|m| m.drawable() && m.faces());
        if !faces {
            return false;
        }
        let mut stamp: Vec<u64> = self
            .marks
            .iter()
            .filter(|m| matches!(m.kind(), MarkKind::Vertices | MarkKind::Faces))
            .map(|m| m.version + u64::from(m.dirty != 0))
            .collect();
        if matches!(self.scene.space, Space::Earth(_)) {
            let camera = self.camera;
            stamp.push(match camera {
                crate::Camera::Map { center, .. } => center[0].to_bits() ^ center[1].to_bits().rotate_left(17),
                crate::Camera::Plot { .. } => 0,
            });
        }
        stamp.push(self.marks.len() as u64);
        if self.normals_drawn.as_ref() == Some(&stamp) {
            return false;
        }
        self.normals_drawn = Some(stamp);
        true
    }

    /// Draws the backdrop, every drawable mark in scene order, then `sprites` overlay sprites. Depth is
    /// kept when `probing` reads it.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        target: &Target<'_>,
        sprites: u32,
        probing: bool,
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let background = self.scene.theme.background.to_array().map(f64::from);
        let plot = matches!(self.scene.space, Space::Plot(_));
        let [w, h] = target.size;
        let scissor = scissor(self.area(), target);
        let samples = super::resources::samples(target.pixel_ratio);
        let resources = self.resources.as_mut().expect("created before passes");
        let (color, depth) = resources.targets(device, target.size, target.format, samples);
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
            Shader::Glyphs,
            Shader::Overlay,
        ] {
            passes.push((shader, resources.pass(device, inner, shader)));
        }
        let group = |shader: Shader| &passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        let (view, resolve) = match &color {
            Some(color) => (color, Some(target.view)),
            None => (target.view, None),
        };
        let mut pass = main_pass(encoder, view, resolve, &depth, background, probing);
        pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
        pass.set_bind_group(1, &groups.mark, &[0]);
        pass.set_pipeline(&inner.pipelines.render(device, Shader::Backdrop, target.format, samples));
        pass.set_bind_group(2, group(Shader::Backdrop), &[]);
        pass.draw(0..3, 0..1);
        for (i, shown) in self.marks.iter().enumerate() {
            if !shown.drawable() {
                continue;
            }
            let Some(compiled) = &shown.compiled else { continue };
            let (shader, corners) = match compiled.drawing.primitive {
                Primitive::Points if compiled.drawing.markers.custom.is_some() => (Shader::PointsCustom, 4),
                Primitive::Points => (Shader::Points, 4),
                Primitive::Strokes => (Shader::Strokes, 4),
                Primitive::Triangles => (Shader::Triangles, 3),
            };
            let instances = shown.instances();
            let pipeline = match &compiled.drawing.markers.custom {
                Some(source) => inner.pipelines.custom(device, source, shader, target.format, samples),
                None => Some(inner.pipelines.render(device, shader, target.format, samples)),
            };
            let Some(pipeline) = pipeline.filter(|_| instances > 0) else { continue };
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            let clipped = plot && shown.kind() == MarkKind::Lines && scissor[2] > 0 && scissor[3] > 0;
            if clipped {
                pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
            }
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(2, group(shader), &[]);
            shown.record(&mut pass, corners, &lists);
            if clipped {
                pass.set_scissor_rect(0, 0, w, h);
            }
            let ports = shown.graph.port_count();
            if compiled.drawing.primitive == Primitive::Points && ports > 0 {
                pass.set_pipeline(&inner.pipelines.render(device, Shader::PointsPorts, target.format, samples));
                pass.set_bind_group(2, group(Shader::PointsPorts), &[]);
                pass.draw(0..4, 0..(shown.rows + shown.exits) * ports);
            }
        }
        let glyphs = inner.pipelines.render(device, Shader::Glyphs, target.format, samples);
        self.draw_labels(&mut pass, &glyphs, &groups, group(Shader::Glyphs));
        if sprites > 0 {
            pass.set_pipeline(&inner.pipelines.render(device, Shader::Overlay, target.format, samples));
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
                    let primitive = self.marks[i].primitive();
                    pass.set_pipeline(&inner.pipelines.probing(device, shader, entry, primitive));
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
        Readback::new(&inner.readbacks, device, encoder, resources.probe(), 0, u64::from(wgsl::PROBE_WORDS) * 4)
    }
}
