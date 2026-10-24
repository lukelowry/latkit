//! A diagram's sheet: where every vertex row stands and how large it is, the boxes groups draw
//! around their members, and the paths wires run along, in units with y down. It is made from the
//! data and the scene alone, never from what was drawn, so the camera, hover, and motion never
//! change it. Places persist by row, so adding a row moves nothing else, and a row that loses its
//! position stays where it stood; layouts place only rows without one, until arranging lays every
//! row out again, and a wire routes again only when its terminals move or a box near it changes.
//! Superlinear work too large for the frame (layouts, many routes) is a host job answering with a
//! patch. The sheet is a derivation: it writes a table beside each table it draws, row for row,
//! which marks read like data. An edit of the values rows are sized and placed by derives only the
//! rows it wrote and what they reach: their boxes, the groups around them, and the wires they move.

mod wires;

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHasher};

use crate::data::{Column, Field, Name, Row, Table, Value, Values, Version};
use crate::derive::graph::{EdgeMark, VertexMark, drawing, key_of, links, marks, position};
use crate::derive::{Derive, Input, Jobs, Read, Tables, answers, beside, kept, stamp_of};
use crate::expr::cpu::Rows;
use crate::gpu::atlas;
use crate::gpu::shaders::{HEADER_BAND, TEXT_BASE};
use crate::host::{Job, Key, Placement, TextRun};
use crate::layout::rect::{Rect, around, union};
use crate::{Layout, Marker, Pending, Shape, Side, Theme, Vertices};

/// Texts measured past which the sheet forgets them all.
const MEASURED: usize = 1 << 16;

/// The sheet of a diagram's view.
#[derive(Default)]
pub(crate) struct Sheet {
    /// Failures to tell: texts its host could not measure.
    errors: Vec<crate::Error>,
    /// The derived table beside each table it draws.
    tables: Tables,
    /// Places layouts gave rows without positions, kept by row, also after a row leaves, so undo
    /// puts it back where it was.
    places: FxHashMap<Row, [f64; 2]>,
    /// Each orthogonal wire's route, by edge row.
    routes: FxHashMap<Row, wires::Routed>,
    /// The size each run of text takes, as its host measured it.
    measured: FxHashMap<TextRun, [f64; 2]>,
    /// The box of every placed vertex row the last update made: what a change moved.
    boxes: FxHashMap<Row, [f64; 4]>,
    /// The box holding every placed vertex and every wire the last update made.
    extent: Option<[f64; 4]>,
    /// What the derived tables were last made from.
    stamp: u64,
    /// Bumps when places start over, so layouts asked before are dropped.
    generation: u64,
    /// Whether every row without a position is to be laid out again, standing where it is until
    /// the layout answers.
    arranging: bool,
    /// What the last arranging laid out, until the view takes it.
    arranged: Option<Vec<(Row, [f64; 2])>>,
    /// The layout places were made by.
    layout: Option<Layout>,
    placing: Option<Placing>,
    routing: Option<wires::Routing>,
    /// Bumps whenever an answer lands.
    landed: u64,
    /// What the last update drew, which an edit derives from.
    drawn: Option<Drawn>,
}

/// What the sheet last drew: every vertex row as it stood, what wiring keeps, what the structure of
/// the marks read, and a stamp of the scene, the host, the answers landed, and the generation of
/// places it was drawn from.
struct Drawn {
    vertices: Vec<Vertex>,
    wired: wires::Wired,
    reads: Vec<Seen>,
    from: u64,
}

/// What the structure of the marks read when the sheet was drawn: a table's rows, or a field.
enum Seen {
    Rows { key: (Name, Name), structure: Version, order: Version },
    Field { key: (Name, Name, Name), field: Option<Box<Field>> },
}

/// A layout under way: the generation of places it was asked in, and the row each key it answers
/// for names.
struct Placing {
    pending: Pending<Vec<u8>>,
    generation: u64,
    rows: FxHashMap<Key, Row>,
}

