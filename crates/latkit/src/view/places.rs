//! Layouts: the scene's layout places every vertex its data gives no position, writing each vertex
//! mark's places, which the position store reads and eases toward. The graph laid out is every
//! vertex row by slot, joined by edges' ends and nets' terminals, and held by groups. Layered runs on
//! the CPU from the vertices' sizes and pins, read back once each time the graph changes; stress runs
//! on the GPU, a few Jacobi rounds a frame over terms the CPU finds from pivots, starting where a
//! layout placed vertices before.

use std::collections::VecDeque;
use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHasher};

use super::View;
use super::passes::dispatch;
use super::resources::EyeSlot;
use crate::data::{Field, Table};
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::layout::layered::{Ranked, layered};
use crate::layout::pack::pack;
use crate::layout::route::{Net, Terminal, route};
use crate::scene::mark::MarkKind;
use crate::{Layout, Route, Side, Value};

/// Jacobi rounds stress runs in all, and at most per frame.
const ROUNDS: u32 = 240;
const ROUNDS_PER_FRAME: u32 = 16;
/// Pivots stress measures graph distances from, and the distances it keeps in all.
const PIVOTS: usize = 32;
const DISTANCES: usize = 8_000_000;
/// Words before a stress graph's vertex records.
const HEADER: usize = 4;

/// The graph a layout places.
#[derive(Default)]
struct Graph {
    /// Each vertex's slot, mark, and row.
    vertices: Vec<(u32, usize, u32)>,
    /// Links from one vertex to another, by index.
    links: Vec<[u32; 2]>,
    /// The group holding each vertex, by index.
    groups: Vec<Option<u32>>,
}

/// A layout in progress.
#[derive(Default)]
pub(crate) struct Placing {
    /// What the places were last laid out from.
    stamp: u64,
    /// The vertices' state read back for a layered layout of the graph.
    reading: Option<(Graph, Readback)>,
    /// Stress rounds left, whether they start from earlier places, and the vertices they move.
    rounds: u32,
    seeding: bool,
    vertices: u32,
}

impl Placing {
    pub(crate) fn busy(&self) -> bool {
        self.reading.is_some() || self.rounds > 0
    }
}

/// Orthogonal routes of edge marks: worked out on the CPU from where the vertices stand, read back
/// once they settle after moving or resizing.
#[derive(Default)]
pub(crate) struct Routing {
    /// What the routes were last worked out from.
    stamp: u64,
    reading: Option<(u64, Readback)>,
    /// Each routed mark's path words, and a count of their changes.
    pub(crate) paths: FxHashMap<usize, Vec<u32>>,
    pub(crate) version: u64,
}

impl Routing {
    pub(crate) fn busy(&self) -> bool {
        self.reading.is_some()
    }
}

/// A routed mark, and the net routing each of its rows.
type Routed = (usize, Vec<Option<usize>>);

/// A vertex read back: its center and half size in position units.
#[derive(Clone, Copy)]
struct Stand {
    center: [f64; 2],
    half: [f64; 2],
    pinned: bool,
}

/// The row a reference column names at `row`.
fn named(table: &Table, field: &str, row: usize) -> Option<u32> {
    match table.field_named(field) {
        Some(Field::Reference(r)) => match r.rows.get(row) {
            Some(Value::Number(n)) => Some(n as u32),
            _ => None,
        },
        _ => None,
    }
}

impl View {
    /// What a layout reads: its options and every mark's rows, slots, ends, and topology.
    fn placing_stamp(&self) -> u64 {
        let mut hasher = FxHasher::default();
        match self.scene.layout {
            Layout::None => return 0,
            Layout::Stress(stress) => (1_u8, stress.gap.to_bits()).hash(&mut hasher),
            Layout::Layered(l) => (2_u8, l.flow as u8, l.gap.to_bits(), l.rank_gap.to_bits()).hash(&mut hasher),
        }
        for shown in &self.marks {
            (std::mem::discriminant(&shown.kind()), shown.drawable(), shown.rows).hash(&mut hasher);
            (shown.graph.stamp, shown.region.state, shown.region.places, &shown.ends).hash(&mut hasher);
        }
        hasher.finish().max(1)
    }

