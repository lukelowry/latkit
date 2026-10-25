//! Wires: the path each edge row of a diagram runs along, in units with y down. An edge with ends
//! runs between its two vertices; a net joins every port naming it, from its outputs. A straight wire
//! runs between outlines, set apart in lanes where edges join the same two vertices, or as a star
//! through a net's middle; bends run through the points of a path field; an orthogonal wire routes
//! around every block. A route holds until its terminals move or a box near it changes. Then it
//! routes again on the frame when few do or rows are being dragged, else in a host job, keeping its
//! old path while its terminals hold, or an elbow while they moved, until the job answers. After an
//! edit of a few vertices, only the wires meeting them, those leaving by a side it changed, and those
//! near what it moved are worked out: the sides, every route's box, and every wire's are kept as
//! edits change them, so neither finding those wires nor the box around them all walks every wire.

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHashSet, FxHasher};

use super::Vertex;
use crate::data::{Row, Table, Value};
use crate::derive::graph::{EdgeMark, Joins, VertexMark, key_of, port_codes};
use crate::derive::{Input, Jobs, answers, spread};
use crate::host::{Job, Key, Wiring};
use crate::layout::boxes::Boxes;
use crate::layout::rect::{EMPTY, Point, Rect, dot, grow, meets, union};
use crate::layout::route::{Net, Terminal, finish, route, simplify};
use crate::{Pending, Route, Shape, Side};

/// Microseconds a wire takes to route, by estimate: what it spends of the frame's budget. A batch
/// that does not fit routes in a host job.
const ROUTE_COST: u64 = 160;
/// Wires routed on the frame at most while rows are dragged, whatever the budget; the rest route
/// once the drag ends.
const DRAGGED: usize = 256;
/// How far wires keep from blocks, in tracks: as far as routes keep.
const CLEARANCE: f64 = 2.0;

/// A wire's parts.
pub(crate) type Parts = Vec<Vec<Point>>;

/// A route: its polylines, y down, before bends round; a stamp of the terminals it joins; and the box
/// it spans.
pub(crate) struct Routed {
    lines: Parts,
    terminals: u64,
    reach: Rect,
}

impl Routed {
    fn new(lines: Parts, terminals: u64) -> Routed {
        let reach = lines.iter().flatten().fold(EMPTY, |reach, &p| union(reach, dot(p)));
        Routed { lines, terminals, reach }
    }

    /// A wire waiting for its first route, in nothing's way.
    fn waiting() -> Routed {
        Routed { lines: Vec::new(), terminals: 0, reach: EMPTY }
    }
}

/// Every orthogonal wire's route, by edge row, each in a slot of its own; the box each spans, by slot,
/// indexed, which finds the routes a box that moved is near; and the rows due to route again: near a
/// box that moved, or due before and not routed since.
#[derive(Default)]
pub(crate) struct Routes {
    by_row: FxHashMap<Row, (Routed, usize)>,
    /// The row each slot holds the route of; `None` where it is free.
    slots: Vec<Option<Row>>,
    free: Vec<usize>,
    reaches: Boxes,
    due: FxHashSet<Row>,
}

impl Routes {
    /// Row `row`'s route, where it has one.
    fn get(&self, row: &Row) -> Option<&Routed> {
        self.by_row.get(row).map(|(routed, _)| routed)
    }

    /// Row `row` routes along `routed`, due no longer.
    fn routed(&mut self, row: Row, routed: Routed) {
        self.due.remove(&row);
        self.put(row, routed);
    }

    /// Row `row` routes again: until it does, it keeps its route, or waits for its first.
    fn due(&mut self, row: &Row) {
        if !self.by_row.contains_key(row) {
            self.put(row.clone(), Routed::waiting());
        }
        self.due.insert(row.clone());
    }

    /// Row `row`'s route is `routed`, in its slot, or in a free one.
    fn put(&mut self, row: Row, routed: Routed) {
        let reach = routed.reach;
        let slot = if let Some((was, slot)) = self.by_row.get_mut(&row) {
            *was = routed;
            *slot
        } else {
            let slot = self.free.pop().unwrap_or(self.slots.len());
            if slot == self.slots.len() {
                self.slots.push(None);
            }
            self.slots[slot] = Some(row.clone());
            self.by_row.insert(row, (routed, slot));
            slot
        };
        self.reaches.set(slot, reach);
    }

    /// Forgets the routes of the rows `kept` does not hold.
    fn retain(&mut self, kept: impl Fn(&Row) -> bool) {
        let gone: Vec<Row> = self.by_row.keys().filter(|row| !kept(row)).cloned().collect();
        for row in gone {
            if let Some((_, slot)) = self.by_row.remove(&row) {
                self.slots[slot] = None;
                self.free.push(slot);
                self.reaches.set(slot, EMPTY);
            }
            self.due.remove(&row);
        }
    }

    /// The rows whose routes reach into `region`.
    fn near(&self, region: Rect) -> Vec<Row> {
        let mut near = Vec::new();
        self.reaches.some(region, &mut |slot| {
            near.extend(self.slots[slot].clone());
            false
        });
        near
    }
}

