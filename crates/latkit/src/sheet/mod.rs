//! A diagram's sheet: where every vertex row stands and how large it is, the boxes groups draw
//! around their members, and the paths wires run along, in units with y down. It is made from the
//! data and the scene alone, never from what was drawn, so the camera, hover, and motion never
//! change it. Places persist by row, so adding a row moves nothing else, and a row that loses its
//! position stays where it stood; layouts place only rows without one, until arranging lays every
//! row out again, and a wire routes again only when its terminals move or a box near it changes.
//! Superlinear work too large for the frame (layouts, many routes) is a host job answering with a
//! patch. The sheet is a derivation: it writes a table beside each table it draws, row for row,
//! which marks read like data.

mod wires;

pub(crate) use wires::links;

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHasher};

use crate::data::{Data, Field, Name, Row, Table, Value, Values};
use crate::derive::{Derive, Input, Jobs, Tables, answers, beside, kept};
use crate::expr::cpu::Rows;
use crate::gpu::atlas;
use crate::gpu::shaders::{HEADER_BAND, PORT_SIZE, TEXT_BASE};
use crate::host::{Job, Key, Placement, TextRun};
use crate::scene::mark::Style;
use crate::{Edges, Layout, Mark, Marker, Pending, Shape, Side, Theme, Vertices};

/// Texts measured past which the sheet forgets them all.
const MEASURED: usize = 1 << 16;

/// The sheet of a diagram's view.
#[derive(Default)]
pub(crate) struct Sheet {
    pub(crate) errors: Vec<crate::Error>,
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
}

/// A layout under way: the generation of places it was asked in, and the row each key it answers
/// for names.
struct Placing {
    pending: Pending<Vec<u8>>,
    generation: u64,
    rows: FxHashMap<Key, Row>,
}

/// The vertex mark a table's rows take their places from, and the vertex index of its first row.
pub(crate) struct VertexMark<'a> {
    pub(crate) mark: &'a Vertices,
    pub(crate) data: &'a Data,
    pub(crate) table: &'a Table,
    pub(crate) first: usize,
}

/// The edge mark a table's rows take their paths from.
pub(crate) struct EdgeMark<'a> {
    pub(crate) mark: &'a Edges,
    pub(crate) data: &'a Data,
    pub(crate) table: &'a Table,
}

