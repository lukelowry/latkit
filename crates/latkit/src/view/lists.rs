//! Lists on the GPU: each item counts its entries, a scan turns the counts into start offsets,
//! and inverse lookup assigns each entry to its item. Draws reserve an upper bound and reject the
//! unused tail before reading geometry, so they never wait for a count to reach the CPU.
//!
//! After the segment lists lie the drawn-row words of each mark drawing a paged table: the held
//! row of each row drawn, expanded from the drawing's runs when they change, so every pass reads a
//! drawn row in one word.
//!
//! Last come the height orders of marks whose rows stand at different heights, where depth varies.
//! Each sorts its instances lowest first on the GPU (`raster/order.wesl`), whenever the heights or
//! the instances change. Height does not depend on the camera, so moving the camera sorts nothing.

use super::View;
use std::sync::Arc;

use super::marks::{Holding, Shown};
use super::passes::offset;
use crate::data::{Field, RowIds, Version};
use crate::derive::{Derived, stamp_of};
use crate::expr::compile::{Deps, Program, Reads};
use crate::gpu::Inner;
use crate::gpu::pipelines::Projection;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Mark, Space};

/// A listed mark's segment list (see `Shown::listed`), used when its rows have different numbers
/// of segments, or for areas, of triangles: where it lies, a stamp of its last build's inputs (the
/// list, the paths, and for great circles where the vertices are drawn), and its count. Each entry
/// is a segment's row and distance along its path, or an area's row and prepared corner address.
/// A curved mark's count is read back,
/// one readback at a time, and its list grows to fit what was found.
#[derive(Default)]
pub(crate) struct Segments {
    pub(crate) list: Option<List>,
    pub(crate) built: u64,
    pub(crate) found: Derived<u32>,
}

/// Source-position dependencies of a vertex mark. Appending vertices does not move existing
/// endpoints. Reference columns independently invalidate edges newly connected to those vertices.
#[derive(Default)]
pub(crate) struct Shape {
    seen: Option<(bool, u64)>,
    version: Option<Version>,
    inputs: Option<ShapeInputs>,
}

struct ShapeInputs {
    program: Arc<Program>,
    holding: Holding,
    columns: u64,
}

impl ShapeInputs {
    fn of(shown: &Shown) -> Option<Self> {
        if shown.transition.is_some() || shown.begin.is_some() || shown.exits != 0 || !shown.drawable() {
            return None;
        }
        let holding = shown.holding.as_ref()?;
        if holding.drawing.is_some() {
            return None;
        }
        let program = &shown.compiled.as_ref()?.program;
        let mut columns = 0;
        for channel in program.channels.iter().filter(|c| matches!(c.name.as_str(), "position" | "elevation")) {
            // Joins, fitted domains, samples, transitions, and view expressions stay conservative.
            if channel.reads.deps != Deps::default() && channel.reads.deps != Deps::DATA {
                return None;
            }
            columns |= channel.reads.columns;
        }
        if program.columns.iter().enumerate().any(|(i, column)| {
            columns & Reads::column(i) != 0 && (column.from.is_some() || column.derived || column.sampled)
        }) {
            return None;
        }
        Some(Self { program: program.clone(), holding: holding.clone(), columns })
    }

    /// The old vertices keep both their identities and every input that places them. Immutable
    /// pages and their bounded write history prove this without comparing or evaluating values.
    fn keeps(&self, before: &Self) -> bool {
        let (old, new) = (&before.holding.table, &self.holding.table);
        if !Arc::ptr_eq(&self.program, &before.program)
            || self.holding.origin != before.holding.origin
            || old.order != new.order
            || new.len() < old.len()
        {
            return false;
        }
        let ids = match (&old.ids, &new.ids) {
            (RowIds::Count(a), RowIds::Count(b)) => b >= a,
            (RowIds::Listed(a), RowIds::Listed(b)) => b.kept_below(a, old.len()),
            _ => false,
        };
        ids && self.program.columns.iter().enumerate().all(|(i, column)| {
            if self.columns & Reads::column(i) == 0 {
                return true;
            }
            match (old.field_named(&column.name), new.field_named(&column.name)) {
                (Some(Field::Values(a, _)), Some(Field::Values(b, _))) => b.kept_below(a, old.len()),
                // References and other field kinds can change their interpretation outside this
                // table, so the general revision remains their dependency.
                _ => false,
            }
        })
    }
}

