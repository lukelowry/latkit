//! The graph: what the view derives from its data's topology for marks to draw, as words beside
//! each mark's program, like its ends. An edge mark gets each row's lane among edges joining the same
//! two vertices, and the points it bends through or its route; a net mark gets each net's terminals
//! at the ports of the vertices naming it; a vertex mark with ports gets where each port sits; a group
//! mark gets the members naming each of its rows. Terminals and members are both entries naming a
//! vertex row, as its end table and row, and for a terminal its port's code; both come from the
//! inverses of the references that name the net or the group. Each kind of word is made again only
//! when the topology it reads changes.

use std::collections::HashMap;

use super::View;
use super::derived::{Derived, stamp_of};
use super::marks::{Compiled, Shown};
use crate::data::{Field, Inverse, Reference, Table};
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Data, Name, Route, Row, Space, Value};

/// Graph words of one mark, each made from what it reads.
#[derive(Default)]
pub(crate) struct Graph {
    /// Each row's lane, as `f32` bits; empty when no two edges join the same vertices.
    lanes: Derived<Vec<u32>>,
    /// Row starts (rows + 1), then points as `f32` x and y bits: bends, or a route.
    paths: Derived<Vec<u32>>,
    /// A net mark's terminals.
    terminals: Derived<Naming>,
    /// A group mark's members.
    members: Derived<Naming>,
    /// Each port's words.
    ports: Derived<Vec<u32>>,
    /// Bumps whenever any word changes.
    pub(crate) version: u64,
}

/// Entries naming vertex rows, by the row they belong to: row starts (rows + 1), then entries of
/// `TERMINAL_WORDS` each; the tables their vertices are in, after the program's own ends; and for a
/// group mark the levels of groups its rows hold, itself included.
#[derive(Default)]
pub(crate) struct Naming {
    words: Vec<u32>,
    tables: Vec<Name>,
    depth: u32,
}

impl Graph {
    pub(crate) fn lanes(&self) -> &[u32] {
        &self.lanes.value
    }

    pub(crate) fn paths(&self) -> &[u32] {
        &self.paths.value
    }

    pub(crate) fn terminals(&self) -> &[u32] {
        &self.terminals.value.words
    }

    pub(crate) fn members(&self) -> &[u32] {
        &self.members.value.words
    }

    pub(crate) fn ports(&self) -> &[u32] {
        &self.ports.value
    }

    /// Levels of groups a group mark's rows hold, itself included; 0 for marks that hold none.
    pub(crate) fn depth(&self) -> u32 {
        self.members.value.depth
    }

    /// Tables the terminals' or members' vertices are in, after the program's own ends.
    pub(crate) fn end_tables(&self) -> impl Iterator<Item = &Name> {
        self.terminals.value.tables.iter().chain(&self.members.value.tables)
    }

    /// What the words joining vertices were made from: lanes (an edge mark's ends), terminals, and
    /// members. Layouts and routes read these, not the paths routes write.
    pub(crate) fn topology(&self) -> u64 {
        stamp_of((self.lanes.stamp(), self.terminals.stamp(), self.members.stamp()))
    }

    /// Ports each row has.
    pub(crate) fn port_count(&self) -> u32 {
        (self.ports().len() / wgsl::PORT_WORDS as usize) as u32
    }

    /// Words the graph adds to the mark's program region.
    pub(crate) fn len(&self) -> usize {
        self.lanes().len() + self.paths().len() + self.terminals().len() + self.ports().len() + self.members().len()
    }
}

/// The reference field `name` of `table`.
fn reference<'t>(table: &'t Table, name: &str) -> Option<&'t Reference> {
    match table.field_named(name)? {
        Field::Reference(reference) => Some(reference),
        _ => None,
    }
}

impl View {
    /// Makes every mark's graph words again where the topology they read changed.
    pub(super) fn derive_graph(&mut self) {
        for i in 0..self.marks.len() {
            let changed = self.remake(i, |g| &mut g.lanes, self.lanes_stamp(i), |v| v.build_lanes(i))
                | self.remake(i, |g| &mut g.paths, self.paths_stamp(i), |v| v.build_paths(i))
                | self.remake(i, |g| &mut g.terminals, self.terminals_stamp(i), |v| v.build_terminals(i))
                | self.remake(i, |g| &mut g.members, self.members_stamp(i), |v| v.build_members(i))
                | self.remake_ports(i);
            if changed {
                let shown = &mut self.marks[i];
                shown.graph.version += 1;
                shown.packed = false;
            }
        }
    }

