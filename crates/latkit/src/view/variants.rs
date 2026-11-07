//! The pipelines a scene uses, by what its frames use them for: each [`Stage`].
//!
//! Draw: for each kind of mark, its draw pipeline and the raster passes it needs (for a stroke
//! mark, those for the path it follows), and each mark's channel pipeline for what its channels
//! read. Text: labels, glyphs, the distance fields text is set in, and the overlay. Changes: the
//! passes that transitions and comet carry use. Lit: the lit rows' draws. Layers: the opaque draws
//! and height sorts frames use where depth varies. Input: each kind of mark's probe program, which
//! answers hover, picks, box selection, and row location.
//!
//! The GPU compiles them through its queue, most urgent first ([`crate::gpu::pipelines`]). The view
//! draws once its draw pipelines are ready, and does without every other stage until its pipelines
//! are: frames show no text, no easing, no glow, and no layers, and probes and queries wait. Draw
//! recording never creates a missing pipeline, although a queued WebGL compile can still block
//! the browser thread. A view is complete once the stages
//! its frames draw with are ready, which never includes input. Pipelines the scene never uses are
//! never requested, and layers only once depth varies. A picture takes no input, and requests
//! everything it draws with at draw urgency.
//!
//! Each pipeline is named once, here: the passes shared by every mark as constants, and each mark's
//! own through [`MarkVariants`]. The view requests and runs them by these same names, so it runs
//! only what it requested.

use std::sync::Arc;

use super::View;
use super::marks::Shown;
use crate::gpu::Inner;
use crate::gpu::atlas::FIELDS;
use crate::gpu::pipelines::{Asked, Projection, Urgency, Variant};
use crate::gpu::shaders::{PATH_BENDS, PATH_ENDS, PATH_GEOMETRY, PATH_POLES, Shader};
use crate::scene::mark::MarkKind;
use crate::{Action, Mark, Marker, Scene, Space};

/// Writes the word of each drawn row of a paged mark from its runs.
pub(super) const EXPAND_RUNS: Variant = Variant::raster(Shader::Lists, "expand_runs");

/// The scan of a list's counts: a segment list's into each row's first instance, or a height
/// order's into where each digit's instances go.
pub(super) const SCAN: [Variant; 2] =
    [Variant::raster(Shader::Words, "scan_totals"), Variant::raster(Shader::Words, "scan")];

/// The passes sorting a height order by one digit of its keys, around a [`SCAN`]: counting each
/// block's instances by digit, then moving them in order.
pub(super) const DIGIT_PASSES: [Variant; 2] =
    [Variant::raster(Shader::Order, "histogram"), Variant::raster(Shader::OrderScatter, "scatter")];

/// Eases a mark in transition from its frozen words toward its settled ones.
pub(super) const EASE: Variant = Variant::raster(Shader::StateNarrow, "ease");

/// Moves comets along their rows at this frame's flow.
pub(super) const TRAVEL: Variant = Variant::raster(Shader::StateNarrow, "travel");

/// Carries comets' travel over to the rows a transition moved.
pub(super) const CARRY: Variant = Variant::raster(Shader::StateNarrow, "carry");

/// Freezes the words a transition eases from.
pub(super) const GATHER: Variant = Variant::raster(Shader::StateNarrow, "freeze");

/// Copies the pages the state passes wrote from their scratch into the arena.
pub(super) const PAGES: Variant = Variant::raster(Shader::WordsGather, "gather");

pub(super) use crate::gpu::pipelines::Draw;

