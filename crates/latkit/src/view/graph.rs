//! The graph a view's data holds: the rows joined to a row across edges and nets, the row a reference
//! names, and which vertex mark an end attaches to.

use rustc_hash::FxHashSet;

use super::View;
use super::marks::Shown;
use crate::data::{Field, Reference, Table};
use crate::scene::mark::MarkKind;
use crate::{Name, Route, Row, Rows, Space};

/// The reference field `name` of `table`.
fn reference<'t>(table: &'t Table, name: &str) -> Option<&'t Reference> {
    match table.field_named(name)? {
        Field::Reference(reference) => Some(reference),
        _ => None,
    }
}

impl View {
    /// The rows joined to `row`: a vertex's neighbors across edges and nets, or an edge's or a net's
    /// vertices, a set per table. It reads the references' inverses, so it costs what the row's degree
    /// does.
    pub fn neighbors(&self, row: &Row) -> Vec<Rows> {
        let mut found: Vec<Row> = Vec::new();
        let Some(data) = self.data(&row.data) else { return Vec::new() };
        let Some(index) = data.table(&row.table).and_then(|t| t.row(row.id.as_ref())) else { return Vec::new() };
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
        Rows::group(found)
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