    /// Whether a layout is still placing vertices: one is due, under way, or easing them there.
    pub(super) fn laying_out(&self) -> bool {
        if matches!(self.scene.layout, Layout::None) {
            return false;
        }
        self.placing.busy()
            || self.placing_stamp() != self.placing.stamp
            || self
                .marks
                .iter()
                .any(|m| m.kind() == MarkKind::Vertices && (m.transition.is_some() || m.begin.is_some()))
    }

    /// Lays the graph out again when it changed, and records this frame's stress rounds.
    pub(super) fn place(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let stamp = self.placing_stamp();
        if stamp != self.placing.stamp {
            self.placing = super::places::Placing { stamp, ..Default::default() };
            match self.scene.layout {
                Layout::None => {}
                Layout::Layered(_) => self.read_vertices(encoder, inner),
                Layout::Stress(stress) => self.start_stress(stress.gap),
            }
        }
        if self.placing.rounds > 0 {
            self.relax(encoder, inner);
        }
        self.route_due(encoder, inner);
    }

    /// Every vertex row of every drawn vertex mark, by slot, and the links and groups between them;
    /// group marks' rows only `with_groups`.
    fn layout_graph(&self, with_groups: bool) -> Graph {
        let mut graph = Graph::default();
        let mut index: FxHashMap<u32, u32> = FxHashMap::default();
        for (m, shown) in self.marks.iter().enumerate() {
            if shown.kind() != MarkKind::Vertices || !shown.drawable() || (!with_groups && shown.graph.depth > 0) {
                continue;
            }
            let base = shown.region.state / wgsl::VERTEX_WORDS;
            for row in 0..shown.rows {
                index.insert(base + row, graph.vertices.len() as u32);
                graph.vertices.push((base + row, m, row));
            }
        }
        let vertex = |ends: &[u32], end: u32, row: u32| {
            let base = *ends.get(end as usize)?;
            if base == wgsl::NONE { None } else { index.get(&(base + row)).copied() }
        };
        graph.groups = vec![None; graph.vertices.len()];
        for shown in &self.marks {
            if !shown.drawable() {
                continue;
            }
            let style = shown.mark.style();
            if let crate::Mark::Edges(edges) = &shown.mark
                && let Some((from, to)) = &edges.ends
                && let Some(table) = self.data(&style.data).and_then(|d| d.table(&style.table))
            {
                for row in 0..table.len() {
                    let ends = (named(table, from, row), named(table, to, row));
                    if let (Some(a), Some(b)) = ends
                        && let (Some(a), Some(b)) = (vertex(&shown.ends, 0, a), vertex(&shown.ends, 1, b))
                    {
                        graph.links.push([a, b]);
                    }
                }
            }
            // Nets join their first terminal to the rest; groups hold their members.
            for (words, is_net) in [(&shown.graph.terminals, true), (&shown.graph.members, false)] {
                let rows = shown.rows as usize;
                if words.len() <= rows {
                    continue;
                }
                let base = shown.region.state / wgsl::VERTEX_WORDS;
                for row in 0..rows {
                    let (start, end) = (words[row] as usize, words[row + 1] as usize);
                    let entry = |k: usize| {
                        let at = rows + 1 + wgsl::TERMINAL_WORDS as usize * k;
                        vertex(&shown.ends, words[at], words[at + 1])
                    };
                    if is_net {
                        let first = (start..end).find_map(entry);
                        for k in start..end {
                            if let (Some(a), Some(b)) = (first, entry(k))
                                && a != b
                            {
                                graph.links.push([a, b]);
                            }
                        }
                    } else if let Some(&group) = index.get(&(base + row as u32)) {
                        for k in start..end {
                            if let Some(member) = entry(k) {
                                graph.groups[member as usize] = Some(group);
                            }
                        }
                    }
                }
            }
        }
        graph
    }

    /// Reads back the vertices' state, for a layered layout to size and pin them by.
    fn read_vertices(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) {
        let graph = self.layout_graph(true);
        if let Some(readback) = self.vertex_readback(encoder, inner) {
            self.placing.reading = Some((graph, readback));
        }
    }

