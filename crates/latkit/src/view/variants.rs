//! The pipelines a scene uses, asked for the first time it draws into a target, all of a wave at
//! once: first what its frames draw with (for each kind of mark, its draw and the compute passes it
//! needs, a stroke mark's for the path it runs along, shadows when something casts, labels, the
//! overlay where it writes) and what changes need (the passes transitions ease with, the reduction of
//! fitted domains, comets carried on); once those landed, what lights rows (the lit rows' draws) and,
//! for frames that take input, what the hover and the intents need (each kind of mark's probe
//! program, which answers the hover, picks, boxes, and where a row lies). In a browser they compile
//! off the GPU's thread, the first wave side by side with the browser's compilers to itself, the
//! second a few at a time while frames draw, each the largest first, and the WGSL of both is read with
//! the first, since a browser reads it on its GPU thread: the view draws once the first landed, and
//! lights rows, probes, and answers queries once the second did, so no frame waits on a compile and
//! nothing compiles where it is first used; what the scene never uses is never asked for. A picture
//! takes no input: it asks for what it draws, changes, and lights rows with at once, and draws once
//! all of it landed.

use super::{SHADE, View};
use crate::gpu::Inner;
use crate::gpu::pipelines::{self, Asked, Variant};
use crate::gpu::shaders::{PATH_ENDS, PATH_GEOMETRY, Shader};
use crate::{Mark, Marker, Scene, Space};

/// The passes of the select capping a mark's labels.
const SELECT: [&str; 4] = ["select_start", "select_count", "select_find", "select_cut"];

/// The label passes run for each labeled mark; in a diagram, only the first.
const LABELS: [&str; 6] = ["candidates", "claim", "decide", "occupy", "ask", "fade"];

/// Pipelines of the second wave compiling at once: few enough that frames drawing meanwhile keep the
/// CPU, the next asked for as each lands.
const AT_ONCE: usize = 4;

/// What a view asked the GPU to compile for frames into one target, taking input or not: what they
/// draw with, which they wait for, and what lights rows, probes, and answers queries, which those
/// wait for, asked up to `next`; and whether each landed.
pub(super) struct Asking {
    target: (wgpu::TextureFormat, u32),
    input: bool,
    drawing: Vec<Asked>,
    answering: Vec<Asked>,
    next: usize,
    drawn: bool,
    answered: bool,
}

impl View {
    /// Whether frames into `format` with `samples` per pixel, taking `input` or not, can draw now:
    /// whether what they draw with compiled. The first time, it asks for that, all at once, and reads
    /// the WGSL of the rest; each wakes the view as it lands.
    pub(super) fn pipelines_ready(
        &mut self,
        inner: &mut Inner,
        format: wgpu::TextureFormat,
        samples: u32,
        input: bool,
    ) -> bool {
        let target = (format, samples);
        let at = if let Some(at) = self.asked.iter().position(|a| a.target == target && a.input == input) {
            at
        } else {
            let Stages { mut draw, changes, lit, input: inputs } = stages(&self.scene, format, samples);
            draw.extend(changes);
            let (mut drawing, mut answering) =
                if input { (draw, [lit, inputs].concat()) } else { ([draw, lit].concat(), Vec::new()) };
            // Marks alike share pipelines, each asked for once. A browser compiles a few at once, in
            // the order asked: the largest first, so the last lands soonest.
            for asked in [&mut drawing, &mut answering] {
                let mut seen = rustc_hash::FxHashSet::default();
                asked.retain(|need| seen.insert(need.clone()));
                asked.sort_by_key(|need| std::cmp::Reverse(need.size()));
            }
            inner.pipelines.ask(&self.gpu.0.device, &drawing, &self.waker);
            inner.pipelines.read(&self.gpu.0.device, &answering);
            let asking = Asking { target, input, drawing, answering, next: 0, drawn: false, answered: false };
            self.asked.push(asking);
            self.asked.len() - 1
        };
        let asking = &mut self.asked[at];
        asking.drawn = asking.drawn || inner.pipelines.ready(&asking.drawing);
        asking.drawn
    }

