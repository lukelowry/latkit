//! The graph: what the view derives from its data's topology for marks to draw, as words beside
//! each mark's program, like its ends. An edge mark gets each row's lane among edges joining the same
//! two vertices, and the points it bends through; a net mark gets each net's terminals at the ports
//! of the vertices naming it; a vertex mark with ports gets where each port sits; a group mark gets
//! the members naming each of its rows. Terminals and members are both entries naming a row: a
//! vertex, as its end table and row, and for a terminal its port's code. Words are rebuilt only when
//! the topology they read changes.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use rustc_hash::FxHasher;

use super::View;
use super::marks::{Compiled, Shown};
use crate::data::{Field, Table};
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Data, Name, Route, Row, Space, Value};

/// Graph words of one mark.
#[derive(Clone, Default, PartialEq, Debug)]
pub(crate) struct Graph {
    /// Each row's lane, as `f32` bits; empty when no two edges join the same vertices.
    pub(crate) lanes: Vec<u32>,
    /// Row starts (rows + 1), then points as `f32` x and y bits.
    pub(crate) paths: Vec<u32>,
    /// Row starts (rows + 1), then terminals of `TERMINAL_WORDS` each.
    pub(crate) terminals: Vec<u32>,
    /// Each port's words.
    pub(crate) ports: Vec<u32>,
    /// Row starts (rows + 1), then members of `TERMINAL_WORDS` each.
    pub(crate) members: Vec<u32>,
    /// Levels of groups a group mark's rows hold, itself included; 0 for marks that hold none.
    pub(crate) depth: u32,
    /// Tables the terminals' or members' vertices are in, after the program's own ends.
    pub(crate) end_tables: Vec<Name>,
    /// What the words were built from.
    pub(crate) stamp: u64,
}

impl Graph {
    /// Ports each row has.
    pub(crate) fn port_count(&self) -> u32 {
        (self.ports.len() / wgsl::PORT_WORDS as usize) as u32
    }

    /// Words the graph adds to the mark's program region.
    pub(crate) fn len(&self) -> usize {
        self.lanes.len() + self.paths.len() + self.terminals.len() + self.ports.len() + self.members.len()
    }
}

/// The version of every column the topology of `table`'s reference field `name` reads.
fn hash_reference(table: &Table, name: &str, hasher: &mut FxHasher) {
    if let Some(Field::Reference(reference)) = table.field_named(name) {
        reference.version.hash(hasher);
    }
}

impl View {
    /// Rebuilds the graph words of every mark whose topology changed.
    pub(super) fn derive_graph(&mut self) {
        for i in 0..self.marks.len() {
            let stamp = self.graph_stamp(i);
            if stamp == self.marks[i].graph.stamp {
                continue;
            }
            let mut graph = self.build_graph(i);
            graph.stamp = stamp;
            let shown = &mut self.marks[i];
            if graph != shown.graph {
                shown.graph = graph;
                shown.packed = false;
                shown.segments_due = true;
            }
        }
    }