    /// A readback of every vertex slot's state.
    fn vertex_readback(&self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) -> Option<Readback> {
        let slots = self
            .marks
            .iter()
            .filter(|m| m.kind() == MarkKind::Vertices && m.drawable())
            .map(|m| m.region.state / wgsl::VERTEX_WORDS + m.rows)
            .max()?;
        let resources = self.resources.as_ref()?;
        let bytes = u64::from(slots.max(1)) * u64::from(wgsl::VERTEX_WORDS) * 4;
        Some(Readback::new(&inner.readbacks, &self.gpu.0.device, encoder, resources.state(), 0, bytes))
    }

    /// The edge marks routed orthogonally.
    fn routed(&self) -> Vec<usize> {
        (0..self.marks.len())
            .filter(|&i| {
                self.marks[i].drawable()
                    && matches!(&self.marks[i].mark, crate::Mark::Edges(e) if e.route == Some(Route::Orthogonal))
            })
            .collect()
    }

    /// What routes read: where vertices stand and how large they are, the routed marks' rows and
    /// ends, and the spacing.
    fn routing_stamp(&self, routed: &[usize]) -> u64 {
        if routed.is_empty() {
            return 0;
        }
        let mut hasher = FxHasher::default();
        (self.px_per_unit.to_bits(), self.scene.theme.edge_spacing.to_bits()).hash(&mut hasher);
        for shown in self.marks.iter().filter(|m| m.kind() == MarkKind::Vertices) {
            (shown.shape_version, shown.region.state, shown.rows, shown.drawable()).hash(&mut hasher);
            // Groups fold and unfold without moving.
            if shown.graph.depth > 0 {
                (shown.version, shown.graph.stamp).hash(&mut hasher);
            }
        }
        for &i in routed {
            let shown = &self.marks[i];
            (i, shown.rows, &shown.ends, shown.graph.terminals.len()).hash(&mut hasher);
            let style = shown.mark.style();
            self.data(&style.data).and_then(|d| d.table(&style.table)).map(|t| t.structure).hash(&mut hasher);
        }
        hasher.finish().max(1)
    }

    /// Reads the vertices back to route again once what routes read changed and nothing moves.
    fn route_due(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) {
        let routed = self.routed();
        let stamp = self.routing_stamp(&routed);
        if routed.is_empty() && !self.routing.paths.is_empty() {
            self.routing.paths.clear();
            self.routing.version += 1;
        }
        let moving = self.placing.busy()
            || self
                .marks
                .iter()
                .any(|m| m.kind() == MarkKind::Vertices && (m.transition.is_some() || m.begin.is_some()));
        if stamp == self.routing.stamp || self.routing.reading.is_some() || moving {
            return;
        }
        match self.vertex_readback(encoder, inner) {
            Some(readback) => self.routing.reading = Some((stamp, readback)),
            None => self.routing.stamp = stamp,
        }
    }

    /// Routes every routed mark's rows once the vertices are read back, around every vertex.
    pub(super) fn settle_routing(&mut self) {
        let Some((_, readback)) = &self.routing.reading else { return };
        let Some(bytes) = readback.take() else { return };
        let (stamp, _) = self.routing.reading.take().expect("reading");
        self.routing.stamp = stamp;
        let Ok(bytes) = bytes else { return };
        let words: &[u32] = bytemuck::cast_slice(&bytes);
        // Wires route around every vertex that shows: rows, and groups folded over their members.
        let standing = self.stand_ins(words);
        let mut slots: FxHashMap<u32, (u32, Stand)> = FxHashMap::default();
        let mut obstacles = Vec::new();
        for shown in &self.marks {
            if shown.kind() != MarkKind::Vertices || !shown.drawable() {
                continue;
            }
            let base = shown.region.state / wgsl::VERTEX_WORDS;
            for slot in base..base + shown.rows {
                let flags = words.get((slot * wgsl::VERTEX_WORDS + wgsl::VERTEX_FLAGS) as usize).copied().unwrap_or(0);
                let open = shown.graph.depth > 0 && flags & wgsl::COLLAPSED == 0;
                if open || standing.contains_key(&slot) {
                    continue;
                }
                let stand = self.stand(words, slot);
                let [x, y] = stand.center;
                let [w, h] = stand.half;
                slots.insert(slot, (obstacles.len() as u32, stand));
                obstacles.push([x - w, y - h, x + w, y + h]);
            }
        }
        let spacing = f64::from(self.scene.theme.edge_spacing) * 2.0 / f64::from(self.px_per_unit.max(1e-9));
        let (marks, nets) = self.routed_nets(&slots, &standing);
        let routes = route(&obstacles, &nets, spacing);
        self.routing.paths.clear();
        for (i, row_nets) in marks {
            // An edge runs from its vertices' middles, through its route, stopping at their outlines.
            let ended = matches!(&self.marks[i].mark, crate::Mark::Edges(e) if e.ends.is_some());
            self.routing.paths.insert(i, route_words(&row_nets, &routes, ended));
        }
        self.routing.version += 1;
        self.wake();
    }

