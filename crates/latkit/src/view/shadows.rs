//! Shadows: marks that cast draw into one map of the ground through the light's eye, blended by MIN,
//! then each level of the map is made from the one below. The map covers the ground the plane's grid
//! fades over, around what the camera looks at, and is drawn again only when a caster or the camera
//! moved.

use glam::DVec3;

use super::View;
use super::derived::stamp_of;
use super::resources::{EyeSlot, SHADE, SHADE_SIZE};
use super::uniforms;
use crate::Space;
use crate::gpu::Inner;
use crate::gpu::pipelines::Variant;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::{MarkKind, Primitive};

impl View {
    /// Indices of marks that cast shadows and draw.
    fn casters(&self) -> Vec<usize> {
        let ground = match &self.scene.space {
            Space::Plane(_) => true,
            Space::Earth(_) => self.projected().globe < 0.5,
            Space::Plot(_) | Space::Diagram(_) => false,
        };
        if !ground {
            return Vec::new();
        }
        (0..self.marks.len())
            .filter(|&i| {
                let m = &self.marks[i];
                m.drawable() && m.compiled.as_ref().is_some_and(|c| c.drawing.flags & wgsl::CASTS != 0)
            })
            .collect()
    }

    /// The light's eye and the frame's shade words for this frame, or `None` when nothing casts.
    pub(super) fn shade(&self, frame: &mut wgsl::Frame, main: &wgsl::Eye) -> Option<wgsl::Eye> {
        let casters = self.casters();
        if casters.is_empty() {
            return None;
        }
        let projected = self.projected();
        let shadow = self.scene.theme.shadow;
        let light = DVec3::from(shadow.light.map(f64::from)).normalize_or(DVec3::Z);
        let light = DVec3::new(light.x, light.y, light.z.max(0.1)).normalize();
        let radius = uniforms::grid_fade(&self.scene, &projected, self.size).max(1e-9);
        // Snapped to whole texels so the map does not shimmer as the camera pans.
        let texel = 2.0 * radius / f64::from(SHADE_SIZE);
        let snap = |v: f64| (v / texel).round() * texel;
        let rect = [snap(-radius), snap(-radius), snap(-radius) + 2.0 * radius, snap(-radius) + 2.0 * radius];
        let lift = f64::from(shadow.lift) / projected.px_per_unit[0].max(1e-30);
        frame.shade.light = [light.x as f32, light.y as f32, light.z as f32, shadow.softness];
        frame.shade.rect = rect.map(|v| v as f32);
        frame.shade.lift = lift as f32;
        frame.shade.texel = texel as f32;
        frame.shade.levels = (SHADE_SIZE.ilog2() + 1) as f32;
        frame.shade.on = 1;
        Some(uniforms::light_eye(main, light, rect, lift, SHADE_SIZE))
    }

    /// Draws every caster into the map through `light`, then the map's levels, when what the map
    /// would show changed.
    pub(super) fn cast(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, light: &wgsl::Eye) {
        let casters = self.casters();
        // What the map is drawn from: the light's eye and each caster's state.
        let versions: Vec<(usize, u64)> = casters.iter().map(|&i| (i, self.marks[i].version)).collect();
        let stamp = stamp_of((bytemuck::bytes_of(light), versions));
        if !self.shadow_map.due(stamp) {
            return;
        }
        self.shadow_map.mark(stamp);
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before shadows");
        resources.ensure_shadows(device);
        let groups = resources.groups(&gpu.0, inner);
        let lists = resources.lists().clone();
        let mut draws = Vec::new();
        for &i in &casters {
            let shown = &self.marks[i];
            let Some(compiled) = &shown.compiled else { continue };
            let custom = compiled.drawing.markers.custom.as_deref();
            let (shader, corners) = match compiled.drawing.primitive {
                Primitive::Points if custom.is_some() => (Shader::PointsCustomCast, 4),
                Primitive::Points => (Shader::PointsCast, 4),
                Primitive::Strokes => (Shader::StrokesCast, 4),
                Primitive::Triangles => (Shader::TrianglesCast, 3),
            };
            let pipeline = match custom {
                Some(source) => inner.pipelines.custom(device, source, shader, SHADE, 1),
                None => {
                    Some(inner.pipelines.render_pipeline(device, Variant::draw(shader, SHADE, 1).path(shown.path())))
                }
            };
            let Some(pipeline) = pipeline else { continue };
            draws.push((i, pipeline, corners, resources.pass(device, inner, shader)));
        }
        let base = resources.shadows.levels[0].clone();
        let open = wgpu::Color { r: 1.0, g: 65504.0, b: 65504.0, a: 0.0 };
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("latkit cast"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &base,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(open), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Light.offset()]);
            for (i, pipeline, corners, group) in &draws {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(1, &groups.mark, &[super::passes::offset(*i)]);
                pass.set_bind_group(2, group, &[]);
                self.marks[*i].record(&mut pass, *corners, &lists);
            }
        }
        let resources = self.resources.as_ref().expect("created");
        let pipeline = inner.pipelines.render(device, Shader::Shade, SHADE, 1);
        for level in 1..resources.shadows.levels.len() {
            let group = resources.level_group(device, inner, level - 1);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("latkit shadow level"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &resources.shadows.levels[level],
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(open), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Light.offset()]);
            pass.set_bind_group(1, &groups.mark, &[0]);
            pass.set_bind_group(2, &group, &[]);
            pass.draw(0..3, 0..1);
        }
    }
}

impl super::marks::Shown {
    /// Whether the mark draws faces, which receive shadows and need normals.
    pub(crate) fn faces(&self) -> bool {
        self.kind() == MarkKind::Faces
    }
}
