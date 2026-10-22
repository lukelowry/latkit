//! The pipelines a scene uses, asked for as it is shown, each at its urgency: what its frames draw
//! with (for each kind of mark, its draw and the compute passes it needs, a stroke mark's for the
//! path it runs along, shadows when something casts, and each mark's channels for what they read);
//! then their text (labels, glyphs, the fields text is set in, the overlay); then what changes need
//! (the passes transitions ease with, comets carried on), what lights rows (the lit rows' draws) and,
//! for frames that take input, what the hover and the intents need (each kind of mark's probe
//! program, which answers the hover, picks, boxes, and where a row lies). The GPU compiles them
//! through its queue, the most urgent first ([`crate::gpu::pipelines`]): the view draws once what it
//! draws with landed, adds text once that did, and lights rows, probes, and answers queries once the
//! rest did, so no frame waits on a compile and nothing compiles where it is first used; what the
//! scene never uses is never asked for. A picture takes no input: it draws once all it draws, writes,
//! changes, and lights rows with landed.

use super::{SHADE, View};
use crate::gpu::Inner;
use crate::gpu::pipelines::{self, Asked, Urgency, Variant};
use crate::gpu::shaders::{PATH_ENDS, PATH_GEOMETRY, Shader};
use crate::{Mark, Marker, Scene, Space};

/// The passes of the select capping a mark's labels.
const SELECT: [&str; 4] = ["select_start", "select_count", "select_find", "select_cut"];

/// The label passes run for each labeled mark; in a diagram, only the first.
const LABELS: [&str; 6] = ["candidates", "claim", "decide", "occupy", "ask", "fade"];

/// What a view asked the GPU to compile for frames into one target, taking input or not: what they
/// draw with, their text, and what changes, lights rows, probes, and answers queries.
pub(super) struct Asking {
    target: (wgpu::TextureFormat, u32),
    input: bool,
    drawing: Vec<Asked>,
    texts: Vec<Asked>,
    answering: Vec<Asked>,
}

/// What nearly every scene draws with, which the GPU compiles for views to come, in this order: the
/// channels, strokes between ends and through geometry, points and the backdrop, their bounds and
/// lists, ports; then text.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub(crate) fn common(format: wgpu::TextureFormat, samples: u32) -> Vec<Asked> {
    let draw = |shader| Variant::draw(shader, format, samples);
    let mut needs = vec![
        Variant::channels(pipelines::Reads { joined: false, timed: false, viewed: false }),
        draw(Shader::Strokes).path(PATH_ENDS),
        draw(Shader::Strokes).path(PATH_GEOMETRY),
        draw(Shader::Points),
        draw(Shader::Backdrop),
        Variant::compute(Shader::Bounds, "points"),
    ];
    for path in [PATH_ENDS, PATH_GEOMETRY] {
        needs.push(Variant::compute(Shader::Bounds, "strokes").path(path));
        needs.extend(["count_segments", "write_segments"].map(|e| Variant::compute(Shader::Lists, e).path(path)));
    }
    needs.extend(["scan_blocks", "scan_sums", "add_sums"].map(|e| Variant::compute(Shader::Lists, e)));
    needs.extend([draw(Shader::PointsPorts), draw(Shader::Overlay), draw(Shader::Glyphs), draw(Shader::GlyphsPorts)]);
    needs.push(Variant::compute(Shader::Labels, "candidates"));
    needs.extend(["columns", "rows"].map(|e| Variant::compute(Shader::Fields, e)));
    needs.into_iter().map(Asked::Shader).collect()
}

impl View {
    /// Asks for what frames of the scene into `target`, taking `input` or not, use, each at its
    /// urgency, the first time; and for the channels of every mark, which compile for what they read
    /// once their data says. Each wakes the view as it lands.
    pub(super) fn ask(&mut self, inner: &mut Inner, target: (wgpu::TextureFormat, u32), input: bool) -> usize {
        let device = &self.gpu.0.device;
        let at = if let Some(at) = self.asked.iter().position(|a| a.target == target && a.input == input) {
            at
        } else {
            let Stages { draw, text, changes, lit, input: inputs } = stages(&self.scene, target.0, target.1);
            let (mut drawing, mut texts, mut answering) = if input {
                (draw, text, [changes, lit, inputs].concat())
            } else {
                ([draw, text, changes, lit].concat(), Vec::new(), Vec::new())
            };
            // Marks alike share pipelines, each asked for once.
            for asked in [&mut drawing, &mut texts, &mut answering] {
                let mut seen = rustc_hash::FxHashSet::default();
                asked.retain(|need| seen.insert(need.clone()));
            }
            inner.pipelines.ask(device, &drawing, Urgency::Draw, &self.waker);
            inner.pipelines.ask(device, &texts, Urgency::Text, &self.waker);
            inner.pipelines.ask(device, &answering, Urgency::Answer, &self.waker);
            self.asked.push(Asking { target, input, drawing, texts, answering });
            self.asked.len() - 1
        };
        inner.pipelines.ask(device, &self.channels(), Urgency::Draw, &self.waker);
        at
    }

