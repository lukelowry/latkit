//! A frame's passes: compute evaluates dirty channels, reduces fitted domains, sums face normals, and
//! measures extents when asked; render draws the backdrop, every mark in scene order with depth, and
//! the overlay; a probe, when one waits, reads what the frame drew.

use super::resources::{MARK_STRIDE, SAMPLES};
use super::{Target, View};
use crate::Space;
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::MarkKind;

const WORKGROUP: u32 = 256;

fn offset(index: usize) -> u32 {
    (index as u64 * MARK_STRIDE) as u32
}

impl View {
    /// Evaluates dirty channels and sums face normals; with `measure`, also measures every vertex
    /// mark's and trace's extents and reads them back.
    pub(super) fn compute(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        measure: bool,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let work: Vec<usize> = (0..self.marks.len())
            .filter(|&i| self.marks[i].drawable() && (self.marks[i].dirty != 0 || self.marks[i].reduce))
            .collect();
        let faces: Vec<usize> = (0..self.marks.len())
            .filter(|&i| self.marks[i].drawable() && self.marks[i].kind() == MarkKind::Faces)
            .collect();
        let measured: Vec<usize> = (0..self.marks.len())
            .filter(|&i| measure && self.marks[i].drawable() && self.marks[i].measured())
            .collect();
        if work.is_empty() && faces.is_empty() && measured.is_empty() {
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
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit compute"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[]);
            if !work.is_empty() {
                let evaluate = inner.pipelines.compute(device, Shader::Evaluate, "evaluate");
                let reduce = inner.pipelines.compute(device, Shader::Evaluate, "reduce");
                pass.set_bind_group(2, &evaluate_group, &[]);
                for &i in &work {
                    let shown = &mut self.marks[i];
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    let workgroups = shown.rows.div_ceil(WORKGROUP);
                    if shown.reduce {
                        pass.set_pipeline(&reduce);
                        pass.dispatch_workgroups(workgroups, 1, 1);
                    }
                    pass.set_pipeline(&evaluate);
                    pass.dispatch_workgroups(workgroups, 1, 1);
                    shown.dirty = 0;
                    shown.reduce = false;
                }
            }
            if let Some(group) = &normals_group {
                pass.set_pipeline(&inner.pipelines.compute(device, Shader::Normals, "accumulate"));
                pass.set_bind_group(2, group, &[]);
                for &i in &faces {
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    pass.dispatch_workgroups(self.marks[i].rows.div_ceil(WORKGROUP), 1, 1);
                }
            }
            if let Some(group) = &bounds_group {
                pass.set_bind_group(2, group, &[]);
                for &i in &measured {
                    let shown = &self.marks[i];
                    let (entry, count) = match shown.kind() {
                        MarkKind::Lines => ("traces", shown.rows * shown.tables.traced()),
                        _ => ("vertices", shown.rows),
                    };
                    pass.set_pipeline(&inner.pipelines.compute(device, Shader::Bounds, entry));
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    pass.dispatch_workgroups(count.div_ceil(WORKGROUP), 1, 1);
                }
            }
        }
        let resources = self.resources.as_ref().expect("created before passes");
        (!measured.is_empty()).then(|| Readback::new(device, encoder, resources.extents(), 0, extent_bytes))
    }