/// What wiring keeps between updates, so an edit works out only the wires it reaches: each edge mark's
/// rows' parts and the boxes they run within, indexed, the edge and net rows meeting each vertex, each
/// edge mark's lanes, and the sides orthogonal edges with ends leave their vertices by.
#[derive(Default)]
pub(crate) struct Wired {
    pub(crate) parts: Vec<Vec<Parts>>,
    meeting: Vec<Vec<[u32; 2]>>,
    lanes: Vec<Option<Vec<f64>>>,
    /// Each edge row's box, y down, by its place among every edge mark's rows.
    boxes: Boxes,
    /// Where each edge mark's rows start among them.
    firsts: Vec<usize>,
    sides: Sides,
}

impl Wired {
    /// The box around every wire, y down.
    pub(crate) fn extent(&self) -> Rect {
        self.boxes.extent()
    }

    /// The box edge mark `e`'s row `row` runs within, y down: its parts' points.
    fn bounds(&self, e: usize, row: usize) -> Rect {
        self.parts[e][row].iter().flatten().fold(EMPTY, |b, &p| union(b, dot(p)))
    }
}

/// Where each orthogonal edge with ends leaves its two vertices, and by vertex and side the ends
/// leaving there, ordered along it by where their other ends lie, so wires leave a side without
/// crossing. Kept between edits, so an edit orders again only the sides it changed, and works out
/// again only the edges leaving by them.
#[derive(Default)]
struct Sides {
    /// How each edge leaves its vertex at either end.
    of: FxHashMap<Edge, [Facing; 2]>,
    /// The ends leaving by each vertex's side, in order.
    at: FxHashMap<(usize, Side), Vec<Leaving>>,
}

/// An edge: its edge mark and row.
type Edge = (usize, usize);

/// How an end of an edge leaves: its vertex, the side it leaves by, and where the other end lies
/// along that side.
type Facing = (usize, Side, f64);

/// An end leaving by a side: where its other end lies along the side, its edge, and which end.
type Leaving = (f64, Edge, usize);

impl Sides {
    /// The sides each of `edges`, between the vertices it names, leaves them by.
    fn new(edges: impl Iterator<Item = (Edge, Option<[usize; 2]>)>, vertices: &[Vertex]) -> Sides {
        let mut sides = Sides::default();
        for (edge, ends) in edges {
            let Some(facings) = facings(ends, vertices) else { continue };
            for (end, &(v, side, along)) in facings.iter().enumerate() {
                sides.at.entry((v, side)).or_default().push((along, edge, end));
            }
            sides.of.insert(edge, facings);
        }
        for leaving in sides.at.values_mut() {
            crate::order::by_wide_key(leaving, order);
        }
        sides
    }

    /// Edge `edge`, between the vertices `ends` names, leaves them by the sides they face each other
    /// by now: out of the sides it left by, into these. The sides it left and joined go into
    /// `changed`.
    fn face(&mut self, edge: Edge, ends: Option<[usize; 2]>, vertices: &[Vertex], changed: &mut Vec<(usize, Side)>) {
        let now = facings(ends, vertices);
        if self.of.get(&edge).copied() == now {
            return;
        }
        for (end, (v, side, along)) in self.of.remove(&edge).into_iter().flatten().enumerate() {
            let leaving = self.at.get_mut(&(v, side)).expect("an end leaves by its side");
            let it = (along, edge, end);
            leaving.remove(leaving.partition_point(|x| order(x) < order(&it)));
            if leaving.is_empty() {
                self.at.remove(&(v, side));
            }
            changed.push((v, side));
        }
        let Some(now) = now else { return };
        for (end, &(v, side, along)) in now.iter().enumerate() {
            let leaving = self.at.entry((v, side)).or_default();
            let it = (along, edge, end);
            leaving.insert(leaving.partition_point(|x| order(x) < order(&it)), it);
            changed.push((v, side));
        }
        self.of.insert(edge, now);
    }

    /// Edge `edge`'s end `end`: its vertex, the side it leaves by, its place along it, and how many
    /// leave there.
    fn place(&self, edge: Edge, end: usize) -> Option<(usize, Side, u32, u32)> {
        let (v, side, along) = self.of.get(&edge)?[end];
        let leaving = self.at.get(&(v, side))?;
        let it = (along, edge, end);
        let place = leaving.partition_point(|x| order(x) < order(&it));
        Some((v, side, place as u32, leaving.len() as u32))
    }

    /// The edges leaving by any of `sides`.
    fn leaving<'s>(&'s self, sides: &'s [(usize, Side)]) -> impl Iterator<Item = Edge> + 's {
        sides.iter().filter_map(|side| self.at.get(side)).flatten().map(|&(_, edge, _)| edge)
    }
}

/// Where an end lies along its side, then its edge: within a side, no edge leaves twice, as its ends
/// stand at two vertices.
fn order(&(along, (e, row), _): &Leaving) -> u128 {
    crate::order::wide(crate::order::number(along), crate::order::pair(e as u32, row as u32))
}

/// How an edge between vertices `ends` leaves each: by the sides they face each other by, where the
/// other end lies along each; `None` unless both stand, apart.
fn facings(ends: Option<[usize; 2]>, vertices: &[Vertex]) -> Option<[Facing; 2]> {
    let [a, b] = ends.filter(|[a, b]| a != b)?;
    let (ba, bb) = (vertices[a].bounds?, vertices[b].bounds?);
    let (side_a, side_b) = facing(ba, bb);
    let along = |side: Side, other: Rect| match side {
        Side::Left | Side::Right => center(other)[1],
        Side::Top | Side::Bottom => center(other)[0],
    };
    Some([(a, side_a, along(side_a, bb)), (b, side_b, along(side_b, ba))])
}