    /// Makes mark `i`'s `word` again with `build` when `stamp` is due; a stamp of 0 empties it.
    fn remake<T: Default>(
        &mut self,
        i: usize,
        word: fn(&mut Graph) -> &mut Derived<T>,
        stamp: u64,
        build: impl FnOnce(&View) -> T,
    ) -> bool {
        if !word(&mut self.marks[i].graph).due(stamp) {
            return false;
        }
        let value = if stamp == 0 { T::default() } else { build(self) };
        word(&mut self.marks[i].graph).make(stamp, value);
        true
    }

    /// Makes mark `i`'s port words again when its ports changed.
    fn remake_ports(&mut self, i: usize) -> bool {
        let words = self.marks[i].compiled.as_ref().map(port_words).unwrap_or_default();
        let stamp = if words.is_empty() { 0 } else { stamp_of(&words) };
        self.remake(i, |g| &mut g.ports, stamp, |_| words)
    }

    /// Mark `i`'s data, table, and compiled program, when it has all three.
    fn source(&self, i: usize) -> Option<(&Data, &Table, &Compiled)> {
        let shown = &self.marks[i];
        let compiled = shown.compiled.as_ref()?;
        let style = shown.mark.style();
        let data = self.data(&style.data)?;
        Some((data, data.table(&style.table)?, compiled))
    }

    /// What an edge mark's lanes read: its rows and the references naming their ends.
    fn lanes_stamp(&self, i: usize) -> u64 {
        let (Some((_, table, _)), crate::Mark::Edges(edges)) = (self.source(i), &self.marks[i].mark) else { return 0 };
        let Some((from, to)) = &edges.ends else { return 0 };
        let version = |name: &str| reference(table, name).map(|r| r.version);
        stamp_of((table.structure, table.order, version(from), version(to)))
    }

    fn build_lanes(&self, i: usize) -> Vec<u32> {
        let (Some((_, table, _)), crate::Mark::Edges(edges)) = (self.source(i), &self.marks[i].mark) else {
            return Vec::new();
        };
        let Some((from, to)) = &edges.ends else { return Vec::new() };
        lanes(table, from, to)
    }

    /// What an edge mark's paths read: its bends field, or its routes.
    fn paths_stamp(&self, i: usize) -> u64 {
        let (Some((_, table, _)), crate::Mark::Edges(edges)) = (self.source(i), &self.marks[i].mark) else { return 0 };
        let bends = edges.bends.as_ref().and_then(|b| table.field_named(b)).map(Field::version);
        let routes = &self.routing.routes.value;
        let routed =
            (edges.route == Some(Route::Orthogonal)).then(|| (routes.version, routes.of(i, table.structure).is_some()));
        if bends.is_none() && routed.is_none() { 0 } else { stamp_of((table.structure, bends, routed)) }
    }

    fn build_paths(&self, i: usize) -> Vec<u32> {
        let (Some((_, table, _)), crate::Mark::Edges(edges)) = (self.source(i), &self.marks[i].mark) else {
            return Vec::new();
        };
        if edges.route == Some(Route::Orthogonal)
            && let Some(words) = self.routing.routes.value.of(i, table.structure)
        {
            return words.clone();
        }
        edges.bends.as_ref().map(|bends| bend_words(table, bends)).unwrap_or_default()
    }

    /// What a net mark's terminals read: its rows, and every port reference naming them, with the
    /// ports of the vertex marks they belong to.
    fn terminals_stamp(&self, i: usize) -> u64 {
        let Some((data, table, compiled)) = self.source(i) else { return 0 };
        if compiled.drawing.source != wgsl::PATH_NET {
            return 0;
        }
        let naming: Vec<_> = self
            .ports_naming(i)
            .into_iter()
            .filter_map(|(m, name)| {
                let vertices = data.table(&self.marks[m].mark.style().table)?;
                let compiled = self.marks[m].compiled.as_ref()?;
                let version = reference(vertices, &name)?.version;
                let ports = port_words(compiled);
                Some((m, vertices.structure, version, ports, compiled.program.units, compiled.drawing.flags))
            })
            .collect();
        stamp_of((table.structure, compiled.program.ends.len(), naming))
    }