    /// The nets to route, one per row of each routed mark: an edge's two ends, each at the middle of
    /// its side facing the other; a net's terminals at their ports. Each routed mark comes with its
    /// rows' nets.
    fn routed_nets(
        &self,
        slots: &FxHashMap<u32, (u32, Stand)>,
        standing: &FxHashMap<u32, u32>,
    ) -> (Vec<Routed>, Vec<Net>) {
        let groups: rustc_hash::FxHashSet<u32> = standing.values().copied().collect();
        let mut marks: Vec<Routed> = Vec::new();
        let mut nets: Vec<Net> = Vec::new();
        for i in self.routed() {
            let shown = &self.marks[i];
            let mut row_nets = vec![None; shown.rows as usize];
            // A vertex inside a folded group meets wires at the group.
            let slot = |end: u32, row: u32| {
                let s = shown.ends.get(end as usize).filter(|&&b| b != wgsl::NONE).map(|b| b + row)?;
                Some(standing.get(&s).copied().unwrap_or(s))
            };
            let style = shown.mark.style();
            let table = self.data(&style.data).and_then(|d| d.table(&style.table));
            if let (crate::Mark::Edges(edges), Some(table)) = (&shown.mark, table)
                && let Some((from, to)) = &edges.ends
            {
                for (row, net) in row_nets.iter_mut().enumerate().take(table.len()) {
                    let ends = (named(table, from, row), named(table, to, row));
                    let (Some(a), Some(b)) = ends else { continue };
                    if slot(0, a) == slot(1, b) {
                        continue;
                    }
                    let (Some(&(oa, sa)), Some(&(ob, sb))) =
                        (slot(0, a).and_then(|s| slots.get(&s)), slot(1, b).and_then(|s| slots.get(&s)))
                    else {
                        continue;
                    };
                    *net = Some(nets.len());
                    nets.push(Net {
                        terminals: vec![meet(&sa, oa, facing(&sa, sb.center)), meet(&sb, ob, facing(&sb, sa.center))],
                    });
                }
            }
            let words = &shown.graph.terminals;
            let rows = shown.rows as usize;
            if words.len() > rows {
                for (row, net) in row_nets.iter_mut().enumerate() {
                    let mut met: Vec<u32> = Vec::new();
                    let terminals: Vec<Terminal> = (words[row] as usize..words[row + 1] as usize)
                        .filter_map(|k| {
                            let at = rows + 1 + wgsl::TERMINAL_WORDS as usize * k;
                            let s = slot(words[at], words[at + 1])?;
                            let &(owner, stand) = slots.get(&s)?;
                            // Terminals folded into one group meet it once, at its middle.
                            if met.contains(&s) {
                                return None;
                            }
                            met.push(s);
                            let folded = groups.contains(&s);
                            let place = if folded { facing(&stand, stand.center) } else { port_place(words[at + 2]) };
                            Some(meet(&stand, owner, place))
                        })
                        .collect();
                    if terminals.len() > 1 {
                        *net = Some(nets.len());
                        nets.push(Net { terminals });
                    }
                }
            }
            marks.push((i, row_nets));
        }
        (marks, nets)
    }