/// Whether an edge mark routes orthogonal edges with ends, which share the sides they leave by.
fn sided(em: &EdgeMark<'_>) -> bool {
    em.mark.route == Some(Route::Orthogonal) && em.mark.ends.is_some()
}

/// What changed since wires were last worked out: the boxes that moved, added, or went, and after an
/// edit of a few rows the vertices it touched; with none, every row is worked out.
pub(crate) struct Change<'a> {
    pub(crate) moved: &'a [Rect],
    pub(crate) touched: Option<&'a [usize]>,
}

/// Routes a host job works out: each row it answers for by its key, with the stamp of its terminals
/// when asked; the boxes that moved since, which the routes it answers may cross; and how far wires
/// keep from them.
pub(crate) struct Routing {
    pub(crate) pending: Pending<Vec<u8>>,
    rows: FxHashMap<Key, (Row, u64)>,
    moved: Vec<Rect>,
    clearance: f64,
}

/// What wires are worked out from: the diagram's vertices, vertex marks, and edge marks; the blocks
/// wires route around, by vertex, and the groups they route among, y up; and in units how far apart
/// parallel wires run, how round their bends are, and how wide ports are.
pub(crate) struct Context<'a> {
    pub(crate) vertices: &'a [Vertex],
    pub(crate) marks: &'a [VertexMark<'a>],
    pub(crate) edges: &'a [EdgeMark<'a>],
    pub(crate) blocks: &'a Boxes,
    pub(crate) groups: &'a [Rect],
    pub(crate) spacing: f64,
    pub(crate) bend: f64,
    pub(crate) port: f64,
}

/// Where a wire meets a vertex: the point, y down, the side it leaves by, the vertex, and how far out
/// the port there reaches, 0 where none is: a wire stops at a port's rim, so its arrowhead shows.
#[derive(Clone, Copy)]
struct End {
    at: Point,
    side: Option<Side>,
    vertex: usize,
    rim: f64,
}

/// An orthogonal wire to route: its edge mark and row, the row, its ends with the root first, and how
/// many of its first ends drive it.
struct Ask {
    mark: usize,
    row: usize,
    key: Row,
    ends: Vec<End>,
    outputs: usize,
}

/// Takes a routing job's answer: each route it worked out, as routed from the terminals it was asked
/// for; one near a box that moved since it was asked routes again.
pub(crate) fn land(routes: &mut Routes, routing: &Routing, bytes: &[u8]) {
    for (key, values) in answers(bytes, &["route"]) {
        let (Some((row, terminals)), Some(Some(Value::Parts(lines)))) =
            (routing.rows.get(&key), values.into_iter().next())
        else {
            continue;
        };
        let routed = Routed::new(flipped(&lines), *terminals);
        let moved = routing.moved.iter().any(|m| meets(&grow(routed.reach, routing.clearance), m));
        routes.routed(row.clone(), routed);
        if moved {
            routes.due(row);
        }
    }
}

/// The boxes a change moved, added, or took away among the blocks wires route around: where each was,
/// and where it is.
pub(crate) fn moved(before: &FxHashMap<Row, Rect>, vertices: &[Vertex]) -> Vec<Rect> {
    let mut moved = Vec::new();
    let mut now: FxHashSet<&Row> = FxHashSet::default();
    for v in vertices {
        let Some(b) = v.bounds else { continue };
        now.insert(&v.key);
        if v.group {
            continue;
        }
        match before.get(&v.key) {
            Some(was) if *was == b => {}
            Some(was) => moved.extend([*was, b]),
            None => moved.push(b),
        }
    }
    moved.extend(before.iter().filter(|(row, _)| !now.contains(row)).map(|(_, b)| *b));
    moved
}

