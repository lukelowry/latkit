//! Stars of nets, outside diagrams.
//!
//! Each row of an edge mark with `joins` is a net joining the vertex rows whose reference field
//! names it. The net draws as a star: a segment from the members' centroid to each member, at the
//! places their vertex mark gives them. Stars are a `route` path field beside the net table, which
//! the mark draws like any geometry. They are recomputed only when the data, the scene, or the
//! layout's places change.

use super::graph::{VertexMark, marks, position};
use super::{Input, Tables, beside, kept};
use crate::data::{Field, Name, UNWIRED, Values};
use crate::expr::cpu::Rows;
use crate::{Mark, Space};

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
        if matches!(input.scene.space, Space::Diagram(_)) || !joining {
            let had = !self.tables.is_empty();
            self.clear();
            return had;
        }
        let field = |t: &crate::Table, name: &str| t.field_named(name).map(Field::version);
        let placed: Vec<_> = places.iter().map(|(key, t)| (key, field(t, "x"), field(t, "y"))).collect();
        let mut hasher = rustc_hash::FxHasher::default();
        std::hash::Hash::hash(&(input.scene_version, placed), &mut hasher);
        input.structure(&mut hasher);
        let stamp = std::hash::Hasher::finish(&hasher).max(1);
        if stamp == self.stamp {
            return false;
        }
        self.stamp = stamp;
        let (vertex_marks, _) = marks(input);
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
            let route = kept("route", &Values::from(stars), nets, before);
            tables.insert(key, beside(nets, [(Name::from("route"), route)]));
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

/// A net's star: a path from the centroid of `members` to each member; empty for fewer than two.
fn star(members: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    if members.len() < 2 {
        return Vec::new();
    }
    let n = members.len() as f64;
    let middle = [members.iter().map(|p| p[0]).sum::<f64>() / n, members.iter().map(|p| p[1]).sum::<f64>() / n];
    members.iter().map(|&p| vec![middle, p]).collect()
}
