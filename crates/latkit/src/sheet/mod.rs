//! A diagram's sheet: each vertex row's place and size, group boxes around their members, and
//! wire paths, in units with y down.
//!
//! The sheet depends only on the data and the scene, never on what was drawn, so the camera,
//! hover, and motion never change it. Places persist by row: adding a row moves nothing else, and
//! a row that loses its position stays where it was. Layouts place only rows without a place, until
//! `arrange` lays out every row without a position again. A wire routes again only when its
//! terminals move or a box near it changes. Superlinear work too large for the frame (layouts,
//! many routes) runs as a host job that answers with a patch.
//!
//! The sheet is a derivation. It writes a table beside each table it draws, row for row, and marks
//! read it like data. That includes the text of each label: a block's label wider than the block,
//! or a group's title wider than its box, shows cut short with "…". An edit of the values that size and place rows recomputes only the rows it
//! wrote and what they affect: their boxes, the groups around them, and the wires they move.

mod groups;
mod wires;

use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHasher};

use crate::data::{Column, Field, Name, Row, Table, Value, Values, Version};
use crate::derive::graph::{EdgeMark, VertexMark, drawing, key_of, links, marks, position};
use crate::derive::{Derive, Input, Jobs, Read, Tables, answers, beside, kept, stamp_of};
use crate::expr::cpu::Rows;
use crate::gpu::atlas;
use crate::gpu::shaders::{HEADER_BAND, TEXT_BASE};
use crate::host::{Job, Key, Placement, TextRun};
use crate::layout::boxes::Boxes;
use crate::layout::rect::{EMPTY, Rect, around, union, valid};
use crate::{Layout, Marker, Pending, Shape, Side, Theme, Vertices};

/// The number of measured texts beyond which the sheet clears its measurement cache.
const MEASURED: usize = 1 << 16;

/// The sheet of a diagram's view.
#[derive(Default)]
pub(crate) struct Sheet {
    /// Errors to report: texts the host could not measure.
    errors: Vec<crate::Error>,
    /// The derived table beside each table it draws.
    tables: Tables,
    /// Places layouts gave rows without positions, by row. Kept after a row is removed, so undo
    /// puts it back where it was.
    places: FxHashMap<Row, [f64; 2]>,
    /// Each orthogonal wire's route, by edge row, and the rows due to route again.
    routes: wires::Routes,
    /// The size of each text run, as the host measured it.
    measured: FxHashMap<TextRun, [f64; 2]>,
    /// The box of every placed vertex row as of the last update, to find the boxes a change moved.
    boxes: FxHashMap<Row, [f64; 4]>,
    /// Each vertex's routing-obstacle box, y up (`EMPTY` for a group), refit as vertices move.
    blocks: Boxes,
    /// The groups, refit as their members move.
    groups: groups::Groups,
    /// The stamp the derived tables were last made from.
    stamp: u64,
    /// Bumps when places start over, so answers to earlier layouts are dropped.
    generation: u64,
    /// Whether every row without a position is to be laid out again. Rows stay where they are
    /// until the layout answers.
    arranging: bool,
    /// The result of the last arrange, until the view takes it.
    arranged: Option<Vec<(Row, [f64; 2])>>,
    /// The layout the places were made with.
    layout: Option<Layout>,
    placing: Option<Placing>,
    routing: Option<wires::Routing>,
    /// Bumps whenever an answer arrives.
    landed: u64,
    /// The state of the last draw, which an edit updates incrementally.
    drawn: Option<Drawn>,
}

/// The sheet's last drawn state: every vertex row, the wiring state, the marks' structure inputs,
/// and a stamp of the scene version, whether there is a host, the answers received, and the
/// places generation.
struct Drawn {
    vertices: Vec<Vertex>,
    wired: wires::Wired,
    reads: Vec<Seen>,
    from: u64,
}

/// An input to the marks' structure as of the last draw: a table's rows, or a field.
enum Seen {
    Rows { key: (Name, Name), structure: Version, order: Version },
    Field { key: (Name, Name, Name), field: Option<Box<Field>> },
}

/// A pending layout job: the places generation it was started in, and the row each answer key
/// names.
struct Placing {
    pending: Pending<Vec<u8>>,
    generation: u64,
    rows: FxHashMap<Key, Row>,
}

/// A vertex row of the diagram.
pub(crate) struct Vertex {
    /// The index of the vertex mark drawing it.
    pub(crate) mark: usize,
    pub(crate) key: Row,
    /// Half its width and height, in units. For a group, its size when it holds nothing placed.
    pub(crate) half: [f64; 2],
    /// The position its data gives it.
    pub(crate) pin: Option<[f64; 2]>,
    /// Its box, least x and y then greatest, once it has a place.
    pub(crate) bounds: Option<[f64; 4]>,
    /// The group holding it, by vertex index.
    pub(crate) parent: Option<usize>,
    /// How many groups hold it.
    pub(crate) depth: u32,
    /// Whether it is a group.
    pub(crate) group: bool,
    /// As a group, how many rows it directly holds.
    pub(crate) members: u32,
    pub(crate) shape: Shape,
    /// The text each of its table's vertex marks labels it with, cut to fit, if the mark has a
    /// label.
    pub(crate) shown: Vec<Option<Arc<str>>>,
}

impl Vertex {
    pub(crate) fn center(&self) -> Option<[f64; 2]> {
        self.bounds.map(|b| [b[0].midpoint(b[2]), b[1].midpoint(b[3])])
    }
}

impl Derive for Sheet {
    /// Updates the sheet to `input`, writing each drawn table's derived table.
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        if self.layout != Some(input.scene.layout) {
            if self.layout.is_some() {
                self.arrange();
            }
            self.layout = Some(input.scene.layout);
        }
        let mut changed = false;
        // Repeat so a job the host finishes at once is taken before the frame draws.
        for _ in 0..4 {
            self.settle();
            let stamp = stamp(input, self.landed, self.generation);
            if stamp == self.stamp {
                break;
            }
            self.stamp = stamp;
            self.build(input, jobs);
            changed = true;
        }
        changed
    }

    /// Whether a layout or routing job is pending.
    fn busy(&self) -> bool {
        self.placing.is_some() || self.routing.is_some()
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    /// Drops the tables but keeps places and routes, so when the scene is a diagram again, rows
    /// return to where they were.
    fn clear(&mut self) {
        self.tables.clear();
        self.drawn = None;
        self.stamp = 0;
    }

    fn take_errors(&mut self) -> Vec<crate::Error> {
        std::mem::take(&mut self.errors)
    }
}

impl Sheet {
    /// Whether a layout job is pending. A fit waits for it.
    pub(crate) fn placing(&self) -> bool {
        self.placing.is_some()
    }

    /// Lays out every row without a position again. Rows stay where they are until the layout
    /// answers.
    pub(crate) fn arrange(&mut self) {
        self.arranging = true;
        self.placing = None;
        self.generation += 1;
        self.stamp = 0;
    }

