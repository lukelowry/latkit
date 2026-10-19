//! The pipelines a scene uses, made before they are needed. The first frame drawing a scene makes
//! what it draws with: for each kind of mark, its draw and the compute passes it needs, a stroke
//! mark's for the path it runs along, shadows when something casts, labels. The frame after it makes
//! what the hover needs, the probes and the lit rows' draws for what picks; the frame after that,
//! the queries behind the intents the controls allow (the hits a menu or the keys list, boxes,
//! locating where a connection starts). Chrome compiles a pipeline where it is made, so the opening
//! costs its longest frame rather than their sum, and no first gesture compiles; what the scene
//! never uses is never made.

use super::{SHADE, View};
use crate::gpu::Inner;
use crate::gpu::pipelines::{self, Variant};
use crate::gpu::shaders::{PATH_ENDS, PATH_GEOMETRY, Shader};
use crate::{Mark, Marker, Scene, Space};

/// The probe's entry points the hover reads every probed mark with.
const HOVER: [&str; 3] = ["nearest", "topmost", "describe"];

/// The probe's entry points behind the hits a menu, the keys, or a connection's end list.
const HITS: [&str; 2] = ["count_hits", "write_hits"];

/// The passes of the select capping a mark's labels.
const SELECT: [&str; 4] = ["select_start", "select_count", "select_find", "select_cut"];

/// The label passes run for each labeled mark; in a diagram, only the first.
const LABELS: [&str; 6] = ["candidates", "claim", "decide", "occupy", "ask", "fade"];

impl View {
    /// Makes the pipelines the scene draws with, for frames into `format` with `samples` per pixel;
    /// on each frame after, the next stage of those its input needs.
    pub(super) fn make_pipelines(&mut self, inner: &mut Inner, format: wgpu::TextureFormat, samples: u32) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        if self.pipelines_made == Some((format, samples)) {
            if let Some(stage) = self.input_pipelines.pop_front() {
                inner.pipelines.make(device, stage);
            }
            return;
        }
        self.pipelines_made = Some((format, samples));
        let scene = &self.scene;
        let lights = scene.marks.iter().any(|m| m.style().interaction.pick);
        for mark in &scene.marks {
            let Mark::Vertices(vertices) = mark else { continue };
            let Marker::Wgsl { source, .. } = &vertices.marker else { continue };
            inner.pipelines.custom(device, source, Shader::PointsCustom, format, samples);
            if lights {
                inner.pipelines.custom(device, source, Shader::PointsCustomFocus, format, samples);
            }
            if mark.style().shadow {
                inner.pipelines.custom(device, source, Shader::PointsCustomCast, SHADE, 1);
            }
        }
        let Stages { draw, hover, intents } = stages(scene, format, samples);
        inner.pipelines.make(device, draw);
        self.input_pipelines = [hover, intents].into_iter().filter(|stage| !stage.is_empty()).collect();
    }
}

/// What a scene's frames make: what the first draws with, then what the hover needs, then what the
/// intents the controls allow need.
#[derive(Default)]
struct Stages {
    draw: Vec<Variant>,
    hover: Vec<Variant>,
    intents: Vec<Variant>,
}

/// The stages of `scene`'s pipelines for frames into `format` with `samples` per pixel, custom
/// markers' aside.
fn stages(scene: &Scene, format: wgpu::TextureFormat, samples: u32) -> Stages {
    let any = |test: fn(&Mark) -> bool| scene.marks.iter().any(test);
    let draw = |shader| Variant::draw(shader, format, samples);
    let compute = Variant::compute;
    let mut stages = Stages {
        draw: vec![
            draw(Shader::Backdrop),
            compute(Shader::Evaluate, "evaluate"),
            compute(Shader::Evaluate, "reduce"),
            compute(Shader::Freeze, "gather"),
        ],
        ..Stages::default()
    };
    let controls = scene.controls;
    let diagram = matches!(scene.space, Space::Diagram(_));
    if matches!(scene.space, Space::Plot(_)) || controls.select_box || controls.connect {
        stages.draw.push(draw(Shader::Overlay));
    }
    if any(|m| m.style().label.is_some()) && !diagram {
        stages.draw.extend([compute(Shader::Labels, "clear_cells"), compute(Shader::Labels, "reset_cells")]);
    }
    if any(|m| m.style().shadow) {
        stages.draw.push(Variant::draw(Shader::Shade, SHADE, 1));
    }
    if any(Mark::flows) {
        stages.draw.extend([compute(Shader::Evaluate, "travel"), compute(Shader::Evaluate, "carry")]);
    }
    if any(|m| m.style().interaction.pick) {
        stages.hover.push(compute(pipelines::probe(samples), "under"));
        stages.intents.extend(["scan_blocks", "scan_sums", "add_sums"].map(|e| compute(Shader::ListsQuery, e)));
    }
    if any(|m| matches!(m, Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_))) {
        stages.draw.extend(["scan_blocks", "scan_sums", "add_sums"].map(|e| compute(Shader::Lists, e)));
    }
    // Focus lights what picks and the ends of edges, so every mark that can be lit draws lit rows.
    let lights = any(|m| m.style().interaction.pick);
    for mark in &scene.marks {
        mark_stages(mark, scene, format, samples, lights, &mut stages);
    }
    stages
}