/// Words per instance: its row, and its path distance or prepared triangle address.
const SEGMENT_WORDS: u32 = 2;

/// Where a paged mark's drawn-row words lie in the lists buffer, `[start, room]` in words, and the
/// stamp of their last expansion's inputs: the drawing, their location, and the buffer.
#[derive(Default)]
pub(crate) struct DrawnRows {
    pub(crate) at: Option<[u32; 2]>,
    expanded: u64,
}

/// A mark's height order: its list, whose entries are the instance drawn at each position
/// (`ORDER_WORDS` per instance), and how many instances its last sort covered: those draws cover,
/// not the spare room of the lists they come from. It sorts again when its instances change, and
/// at most every [`RESORT`] seconds while only their heights change.
#[derive(Default)]
pub(crate) struct HeightOrder {
    pub(crate) list: Option<List>,
    count: u32,
    /// Stamps of what its instances are and of where they stand.
    instances: u64,
    heights: u64,
    /// Whether heights changed since its last sort, which happened at `sorted` on the view's clock.
    stale: bool,
    sorted: f64,
}

impl HeightOrder {
    /// Whether heights changed since the last sort, which a coming frame makes.
    pub(super) fn stale(&self) -> bool {
        self.stale
    }
}

/// The fewest seconds between two sorts of a height order while only heights change, as when they
/// stream in every frame. Meanwhile, a row whose height changed may draw out of order among rows of
/// nearly its height.
const RESORT: f64 = 0.1;

/// Words a height order keeps per instance: the instance and its key, on each of two sides.
const ORDER_WORDS: u32 = 1;

/// Where a list lies in the lists buffer, in words.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct List {
    pub(crate) header: u32,
    pub(crate) items: u32,
    pub(crate) entries: u32,
    /// The most entries it keeps, and words per entry.
    pub(crate) kept: u32,
    pub(crate) stride: u32,
    pub(crate) counts: u32,
}

impl List {
    /// A list of `items` items keeping `kept` entries of `stride` words: its header and entries at
    /// `front`, its block sums and counts at `back`.
    pub(crate) fn at(front: u32, back: u32, items: u32, kept: u32, stride: u32) -> List {
        let counts = back;
        List { header: front, items, entries: front + wgsl::LIST_HEADER, kept, stride, counts }
    }

    /// Words its header and entries take.
    pub(crate) fn front_words(kept: u32, stride: u32) -> u32 {
        (wgsl::LIST_HEADER + kept * stride).next_multiple_of(4)
    }

    /// Words its sums and counts take.
    pub(crate) fn back_words(items: u32) -> u32 {
        (items + 1).next_multiple_of(4)
    }

    /// Where the scan writes the list's total, before it is capped at `kept`.
    pub(crate) fn total(&self) -> u32 {
        self.counts + self.items
    }

    /// The header's item count, prefix offsets, entries, and reserved capacity.
    pub(crate) fn header_words(&self) -> [u32; wgsl::LIST_HEADER as usize] {
        [self.items, self.counts, self.entries, self.kept]
    }
}

impl View {
    /// Builds only invalidated lists. Every intermediate stays on the GPU, and persistent lists
    /// are updated by ordered copies from shared scratch, avoiding sampled/attached aliases.
    pub(super) fn record_lists(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        expanded: &[usize],
        segments: &[usize],
        ordered: &[usize],
    ) {
        if expanded.is_empty() && segments.is_empty() && ordered.is_empty() {
            return;
        }
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let resources = self.resources.as_mut().expect("frame resources");
        let groups = resources.groups(&gpu.0, inner);
        for &i in segments.iter().chain(ordered) {
            let shown = &self.marks[i];
            for list in [shown.segments.list, shown.height_order.list].into_iter().flatten() {
                resources.lists().write(queue, list.header, &list.header_words());
            }
        }
        let input = |i: usize| crate::gpu::listing::Inputs {
            pages: inner.arena.words(),
            lists: resources.lists(),
            view: &groups.view,
            mark: &groups.mark,
            offset: offset(i),
            path: self.marks[i].path(),
            projection: Projection::of(&self.scene.space),
            measured: self.marks[i].measures_paths(),
        };
        let mut raster = crate::gpu::raster::Raster { device, queue, pipelines: &mut inner.pipelines, encoder };
        for &i in expanded {
            let shown = &self.marks[i];
            inner.listing.expand(
                &mut raster,
                &input(i),
                shown.rows + shown.exits,
                shown.drawn_rows.at.expect("drawn rows")[0],
            );
        }
        for &i in segments {
            let shown = &self.marks[i];
            let list = shown.segments.list.expect("segment list");
            inner.listing.segments(
                &mut raster,
                &input(i),
                crate::gpu::listing::Segments {
                    items: list.items,
                    kept: list.kept,
                    counts: list.counts,
                    destination: list.entries,
                    areas: shown.kind() == MarkKind::Areas,
                },
            );
        }
        for &i in ordered {
            let order = &self.marks[i].height_order;
            let list = order.list.expect("height order");
            inner.listing.order(&mut raster, &input(i), (order.count, list.kept), list.entries);
        }
    }

