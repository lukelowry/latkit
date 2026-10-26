//! The pipelines a scene uses, requested when the scene is shown, in three urgency tiers.
//!
//! Draw: for each kind of mark, its draw pipeline and the compute passes it needs (a stroke mark's
//! for the path it follows), and each mark's channels for what they read. Text: labels, glyphs, the
//! distance fields text is set in, and the overlay. Answer: the passes that transitions and comet
//! carry use, the lit rows' draws, and for frames that take input, each kind of mark's probe
//! program, which answers hover, picks, box selection, and row location.
//!
//! The GPU compiles them through its queue, most urgent first ([`crate::gpu::pipelines`]). The view
//! draws once its draw pipelines are ready, adds text once those are, and lights rows, probes, and
//! answers queries once the rest are. So no frame waits on a compile, and nothing compiles at first
//! use. Pipelines the scene never uses are never requested. A picture takes no input: it requests
//! everything it draws with, text, transitions, and lit rows at draw urgency, and draws once all of
//! them are ready.

use super::View;
use crate::gpu::Inner;
use crate::gpu::pipelines::{self, Asked, Urgency, Variant};
use crate::gpu::shaders::{PATH_ENDS, PATH_GEOMETRY, Shader};
use crate::{Mark, Marker, Scene, Space};

/// The passes of the selection that caps a mark's label count.
const SELECT: [&str; 4] = ["select_start", "select_count", "select_find", "select_cut"];

/// The passes that place each labeled mark's labels once its candidates are measured. A diagram's
/// labels need no placement.
pub(super) const PLACING: [&str; 5] = ["claim", "decide", "occupy", "ask", "fade"];

/// The pipelines a view requested for frames into one target, with or without input, by tier: draw,
/// text, and answer (transitions, lit rows, probes, and queries).
pub(super) struct Asking {
    target: (wgpu::TextureFormat, u32),
    input: bool,
    drawing: Vec<Asked>,
    texts: Vec<Asked>,
    answering: Vec<Asked>,
}

/// The pipelines nearly every scene draws with, which the GPU compiles ahead for later views, in
/// this order: channels, strokes between endpoints and through geometry, points and the backdrop,
/// their bounds and lists, ports, then text.
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
    needs.push(Variant::compute(Shader::Candidates, "candidates"));
    needs.extend(["columns", "rows"].map(|e| Variant::compute(Shader::Fields, e)));
    needs.into_iter().map(Asked::Shader).collect()
}

impl View {
    /// Requests the pipelines the scene's frames into `target` use, with or without `input`, each
    /// at its urgency, on the first call for that pair. Every call also requests each mark's
    /// channel pipeline, whose variant depends on what the channels read, known once the data is.
    /// Each finished compile wakes the view. Returns the request's index in `asked`.
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
            // Several marks can need the same pipeline; request each once.
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

    /// Each mark's channel pipeline, built for what its channels read. Before its data is known,
    /// they read neither joins, samples, nor the view.
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

    /// Whether frames into `format` at `samples` per pixel, with or without `input`, can draw now:
    /// whether their draw pipelines are compiled.
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

    /// Whether frames can draw text: labels, their glyphs and distance fields, and the overlay.
    /// Until then frames draw without text, and labels fade in once it is ready, as after any
    /// change.
    pub(super) fn texts_ready(&self, inner: &Inner) -> bool {
        self.asked.iter().all(|a| inner.pipelines.ready(&a.texts))
    }

    /// Whether, for every target that frames taking input draw into, the pipelines for easing, lit
    /// rows, probes, and queries are compiled.
    pub(super) fn answers_ready(&self, inner: &Inner) -> bool {
        self.asked.iter().filter(|a| a.input).all(|a| inner.pipelines.ready(&a.answering))
    }
}

/// The pipelines a scene's frames use, by stage: drawing, text, transitions, lit rows, and input.
#[derive(Default)]
struct Stages {
    draw: Vec<Asked>,
    text: Vec<Asked>,
    changes: Vec<Asked>,
    lit: Vec<Asked>,
    input: Vec<Asked>,
}