    /// Draws the backdrop, every drawable mark in scene order, then `sprites` overlay sprites.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        target: &Target<'_>,
        sprites: u32,
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let background = self.scene.theme.background;
        let plot = matches!(self.scene.space, Space::Plot(_));
        let area = self.area();
        let resources = self.resources.as_mut().expect("created before passes");
        let (color, depth) = resources.targets(device, target.size, target.format);
        let (color, depth) = (color.clone(), depth.clone());
        let groups = resources.groups(&gpu.0, inner);
        let mut passes: Vec<(Shader, wgpu::BindGroup)> = Vec::new();
        for shader in [
            Shader::Vertices,
            Shader::VerticesShadow,
            Shader::Edges,
            Shader::Faces,
            Shader::FacesShadow,
            Shader::Lines,
            Shader::Overlay,
        ] {
            passes.push((shader, resources.pass(device, inner, shader)));
        }
        let group = |shader: Shader| &passes.iter().find(|(s, _)| *s == shader).expect("listed").1;
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("latkit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &color,
                depth_slice: None,
                resolve_target: Some(target.view),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: f64::from(background.r),
                        g: f64::from(background.g),
                        b: f64::from(background.b),
                        a: f64::from(background.a),
                    }),
                    store: wgpu::StoreOp::Discard,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_bind_group(0, &groups.view, &[]);
        pass.set_bind_group(1, &groups.mark, &[0]);
        pass.set_pipeline(&inner.pipelines.render(device, Shader::Backdrop, target.format, SAMPLES));
        pass.draw(0..3, 0..1);
        let [w, h] = target.size;
        let scissor = {
            let r = f64::from(target.pixel_ratio);
            let x0 = (area[0] * r).floor().clamp(0.0, f64::from(w)) as u32;
            let y0 = (area[1] * r).floor().clamp(0.0, f64::from(h)) as u32;
            let x1 = (area[2] * r).ceil().clamp(f64::from(x0), f64::from(w)) as u32;
            let y1 = (area[3] * r).ceil().clamp(f64::from(y0), f64::from(h)) as u32;
            [x0, y0, x1 - x0, y1 - y0]
        };
        // Faces' shadows lie on the ground under every mark.
        for (i, shown) in self.marks.iter().enumerate() {
            if shown.drawable() && shown.kind() == MarkKind::Faces && shown.mark.shadow() {
                pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                pass.set_pipeline(&inner.pipelines.render(device, Shader::FacesShadow, target.format, SAMPLES));
                pass.set_bind_group(2, group(Shader::FacesShadow), &[]);
                pass.draw(0..3, 0..shown.rows);
            }
        }
        for (i, shown) in self.marks.iter().enumerate() {
            if !shown.drawable() {
                continue;
            }
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            let (shaders, corners, instances): (&[Shader], u32, u32) = match shown.kind() {
                MarkKind::Vertices if shown.mark.shadow() => {
                    (&[Shader::VerticesShadow, Shader::Vertices], 4, shown.rows)
                }
                MarkKind::Vertices => (&[Shader::Vertices], 4, shown.rows),
                MarkKind::Edges => (&[Shader::Edges], 4, shown.rows),
                MarkKind::Faces => (&[Shader::Faces], 3, shown.rows),
                MarkKind::Lines => (&[Shader::Lines], 4, shown.rows * shown.tables.traced().saturating_sub(1)),
            };
            if instances == 0 {
                continue;
            }
            let clipped = plot && shown.kind() == MarkKind::Lines && scissor[2] > 0 && scissor[3] > 0;
            if clipped {
                pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
            }
            for &shader in shaders {
                pass.set_pipeline(&inner.pipelines.render(device, shader, target.format, SAMPLES));
                pass.set_bind_group(2, group(shader), &[]);
                pass.draw(0..corners, 0..instances);
            }
            if clipped {
                pass.set_scissor_rect(0, 0, w, h);
            }
        }
        if sprites > 0 {
            pass.set_pipeline(&inner.pipelines.render(device, Shader::Overlay, target.format, SAMPLES));
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
        let mut reset = [0_u32; wgsl::PROBE_WORDS as usize];
        reset[wgsl::PROBE_KEY as usize] = wgsl::NONE;
        gpu.0.queue.write_buffer(resources.probe(), 0, bytemuck::cast_slice(&reset));
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, Shader::Probe);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit probe"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[]);
            pass.set_bind_group(2, &group, &[]);
            for entry in ["nearest", "topmost", "describe"] {
                pass.set_pipeline(&inner.pipelines.compute(device, Shader::Probe, entry));
                for &i in &probed {
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    let workgroups = if entry == "describe" { 1 } else { self.marks[i].rows.div_ceil(WORKGROUP) };
                    pass.dispatch_workgroups(workgroups, 1, 1);
                }
            }
            pass.set_pipeline(&inner.pipelines.compute(device, Shader::Probe, "under"));
            pass.set_bind_group(1, &groups.mark, &[0]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        let resources = self.resources.as_ref().expect("created before passes");
        Readback::new(device, encoder, resources.probe(), 0, u64::from(wgsl::PROBE_WORDS) * 4)
    }
}