    /// Lays out the lists buffer: every listed mark's segment list at the front, using counts read
    /// back, then each paged mark's drawn-row words, then in `layered` frames the height order of
    /// each mark whose rows stand at different heights. A list smaller than its rows need grows,
    /// with a quarter to spare.
    pub(super) fn lay_out_lists_buffer(&mut self, layered: bool) {
        let mut at = 0;
        for shown in &mut self.marks {
            if let Some((stamp, bytes)) = shown.segments.found.landed() {
                let found = crate::wire::In::new(&bytes).u32().unwrap_or(0);
                shown.segments.found.make(stamp, found);
            }
            if !shown.listed() {
                shown.segments.list = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let kept = shown.segment_capacity();
            let list = match shown.segments.list {
                Some(list) if list.header == at && list.items == items && list.kept >= kept => list,
                _ => {
                    let kept = kept + kept / 4;
                    List::at(at, at + List::front_words(kept, SEGMENT_WORDS), items, kept, SEGMENT_WORDS)
                }
            };
            at += List::front_words(list.kept, SEGMENT_WORDS) + List::back_words(items);
            shown.segments.list = Some(list);
        }
        // Then one word per row each paged mark draws, rows that left included.
        for shown in &mut self.marks {
            if shown.drawing().is_none() {
                shown.drawn_rows.at = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let region = match shown.drawn_rows.at {
                Some([start, room]) if start == at && room >= items => [start, room],
                _ => [at, (items + items / 4).next_multiple_of(4)],
            };
            at += region[1];
            shown.drawn_rows.at = Some(region);
        }
        // Then a height order for each mark whose rows stand at different heights, with room for
        // every instance it may draw.
        let ordered: Vec<bool> = (0..self.marks.len()).map(|i| layered && self.heights_vary(i)).collect();
        for (shown, ordered) in self.marks.iter_mut().zip(ordered) {
            if !ordered {
                shown.height_order.list = None;
                continue;
            }
            let kept = shown.instances().max(1);
            let list = match shown.height_order.list {
                Some(list) if list.header == at && list.kept >= kept => list,
                _ => {
                    let kept = kept + kept / 4;
                    let items = 0;
                    List::at(at, at + List::front_words(kept, ORDER_WORDS), items, kept, ORDER_WORDS)
                }
            };
            at += List::front_words(list.kept, ORDER_WORDS) + List::back_words(list.items);
            shown.height_order.list = Some(list);
        }
        self.list_words = at;
    }

    /// Whether mark `i`'s rows can stand at different heights where depth varies, so they draw
    /// lowest first: a raised vertex mark on a plane or the earth, and edges and poles ending at
    /// one.
    fn heights_vary(&self, i: usize) -> bool {
        if !matches!(self.scene.space, Space::Plane(_) | Space::Earth(_)) {
            return false;
        }
        let shown = &self.marks[i];
        match shown.kind() {
            MarkKind::Vertices => raised(&shown.mark),
            MarkKind::Edges => {
                matches!(shown.path(), wgsl::PATH_ENDS | wgsl::PATH_BENDS | wgsl::PATH_POLES)
                    && shown.ends.iter().any(|end| end.mark.is_some_and(|m| raised(&self.marks[m].mark)))
            }
            MarkKind::Lines | MarkKind::Areas => false,
        }
    }

    /// The marks whose height orders sort this frame: those whose order, lists buffer, or instances
    /// changed, and, at most every [`RESORT`] seconds, those whose rows' heights changed. Heights
    /// change where its rows or the vertices they end at are drawn ([`Shown::places_drawn`]), with
    /// the paths drawn between them, and where the rows resolve their ends. Only an `input` frame
    /// that moves the clock waits: a picture's or a video's frame shows every row in order, and
    /// without the clock moving, no later frame would come.
    pub(super) fn height_orders_due(&mut self, input: bool) -> Vec<usize> {
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let places: Vec<(bool, u64)> = self.marks.iter().map(Shown::places_drawn).collect();
        let (now, waits) = (self.clock.now(), input && self.clock.moved());
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(list) = shown.height_order.list.filter(|_| shown.drawable()) else {
                shown.height_order.stale = false;
                continue;
            };
            let ends: Vec<(bool, u64)> = shown.ends.iter().filter_map(|end| end.mark).map(|m| places[m]).collect();
            let drawn = shown.drawing().map(|d| d.made);
            let count = shown.counted_instances(shown.instances()).min(list.kept);
            let instances = stamp_of((list.header, list.kept, generation, shown.rows, shown.exits, drawn, count));
            let heights = stamp_of((shown.segments.built, places[i], ends));
            let order = &mut shown.height_order;
            order.stale |= heights != order.heights || shown.end_block_count > 0;
            order.heights = heights;
            if instances != order.instances || (order.stale && (!waits || now - order.sorted >= RESORT)) {
                (order.instances, order.count, order.stale, order.sorted) = (instances, count, false, now);
                due.push(i);
            }
        }
        due
    }

    /// The marks whose drawn-row words are rewritten this frame: those whose drawing, rows, word
    /// location, or lists buffer changed.
    pub(super) fn drawn_rows_due(&mut self) -> Vec<usize> {
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(at) = shown.drawn_rows.at.filter(|_| shown.drawable()) else { continue };
            let drawn = shown.drawing().map(|d| d.made);
            let stamp = stamp_of((at, shown.rows, shown.exits, drawn, generation));
            if stamp != shown.drawn_rows.expanded {
                shown.drawn_rows.expanded = stamp;
                due.push(i);
            }
        }
        due
    }