    /// The folded group standing in for each vertex slot inside one, from the vertices' state read
    /// back: the outermost folded group holding it.
    fn stand_ins(&self, words: &[u32]) -> FxHashMap<u32, u32> {
        let mut parent: FxHashMap<u32, (u32, bool)> = FxHashMap::default();
        for shown in self.marks.iter().filter(|m| m.drawable() && m.graph.depth > 0) {
            let members = &shown.graph.members;
            let rows = shown.rows as usize;
            if members.len() <= rows {
                continue;
            }
            let base = shown.region.state / wgsl::VERTEX_WORDS;
            for row in 0..rows {
                let group = base + row as u32;
                let flags = words.get((group * wgsl::VERTEX_WORDS + wgsl::VERTEX_FLAGS) as usize).copied().unwrap_or(0);
                for k in members[row] as usize..members[row + 1] as usize {
                    let at = rows + 1 + wgsl::TERMINAL_WORDS as usize * k;
                    if let Some(&first) = shown.ends.get(members[at] as usize).filter(|&&b| b != wgsl::NONE) {
                        parent.insert(first + members[at + 1], (group, flags & wgsl::COLLAPSED != 0));
                    }
                }
            }
        }
        let mut standing = FxHashMap::default();
        for &member in parent.keys() {
            let (mut at, mut stands) = (member, member);
            for _ in 0..wgsl::GROUP_DEPTH {
                let Some(&(group, folded)) = parent.get(&at) else { break };
                if folded {
                    stands = group;
                }
                at = group;
            }
            if stands != member {
                standing.insert(member, stands);
            }
        }
        standing
    }

    /// Where the vertex in slot `slot` stands in `words`, the vertices' state read back.
    fn stand(&self, words: &[u32], slot: u32) -> Stand {
        let at = (slot * wgsl::VERTEX_WORDS) as usize;
        let float = |i: usize| words.get(at + i).map_or(0.0, |&w| f64::from(f32::from_bits(w)));
        let flags = words.get(at + wgsl::VERTEX_FLAGS as usize).copied().unwrap_or(0);
        let scale = if flags & wgsl::HALF_UNITS != 0 { 1.0 } else { 1.0 / f64::from(self.px_per_unit.max(1e-9)) };
        let (half, position) = (wgsl::VERTEX_HALF as usize, wgsl::VERTEX_POSITION as usize);
        let height = if flags & wgsl::OWN_HEIGHT != 0 { float(half + 1) } else { float(half) };
        Stand {
            center: [float(position) + float(position + 2), float(position + 1) + float(position + 3)],
            half: [float(half) * scale, height * scale],
            pinned: flags & wgsl::PINNED != 0,
        }
    }

    /// Lays the graph out in ranks once the vertices' state is read back, and eases them there.
    pub(super) fn settle_placing(&mut self) {
        let Some((_, readback)) = &self.placing.reading else { return };
        let Some(bytes) = readback.take() else { return };
        let (graph, _) = self.placing.reading.take().expect("reading");
        let (Ok(bytes), Layout::Layered(options)) = (bytes, self.scene.layout) else { return };
        let words: &[u32] = bytemuck::cast_slice(&bytes);
        let stands: Vec<Stand> = graph.vertices.iter().map(|&(slot, _, _)| self.stand(words, slot)).collect();
        let sizes: Vec<[f64; 2]> = stands.iter().map(|s| s.half.map(|h| 2.0 * h)).collect();
        let pinned: Vec<Option<[f64; 2]>> = stands.iter().map(|s| s.pinned.then_some(s.center)).collect();
        let ranked = Ranked { sizes: &sizes, edges: &graph.links, pinned: &pinned, groups: &graph.groups };
        let centers = layered(&ranked, &options);
        self.write_places(&graph, &centers);
    }

