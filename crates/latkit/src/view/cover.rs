//! Covering: a mark drawing enough instances that they crowd the screen covers. A small instance a
//! later one covers in a crowded cell of the screen is left out of the draw, so drawing a crowded
//! mark costs what its cells show rather than what it holds. Each frame lays out every covering
//! mark's cells in the cover buffer, clears them, and has each small instance claim the cell under
//! its middle; the last one drawn there keeps it. Points cover, and edges, rows apart; a path's
//! segments never do, as each joins the next and leaving one out would break the path.
//!
//! Covering is measured: the pass counts the instances it found covered. A mark checks now and then,
//! and again once the zoom moves, and between checks covers only while enough of its instances were
//! covered to pay for the pass.

use super::View;
use super::passes::{dispatch, offset};
use super::resources::EyeSlot;
use crate::Space;
use crate::derive::Derived;
use crate::gpu::Inner;
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::{MarkKind, Primitive};

/// Instances a mark draws before it may cover: fewer cost less to draw than to cover.
const CROWDED: u32 = 32_768;
/// The share of a mark's instances a check must find covered for the mark to keep covering.
const CROWDING: f64 = 0.05;
/// Frames between checks, and how far the zoom moves before checking at once.
const RECHECK: u32 = 60;
const ZOOM_MOVED: f64 = 0.5;

/// Whether a mark's instances crowd, as its last check found, and when it checks next.
#[derive(Default)]
pub(crate) struct Crowding {
    found: Derived<bool>,
    /// Instances the last check found covered.
    covered: u32,
    /// Frames until the next check, the zoom of the last, whether this frame's pass checks, and
    /// how many checks there have been.
    wait: u32,
    zoom: f64,
    checking: bool,
    checks: u64,
}

impl Crowding {
    /// Instances the mark leaves out under later ones, as last counted, while it covers.
    pub(crate) fn covered(&self) -> u32 {
        if self.found.value { self.covered } else { 0 }
    }
}

impl View {
    /// Lays out the cells of every mark that covers this frame, as many as cover a target of `size`
    /// pixels at `zoom`, and sets them in `frame`; returns the words they take.
    pub(super) fn lay_out_cover(&mut self, frame: &mut wgsl::Frame, size: [u32; 2], zoom: f64) -> u64 {
        let cell = wgsl::COVER_CELL as u32;
        frame.cover_columns = size[0].div_ceil(cell);
        frame.cover_rows = size[1].div_ceil(cell);
        let cells = u64::from(frame.cover_columns) * u64::from(frame.cover_rows);
        let plot = matches!(self.scene.space, Space::Plot(_));
        let mut words = 0;
        for shown in &mut self.marks {
            let primitive = shown.compiled.as_ref().map(|c| c.drawing.primitive);
            let parts = primitive == Some(Primitive::Strokes) && shown.path() != wgsl::PATH_ENDS;
            let candidate = matches!(primitive, Some(Primitive::Points | Primitive::Strokes))
                && !parts
                && shown.drawable()
                && shown.instances() >= CROWDED
                // A plot's lines draw clipped to its axes, which their cells know nothing of.
                && !(plot && shown.kind() == MarkKind::Lines);
            shown.cover = wgsl::NONE;
            let instances = f64::from(shown.instances());
            let crowding = &mut shown.crowding;
            if !candidate {
                *crowding = Crowding::default();
                continue;
            }
            if let Some((stamp, bytes)) = crowding.found.landed() {
                // Every claim in a crowded cell but its last is of an instance covered.
                let word =
                    |i: usize| bytes.get(i * 4..i * 4 + 4).map_or(0, |w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]));
                let covered = word(0).saturating_add(word(1).saturating_mul(wgsl::COVER_CROWD - 1));
                crowding.covered = covered;
                crowding.found.make(stamp, f64::from(covered) >= CROWDING * instances);
            }
            crowding.checking =
                !crowding.found.busy() && (crowding.wait == 0 || (zoom - crowding.zoom).abs() > ZOOM_MOVED);
            if crowding.checking {
                crowding.wait = RECHECK;
                crowding.zoom = zoom;
            }
            crowding.wait = crowding.wait.saturating_sub(1);
            if (crowding.checking || crowding.found.value)
                && let Ok(at) = u32::try_from(words + 2)
            {
                // Counts of claims and of cells claimed, then each cell's last instance and claims.
                shown.cover = at;
                words += 2 + 2 * cells;
            }
        }
        words
    }

    /// Clears every covering mark's cells and has its small instances claim them; reads back the
    /// count of a mark that checks.
    pub(super) fn cover(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, words: u64) {
        let covered: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].cover != wgsl::NONE).collect();
        if covered.is_empty() {
            return;
        }
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before passes");
        encoder.clear_buffer(resources.cover(), 0, Some(words * 4));
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, Shader::Cover);
        let lists = resources.lists().clone();
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit cover"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            pass.set_bind_group(2, &group, &[]);
            for &i in &covered {
                let shown = &self.marks[i];
                let points = shown.compiled.as_ref().is_some_and(|c| c.drawing.primitive == Primitive::Points);
                let variant = Variant::compute(Shader::Cover, if points { "points" } else { "strokes" });
                pass.set_pipeline(&inner.pipelines.compute_pipeline(device, variant.path(shown.path())));
                pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                // A listed mark's instances are counted on the GPU, as are its threads.
                if let Some(list) = &shown.segments.list {
                    pass.dispatch_workgroups_indirect(&lists, u64::from(list.header + wgsl::LIST_DISPATCH) * 4);
                } else {
                    dispatch(&mut pass, shown.instances());
                }
            }
        }
        let cover = self.resources.as_ref().expect("created before passes").cover().clone();
        for &i in &covered {
            let at = u64::from(self.marks[i].cover - 2) * 4;
            let crowding = &mut self.marks[i].crowding;
            if crowding.checking {
                crowding.checks += 1;
                crowding.found.start(crowding.checks, Readback::new(&inner.readbacks, device, encoder, &cover, at, 8));
            }
        }
    }
}