/// What a mark's pipelines are specialized for: its kind, the `PATH_` code its rows follow, and a
/// custom marker's WGSL.
#[derive(Clone, Copy)]
pub(super) struct MarkVariants<'a> {
    kind: MarkKind,
    path: u32,
    projection: Projection,
    painted: bool,
    marker: u32,
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
        MarkVariants {
            kind: mark.kind(),
            path: mark.path(space),
            projection: Projection::of(space),
            painted: mark.measures_paths(),
            marker: match mark {
                Mark::Vertices(vertices) => vertices.marker.code(),
                _ => 0,
            },
            custom,
        }
    }

    /// The variants `shown` runs.
    pub(super) fn shown(shown: &'a Shown, space: &Space) -> MarkVariants<'a> {
        let custom = shown.compiled.as_ref().and_then(|c| c.drawing.markers.custom.as_ref());
        MarkVariants {
            kind: shown.kind(),
            path: shown.path(),
            projection: Projection::of(space),
            painted: shown.mark.measures_paths(),
            marker: match &shown.mark {
                Mark::Vertices(vertices) => vertices.marker.code(),
                _ => 0,
            },
            custom,
        }
    }

    fn primitive(self) -> u32 {
        self.kind.primitive().code()
    }

    /// The shader for draw `draw`.
    pub(super) fn shader(self, draw: Draw) -> Shader {
        let custom = self.custom.is_some();
        let (every, focus) = self.kind.shaders(custom);
        match draw {
            Draw::Rows => every,
            Draw::Lit => focus,
            Draw::Opaque => self.kind.opaque_shader(custom),
        }
    }

    /// The pipeline for draw `draw`. A custom marker's WGSL compiles together with its shader's.
    pub(super) fn draw(self, draw: Draw, format: wgpu::TextureFormat, samples: u32) -> Asked {
        let variant = Variant::draw(self.shader(draw), format, samples)
            .mode(draw)
            .path(self.path)
            .projection(self.projection)
            .painted(self.painted)
            .marker(self.marker);
        match self.custom {
            Some(source) => Asked::Custom(source.clone(), variant),
            None => Asked::Shader(variant),
        }
    }

    /// The pass measuring its rows' extents for a fit. `None` for edges.
    pub(super) fn bounds(self) -> Option<Variant> {
        Some(Variant::raster(Shader::Bounds, self.kind.bounds()?).path(self.path).projection(self.projection))
    }

    /// Whether a list may number its instances, for rows whose counts differ: edges between ends
    /// (which may pass through bends, follow great circles, or bow into lanes), and every path
    /// through geometry, including areas' triangles.
    fn listed(self) -> bool {
        self.path == PATH_GEOMETRY || (self.kind == MarkKind::Edges && matches!(self.path, PATH_ENDS | PATH_BENDS))
    }

    /// The passes counting each row's instances into its list, then writing them, around a
    /// [`SCAN`].
    pub(super) fn segments(self, measured: bool) -> [Variant; 2] {
        [
            Variant::raster(Shader::Lists, "count_segments").path(self.path).projection(self.projection),
            if measured {
                Variant::raster(Shader::Lists, "segments").path(self.path).projection(self.projection)
            } else if self.kind == MarkKind::Areas {
                Variant::raster(Shader::Lists, "area_segments")
            } else {
                Variant::raster(Shader::Lists, "segments_unmeasured")
            },
        ]
    }

    /// The pass keying each instance by its height before [`DIGIT_PASSES`] sort its height order.
    pub(super) fn height_keys(self) -> Variant {
        Variant::raster(Shader::Lists, "height_keys").path(self.path).projection(self.projection)
    }

    /// Its program for the probe `shader`, which answers hover, queries, and the depth under the
    /// pointer for its geometry.
    pub(super) fn probe(self, shader: Shader) -> Variant {
        Variant::probe(shader, self.primitive()).path(self.path).projection(self.projection)
    }

    /// The label passes: `claim`, which claims the screen cells its labels would cover, then
    /// `texts`, which finds the texts needed by the labels that kept their cells.
    pub(super) fn label_passes(self) -> [Variant; 7] {
        [
            Variant::raster(Shader::Metadata, "metadata")
                .path(self.path)
                .projection(self.projection)
                .primitive(self.primitive()),
            Variant::raster(Shader::Claims, "claim"),
            Variant::raster(Shader::Requests, "request"),
            Variant::raster(Shader::TextCodes, "bits"),
            Variant::raster(Shader::TextCodes, "counts"),
            Variant::raster(Shader::TextCodes, "gather"),
            Variant::raster(Shader::TextCodes, "seen"),
        ]
    }

    /// The pipeline drawing its labels' glyphs.
    pub(super) fn glyphs(self, format: wgpu::TextureFormat, samples: u32) -> Variant {
        Variant::draw(Shader::Glyphs, format, samples)
            .path(self.path)
            .projection(self.projection)
            .primitive(self.primitive())
    }
}

