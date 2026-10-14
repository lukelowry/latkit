//! Layouts: the scene's layout places every vertex its data gives no position, writing each vertex
//! mark's places, which the position store reads and eases toward. The graph laid out is every
//! vertex row by slot, joined by edges' ends and nets' terminals, and held by groups; a net runs
//! from the ports on the side the flow leaves by to its others. Layered is a
//! host job over the vertices' sizes and pins, read back once each time the graph changes; stress
//! runs on the GPU, a few Jacobi rounds a frame over terms the CPU finds from pivots, starting where
//! a layout placed vertices before, then once they settle a host job parts their boxes.

use std::collections::VecDeque;
use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHasher};

use super::View;
use super::derived::{Derived, Landed, Work};
use super::passes::dispatch;
use super::resources::EyeSlot;
use crate::data::{Field, Table};
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::host::{Job, centers};
use crate::layout::layered::Ranked;
use crate::layout::pack::pack;
use crate::scene::mark::MarkKind;
use crate::{Direction, Layout, Side, Value};

/// Jacobi rounds stress runs in all, and at most per frame.
const ROUNDS: u32 = 240;
const ROUNDS_PER_FRAME: u32 = 16;
/// Pivots stress measures graph distances from, and the distances it keeps in all.
const PIVOTS: usize = 32;
const DISTANCES: usize = 8_000_000;
/// Words before a stress graph's vertex records.
const HEADER: usize = 4;
/// The share of a stress layout's gap its vertices' boxes keep clear of each other.
const CLEARANCE: f64 = 0.25;

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

/// The layout's places: what they were laid out from, the readback and job under way and the graph
/// they place, the stress rounds left, and whether its boxes are still to part.
#[derive(Default)]
pub(crate) struct Placing {
    places: Derived<()>,
    graph: Graph,
    /// Stress rounds left, whether they start from earlier places, and the vertices they move.
    rounds: u32,
    seeding: bool,
    vertices: u32,
    separating: bool,
}

impl Placing {
    pub(crate) fn busy(&self) -> bool {
        self.places.busy() || self.rounds > 0 || self.separating
    }
}

/// A vertex read back: its center and half size in position units.
#[derive(Clone, Copy)]
pub(super) struct Stand {
    pub(super) center: [f64; 2],
    pub(super) half: [f64; 2],
    pinned: bool,
}