    /// Each net row's terminals: every vertex row whose port reference names it, through the
    /// references' inverses.
    fn build_terminals(&self, i: usize) -> Naming {
        let Some((data, table, compiled)) = self.source(i) else { return Naming::default() };
        let ends = compiled.program.ends.len() as u32;
        let mut tables: Vec<Name> = Vec::new();
        let mut sources: Vec<(u32, u32, &Inverse)> = Vec::new();
        for (m, name) in self.ports_naming(i) {
            let shown = &self.marks[m];
            let Some(vertex_compiled) = &shown.compiled else { continue };
            let vertex_table = &shown.mark.style().table;
            let Some(r) = data.table(vertex_table).and_then(|t| reference(t, &name)) else { continue };
            let end = ends
                + tables.iter().position(|t| t == vertex_table).unwrap_or_else(|| {
                    tables.push(vertex_table.clone());
                    tables.len() - 1
                }) as u32;
            let ports = &vertex_compiled.drawing.ports;
            let index = ports.iter().position(|(n, _)| *n == name).unwrap_or(0);
            sources.push((end, port_code(ports, index), r.inverse()));
        }
        let words = naming(table.len(), |net, items| {
            for &(end, code, inverse) in &sources {
                items.extend(inverse.of(net).iter().map(|&v| [end, v, code]));
            }
            items.sort_unstable();
        });
        Naming { words, tables, depth: 0 }
    }

    /// What a group mark's members read: its rows, the table its members are in and the reference
    /// naming their group, and how many levels of groups the members hold.
    fn members_stamp(&self, i: usize) -> u64 {
        let Some((data, table, compiled)) = self.source(i) else { return 0 };
        let Some((members, name)) = &compiled.drawing.members else { return 0 };
        let style = self.marks[i].mark.style();
        let Some(m) = end_mark(&self.marks, &style.data, members) else { return 0 };
        let held = data.table(members).map(|t| (t.structure, reference(t, name).map(|r| r.version)));
        let depth = if m == i { 0 } else { self.marks[m].graph.depth() };
        stamp_of((table.structure, compiled.program.ends.len(), m, held, depth))
    }

    /// Each group row's members, every row of the table it contains whose reference names it, through
    /// the reference's inverse; and the levels of groups its rows hold.
    fn build_members(&self, i: usize) -> Naming {
        let Some((data, table, compiled)) = self.source(i) else { return Naming::default() };
        let Some((members, name)) = &compiled.drawing.members else { return Naming::default() };
        let style = self.marks[i].mark.style();
        let Some(m) = end_mark(&self.marks, &style.data, members) else { return Naming::default() };
        let Some(r) = data.table(members).and_then(|t| reference(t, name)).filter(|r| r.to == style.table) else {
            return Naming::default();
        };
        let rows = table.len();
        let end = compiled.program.ends.len() as u32;
        let inverse = r.inverse();
        // A row of a mark holding its own table's rows is not its own member. Each entry's last word
        // is the group it belongs to, so a thread per member finds its group.
        let words = naming(rows, |group, items| {
            let held = inverse.of(group).iter().filter(|&&v| m != i || v as usize != group);
            items.extend(held.map(|&v| [end, v, group as u32]));
        });
        let depth = if m == i {
            // Groups of this mark's own rows: as many levels as the longest chain of them.
            let up = |v: usize| r.target(v).map(|g| g as usize).filter(|&g| g < rows && g != v);
            let mut deepest = 1;
            for v in 0..data.table(members).map_or(0, Table::len) {
                let (mut at, mut levels) = (v, 1);
                while let Some(group) = up(at).filter(|_| levels < wgsl::GROUP_DEPTH) {
                    at = group;
                    levels += 1;
                }
                deepest = deepest.max(levels);
            }
            deepest
        } else {
            1 + self.marks[m].graph.depth()
        };
        Naming { words, tables: vec![members.clone()], depth: depth.min(wgsl::GROUP_DEPTH) }
    }