/// What a view's frames use pipelines for. A view asks for each stage at its own urgency, and its
/// frames do without a stage until its pipelines land.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Stage {
    /// The marks. Until these land, the view draws nothing new.
    Draw,
    /// Labels, titles, legends, and the overlay.
    Text,
    /// Transitions: freezing, easing, and carrying comets.
    Changes,
    /// The glow of selected, hovered, and related rows.
    Lit,
    /// Drawing opaque pixels first and rows lowest first, where depth varies.
    Layers,
    /// Probes and queries, which draw nothing.
    Input,
}

impl Stage {
    const ALL: [Stage; 6] = [Stage::Draw, Stage::Text, Stage::Changes, Stage::Lit, Stage::Layers, Stage::Input];

    /// How soon a view asks for the stage. A picture takes no input, and asks for everything it
    /// draws with at draw urgency.
    fn urgency(self, input: bool) -> Urgency {
        match self {
            Stage::Draw => Urgency::Draw,
            _ if !input => Urgency::Draw,
            Stage::Text => Urgency::Text,
            Stage::Changes | Stage::Lit | Stage::Layers | Stage::Input => Urgency::Answer,
        }
    }
}

/// A set of stages.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(super) struct StageSet(u8);

impl StageSet {
    /// The set with `stage` added.
    pub(super) fn with(self, stage: Stage) -> StageSet {
        StageSet(self.0 | 1 << stage as u8)
    }

    pub(super) fn has(self, stage: Stage) -> bool {
        self.0 & 1 << stage as u8 != 0
    }

    /// Whether the two sets share a stage.
    pub(super) fn meets(self, other: StageSet) -> bool {
        self.0 & other.0 != 0
    }
}

/// Each stage's pipelines, for frames of one scene into one target.
#[derive(Default)]
struct Stages([Vec<Asked>; Stage::ALL.len()]);

impl Stages {
    fn of(&self, stage: Stage) -> &[Asked] {
        &self.0[stage as usize]
    }

    fn add(&mut self, stage: Stage, need: Asked) {
        self.0[stage as usize].push(need);
    }

    fn add_all(&mut self, stage: Stage, needs: impl IntoIterator<Item = Asked>) {
        self.0[stage as usize].extend(needs);
    }

    /// Keeps each stage's first request for a pipeline. Several marks can need the same one.
    fn dedupe(&mut self) {
        for needs in &mut self.0 {
            let mut seen = rustc_hash::FxHashSet::default();
            needs.retain(|need| seen.insert(need.clone()));
        }
    }
}

/// The pipelines a view requested for frames into one target, with or without input, by stage.
pub(super) struct Asking {
    target: (wgpu::TextureFormat, u32),
    input: bool,
    stages: Stages,
}

impl Asking {
    /// Whether frames ask for `stage`: input only when they take it, and layers only where depth
    /// varies (`deep`).
    fn asks(&self, stage: Stage, deep: bool) -> bool {
        match stage {
            Stage::Input => self.input,
            Stage::Layers => deep,
            _ => true,
        }
    }
}