    /// Writes each laid-out vertex's place, and eases its mark there.
    fn write_places(&mut self, graph: &Graph, centers: &[[f64; 2]]) {
        let mut per_mark: FxHashMap<usize, Vec<u32>> = FxHashMap::default();
        for (&(_, m, row), center) in graph.vertices.iter().zip(centers) {
            let words = per_mark.entry(m).or_insert_with(|| vec![0; 2 * self.marks[m].rows as usize]);
            words[2 * row as usize] = place_word(center[0] as f32);
            words[2 * row as usize + 1] = place_word(center[1] as f32);
        }
        let Some(resources) = &self.resources else { return };
        for (m, words) in per_mark {
            let shown = &mut self.marks[m];
            if shown.region.places == wgsl::NONE {
                continue;
            }
            self.gpu.0.queue.write_buffer(
                resources.places(),
                u64::from(shown.region.places) * 4,
                bytemuck::cast_slice(&words),
            );
            shown.begin(None);
            shown.place_dirty();
        }
        self.wake();
    }

    /// Writes the stress graph's terms and starting positions and starts its rounds.
    fn start_stress(&mut self, gap: f64) {
        let graph = self.layout_graph(false);
        if graph.vertices.is_empty() {
            return;
        }
        let places: Vec<u32> =
            graph.vertices.iter().map(|&(_, m, row)| self.marks[m].region.places.saturating_add(2 * row)).collect();
        let words = stress_words(&graph, gap, &places);
        let gpu = self.gpu.clone();
        let Some(resources) = self.resources.as_mut() else { return };
        resources.fit_layout(&gpu.0.device, words.len() as u64);
        gpu.0.queue.write_buffer(resources.layout(), 0, bytemuck::cast_slice(&words));
        self.placing.rounds = ROUNDS;
        self.placing.seeding = true;
        self.placing.vertices = graph.vertices.len() as u32;
    }

    /// Records this frame's stress rounds and writes where they moved the vertices to their places.
    fn relax(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let Some(resources) = self.resources.as_mut() else { return };
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, Shader::Stress);
        let n = self.placing.vertices;
        let rounds = self.placing.rounds.min(ROUNDS_PER_FRAME) / 2;
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit stress"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            pass.set_bind_group(1, &groups.mark, &[0]);
            pass.set_bind_group(2, &group, &[]);
            if std::mem::take(&mut self.placing.seeding) {
                pass.set_pipeline(&inner.pipelines.compute(device, Shader::Stress, "seed"));
                dispatch(&mut pass, n);
            }
            let forward = inner.pipelines.compute(device, Shader::Stress, "forward");
            let backward = inner.pipelines.compute(device, Shader::Stress, "backward");
            for _ in 0..rounds {
                pass.set_pipeline(&forward);
                dispatch(&mut pass, n);
                pass.set_pipeline(&backward);
                dispatch(&mut pass, n);
            }
            pass.set_pipeline(&inner.pipelines.compute(device, Shader::Stress, "settle"));
            dispatch(&mut pass, n);
        }
        self.placing.rounds = self.placing.rounds.saturating_sub(2 * rounds.max(1));
        for shown in &mut self.marks {
            if shown.kind() == MarkKind::Vertices && shown.graph.depth == 0 {
                shown.place_dirty();
            }
        }
    }
}

/// The side of `stand` facing `other`, as a port's side, place, and count: the middle of it.
fn facing(stand: &Stand, other: [f64; 2]) -> (Side, u32, u32) {
    let [dx, dy] = [other[0] - stand.center[0], other[1] - stand.center[1]];
    let side = if dx.abs() >= dy.abs() {
        if dx >= 0.0 { Side::Right } else { Side::Left }
    } else if dy >= 0.0 {
        Side::Top
    } else {
        Side::Bottom
    };
    (side, 0, 1)
}

/// A port code's side, place on it, and how many share it.
fn port_place(code: u32) -> (Side, u32, u32) {
    let side = match code & 3 {
        0 => Side::Left,
        1 => Side::Right,
        2 => Side::Top,
        _ => Side::Bottom,
    };
    (side, (code >> 2) & 255, (code >> 10) & 255)
}

/// Where a wire meets `stand`, the obstacle `owner`: at a place on one of its sides, y up.
fn meet(stand: &Stand, owner: u32, (side, place, count): (Side, u32, u32)) -> Terminal {
    let along = (f64::from(place) + 1.0) / (f64::from(count) + 1.0) * 2.0 - 1.0;
    let [x, y] = stand.center;
    let [w, h] = stand.half;
    let at = match side {
        Side::Left => [x - w, y - along * h],
        Side::Right => [x + w, y - along * h],
        Side::Top => [x + along * w, y + h],
        Side::Bottom => [x + along * w, y - h],
    };
    Terminal { at, side: Some(side), owner: Some(owner) }
}