    /// Takes the result of the last `arrange` once it arrives: each row laid out and its position,
    /// in units with y down.
    pub(crate) fn take_arranged(&mut self) -> Option<Vec<(Row, [f64; 2])>> {
        self.arranged.take()
    }

    /// Row `row`'s box, in units with y down, once it has one.
    pub(crate) fn bounds(&self, row: &Row) -> Option<[f64; 4]> {
        self.boxes.get(row).copied()
    }

    /// The box around every placed vertex and every wire, in units with y down. `None` until
    /// something is placed. Read from the indexes the sheet keeps of blocks, groups, and wires.
    pub(crate) fn extent(&self) -> Option<[f64; 4]> {
        let wires = self.drawn.as_ref()?.wired.extent();
        let up = union(self.blocks.extent(), self.groups.extent());
        let extent = union([up[0], -up[3], up[2], -up[1]], wires);
        valid(&extent).then_some(extent)
    }

    /// Takes the answers of finished jobs: a layout's places, if it was started in the current
    /// generation, and routes.
    fn settle(&mut self) {
        if let Some(answer) = self.placing.as_ref().and_then(|p| p.pending.take()) {
            let placing = self.placing.take().expect("a layout under way");
            if placing.generation == self.generation {
                let mut placed = Vec::new();
                for (key, values) in answer.map(|bytes| answers(&bytes, &["x", "y"])).unwrap_or_default() {
                    if let (Some(row), [Some(Value::Number(x)), Some(Value::Number(y))]) =
                        (placing.rows.get(&key), &values[..])
                    {
                        // Layouts are y up and the sheet is y down.
                        self.places.insert(row.clone(), [*x, -*y]);
                        placed.push((row.clone(), [*x, -*y]));
                    }
                }
                if std::mem::take(&mut self.arranging) {
                    self.arranged = Some(placed);
                }
            }
            self.landed += 1;
        }
        if let Some(answer) = self.routing.as_ref().and_then(|r| r.pending.take()) {
            let routing = self.routing.take().expect("routes under way");
            if let Ok(bytes) = answer {
                wires::land(&mut self.routes, &routing, &bytes);
            }
            self.landed += 1;
        }
    }

    /// Rebuilds the derived tables: sizes, places, group boxes, then wires. After an edit that only
    /// changed values sizing or placing rows (each by its own row's value), it redraws only what
    /// the written rows affect.
    fn build(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) {
        let marks = marks(input);
        let from = stamp_of((input.scene_version, input.host.is_some(), self.landed, self.generation));
        let drawn = self.drawn.take().filter(|drawn| drawn.from == from);
        let mut drawn = match drawn.as_ref().and_then(|drawn| edited(drawn, input, &marks.0)) {
            Some(touched) => self.redraw(drawn.expect("drawn"), touched, &marks, input, jobs),
            None => self.draw(&marks, input, jobs),
        };
        drawn.reads = seen(input);
        drawn.from = from;
        self.drawn = Some(drawn);
    }

    /// Draws every row: sizes, places, group boxes, then wires.
    fn draw(&mut self, marks: &Marks<'_>, input: &Input<'_>, jobs: &mut Jobs<'_>) -> Drawn {
        let (vertex_marks, edge_marks) = marks;
        let mut vertices = self.vertices(vertex_marks, input);
        hold(vertex_marks, &mut vertices);
        let (header, padding) = framing(vertex_marks, &input.scene.theme);
        for v in vertices.iter_mut().filter(|v| !v.group) {
            self.stand(v);
        }
        let framing = groups::Framing { header: &header, padding, places: &self.places };
        self.groups = groups::Groups::new(&mut vertices, &framing);
        self.blocks = Boxes::new(vertices.iter().map(obstacle).collect());
        self.place(&vertices, vertex_marks, edge_marks, &header, padding, input, jobs);
        let every: Vec<usize> = (0..vertices.len()).collect();
        self.show_labels(vertex_marks, &mut vertices, &every, padding, input);
        let moved = wires::moved(&self.boxes, &vertices);
        let mut drawn = Drawn { vertices, wired: wires::Wired::default(), reads: Vec::new(), from: 0 };
        self.wire(&mut drawn, marks, &wires::Change { moved: &moved, touched: None }, input, jobs);
        self.boxes = drawn.vertices.iter().filter_map(|v| Some((v.key.clone(), v.bounds?))).collect();
        write(vertex_marks, &drawn.vertices, edge_marks, &drawn.wired.parts, &mut self.tables);
        drawn
    }

    /// Redraws what an edit affects: sizes and places rows `touched` again, refits the groups
    /// around them, and recomputes the wires meeting them or near the boxes they moved.
    fn redraw(
        &mut self,
        mut drawn: Drawn,
        mut touched: Vec<usize>,
        marks: &Marks<'_>,
        input: &Input<'_>,
        jobs: &mut Jobs<'_>,
    ) -> Drawn {
        let (vertex_marks, edge_marks) = marks;
        let (header, padding) = framing(vertex_marks, &input.scene.theme);
        let rows: Vec<Rows<'_>> = vertex_marks.iter().map(|vm| Rows::new(vm.table, input.data)).collect();
        let before: Vec<Option<Rect>> = touched.iter().map(|&v| drawn.vertices[v].bounds).collect();
        for &v in &touched {
            let (m, row) = (drawn.vertices[v].mark, v - vertex_marks[drawn.vertices[v].mark].first);
            let half = self.half(&vertex_marks[m], &rows[m], row, input);
            let vertex = &mut drawn.vertices[v];
            vertex.half = half;
            vertex.pin = position(vertex_marks[m].mark, &rows[m], row);
            if !vertex.group {
                self.stand(vertex);
            }
        }
        // The block boxes the edit moved, added, or removed, which wires route around.
        let mut moved = Vec::new();
        for (&v, &was) in touched.iter().zip(&before) {
            let vertex = &drawn.vertices[v];
            if !vertex.group && vertex.bounds != was {
                moved.extend(was.into_iter().chain(vertex.bounds));
            }
        }
        // Refit the groups above the touched rows. A group whose box changed counts as touched.
        let framing = groups::Framing { header: &header, padding, places: &self.places };
        let regrouped = self.groups.refit(&mut drawn.vertices, &touched, &framing);
        if !regrouped.is_empty() {
            touched.extend(regrouped);
            touched.sort_unstable();
            touched.dedup();
        }
        for &v in &touched {
            self.blocks.set(v, obstacle(&drawn.vertices[v]));
        }
        // Layouts place only rows without a place, so start one only if the edit removed a place.
        if touched.iter().any(|&v| drawn.vertices[v].bounds.is_none()) {
            self.place(&drawn.vertices, vertex_marks, edge_marks, &header, padding, input, jobs);
        }
        let written =
            self.wire(&mut drawn, marks, &wires::Change { moved: &moved, touched: Some(&touched) }, input, jobs);
        for &v in &touched {
            let vertex = &drawn.vertices[v];
            match vertex.bounds {
                Some(b) => self.boxes.insert(vertex.key.clone(), b),
                None => self.boxes.remove(&vertex.key),
            };
        }
        self.show_labels(vertex_marks, &mut drawn.vertices, &touched, padding, input);
        if !write_rows(marks, &drawn, &touched, &written, &mut self.tables) {
            write(vertex_marks, &drawn.vertices, edge_marks, &drawn.wired.parts, &mut self.tables);
        }
        drawn
    }