    /// Every vertex mark's port reference field that names rows of net mark `i`'s table.
    fn ports_naming(&self, i: usize) -> Vec<(usize, Name)> {
        let style = self.marks[i].mark.style();
        let Some(data) = self.data(&style.data) else { return Vec::new() };
        let mut found = Vec::new();
        for (m, shown) in self.marks.iter().enumerate() {
            let s = shown.mark.style();
            let Some(compiled) = &shown.compiled else { continue };
            if shown.kind() != MarkKind::Vertices || s.data != style.data {
                continue;
            }
            let Some(table) = data.table(&s.table) else { continue };
            for (name, _) in &compiled.drawing.ports {
                if reference(table, name).is_some_and(|r| r.to == style.table) {
                    found.push((m, name.clone()));
                }
            }
        }
        found
    }

    /// The rows joined to `row`: a vertex's neighbors across edges and nets, or an edge's or a net's
    /// vertices. It reads the references' inverses, so it costs what the row's degree does.
    pub fn neighbors(&self, row: &Row) -> Vec<Row> {
        let mut found: Vec<Row> = Vec::new();
        let Some(data) = self.data(&row.data) else { return found };
        let Some(index) = data.table(&row.table).and_then(|t| t.row(row.id.as_ref())) else { return found };
        let at = |table: &Name, r: u32| {
            let id = data.table(table)?.ids.id(r as usize)?;
            Some(Row { data: row.data.clone(), table: table.clone(), id })
        };
        for (i, shown) in self.marks.iter().enumerate() {
            let style = shown.mark.style();
            let crate::Mark::Edges(edges) = &shown.mark else { continue };
            let Some(table) = data.table(&style.table).filter(|_| style.data == row.data) else { continue };
            if let Some((from, to)) = &edges.ends {
                let (Some(a), Some(b)) = (reference(table, from), reference(table, to)) else { continue };
                if style.table == row.table {
                    found.extend([a, b].into_iter().filter_map(|r| at(&r.to, r.target(index)?)));
                    continue;
                }
                for (near, far) in [(a, b), (b, a)] {
                    if near.to == row.table {
                        let rows = near.inverse().of(index);
                        found.extend(rows.iter().filter_map(|&e| at(&far.to, far.target(e as usize)?)));
                    }
                }
                continue;
            }
            // A net: its terminals are the vertices whose port references name it.
            let ports = self.ports_naming(i);
            let net = if style.table == row.table {
                Some(index)
            } else {
                ports.iter().find_map(|(m, name)| {
                    let vertices = &self.marks[*m].mark.style().table;
                    if *vertices != row.table {
                        return None;
                    }
                    reference(data.table(vertices)?, name)?.target(index).map(|n| n as usize)
                })
            };
            let Some(net) = net else { continue };
            for (m, name) in &ports {
                let vertices = &self.marks[*m].mark.style().table;
                let Some(r) = data.table(vertices).and_then(|t| reference(t, name)) else { continue };
                found.extend(r.inverse().of(net).iter().filter_map(|&v| at(vertices, v)).filter(|r| r != row));
            }
        }
        let mut seen = rustc_hash::FxHashSet::default();
        found.retain(|r| seen.insert(r.clone()));
        found
    }

    /// The row `row`'s reference field `field` names.
    pub(super) fn referenced(&self, row: &Row, field: &str) -> Option<Row> {
        let data = self.data(&row.data)?;
        let table = data.table(&row.table)?;
        let r = reference(table, field)?;
        let id = data.table(&r.to)?.ids.id(r.target(table.row(row.id.as_ref())?)? as usize)?;
        Some(Row { data: row.data.clone(), table: r.to.clone(), id })
    }

    /// Marks each edge mark on the earth whose route is not straight as following great circles.
    pub(super) fn geodesic(&self, shown: &Shown) -> bool {
        let Space::Earth(_) = self.scene.space else { return false };
        match &shown.mark {
            crate::Mark::Edges(edges) => edges.ends.is_some() && matches!(edges.route, None | Some(Route::Geodesic)),
            _ => false,
        }
    }
}

/// The vertex mark drawing `table` that ends and members attach to: the unnamed one, else the first.
pub(super) fn end_mark(marks: &[Shown], data: &Name, table: &Name) -> Option<usize> {
    let drawing = |i: &usize| {
        let m = &marks[*i];
        m.kind() == MarkKind::Vertices
            && m.compiled.is_some()
            && m.mark.style().data == *data
            && m.mark.style().table == *table
    };
    let mut candidates = (0..marks.len()).filter(drawing);
    (0..marks.len()).filter(drawing).find(|&i| marks[i].mark.style().name.is_none()).or_else(|| candidates.next())
}

