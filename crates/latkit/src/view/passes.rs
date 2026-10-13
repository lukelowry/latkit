//! A frame's two passes: compute evaluates dirty channels, reducing fitted domains first and
//! measuring extents when asked; render draws the backdrop, then every mark in scene order.

use super::resources::{Groups, MARK_STRIDE, SAMPLES};
use super::{Target, View};
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::Shader;
use crate::scene::mark::MarkKind;

const WORKGROUP: u32 = 256;

fn offset(index: usize) -> u32 {
    (index as u64 * MARK_STRIDE) as u32
}

impl View {
    /// Evaluates dirty channels. With `measure`, also reduces every vertex mark's extent and reads
    /// it back.
    pub(super) fn compute(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        groups: &Groups,
        measure: bool,
    ) -> Option<Readback> {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let work: Vec<usize> = (0..self.marks.len())
            .filter(|&i| self.marks[i].drawable() && (self.marks[i].dirty != 0 || self.marks[i].reduce))
            .collect();
        let measured: Vec<usize> = (0..self.marks.len())
            .filter(|&i| measure && self.marks[i].drawable() && self.marks[i].kind() == MarkKind::Vertices)
            .collect();
        if work.is_empty() && measured.is_empty() {
            return None;
        }
        let resources = self.resources.as_ref().expect("created before passes");
        for &i in &work {
            let shown = &self.marks[i];
            if shown.reduce {
                let bytes = u64::from(shown.reductions()) * 8;
                encoder.clear_buffer(resources.domains(), u64::from(shown.domains) * 8, Some(bytes));
            }
        }
        if !measured.is_empty() {
            encoder.clear_buffer(resources.extents(), 0, Some(self.marks.len() as u64 * 16));
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit compute"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[]);
            if !work.is_empty() {
                let evaluate = inner.pipelines.compute(device, Shader::Evaluate, "evaluate");
                let reduce = inner.pipelines.compute(device, Shader::Evaluate, "reduce");
                pass.set_bind_group(2, &groups.evaluate, &[]);
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
            if !measured.is_empty() {
                pass.set_pipeline(&inner.pipelines.compute(device, Shader::Bounds, "bounds"));
                pass.set_bind_group(2, &groups.bounds, &[]);
                for &i in &measured {
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    pass.dispatch_workgroups(self.marks[i].rows.div_ceil(WORKGROUP), 1, 1);
                }
            }
        }
        (!measured.is_empty())
            .then(|| Readback::new(device, encoder, resources.extents(), 0, self.marks.len() as u64 * 16))
    }

    /// Draws the backdrop, then every drawable mark in scene order.
    pub(super) fn draw(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        groups: &Groups,
        target: &Target<'_>,
    ) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let background = self.scene.theme.background;
        let resources = self.resources.as_mut().expect("created before passes");
        let samples = resources.samples(device, target.size, target.format);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("latkit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: samples,
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
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_bind_group(0, &groups.view, &[]);
        pass.set_bind_group(1, &groups.mark, &[0]);
        pass.set_pipeline(&inner.pipelines.render(device, Shader::Backdrop, target.format, SAMPLES));
        pass.draw(0..3, 0..1);
        pass.set_bind_group(2, &groups.draw, &[]);
        for (i, shown) in self.marks.iter().enumerate() {
            if !shown.drawable() {
                continue;
            }
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            let shaders: &[Shader] = match shown.kind() {
                MarkKind::Vertices if self.scene.theme.shadows => &[Shader::VerticesShadow, Shader::Vertices],
                MarkKind::Vertices => &[Shader::Vertices],
                MarkKind::Edges => &[Shader::Edges],
            };
            for &shader in shaders {
                pass.set_pipeline(&inner.pipelines.render(device, shader, target.format, SAMPLES));
                pass.draw(0..4, 0..shown.rows);
            }
        }
    }
}