    /// Each mark's channels, made for what they read: before its data says, neither joins, samples, nor
    /// the view.
    fn channels(&self) -> Vec<Asked> {
        let mut channels: Vec<Asked> = Vec::new();
        for shown in &self.marks {
            let need = Asked::Shader(Variant::channels(shown.reads()));
            if !channels.contains(&need) {
                channels.push(need);
            }
        }
        channels
    }

    /// Whether frames into `format` with `samples` per pixel, taking `input` or not, can draw now:
    /// whether what they draw with compiled.
    pub(super) fn pipelines_ready(
        &mut self,
        inner: &mut Inner,
        format: wgpu::TextureFormat,
        samples: u32,
        input: bool,
    ) -> bool {
        let at = self.ask(inner, (format, samples), input);
        inner.pipelines.ready(&self.asked[at].drawing) && inner.pipelines.ready(&self.channels())
    }

    /// Whether frames draw text: labels, their glyphs and fields, and the overlay. Until then they
    /// draw without, and labels fade in once it lands, as after any change.
    pub(super) fn texts_ready(&self, inner: &Inner) -> bool {
        self.asked.iter().all(|a| inner.pipelines.ready(&a.texts))
    }

    /// Whether every target the view's frames taking input draw into can ease, light rows, probe,
    /// and answer queries: whether what those use compiled.
    pub(super) fn answers_ready(&self, inner: &Inner) -> bool {
        self.asked.iter().filter(|a| a.input).all(|a| inner.pipelines.ready(&a.answering))
    }
}

/// What a scene's frames use: what they draw with, their text, what changes need, what lights rows,
/// and what input needs.
#[derive(Default)]
struct Stages {
    draw: Vec<Asked>,
    text: Vec<Asked>,
    changes: Vec<Asked>,
    lit: Vec<Asked>,
    input: Vec<Asked>,
}

/// What frames of `scene` into `format` with `samples` per pixel use, but for each mark's channels,
/// which compile for what they read.
fn stages(scene: &Scene, format: wgpu::TextureFormat, samples: u32) -> Stages {
    let any = |test: fn(&Mark) -> bool| scene.marks.iter().any(test);
    let draw = |shader| Asked::Shader(Variant::draw(shader, format, samples));
    let compute = |shader, entry| Asked::Shader(Variant::compute(shader, entry));
    let mut stages = Stages {
        draw: vec![draw(Shader::Backdrop)],
        changes: vec![compute(Shader::Evaluate, "ease"), compute(Shader::Freeze, "gather")],
        ..Stages::default()
    };
    let controls = scene.controls;
    let diagram = matches!(scene.space, Space::Diagram(_));
    // The overlay writes a plot's axes, the title, and the legends, and the box and the connection a
    // gesture draws.
    let legends = any(|m| m.style().legend.is_some() && m.style().color.is_some());
    let written = matches!(scene.space, Space::Plot(_)) || scene.title.is_some() || scene.subtitle.is_some() || legends;
    if written || controls.select_box || controls.connect {
        stages.text.push(draw(Shader::Overlay));
    }
    // The distance fields of the text frames set are made before they draw.
    let labeled = any(|m| {
        m.style().label.is_some()
            || matches!(m, Mark::Vertices(v) if v.ports.iter().any(|(_, port)| port.label.is_some()))
    });
    if written || labeled {
        stages.text.extend(["columns", "rows"].map(|e| compute(Shader::Fields, e)));
    }
    if any(|m| m.style().label.is_some()) && !diagram {
        stages.text.extend([compute(Shader::Labels, "clear_cells"), compute(Shader::Labels, "reset_cells")]);
    }
    if any(|m| m.style().shadow) {
        stages.draw.push(Asked::Shader(Variant::draw(Shader::Shade, SHADE, 1)));
    }
    if any(Mark::flows) {
        stages.draw.push(compute(Shader::Evaluate, "travel"));
        stages.changes.push(compute(Shader::Evaluate, "carry"));
    }
    if any(|m| matches!(m, Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_))) {
        stages.draw.extend(["scan_blocks", "scan_sums", "add_sums"].map(|e| compute(Shader::Lists, e)));
    }
    for mark in &scene.marks {
        mark_stages(mark, scene, format, samples, &mut stages);
    }
    stages
}

