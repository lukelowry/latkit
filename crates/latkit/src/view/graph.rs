//! The graph a view's data holds: the rows joined to a row across edges and nets, the row a reference
//! names, which vertex mark an end attaches to, and outside a diagram each edge row's lane among the
//! edges joining the same two vertices, derived beside its table.

use rustc_hash::{FxHashMap, FxHashSet};

use super::View;
use super::marks::Shown;
use crate::data::{Column, Field, Reference, Table, Values, Version};
use crate::scene::mark::MarkKind;
use crate::{Name, Route, Row, Space};

/// What each derived lane table was made from, by its dataset and table.
#[derive(Default)]
pub(crate) struct Lanes {
    stamps: FxHashMap<(Name, Name), u64>,
}

/// The reference field `name` of `table`.
fn reference<'t>(table: &'t Table, name: &str) -> Option<&'t Reference> {
    match table.field_named(name)? {
        Field::Reference(reference) => Some(reference),
        _ => None,
    }
}

impl View {
    /// Derives each edge mark's lanes beside its table, again only when its rows or ends changed;
    /// a table whose edges share no ends derives nothing.
    pub(super) fn derive_lanes(&mut self) {
        let mut kept: FxHashSet<(Name, Name)> = FxHashSet::default();
        for shown in &self.marks {
            let crate::Mark::Edges(edges) = &shown.mark else { continue };
            let (Some((from, to)), Some(_)) = (&edges.ends, &shown.compiled) else { continue };
            let style = &edges.style;
            let Some(table) = self.data.iter().find(|d| *d.name() == style.data).and_then(|d| d.table(&style.table))
            else {
                continue;
            };
            let key = (style.data.clone(), style.table.clone());
            let version = |name: &str| reference(table, name).map(|r| r.version);
            let stamp = super::derived::stamp_of((table.structure, table.order, version(from), version(to)));
            kept.insert(key.clone());
            if self.lanes.stamps.get(&key) == Some(&stamp) {
                continue;
            }
            self.lanes.stamps.insert(key.clone(), stamp);
            match lanes(table, from, to) {
                Some(lanes) => {
                    let lane = Field::Values(Column::new(&Values::from(lanes)), Version::next());
                    let derived = Table {
                        name: table.name.clone(),
                        ids: table.ids.clone(),
                        index: table.index.clone(),
                        fields: vec![("lane".into(), lane)],
                        structure: table.structure,
                        order: table.order,
                    };
                    self.derived.insert(key, derived);
                }
                None => {
                    self.derived.remove(&key);
                }
            }
        }
        self.derived.retain(|key, _| kept.contains(key));
        self.lanes.stamps.retain(|key, _| kept.contains(key));
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
        let mut seen = FxHashSet::default();
        found.retain(|r| seen.insert(r.clone()));
        found
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
            for (name, ..) in &compiled.drawing.ports {
                if reference(table, name).is_some_and(|r| r.to == style.table) {
                    found.push((m, name.clone()));
                }
            }
        }
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

/// The vertex mark drawing `table` that ends attach to: the unnamed one, else the first.
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

/// Each edge row's lane among edges joining the same two vertices: offsets from the middle, signed so
/// edges joining them either way spread apart. `None` when no two share their ends.
fn lanes(table: &Table, from: &str, to: &str) -> Option<Vec<f64>> {
    let (a, b) = (reference(table, from)?, reference(table, to)?);
    let mut pairs: FxHashMap<(u32, u32), Vec<usize>> = FxHashMap::default();
    for row in 0..table.len() {
        if let (Some(x), Some(y)) = (a.target(row), b.target(row)) {
            pairs.entry((x.min(y), x.max(y))).or_default().push(row);
        }
    }
    if pairs.values().all(|rows| rows.len() < 2) {
        return None;
    }
    let mut lanes = vec![0.0; table.len()];
    for rows in pairs.values().filter(|rows| rows.len() > 1) {
        let middle = (rows.len() - 1) as f64 / 2.0;
        for (k, &row) in rows.iter().enumerate() {
            let reversed = a.target(row) > b.target(row);
            let lane = k as f64 - middle;
            lanes[row] = if reversed { -lane } else { lane };
        }
    }
    Some(lanes)
}