/// What `mark` adds to the stages: its draw and compute passes, for the path a stroke mark runs
/// along or an area's triangles' geometry; its lit rows and probes where it picks; its labels.
fn mark_stages(
    mark: &Mark,
    scene: &Scene,
    format: wgpu::TextureFormat,
    samples: u32,
    lights: bool,
    stages: &mut Stages,
) {
    let draw = |shader| Variant::draw(shader, format, samples);
    let compute = Variant::compute;
    let style = mark.style();
    let primitive = mark.kind().primitive().code();
    let path = mark.path(&scene.space).unwrap_or(PATH_ENDS);
    let (shader, cast, lit) = match mark {
        Mark::Vertices(v) if matches!(v.marker, Marker::Wgsl { .. }) => (None, None, None),
        Mark::Vertices(_) => (Some(Shader::Points), Some(Shader::PointsCast), Some(Shader::PointsFocus)),
        Mark::Faces(_) => (Some(Shader::Triangles), Some(Shader::TrianglesCast), None),
        Mark::Areas(_) => (Some(Shader::Areas), None, Some(Shader::AreasFocus)),
        Mark::Edges(_) | Mark::Lines(_) => {
            (Some(Shader::Strokes), Some(Shader::StrokesCast), Some(Shader::StrokesFocus))
        }
    };
    stages.draw.extend(shader.map(|s| draw(s).path(path)));
    if lights {
        stages.hover.extend(lit.map(|s| draw(s).path(path)));
    }
    if style.shadow {
        stages.draw.extend(cast.map(|s| Variant::draw(s, SHADE, 1).path(path)));
    }
    let bounds = match mark {
        Mark::Vertices(_) => "points",
        Mark::Areas(_) => "areas",
        _ => "strokes",
    };
    stages.draw.push(compute(Shader::Bounds, bounds).path(path));
    // Rows running through different numbers of segments, or areas of different numbers of
    // triangles, are numbered by a list.
    if matches!(mark, Mark::Edges(_)) || path == PATH_GEOMETRY {
        stages.draw.extend(["count_segments", "write_segments"].map(|e| compute(Shader::Lists, e).path(path)));
    }
    if style.interaction.pick {
        let controls = scene.controls;
        let probing = |entry| Variant::probe(pipelines::probe(samples), entry, primitive).path(path);
        stages.hover.extend(HOVER.map(probing));
        stages.intents.extend(HITS.map(probing));
        if controls.select_box {
            stages.intents.extend(["count_boxed", "write_boxed"].map(probing));
        }
        if controls.connect {
            stages.intents.push(probing("locate"));
        }
    }
    if style.label.is_some() {
        // In a diagram, only the first label pass runs.
        let labels = if matches!(scene.space, Space::Diagram(_)) { &LABELS[..1] } else { &LABELS[..] };
        stages.draw.push(draw(Shader::Glyphs).path(path));
        stages.draw.extend(labels.iter().map(|e| compute(Shader::Labels, e).path(path)));
        if style.label.as_ref().is_some_and(|l| l.max.is_some()) && !matches!(scene.space, Space::Diagram(_)) {
            stages.draw.extend(SELECT.map(|e| compute(Shader::Labels, e)));
        }
    }
    match mark {
        Mark::Faces(_) => stages.draw.push(compute(Shader::Normals, "accumulate")),
        Mark::Vertices(vertices) => {
            if !vertices.ports.is_empty() {
                stages.draw.push(draw(Shader::PointsPorts));
            }
            if vertices.ports.iter().any(|(_, port)| port.label.is_some()) {
                stages.draw.push(draw(Shader::GlyphsPorts));
            }
        }
        Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_) => {}
    }
}