    /// The marks whose segment lists rebuild this frame: those whose list, lists buffer, paths, or
    /// drawing changed, or, along great circles or lanes, where the vertices their rows join are
    /// drawn. A color changing every frame rebuilds none.
    pub(super) fn segments_due(&mut self) -> Vec<usize> {
        let vertices: Vec<Option<Version>> =
            self.marks.iter_mut().map(|m| (m.kind() == MarkKind::Vertices).then(|| m.shape_version())).collect();
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        // Flat-plane lanes retain a conservative plan throughout a zoom octave. Draws test the
        // exact current density. Other projections retain their full camera dependency.
        let projected = self.projected();
        let sight = projected.lane_band().map_or_else(
            || {
                stamp_of((
                    projected.clip_from_world.to_cols_array().map(f64::to_bits),
                    projected.center.map(f64::to_bits),
                    self.size.map(f64::to_bits),
                    projected.globe.to_bits(),
                    self.scene.theme.edge.bow.to_bits(),
                ))
            },
            |band| stamp_of((band.to_bits(), self.size.map(f64::to_bits), self.scene.theme.edge.bow.to_bits())),
        );
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(list) = shown.segments.list.filter(|_| shown.drawable()) else { continue };
            let laned = shown.laned().then_some(sight);
            let measured = shown.measures_paths();
            let arcs = (shown.geodesic || laned.is_some() || measured).then(|| {
                let ends: Vec<_> = shown.ends.iter().map(|end| end.mark.map(|m| (m, vertices[m]))).collect();
                (ends, shown.places_drawn(), laned)
            });
            let tables = shown.compiled.as_ref().map(|c| {
                let generation = |column| (column, shown.tables.column_generation(column));
                let ends: Vec<_> = c.program.ends.iter().map(|end| generation(end.column)).collect();
                (generation(c.drawing.geometry), generation(c.drawing.lane), ends)
            });
            let drawn = shown.drawing().map(|d| d.made);
            let stamp = stamp_of((list.header, list.items, list.kept, tables, generation, arcs, drawn, measured));
            if stamp != shown.segments.built {
                shown.segments.built = stamp;
                due.push(i);
            }
        }
        due
    }

    /// Reads curved marks' counts without blocking. Great-circle reservations grow when needed;
    /// a current count also trims lane draws to the compacted prefix. A new list invalidates its
    /// old count immediately, so no changed geometry is dropped while a readback is pending.
    pub(super) fn count_found(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) {
        let gpu = self.gpu.clone();
        let Some(resources) = &self.resources else { return };
        for shown in &mut self.marks {
            let Some(list) = shown.segments.list.filter(|_| shown.curved() && shown.drawable()) else { continue };
            let built = shown.segments.built;
            if shown.segments.found.busy() || !shown.segments.found.due(built) {
                continue;
            }
            let at = list.total();
            let readback =
                Readback::words(&inner.readbacks, &gpu.0.device, encoder, resources.lists(), at, 1, &self.waker);
            shown.segments.found.start(built, readback);
        }
    }
}

