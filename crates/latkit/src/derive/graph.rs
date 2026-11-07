//! The graph the scene's marks draw: the vertex marks and the edge mark of each table, and how
//! edges meet vertices, either by two endpoint references or as nets whose members reference them.
//! Layouts and the stars of nets read it.
//!
//! A table's row is one vertex, however many marks draw it.

use crate::data::{Field, Name, Reference, Row, Snapshot, Table, Value};
use crate::expr::cpu::Rows;
use crate::host::Key;
use crate::scene::mark::Style;
use crate::{Edges, Mark, Vertices};

/// The vertex marks of a table: the one that places its rows, every one that draws them, and the
/// vertex index of the table's first row.
pub(crate) struct VertexMark<'a> {
    pub(crate) mark: &'a Vertices,
    /// Every vertex mark of the table, in scene order.
    pub(crate) marks: Vec<&'a Vertices>,
    pub(crate) data: &'a Snapshot,
    pub(crate) table: &'a Table,
    pub(crate) first: usize,
}

/// The edge mark that draws a table's rows as paths.
pub(crate) struct EdgeMark<'a> {
    pub(crate) mark: &'a Edges,
    pub(crate) data: &'a Snapshot,
    pub(crate) table: &'a Table,
}

/// The scene's vertex and edge marks, one of each kind per table: the table's unnamed mark of that
/// kind, else its first. Each vertex mark also lists every vertex mark of its table. Vertex indices
/// number the rows of every vertex mark in turn.
pub(crate) fn marks<'a>(input: &super::Input<'a>) -> (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>) {
    let (mut vertices, mut edges): (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>) = (Vec::new(), Vec::new());
    for mark in &input.scene.marks {
        let style = mark.style();
        let Some(data) = input.data.iter().find(|d| *d.name() == style.data) else { continue };
        let Some(table) = data.table(&style.table) else { continue };
        match mark {
            Mark::Vertices(v) => match taken(vertices.iter().map(|vm| &vm.mark.style), style) {
                None => vertices.push(VertexMark { mark: v, marks: vec![v], data, table, first: 0 }),
                Some(at) => {
                    vertices[at].marks.push(v);
                    if replaces(&vertices[at].mark.style, style) {
                        vertices[at].mark = v;
                    }
                }
            },
            Mark::Edges(e) => {
                let shown = EdgeMark { mark: e, data, table };
                match taken(edges.iter().map(|em| &em.mark.style), style) {
                    None => edges.push(shown),
                    Some(at) if replaces(&edges[at].mark.style, style) => edges[at] = shown,
                    Some(_) => {}
                }
            }
            Mark::Lines(_) | Mark::Areas(_) => {}
        }
    }
    let mut first = 0;
    for vm in &mut vertices {
        vm.first = first;
        first += vm.table.len();
    }
    (vertices, edges)
}

/// The index of the mark among `styles` that already draws `style`'s table.
fn taken<'s>(mut styles: impl Iterator<Item = &'s Style>, style: &Style) -> Option<usize> {
    styles.position(|s| s.data == style.data && s.table == style.table)
}

/// Whether the mark of `style` replaces the mark of `before` for their table: an unnamed mark
/// replaces a named one.
fn replaces(before: &Style, style: &Style) -> bool {
    before.name.is_some() && style.name.is_none()
}

/// The index of the vertex mark drawing `table` of dataset `data`, which edge endpoints and net
/// members attach to.
pub(crate) fn drawing(vertex_marks: &[VertexMark<'_>], data: &Name, table: &Name) -> Option<usize> {
    vertex_marks.iter().position(|vm| vm.data.name() == data && vm.table.name() == table)
}

/// Row `row`'s position from its data: the mark's position fields, else its point geometry (finite
/// points only). `None` where the data gives none.
pub(crate) fn position(mark: &Vertices, rows: &Rows<'_>, row: usize) -> Option<[f64; 2]> {
    match &mark.position {
        Some([x, y]) => Some([rows.number(x, row)?, rows.number(y, row)?]),
        None => match rows.table.value(row, mark.point_field(), f64::INFINITY)? {
            Value::Point(p) if p.iter().all(|v| v.is_finite()) => Some(p),
            _ => None,
        },
    }
}

/// A row's key in a job: its table and id.
pub(crate) fn key_of(row: &Row) -> Key {
    (row.table.clone(), row.id.clone())
}

/// The links a layout reads, by vertex index: each edge's two endpoints (self-loops dropped), and
/// each net's first member linked to every other member.
pub(crate) fn links(marks: &[VertexMark<'_>], edge_marks: &[EdgeMark<'_>]) -> Vec<[u32; 2]> {
    let mut links = Vec::new();
    for em in edge_marks {
        if let Some((from, to)) = &em.mark.ends {
            let (Some((a, first_a)), Some((b, first_b))) = (end(marks, em, from), end(marks, em, to)) else { continue };
            for row in 0..em.table.len() {
                if let (Some(x), Some(y)) = (a.target(row), b.target(row)) {
                    let (x, y) = (first_a + x as usize, first_b + y as usize);
                    if x != y {
                        links.push([x as u32, y as u32]);
                    }
                }
            }
        } else if let Some((members, reference)) = &em.mark.joins {
            links.extend(net_links(marks, em, members, reference));
        }
    }
    links
}

/// The reference field `field` of `em`'s table, with the vertex index of the first row of the
/// table it references. `None` unless it is a reference field to a drawn vertex table.
fn end<'a>(marks: &[VertexMark<'_>], em: &EdgeMark<'a>, field: &str) -> Option<(&'a Reference, usize)> {
    let Some(Field::Reference(r)) = em.table.field_named(field) else { return None };
    let m = drawing(marks, em.data.name(), &r.to)?;
    Some((r, marks[m].first))
}

/// The links of `em`'s nets, whose members are the rows of vertex table `members` that
/// `reference` names a net in: each net's first member to every other member.
fn net_links(marks: &[VertexMark<'_>], em: &EdgeMark<'_>, members: &Name, reference: &str) -> Vec<[u32; 2]> {
    let Some(m) = drawing(marks, em.data.name(), members) else { return Vec::new() };
    let vm = &marks[m];
    let Some(Field::Reference(named)) = vm.table.field_named(reference) else { return Vec::new() };
    if named.to != *em.table.name() {
        return Vec::new();
    }
    let inverse = named.inverse();
    let mut links = Vec::new();
    for net in 0..em.table.len() {
        if let Some((&first, rest)) = inverse.of(net).split_first() {
            let first = (vm.first + first as usize) as u32;
            links.extend(rest.iter().map(|&member| [first, (vm.first + member as usize) as u32]));
        }
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Data, Ids, Patch, Scene};

    #[test]
    fn nets_link_their_first_member_to_the_others() {
        let data = Data::new("g");
        let members = Table::new("V", Ids::count(4)).reference("net", "N", vec![Some(0_u64), Some(0), None, Some(0)]);
        data.apply(Patch::new().set(Table::new("N", vec![0_u64])).set(members)).expect("valid");
        let data = data.snapshot();
        let scene = Scene::new(crate::Plane::default())
            .draw(crate::Edges::of("g", "N").joins("V", "net"))
            .draw(crate::Vertices::of("g", "V"));
        let input =
            super::super::Input { scene: &scene, scene_version: 1, data: std::slice::from_ref(&data), paged: None };
        let (vertex_marks, edge_marks) = marks(&input);
        assert_eq!(links(&vertex_marks, &edge_marks), vec![[0, 1], [0, 3]]);
    }
}