// A vertex row of the diagram.
pub(crate) struct Vertex {
    /// The vertex mark drawing it.
    pub(crate) mark: usize,
    pub(crate) key: Row,
    /// Half its width and height, units; a group's while it holds nothing placed.
    pub(crate) half: [f64; 2],
    /// The position its data gives it.
    pub(crate) pin: Option<[f64; 2]>,
    /// Its box, least x and y then greatest, once it has a place.
    pub(crate) bounds: Option<[f64; 4]>,
    /// The group holding it, and how many groups hold it.
    pub(crate) parent: Option<usize>,
    pub(crate) depth: u32,
    /// Whether it is a group, and how many rows it holds.
    pub(crate) group: bool,
    pub(crate) members: u32,
    pub(crate) shape: Shape,
}

impl Vertex {
    pub(crate) fn center(&self) -> Option<[f64; 2]> {
        self.bounds.map(|b| [b[0].midpoint(b[2]), b[1].midpoint(b[3])])
    }
}

impl Derive for Sheet {
    /// Brings the sheet up to `input`, writing each drawn table's derived table.
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        if self.layout != Some(input.scene.layout) {
            if self.layout.is_some() {
                self.arrange();
            }
            self.layout = Some(input.scene.layout);
        }
        let mut changed = false;
        // A job its host does at once is taken before the frame draws.
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

