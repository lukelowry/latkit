//! The pipelines a scene uses, made on the first frame drawing it: for each kind of mark, its draw
//! and the compute passes it needs, a stroke mark's for the path it runs along, shadows when
//! something casts, and the hover's probes for what picks. Chrome compiles them with that frame
//! rather than when the pointer first moves; what the scene never uses is never made. The queries
//! behind picks, box selection, and locating are made when first asked.

use super::{SHADE, View};
use crate::gpu::Inner;
use crate::gpu::pipelines::{self, Variant};
use crate::gpu::shaders::{PATH_ENDS, PATH_GEOMETRY, Shader};
use crate::{Mark, Marker, Space};

/// The probe's entry points the hover reads every probed mark with.
const HOVER: [&str; 3] = ["nearest", "topmost", "describe"];

/// The label passes run for each labeled mark; in a diagram, only the first.
const LABELS: [&str; 5] = ["candidates", "claim", "decide", "occupy", "fade"];

impl View {
    /// Makes every pipeline the scene uses, for frames into `format` with `samples` per pixel.
    pub(super) fn make_pipelines(&mut self, inner: &mut Inner, format: wgpu::TextureFormat, samples: u32) {
        if self.pipelines_made == Some((format, samples)) {
            return;
        }
        self.pipelines_made = Some((format, samples));
        let device = &self.gpu.0.device;
        let scene = &self.scene;
        let marks = &scene.marks;
        let any = |test: fn(&Mark) -> bool| marks.iter().any(test);
        let draw = |shader| Variant::draw(shader, format, samples);
        let compute = Variant::compute;
        let probe = pipelines::probe(samples);
        let mut variants = vec![
            draw(Shader::Backdrop),
            compute(Shader::Evaluate, "evaluate"),
            compute(Shader::Evaluate, "reduce"),
            compute(Shader::Freeze, "gather"),
        ];
        let controls = scene.controls;
        let diagram = matches!(scene.space, Space::Diagram(_));
        if matches!(scene.space, Space::Plot(_)) || controls.select_box || controls.connect {
            variants.push(draw(Shader::Overlay));
        }
        if any(|m| m.style().label.is_some()) && !diagram {
            variants.extend([compute(Shader::Labels, "clear_cells"), compute(Shader::Labels, "reset_cells")]);
        }
        if any(|m| m.style().shadow) {
            variants.push(Variant::draw(Shader::Shade, SHADE, 1));
        }
        if any(|m| m.style().interaction.pick) {
            variants.push(compute(probe, "under"));
        }
        if any(|m| matches!(m, Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_))) {
            variants.extend(["scan_blocks", "scan_sums", "add_sums"].map(|e| compute(Shader::Lists, e)));
        }
        let labels = if diagram { &LABELS[..1] } else { &LABELS[..] };
        for mark in marks {
            let style = mark.style();
            let primitive = mark.kind().primitive().code();
            // A stroke mark's pipelines are made for the path it runs along, an area's for its triangles'
            // geometry; others' read none.
            let path = mark.path(&scene.space).unwrap_or(PATH_ENDS);
            let (shader, cast) = match mark {
                Mark::Vertices(v) if matches!(v.marker, Marker::Wgsl { .. }) => (None, None),
                Mark::Vertices(_) => (Some(Shader::Points), Some(Shader::PointsCast)),
                Mark::Faces(_) => (Some(Shader::Triangles), Some(Shader::TrianglesCast)),
                Mark::Areas(_) => (Some(Shader::Areas), None),
                Mark::Edges(_) | Mark::Lines(_) => (Some(Shader::Strokes), Some(Shader::StrokesCast)),
            };
            variants.extend(shader.map(|s| draw(s).path(path)));
            if style.shadow {
                variants.extend(cast.map(|s| Variant::draw(s, SHADE, 1).path(path)));
            }
            let bounds = match mark {
                Mark::Vertices(_) => "points",
                Mark::Areas(_) => "areas",
                _ => "strokes",
            };
            variants.push(compute(Shader::Bounds, bounds).path(path));
            // Rows running through different numbers of segments, or areas of different numbers of
            // triangles, are numbered by a list.
            if matches!(mark, Mark::Edges(_)) || path == PATH_GEOMETRY {
                variants.extend(["count_segments", "write_segments"].map(|e| compute(Shader::Lists, e).path(path)));
            }
            if style.interaction.pick {
                variants.extend(HOVER.map(|e| Variant::probe(probe, e, primitive).path(path)));
            }
            if style.label.is_some() {
                variants.push(draw(Shader::Glyphs).path(path));
                variants.extend(labels.iter().map(|e| compute(Shader::Labels, e).path(path)));
            }
            match mark {
                Mark::Faces(_) => variants.push(compute(Shader::Normals, "accumulate")),
                Mark::Vertices(vertices) => {
                    if !vertices.ports.is_empty() {
                        variants.push(draw(Shader::PointsPorts));
                    }
                    if vertices.ports.iter().any(|(_, port)| port.label.is_some()) {
                        variants.push(draw(Shader::GlyphsPorts));
                    }
                    if let Marker::Wgsl { source, .. } = &vertices.marker {
                        inner.pipelines.custom(device, source, Shader::PointsCustom, format, samples);
                        if style.shadow {
                            inner.pipelines.custom(device, source, Shader::PointsCustomCast, SHADE, 1);
                        }
                    }
                }
                Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_) => {}
            }
        }
        inner.pipelines.make(device, variants);
    }
}