/// A vertex row of the diagram.
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
        self.stamp = 0;
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

    /// Makes the derived tables again: sizes, places, group boxes, then wires.
    fn build(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) {
        let (vertex_marks, edge_marks) = marks(input);
        let mut vertices = self.vertices(&vertex_marks, input);
        hold(&vertex_marks, &mut vertices);
        let theme = &input.scene.theme;
        let padding = f64::from(theme.group_padding);
        let header: Vec<f64> = vertex_marks.iter().map(|vm| header(vm.mark, theme)).collect();
        for v in vertices.iter_mut().filter(|v| !v.group) {
            // A row that lost its position keeps standing where it stood.
            if v.pin.is_none()
                && !self.places.contains_key(&v.key)
                && let Some(b) = self.boxes.get(&v.key)
            {
                self.places.insert(v.key.clone(), [b[0].midpoint(b[2]), b[1].midpoint(b[3])]);
            }
            if let Some(center) = v.pin.or_else(|| self.places.get(&v.key).copied()) {
                v.bounds = Some(around(center, v.half));
            }
        }
        stand_groups(&mut vertices, &self.places, &header, padding);
        self.place(&vertices, &vertex_marks, &edge_marks, &header, padding, input, jobs);
        let spacing = f64::from(theme.edge_spacing);
        let context = wires::Context { vertices: &vertices, marks: &vertex_marks, spacing, radius: spacing };
        let moved = wires::moved(&self.boxes, &vertices);
        let routes = (&mut self.routes, &mut self.routing);
        let paths = wires::paths(&context, &edge_marks, input, jobs, &moved, routes);
        self.boxes = vertices.iter().filter_map(|v| Some((v.key.clone(), v.bounds?))).collect();
        write(&vertex_marks, &vertices, &edge_marks, paths, &mut self.tables);
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
        let radius = f64::from(theme.vertex_radius);
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
            let padding = f64::from(theme.group_padding);
            let title = text.map_or(0.0, |([w, _], _)| w);
            return [title / 2.0 + padding, header(vm.mark, theme) / 2.0 + padding];
        }
        let Some(([w, h], size)) = text else { return [radius, radius] };
        // A round or pointed outline holds its text's box inside it.
        let fit = match shape_of(vm.mark) {
            Shape::Ellipse => std::f64::consts::SQRT_2,
            Shape::Diamond => 2.0,
            Shape::Rectangle | Shape::Rounded => 1.0,
        };
        let (mut width, mut height) = ((w + 1.6 * size) * fit, (h + 1.2 * size) * fit);
        // Room for its ports: a pitch apiece along each side, and their labels across from each other.
        let ports = &vm.mark.ports;
        let pitch = (2.0 * f64::from(PORT_SIZE)).max(1.4 * size);
        let count = |side: Side| ports.iter().filter(|(_, p)| p.side == side).count() as f64;
        height = height.max((count(Side::Left).max(count(Side::Right)) + 1.0) * pitch);
        width = width.max((count(Side::Top).max(count(Side::Bottom)) + 1.0) * pitch);
        let port_size = 0.8 * theme.font_size;
        let mut widest = |side: Side| {
            let mut widest: f64 = 0.0;
            for label in ports.iter().filter(|(_, p)| p.side == side).filter_map(|(_, p)| p.label.as_deref()) {
                let run = atlas::run(label.into(), theme.font.clone(), port_size, None);
                widest = widest.max(self.measure(run, input)[0] * f64::from(port_size) / f64::from(TEXT_BASE));
            }
            widest
        };
        let labels = widest(Side::Left) + widest(Side::Right);
        if labels > 0.0 {
            width = width.max(w + labels + 3.0 * f64::from(PORT_SIZE) + 1.6 * size);
        }
        [width / 2.0, height / 2.0]
    }

    /// The width and height of row `row`'s label in units, and its size; `None` without one.
    fn label(&mut self, mark: &Vertices, rows: &Rows<'_>, row: usize, input: &Input<'_>) -> Option<([f64; 2], f64)> {
        let label = mark.style.label.as_ref()?;
        let text = rows.text(&label.text, row)?;
        let theme = &input.scene.theme;
        let size = label.size.unwrap_or(theme.font_size);
        let font = label.font.clone().unwrap_or_else(|| theme.font.clone());
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
        let links = wires::links(vertex_marks, edge_marks);
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

/// The vertex marks and edge marks of the diagram, one per table: its unnamed mark of the kind, else
/// its first; each vertex mark with the vertex index of its first row.
pub(crate) fn marks<'a>(input: &Input<'a>) -> (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>) {
    let (mut vertices, mut edges): (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>) = (Vec::new(), Vec::new());
    for mark in &input.scene.marks {
        let style = mark.style();
        let Some(data) = input.data.iter().find(|d| *d.name() == style.data) else { continue };
        let Some(table) = data.table(&style.table) else { continue };
        match mark {
            Mark::Vertices(v) => {
                let shown = VertexMark { mark: v, data, table, first: 0 };
                match taken(vertices.iter().map(|vm| &vm.mark.style), style) {
                    None => vertices.push(shown),
                    Some(at) if replaces(&vertices[at].mark.style, style) => vertices[at] = shown,
                    Some(_) => {}
                }
            }
            Mark::Edges(e) => {
                let shown = EdgeMark { mark: e, data, table };
                match taken(edges.iter().map(|em| &em.mark.style), style) {
                    None => edges.push(shown),
                    Some(at) if replaces(&edges[at].mark.style, style) => edges[at] = shown,
                    Some(_) => {}
                }
            }
            Mark::Faces(_) | Mark::Lines(_) | Mark::Areas(_) => {}
        }
    }
    let mut first = 0;
    for vm in &mut vertices {
        vm.first = first;
        first += vm.table.len();
    }
    (vertices, edges)
}

