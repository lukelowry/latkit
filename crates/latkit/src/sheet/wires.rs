//! Wires: the path each edge row of a diagram runs along, in units with y down. An edge with ends
//! runs between its two vertices; a net joins every port naming it, from its outputs. A straight wire
//! runs between outlines, set apart in lanes where edges join the same two vertices, or as a star
//! through a net's middle; bends run through the points of a path field; an orthogonal wire routes
//! around every block. A route holds until its terminals move or a box near it changes. Then it
//! routes again on the frame when few do or rows are being dragged, else in a host job, keeping its
//! old path while its terminals hold, or an elbow while they moved, until the job answers.

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHashSet, FxHasher};

use super::{EdgeMark, Vertex, VertexMark, drawing, key_of};
use crate::data::{Field, Inverse, Reference, Row, Table, Value};
use crate::derive::{Input, Jobs, answers, spread};
use crate::host::{Job, Key, Wiring};
use crate::layout::route::{Net, Terminal, finish, route, simplify};
use crate::{Pending, Port, Route, Shape, Side, Vertices};

/// Microseconds a wire takes to route, by estimate: what it spends of the frame's budget. A batch
/// that does not fit routes in a host job.
const ROUTE_COST: u64 = 160;
/// Wires routed on the frame at most while rows are dragged, whatever the budget; the rest route
/// once the drag ends.
const DRAGGED: usize = 256;
/// How far wires keep from blocks, in tracks: as far as routes keep.
const CLEARANCE: f64 = 2.0;

type Point = [f64; 2];
type Rect = [f64; 4];
/// A wire's parts.
pub(crate) type Parts = Vec<Vec<Point>>;

/// A box holding nothing, which any union replaces.
const EMPTY: Rect = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];

/// A route: its polylines, y down, before bends round; a stamp of the terminals it joins; the box it
/// spans; and whether it is to route again, a box having moved near it while it waited.
pub(crate) struct Routed {
    lines: Parts,
    terminals: u64,
    reach: Rect,
    stale: bool,
}

impl Routed {
    fn new(lines: Parts, terminals: u64) -> Routed {
        let reach = lines.iter().flatten().fold(EMPTY, |reach, &p| union(reach, dot(p)));
        Routed { lines, terminals, reach, stale: false }
    }
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

/// What wires are worked out from: the diagram's vertices and vertex marks, how far apart parallel
/// wires run, and how round their bends are, units.
pub(crate) struct Context<'a> {
    pub(crate) vertices: &'a [Vertex],
    pub(crate) marks: &'a [VertexMark<'a>],
    pub(crate) spacing: f64,
    pub(crate) radius: f64,
}