/// Each edge mark's rows' paths, y down, into `wired`: worked out at once where straight or bent,
/// routed where orthogonal: on the frame while the budget lasts, else in a job, `routes` holding what
/// was routed and the job under way. After an edit, only the rows it reaches; the rows worked out.
pub(crate) fn paths(
    context: &Context<'_>,
    input: &Input<'_>,
    jobs: &mut Jobs<'_>,
    change: &Change<'_>,
    wired: &mut Wired,
    (routes, routing): (&mut Routes, &mut Option<Routing>),
) -> Vec<Vec<usize>> {
    let (vertices, edge_marks) = (context.vertices, context.edges);
    let codes: Vec<Vec<u32>> = context.marks.iter().map(|vm| port_codes(vm.mark)).collect();
    let joins: Vec<Joins<'_>> = edge_marks.iter().map(|em| Joins::new(context.marks, &codes, em)).collect();
    let orthogonal = |e: usize| edge_marks[e].mark.route == Some(Route::Orthogonal);
    // A route near a box that moved routes again.
    let clearance = CLEARANCE * 2.0 * context.spacing;
    for &m in change.moved {
        for row in routes.near(grow(m, clearance)) {
            routes.due(&row);
        }
    }
    let rows = if let Some(touched) = change.touched {
        reached(context, &joins, touched, wired, routes, routing.as_ref())
    } else {
        every_row(context, &joins, wired)
    };
    // Which vertices each row meets is told once, as every row is worked out.
    let telling = change.touched.is_none();
    let mut asks: Vec<Ask> = Vec::new();
    for (e, em) in edge_marks.iter().enumerate() {
        let joins = &joins[e];
        let orthogonal = orthogonal(e);
        for &row in &rows[e] {
            wired.parts[e][row] = Vec::new();
            let Some(id) = em.table.ids.id(row) else { continue };
            let key = Row { data: em.data.name().clone(), table: em.table.name().clone(), id };
            let meeting = [e as u32, row as u32];
            if let Some([a, b]) = joins.ends(row) {
                if telling {
                    wired.meeting[a].push(meeting);
                    wired.meeting[b].push(meeting);
                }
                let (va, vb) = (&vertices[a], &vertices[b]);
                if a == b || va.bounds.is_none() || vb.bounds.is_none() {
                    continue;
                }
                if orthogonal {
                    let ends = faced(&wired.sides, (e, row), vertices);
                    asks.push(Ask { mark: e, row, key, ends, outputs: 1 });
                } else {
                    let through = em.mark.bends.as_ref().map(|field| bends(em.table, field, row)).unwrap_or_default();
                    let shift = wired.lanes[e].as_ref().map_or(0.0, |lanes| lanes[row] * context.spacing);
                    wired.parts[e][row] = straight(va, vb, &through, shift).into_iter().collect();
                }
                continue;
            }
            let terminals = joins.terminals(context.marks, row);
            if telling {
                for &(v, ..) in &terminals {
                    wired.meeting[v].push(meeting);
                }
            }
            // A net: its ends at the ports naming it, outputs first.
            let mut ends: Vec<(End, bool)> = terminals
                .into_iter()
                .filter_map(|(v, code, output)| {
                    let b = vertices[v].bounds?;
                    let end = End {
                        at: port_point(b, code),
                        side: Side::from_code(code & 3),
                        vertex: v,
                        rim: port_reach(b, context.port),
                    };
                    Some((end, output))
                })
                .collect();
            if ends.len() < 2 {
                continue;
            }
            crate::order::by_key(&mut ends, |&(_, output)| u64::from(!output));
            let outputs = ends.iter().filter(|(_, output)| *output).count().max(1);
            let ends: Vec<End> = ends.into_iter().map(|(end, _)| end).collect();
            if orthogonal {
                asks.push(Ask { mark: e, row, key, ends, outputs });
            } else {
                wired.parts[e][row] = star(&ends, outputs);
            }
        }
    }
    wire(context, input, jobs, &asks, change, (routes, routing), &mut wired.parts);
    // The box each row worked out runs within, which the extent of every wire is kept from.
    if telling {
        let boxes = (0..edge_marks.len()).flat_map(|e| (0..edge_marks[e].table.len()).map(move |row| (e, row)));
        wired.boxes = Boxes::new(boxes.map(|(e, row)| wired.bounds(e, row)).collect());
    } else {
        for (e, rows) in rows.iter().enumerate() {
            for &row in rows {
                let bounds = wired.bounds(e, row);
                wired.boxes.set(wired.firsts[e] + row, bounds);
            }
        }
    }
    rows
}

/// Every row of every edge mark, by edge mark, with `wired` started over for them: no parts yet, each
/// mark's lanes, where its rows start among them all, and the sides its orthogonal edges with ends
/// leave by.
fn every_row(context: &Context<'_>, joins: &[Joins<'_>], wired: &mut Wired) -> Vec<Vec<usize>> {
    let edge_marks = context.edges;
    wired.parts = edge_marks.iter().map(|em| vec![Vec::new(); em.table.len()]).collect();
    wired.meeting = vec![Vec::new(); context.vertices.len()];
    wired.lanes = (0..edge_marks.len())
        .map(|e| {
            let em = &edge_marks[e];
            let spaced = em.mark.route != Some(Route::Orthogonal) && em.mark.bends.is_none();
            if spaced { spread(em.table.len(), |r| joins[e].ends(r)) } else { None }
        })
        .collect();
    wired.firsts = edge_marks
        .iter()
        .scan(0, |first, em| {
            *first += em.table.len();
            Some(*first - em.table.len())
        })
        .collect();
    let edges = (0..edge_marks.len())
        .filter(|&e| sided(&edge_marks[e]))
        .flat_map(|e| (0..edge_marks[e].table.len()).map(move |row| (e, row)));
    wired.sides = Sides::new(edges.map(|(e, row)| ((e, row), joins[e].ends(row))), context.vertices);
    edge_marks.iter().map(|em| (0..em.table.len()).collect()).collect()
}