/// Path words of each row's route (see `graph::bend_words`): its polylines, broken by a missing
/// point; without their first and last points, which lie on the outlines, when `ended`.
fn route_words(row_nets: &[Option<usize>], routes: &[Vec<Vec<[f64; 2]>>], ended: bool) -> Vec<u32> {
    let mut words = Vec::with_capacity(row_nets.len() + 1);
    let mut points: Vec<[f32; 2]> = Vec::new();
    for net in row_nets {
        words.push(points.len() as u32);
        for (k, polyline) in net.map_or(&[][..], |n| &routes[n][..]).iter().enumerate() {
            if k > 0 {
                points.push([f32::NAN; 2]);
            }
            let inner = if ended && polyline.len() > 2 { &polyline[1..polyline.len() - 1] } else { &polyline[..] };
            points.extend(inner.iter().map(|p| p.map(|v| v as f32)));
        }
    }
    words.push(points.len() as u32);
    words.extend(points.iter().flat_map(|p| p.map(f32::to_bits)));
    words
}

/// A coordinate as a place word: zero as negative zero, so a place at the origin reads as placed.
fn place_word(v: f32) -> u32 {
    if v == 0.0 { (-0.0_f32).to_bits() } else { v.to_bits() }
}

/// Each vertex's neighbors, once each.
fn neighbors(n: usize, links: &[[u32; 2]]) -> (Vec<u32>, Vec<u32>) {
    let mut pairs: Vec<(u32, u32)> =
        links.iter().filter(|[a, b]| a != b).flat_map(|&[a, b]| [(a, b), (b, a)]).collect();
    pairs.sort_unstable();
    pairs.dedup();
    let mut offsets = vec![0_u32; n + 1];
    for &(a, _) in &pairs {
        offsets[a as usize + 1] += 1;
    }
    for i in 0..n {
        offsets[i + 1] += offsets[i];
    }
    (offsets, pairs.into_iter().map(|(_, b)| b).collect())
}

/// Hops from `from` to every vertex; `u32::MAX` where none lead.
fn hops(from: usize, offsets: &[u32], targets: &[u32]) -> Vec<u32> {
    let mut distance = vec![u32::MAX; offsets.len() - 1];
    let mut queue = VecDeque::from([from]);
    distance[from] = 0;
    while let Some(v) = queue.pop_front() {
        for &w in &targets[offsets[v] as usize..offsets[v + 1] as usize] {
            if distance[w as usize] == u32::MAX {
                distance[w as usize] = distance[v] + 1;
                queue.push_back(w as usize);
            }
        }
    }
    distance
}

