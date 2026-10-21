//! The graph the marks draw: one vertex mark and one edge mark per table, and where edges meet
//! vertices, by their two ends or by the ports naming a net. Layouts link vertices by it, a diagram's
//! wires run along it, and nets' stars join it.

use crate::data::{Data, Field, Inverse, Name, Reference, Row, Table, Value};
use crate::expr::cpu::Rows;
use crate::host::Key;
use crate::scene::mark::Style;
use crate::{Edges, Mark, Port, Vertices};

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

/// The vertex marks and edge marks of the scene, one per table: its unnamed mark of the kind, else
/// its first; each vertex mark with the vertex index of its first row.
pub(crate) fn marks<'a>(input: &super::Input<'a>) -> (Vec<VertexMark<'a>>, Vec<EdgeMark<'a>>) {
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
pub(crate) fn drawing(vertex_marks: &[VertexMark<'_>], data: &Name, table: &Name) -> Option<usize> {
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

/// A row's key in a job: its table and id.
pub(crate) fn key_of(row: &Row) -> Key {
    (row.table.clone(), row.id.clone())
}

/// What a layout links: each edge's two ends, and each net from its outputs to its inputs, by vertex.
pub(crate) fn links(marks: &[VertexMark<'_>], edge_marks: &[EdgeMark<'_>]) -> Vec<[u32; 2]> {
    let codes: Vec<Vec<u32>> = marks.iter().map(|vm| port_codes(vm.mark)).collect();
    let mut links = Vec::new();
    for em in edge_marks {
        let joins = Joins::new(marks, &codes, em);
        for row in 0..em.table.len() {
            if let Some([a, b]) = joins.ends(row) {
                if a != b {
                    links.push([a as u32, b as u32]);
                }
                continue;
            }
            let terminals: Vec<(u32, bool)> =
                joins.terminals(marks, row).into_iter().map(|(v, _, output)| (v as u32, output)).collect();
            links.extend(net_links(&terminals));
        }
    }
    links
}

/// Where an edge mark's rows meet vertices: the references naming each row's two ends, with the
/// first vertex of the table each names; or, for nets, every port reference naming its rows.
pub(crate) struct Joins<'a> {
    ends: Option<[(&'a Reference, usize); 2]>,
    ports: Vec<Naming<'a>>,
}

/// A port reference naming a net table's rows: the vertex mark, the port's code and whether it is an
/// output, and the rows naming each net.
struct Naming<'a> {
    mark: usize,
    code: u32,
    output: bool,
    inverse: &'a Inverse,
}

impl<'a> Joins<'a> {
    pub(crate) fn new(marks: &[VertexMark<'a>], codes: &[Vec<u32>], em: &EdgeMark<'a>) -> Joins<'a> {
        let table: &'a Table = em.table;
        let end = |field: &str| {
            let Some(Field::Reference(r)) = table.field_named(field) else { return None };
            let m = drawing(marks, em.data.name(), &r.to)?;
            Some((r, marks[m].first))
        };
        if let Some((from, to)) = &em.mark.ends {
            return Joins { ends: end(from).zip(end(to)).map(|(a, b)| [a, b]), ports: Vec::new() };
        }
        let mut ports = Vec::new();
        for (m, vm) in marks.iter().enumerate().filter(|(_, vm)| vm.data.name() == em.data.name()) {
            let vertices: &'a Table = vm.table;
            for (k, (name, port)) in vm.mark.ports.iter().enumerate() {
                if let Some(Field::Reference(r)) = vertices.field_named(name)
                    && r.to == *table.name()
                {
                    ports.push(Naming { mark: m, code: codes[m][k], output: port.output, inverse: r.inverse() });
                }
            }
        }
        Joins { ends: None, ports }
    }

    /// Row `row`'s two ends, by vertex.
    pub(crate) fn ends(&self, row: usize) -> Option<[usize; 2]> {
        let [(a, first_a), (b, first_b)] = self.ends?;
        Some([first_a + a.target(row)? as usize, first_b + b.target(row)? as usize])
    }

    /// Net row `row`'s terminals: each vertex naming it at a port, the port's code, and whether it is
    /// an output.
    pub(crate) fn terminals(&self, marks: &[VertexMark<'_>], row: usize) -> Vec<(usize, u32, bool)> {
        let mut terminals = Vec::new();
        for naming in &self.ports {
            let first = marks[naming.mark].first;
            terminals.extend(naming.inverse.of(row).iter().map(|&v| (first + v as usize, naming.code, naming.output)));
        }
        terminals
    }
}

/// Each port's code on a vertex mark's rows.
pub(crate) fn port_codes(mark: &Vertices) -> Vec<u32> {
    Port::codes(&mark.ports.iter().map(|(_, port)| port).collect::<Vec<_>>())
}

/// The links of a net whose terminals are `ends`, each a vertex and whether it drives the net: every
/// driver to its first reader, and its first driver to every reader, so a wide net adds as many links
/// as it has terminals. A net without both drivers and readers runs from its first terminal.
fn net_links(ends: &[(u32, bool)]) -> Vec<[u32; 2]> {
    let (mut drivers, mut readers): (Vec<u32>, Vec<u32>) = (Vec::new(), Vec::new());
    for &(vertex, drives) in ends {
        if drives { drivers.push(vertex) } else { readers.push(vertex) }
    }
    if drivers.is_empty() || readers.is_empty() {
        drivers = ends.iter().take(1).map(|e| e.0).collect();
        readers = ends.iter().skip(1).map(|e| e.0).collect();
    }
    let (Some(&driver), Some(&reader)) = (drivers.first(), readers.first()) else { return Vec::new() };
    let links = drivers.iter().map(|&d| [d, reader]).chain(readers.iter().skip(1).map(|&r| [driver, r]));
    links.filter(|[a, b]| a != b).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nets_link_their_drivers_to_their_readers() {
        assert_eq!(net_links(&[(0, false), (1, true), (2, false)]), vec![[1, 0], [1, 2]]);
        assert_eq!(net_links(&[(4, false), (5, false)]), vec![[4, 5]], "without a driver, the first drives");
    }
}