/// The pipelines frames of `scene` into `format` at `samples` per pixel use, except each mark's
/// channel pipeline, which depends on what its channels read.
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
    // The overlay draws a plot's axes, the title, the legends, and the selection box and connection
    // line that gestures draw.
    let legends = any(|m| m.style().legend.is_some() && m.style().color.is_some());
    let written = matches!(scene.space, Space::Plot(_)) || scene.title.is_some() || scene.subtitle.is_some() || legends;
    if written || controls.select_box || controls.connect {
        stages.text.push(draw(Shader::Overlay));
    }
    // The distance fields of text a frame sets are built before the frame draws.
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
    if any(Mark::flows) {
        stages.draw.push(compute(Shader::Evaluate, "travel"));
        stages.changes.push(compute(Shader::Evaluate, "carry"));
    }
    if any(|m| matches!(m, Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_))) {
        stages.draw.extend(["scan_blocks", "scan_sums", "add_sums"].map(|e| compute(Shader::Lists, e)));
    }
    // Any table may become paged: its data can outgrow the budget, or a mark can give a priority.
    if !scene.marks.is_empty() {
        stages.draw.push(compute(Shader::Lists, "expand_runs"));
    }
    for mark in &scene.marks {
        mark_stages(mark, scene, format, samples, &mut stages);
    }
    stages
}

/// Adds `mark`'s pipelines to `stages`: its draw and compute passes, for the path a stroke follows
/// or an area's triangle geometry; its lit-row draw, for the rows that hover, selection, and edge
/// endpoints light; its probe; and its labels.
fn mark_stages(mark: &Mark, scene: &Scene, format: wgpu::TextureFormat, samples: u32, stages: &mut Stages) {
    let draw = |shader| Variant::draw(shader, format, samples);
    let compute = |shader, entry| Asked::Shader(Variant::compute(shader, entry));
    let style = mark.style();
    let primitive = mark.kind().primitive().code();
    let path = mark.path(&scene.space).unwrap_or(PATH_ENDS);
    let (shader, lit) = match mark {
        Mark::Vertices(v) => {
            if let Marker::Wgsl { source, .. } = &v.marker {
                // A custom marker's WGSL compiles together with its shader's.
                let custom =
                    |shader, format, samples| Asked::Custom(source.clone(), Variant::draw(shader, format, samples));
                stages.draw.push(custom(Shader::PointsCustom, format, samples));
                stages.lit.push(custom(Shader::PointsCustomFocus, format, samples));
                (None, None)
            } else {
                (Some(Shader::Points), Some(Shader::PointsFocus))
            }
        }
        Mark::Faces(_) => (Some(Shader::Triangles), None),
        Mark::Areas(_) => (Some(Shader::Areas), Some(Shader::AreasFocus)),
        Mark::Edges(_) | Mark::Lines(_) => (Some(Shader::Strokes), Some(Shader::StrokesFocus)),
    };
    stages.draw.extend(shader.map(|s| Asked::Shader(draw(s).path(path))));
    stages.lit.extend(lit.map(|s| Asked::Shader(draw(s).path(path))));
    let bounds = match mark {
        Mark::Vertices(_) => "points",
        Mark::Areas(_) => "areas",
        _ => "strokes",
    };
    stages.draw.push(Asked::Shader(Variant::compute(Shader::Bounds, bounds).path(path)));
    // A list numbers rows with differing segment counts, and areas with differing triangle counts.
    if matches!(mark, Mark::Edges(_)) || path == PATH_GEOMETRY {
        stages.draw.extend(
            ["count_segments", "write_segments"].map(|e| Asked::Shader(Variant::compute(Shader::Lists, e).path(path))),
        );
    }
    // One probe program answers hover, queries, and the depth under the pointer for the mark's
    // geometry. Every mark gets one, so any drawn row can be located, pickable or not.
    stages.input.push(Asked::Shader(Variant::probe(pipelines::probe(samples), primitive).path(path)));
    if style.label.is_some() {
        // Measuring label candidates and drawing glyphs are built for the mark's primitive. A
        // diagram's labels need no placement.
        stages.text.push(Asked::Shader(draw(Shader::Glyphs).path(path).primitive(primitive)));
        stages
            .text
            .push(Asked::Shader(Variant::compute(Shader::Candidates, "candidates").path(path).primitive(primitive)));
        if !matches!(scene.space, Space::Diagram(_)) {
            stages.text.extend(PLACING.map(|e| Asked::Shader(Variant::compute(Shader::Labels, e).path(path))));
        }
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
