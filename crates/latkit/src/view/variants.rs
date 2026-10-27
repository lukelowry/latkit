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
//!
//! Each pipeline is named once, here: the passes that serve every mark alike as constants, and a
//! mark's own through [`MarkVariants`]. The view requests and runs them by these same names, so it
//! runs only what it requested.

use std::sync::Arc;

use super::View;
use super::marks::Shown;
use crate::gpu::Inner;
use crate::gpu::atlas::FIELDS;
use crate::gpu::pipelines::{self, Asked, Urgency, Variant};
use crate::gpu::shaders::{PATH_ENDS, PATH_GEOMETRY, Shader};
use crate::scene::mark::MarkKind;
use crate::{Mark, Marker, Scene, Space};

/// Writes the word of each drawn row of a paged mark from its runs.
pub(super) const EXPAND_RUNS: Variant = Variant::compute(Shader::Lists, "expand_runs");

/// The scan of a segment list's counts into each row's first instance.
pub(super) const SCAN: [Variant; 3] = [
    Variant::compute(Shader::Lists, "scan_blocks"),
    Variant::compute(Shader::Lists, "scan_sums"),
    Variant::compute(Shader::Lists, "add_sums"),
];

/// Eases a mark in transition from its frozen words toward its settled ones.
pub(super) const EASE: Variant = Variant::compute(Shader::Evaluate, "ease");

/// Moves comets along their rows at this frame's flow.
pub(super) const TRAVEL: Variant = Variant::compute(Shader::Evaluate, "travel");

/// Carries comets' travel over to the rows a transition moved.
pub(super) const CARRY: Variant = Variant::compute(Shader::Evaluate, "carry");

/// Freezes the words a transition eases from.
pub(super) const GATHER: Variant = Variant::compute(Shader::Freeze, "gather");

/// Sums each face's normal into its corners.
pub(super) const NORMALS: Variant = Variant::compute(Shader::Normals, "accumulate");

/// What a mark's pipelines are specialized for: its kind, the `PATH_` code its rows follow, and a
/// custom marker's WGSL.
#[derive(Clone, Copy)]
pub(super) struct MarkVariants<'a> {
    kind: MarkKind,
    path: u32,
    custom: Option<&'a Arc<str>>,
}