    /// Whether a layout or routes are under way.
    fn busy(&self) -> bool {
        self.placing.is_some() || self.routing.is_some()
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    /// Forgets the tables but keeps places and routes: a scene that is a diagram again finds its rows
    /// where they stood.
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
    /// Whether a layout is under way, which a fit waits for.
    pub(crate) fn placing(&self) -> bool {
        self.placing.is_some()
    }

    /// Lays every row without a position out again; until the layout answers, rows stand where they
    /// are.
    pub(crate) fn arrange(&mut self) {
        self.arranging = true;
        self.placing = None;
        self.generation += 1;
        self.stamp = 0;
    }

    /// What the last arranging laid out, once it landed: each row placed, and where, units with y
    /// down.
    pub(crate) fn take_arranged(&mut self) -> Option<Vec<(Row, [f64; 2])>> {
        self.arranged.take()
    }

    /// Row `row`'s box, units with y down, once it has one.
    pub(crate) fn bounds(&self, row: &Row) -> Option<[f64; 4]> {
        self.boxes.get(row).copied()
    }

    /// The box holding every placed vertex and every wire, units with y down, once anything is placed.
    pub(crate) fn extent(&self) -> Option<[f64; 4]> {
        self.extent
    }

    /// Takes the answers that landed: places asked in the current generation, and routes.
    fn settle(&mut self) {
        if let Some(answer) = self.placing.as_ref().and_then(|p| p.pending.take()) {
            let placing = self.placing.take().expect("a layout under way");
            if placing.generation == self.generation {
                let mut placed = Vec::new();
                for (key, values) in answer.map(|bytes| answers(&bytes, &["x", "y"])).unwrap_or_default() {
                    if let (Some(row), [Some(Value::Number(x)), Some(Value::Number(y))]) =
                        (placing.rows.get(&key), &values[..])
                    {
                        // Layouts lay out with y up.
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

    /// Makes the derived tables again: sizes, places, group boxes, then wires. After an edit of only
    /// values rows are sized and placed by, each by its own row's, only what the rows it wrote reach.
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
        stand_groups(&mut vertices, &self.places, &header, padding);
        self.place(&vertices, vertex_marks, edge_marks, &header, padding, input, jobs);
        let moved = wires::moved(&self.boxes, &vertices);
        let mut drawn = Drawn { vertices, wired: wires::Wired::default(), reads: Vec::new(), from: 0 };
        self.wire(&mut drawn, marks, &wires::Change { moved: &moved, touched: None }, input, jobs);
        self.boxes = drawn.vertices.iter().filter_map(|v| Some((v.key.clone(), v.bounds?))).collect();
        self.extent = extent(&drawn);
        write(vertex_marks, &drawn.vertices, edge_marks, &drawn.wired.parts, &mut self.tables);
        drawn
    }

    /// Draws again what an edit reaches: the rows `touched` sized and placed again, the groups around
    /// them, and the wires meeting them or near what they moved.
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
        // The boxes the edit moved, added, or took away among the blocks wires route around.
        let mut moved = Vec::new();
        for (&v, &was) in touched.iter().zip(&before) {
            let vertex = &drawn.vertices[v];
            if !vertex.group && vertex.bounds != was {
                moved.extend(was.into_iter().chain(vertex.bounds));
            }
        }
        // Groups stand around their members again; a group that moved is touched too.
        if touched.iter().any(|&v| drawn.vertices[v].group || drawn.vertices[v].parent.is_some()) {
            let groups: Vec<(usize, Option<Rect>)> =
                drawn.vertices.iter().enumerate().filter(|(_, v)| v.group).map(|(g, v)| (g, v.bounds)).collect();
            stand_groups(&mut drawn.vertices, &self.places, &header, padding);
            touched.extend(groups.into_iter().filter(|&(g, was)| drawn.vertices[g].bounds != was).map(|(g, _)| g));
            touched.sort_unstable();
            touched.dedup();
        }
        self.place(&drawn.vertices, vertex_marks, edge_marks, &header, padding, input, jobs);
        let written =
            self.wire(&mut drawn, marks, &wires::Change { moved: &moved, touched: Some(&touched) }, input, jobs);
        for &v in &touched {
            let vertex = &drawn.vertices[v];
            match vertex.bounds {
                Some(b) => self.boxes.insert(vertex.key.clone(), b),
                None => self.boxes.remove(&vertex.key),
            };
        }
        self.extent = extent(&drawn);
        if !write_rows(marks, &drawn, &touched, &written, &mut self.tables) {
            write(vertex_marks, &drawn.vertices, edge_marks, &drawn.wired.parts, &mut self.tables);
        }
        drawn
    }

    /// Stands vertex `v`, not a group, where its data or a layout places it. A row that lost its
    /// position keeps standing where it stood.
    fn stand(&mut self, v: &mut Vertex) {
        if v.pin.is_none()
            && !self.places.contains_key(&v.key)
            && let Some(b) = self.boxes.get(&v.key)
        {
            self.places.insert(v.key.clone(), [b[0].midpoint(b[2]), b[1].midpoint(b[3])]);
        }
        v.bounds = v.pin.or_else(|| self.places.get(&v.key).copied()).map(|center| around(center, v.half));
    }

    /// Works out the wires `change` reaches; the edge rows worked out, by edge mark.
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
            let (shape, group) = (shape_of(vm.mark), vm.mark.contains.is_some());
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
                });
            }
        }
        vertices
    }

    /// Half the width and height of `vm`'s row `row`, units: its size, its radius, or with neither a
    /// box fitting its label and ports. A group's is what it takes holding nothing: its title.
    fn half(&mut self, vm: &VertexMark<'_>, rows: &Rows<'_>, row: usize, input: &Input<'_>) -> [f64; 2] {
        let theme = &input.scene.theme;
        let radius = f64::from(theme.vertex.radius);
        let group = vm.mark.contains.is_some();
        if !group {
            if let Some([w, h]) = &vm.mark.size {
                let half = |size: &crate::Size| rows.number(&size.expr, row).map_or(radius, |v| v.max(0.0) / 2.0);
                return [half(w), half(h)];
            }
            if let Some(r) = &vm.mark.radius {
                let r = rows.number(&r.expr, row).map_or(radius, |v| v.max(0.0));
                return [r, r];
            }
        }
        let text = self.label(vm.mark, rows, row, input);
        if group {
            let padding = f64::from(theme.diagram.group_padding);
            let title = text.map_or(0.0, |([w, _], _)| w);
            return [title / 2.0 + padding, header(vm.mark, theme) / 2.0 + padding];
        }
        let ports = &vm.mark.ports;
        // A row with neither a label nor ports is a dot.
        if text.is_none() && ports.is_empty() {
            return [radius, radius];
        }
        let size = text.map_or(f64::from(theme.text.size), |(_, size)| size);
        let [w, h] = text.map_or([0.0; 2], |(box_, _)| box_);
        // A round or pointed outline holds its text's box inside it.
        let fit = match shape_of(vm.mark) {
            Shape::Ellipse => std::f64::consts::SQRT_2,
            Shape::Diamond => 2.0,
            Shape::Rectangle | Shape::Rounded => 1.0,
        };
        let (mut width, mut height) = if text.is_some() {
            ((w + 1.6 * size) * fit, (h + 1.2 * size) * fit)
        } else {
            (2.0 * radius, 2.0 * radius)
        };
        // Room for its ports: a pitch apiece along each side, and their labels across from each other.
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
        // A port named on the top or the bottom takes a line of its own between its side and the
        // label, and as much on the other side, so the label stays in the middle; and its share of
        // the side holds its name.
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

    /// The width and height of row `row`'s label in units, and its size; `None` without one.
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

    /// The width and height `run` takes, base pixels: as its host measures it, once, or an estimate
    /// without one.
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
                return [run.text.chars().count() as f64 * 0.6 * base, 1.25 * base];
            }
        };
        if self.measured.len() >= MEASURED {
            self.measured.clear();
        }
        let size = size.map(f64::from);
        self.measured.insert(run, size);
        size
    }

    /// Asks the scene's layout, once none is under way, to place every row without a place: blocks,
    /// and groups holding nothing; while arranging, every row without a position. The rest hold;
    /// groups lay out around their members.
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
            // Nothing to lay out: the arranging is done as asked.
            if std::mem::take(&mut self.arranging) {
                self.arranged = Some(Vec::new());
            }
            return;
        }
        // Layouts lay out with y up: a group's header is its top.
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