/// Row starts (rows + 1), then the entries `entries` gives each row, in row order.
fn naming(rows: usize, mut entries: impl FnMut(usize, &mut Vec<[u32; 3]>)) -> Vec<u32> {
    let mut starts = Vec::with_capacity(rows + 1);
    let mut items: Vec<[u32; 3]> = Vec::new();
    let mut row_items = Vec::new();
    for row in 0..rows {
        starts.push(items.len() as u32);
        row_items.clear();
        entries(row, &mut row_items);
        items.extend_from_slice(&row_items);
    }
    starts.push(items.len() as u32);
    starts.extend(items.iter().flatten());
    starts
}

/// Each port's words: its code and its shape.
fn port_words(compiled: &Compiled) -> Vec<u32> {
    let ports = &compiled.drawing.ports;
    (0..ports.len()).flat_map(|i| [port_code(ports, i), shape_code(ports[i].1.shape)]).collect()
}

fn shape_code(shape: crate::Shape) -> u32 {
    match shape {
        crate::Shape::Ellipse => wgsl::SHAPE_ELLIPSE,
        crate::Shape::Rectangle => wgsl::SHAPE_RECTANGLE,
        crate::Shape::Rounded => wgsl::SHAPE_ROUNDED,
        crate::Shape::Diamond => wgsl::SHAPE_DIAMOND,
    }
}

/// Port `index`'s side, place among the ports on its side (by their order, then declaration), and
/// how many share the side, packed: side in two bits, place and count in eight each.
fn port_code(ports: &[(Name, crate::Port)], index: usize) -> u32 {
    let port = &ports[index].1;
    let mut same: Vec<usize> = (0..ports.len()).filter(|&j| ports[j].1.side == port.side).collect();
    same.sort_by_key(|&j| (ports[j].1.order.unwrap_or(u32::MAX), j));
    let place = same.iter().position(|&j| j == index).unwrap_or(0) as u32;
    port.side.code() | (place.min(255) << 2) | ((same.len() as u32).min(255) << 10)
}

/// Each edge row's lane among edges joining the same two vertices, as `f32` bits: offsets from the
/// middle, signed so edges joining them either way spread apart. Empty when no two share their ends.
fn lanes(table: &Table, from: &str, to: &str) -> Vec<u32> {
    let (Some(a), Some(b)) = (reference(table, from), reference(table, to)) else { return Vec::new() };
    let mut pairs: HashMap<(u32, u32), Vec<usize>, rustc_hash::FxBuildHasher> = HashMap::default();
    for row in 0..table.len() {
        if let (Some(x), Some(y)) = (a.target(row), b.target(row)) {
            pairs.entry((x.min(y), x.max(y))).or_default().push(row);
        }
    }
    if pairs.values().all(|rows| rows.len() < 2) {
        return Vec::new();
    }
    let mut lanes = vec![0.0_f32.to_bits(); table.len()];
    for rows in pairs.values().filter(|rows| rows.len() > 1) {
        let middle = (rows.len() - 1) as f32 / 2.0;
        for (k, &row) in rows.iter().enumerate() {
            let reversed = a.target(row) > b.target(row);
            let lane = k as f32 - middle;
            lanes[row] = if reversed { -lane } else { lane }.to_bits();
        }
    }
    lanes
}

/// A path field's points per row as written words: row starts, then x and y; the parts of a row
/// are broken by a missing point.
pub(crate) fn bend_words(table: &Table, field: &str) -> Vec<u32> {
    let rows = table.len();
    let mut starts = Vec::with_capacity(rows + 1);
    let mut points: Vec<[f32; 2]> = Vec::new();
    for row in 0..rows {
        starts.push(points.len() as u32);
        match table.value(row, field, f64::INFINITY) {
            Some(Value::Path(path)) => points.extend(path.iter().map(|p| p.map(|v| v as f32))),
            Some(Value::Parts(parts)) => {
                for (k, part) in parts.iter().enumerate() {
                    if k > 0 {
                        points.push([f32::NAN; 2]);
                    }
                    points.extend(part.iter().map(|p| p.map(|v| v as f32)));
                }
            }
            _ => {}
        }
    }
    starts.push(points.len() as u32);
    starts.extend(points.iter().flat_map(|p| p.map(f32::to_bits)));
    starts
}