impl View {
    /// Requests the pipelines the scene's frames into `target` use, with or without `input`, each
    /// stage at its urgency, on the first call for that pair. Layers are requested once depth varies.
    /// Every call also requests each mark's channel pipeline, whose variant depends on what the
    /// channels read, known once the data is. Each finished compile wakes the view. Returns the
    /// request's index in `asked`.
    pub(super) fn ask(&mut self, inner: &mut Inner, target: (wgpu::TextureFormat, u32), input: bool) -> usize {
        let device = &self.gpu.0.device;
        let deep = self.deep();
        let at = if let Some(at) = self.asked.iter().position(|a| a.target == target && a.input == input) {
            at
        } else {
            let asking = Asking {
                target,
                input,
                stages: stages(&self.scene, target.0, target.1, crate::gpu::state::State::shader(device)),
            };
            for stage in Stage::ALL.into_iter().filter(|&stage| stage != Stage::Layers && asking.asks(stage, deep)) {
                inner.pipelines.queue(asking.stages.of(stage), stage.urgency(input), &self.compile_waker);
            }
            self.asked.push(asking);
            self.asked.len() - 1
        };
        // A flat view never draws in layers, so it compiles nothing for them. Asking again is free.
        if deep {
            inner.pipelines.queue(
                self.asked[at].stages.of(Stage::Layers),
                Stage::Layers.urgency(input),
                &self.compile_waker,
            );
        }
        inner.pipelines.ask(device, &self.channels(), Urgency::Draw, &self.compile_waker);
        at
    }

    /// Each mark's channel pipeline, built for what its channels read. Before the mark's data is
    /// known, it reads no joins, samples, or view state.
    fn channels(&self) -> Vec<Asked> {
        let mut channels: Vec<Asked> = Vec::new();
        let shader = crate::gpu::state::State::shader(&self.gpu.0.device);
        for shown in &self.marks {
            let Some(compiled) = &shown.compiled else { continue };
            for entry in ["evaluate", "reduce"] {
                if entry == "reduce" && shown.reductions() == 0 {
                    continue;
                }
                let need = Asked::Kernel(compiled.kernel.clone(), Variant::state(shader, entry, shown.reads()));
                if !channels.contains(&need) {
                    channels.push(need);
                }
            }
        }
        if self.marks.iter().any(|m| m.reductions() > 0) {
            channels.push(Asked::Shader(Variant::raster(Shader::Words, "maximum")));
        }
        channels
    }

    /// Why the browser refused to build a pipeline the view asked for, if it refused one.
    pub(super) fn refusal(&self, inner: &Inner) -> Option<crate::Error> {
        let pipelines = &inner.pipelines;
        self.asked
            .iter()
            .flat_map(|a| Stage::ALL.map(|stage| a.stages.of(stage)))
            .find_map(|needs| pipelines.refused(needs))
            .or_else(|| pipelines.refused(&self.channels()))
    }

    /// The stages of request `at` whose pipelines have not all landed, and of those, the ones it
    /// asked for. Layers it has not asked for never land. Draw includes each mark's channels.
    pub(super) fn unready(&self, inner: &Inner, at: usize) -> (StageSet, StageSet) {
        let asking = &self.asked[at];
        let deep = self.deep();
        let (mut unready, mut asked) = (StageSet::default(), StageSet::default());
        for stage in Stage::ALL {
            let landed = inner.pipelines.ready(asking.stages.of(stage));
            let landed = landed && (stage != Stage::Draw || inner.pipelines.ready(&self.channels()));
            if !landed && (stage != Stage::Input || asking.input) {
                unready = unready.with(stage);
                if asking.asks(stage, deep) {
                    asked = asked.with(stage);
                }
            }
        }
        (unready, asked)
    }

    /// Whether frames draw in layers: depth varies, and the pipelines for it are ready. Opaque
    /// pixels then draw first, and rows that stand at different heights draw lowest first.
    pub(super) fn layered(&self) -> bool {
        self.deep() && self.can_use(Stage::Layers)
    }
}