    /// Places vertex `v` (not a group) where its data or a layout puts it. A row that lost its
    /// position stays where it was.
    fn stand(&mut self, v: &mut Vertex) {
        if v.pin.is_none()
            && !self.places.contains_key(&v.key)
            && let Some(b) = self.boxes.get(&v.key)
        {
            self.places.insert(v.key.clone(), [b[0].midpoint(b[2]), b[1].midpoint(b[3])]);
        }
        v.bounds = v.pin.or_else(|| self.places.get(&v.key).copied()).map(|center| around(center, v.half));
    }

    /// Computes the wires `change` affects. Returns the edge rows computed, by edge mark.
    fn wire(
        &mut self,
        drawn: &mut Drawn,
        (vertex_marks, edge_marks): &Marks<'_>,
        change: &wires::Change<'_>,
        input: &Input<'_>,
        jobs: &mut Jobs<'_>,
    ) -> Vec<Vec<usize>> {
        let theme = &input.scene.theme;
        let context = wires::Context {
            vertices: &drawn.vertices,
            marks: vertex_marks,
            edges: edge_marks,
            blocks: &self.blocks,
            groups: self.groups.boxes(),
            spacing: f64::from(theme.edge.spacing),
            bend: f64::from(theme.diagram.bend),
            port: f64::from(theme.diagram.port_size),
        };
        wires::paths(&context, input, jobs, change, &mut drawn.wired, (&mut self.routes, &mut self.routing))
    }