/// The rows an edit of vertices `touched` reaches, by edge mark, in order: those meeting them; the
/// orthogonal edges with ends leaving by a side whose ends it changed; and the orthogonal wires due to
/// route again, or asked of the job under way.
fn reached(
    context: &Context<'_>,
    joins: &[Joins<'_>],
    touched: &[usize],
    wired: &mut Wired,
    routes: &Routes,
    routing: Option<&Routing>,
) -> Vec<Vec<usize>> {
    let edge_marks = context.edges;
    let mut rows: Vec<Vec<usize>> = vec![Vec::new(); edge_marks.len()];
    for &[e, row] in touched.iter().flat_map(|&v| &wired.meeting[v]) {
        rows[e as usize].push(row as usize);
    }
    // An edge with ends meeting what the edit moved leaves by other sides, or from other places along
    // them: so do the edges leaving by a side it left or joined.
    let mut changed = Vec::new();
    for (e, rows) in rows.iter_mut().enumerate().filter(|(e, _)| sided(&edge_marks[*e])) {
        rows.sort_unstable();
        rows.dedup();
        for &row in rows.iter() {
            wired.sides.face((e, row), joins[e].ends(row), context.vertices, &mut changed);
        }
    }
    crate::order::by_key(&mut changed, |&(v, side)| crate::order::pair(v as u32, side.code()));
    changed.dedup();
    let leaving: Vec<Edge> = wired.sides.leaving(&changed).collect();
    for (e, row) in leaving {
        rows[e].push(row);
    }
    let asked = routing.into_iter().flat_map(|r| r.rows.values().map(|(row, _)| row));
    for (e, row) in routes.due.iter().chain(asked).filter_map(|row| drawing(context, row)) {
        rows[e].push(row);
    }
    for rows in &mut rows {
        rows.sort_unstable();
        rows.dedup();
    }
    rows
}

/// The edge mark and row drawing edge row `row`.
fn drawing(context: &Context<'_>, row: &Row) -> Option<(usize, usize)> {
    let e = context.edges.iter().position(|em| *em.data.name() == row.data && *em.table.name() == row.table)?;
    Some((e, context.edges[e].table.row(row.id.as_ref())?))
}

/// Routes the orthogonal wires that are due, and writes the parts of every orthogonal wire `asks`
/// holds: its route, bends rounded; an elbow while its terminals moved and a job routes it.
fn wire(
    context: &Context<'_>,
    input: &Input<'_>,
    jobs: &mut Jobs<'_>,
    asks: &[Ask],
    change: &Change<'_>,
    (routes, routing): (&mut Routes, &mut Option<Routing>),
    out: &mut [Vec<Parts>],
) {
    if let Some(routing) = routing.as_mut() {
        routing.moved.extend_from_slice(change.moved);
    }
    // Routes of rows no longer drawn are forgotten, once every row is worked out.
    if change.touched.is_none() {
        let drawn: FxHashSet<&Row> = asks.iter().map(|ask| &ask.key).collect();
        routes.retain(|row| drawn.contains(row));
    }
    if asks.is_empty() {
        return;
    }
    let vertices = context.vertices;
    let tracks = 2.0 * context.spacing;
    let clearance = CLEARANCE * tracks;
    let stamps: Vec<u64> = asks.iter().map(|ask| stamp(&ask.ends, vertices)).collect();
    let mut due: Vec<usize> = (0..asks.len())
        .filter(|&k| {
            let key = &asks[k].key;
            routes.due.contains(key) || routes.get(key).is_none_or(|r| r.terminals != stamps[k])
        })
        .collect();
    let asked = |k: &usize| routing.as_ref().is_some_and(|r| r.rows.contains_key(&key_of(&asks[*k].key)));
    if routing.is_some() && !input.dragging {
        // Wires a job under way routes wait for it.
        due.retain(|k| !asked(k));
    }
    if !due.is_empty() {
        let cost = ROUTE_COST * due.len() as u64;
        let inline = if input.dragging {
            jobs.spend(ROUTE_COST * due.len().min(DRAGGED) as u64);
            true
        } else {
            jobs.fits(cost)
        };
        if inline {
            let routed = &due[..due.len().min(DRAGGED)];
            let nets: Vec<Net> = routed.iter().map(|&k| net(&asks[k], vertices)).collect();
            let fixed = fixed(context, asks, routed, routes, 4.0 * clearance);
            let lines = route(context.blocks, context.groups, &nets, &fixed, tracks);
            for (&k, lines) in routed.iter().zip(lines) {
                routes.routed(asks[k].key.clone(), Routed::new(flipped(&lines), stamps[k]));
            }
            if let Some(routing) = routing.as_mut() {
                let done: FxHashSet<&Row> = routed.iter().map(|&k| &asks[k].key).collect();
                routing.rows.retain(|_, (row, _)| !done.contains(row));
            }
            due.drain(..routed.len());
        } else if routing.is_none() {
            let nets: Vec<Net> = due.iter().map(|&k| net(&asks[k], vertices)).collect();
            let fixed = fixed(context, asks, &due, routes, 4.0 * clearance);
            let keys: Vec<Key> = due.iter().map(|&k| key_of(&asks[k].key)).collect();
            let wiring = Wiring {
                obstacles: context.blocks.all(),
                groups: context.groups,
                nets: &nets,
                keys: &keys,
                fixed: &fixed,
                spacing: tracks,
            };
            let pending = jobs.spawn(Job::routes(&wiring));
            let rows = keys.into_iter().zip(&due).map(|(key, &k)| (key, (asks[k].key.clone(), stamps[k]))).collect();
            *routing = Some(Routing { pending, rows, moved: Vec::new(), clearance });
        }
        // Wires still due route later; until then they keep their routes while their terminals hold.
        for &k in &due {
            routes.due(&asks[k].key);
        }
    }
    for (k, ask) in asks.iter().enumerate() {
        let Some((root, rest)) = ask.ends.split_first() else { continue };
        let lines = match routes.get(&ask.key) {
            Some(r) if r.terminals == stamps[k] => r.lines.clone(),
            _ => rest.iter().map(|end| elbow(root, end, clearance)).collect(),
        };
        let mut parts = finish(&lines, context.bend);
        // A part reaching another output ends there without an arrowhead.
        let outputs = &rest[..(ask.outputs - 1).min(rest.len())];
        for part in &mut parts {
            if let Some(&end) = part.last()
                && outputs.iter().any(|o| o.at == end)
            {
                part.push(end);
            }
            stop_at_rims(part, &ask.ends);
        }
        out[ask.mark][ask.row] = parts;
    }
}

/// Where a port of code `code` sits on box `b`, y down: on its side, spread by its place among the
/// ports there, as the port draws.
fn port_point(b: Rect, code: u32) -> Point {
    let (place, count) = (f64::from((code >> 2) & 255), f64::from((code >> 10) & 255));
    let along = (place + 1.0) / (count + 1.0) * 2.0 - 1.0;
    let ([x, y], [w, h]) = (center(b), [(b[2] - b[0]) / 2.0, (b[3] - b[1]) / 2.0]);
    match Side::from_code(code & 3) {
        Some(Side::Left) => [x - w, y + along * h],
        Some(Side::Right) => [x + w, y + along * h],
        Some(Side::Top) => [x + along * w, y - h],
        Some(Side::Bottom) | None => [x + along * w, y + h],
    }
}

/// How far a port `size` across on box `b` reaches from its middle: at most half the box's smaller
/// side.
fn port_reach(b: Rect, size: f64) -> f64 {
    (size / 2.0).min((b[2] - b[0]).min(b[3] - b[1]) / 4.0)
}

/// The ends of orthogonal edge `edge`, as `sides` gives them: on the sides of its vertices facing each
/// other, spread along each by where the other ends lie.
fn faced(sides: &Sides, edge: Edge, vertices: &[Vertex]) -> Vec<End> {
    (0..2)
        .filter_map(|end| {
            let (v, side, place, count) = sides.place(edge, end)?;
            let code = side.code() | (place.min(255) << 2) | (count.min(255) << 10);
            Some(End { at: port_point(vertices[v].bounds?, code), side: Some(side), vertex: v, rim: 0.0 })
        })
        .collect()
}

/// The sides of boxes `a` and `b` that face each other, y down: across the wider gap between them.
fn facing(a: Rect, b: Rect) -> (Side, Side) {
    let ([ax, ay], [bx, by]) = (center(a), center(b));
    let (dx, dy) = (bx - ax, by - ay);
    let gap_x = dx.abs() - (a[2] - a[0] + b[2] - b[0]) / 2.0;
    let gap_y = dy.abs() - (a[3] - a[1] + b[3] - b[1]) / 2.0;
    if gap_x >= gap_y {
        if dx >= 0.0 { (Side::Right, Side::Left) } else { (Side::Left, Side::Right) }
    } else if dy >= 0.0 {
        (Side::Bottom, Side::Top)
    } else {
        (Side::Top, Side::Bottom)
    }
}

/// A stamp of where a wire's ends are, the sides they leave by, and their vertices' boxes.
fn stamp(ends: &[End], vertices: &[Vertex]) -> u64 {
    let mut hasher = FxHasher::default();
    for end in ends {
        (end.at.map(f64::to_bits), end.side.map(Side::code)).hash(&mut hasher);
        vertices[end.vertex].bounds.map(|b| b.map(f64::to_bits)).hash(&mut hasher);
    }
    hasher.finish().max(1)
}

/// The net routing `ask`, y up: each end owned by its vertex's block, which a group has none of.
fn net(ask: &Ask, vertices: &[Vertex]) -> Net {
    let terminal = |end: &End| Terminal {
        at: [end.at[0], -end.at[1]],
        side: end.side,
        owner: (!vertices[end.vertex].group).then_some(end.vertex as u32),
    };
    Net { terminals: ask.ends.iter().map(terminal).collect() }
}

/// The routes of the wires near those about to route, which keep their tracks, y up: within `reach`
/// of the ends of the wires `routed`, in the order the edge marks draw them.
fn fixed(context: &Context<'_>, asks: &[Ask], routed: &[usize], routes: &Routes, reach: f64) -> Parts {
    let region = routed.iter().flat_map(|&k| &asks[k].ends).fold(EMPTY, |region, end| union(region, dot(end.at)));
    let routing: FxHashSet<&Row> = routed.iter().map(|&k| &asks[k].key).collect();
    let mut near: Vec<(Edge, &Routed)> = routes
        .near(grow(region, reach))
        .into_iter()
        .filter(|row| !routing.contains(row))
        .filter_map(|row| Some((drawing(context, &row)?, routes.get(&row)?)))
        .collect();
    crate::order::by_key(&mut near, |&((e, row), _)| crate::order::pair(e as u32, row as u32));
    near.into_iter().flat_map(|(_, r)| flipped(&r.lines)).collect()
}

/// An orthogonal path from `a` to `b` that leaves and enters along their sides, `stub` out from each.
fn elbow(a: &End, b: &End, stub: f64) -> Vec<Point> {
    let out = |end: &End| {
        let n = normal(end.side);
        [end.at[0] + n[0] * stub, end.at[1] + n[1] * stub]
    };
    let (from, to) = (out(a), out(b));
    let across = |end: &End| matches!(end.side, Some(Side::Left | Side::Right) | None);
    let mut path = vec![a.at, from];
    match (across(a), across(b)) {
        (true, true) => {
            let x = from[0].midpoint(to[0]);
            path.extend([[x, from[1]], [x, to[1]]]);
        }
        (false, false) => {
            let y = from[1].midpoint(to[1]);
            path.extend([[from[0], y], [to[0], y]]);
        }
        (true, false) => path.push([to[0], from[1]]),
        (false, true) => path.push([from[0], to[1]]),
    }
    path.extend([to, b.at]);
    simplify(&path)
}

/// The way out of a side, y down.
fn normal(side: Option<Side>) -> Point {
    match side {
        Some(Side::Left) => [-1.0, 0.0],
        Some(Side::Right) => [1.0, 0.0],
        Some(Side::Top) => [0.0, -1.0],
        Some(Side::Bottom) => [0.0, 1.0],
        None => [0.0, 0.0],
    }
}

/// A straight wire from `a` to `b` through the points `through`, from outline to outline; without
/// bends, shifted `shift` across into its lane.
fn straight(a: &Vertex, b: &Vertex, through: &[Point], shift: f64) -> Option<Vec<Point>> {
    let (ca, cb) = (a.center()?, b.center()?);
    if let (Some(&first), Some(&last)) = (through.first(), through.last()) {
        let (da, la) = unit(ca, first)?;
        let (db, lb) = unit(last, cb)?;
        let start = add(ca, da, outline(a, da).min(la));
        let end = add(cb, db, -outline(b, db).min(lb));
        return Some([start].into_iter().chain(through.iter().copied()).chain([end]).collect());
    }
    let (d, length) = unit(ca, cb)?;
    let n = [-d[1], d[0]];
    let (pa, pb) = (add(ca, n, shift), add(cb, n, shift));
    let room = length / 2.0;
    Some(vec![add(pa, d, outline(a, d).min(room)), add(pb, d, -outline(b, d).min(room))])
}

/// How far `v`'s outline lies from its middle along the unit direction `d`.
fn outline(v: &Vertex, d: Point) -> f64 {
    let Some(b) = v.bounds else { return 0.0 };
    let (w, h) = ((b[2] - b[0]) / 2.0, (b[3] - b[1]) / 2.0);
    if w <= 0.0 || h <= 0.0 {
        return 0.0;
    }
    match v.shape {
        Shape::Ellipse => 1.0 / ((d[0] / w).powi(2) + (d[1] / h).powi(2)).sqrt(),
        Shape::Diamond => 1.0 / (d[0].abs() / w + d[1].abs() / h),
        Shape::Rectangle | Shape::Rounded => (w / d[0].abs().max(1e-12)).min(h / d[1].abs().max(1e-12)),
    }
}

/// A straight net: two ends joined, or more joined through their middle, outputs into it and from
/// it out to inputs. Parts into the middle end doubled there, a junction without an arrowhead; parts
/// stop at the rims of the ports they join.
fn star(ends: &[End], outputs: usize) -> Parts {
    if let [a, b] = ends {
        let mut part = vec![rim_point(a, b.at), rim_point(b, a.at)];
        if outputs > 1 {
            part.push(part[1]);
        }
        return vec![part];
    }
    let n = ends.len() as f64;
    let middle = [ends.iter().map(|e| e.at[0]).sum::<f64>() / n, ends.iter().map(|e| e.at[1]).sum::<f64>() / n];
    let part = |(k, end): (usize, &End)| {
        if k < outputs { vec![rim_point(end, middle), middle, middle] } else { vec![middle, rim_point(end, middle)] }
    };
    ends.iter().enumerate().map(part).collect()
}

/// Moves a routed part's ends at ports back to the ports' rims, as a straight net's stop: its first
/// point toward the next, and its last, doubled where it reaches an output, toward the one before.
/// The router joins the ports themselves, on their boxes' sides.
fn stop_at_rims(part: &mut [Point], ends: &[End]) {
    let port = |p: Point| ends.iter().find(|end| end.rim > 0.0 && end.at == p);
    let last = part.len().saturating_sub(1);
    let copies = part.iter().rev().take_while(|&&p| p == part[last]).count();
    if copies > last {
        return;
    }
    let first = port(part[0]).map(|end| rim_point(end, part[1]));
    let end = port(part[last]).map(|end| rim_point(end, part[last - copies]));
    if let Some(p) = first {
        part[0] = p;
    }
    if let Some(p) = end {
        part[last + 1 - copies..].fill(p);
    }
}

/// `end`'s point on the way to `toward`: its port's rim, at most halfway there.
fn rim_point(end: &End, toward: Point) -> Point {
    unit(end.at, toward).map_or(end.at, |(d, length)| add(end.at, d, end.rim.min(length / 2.0)))
}

/// The points of row `row`'s path field `field`, y down.
fn bends(table: &Table, field: &str, row: usize) -> Vec<Point> {
    match table.value(row, field, f64::INFINITY) {
        Some(Value::Path(points)) => points.into_iter().filter(|p| p.iter().all(|v| v.is_finite())).collect(),
        _ => Vec::new(),
    }
}

// Lines with y up as y down, or back.
fn flipped(lines: &[Vec<Point>]) -> Parts {
    lines.iter().map(|line| line.iter().map(|p| [p[0], -p[1]]).collect()).collect()
}

fn center(b: Rect) -> Point {
    [b[0].midpoint(b[2]), b[1].midpoint(b[3])]
}

/// The unit direction from `a` to `b`, and the distance; `None` where they meet.
fn unit(a: Point, b: Point) -> Option<(Point, f64)> {
    let d = [b[0] - a[0], b[1] - a[1]];
    let length = d[0].hypot(d[1]);
    (length > 1e-9).then(|| ([d[0] / length, d[1] / length], length))
}

/// `p` moved `by` along `d`.
fn add(p: Point, d: Point, by: f64) -> Point {
    [p[0] + d[0] * by, p[1] + d[1] * by]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(at: Point, side: Side) -> End {
        End { at, side: Some(side), vertex: 0, rim: 0.0 }
    }

    #[test]
    fn elbows_leave_and_enter_along_their_sides() {
        let path = elbow(&end([0.0, 0.0], Side::Right), &end([100.0, 40.0], Side::Left), 10.0);
        assert_eq!(path, vec![[0.0, 0.0], [50.0, 0.0], [50.0, 40.0], [100.0, 40.0]]);
        let turned = elbow(&end([0.0, 0.0], Side::Right), &end([100.0, 40.0], Side::Top), 10.0);
        assert_eq!(turned, vec![[0.0, 0.0], [100.0, 0.0], [100.0, 40.0]]);
    }

    #[test]
    fn facing_sides_cross_the_wider_gap() {
        let a = [0.0, 0.0, 100.0, 20.0];
        assert_eq!(facing(a, [150.0, 30.0, 250.0, 50.0]), (Side::Right, Side::Left));
        assert_eq!(facing(a, [20.0, 80.0, 80.0, 100.0]), (Side::Bottom, Side::Top), "below, y down");
        assert_eq!(facing(a, [20.0, -100.0, 80.0, -80.0]), (Side::Top, Side::Bottom));
    }

    #[test]
    fn ports_sit_where_they_draw() {
        let b = [0.0, 0.0, 40.0, 20.0];
        // The second of three on the left: halfway down, y down.
        assert_eq!(port_point(b, Side::Left.code() | 1 << 2 | 3 << 10), [0.0, 10.0]);
        assert_eq!(port_point(b, Side::Top.code() | 1 << 10), [20.0, 0.0]);
        assert_eq!(port_point(b, Side::Bottom.code() | 1 << 2 | 3 << 10), [20.0, 20.0]);
    }

    #[test]
    fn stars_join_outputs_to_inputs_through_their_middle() {
        let ends = [end([0.0, 0.0], Side::Right), end([30.0, 0.0], Side::Left), end([30.0, 30.0], Side::Left)];
        let parts = star(&ends, 1);
        assert_eq!(parts[0], vec![[0.0, 0.0], [20.0, 10.0], [20.0, 10.0]], "into the middle, a junction");
        assert_eq!(parts[2], vec![[20.0, 10.0], [30.0, 30.0]], "out to an input, an arrowhead");
    }

    #[test]
    fn wires_stop_at_the_rims_of_ports() {
        let port = |at: Point| End { rim: 4.0, ..end(at, Side::Top) };
        assert_eq!(star(&[port([0.0, 0.0]), port([40.0, 0.0])], 1), [vec![[4.0, 0.0], [36.0, 0.0]]], "short of each");
        // A port reaches no further than halfway to the other end.
        assert_eq!(star(&[port([0.0, 0.0]), port([6.0, 0.0])], 1), [vec![[3.0, 0.0], [3.0, 0.0]]]);
        let b = [0.0, 0.0, 40.0, 40.0];
        assert_eq!(port_reach(b, 7.0), 3.5);
        assert_eq!(port_reach([0.0, 0.0, 8.0, 40.0], 7.0), 2.0, "at most half the box's smaller side");
    }

    #[test]
    fn routed_parts_stop_at_the_rims_of_ports() {
        let ends =
            [End { rim: 4.0, ..end([0.0, 0.0], Side::Right) }, End { rim: 4.0, ..end([40.0, 20.0], Side::Left) }];
        let mut part = vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [40.0, 20.0]];
        stop_at_rims(&mut part, &ends);
        assert_eq!(part, [[4.0, 0.0], [20.0, 0.0], [20.0, 20.0], [36.0, 20.0]], "routed between the ports");
        // A branch from a junction into an output, doubled there: the junction stays.
        let mut part = vec![[20.0, 0.0], [20.0, 20.0], [40.0, 20.0], [40.0, 20.0]];
        stop_at_rims(&mut part, &ends);
        assert_eq!(part, [[20.0, 0.0], [20.0, 20.0], [36.0, 20.0], [36.0, 20.0]]);
    }
}