/// The stress graph's words (see `compute/stress.wesl`): each vertex's terms are its neighbors one
/// `gap` away, weighted by the inverse square, and pivots at their graph distance, weighted by the
/// vertices nearer the pivot than half that distance. Vertices start around their part's most linked
/// vertex, by hops from it, and parts pack apart.
fn stress_words(graph: &Graph, gap: f64, places: &[u32]) -> Vec<u32> {
    let n = graph.vertices.len();
    let (offsets, targets) = neighbors(n, &graph.links);
    let degree = |v: usize| offsets[v + 1] - offsets[v];
    // Pivots far from each other: each the vertex farthest from those before, other parts first.
    let count = PIVOTS.min(n).min((DISTANCES / n.max(1)).max(2));
    let mut pivots: Vec<(usize, Vec<u32>)> = Vec::with_capacity(count);
    let mut nearest = vec![u32::MAX; n];
    let mut next = (0..n).max_by_key(|&v| degree(v)).unwrap_or(0);
    while pivots.len() < count {
        let distance = hops(next, &offsets, &targets);
        for (near, &d) in nearest.iter_mut().zip(&distance) {
            *near = (*near).min(d);
        }
        pivots.push((next, distance));
        let Some(far) = (0..n).max_by_key(|&v| (nearest[v], degree(v))) else { break };
        if nearest[far] == 0 {
            break;
        }
        next = far;
    }
    // Each pivot's region, as the sorted distances of the vertices nearest it.
    let mut regions: Vec<Vec<u32>> = vec![Vec::new(); pivots.len()];
    for v in 0..n {
        if let Some((p, d)) = pivots
            .iter()
            .enumerate()
            .map(|(p, (_, d))| (p, d[v]))
            .filter(|&(_, d)| d != u32::MAX)
            .min_by_key(|&(_, d)| d)
        {
            regions[p].push(d);
        }
    }
    for region in &mut regions {
        region.sort_unstable();
    }
    let mut records = Vec::with_capacity(4 * n);
    let mut terms: Vec<u32> = Vec::new();
    for v in 0..n {
        let first = terms.len() / 3;
        let near = &targets[offsets[v] as usize..offsets[v + 1] as usize];
        let weight = (1.0 / (gap * gap)) as f32;
        for &w in near {
            terms.extend([w, (gap as f32).to_bits(), weight.to_bits()]);
        }
        for (p, (pivot, distance)) in pivots.iter().enumerate() {
            let d = distance[v];
            if *pivot == v || d == u32::MAX || d <= 1 {
                continue;
            }
            let held = regions[p].partition_point(|&r| 2 * r <= d).max(1) as f64;
            let apart = gap * f64::from(d);
            terms.extend([*pivot as u32, (apart as f32).to_bits(), ((held / (apart * apart)) as f32).to_bits()]);
        }
        records.extend([graph.vertices[v].0, places[v], first as u32, (terms.len() / 3 - first) as u32]);
    }
    let start = start_positions(n, gap, &offsets, &targets);
    let terms_at = HEADER + records.len();
    let positions = terms_at + terms.len();
    let mut words = Vec::with_capacity(positions + 4 * n);
    words.extend([n as u32, terms_at as u32, positions as u32, (positions + 2 * n) as u32]);
    words.extend(records);
    words.extend(terms);
    for _ in 0..2 {
        words.extend(start.iter().flat_map(|p| p.map(|v| (v as f32).to_bits())));
    }
    words
}

/// Where stress starts each vertex: around its part's most linked vertex, a gap per hop from it on
/// a golden-angle spiral, with the parts packed apart.
fn start_positions(n: usize, gap: f64, offsets: &[u32], targets: &[u32]) -> Vec<[f64; 2]> {
    // One walk per part: each vertex is reached once, so every walk shares the distances.
    let mut distance = vec![u32::MAX; n];
    let mut local = vec![[0.0; 2]; n];
    let mut boxes = Vec::new();
    let mut parts: Vec<Vec<usize>> = Vec::new();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&v| std::cmp::Reverse(offsets[v + 1] - offsets[v]));
    for &root in &order {
        if distance[root] != u32::MAX {
            continue;
        }
        distance[root] = 0;
        let mut inside = vec![root];
        let mut k = 0;
        while k < inside.len() {
            let v = inside[k];
            k += 1;
            for &w in &targets[offsets[v] as usize..offsets[v + 1] as usize] {
                if distance[w as usize] == u32::MAX {
                    distance[w as usize] = distance[v] + 1;
                    inside.push(w as usize);
                }
            }
        }
        let mut reach: f64 = 0.0;
        for &v in &inside {
            let angle = v as f64 * 2.399_963_229_728_653;
            let radius = gap * f64::from(distance[v]) + gap * 0.1 * (v % 7) as f64;
            local[v] = [radius * angle.cos(), radius * angle.sin()];
            reach = reach.max(radius);
        }
        boxes.push([2.0 * reach + gap, 2.0 * reach + gap]);
        parts.push(inside);
    }
    let corners = pack(&boxes, gap, 16.0 / 9.0);
    let mut start = vec![[0.0; 2]; n];
    for (p, inside) in parts.iter().enumerate() {
        let center = [corners[p][0] + boxes[p][0] / 2.0, corners[p][1] - boxes[p][1] / 2.0];
        for &v in inside {
            start[v] = [center[0] + local[v][0], center[1] + local[v][1]];
        }
    }
    start
}