/// The pipelines frames of `scene` into `format` at `samples` per pixel use, except each mark's
/// channel pipeline, which depends on what its channels read.
fn stages(scene: &Scene, format: wgpu::TextureFormat, samples: u32, state: Shader) -> Stages {
    let any = |test: &dyn Fn(&Mark) -> bool| scene.marks.iter().any(test);
    let draw = |shader| Asked::Shader(Variant::draw(shader, format, samples).projection(Projection::of(&scene.space)));
    let mut stages = Stages::default();
    stages.add(Stage::Draw, draw(Shader::Backdrop));
    if samples > 1 {
        stages.add(
            Stage::Input,
            Asked::Shader(Variant::draw(Shader::Backdrop, format, 1).projection(Projection::of(&scene.space))),
        );
    }
    if !scene.ease.is_zero() {
        stages
            .add_all(Stage::Changes, [Asked::Shader(EASE.state_kind(state)), Asked::Shader(GATHER.state_kind(state))]);
    }
    if !scene.marks.is_empty() {
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Pack, "pack")));
        stages.add(Stage::Draw, Asked::Shader(PAGES));
        if any(&|mark| matches!(mark, Mark::Edges(_))) {
            stages.add(Stage::Draw, Asked::Shader(Variant::raster(state, "ends")));
        }
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Words, "fill")));
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Words, "maximum")));
    }
    let controls = scene.controls;
    // The overlay draws a plot's axes, the title, the legends, and the selection box and connection
    // line that gestures draw.
    let legends = any(&|m| m.style().legend.is_some() && m.style().color.is_some());
    let written = matches!(scene.space, Space::Plot(_)) || scene.title.is_some() || legends;
    let draws = [Action::Box, Action::ZoomBox, Action::Connect].into_iter().any(|a| controls.gestures.any(a));
    if written || draws {
        stages.add(Stage::Text, draw(Shader::Overlay));
    }
    // The distance fields of text a frame sets are built before the frame draws.
    let labeled = any(&|m| m.style().label.is_some());
    if written || labeled {
        stages.add_all(Stage::Text, FIELDS.map(Asked::Shader));
    }
    if any(&Mark::flows) {
        stages.add(Stage::Draw, Asked::Shader(TRAVEL.state_kind(state)));
        stages.add(Stage::Changes, Asked::Shader(CARRY.state_kind(state)));
    }
    if any(&|m| MarkVariants::of(m, &scene.space).listed()) {
        stages.add_all(Stage::Draw, SCAN.map(Asked::Shader));
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Lists, "pack_counts")));
    }
    if any(&|m| MarkVariants::of(m, &scene.space).listed() && m.measures_paths()) {
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Lists, "pack_segments")));
        for entry in ["totals", "scan"] {
            stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Lengths, entry)));
        }
    }
    // Any table may become paged: its data can outgrow the budget, or a mark can give a priority.
    if !scene.marks.is_empty() {
        stages.add(Stage::Draw, Asked::Shader(EXPAND_RUNS));
    }
    for mark in &scene.marks {
        mark_stages(mark, scene, format, samples, &mut stages);
    }
    stages.dedupe();
    stages
}