    /// Every vertex row of the diagram, sized, with the position its data gives it.
    fn vertices(&mut self, vertex_marks: &[VertexMark<'_>], input: &Input<'_>) -> Vec<Vertex> {
        let mut vertices = Vec::with_capacity(vertex_marks.iter().map(|vm| vm.table.len()).sum());
        for (m, vm) in vertex_marks.iter().enumerate() {
            let rows = Rows::new(vm.table, input.data);
            let (shape, group) = (shape_of(vm.mark), grouping(vm));
            for row in 0..vm.table.len() {
                let id = vm.table.ids.id(row).expect("every row has an id");
                vertices.push(Vertex {
                    mark: m,
                    key: Row { data: vm.data.name().clone(), table: vm.table.name().clone(), id },
                    half: self.half(vm, &rows, row, input),
                    pin: position(vm.mark, &rows, row),
                    bounds: None,
                    parent: None,
                    depth: 0,
                    group,
                    members: 0,
                    shape,
                    shown: Vec::new(),
                });
            }
        }
        vertices
    }

    /// Half the width and height of `vm`'s row `row`, in units: the largest any of the table's
    /// vertex marks draws it. See [`half_of`](Sheet::half_of).
    fn half(&mut self, vm: &VertexMark<'_>, rows: &Rows<'_>, row: usize, input: &Input<'_>) -> [f64; 2] {
        let (group, ports) = (grouping(vm), crate::derive::graph::ports(&vm.marks));
        let mut half = [0.0_f64; 2];
        for mark in &vm.marks {
            let [w, h] = self.half_of(mark, group, &ports, rows, row, input);
            half = [half[0].max(w), half[1].max(h)];
        }
        half
    }

    /// Half the width and height `mark` draws its row `row` at, in units: from its size, its
    /// radius, or else a box fitting its label and the table's `ports`. For a group, it is the size
    /// when the group holds nothing, with space for its title.
    fn half_of(
        &mut self,
        mark: &Vertices,
        group: bool,
        ports: &[&(Name, crate::Port)],
        rows: &Rows<'_>,
        row: usize,
        input: &Input<'_>,
    ) -> [f64; 2] {
        let theme = &input.scene.theme;
        let radius = f64::from(theme.vertex.radius);
        if !group {
            if let Some([w, h]) = &mark.size {
                let half = |size: &crate::Size| rows.number(&size.expr, row).map_or(radius, |v| v.max(0.0) / 2.0);
                return [half(w), half(h)];
            }
            if let Some(r) = &mark.radius {
                let r = rows.number(&r.expr, row).map_or(radius, |v| v.max(0.0));
                return [r, r];
            }
        }
        let text = self.label(mark, rows, row, input);
        if group {
            let padding = f64::from(theme.diagram.group_padding);
            let title = text.map_or(0.0, |([w, _], _)| w);
            return [title / 2.0 + padding, header(mark, theme) / 2.0 + padding];
        }
        // A row with neither a label nor ports is a dot.
        if text.is_none() && ports.is_empty() {
            return [radius, radius];
        }
        let size = text.map_or(f64::from(theme.text.size), |(_, size)| size);
        let [w, h] = text.map_or([0.0; 2], |(box_, _)| box_);
        // Scale up so a round or pointed outline contains its text's box.
        let fit = match shape_of(mark) {
            Shape::Ellipse => std::f64::consts::SQRT_2,
            Shape::Diamond => 2.0,
            Shape::Rectangle | Shape::Rounded => 1.0,
        };
        let (mut width, mut height) = if text.is_some() {
            ((w + 1.6 * size) * fit, (h + 1.2 * size) * fit)
        } else {
            (2.0 * radius, 2.0 * radius)
        };
        // Room for its ports: one pitch per port along each side, and width for the left and right
        // port labels on either side of the label.
        let port = f64::from(theme.diagram.port_size);
        let pitch = (2.0 * port).max(1.4 * size);
        let count = |side: Side| ports.iter().filter(|(_, p)| p.side == side).count() as f64;
        height = height.max((count(Side::Left).max(count(Side::Right)) + 1.0) * pitch);
        width = width.max((count(Side::Top).max(count(Side::Bottom)) + 1.0) * pitch);
        let port_text = 0.8 * theme.text.size;
        let mut widest = |side: Side| {
            let mut widest: f64 = 0.0;
            for label in ports.iter().filter(|(_, p)| p.side == side).filter_map(|(_, p)| p.label.as_deref()) {
                let run = atlas::run(label.into(), theme.text.font.clone(), port_text, None);
                widest = widest.max(self.measure(run, input)[0] * f64::from(port_text) / f64::from(TEXT_BASE));
            }
            widest
        };
        let labels = widest(Side::Left) + widest(Side::Right);
        if labels > 0.0 {
            width = width.max(w + labels + 3.0 * port + 1.6 * size);
        }
        // A named port on the top or bottom needs a line between its side and the label, and as
        // much on the other side to keep the label centered. Its share of the side fits its name.
        let mut stacked = false;
        for side in [Side::Top, Side::Bottom] {
            let name = widest(side);
            if name > 0.0 {
                stacked = true;
                width = width.max((count(side) + 1.0) * (name + port));
            }
        }
        if stacked {
            height = height.max(h + 1.2 * size + 2.0 * (1.3 * f64::from(port_text) + port));
        }
        [width / 2.0, height / 2.0]
    }

    /// The width and height of row `row`'s label in units, and its font size. `None` without a
    /// label.
    fn label(&mut self, mark: &Vertices, rows: &Rows<'_>, row: usize, input: &Input<'_>) -> Option<([f64; 2], f64)> {
        let label = mark.style.label.as_ref()?;
        let text = rows.text(&label.text, row)?;
        let theme = &input.scene.theme;
        let size = label.size.unwrap_or(theme.text.size);
        let font = label.font.clone().unwrap_or_else(|| theme.text.font.clone());
        let run = atlas::run(text, font, size, label.max_width);
        let measured = self.measure(run, input);
        Some((measured.map(|v| v * f64::from(size) / f64::from(TEXT_BASE)), f64::from(size)))
    }

    /// Sets the text each vertex mark labels vertices `which` with: the label's text, or where it is
    /// wider than its room, as much of it as fits followed by "…". A block's room is its width less
    /// the label's size, and a group's is its box less its padding. A label that wraps or holds
    /// several lines shows whole.
    fn show_labels(
        &mut self,
        vertex_marks: &[VertexMark<'_>],
        vertices: &mut [Vertex],
        which: &[usize],
        padding: f64,
        input: &Input<'_>,
    ) {
        let rows: Vec<Rows<'_>> = vertex_marks.iter().map(|vm| Rows::new(vm.table, input.data)).collect();
        let theme = &input.scene.theme;
        for &v in which {
            let (m, bounds, group) = (vertices[v].mark, vertices[v].bounds, vertices[v].group);
            let vm = &vertex_marks[m];
            let row = v - vm.first;
            let half_width = bounds.map_or(vertices[v].half[0], |b| (b[2] - b[0]) / 2.0);
            let shown = vm
                .marks
                .iter()
                .map(|mark| {
                    let label = mark.style.label.as_ref()?;
                    let text = rows[m].text(&label.text, row)?;
                    if label.max_width.is_some() || text.contains('\n') {
                        return Some(text);
                    }
                    let size = label.size.unwrap_or(theme.text.size);
                    let room = if group { 2.0 * (half_width - padding) } else { 2.0 * half_width - f64::from(size) };
                    let font = label.font.clone().unwrap_or_else(|| theme.text.font.clone());
                    self.cut(text, &font, size, room, input)
                })
                .collect();
            vertices[v].shown = shown;
        }
    }

    /// `text` as it fits `room` units in `font` at `size`: whole, or cut at a character and ended
    /// with "…". `None` when not even "…" fits. Each width tried is measured once and cached.
    fn cut(&mut self, text: Arc<str>, font: &Arc<str>, size: f32, room: f64, input: &Input<'_>) -> Option<Arc<str>> {
        // A little room is kept back, so the cut text also fits as the GPU measures its glyphs.
        let room = room - 0.1 * f64::from(size);
        let mut width = |s: &str| {
            let run = atlas::run(s.into(), font.clone(), size, None);
            self.measure(run, input)[0] * f64::from(size) / f64::from(TEXT_BASE)
        };
        if width(&text) <= room {
            return Some(text);
        }
        let ends: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
        let mut cut = |k: usize| -> Option<Arc<str>> {
            let shown: Arc<str> = format!("{}…", text[..ends[k]].trim_end()).into();
            (width(&shown) <= room).then_some(shown)
        };
        // The longest cut that fits: the cut at `lo` fits, and every cut from `over` on is too wide.
        let mut fits = cut(0)?;
        let (mut lo, mut over) = (0, ends.len());
        while over - lo > 1 {
            let mid = lo.midpoint(over);
            match cut(mid) {
                Some(shown) => (lo, fits) = (mid, shown),
                None => over = mid,
            }
        }
        Some(fits)
    }

    /// The width and height of `run` in base pixels: measured once by the host and cached, or
    /// estimated when there is no host or measuring fails.
    fn measure(&mut self, run: TextRun, input: &Input<'_>) -> [f64; 2] {
        if let Some(&size) = self.measured.get(&run) {
            return size;
        }
        let base = f64::from(TEXT_BASE);
        let measured = input.host.map(|host| host.measure(&run));
        let size = match measured {
            Some(Ok(size)) => size,
            other => {
                if let Some(Err(error)) = other {
                    self.errors.push(error);
                }
                // Without a host, 0.6 em per character of the longest line and 1.25 em per line.
                let longest = run.text.lines().map(|line| line.chars().count()).max().unwrap_or(0);
                return [longest as f64 * 0.6 * base, run.text.lines().count().max(1) as f64 * 1.25 * base];
            }
        };
        if self.measured.len() >= MEASURED {
            self.measured.clear();
        }
        let size = size.map(f64::from);
        self.measured.insert(run, size);
        size
    }

    /// Starts a layout job, unless one is pending, to place every block and empty group that has no
    /// place (while arranging, no position). Other rows are pinned, and groups lay out around their
    /// members.
    #[allow(clippy::too_many_arguments, reason = "one layout request")]
    fn place(
        &mut self,
        vertices: &[Vertex],
        vertex_marks: &[VertexMark<'_>],
        edge_marks: &[EdgeMark<'_>],
        header: &[f64],
        padding: f64,
        input: &Input<'_>,
        jobs: &Jobs<'_>,
    ) {
        let layout = input.scene.layout;
        let arranging = self.arranging;
        let placed = |v: &Vertex| if arranging { v.pin.is_some() } else { v.bounds.is_some() };
        let wanted = |v: &Vertex| !placed(v) && (!v.group || v.members == 0);
        if self.placing.is_some() {
            return;
        }
        if matches!(layout, Layout::None) || !vertices.iter().any(wanted) {
            // Nothing to lay out: the arrange finishes with no rows.
            if std::mem::take(&mut self.arranging) {
                self.arranged = Some(Vec::new());
            }
            return;
        }
        // Layouts are y up, so a group's header pads its top.
        let sizes: Vec<[f64; 2]> = vertices.iter().map(|v| v.half.map(|h| 2.0 * h)).collect();
        let pinned: Vec<Option<[f64; 2]>> = vertices
            .iter()
            .map(|v| v.center().filter(|_| placed(v) && (!v.group || v.members == 0)).map(|c| [c[0], -c[1]]))
            .collect();
        let groups: Vec<Option<u32>> = vertices.iter().map(|v| v.parent.map(|p| p as u32)).collect();
        let pads: Vec<[f64; 4]> =
            vertices.iter().map(|v| [padding, padding, padding, padding + header[v.mark]]).collect();
        let links = links(vertex_marks, edge_marks);
        let mut rows = FxHashMap::default();
        let keys: Vec<Option<Key>> = vertices
            .iter()
            .map(|v| {
                let key = key_of(&v.key);
                (wanted(v) && rows.insert(key.clone(), v.key.clone()).is_none()).then_some(key)
            })
            .collect();
        let placement =
            Placement { sizes: &sizes, pinned: &pinned, groups: &groups, pads: &pads, links: &links, keys: &keys };
        let pending = jobs.spawn(Job::layout(&layout, &placement));
        self.placing = Some(Placing { pending, generation: self.generation, rows });
    }
}

/// A stamp of the sheet's inputs: the scene version, whether a host measures text, the answers
/// received, the places generation, whether rows are being dragged, and the marks' structure.
fn stamp(input: &Input<'_>, landed: u64, generation: u64) -> u64 {
    let mut hasher = FxHasher::default();
    (input.scene_version, input.host.is_some(), landed, generation, input.dragging).hash(&mut hasher);
    input.structure(&mut hasher);
    hasher.finish().max(1)
}

/// The diagram's vertex marks and edge marks.
type Marks<'a> = (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>);

/// The current inputs to the marks' structure.
fn seen(input: &Input<'_>) -> Vec<Seen> {
    let mut seen = Vec::new();
    input.reads(&mut |read| {
        seen.push(match read {
            Read::Rows { data, table, rows } => {
                Seen::Rows { key: (data.clone(), table.clone()), structure: rows.structure, order: rows.order }
            }
            Read::Field { data, table, name, field, .. } => {
                Seen::Field { key: (data.clone(), table.clone(), name.into()), field: field.cloned().map(Box::new) }
            }
        });
    });
    seen
}

/// The vertex rows written since `drawn`, as sorted vertex indices. `None` unless the same tables
/// hold the same rows and the only changes are to values that size or place each row by its own
/// value.
fn edited(drawn: &Drawn, input: &Input<'_>, vertex_marks: &[VertexMark<'_>]) -> Option<Vec<usize>> {
    let mut seen = drawn.reads.iter();
    let mut rows = Vec::new();
    let mut same = true;
    input.reads(&mut |read| {
        let Some(then) = seen.next().filter(|_| same) else {
            same = false;
            return;
        };
        same = match (read, then) {
            (Read::Rows { data, table, rows: now }, Seen::Rows { key, structure, order }) => {
                (data, table) == (&key.0, &key.1) && now.structure == *structure && now.order == *order
            }
            (Read::Field { data, table, name, field, own }, Seen::Field { key, field: before }) => {
                (data, table, name) == (&key.0, &key.1, key.2.as_str())
                    && match (field, before.as_deref()) {
                        (None, None) => true,
                        (Some(now), Some(then)) if now.version() == then.version() => true,
                        (Some(Field::Values(now, _)), Some(Field::Values(then, _))) if own => {
                            drawing(vertex_marks, data, table).is_some_and(|m| {
                                let changed = now.changed_since(then);
                                rows.extend(changed.into_iter().map(|row| vertex_marks[m].first + row));
                                true
                            })
                        }
                        _ => false,
                    }
            }
            _ => false,
        };
    });
    (same && seen.next().is_none()).then(|| {
        rows.sort_unstable();
        rows.dedup();
        rows
    })
}

/// The height of each vertex mark's group header band, and the padding around group members.
fn framing(vertex_marks: &[VertexMark<'_>], theme: &Theme) -> (Vec<f64>, f64) {
    (vertex_marks.iter().map(|vm| header(vm.mark, theme)).collect(), f64::from(theme.diagram.group_padding))
}

/// Vertex `v`'s box as a routing obstacle, y up. `EMPTY` for a group, which wires may pass through.
fn obstacle(v: &Vertex) -> Rect {
    v.bounds.filter(|_| !v.group).map_or(EMPTY, |b| [b[0], -b[3], b[2], -b[1]])
}

/// Whether a table's rows are groups: one of its vertex marks contains other rows.
fn grouping(vm: &VertexMark<'_>) -> bool {
    vm.marks.iter().any(|mark| !mark.contains.is_empty())
}

/// The outline a vertex mark's markers draw: a rectangle for groups, blocks, icons, and WGSL
/// markers, an ellipse for pies, else the marker's shape.
fn shape_of(mark: &Vertices) -> Shape {
    if !mark.contains.is_empty() {
        return Shape::Rectangle;
    }
    match &mark.marker {
        Marker::Shape(shape) | Marker::Gauge { shape, .. } => *shape,
        Marker::Pie { .. } => Shape::Ellipse,
        Marker::Block { .. } | Marker::Icon { .. } | Marker::Wgsl { .. } => Shape::Rectangle,
    }
}

/// The height in units of the band across the top of a group mark's boxes, where titles sit. 0 for
/// other marks, or without labels.
fn header(mark: &Vertices, theme: &Theme) -> f64 {
    match &mark.style.label {
        Some(label) if !mark.contains.is_empty() => f64::from(label.size.unwrap_or(theme.text.size) * HEADER_BAND),
        _ => 0.0,
    }
}

/// Sets each row's group: the rows of each table a group mark contains belong to the group their
/// reference names. Then sets how many groups hold each row, dropping the group of a row whose
/// walk up the groups cycles, and how many rows each group directly holds.
fn hold(vertex_marks: &[VertexMark<'_>], vertices: &mut [Vertex]) {
    let contained = |vm: &VertexMark<'_>| vm.marks.iter().flat_map(|mark| &mark.contains).cloned().collect::<Vec<_>>();
    for vm in vertex_marks {
        for (table, reference) in contained(vm) {
            hold_table(vertex_marks, vm, &table, &reference, vertices);
        }
    }
    for v in 0..vertices.len() {
        let (mut depth, mut at) = (0_u32, vertices[v].parent);
        while let Some(p) = at {
            depth += 1;
            if depth as usize > vertices.len() {
                vertices[v].parent = None;
                depth = 0;
                break;
            }
            at = vertices[p].parent;
        }
        vertices[v].depth = depth;
    }
    for v in 0..vertices.len() {
        if let Some(p) = vertices[v].parent {
            vertices[p].members += 1;
        }
    }
}

/// Puts each row of `table` in the group of `vm`'s table that its `reference` field names.
fn hold_table(
    vertex_marks: &[VertexMark<'_>],
    vm: &VertexMark<'_>,
    table: &Name,
    reference: &Name,
    vertices: &mut [Vertex],
) {
    let Some(m) = drawing(vertex_marks, vm.data.name(), table) else { return };
    let members = &vertex_marks[m];
    let Some(Field::Reference(r)) = members.table.field_named(reference) else { return };
    if r.to != *vm.table.name() {
        return;
    }
    for row in 0..members.table.len() {
        let Some(group_row) = r.target(row) else { continue };
        let (member, group) = (members.first + row, vm.first + group_row as usize);
        if member != group {
            vertices[member].parent = Some(group);
        }
    }
}

/// A derived table to write: its dataset and table, the table it stands beside, and its fields.
type Writing<'a> = ((Name, Name), &'a Table, Vec<(Name, Values)>);

/// The derived text field holding the text a vertex mark named `name` labels each block with, cut
/// to fit. A diagram's label reads it.
pub(crate) fn shown_label(name: Option<&Name>) -> Name {
    match name {
        Some(name) => format!("label of {name}").into(),
        None => "label".into(),
    }
}

/// Each labeled vertex mark of `vm`'s table: its [`shown_label`] field, and its index among the
/// table's marks.
fn labeled<'a>(vm: &'a VertexMark<'_>) -> impl Iterator<Item = (Name, usize)> + 'a {
    let labeled = vm.marks.iter().enumerate().filter(|(_, mark)| mark.style.label.is_some());
    labeled.map(|(k, mark)| (shown_label(mark.style.name.as_ref()), k))
}

/// The texts `vertices` show for their table's mark `k`.
fn shown_texts<'v>(vertices: impl Iterator<Item = &'v Vertex>, k: usize) -> Values {
    let texts: Vec<Option<String>> =
        vertices.map(|v| v.shown.get(k).cloned().flatten().map(|t| t.to_string())).collect();
    Values::from(texts)
}

/// A derived field of a vertex table: its name, and its value for a vertex.
type VertexField = (&'static str, fn(&Vertex) -> Option<f64>);

/// A vertex table's derived fields: center, half sizes, then depth (how many groups hold it).
/// Depth changes only when group membership does.
const VERTEX_FIELDS: [VertexField; 5] = [
    ("x", |v| v.center().map(|c| c[0])),
    ("y", |v| v.center().map(|c| c[1])),
    ("half_x", |v| v.bounds.map(|b| (b[2] - b[0]) / 2.0)),
    ("half_y", |v| v.bounds.map(|b| (b[3] - b[1]) / 2.0)),
    ("depth", |v| Some(f64::from(v.depth))),
];

/// Writes each drawn table's derived table (a vertex table's centers, half sizes, and depths, or an
/// edge table's paths), and drops those of tables no longer drawn. A field equal to the previous
/// one keeps its column, so nothing uploads again.
fn write(
    vertex_marks: &[VertexMark<'_>],
    vertices: &[Vertex],
    edge_marks: &[EdgeMark<'_>],
    paths: &[Vec<wires::Parts>],
    derived: &mut Tables,
) {
    let mut tables: Vec<Writing<'_>> = Vec::new();
    for vm in vertex_marks {
        let own = &vertices[vm.first..vm.first + vm.table.len()];
        let mut fields: Vec<(Name, Values)> = VERTEX_FIELDS
            .iter()
            .map(|&(name, value)| (name.into(), Values::from(own.iter().map(value).collect::<Vec<_>>())))
            .collect();
        fields.extend(labeled(vm).map(|(name, k)| (name, shown_texts(own.iter(), k))));
        tables.push(((vm.data.name().clone(), vm.table.name().clone()), vm.table, fields));
    }
    for (em, paths) in edge_marks.iter().zip(paths) {
        let key = (em.data.name().clone(), em.table.name().clone());
        let field = (Name::from("route"), Values::from(paths.clone()));
        match tables.iter_mut().find(|(k, ..)| *k == key) {
            Some((.., fields)) => fields.push(field),
            None => tables.push((key, em.table, vec![field])),
        }
    }
    derived.retain(|key, _| tables.iter().any(|(k, ..)| k == key));
    for (key, source, fields) in tables {
        let before = derived.get(&key);
        let fields: Vec<(Name, Field)> = fields
            .into_iter()
            .map(|(name, values)| {
                let field = kept(&name, &values, source, before);
                (name, field)
            })
            .collect();
        derived.insert(key, beside(source, fields));
    }
}

/// Writes an edit's results into the derived tables row by row: the center and half sizes of each
/// vertex in `touched`, and the parts of each edge row in `written`, so only the pages they fall on
/// change. Returns false when a derived table lacks a field to write.
fn write_rows(
    (vertex_marks, edge_marks): &Marks<'_>,
    drawn: &Drawn,
    touched: &[usize],
    written: &[Vec<usize>],
    derived: &mut Tables,
) -> bool {
    for vm in vertex_marks {
        let within =
            touched.partition_point(|&v| v < vm.first)..touched.partition_point(|&v| v < vm.first + vm.table.len());
        let rows: Vec<usize> = touched[within].iter().map(|&v| v - vm.first).collect();
        if rows.is_empty() {
            continue;
        }
        let Some(table) = derived.get_mut(&(vm.data.name().clone(), vm.table.name().clone())) else { return false };
        // An edit does not change group membership, so depth stays unchanged.
        for &(name, value) in &VERTEX_FIELDS[..4] {
            let values =
                Values::from(rows.iter().map(|&row| value(&drawn.vertices[vm.first + row])).collect::<Vec<_>>());
            if !write_field(table, name, &rows, &values) {
                return false;
            }
        }
        for (name, k) in labeled(vm) {
            let values = shown_texts(rows.iter().map(|&row| &drawn.vertices[vm.first + row]), k);
            if !write_field(table, &name, &rows, &values) {
                return false;
            }
        }
    }
    for ((em, rows), parts) in edge_marks.iter().zip(written).zip(&drawn.wired.parts) {
        if rows.is_empty() {
            continue;
        }
        let Some(table) = derived.get_mut(&(em.data.name().clone(), em.table.name().clone())) else { return false };
        let values = Values::from(rows.iter().map(|&row| parts[row].clone()).collect::<Vec<_>>());
        if !write_field(table, "route", rows, &values) {
            return false;
        }
    }
    true
}

/// Writes `values` over rows `rows` of field `name` of `table`, skipping rows that already hold
/// their value, so a page changes only when one of its values does. Returns false when `table` has
/// no such values column or the write fails.
fn write_field(table: &mut Table, name: &str, rows: &[usize], values: &Values) -> bool {
    let Some(Field::Values(column, _)) = table.field_named(name) else { return false };
    let writes: Vec<(usize, usize)> =
        rows.iter().copied().zip(0..).filter(|&(row, at)| !column.holds(row, values, at)).collect();
    if writes.is_empty() {
        return true;
    }
    let Ok(column) = column.write(column.len(), &writes, &Column::new(values)) else { return false };
    table.insert(name.into(), Field::Values(column, Version::next()));
    true
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::task::Waker;

    use super::*;
    use crate::data::{Data, Ids, Patch};
    use crate::gpu::work::Counters;
    use crate::{Diagram, Edges, Grid, Label, Port, Route, Scene, field};

    const BLOCKS: u64 = 24;

    /// Blocks with labels and ports, most in one of two groups inside one outer group. They are
    /// wired by orthogonal nets, by straight edges with lanes between the same two blocks, and by
    /// orthogonal edges with endpoints, some leaving one block by the same side.
    fn diagram() -> (Scene, Data) {
        let scene = Scene::new(Diagram { grid: Grid::Off })
            .draw(Vertices::of("d", "H").contains("G", "outer"))
            .draw(Vertices::of("d", "G").contains("B", "group"))
            .draw(Edges::of("d", "N").route(Route::Orthogonal))
            .draw(Edges::of("d", "E").ends("from", "to"))
            .draw(Edges::of("d", "F").ends("from", "to").route(Route::Orthogonal))
            .draw(
                Vertices::of("d", "B")
                    .position(field("x"), field("y"))
                    .label(Label::new(field("name")))
                    .port("in", Side::Left)
                    .port("out", Port::output(Side::Right)),
            );
        let names: Vec<String> = (0..BLOCKS).map(|i| format!("block {i}")).collect();
        let blocks = Table::new("B", (0..BLOCKS).collect::<Vec<_>>())
            .field("x", (0..BLOCKS).map(|i| (i % 6) as f64 * 160.0).collect::<Vec<_>>())
            .field("y", (0..BLOCKS).map(|i| (i / 6) as f64 * 120.0).collect::<Vec<_>>())
            .field("name", names.iter().map(String::as_str).collect::<Vec<_>>())
            .reference(
                "group",
                "G",
                (0..BLOCKS).map(|i| [Some(1_u64), Some(1), Some(2), None][i as usize % 4]).collect::<Vec<_>>(),
            )
            .reference("out", "N", (0..BLOCKS).map(|i| Some(i / 2)).collect::<Vec<_>>())
            .reference("in", "N", (0..BLOCKS).map(|i| (i > 1).then(|| (i - 2) / 2)).collect::<Vec<_>>());
        let pairs = |from: Vec<u64>, to: Vec<u64>, name: &str| {
            Table::new(name, Ids::count(from.len() as u32)).reference("from", "B", from).reference("to", "B", to)
        };
        let data = Data::new("d");
        data.apply(
            Patch::new()
                .set(Table::new("H", vec![1_u64]))
                .set(Table::new("G", vec![1_u64, 2]).reference("outer", "H", vec![Some(1_u64), Some(1)]))
                .set(Table::new("N", (0..BLOCKS / 2).collect::<Vec<_>>()))
                .set(blocks)
                .set(pairs(vec![0, 0, 3, 7], vec![1, 1, 9, 15], "E"))
                .set(pairs(vec![4, 5, 11, 20, 4, 4, 9], vec![10, 17, 12, 21, 11, 16, 4], "F")),
        )
        .expect("valid");
        (scene, data)
    }

    /// The first row at which two sets of derived tables differ.
    fn differ(a: &Tables, b: &Tables) -> Option<String> {
        if a.len() != b.len() {
            return Some(format!("{} tables, not {}", a.len(), b.len()));
        }
        for (key, ta) in a {
            let Some(tb) = b.get(key) else { return Some(format!("no {key:?}")) };
            for (name, _) in &ta.fields {
                for row in 0..ta.len() {
                    let (va, vb) = (ta.value(row, name, f64::INFINITY), tb.value(row, name, f64::INFINITY));
                    if va != vb {
                        return Some(format!("{key:?}.{name}[{row}]: {va:?} and {vb:?}"));
                    }
                }
            }
        }
        None
    }

    /// Updates `sheet` to `data`, routing on the frame as during a drag. Returns whether it redrew
    /// only what an edit affected.
    fn derive(sheet: &mut Sheet, scene: &Scene, data: &Data) -> bool {
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let now = data.snapshot();
        let input = Input {
            scene,
            scene_version: 1,
            data: std::slice::from_ref(&now),
            host: None,
            dragging: true,
            paged: None,
        };
        let edit = sheet.drawn.as_ref().is_some_and(|drawn| edited(drawn, &input, &marks(&input).0).is_some());
        sheet.update(&input, &mut Jobs::new(None, Waker::noop(), &counters, &errors, crate::derive::FRAME_WORK));
        edit
    }

    #[test]
    fn a_wire_reroutes_around_a_block_moved_into_its_path() {
        let scene = Scene::new(Diagram { grid: Grid::Off })
            .draw(Edges::of("d", "F").ends("from", "to").route(Route::Orthogonal))
            .draw(Vertices::of("d", "B").position(field("x"), field("y")).label(Label::new(field("name"))));
        let blocks = Table::new("B", vec![0_u64, 1, 2])
            .field("x", vec![0.0, 400.0, 200.0])
            .field("y", vec![0.0, 0.0, 400.0])
            .field("name", vec!["a", "b", "c"]);
        let wire = Table::new("F", Ids::count(1)).reference("from", "B", vec![0_u64]).reference("to", "B", vec![1_u64]);
        let data = Data::new("d");
        data.apply(Patch::new().set(blocks).set(wire)).expect("valid");
        let mut sheet = Sheet::default();
        derive(&mut sheet, &scene, &data);
        // The third block moves into the wire's path. The wire does not end at it, so only the
        // moved box near the wire makes it route again.
        data.apply(Table::new("B", vec![2_u64]).field("y", vec![0.0])).expect("valid edit");
        assert!(derive(&mut sheet, &scene, &data), "only what the edit affects is redrawn");
        let b = sheet.bounds(&Row { data: "d".into(), table: "B".into(), id: 2_u64.into() }).expect("placed");
        let Some(Value::Parts(parts)) = sheet.tables.get(&("d".into(), "F".into())).and_then(|t| t.get(0_u64, "route"))
        else {
            panic!("a route");
        };
        for [p, q] in parts.iter().flat_map(|part| part.windows(2)).map(|pq| [pq[0], pq[1]]) {
            for t in (0..=32).map(|t| f64::from(t) / 32.0) {
                let [x, y] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
                assert!(!(b[0] < x && x < b[2] && b[1] < y && y < b[3]), "{parts:?} runs through {b:?}");
            }
        }
    }

    /// The derived value of field `name` of row `id` of table `table`.
    fn derived(sheet: &Sheet, table: &str, id: u64, name: &str) -> Option<Value> {
        sheet.tables.get(&("d".into(), table.into()))?.get(id, name)
    }

    fn row(table: &str, id: u64) -> Row {
        Row { data: "d".into(), table: table.into(), id: id.into() }
    }

    #[test]
    fn a_group_holds_rows_of_several_tables() {
        let scene = Scene::new(Diagram { grid: Grid::Off })
            .draw(Vertices::of("d", "Unit").contains("Machine", "unit").contains("Exciter", "unit"))
            .draw(Vertices::of("d", "Machine").position(field("x"), field("y")))
            .draw(Vertices::of("d", "Exciter").position(field("x"), field("y")));
        let member = |name: &str, x: f64| {
            Table::new(name, vec![1_u64]).field("x", vec![x]).field("y", vec![0.0]).reference(
                "unit",
                "Unit",
                vec![1_u64],
            )
        };
        let data = Data::new("d");
        data.apply(
            Patch::new().set(Table::new("Unit", vec![1_u64])).set(member("Machine", 0.0)).set(member("Exciter", 300.0)),
        )
        .expect("valid");
        let mut sheet = Sheet::default();
        derive(&mut sheet, &scene, &data);
        let unit = sheet.bounds(&row("Unit", 1)).expect("the group has a box");
        for table in ["Machine", "Exciter"] {
            let b = sheet.bounds(&row(table, 1)).expect("placed");
            assert!(unit[0] < b[0] && unit[1] < b[1] && b[2] < unit[2] && b[3] < unit[3], "{table} {b:?} in {unit:?}");
        }
    }

    #[test]
    fn a_net_of_one_port_draws_a_stub_out_from_it() {
        let scene = Scene::new(Diagram { grid: Grid::Off })
            .draw(Edges::of("d", "N"))
            .draw(Vertices::of("d", "B").position(field("x"), field("y")).port("out", Port::output(Side::Right)));
        let data = Data::new("d");
        data.apply(Patch::new().set(Table::new("N", vec![1_u64])).set(
            Table::new("B", vec![1_u64]).field("x", vec![0.0]).field("y", vec![0.0]).reference("out", "N", vec![1_u64]),
        ))
        .expect("valid");
        let mut sheet = Sheet::default();
        derive(&mut sheet, &scene, &data);
        let b = sheet.bounds(&row("B", 1)).expect("placed");
        let Some(Value::Parts(parts)) = derived(&sheet, "N", 1, "route") else { panic!("a route") };
        let [part] = &parts[..] else { panic!("one stub: {parts:?}") };
        let [from, to] = part[..] else { panic!("a straight stub: {part:?}") };
        assert!(from[0] >= b[2] && to[0] > from[0] && from[1] == to[1], "out to the right of {b:?}: {part:?}");
    }

    #[test]
    fn every_vertex_mark_of_a_table_gives_its_blocks_ports_and_size() {
        // The second mark of the table adds an output port, and is drawn larger.
        let scene = Scene::new(Diagram { grid: Grid::Off })
            .draw(Edges::of("d", "N"))
            .draw(Vertices::of("d", "B").position(field("x"), field("y")).size(40.0, 20.0).port("in", Side::Left))
            .draw(
                Vertices::of("d", "B")
                    .named("outputs")
                    .position(field("x"), field("y"))
                    .size(60.0, 30.0)
                    .port("out", Port::output(Side::Right)),
            );
        let data = Data::new("d");
        let blocks = Table::new("B", vec![1_u64, 2])
            .field("x", vec![0.0, 200.0])
            .field("y", vec![0.0, 0.0])
            .reference("out", "N", vec![Some(1_u64), None])
            .reference("in", "N", vec![None, Some(1_u64)]);
        data.apply(Patch::new().set(Table::new("N", vec![1_u64])).set(blocks)).expect("valid");
        let mut sheet = Sheet::default();
        derive(&mut sheet, &scene, &data);
        assert_eq!(derived(&sheet, "B", 1, "half_x"), Some(Value::Number(30.0)), "the larger mark's size");
        let Some(Value::Parts(parts)) = derived(&sheet, "N", 1, "route") else { panic!("a route") };
        let [part] = &parts[..] else { panic!("one wire: {parts:?}") };
        let (first, last) = (part[0], part[part.len() - 1]);
        assert!(first[0] >= 30.0 && last[0] <= 170.0, "from block 1's output to block 2's input: {part:?}");
    }

    #[test]
    fn a_label_wider_than_its_block_ends_in_an_ellipsis() {
        let scene = Scene::new(Diagram { grid: Grid::Off }).draw(
            Vertices::of("d", "B").position(field("x"), field("y")).size(80.0, 20.0).label(Label::new(field("name"))),
        );
        let data = Data::new("d");
        let names = vec!["ok", "a label much too long for its block"];
        data.apply(
            Table::new("B", vec![1_u64, 2])
                .field("x", vec![0.0, 0.0])
                .field("y", vec![0.0, 100.0])
                .field("name", names),
        )
        .expect("valid");
        let mut sheet = Sheet::default();
        derive(&mut sheet, &scene, &data);
        assert_eq!(derived(&sheet, "B", 1, "label"), Some(Value::Text("ok".into())), "a label that fits shows whole");
        let Some(Value::Text(cut)) = derived(&sheet, "B", 2, "label") else { panic!("a label") };
        assert!(cut.ends_with('…') && cut.len() < 20 && "a label much".starts_with(cut.trim_end_matches('…')), "{cut}");
    }

    #[test]
    fn edits_derive_the_same_tables_as_a_full_rebuild() {
        let (scene, data) = diagram();
        let (mut edits, mut whole) = (Sheet::default(), Sheet::default());
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        let mut random = |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let mut redrawn = 0;
        for step in 0..60 {
            if step > 0 {
                // Renames resize a block; moves and lost positions move it.
                let rows: Vec<u64> = (0..=random(3)).map(|_| random(BLOCKS)).collect();
                let edit = match random(3) {
                    0 => Table::new("B", rows.clone()).field(
                        "name",
                        rows.iter().map(|r| format!("b{r}{}", "x".repeat(random(12) as usize))).collect::<Vec<_>>(),
                    ),
                    1 => Table::new("B", rows.clone())
                        .field("x", rows.iter().map(|_| random(1000) as f64).collect::<Vec<_>>())
                        .field("y", rows.iter().map(|_| random(600) as f64).collect::<Vec<_>>()),
                    _ => Table::new("B", rows.clone()).field("x", vec![None::<f64>; rows.len()]),
                };
                // Skip edits that name a row twice; the last value would win.
                let mut unique = rows.clone();
                unique.sort_unstable();
                unique.dedup();
                if unique.len() < rows.len() {
                    continue;
                }
                data.apply(edit).expect("valid edit");
            }
            redrawn += usize::from(derive(&mut edits, &scene, &data));
            whole.drawn = None;
            derive(&mut whole, &scene, &data);
            if let Some(difference) = differ(&edits.tables, &whole.tables) {
                panic!("step {step}: {difference}");
            }
            assert_eq!(edits.extent(), whole.extent(), "step {step}");
        }
        assert!(redrawn > 30, "most steps redraw only what the edit affects: {redrawn} of 60");
    }
}