/// Whether `mark` is a vertex mark whose rows stand at the heights its elevation gives.
pub(super) fn raised(mark: &Mark) -> bool {
    matches!(mark, Mark::Vertices(vertices) if vertices.raised())
}

impl Shown {
    fn shape_version(&mut self) -> Version {
        let seen = self.places_drawn();
        if self.shape.seen != Some(seen) {
            let inputs = ShapeInputs::of(self);
            if !inputs.as_ref().zip(self.shape.inputs.as_ref()).is_some_and(|(now, before)| now.keeps(before)) {
                self.shape.version = Some(Version::next());
            }
            self.shape.seen = Some(seen);
            self.shape.inputs = inputs;
        }
        self.shape.version.expect("a shape is versioned on its first use")
    }

    /// Whether its segment count is being read back, or is due to be.
    pub(crate) fn counting(&self) -> bool {
        let found = &self.segments.found;
        found.busy() || (self.curved() && self.drawable() && found.due(self.segments.built))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Camera, Color, Data, Frame, Gpu, Grid, Ids, Lines, Plane, Scene, Table, field};

    #[test]
    fn curved_lists_keep_counts_for_unreferenced_appends_but_follow_changed_endpoints() {
        use crate::{Earth, Edges, Patch, Vertices};
        let gpu = match pollster::block_on(Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let data = Data::new("d");
        data.apply(
            Patch::new()
                .set(Table::new("Node", vec![0_u64, 1]).field("x", vec![-1.0, 1.0]).field("y", vec![0.0, 0.0]))
                .set(Table::new("Link", Ids::count(2)).reference("from", "Node", vec![0_u64, 0]).reference(
                    "to",
                    "Node",
                    vec![1_u64, 9],
                )),
        )
        .unwrap();
        let scene = |shift: f64| {
            Scene::new(Earth { graticule: false, ..Earth::default() })
                .ease(std::time::Duration::ZERO)
                .draw(Vertices::of("d", "Node").position(field("x") + shift, field("y")).radius(1.0))
                .draw(Edges::of("d", "Link").ends("from", "to"))
        };
        let mut view = View::new(&gpu, scene(0.0));
        view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
        view.set_sources([&data]).unwrap();
        let device = gpu.device();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("endpoint dependency test"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::gpu::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut time = 0.0;
        let mut render = |view: &mut View| {
            for _ in 0..20 {
                time += 1.0 / 60.0;
                let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
                view.render(
                    &mut encoder,
                    &Frame { target: &target, format: crate::gpu::FORMAT, size: [64, 64], pixel_ratio: 1.0, time },
                );
                gpu.queue().submit([encoder.finish()]);
                device
                    .poll(wgpu::PollType::Wait {
                        submission_index: None,
                        timeout: Some(std::time::Duration::from_secs(10)),
                    })
                    .unwrap();
                if !view.needs_render() {
                    assert_eq!(gpu.work().late, 0);
                    return view.marks[1].segments.built;
                }
            }
            panic!("the view settles");
        };
        let first = render(&mut view);
        assert_ne!(first, 0);
        data.apply(Table::new("Node", [2_u64]).field("x", vec![5.0]).field("y", vec![0.0])).unwrap();
        assert_eq!(render(&mut view), first, "an unreferenced append keeps existing geometry and its exact count");
        data.apply(Table::new("Node", [1_u64]).field("x", vec![110.0])).unwrap();
        let moved = render(&mut view);
        assert_ne!(moved, first, "an existing endpoint moving changes its arc");
        data.apply(Table::new("Node", [9_u64]).field("x", vec![60.0]).field("y", vec![30.0])).unwrap();
        let connected = render(&mut view);
        assert_ne!(connected, moved, "a formerly missing reference connecting changes its list");
        view.set_scene(scene(1.0));
        assert_ne!(render(&mut view), connected, "changing the position expression invalidates inherited geometry");
    }

    #[test]
    fn heights_changing_every_frame_sort_at_most_every_resort_and_end_in_order() {
        use crate::Vertices;
        let gpu = match pollster::block_on(Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let data = Data::new("d");
        let node = |z: f64| Table::new("Node", vec![0_u64, 1, 2]).field("z", vec![0.0, z, 2.0]);
        data.apply(node(1.0).field("x", vec![-1.0, 0.0, 1.0]).field("y", vec![0.0; 3])).unwrap();
        let raised = Vertices::of("d", "Node").position(field("x"), field("y")).elevation(field("z"));
        let scene = Scene::new(Plane { grid: Grid::Off }).ease(std::time::Duration::ZERO).draw(raised);
        let mut view = View::new(&gpu, scene);
        // Tilted, depth varies, so the raised rows draw lowest first.
        view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 50.0, bearing: 0.0 });
        view.set_sources([&data]).unwrap();
        let device = gpu.device();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("height order test"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::gpu::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut time = 0.0;
        let mut frame = |view: &mut View| {
            time += 1.0 / 60.0;
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let size = [64, 64];
            view.render(
                &mut encoder,
                &Frame { target: &target, format: crate::gpu::FORMAT, size, pixel_ratio: 1.0, time },
            );
            gpu.queue().submit([encoder.finish()]);
            let wait =
                wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) };
            device.poll(wait).unwrap();
        };
        for _ in 0..10 {
            frame(&mut view);
        }
        assert!(view.marks[0].height_order.list.is_some(), "the tilted view orders its raised rows");
        // Half a second of a height changing every frame sorts about every `RESORT`, not every frame.
        let mut sorts = 0;
        for i in 0..30 {
            let before = view.marks[0].height_order.sorted;
            data.apply(node(f64::from(i % 4))).unwrap();
            frame(&mut view);
            sorts += u32::from(view.marks[0].height_order.sorted != before);
        }
        assert!((4..=6).contains(&sorts), "{sorts} sorts in 30 frames of 1/60 s");
        // Once the heights stop changing, a frame soon sorts them all, and the view sleeps.
        assert!(view.needs_render() || !view.marks[0].height_order.stale());
        for _ in 0..12 {
            if !view.needs_render() {
                break;
            }
            frame(&mut view);
        }
        assert!(!view.needs_render(), "the view sleeps");
        assert!(!view.marks[0].height_order.stale(), "with every row in order");
        assert_eq!(gpu.work().late, 0);
    }