    /// What mark `i`'s graph words read: its table's rows, its ends and bends, and for a net the
    /// port references naming it.
    fn graph_stamp(&self, i: usize) -> u64 {
        let shown = &self.marks[i];
        let mut hasher = FxHasher::default();
        let Some(compiled) = &shown.compiled else { return 0 };
        let style = shown.mark.style();
        let Some(table) = self.data(&style.data).and_then(|d| d.table(&style.table)) else { return 0 };
        (table.structure, table.order).hash(&mut hasher);
        compiled.drawing.ports.len().hash(&mut hasher);
        if let Some((members, reference)) = &compiled.drawing.members
            && let Some(m) = end_mark(&self.marks, &style.data, members)
        {
            let s = self.marks[m].mark.style();
            if let Some(t) = self.data(&s.data).and_then(|d| d.table(&s.table)) {
                (t.structure, m).hash(&mut hasher);
                hash_reference(t, reference, &mut hasher);
            }
            self.marks[m].graph.depth.hash(&mut hasher);
        }
        if let crate::Mark::Edges(edges) = &shown.mark {
            if let Some((from, to)) = &edges.ends {
                hash_reference(table, from, &mut hasher);
                hash_reference(table, to, &mut hasher);
            }
            if let Some(bends) = &edges.bends {
                table.field_named(bends).map(Field::version).hash(&mut hasher);
            }
            self.routing.paths.get(&i).map(Vec::len).hash(&mut hasher);
            self.routing.version.hash(&mut hasher);
            if compiled.drawing.source == wgsl::PATH_NET {
                for (m, reference) in self.ports_naming(i) {
                    let s = self.marks[m].mark.style();
                    if let Some(t) = self.data(&s.data).and_then(|d| d.table(&s.table)) {
                        (t.structure, m).hash(&mut hasher);
                        hash_reference(t, &reference, &mut hasher);
                    }
                    self.marks[m].compiled.as_ref().map(|c| (c.program.units, c.drawing.flags)).hash(&mut hasher);
                }
            }
        }
        hasher.finish().max(1)
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
            for (reference, _) in &compiled.drawing.ports {
                if let Some(Field::Reference(r)) = table.field_named(reference)
                    && r.to == style.table
                {
                    found.push((m, reference.clone()));
                }
            }
        }
        found
    }

    fn build_graph(&self, i: usize) -> Graph {
        let shown = &self.marks[i];
        let mut graph = Graph::default();
        let Some(compiled) = &shown.compiled else { return graph };
        let style = shown.mark.style();
        let Some(data) = self.data(&style.data) else { return graph };
        let Some(table) = data.table(&style.table) else { return graph };
        graph.ports = port_words(compiled);
        if compiled.drawing.members.is_some() {
            let (members, tables, depth) = self.members(i, data, table);
            graph.members = members;
            graph.end_tables = tables;
            graph.depth = depth;
        }
        if let crate::Mark::Edges(edges) = &shown.mark {
            if let Some((from, to)) = &edges.ends {
                graph.lanes = lanes(table, from, to);
            }
            if let Some(bends) = &edges.bends {
                graph.paths = bend_words(table, bends);
            }
            if edges.route == Some(Route::Orthogonal)
                && let Some(paths) = self.routing.paths.get(&i)
            {
                graph.paths.clone_from(paths);
            }
            if compiled.drawing.source == wgsl::PATH_NET {
                let (terminals, tables) = self.terminals(i, data, table);
                graph.terminals = terminals;
                graph.end_tables = tables;
            }
        }
        graph
    }

    /// Each group row's members: every row of the table it contains whose reference field names it;
    /// and the levels of groups its rows hold.
    fn members(&self, i: usize, data: &Data, table: &Table) -> (Vec<u32>, Vec<Name>, u32) {
        let none = (Vec::new(), Vec::new(), 0);
        let Some(compiled) = &self.marks[i].compiled else { return none };
        let Some((members, reference)) = &compiled.drawing.members else { return none };
        let style = self.marks[i].mark.style();
        let Some(m) = end_mark(&self.marks, &style.data, members) else { return none };
        let Some(vertices) = data.table(members) else { return none };
        let Some(Field::Reference(r)) =
            vertices.field_named(reference).filter(|f| matches!(f, Field::Reference(r) if r.to == style.table))
        else {
            return none;
        };
        let rows = table.len();
        let end = compiled.program.ends.len() as u32;
        let group = |v: usize| match r.rows.get(v) {
            Some(Value::Number(n)) if (n as usize) < rows && !(m == i && n as usize == v) => Some(n as usize),
            _ => None,
        };
        let items: Vec<(u32, [u32; 3])> =
            (0..vertices.len()).filter_map(|v| group(v).map(|n| (n as u32, [end, v as u32, 0]))).collect();
        let depth = if m == i {
            // Groups of this mark's own rows: as many levels as the longest chain of them.
            let mut deepest = 1;
            for v in 0..vertices.len() {
                let (mut at, mut levels) = (v, 1);
                while let Some(up) = group(at).filter(|_| levels < wgsl::GROUP_DEPTH) {
                    at = up;
                    levels += 1;
                }
                deepest = deepest.max(levels);
            }
            deepest
        } else {
            1 + self.marks[m].graph.depth
        };
        (naming(rows, items), vec![members.clone()], depth.min(wgsl::GROUP_DEPTH))
    }

    /// Each net row's terminals: every vertex row whose port reference field names it.
    fn terminals(&self, i: usize, data: &Data, table: &Table) -> (Vec<u32>, Vec<Name>) {
        let rows = table.len();
        let ends = self.marks[i].compiled.as_ref().map_or(0, |c| c.program.ends.len());
        let mut tables: Vec<Name> = Vec::new();
        let mut items: Vec<(u32, [u32; 3])> = Vec::new();
        for (m, reference) in self.ports_naming(i) {
            let shown = &self.marks[m];
            let Some(compiled) = &shown.compiled else { continue };
            let vertex_table = &shown.mark.style().table;
            let Some(vertices) = data.table(vertex_table) else { continue };
            let Some(Field::Reference(r)) = vertices.field_named(&reference) else { continue };
            let end = (ends
                + tables.iter().position(|t| t == vertex_table).unwrap_or_else(|| {
                    tables.push(vertex_table.clone());
                    tables.len() - 1
                })) as u32;
            let index = compiled.drawing.ports.iter().position(|(name, _)| *name == reference).unwrap_or(0);
            let code = port_code(&compiled.drawing.ports, index);
            for v in 0..vertices.len() {
                if let Some(Value::Number(n)) = r.rows.get(v) {
                    let n = n as u32;
                    if (n as usize) < rows {
                        items.push((n, [end, v as u32, code]));
                    }
                }
            }
        }
        (naming(rows, items), tables)
    }

    /// The rows joined to `row`: a vertex's neighbors across edges and nets, or an edge's or a net's
    /// vertices.
    pub fn neighbors(&self, row: &Row) -> Vec<Row> {
        let mut found: Vec<Row> = Vec::new();
        let Some(data) = self.data(&row.data) else { return found };
        for shown in &self.marks {
            let style = shown.mark.style();
            let Some(table) = data.table(&style.table).filter(|_| style.data == row.data) else { continue };
            let own = style.table == row.table;
            let index = if own { table.row(row.id.as_ref()) } else { None };
            if let crate::Mark::Edges(edges) = &shown.mark
                && let Some((from, to)) = &edges.ends
            {
                for r in 0..table.len() {
                    let at = |field: &str| referenced_row(&row.data, table, field, r, data);
                    let (a, b) = (at(from), at(to));
                    if own {
                        if index == Some(r) {
                            found.extend(a.into_iter().chain(b));
                        }
                    } else if a.as_ref() == Some(row) {
                        found.extend(b);
                    } else if b.as_ref() == Some(row) {
                        found.extend(a);
                    }
                }
            }
            let words = &shown.graph.terminals;
            let rows = table.len();
            if words.len() <= rows {
                continue;
            }
            let tables: Vec<&Name> =
                shown.compiled.iter().flat_map(|c| &c.program.ends).chain(&shown.graph.end_tables).collect();
            let terminal = |k: usize| {
                let at = rows + 1 + wgsl::TERMINAL_WORDS as usize * k;
                let name = tables.get(words[at] as usize)?;
                let id = data.table(name)?.ids.id(words[at + 1] as usize)?;
                Some(Row { data: row.data.clone(), table: (*name).clone(), id })
            };
            for net in 0..rows {
                let terminals: Vec<Row> = (words[net] as usize..words[net + 1] as usize).filter_map(terminal).collect();
                if own && index == Some(net) {
                    found.extend(terminals);
                } else if !own && terminals.contains(row) {
                    found.extend(terminals.into_iter().filter(|t| t != row));
                }
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
        referenced_row(&row.data, table, field, table.row(row.id.as_ref())?, data)
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

/// Row starts (rows + 1), then the entries naming each row, in order of the row they name.
fn naming(rows: usize, mut items: Vec<(u32, [u32; 3])>) -> Vec<u32> {
    items.sort_by_key(|&(n, item)| (n, item));
    let mut words = vec![0_u32; rows + 1];
    for &(n, _) in &items {
        words[n as usize + 1] += 1;
    }
    for r in 0..rows {
        words[r + 1] += words[r];
    }
    words.extend(items.iter().flat_map(|(_, item)| *item));
    words
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
    let rows_of = |name: &str| match table.field_named(name) {
        Some(Field::Reference(r)) => Some(&r.rows),
        _ => None,
    };
    let (Some(a), Some(b)) = (rows_of(from), rows_of(to)) else { return Vec::new() };
    let end = |column: &crate::data::Column, row: usize| match column.get(row) {
        Some(Value::Number(n)) => Some(n as u32),
        _ => None,
    };
    let mut pairs: HashMap<(u32, u32), Vec<usize>, rustc_hash::FxBuildHasher> = HashMap::default();
    for row in 0..table.len() {
        if let (Some(x), Some(y)) = (end(a, row), end(b, row)) {
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
            let reversed = end(a, row) > end(b, row);
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

/// The row of dataset `data` that `table`'s reference field `field` names at `row`.
fn referenced_row(data_name: &Name, table: &Table, field: &str, row: usize, data: &Data) -> Option<Row> {
    let Some(Field::Reference(r)) = table.field_named(field) else { return None };
    let Some(Value::Number(n)) = r.rows.get(row) else { return None };
    let id = data.table(&r.to)?.ids.id(n as usize)?;
    Some(Row { data: data_name.clone(), table: r.to.clone(), id })
}