/// The row a reference column names at `row`.
pub(super) fn named(table: &Table, field: &str, row: usize) -> Option<u32> {
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
            (shown.graph.topology(), shown.region.state, shown.region.places, &shown.ends).hash(&mut hasher);
        }
        hasher.finish().max(1)
    }

    /// Whether a layout is still placing vertices: one is due, under way, or easing them there.
    pub(super) fn laying_out(&self) -> bool {
        if matches!(self.scene.layout, Layout::None) {
            return false;
        }
        self.placing.busy() || self.placing.places.due(self.placing_stamp()) || self.vertices_moving()
    }

    /// Whether a vertex mark eases or is about to.
    pub(super) fn vertices_moving(&self) -> bool {
        self.marks.iter().any(|m| m.kind() == MarkKind::Vertices && (m.transition.is_some() || m.begin.is_some()))
    }

    /// Lays the graph out again when it changed, records this frame's stress rounds, and routes
    /// again when what routes read changed.
    pub(super) fn place(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let stamp = self.placing_stamp();
        if self.placing.places.due(stamp) {
            self.placing.rounds = 0;
            match self.scene.layout {
                Layout::None => self.placing.places.mark(stamp),
                Layout::Layered(layered) => match self.vertex_readback(encoder, inner) {
                    Some(readback) => {
                        self.placing.graph = self.layout_graph(true, Some(leaving(layered.flow)));
                        self.placing.places.start(stamp, Work::Read(readback));
                    }
                    None => self.placing.places.mark(stamp),
                },
                Layout::Stress(stress) => {
                    self.placing.places.mark(stamp);
                    self.start_stress(stress.gap);
                }
            }
        }
        if self.placing.rounds > 0 {
            self.relax(encoder, inner);
        } else if self.placing.separating && !self.vertices_moving() {
            // Stress settled and its vertices stand still: their boxes part.
            self.placing.separating = false;
            if let Some(readback) = self.vertex_readback(encoder, inner) {
                let stamp = self.placing.places.stamp();
                self.placing.places.start(stamp, Work::Read(readback));
            }
        }
        self.route_due(encoder, inner);
    }

    /// Every vertex row of every drawn vertex mark, by slot, and the links and groups between them;
    /// group marks' rows only `with_groups`. Nets run from their terminals on the side `leaving`.
    fn layout_graph(&self, with_groups: bool, leaving: Option<Side>) -> Graph {
        let mut graph = Graph::default();
        let mut index: FxHashMap<u32, u32> = FxHashMap::default();
        for (m, shown) in self.marks.iter().enumerate() {
            if shown.kind() != MarkKind::Vertices || !shown.drawable() || (!with_groups && shown.graph.depth() > 0) {
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
            // Nets join their drivers to their readers; groups hold their members.
            for (words, is_net) in [(shown.graph.terminals(), true), (shown.graph.members(), false)] {
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
                        let drives = |k: usize| {
                            let code = words[rows + 1 + wgsl::TERMINAL_WORDS as usize * k + 2];
                            leaving.is_some() && Side::from_code(code & 3) == leaving
                        };
                        let ends: Vec<(u32, bool)> =
                            (start..end).filter_map(|k| Some((entry(k)?, drives(k)))).collect();
                        graph.links.extend(net_links(&ends));
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

    /// A readback of every vertex slot's state.
    pub(super) fn vertex_readback(&self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) -> Option<Readback> {
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

    /// Where the vertex in slot `slot` stands in `words`, the vertices' state read back.
    pub(super) fn stand(&self, words: &[u32], slot: u32) -> Stand {
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

    /// Takes what landed of a layout's job: the vertices read back start it, sized and pinned by
    /// them, laying a layered graph out or parting a stress layout's boxes; its centers become the
    /// places.
    pub(super) fn settle_placing(&mut self) {
        let Some((stamp, landed)) = self.placing.places.landed() else { return };
        match landed {
            Landed::Read(bytes) => {
                let words: &[u32] = bytemuck::cast_slice(&bytes);
                let graph = &self.placing.graph;
                let stands: Vec<Stand> = graph.vertices.iter().map(|&(slot, _, _)| self.stand(words, slot)).collect();
                let job = match self.scene.layout {
                    Layout::Layered(options) => {
                        let sizes: Vec<[f64; 2]> = stands.iter().map(|s| s.half.map(|h| 2.0 * h)).collect();
                        let pinned: Vec<Option<[f64; 2]>> =
                            stands.iter().map(|s| s.pinned.then_some(s.center)).collect();
                        let edges = &graph.links;
                        Job::layered(&Ranked { sizes: &sizes, edges, pinned: &pinned, groups: &graph.groups }, &options)
                    }
                    Layout::Stress(stress) => {
                        let boxes: Vec<[f64; 4]> =
                            stands.iter().map(|s| [s.center[0], s.center[1], s.half[0], s.half[1]]).collect();
                        let pinned: Vec<bool> = stands.iter().map(|s| s.pinned).collect();
                        Job::overlaps(&boxes, &pinned, stress.gap * CLEARANCE)
                    }
                    Layout::None => return,
                };
                self.placing.places.start(stamp, Work::Job(self.gpu.spawn(job)));
                self.wake();
            }
            Landed::Job(answer) => {
                if let Some(centers) = centers(&answer).filter(|c| c.len() == self.placing.graph.vertices.len()) {
                    self.write_places(&centers);
                }
                self.placing.places.mark(stamp);
            }
        }
    }

    /// Writes each laid-out vertex's place, and eases its mark there.
    fn write_places(&mut self, centers: &[[f64; 2]]) {
        let mut per_mark: FxHashMap<usize, Vec<u32>> = FxHashMap::default();
        for (&(_, m, row), center) in self.placing.graph.vertices.iter().zip(centers) {
            let Some(shown) = self.marks.get(m) else { continue };
            let words = per_mark.entry(m).or_insert_with(|| vec![0; 2 * shown.rows as usize]);
            if let Some(place) = words.get_mut(2 * row as usize..2 * row as usize + 2) {
                place.copy_from_slice(&center.map(|v| place_word(v as f32)));
            }
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
        let graph = self.layout_graph(false, None);
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
        self.placing.separating = true;
        self.placing.graph = graph;
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
            if shown.kind() == MarkKind::Vertices && shown.graph.depth() == 0 {
                shown.place_dirty();
            }
        }
    }
}

/// A coordinate as a place word: zero as negative zero, so a place at the origin reads as placed.
fn place_word(v: f32) -> u32 {
    if v == 0.0 { (-0.0_f32).to_bits() } else { v.to_bits() }
}

/// The side a port faces when the flow leaves its vertex by it: an output's.
fn leaving(flow: Direction) -> Side {
    match flow {
        Direction::Right => Side::Right,
        Direction::Left => Side::Left,
        Direction::Down => Side::Bottom,
        Direction::Up => Side::Top,
    }
}

/// The links of a net whose terminals are `ends`, each a vertex and whether it drives the net: every
/// driver to its first reader, and its first driver to every reader, so a wide net adds as many links
/// as it has terminals. A net without both drivers and readers runs from its first terminal.
fn net_links(ends: &[(u32, bool)]) -> Vec<[u32; 2]> {
    let (mut drivers, mut readers) = (Vec::new(), Vec::new());
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