/// What `mark` adds to the stages: its draw and compute passes, for the path a stroke mark runs
/// along or an area's triangles' geometry; its lit rows, which hover, selection, and the ends of
/// edges light; its probes; its labels.
fn mark_stages(mark: &Mark, scene: &Scene, format: wgpu::TextureFormat, samples: u32, stages: &mut Stages) {
    let draw = |shader| Variant::draw(shader, format, samples);
    let compute = |shader, entry| Asked::Shader(Variant::compute(shader, entry));
    let style = mark.style();
    let primitive = mark.kind().primitive().code();
    let path = mark.path(&scene.space).unwrap_or(PATH_ENDS);
    let (shader, cast, lit) = match mark {
        Mark::Vertices(v) => {
            if let Marker::Wgsl { source, .. } = &v.marker {
                // A custom marker's WGSL follows its shader's.
                let custom =
                    |shader, format, samples| Asked::Custom(source.clone(), Variant::draw(shader, format, samples));
                stages.draw.push(custom(Shader::PointsCustom, format, samples));
                stages.lit.push(custom(Shader::PointsCustomFocus, format, samples));
                if style.shadow {
                    stages.draw.push(custom(Shader::PointsCustomCast, SHADE, 1));
                }
                (None, None, None)
            } else {
                (Some(Shader::Points), Some(Shader::PointsCast), Some(Shader::PointsFocus))
            }
        }
        Mark::Faces(_) => (Some(Shader::Triangles), Some(Shader::TrianglesCast), None),
        Mark::Areas(_) => (Some(Shader::Areas), None, Some(Shader::AreasFocus)),
        Mark::Edges(_) | Mark::Lines(_) => {
            (Some(Shader::Strokes), Some(Shader::StrokesCast), Some(Shader::StrokesFocus))
        }
    };
    stages.draw.extend(shader.map(|s| Asked::Shader(draw(s).path(path))));
    stages.lit.extend(lit.map(|s| Asked::Shader(draw(s).path(path))));
    if style.shadow {
        stages.draw.extend(cast.map(|s| Asked::Shader(Variant::draw(s, SHADE, 1).path(path))));
    }
    let bounds = match mark {
        Mark::Vertices(_) => "points",
        Mark::Areas(_) => "areas",
        _ => "strokes",
    };
    stages.draw.push(Asked::Shader(Variant::compute(Shader::Bounds, bounds).path(path)));
    // Rows running through different numbers of segments, or areas of different numbers of
    // triangles, are numbered by a list.
    if matches!(mark, Mark::Edges(_)) || path == PATH_GEOMETRY {
        stages.draw.extend(
            ["count_segments", "write_segments"].map(|e| Asked::Shader(Variant::compute(Shader::Lists, e).path(path))),
        );
    }
    // One program answers the hover, the queries, and the depth under the pointer for the mark's
    // geometry: any row drawn can be located, whether or not it picks.
    stages.input.push(Asked::Shader(Variant::probe(pipelines::probe(samples), primitive).path(path)));
    if style.label.is_some() {
        // In a diagram, only the first label pass runs.
        let labels = if matches!(scene.space, Space::Diagram(_)) { &LABELS[..1] } else { &LABELS[..] };
        stages.text.push(Asked::Shader(draw(Shader::Glyphs).path(path)));
        stages.text.extend(labels.iter().map(|e| Asked::Shader(Variant::compute(Shader::Labels, e).path(path))));
        if style.label.as_ref().is_some_and(|l| l.max.is_some()) && !matches!(scene.space, Space::Diagram(_)) {
            stages.text.extend(SELECT.map(|e| compute(Shader::Labels, e)));
        }
    }
    match mark {
        Mark::Faces(_) => stages.draw.push(compute(Shader::Normals, "accumulate")),
        Mark::Vertices(vertices) => {
            if !vertices.ports.is_empty() {
                stages.draw.push(Asked::Shader(draw(Shader::PointsPorts)));
            }
            if vertices.ports.iter().any(|(_, port)| port.label.is_some()) {
                stages.text.push(Asked::Shader(draw(Shader::GlyphsPorts)));
            }
        }
        Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_) => {}
    }
}