impl<'a> MarkVariants<'a> {
    /// The variants `mark` uses in `space`, requested before it compiles.
    fn of(mark: &'a Mark, space: &Space) -> MarkVariants<'a> {
        let custom = match mark {
            Mark::Vertices(vertices) => match &vertices.marker {
                Marker::Wgsl { source, .. } => Some(source),
                _ => None,
            },
            _ => None,
        };
        MarkVariants { kind: mark.kind(), path: mark.path(space), custom }
    }

    /// The variants `shown` runs.
    pub(super) fn shown(shown: &'a Shown) -> MarkVariants<'a> {
        let custom = shown.compiled.as_ref().and_then(|c| c.drawing.markers.custom.as_ref());
        MarkVariants { kind: shown.kind(), path: shown.path(), custom }
    }

    fn primitive(self) -> u32 {
        self.kind.primitive().code()
    }

    /// The shader drawing its rows, or with `lit`, the rows its focus lights; `None` for a face's
    /// lit rows.
    pub(super) fn shader(self, lit: bool) -> Option<Shader> {
        let (every, focus) = self.kind.shaders(self.custom.is_some());
        if lit { focus } else { Some(every) }
    }

    /// The pipeline drawing its rows, or with `lit`, the rows its focus lights. A custom marker's
    /// WGSL compiles together with its shader's.
    pub(super) fn draw(self, lit: bool, format: wgpu::TextureFormat, samples: u32) -> Option<Asked> {
        let variant = Variant::draw(self.shader(lit)?, format, samples).path(self.path);
        Some(match self.custom {
            Some(source) => Asked::Custom(source.clone(), variant),
            None => Asked::Shader(variant),
        })
    }

    /// The pass measuring its rows' extents for a fit; `None` for edges and faces.
    pub(super) fn bounds(self) -> Option<Variant> {
        Some(Variant::compute(Shader::Bounds, self.kind.bounds()?).path(self.path))
    }

    /// Whether a list may number its instances, for rows whose counts differ: edges between ends,
    /// which may pass through bends, follow great circles, or bow into lanes; and every path
    /// through geometry, including areas' triangles.
    fn listed(self) -> bool {
        self.path == PATH_GEOMETRY || (self.kind == MarkKind::Edges && self.path == PATH_ENDS)
    }

    /// The passes counting each row's instances into its list, then writing them, around a
    /// [`SCAN`].
    pub(super) fn segments(self) -> [Variant; 2] {
        ["count_segments", "write_segments"].map(|entry| Variant::compute(Shader::Lists, entry).path(self.path))
    }

    /// Its program for the probe `shader`, which answers hover, queries, and the depth under the
    /// pointer for its geometry.
    pub(super) fn probe(self, shader: Shader) -> Variant {
        Variant::probe(shader, self.primitive()).path(self.path)
    }

    /// The texts pass, which finds the texts its labels need at their anchors.
    pub(super) fn texts(self) -> Variant {
        Variant::compute(Shader::Texts, "texts").path(self.path).primitive(self.primitive())
    }

    /// The pipeline drawing its labels' glyphs.
    pub(super) fn glyphs(self, format: wgpu::TextureFormat, samples: u32) -> Variant {
        Variant::draw(Shader::Glyphs, format, samples).path(self.path).primitive(self.primitive())
    }
}

/// The pipelines a view requested for frames into one target, with or without input, by tier: draw,
/// text, and answer (transitions, lit rows, probes, and queries).
pub(super) struct Asking {
    target: (wgpu::TextureFormat, u32),
    input: bool,
    drawing: Vec<Asked>,
    texts: Vec<Asked>,
    answering: Vec<Asked>,
}

/// The pipelines nearly every scene draws with, which the GPU compiles ahead for later views:
/// channels, edges, lines along paths, vertices and their labels, and the backdrop, ports, and
/// overlay.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub(crate) fn common(format: wgpu::TextureFormat, samples: u32) -> Vec<Asked> {
    let draw = |shader| Asked::Shader(Variant::draw(shader, format, samples));
    let marks = [(MarkKind::Edges, PATH_ENDS), (MarkKind::Lines, PATH_GEOMETRY), (MarkKind::Vertices, PATH_ENDS)]
        .map(|(kind, path)| MarkVariants { kind, path, custom: None });
    let mut needs = vec![Asked::Shader(Variant::channels(pipelines::Reads::NONE))];
    needs.extend(marks.iter().filter_map(|m| m.draw(false, format, samples)));
    needs.push(draw(Shader::Backdrop));
    for m in &marks {
        needs.extend(m.bounds().map(Asked::Shader));
        if m.listed() {
            needs.extend(m.segments().map(Asked::Shader));
        }
    }
    needs.extend(SCAN.map(Asked::Shader));
    needs.extend([draw(Shader::PointsPorts), draw(Shader::Overlay), draw(Shader::GlyphsPorts)]);
    let vertices = marks[2];
    needs.extend([vertices.glyphs(format, samples), vertices.texts()].map(Asked::Shader));
    needs.extend(FIELDS.map(Asked::Shader));
    needs
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
    /// Until then frames draw without text.
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
    let any = |test: &dyn Fn(&Mark) -> bool| scene.marks.iter().any(test);
    let draw = |shader| Asked::Shader(Variant::draw(shader, format, samples));
    let mut stages = Stages {
        draw: vec![draw(Shader::Backdrop)],
        changes: vec![Asked::Shader(EASE), Asked::Shader(GATHER)],
        ..Stages::default()
    };
    let controls = scene.controls;
    // The overlay draws a plot's axes, the title, the legends, and the selection box and connection
    // line that gestures draw.
    let legends = any(&|m| m.style().legend.is_some() && m.style().color.is_some());
    let written = matches!(scene.space, Space::Plot(_)) || scene.title.is_some() || scene.subtitle.is_some() || legends;
    if written || controls.select_box || controls.connect {
        stages.text.push(draw(Shader::Overlay));
    }
    // The distance fields of text a frame sets are built before the frame draws.
    let labeled = any(&|m| {
        m.style().label.is_some()
            || matches!(m, Mark::Vertices(v) if v.ports.iter().any(|(_, port)| port.label.is_some()))
    });
    if written || labeled {
        stages.text.extend(FIELDS.map(Asked::Shader));
    }
    if any(&Mark::flows) {
        stages.draw.push(Asked::Shader(TRAVEL));
        stages.changes.push(Asked::Shader(CARRY));
    }
    if any(&|m| MarkVariants::of(m, &scene.space).listed()) {
        stages.draw.extend(SCAN.map(Asked::Shader));
    }
    // Any table may become paged: its data can outgrow the budget, or a mark can give a priority.
    if !scene.marks.is_empty() {
        stages.draw.push(Asked::Shader(EXPAND_RUNS));
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
    let variants = MarkVariants::of(mark, &scene.space);
    stages.draw.extend(variants.draw(false, format, samples));
    stages.lit.extend(variants.draw(true, format, samples));
    stages.draw.extend(variants.bounds().map(Asked::Shader));
    if variants.listed() {
        stages.draw.extend(variants.segments().map(Asked::Shader));
    }
    // One probe program answers hover, queries, and the depth under the pointer for the mark's
    // geometry. Every mark gets one, so any drawn row can be located, pickable or not.
    stages.input.push(Asked::Shader(variants.probe(pipelines::probe(samples))));
    if mark.style().label.is_some() {
        stages.text.extend([variants.glyphs(format, samples), variants.texts()].map(Asked::Shader));
    }
    match mark {
        Mark::Faces(_) => stages.draw.push(Asked::Shader(NORMALS)),
        Mark::Vertices(vertices) => {
            if !vertices.ports.is_empty() {
                stages.draw.push(Asked::Shader(Variant::draw(Shader::PointsPorts, format, samples)));
            }
            if vertices.ports.iter().any(|(_, port)| port.label.is_some()) {
                stages.text.push(Asked::Shader(Variant::draw(Shader::GlyphsPorts, format, samples)));
            }
        }
        Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Edges, Lines, Plane, Vertices};

    #[test]
    fn only_marks_that_frame_a_fit_ask_for_a_bounds_pass() {
        let scene = Scene::new(Plane::default())
            .draw(Vertices::of("g", "V"))
            .draw(Edges::of("g", "E").ends("from", "to"))
            .draw(Lines::of("g", "L"));
        let Stages { draw, .. } = stages(&scene, wgpu::TextureFormat::Rgba8Unorm, 1);
        let asks = |entry, path| draw.contains(&Asked::Shader(Variant::compute(Shader::Bounds, entry).path(path)));
        assert!(asks("points", PATH_ENDS), "vertices frame a fit");
        assert!(asks("strokes", PATH_GEOMETRY), "so do lines along their paths");
        assert!(!asks("strokes", PATH_ENDS), "edges lie between the vertices that frame them");
    }
}