    #[test]
    fn path_lists_track_geometry_and_length_styles_but_not_color_updates() {
        let gpu = match pollster::block_on(Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let data = Data::new("d");
        data.apply(
            Table::new("Path", Ids::count(1))
                .field("geometry", vec![vec![[-10.0, 0.0], [0.0, 0.0], [10.0, 0.0]]])
                .field("red", vec![false]),
        )
        .unwrap();
        let line = Lines::of("d", "Path").color(crate::when(field("red")).then(Color::WHITE).otherwise(Color::BLACK));
        let scene = |line| Scene::new(Plane { grid: Grid::Off }).ease(std::time::Duration::ZERO).draw(line);
        let mut view = View::new(&gpu, scene(line.clone()));
        view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
        view.set_sources([&data]).unwrap();
        let device = gpu.device();
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("list invalidation test"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::gpu::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut time = 0.0;
        let mut render = |view: &mut View| {
            for _ in 0..20 {
                time += 1.0 / 60.0;
                let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
                view.render(
                    &mut encoder,
                    &Frame { target: &target, format: crate::gpu::FORMAT, size: [64, 64], pixel_ratio: 1.0, time },
                );
                gpu.queue().submit([encoder.finish()]);
                device
                    .poll(wgpu::PollType::Wait {
                        submission_index: None,
                        timeout: Some(std::time::Duration::from_secs(10)),
                    })
                    .unwrap();
                if !view.needs_render() {
                    return view.marks[0].segments.built;
                }
            }
            panic!("the view settles");
        };
        let first = render(&mut view);
        assert_ne!(first, 0);
        data.apply(Table::new("Path", [0_u64]).field("red", vec![true])).unwrap();
        assert_eq!(render(&mut view), first, "changing color preserves the path list");
        data.apply(Table::new("Path", [0_u64]).field("geometry", vec![vec![[-10.0, 0.0], [10.0, 0.0]]])).unwrap();
        let changed = render(&mut view);
        assert_ne!(changed, first, "changing the path rebuilds its list");
        view.set_scene(scene(line.dash(true)));
        assert_ne!(render(&mut view), changed, "enabling dashes measures the existing path");
    }
}
