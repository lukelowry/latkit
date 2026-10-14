//! Orthogonal routes of edge marks: worked out by a host job from where the vertices stand, read back
//! once they settle after moving or resizing. Wires route around every vertex that shows, groups
//! folded over their members included.

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHashSet, FxHasher};

use super::View;
use super::derived::{Derived, Landed, Work};
use super::layouts::{Stand, named};
use crate::data::Version;
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::host::{Job, polylines};
use crate::layout::route::{Net, Terminal};
use crate::scene::mark::MarkKind;
use crate::{Route, Side};

/// Each routed mark's path words with the rows of its table they were routed for, and a count of
/// their changes.
#[derive(Default)]
pub(crate) struct Routes {
    pub(crate) paths: FxHashMap<usize, (Version, Vec<u32>)>,
    pub(crate) version: u64,
}

impl Routes {
    /// Mark `i`'s path words when they were routed for `rows`, its table's rows now: words routed
    /// for other rows, or another scene's mark, would give rows other rows' routes.
    pub(crate) fn of(&self, i: usize, rows: Version) -> Option<&Vec<u32>> {
        self.paths.get(&i).filter(|(routed, _)| *routed == rows).map(|(_, words)| words)
    }
}

/// The routes: what they were worked out from, the readback and job working them out, and the
/// net routing each row of each routed mark, for the job's answer.
#[derive(Default)]
pub(crate) struct Routing {
    pub(crate) routes: Derived<Routes>,
    nets: Vec<Routed>,
}

impl Routing {
    pub(crate) fn busy(&self) -> bool {
        self.routes.busy()
    }
}

/// A routed mark, its table's rows, and the net routing each of them.
type Routed = (usize, Version, Vec<Option<usize>>);

impl View {
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
            if shown.graph.depth() > 0 {
                (shown.version, shown.graph.topology()).hash(&mut hasher);
            }
        }
        for &i in routed {
            let shown = &self.marks[i];
            (i, shown.rows, &shown.ends, shown.graph.terminals().len()).hash(&mut hasher);
            let style = shown.mark.style();
            self.data(&style.data).and_then(|d| d.table(&style.table)).map(|t| t.structure).hash(&mut hasher);
        }
        hasher.finish().max(1)
    }

    /// Reads the vertices back to route again once what routes read changed and nothing moves.
    pub(super) fn route_due(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) {
        let routed = self.routed();
        let stamp = self.routing_stamp(&routed);
        if routed.is_empty() && !self.routing.routes.value.paths.is_empty() {
            let version = self.routing.routes.value.version + 1;
            self.routing.routes.make(stamp, Routes { paths: FxHashMap::default(), version });
        }
        // Routes under way finish first, so routes land while the zoom keeps changing their spacing.
        let moving = self.placing.busy() || self.vertices_moving();
        if !self.routing.routes.due(stamp) || moving || self.routing.busy() {
            return;
        }
        match self.vertex_readback(encoder, inner) {
            Some(readback) => self.routing.routes.start(stamp, Work::Read(readback)),
            None => self.routing.routes.mark(stamp),
        }
    }

    /// Takes what landed of the routes: the vertices read back start the job routing every routed
    /// mark's rows around every vertex; its polylines become each mark's path words.
    pub(super) fn settle_routing(&mut self) {
        let Some((stamp, landed)) = self.routing.routes.landed() else { return };
        match landed {
            Landed::Read(bytes) => {
                let words: &[u32] = bytemuck::cast_slice(&bytes);
                let standing = self.stand_ins(words);
                let mut slots: FxHashMap<u32, (u32, Stand)> = FxHashMap::default();
                let mut obstacles = Vec::new();
                for shown in &self.marks {
                    if shown.kind() != MarkKind::Vertices || !shown.drawable() {
                        continue;
                    }
                    let base = shown.region.state / wgsl::VERTEX_WORDS;
                    for slot in base..base + shown.rows {
                        let at = (slot * wgsl::VERTEX_WORDS + wgsl::VERTEX_FLAGS) as usize;
                        let flags = words.get(at).copied().unwrap_or(0);
                        let open = shown.graph.depth() > 0 && flags & wgsl::COLLAPSED == 0;
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
                self.routing.nets = marks;
                let job = Job::routes(&obstacles, &nets, spacing);
                self.routing.routes.start(stamp, Work::Job(self.gpu.spawn(job)));
                self.wake();
            }
            Landed::Job(answer) => {
                let routes = polylines(&answer).unwrap_or_default();
                let mut paths = FxHashMap::default();
                for (i, rows, row_nets) in &self.routing.nets {
                    // An edge runs from its vertices' middles, through its route, stopping at their
                    // outlines.
                    let ended =
                        matches!(self.marks.get(*i).map(|s| &s.mark), Some(crate::Mark::Edges(e)) if e.ends.is_some());
                    paths.insert(*i, (*rows, route_words(row_nets, &routes, ended)));
                }
                let version = self.routing.routes.value.version + 1;
                self.routing.routes.make(stamp, Routes { paths, version });
                self.wake();
            }
        }
    }

    /// The nets to route, one per row of each routed mark: an edge's two ends, each at the middle of
    /// its side facing the other; a net's terminals at their ports. Each routed mark comes with its
    /// rows' nets.
    fn routed_nets(
        &self,
        slots: &FxHashMap<u32, (u32, Stand)>,
        standing: &FxHashMap<u32, u32>,
    ) -> (Vec<Routed>, Vec<Net>) {
        let groups: FxHashSet<u32> = standing.values().copied().collect();
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
            let Some(table) = self.data(&style.data).and_then(|d| d.table(&style.table)) else { continue };
            if let crate::Mark::Edges(edges) = &shown.mark
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
            let words = shown.graph.terminals();
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
            marks.push((i, table.structure, row_nets));
        }
        (marks, nets)
    }

    /// The folded group standing in for each vertex slot inside one, from the vertices' state read
    /// back: the outermost folded group holding it.
    fn stand_ins(&self, words: &[u32]) -> FxHashMap<u32, u32> {
        let mut parent: FxHashMap<u32, (u32, bool)> = FxHashMap::default();
        for shown in self.marks.iter().filter(|m| m.drawable() && m.graph.depth() > 0) {
            let members = shown.graph.members();
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
    let side = Side::from_code(code & 3).unwrap_or(Side::Bottom);
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
        for (k, polyline) in net.and_then(|n| routes.get(n)).map_or(&[][..], |r| &r[..]).iter().enumerate() {
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