/// Adds `mark`'s pipelines to `stages`: its draw and raster passes (for the path a stroke follows
/// or an area's triangle geometry), its lit-row draw (for the rows that hover, selection, and edge
/// endpoints light), its layering where depth varies, its probe, and its labels.
fn mark_stages(mark: &Mark, scene: &Scene, format: wgpu::TextureFormat, samples: u32, stages: &mut Stages) {
    let variants = MarkVariants::of(mark, &scene.space);
    stages.add(Stage::Draw, variants.draw(Draw::Rows, format, samples));
    stages.add(Stage::Lit, variants.draw(Draw::Lit, format, samples));
    // Depth varies only where the camera can tilt or the globe shows: on a plane or the earth.
    if matches!(scene.space, Space::Plane(_) | Space::Earth(_)) {
        stages.add(Stage::Layers, variants.draw(Draw::Opaque, format, samples));
        // Rows that can stand at different heights draw lowest first: a raised vertex mark's, and
        // those of edges and poles, which may end at one.
        let edges = matches!(mark, Mark::Edges(_)) && matches!(variants.path, PATH_ENDS | PATH_BENDS | PATH_POLES);
        if super::lists::raised(mark) || (edges && scene.marks.iter().any(super::lists::raised)) {
            stages.add(Stage::Layers, Asked::Shader(variants.height_keys()));
            stages.add(Stage::Layers, Asked::Shader(Variant::raster(Shader::Lists, "pack_order")));
            stages.add_all(Stage::Layers, [&DIGIT_PASSES[..], &SCAN[..]].concat().into_iter().map(Asked::Shader));
        }
    }
    stages.add_all(Stage::Draw, variants.bounds().map(Asked::Shader));
    if variants.listed() {
        stages.add_all(Stage::Draw, variants.segments(mark.measures_paths()).map(Asked::Shader));
    }
    // One probe program answers hover, queries, and the depth under the pointer for the mark's
    // geometry. Every mark gets one, so any drawn row can be located, pickable or not.
    for entry in ["probe", "finish"] {
        stages.add(Stage::Input, Asked::Shader(variants.probe(Shader::Probe).entry(entry)));
    }
    stages.add(Stage::Input, Asked::Shader(Variant::raster(Shader::Boxed, "boxed_row")));
    for entry in ["counts", "boxed"] {
        stages.add(Stage::Input, Asked::Shader(Variant::raster(Shader::QueryPack, entry)));
    }
    for entry in ["greatest", "fill"] {
        stages.add(Stage::Input, Asked::Shader(Variant::raster(Shader::Words, entry)));
    }
    stages.add_all(Stage::Input, SCAN.map(Asked::Shader));
    if samples > 1 {
        stages.add(Stage::Input, variants.draw(Draw::Opaque, format, 1));
    }
    if mark.style().label.is_some() {
        stages.add(Stage::Text, Asked::Shader(variants.glyphs(format, samples)));
        stages.add_all(Stage::Text, variants.label_passes().map(Asked::Shader));
        stages.add_all(Stage::Text, SCAN.map(Asked::Shader));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Edges, Event, Lines, Plane, Vertices};

    #[test]
    fn only_marks_that_frame_a_fit_ask_for_a_bounds_pass() {
        let scene = Scene::new(Plane::default())
            .draw(Vertices::of("g", "V"))
            .draw(Edges::of("g", "E").ends("from", "to"))
            .draw(Lines::of("g", "L"));
        let stages = stages(&scene, wgpu::TextureFormat::Rgba8Unorm, 1, Shader::StateNarrow);
        let draw = stages.of(Stage::Draw);
        let asks = |entry, path| {
            draw.contains(&Asked::Shader(
                Variant::raster(Shader::Bounds, entry).path(path).projection(Projection::Planar),
            ))
        };
        assert!(asks("points", PATH_ENDS), "vertices frame a fit");
        assert!(asks("strokes", PATH_GEOMETRY), "so do lines along their paths");
        assert!(!asks("strokes", PATH_ENDS), "edges lie between the vertices that frame them");
    }

    #[test]
    fn only_rows_that_can_stand_at_heights_ask_to_sort_by_height() {
        let sorting = |scene: Scene| {
            let stages = stages(&scene, wgpu::TextureFormat::Rgba8Unorm, 1, Shader::StateNarrow);
            let layering = stages.of(Stage::Layers);
            let keys = |path| {
                layering.contains(&Asked::Shader(
                    Variant::raster(Shader::Lists, "height_keys").path(path).projection(Projection::Planar),
                ))
            };
            [keys(PATH_ENDS), keys(PATH_POLES), keys(PATH_GEOMETRY)]
        };
        let flat = Scene::new(Plane::default()).draw(Vertices::of("g", "V")).draw(Edges::of("g", "E").ends("a", "b"));
        assert_eq!(sorting(flat), [false; 3], "rows on the ground keep their order");
        let raised = Scene::new(Plane::default())
            .draw(Vertices::of("g", "V").elevation(crate::field("z")))
            .draw(Edges::of("g", "V").poles())
            .draw(Lines::of("g", "L"));
        assert_eq!(sorting(raised), [true, true, false], "vertices and poles stand at heights, lines lie flat");
    }

    #[test]
    fn a_view_needing_a_refused_pipeline_says_why_once_and_draws_nothing() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")));
        assert!(view.ready_for(format, 1.0, false));
        view.events().for_each(drop);
        let need = view.asked[0].stages.of(Stage::Draw)[0].clone();
        gpu.0.lock().pipelines.refuse(&need, "the stage reads no such constant");
        let done = view.done();
        assert!(!view.ready_for(format, 1.0, false), "a view that can't draw what its scene says draws nothing");
        assert!(!view.ready_for(format, 1.0, false));
        let errors: Vec<_> =
            view.events().filter_map(|e| if let Event::Error(e) = e { Some(e) } else { None }).collect();
        assert_eq!(errors.len(), 1, "it says why once: {errors:?}");
        assert!(matches!(&errors[0], crate::Error::Unsupported(m) if m.contains(&need.label())), "{errors:?}");
        assert_eq!(done.take(), Some(Err(errors[0].clone())), "and what waited for it to be done fails");
        assert_eq!(view.done().take(), Some(Err(errors[0].clone())));
    }

    #[test]
    fn only_a_view_whose_depth_varies_asks_for_what_draws_in_layers() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let scene = Scene::new(Plane::default()).draw(Vertices::of("g", "V")).draw(Edges::of("g", "E").ends("a", "b"));
        let mut view = View::new(&gpu, scene);
        assert!(view.ready_for(format, 1.0, true));
        let layering = view.asked[0].stages.of(Stage::Layers).to_vec();
        assert!(!layering.is_empty(), "every mark has an opaque draw");
        // Straight down at a plane, marks draw in order: nothing waits for the layered draws.
        assert!(!gpu.0.lock().pipelines.ready(&layering), "a flat view asks for none of them");
        assert!(!view.waiting().compiling);
        view.set_camera(crate::Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 40.0, bearing: 0.0 });
        assert!(view.ready_for(format, 1.0, true));
        assert!(gpu.0.lock().pipelines.ready(&layering), "tilted, it asks for them");
    }

    #[test]
    fn a_view_waits_only_for_the_pipelines_its_frames_draw_with() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")));
        assert!(view.ready_for(format, 1.0, true));
        let of = |view: &View, stage| view.asked[0].stages.of(stage).to_vec();
        let (draw, lit, input) = (of(&view, Stage::Draw), of(&view, Stage::Lit), of(&view, Stage::Input));
        let hold = |needs: &[Asked]| needs.iter().for_each(|need| gpu.0.lock().pipelines.hold(need));
        let release = |needs: &[Asked]| needs.iter().for_each(|need| gpu.0.lock().pipelines.release(need));
        // Probes share reduction/fill kernels with drawing. Hold only the exclusive input
        // pipelines: already compiled shared pipelines cannot become pending again.
        let input: Vec<_> = input.into_iter().filter(|need| !draw.contains(need)).collect();
        hold(&input);
        assert!(view.ready_for(format, 1.0, true));
        assert!(!view.can_use(Stage::Input) && !view.waiting().compiling, "complete without its probes");
        assert!(view.compiling.is_some(), "a finished compile wakes it to probe");
        release(&input);
        // The glow is drawn only while a row is lit.
        hold(&lit);
        assert!(view.ready_for(format, 1.0, true));
        assert!(!view.waiting().compiling, "complete while nothing is lit");
        view.marks[0].lit.rows = 1;
        assert!(view.ready_for(format, 1.0, true));
        assert!(view.waiting().compiling, "incomplete while a lit row draws without its glow");
        release(&lit);
        // Without its draws, the view draws nothing new.
        hold(&draw);
        assert!(!view.ready_for(format, 1.0, true));
        assert!(view.waiting().compiling);
        release(&draw);
        assert!(view.ready_for(format, 1.0, true));
        assert!(view.can_use(Stage::Input) && !view.waiting().compiling);
    }
}