    /// Whether every target the view's frames taking input draw into can light rows, probe, and
    /// answer queries: whether what those use compiled. Once frames draw, it asks for that a few at a
    /// time, the next as each lands, whichever frame looks, a picture's too.
    pub(super) fn answers_ready(&mut self, inner: &mut Inner) -> bool {
        let mut all = true;
        for asking in self.asked.iter_mut().filter(|a| a.input) {
            if asking.drawn && !asking.answered {
                // Natively what is asked for lands at once, so all of it is asked for now.
                let landing = |next: usize, inner: &Inner| {
                    asking.answering[..next]
                        .iter()
                        .filter(|need| !inner.pipelines.ready(std::slice::from_ref(need)))
                        .count()
                };
                while asking.next < asking.answering.len() && landing(asking.next, inner) < AT_ONCE {
                    let next = &asking.answering[asking.next..=asking.next];
                    inner.pipelines.ask(&self.gpu.0.device, next, &self.waker);
                    asking.next += 1;
                }
                asking.answered = asking.next == asking.answering.len() && inner.pipelines.ready(&asking.answering);
            }
            all &= asking.answered;
        }
        all
    }
}

/// What a scene's frames use: what they draw with, what changes need, what lights rows, and what
/// input needs.
#[derive(Default)]
struct Stages {
    draw: Vec<Asked>,
    changes: Vec<Asked>,
    lit: Vec<Asked>,
    input: Vec<Asked>,
}

/// What frames of `scene` into `format` with `samples` per pixel use.
fn stages(scene: &Scene, format: wgpu::TextureFormat, samples: u32) -> Stages {
    let any = |test: fn(&Mark) -> bool| scene.marks.iter().any(test);
    let draw = |shader| Asked::Shader(Variant::draw(shader, format, samples));
    let compute = |shader, entry| Asked::Shader(Variant::compute(shader, entry));
    let mut stages = Stages {
        draw: vec![draw(Shader::Backdrop), compute(Shader::Evaluate, "evaluate")],
        changes: vec![
            compute(Shader::Evaluate, "ease"),
            compute(Shader::Evaluate, "reduce"),
            compute(Shader::Freeze, "gather"),
        ],
        ..Stages::default()
    };
    let controls = scene.controls;
    let diagram = matches!(scene.space, Space::Diagram(_));
    // The overlay writes a plot's axes, the title, and the legends, and the box and the connection a
    // gesture draws.
    let legends = any(|m| m.style().legend.is_some() && m.style().color.is_some());
    let written = matches!(scene.space, Space::Plot(_)) || scene.title.is_some() || scene.subtitle.is_some() || legends;
    if written || controls.select_box || controls.connect {
        stages.draw.push(draw(Shader::Overlay));
    }
    // The distance fields of the text frames set are made before they draw.
    let labeled = any(|m| {
        m.style().label.is_some()
            || matches!(m, Mark::Vertices(v) if v.ports.iter().any(|(_, port)| port.label.is_some()))
    });
    if written || labeled {
        stages.draw.extend(["columns", "rows"].map(|e| compute(Shader::Fields, e)));
    }
    if any(|m| m.style().label.is_some()) && !diagram {
        stages.draw.extend([compute(Shader::Labels, "clear_cells"), compute(Shader::Labels, "reset_cells")]);
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
        stages.draw.push(Asked::Shader(draw(Shader::Glyphs).path(path)));
        stages.draw.extend(labels.iter().map(|e| Asked::Shader(Variant::compute(Shader::Labels, e).path(path))));
        if style.label.as_ref().is_some_and(|l| l.max.is_some()) && !matches!(scene.space, Space::Diagram(_)) {
            stages.draw.extend(SELECT.map(|e| compute(Shader::Labels, e)));
        }
    }
    match mark {
        Mark::Faces(_) => stages.draw.push(compute(Shader::Normals, "accumulate")),
        Mark::Vertices(vertices) => {
            if !vertices.ports.is_empty() {
                stages.draw.push(Asked::Shader(draw(Shader::PointsPorts)));
            }
            if vertices.ports.iter().any(|(_, port)| port.label.is_some()) {
                stages.draw.push(Asked::Shader(draw(Shader::GlyphsPorts)));
            }
        }
        Mark::Edges(_) | Mark::Lines(_) | Mark::Areas(_) => {}
    }
}