/// What the sheet reads, stamped: the scene, whether a host measures text, answers landed, the
/// generation of places, whether rows are being dragged, and what the marks' structure reads.
fn stamp(input: &Input<'_>, landed: u64, generation: u64) -> u64 {
    let mut hasher = FxHasher::default();
    (input.scene_version, input.host.is_some(), landed, generation, input.dragging).hash(&mut hasher);
    input.structure(&mut hasher);
    hasher.finish().max(1)
}

/// The diagram's vertex marks and edge marks.
type Marks<'a> = (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>);

/// What the structure of the marks reads now.
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

/// The vertex rows written since `drawn`, by vertex, in order: `None` unless the same tables hold the
/// same rows and nothing changed but values rows are sized and placed by, each by its own row's.
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

/// The band across the top of each vertex mark's groups, and the padding around their members.
fn framing(vertex_marks: &[VertexMark<'_>], theme: &Theme) -> (Vec<f64>, f64) {
    (vertex_marks.iter().map(|vm| header(vm.mark, theme)).collect(), f64::from(theme.diagram.group_padding))
}

/// The box holding every placed vertex and every wire.
fn extent(drawn: &Drawn) -> Option<Rect> {
    let points = drawn.wired.parts.iter().flatten().flatten().flatten().map(|&[x, y]| [x, y, x, y]);
    drawn.vertices.iter().filter_map(|v| v.bounds).chain(points).reduce(union)
}

/// The outline a vertex mark's markers draw: groups and blocks are boxes, the rest their shape.
fn shape_of(mark: &Vertices) -> Shape {
    if mark.contains.is_some() {
        return Shape::Rectangle;
    }
    match &mark.marker {
        Marker::Shape(shape) | Marker::Gauge { shape, .. } => *shape,
        Marker::Pie { .. } => Shape::Ellipse,
        Marker::Block { .. } | Marker::Icon { .. } | Marker::Wgsl { .. } => Shape::Rectangle,
    }
}

/// The band across the top of a group mark's containers its titles sit in, units; none for other
/// marks, or without titles.
fn header(mark: &Vertices, theme: &Theme) -> f64 {
    match (&mark.contains, &mark.style.label) {
        (Some(_), Some(label)) => f64::from(label.size.unwrap_or(theme.text.size) * HEADER_BAND),
        _ => 0.0,
    }
}

/// Names each row's group: the rows of the table a group mark contains, through the reference
/// naming the group; then how many groups hold each row, cycles cut where a walk up closes; then
/// how many rows each group holds.
fn hold(vertex_marks: &[VertexMark<'_>], vertices: &mut [Vertex]) {
    for vm in vertex_marks {
        let Some((table, reference)) = &vm.mark.contains else { continue };
        let Some(m) = drawing(vertex_marks, vm.data.name(), table) else { continue };
        let members = &vertex_marks[m];
        let Some(Field::Reference(r)) = members.table.field_named(reference) else { continue };
        if r.to != *vm.table.name() {
            continue;
        }
        for row in 0..members.table.len() {
            let Some(group_row) = r.target(row) else { continue };
            let (member, group) = (members.first + row, vm.first + group_row as usize);
            if member != group {
                vertices[member].parent = Some(group);
            }
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

/// Stands every group around its members, innermost first: their bounds grown by `padding`, with
/// its header across the top. A group holding nothing placed stands at its own place.
fn stand_groups(vertices: &mut [Vertex], places: &FxHashMap<Row, [f64; 2]>, header: &[f64], padding: f64) {
    let mut order: Vec<usize> = (0..vertices.len()).filter(|&v| vertices[v].group).collect();
    crate::order::by_key(&mut order, |&v| !u64::from(vertices[v].depth));
    let mut held: Vec<Option<[f64; 4]>> = vec![None; vertices.len()];
    for v in vertices.iter().filter(|v| !v.group) {
        if let (Some(p), Some(b)) = (v.parent, v.bounds) {
            held[p] = Some(held[p].map_or(b, |h| union(h, b)));
        }
    }
    for g in order {
        let top = header[vertices[g].mark];
        let own = if let Some(b) = held[g] {
            Some([b[0] - padding, b[1] - padding - top, b[2] + padding, b[3] + padding])
        } else {
            let center = vertices[g].pin.or_else(|| places.get(&vertices[g].key).copied());
            center.map(|c| around(c, vertices[g].half))
        };
        vertices[g].bounds = own;
        if let (Some(p), Some(b)) = (vertices[g].parent, own) {
            held[p] = Some(held[p].map_or(b, |h| union(h, b)));
        }
    }
}

/// A derived table to write: its dataset and table, the table it stands beside, and its fields.
type Writing<'a> = ((Name, Name), &'a Table, Vec<(&'static str, Values)>);

/// A derived field of a vertex table, and its value for a vertex.
type VertexField = (&'static str, fn(&Vertex) -> Option<f64>);

/// A vertex table's derived fields, each a vertex's: its center and half sizes, then how many groups
/// hold it, which only groups gaining or losing members change.
const VERTEX_FIELDS: [VertexField; 5] = [
    ("x", |v| v.center().map(|c| c[0])),
    ("y", |v| v.center().map(|c| c[1])),
    ("half_x", |v| v.bounds.map(|b| (b[2] - b[0]) / 2.0)),
    ("half_y", |v| v.bounds.map(|b| (b[3] - b[1]) / 2.0)),
    ("depth", |v| Some(f64::from(v.depth))),
];

/// Writes each drawn table's derived table, dropping those of tables no longer drawn: a vertex
/// table's centers, half sizes, and depths; an edge table's paths. A field equal to the one before
/// keeps its column, so nothing uploads again.
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
        let fields = VERTEX_FIELDS
            .iter()
            .map(|&(name, value)| (name, Values::from(own.iter().map(value).collect::<Vec<_>>())))
            .collect();
        tables.push(((vm.data.name().clone(), vm.table.name().clone()), vm.table, fields));
    }
    for (em, paths) in edge_marks.iter().zip(paths) {
        let key = (em.data.name().clone(), em.table.name().clone());
        let field = ("route", Values::from(paths.clone()));
        match tables.iter_mut().find(|(k, ..)| *k == key) {
            Some((.., fields)) => fields.push(field),
            None => tables.push((key, em.table, vec![field])),
        }
    }
    derived.retain(|key, _| tables.iter().any(|(k, ..)| k == key));
    for (key, source, fields) in tables {
        let before = derived.get(&key);
        let fields: Vec<(Name, Field)> =
            fields.into_iter().map(|(name, values)| (name.into(), kept(name, &values, source, before))).collect();
        derived.insert(key, beside(source, fields));
    }
}

/// Writes what an edit reached over the derived tables, row by row: the center and half sizes of each
/// vertex row `touched` names, and the parts of each edge row `written` names, so only the pages they
/// fall on change. False where a derived table lacks a field to write over.
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
        // An edit leaves which groups hold each row, and so its depth.
        for &(name, value) in &VERTEX_FIELDS[..4] {
            let values =
                Values::from(rows.iter().map(|&row| value(&drawn.vertices[vm.first + row])).collect::<Vec<_>>());
            if !write_field(table, name, &rows, &values) {
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

/// Writes `values` over rows `rows` of field `name` of `table`, but where a row holds its value already,
/// so a page changes only when a value on it does; false where it holds no such column.
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
    use crate::{Diagram, Edges, Grid, Label, Port, Route, Scene};

    const BLOCKS: u64 = 24;

    /// Blocks with labels and ports, most in one of two groups, wired by orthogonal nets, straight
    /// edges with lanes between the same two blocks, and orthogonal edges with ends.
    fn diagram() -> (Scene, Data) {
        let scene = Scene::new(Diagram { grid: Grid::Off })
            .draw(Vertices::of("d", "G").contains("B", "group"))
            .draw(Edges::of("d", "N").route(Route::Orthogonal))
            .draw(Edges::of("d", "E").ends("from", "to"))
            .draw(Edges::of("d", "F").ends("from", "to").route(Route::Orthogonal))
            .draw(
                Vertices::of("d", "B")
                    .position("x", "y")
                    .label(Label::new("name"))
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
                .set(Table::new("G", vec![1_u64, 2]))
                .set(Table::new("N", (0..BLOCKS / 2).collect::<Vec<_>>()))
                .set(blocks)
                .set(pairs(vec![0, 0, 3, 7], vec![1, 1, 9, 15], "E"))
                .set(pairs(vec![4, 5, 11, 20], vec![10, 17, 12, 21], "F")),
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

    #[test]
    fn an_edit_derives_what_deriving_every_row_does() {
        let (scene, data) = diagram();
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
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
                // A row named twice in one edit takes the last value.
                let mut unique = rows.clone();
                unique.sort_unstable();
                unique.dedup();
                if unique.len() < rows.len() {
                    continue;
                }
                data.apply(edit).expect("valid edit");
            }
            let now = data.snapshot();
            let input = Input {
                scene: &scene,
                scene_version: 1,
                data: std::slice::from_ref(&now),
                host: None,
                dragging: true,
                paged: None,
            };
            if let Some(drawn) = &edits.drawn {
                redrawn += usize::from(edited(drawn, &input, &marks(&input).0).is_some());
            }
            whole.drawn = None;
            for sheet in [&mut edits, &mut whole] {
                sheet
                    .update(&input, &mut Jobs::new(None, Waker::noop(), &counters, &errors, crate::derive::FRAME_WORK));
            }
            if let Some(difference) = differ(&edits.tables, &whole.tables) {
                panic!("step {step}: {difference}");
            }
            assert_eq!(edits.extent, whole.extent, "step {step}");
        }
        assert!(redrawn > 30, "edits derived only what they reached: {redrawn} of 60");
    }
}
