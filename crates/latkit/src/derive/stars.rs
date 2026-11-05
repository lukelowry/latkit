//! Stars of nets.
//!
//! Each row of an edge mark with `joins` is a net. Its members are the vertex rows whose reference
//! field names it. The net draws as a star: a segment from the members' centroid to each member, at
//! the places their vertex mark gives them. Stars are a `star` path field beside the net table,
//! and the mark draws them like any geometry. They are recomputed only when what they read
//! changes: the nets and their members, the members' positions, and the layout's places.

use std::hash::Hash;

use super::graph::{VertexMark, marks, position};
use super::{Input, Tables, beside, kept, stamp_with};
use crate::Mark;
use crate::data::{Field, Name, UNWIRED, Values};
use crate::expr::cpu::Rows;

#[derive(Default)]
pub(crate) struct Stars {
    tables: Tables,
    stamp: u64,
}

impl Stars {
    /// Updates the stars to `input`. A member is at its data's position, else at its place in the
    /// layout's `places` beside its table. Returns whether a table changed.
    pub(crate) fn update(&mut self, input: &Input<'_>, places: &Tables) -> bool {
        let joining = input.scene.marks.iter().any(|m| matches!(m, Mark::Edges(e) if e.joins.is_some()));
        if !joining {
            let had = !self.tables.is_empty();
            self.clear();
            return had;
        }
        let (vertex_marks, _) = marks(input);
        let stamp = stamp_with(|hasher| {
            input.scene_version.hash(hasher);
            for mark in &input.scene.marks {
                let Mark::Edges(edges) = mark else { continue };
                let Some((members, _)) = &edges.joins else { continue };
                let data = &edges.style.data;
                for table in [&edges.style.table, members] {
                    let rows = input.data(data).and_then(|d| d.table(table));
                    (table, rows.map(|t| (t.structure, t.order))).hash(hasher);
                }
                input.links(edges, &mut |read| read.stamp(hasher));
                if let Some(vm) = vertex_marks.iter().find(|vm| vm.data.name() == data && vm.table.name() == members) {
                    input.positions(vm.mark, &mut |read| read.stamp(hasher));
                }
                let placed = places.get(&(data.clone(), members.clone()));
                ["x", "y"].map(|name| placed.and_then(|t| t.field_named(name)).map(Field::version)).hash(hasher);
            }
        });
        if stamp == self.stamp {
            return false;
        }
        self.stamp = stamp;
        let mut tables = Tables::default();
        for mark in &input.scene.marks {
            let Mark::Edges(edges) = mark else { continue };
            let Some((members, reference)) = &edges.joins else { continue };
            let style = &edges.style;
            let Some(data) = input.data(&style.data) else { continue };
            let Some(nets) = data.table(&style.table) else { continue };
            let Some(vm) = vertex_marks.iter().find(|vm| vm.data.name() == data.name() && vm.table.name() == members)
            else {
                continue;
            };
            let Some(Field::Reference(named)) = vm.table.field_named(reference) else { continue };
            if named.to != *nets.name() {
                continue;
            }
            let placed = places.get(&(data.name().clone(), members.clone()));
            let mut points: Vec<Vec<[f64; 2]>> = vec![Vec::new(); nets.len()];
            let rows = Rows::new(vm.table, input.data);
            for (row, net) in named.targets().into_iter().enumerate() {
                if net == UNWIRED {
                    continue;
                }
                if let (Some(point), Some(members)) = (place(vm, &rows, row, placed), points.get_mut(net as usize)) {
                    members.push(point);
                }
            }
            let stars: Vec<Vec<Vec<[f64; 2]>>> = points.iter().map(|members| star(members)).collect();
            let key = (data.name().clone(), nets.name().clone());
            let before = self.tables.get(&key);
            let star = kept("star", &Values::from(stars), nets, before);
            tables.insert(key, beside(nets, [(Name::from("star"), star)]));
        }
        self.tables = tables;
        true
    }

    pub(crate) fn tables(&self) -> &Tables {
        &self.tables
    }

    pub(crate) fn clear(&mut self) {
        self.tables.clear();
        self.stamp = 0;
    }
}

/// The position of member row `row`: its data's position, else the layout's place for it.
fn place(vm: &VertexMark<'_>, rows: &Rows<'_>, row: usize, placed: Option<&crate::Table>) -> Option<[f64; 2]> {
    position(vm.mark, rows, row).or_else(|| {
        let table = placed?;
        match (table.value(row, "x", f64::INFINITY)?, table.value(row, "y", f64::INFINITY)?) {
            (crate::Value::Number(x), crate::Value::Number(y)) => Some([x, y]),
            _ => None,
        }
    })
}

/// A net's star: a path from the centroid of `members` to each member. Empty for fewer than two
/// members.
fn star(members: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    if members.len() < 2 {
        return Vec::new();
    }
    let n = members.len() as f64;
    let middle = [members.iter().map(|p| p[0]).sum::<f64>() / n, members.iter().map(|p| p[1]).sum::<f64>() / n];
    members.iter().map(|&p| vec![middle, p]).collect()
}