/// Where a wire meets a vertex: the point, y down, the side it leaves by, and the vertex.
#[derive(Clone, Copy)]
struct End {
    at: Point,
    side: Option<Side>,
    vertex: usize,
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
pub(crate) fn land(routes: &mut FxHashMap<Row, Routed>, routing: &Routing, bytes: &[u8]) {
    for (key, values) in answers(bytes, &["route"]) {
        let (Some((row, terminals)), Some(Some(Value::Parts(lines)))) =
            (routing.rows.get(&key), values.into_iter().next())
        else {
            continue;
        };
        let mut routed = Routed::new(flipped(&lines), *terminals);
        routed.stale = routing.moved.iter().any(|m| meets(&grow(routed.reach, routing.clearance), m));
        routes.insert(row.clone(), routed);
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

/// Each edge mark's rows' paths, y down: worked out at once where straight or bent, routed where
/// orthogonal: on the frame while the budget lasts, else in a job, `routes` holding what was routed
/// and the job under way.
pub(crate) fn paths(
    context: &Context<'_>,
    edge_marks: &[EdgeMark<'_>],
    input: &Input<'_>,
    jobs: &mut Jobs<'_>,
    moved: &[Rect],
    (routes, routing): (&mut FxHashMap<Row, Routed>, &mut Option<Routing>),
) -> Vec<Vec<Parts>> {
    let vertices = context.vertices;
    let codes: Vec<Vec<u32>> = context.marks.iter().map(|vm| port_codes(vm.mark)).collect();
    let mut out: Vec<Vec<Parts>> = edge_marks.iter().map(|em| vec![Vec::new(); em.table.len()]).collect();
    let mut asks: Vec<Ask> = Vec::new();
    let mut edges: Vec<(usize, [usize; 2])> = Vec::new();
    for (e, em) in edge_marks.iter().enumerate() {
        let joins = Joins::new(context.marks, &codes, em);
        let orthogonal = em.mark.route == Some(Route::Orthogonal);
        let lanes =
            if orthogonal || em.mark.bends.is_some() { None } else { spread(em.table.len(), |r| joins.ends(r)) };
        for row in 0..em.table.len() {
            let Some(id) = em.table.ids.id(row) else { continue };
            let key = Row { data: em.data.name().clone(), table: em.table.name().clone(), id };
            if let Some([a, b]) = joins.ends(row) {
                let (va, vb) = (&vertices[a], &vertices[b]);
                if a == b || va.bounds.is_none() || vb.bounds.is_none() {
                    continue;
                }
                if orthogonal {
                    edges.push((asks.len(), [a, b]));
                    asks.push(Ask { mark: e, row, key, ends: Vec::new(), outputs: 1 });
                } else {
                    let through = em.mark.bends.as_ref().map(|field| bends(em.table, field, row)).unwrap_or_default();
                    let shift = lanes.as_ref().map_or(0.0, |lanes| lanes[row] * context.spacing);
                    out[e][row] = straight(va, vb, &through, shift).into_iter().collect();
                }
                continue;
            }
            // A net: its ends at the ports naming it, outputs first.
            let mut ends: Vec<(End, bool)> = joins
                .terminals(context.marks, row)
                .into_iter()
                .filter_map(|(v, code, output)| {
                    let b = vertices[v].bounds?;
                    Some((End { at: port_point(b, code), side: Side::from_code(code & 3), vertex: v }, output))
                })
                .collect();
            if ends.len() < 2 {
                continue;
            }
            ends.sort_by_key(|&(_, output)| !output);
            let outputs = ends.iter().filter(|(_, output)| *output).count().max(1);
            let ends: Vec<End> = ends.into_iter().map(|(end, _)| end).collect();
            if orthogonal {
                asks.push(Ask { mark: e, row, key, ends, outputs });
            } else {
                out[e][row] = star(&ends, outputs);
            }
        }
    }
    face(&mut asks, &edges, vertices);
    wire(context, input, jobs, &asks, moved, (routes, routing), &mut out);
    out
}

/// Routes the orthogonal wires that are due, and writes every orthogonal wire's parts: its route,
/// bends rounded; an elbow while its terminals moved and a job routes it.
fn wire(
    context: &Context<'_>,
    input: &Input<'_>,
    jobs: &mut Jobs<'_>,
    asks: &[Ask],
    moved: &[Rect],
    (routes, routing): (&mut FxHashMap<Row, Routed>, &mut Option<Routing>),
    out: &mut [Vec<Parts>],
) {
    if let Some(routing) = routing.as_mut() {
        routing.moved.extend_from_slice(moved);
    }
    // Routes of rows no longer drawn are forgotten.
    if routes.len() > asks.len() {
        let drawn: FxHashSet<&Row> = asks.iter().map(|ask| &ask.key).collect();
        routes.retain(|row, _| drawn.contains(row));
    }
    if asks.is_empty() {
        return;
    }
    let vertices = context.vertices;
    let tracks = 2.0 * context.spacing;
    let clearance = CLEARANCE * tracks;
    let stamps: Vec<u64> = asks.iter().map(|ask| stamp(&ask.ends, vertices)).collect();
    let mut due: Vec<usize> = (0..asks.len())
        .filter(|&k| match routes.get(&asks[k].key) {
            Some(r) => r.stale || r.terminals != stamps[k] || moved.iter().any(|m| meets(&grow(r.reach, clearance), m)),
            None => true,
        })
        .collect();
    let asked = |k: &usize| routing.as_ref().is_some_and(|r| r.rows.contains_key(&key_of(&asks[*k].key)));
    if routing.is_some() && !input.dragging {
        // Wires a job under way routes wait for it.
        due.retain(|k| !asked(k));
    }
    if !due.is_empty() {
        let (obstacles, owners) = obstacles(vertices);
        let groups = groups(vertices);
        let cost = ROUTE_COST * due.len() as u64;
        let inline = if input.dragging {
            jobs.spend(ROUTE_COST * due.len().min(DRAGGED) as u64);
            true
        } else {
            jobs.fits(cost)
        };
        if inline {
            let routed = &due[..due.len().min(DRAGGED)];
            let nets: Vec<Net> = routed.iter().map(|&k| net(&asks[k], &owners)).collect();
            let fixed = fixed(asks, routed, routes, 4.0 * clearance);
            for (&k, lines) in routed.iter().zip(route(&obstacles, &groups, &nets, &fixed, tracks)) {
                routes.insert(asks[k].key.clone(), Routed::new(flipped(&lines), stamps[k]));
            }
            if let Some(routing) = routing.as_mut() {
                let done: FxHashSet<&Row> = routed.iter().map(|&k| &asks[k].key).collect();
                routing.rows.retain(|_, (row, _)| !done.contains(row));
            }
            due.drain(..routed.len());
        } else if routing.is_none() {
            let nets: Vec<Net> = due.iter().map(|&k| net(&asks[k], &owners)).collect();
            let fixed = fixed(asks, &due, routes, 4.0 * clearance);
            let keys: Vec<Key> = due.iter().map(|&k| key_of(&asks[k].key)).collect();
            let wiring = Wiring {
                obstacles: &obstacles,
                groups: &groups,
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
            if let Some(r) = routes.get_mut(&asks[k].key) {
                r.stale = true;
            }
        }
    }
    for (k, ask) in asks.iter().enumerate() {
        let Some((root, rest)) = ask.ends.split_first() else { continue };
        let lines = match routes.get(&ask.key) {
            Some(r) if r.terminals == stamps[k] => r.lines.clone(),
            _ => rest.iter().map(|end| elbow(root, end, clearance)).collect(),
        };
        let mut parts = finish(&lines, context.radius);
        // A part reaching another output ends there without an arrowhead.
        let outputs = &rest[..(ask.outputs - 1).min(rest.len())];
        for part in &mut parts {
            if let Some(&end) = part.last()
                && outputs.iter().any(|o| o.at == end)
            {
                part.push(end);
            }
        }
        out[ask.mark][ask.row] = parts;
    }
}

/// Where an edge mark's rows meet vertices: the references naming each row's two ends, with the
/// first vertex of the table each names; or, for nets, every port reference naming its rows.
struct Joins<'a> {
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
    fn new(marks: &[VertexMark<'a>], codes: &[Vec<u32>], em: &EdgeMark<'a>) -> Joins<'a> {
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
    fn ends(&self, row: usize) -> Option<[usize; 2]> {
        let [(a, first_a), (b, first_b)] = self.ends?;
        Some([first_a + a.target(row)? as usize, first_b + b.target(row)? as usize])
    }

    /// Net row `row`'s terminals: each vertex naming it at a port, the port's code, and whether it is
    /// an output.
    fn terminals(&self, marks: &[VertexMark<'_>], row: usize) -> Vec<(usize, u32, bool)> {
        let mut terminals = Vec::new();
        for naming in &self.ports {
            let first = marks[naming.mark].first;
            terminals.extend(naming.inverse.of(row).iter().map(|&v| (first + v as usize, naming.code, naming.output)));
        }
        terminals
    }
}

/// Each port's code on a vertex mark's rows.
fn port_codes(mark: &Vertices) -> Vec<u32> {
    Port::codes(&mark.ports.iter().map(|(_, port)| port).collect::<Vec<_>>())
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

/// An end leaving by a side: where its other end lies along the side, its edge, and which end.
type Leaving = (f64, usize, usize);

/// Gives each orthogonal edge its ends: on the sides of its vertices facing each other, spread along
/// each side by where the other ends lie, so wires leave a side without crossing.
fn face(asks: &mut [Ask], edges: &[(usize, [usize; 2])], vertices: &[Vertex]) {
    let bounds = |v: usize| vertices[v].bounds.unwrap_or(EMPTY);
    // Each vertex's side: the ends leaving by it, each where its other end lies along the side, the
    // edge, and which end.
    let mut sides: FxHashMap<(usize, Side), Vec<Leaving>> = FxHashMap::default();
    for (k, &(_, [a, b])) in edges.iter().enumerate() {
        let (ba, bb) = (bounds(a), bounds(b));
        let (side_a, side_b) = facing(ba, bb);
        let along = |side: Side, other: Rect| match side {
            Side::Left | Side::Right => center(other)[1],
            Side::Top | Side::Bottom => center(other)[0],
        };
        sides.entry((a, side_a)).or_default().push((along(side_a, bb), k, 0));
        sides.entry((b, side_b)).or_default().push((along(side_b, ba), k, 1));
    }
    let mut ends: Vec<[Option<End>; 2]> = vec![[None; 2]; edges.len()];
    for ((v, side), mut placed) in sides {
        placed.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
        let count = (placed.len() as u32).min(255);
        for (place, (_, k, end)) in placed.into_iter().enumerate() {
            let code = side.code() | ((place as u32).min(255) << 2) | (count << 10);
            ends[k][end] = Some(End { at: port_point(bounds(v), code), side: Some(side), vertex: v });
        }
    }
    for (k, &(ask, _)) in edges.iter().enumerate() {
        asks[ask].ends = ends[k].iter().flatten().copied().collect();
    }
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

/// The blocks wires route around, y up, and the obstacle of each vertex that is one. Groups hold
/// wires rather than turn them away.
fn obstacles(vertices: &[Vertex]) -> (Vec<Rect>, Vec<Option<u32>>) {
    let mut boxes = Vec::new();
    let owners = vertices
        .iter()
        .map(|v| {
            let b = v.bounds.filter(|_| !v.group)?;
            boxes.push([b[0], -b[3], b[2], -b[1]]);
            Some(boxes.len() as u32 - 1)
        })
        .collect();
    (boxes, owners)
}

/// The groups wires route among, y up: they cross a group's border at a cost, and keep off it.
fn groups(vertices: &[Vertex]) -> Vec<Rect> {
    vertices.iter().filter(|v| v.group).filter_map(|v| v.bounds).map(|b| [b[0], -b[3], b[2], -b[1]]).collect()
}

/// The net routing `ask`, y up.
fn net(ask: &Ask, owners: &[Option<u32>]) -> Net {
    let terminal = |end: &End| Terminal { at: [end.at[0], -end.at[1]], side: end.side, owner: owners[end.vertex] };
    Net { terminals: ask.ends.iter().map(terminal).collect() }
}

/// The routes of the wires near those about to route, which keep their tracks, y up: within `reach`
/// of the ends of the wires `routed`.
fn fixed(asks: &[Ask], routed: &[usize], routes: &FxHashMap<Row, Routed>, reach: f64) -> Parts {
    let region = routed.iter().flat_map(|&k| &asks[k].ends).fold(EMPTY, |region, end| union(region, dot(end.at)));
    let region = grow(region, reach);
    let routing: FxHashSet<&Row> = routed.iter().map(|&k| &asks[k].key).collect();
    asks.iter()
        .filter(|ask| !routing.contains(&ask.key))
        .filter_map(|ask| routes.get(&ask.key))
        .filter(|r| meets(&r.reach, &region))
        .flat_map(|r| flipped(&r.lines))
        .collect()
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
/// it out to inputs. Parts into the middle end doubled there, a junction without an arrowhead.
fn star(ends: &[End], outputs: usize) -> Parts {
    if let [a, b] = ends {
        let mut part = vec![a.at, b.at];
        if outputs > 1 {
            part.push(b.at);
        }
        return vec![part];
    }
    let n = ends.len() as f64;
    let middle = [ends.iter().map(|e| e.at[0]).sum::<f64>() / n, ends.iter().map(|e| e.at[1]).sum::<f64>() / n];
    let part = |(k, end): (usize, &End)| if k < outputs { vec![end.at, middle, middle] } else { vec![middle, end.at] };
    ends.iter().enumerate().map(part).collect()
}

/// The points of row `row`'s path field `field`, y down.
fn bends(table: &Table, field: &str, row: usize) -> Vec<Point> {
    match table.value(row, field, f64::INFINITY) {
        Some(Value::Path(points)) => points.into_iter().filter(|p| p.iter().all(|v| v.is_finite())).collect(),
        _ => Vec::new(),
    }
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

/// Lines with y up as y down, or back.
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

fn dot(p: Point) -> Rect {
    [p[0], p[1], p[0], p[1]]
}

fn union(a: Rect, b: Rect) -> Rect {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

fn grow(r: Rect, by: f64) -> Rect {
    [r[0] - by, r[1] - by, r[2] + by, r[3] + by]
}

fn meets(a: &Rect, b: &Rect) -> bool {
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(at: Point, side: Side) -> End {
        End { at, side: Some(side), vertex: 0 }
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
    fn nets_link_their_drivers_to_their_readers() {
        assert_eq!(net_links(&[(0, false), (1, true), (2, false)]), vec![[1, 0], [1, 2]]);
        assert_eq!(net_links(&[(4, false), (5, false)]), vec![[4, 5]], "without a driver, the first drives");
    }
}