/// Which of the marks taken, by their styles, draws `style`'s table already.
fn taken<'s>(mut styles: impl Iterator<Item = &'s Style>, style: &Style) -> Option<usize> {
    styles.position(|s| s.data == style.data && s.table == style.table)
}

/// Whether the mark of `style` takes its table from the one of `before`: an unnamed mark from a
/// named one.
fn replaces(before: &Style, style: &Style) -> bool {
    before.name.is_some() && style.name.is_none()
}

/// The vertex mark drawing `table` of dataset `data`, which ends and members attach to.
fn drawing(vertex_marks: &[VertexMark<'_>], data: &Name, table: &Name) -> Option<usize> {
    vertex_marks.iter().position(|vm| vm.data.name() == data && vm.table.name() == table)
}

/// The position row `row`'s data gives it, if any: its position, else its point geometry.
pub(crate) fn position(mark: &Vertices, rows: &Rows<'_>, row: usize) -> Option<[f64; 2]> {
    match &mark.position {
        Some([x, y]) => Some([rows.number(x, row)?, rows.number(y, row)?]),
        None => match rows.table.value(row, mark.point_field(), f64::INFINITY)? {
            Value::Point(p) if p.iter().all(|v| v.is_finite()) => Some(p),
            _ => None,
        },
    }
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
        (Some(_), Some(label)) => f64::from(label.size.unwrap_or(theme.font_size) * HEADER_BAND),
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
    order.sort_by_key(|&v| std::cmp::Reverse(vertices[v].depth));
    let mut held: Vec<Option<[f64; 4]>> = vec![None; vertices.len()];
    for v in vertices.iter().filter(|v| !v.group) {
        if let (Some(p), Some(b)) = (v.parent, v.bounds) {
            held[p] = Some(union(held[p], b));
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
            held[p] = Some(union(held[p], b));
        }
    }
}

/// The box of half size `half` around `center`.
fn around(center: [f64; 2], half: [f64; 2]) -> [f64; 4] {
    [center[0] - half[0], center[1] - half[1], center[0] + half[0], center[1] + half[1]]
}

/// The box holding `a` and `b`.
fn union(a: Option<[f64; 4]>, b: [f64; 4]) -> [f64; 4] {
    a.map_or(b, |a| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])])
}

/// A derived table to write: its dataset and table, the table it stands beside, and its fields.
type Writing<'a> = ((Name, Name), &'a Table, Vec<(&'static str, Values)>);

/// Writes each drawn table's derived table, dropping those of tables no longer drawn: a vertex
/// table's centers, half sizes, and depths; an edge table's paths. A field equal to the one before
/// keeps its column, so nothing uploads again.
fn write(
    vertex_marks: &[VertexMark<'_>],
    vertices: &[Vertex],
    edge_marks: &[EdgeMark<'_>],
    paths: Vec<Vec<wires::Parts>>,
    derived: &mut Tables,
) {
    let mut tables: Vec<Writing<'_>> = Vec::new();
    for vm in vertex_marks {
        let own = &vertices[vm.first..vm.first + vm.table.len()];
        let number = |f: fn(&Vertex) -> Option<f64>| Values::from(own.iter().map(f).collect::<Vec<_>>());
        let fields = vec![
            ("x", number(|v| v.center().map(|c| c[0]))),
            ("y", number(|v| v.center().map(|c| c[1]))),
            ("half_x", number(|v| v.bounds.map(|b| (b[2] - b[0]) / 2.0))),
            ("half_y", number(|v| v.bounds.map(|b| (b[3] - b[1]) / 2.0))),
            ("depth", number(|v| Some(f64::from(v.depth)))),
        ];
        tables.push(((vm.data.name().clone(), vm.table.name().clone()), vm.table, fields));
    }
    for (em, paths) in edge_marks.iter().zip(paths) {
        let key = (em.data.name().clone(), em.table.name().clone());
        let field = ("route", Values::from(paths));
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

/// A row's key in a job: its table and id.
pub(crate) fn key_of(row: &Row) -> Key {
    (row.table.clone(), row.id.clone())
}
