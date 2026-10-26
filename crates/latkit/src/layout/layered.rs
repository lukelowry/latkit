use rustc_hash::FxHashMap;

use super::levels::{Graph, Level, Runs, bounds, frame, nested};
use super::pack;
use super::rect::union;
use crate::scene::{Direction, Layered};

/// The target width over height of the rows that parts with no pinned vertex pack into.
const ASPECT: f64 = 16.0 / 9.0;
/// Crossing-reduction sweeps, alternately down and up the ranks.
const SWEEPS: usize = 8;

/// Every vertex's center from a layered layout. Pinned vertices stay put. The others go in ranks
/// along `options.flow` (`Direction::Up` is toward +y), `options.gap` apart within a rank and
/// `options.rank_gap` between ranks, ordered to reduce crossings. Links are directed; cycles are
/// broken.
///
/// Each connected part is laid out separately, and parts with no pinned vertex pack into rows
/// (aspect 16:9) below the pinned ones. Across the flow, each vertex lines up with its sources; in
/// a part with no pinned vertex, each source then centers among the vertices it fans out to. Groups
/// nest as [`nested`] lays them out.
pub(crate) fn layered(graph: &Graph<'_>, options: &Layered) -> Vec<[f64; 2]> {
    nested(graph, |level| arrange(level, options))
}

/// Places one level: lays out each connected part in ranks, then packs the parts with no pinned
/// vertex in rows below the pinned ones, tallest first.
fn arrange(level: &Level, options: &Layered) -> Vec<[f64; 2]> {
    let (sizes, pins) = (&level.sizes, &level.pinned);
    let mut centers = vec![[0.0; 2]; sizes.len()];
    let (part, count) = parts(sizes.len(), &level.links);
    let inside = Runs::new(count, (0..sizes.len()).map(|i| (part[i] as usize, i as u32)));
    let joins = Runs::new(count, level.links.iter().map(|&link| (part[link[0] as usize] as usize, link)));
    // Each member's index within its part; a part's members are in index order.
    let mut slot = vec![0_u32; sizes.len()];
    for p in 0..count {
        for (s, &i) in inside.get(p).iter().enumerate() {
            slot[i as usize] = s as u32;
        }
    }
    let vertex = |i: u32| i as usize;
    let flow = options.flow;
    let mut anchored: Option<[f64; 4]> = None;
    let mut loose: Vec<(usize, [f64; 4])> = Vec::new();
    for p in 0..count {
        let part_members = inside.get(p);
        let free = part_members.iter().filter(|&&i| pins[vertex(i)].is_none()).count();
        if free > 0 && part_members.len() == 1 {
            centers[vertex(part_members[0])] = [0.0; 2];
        } else if free > 0 {
            let extents: Vec<[f64; 2]> = part_members.iter().map(|&i| extent(flow, sizes[vertex(i)])).collect();
            let fixed: Vec<Option<[f64; 2]>> =
                part_members.iter().map(|&i| pins[vertex(i)].map(|pin| to_flow(flow, pin))).collect();
            let part_links: Vec<[u32; 2]> =
                joins.get(p).iter().map(|&[from, to]| [slot[from as usize], slot[to as usize]]).collect();
            let placed = ranked(&extents, &fixed, &part_links, options.gap, options.rank_gap);
            for (&i, &at) in part_members.iter().zip(&placed) {
                centers[vertex(i)] = from_flow(flow, at);
            }
        }
        for &i in part_members {
            if let Some(pin) = pins[vertex(i)] {
                centers[vertex(i)] = pin;
            }
        }
        let bounds = bounds(part_members.iter().map(|&i| frame(centers[vertex(i)], sizes[vertex(i)])));
        if free == part_members.len() {
            loose.push((p, bounds));
        } else {
            anchored = Some(anchored.map_or(bounds, |anchored| union(anchored, bounds)));
        }
    }
    if loose.is_empty() {
        return centers;
    }
    // Tallest first, ties in part order (by first member), so similar parts line up.
    crate::order::by_key(&mut loose, |a| !crate::order::number(a.1[3] - a.1[1]));
    let boxes: Vec<[f64; 2]> = loose.iter().map(|(_, b)| [b[2] - b[0], b[3] - b[1]]).collect();
    let gap = options.rank_gap;
    let span = pack::span(&boxes, gap, ASPECT).max(anchored.map_or(0.0, |anchored| anchored[2] - anchored[0]));
    let origin = anchored.map_or([0.0; 2], |anchored| [anchored[0], anchored[1] - gap]);
    for (&(p, bounds), corner) in loose.iter().zip(pack::rows(&boxes, gap, span)) {
        let shift = [origin[0] + corner[0] - bounds[0], origin[1] + corner[1] - bounds[3]];
        for &i in inside.get(p) {
            let center = &mut centers[vertex(i)];
            *center = [center[0] + shift[0], center[1] + shift[1]];
        }
    }
    centers
}

/// Each of `count` vertices' connected part under `links`, with parts numbered in order of their
/// first vertex, and the number of parts.
fn parts(count: usize, links: &[[u32; 2]]) -> (Vec<u32>, usize) {
    fn find(root: &mut [u32], mut vertex: u32) -> u32 {
        while root[vertex as usize] != vertex {
            root[vertex as usize] = root[root[vertex as usize] as usize];
            vertex = root[vertex as usize];
        }
        vertex
    }
    let mut root: Vec<u32> = (0..count as u32).collect();
    for &[from, to] in links {
        let (from, to) = (find(&mut root, from), find(&mut root, to));
        // The lower root wins, so a part's root is its first vertex.
        if from < to {
            root[to as usize] = from;
        } else {
            root[from as usize] = to;
        }
    }
    let mut number = vec![u32::MAX; count];
    let mut parts = 0;
    let part = (0..count as u32)
        .map(|vertex| {
            let first = find(&mut root, vertex) as usize;
            if number[first] == u32::MAX {
                number[first] = parts as u32;
                parts += 1;
            }
            number[first]
        })
        .collect();
    (part, parts)
}

/// Plane coordinates rotated so `flow` runs along the first axis: `[along, across]`. Across runs
/// down for a sideways flow, and right for an upward or downward one.
fn to_flow(flow: Direction, [x, y]: [f64; 2]) -> [f64; 2] {
    match flow {
        Direction::Right => [x, -y],
        Direction::Left => [-x, -y],
        Direction::Down => [-y, x],
        Direction::Up => [y, x],
    }
}

/// Plane coordinates of flow coordinates `[along, across]`; undoes [`to_flow`].
fn from_flow(flow: Direction, [along, across]: [f64; 2]) -> [f64; 2] {
    match flow {
        Direction::Right => [along, -across],
        Direction::Left => [-along, -across],
        Direction::Down => [across, -along],
        Direction::Up => [across, along],
    }
}

/// A width and height as a length along `flow` and a span across it.
fn extent(flow: Direction, [width, height]: [f64; 2]) -> [f64; 2] {
    match flow {
        Direction::Right | Direction::Left => [width, height],
        Direction::Down | Direction::Up => [height, width],
    }
}

/// One part's centers in flow coordinates (see [`to_flow`]). `extents` are each vertex's length
/// along the flow and span across it, `pins` the centers of pinned vertices, and `links` are
/// directed.
fn ranked(
    extents: &[[f64; 2]],
    pins: &[Option<[f64; 2]>],
    links: &[[u32; 2]],
    gap: f64,
    rank_gap: f64,
) -> Vec<[f64; 2]> {
    let count = extents.len();
    let rank = ranks(count, links);
    let rank_count = rank.iter().max().map_or(0, |&last| last as usize + 1);
    let mut layers = Runs::new(rank_count, (0..count).map(|i| (rank[i] as usize, i as u32)));
    // Each link as its end in the earlier rank, then its end in the later. Ranking leaves no link
    // within a rank.
    let ends = |&[from, to]: &[u32; 2]| if rank[from as usize] < rank[to as usize] { [from, to] } else { [to, from] };
    let above = Runs::new(count, links.iter().map(ends).map(|[early, late]| (late as usize, early)));
    let below = Runs::new(count, links.iter().map(ends).map(|[early, late]| (early as usize, late)));
    let adjacent = Runs::new(
        rank_count,
        links
            .iter()
            .map(ends)
            .filter(|&[early, late]| rank[late as usize] == rank[early as usize] + 1)
            .map(|link| (rank[link[0] as usize] as usize, link)),
    );
    reorder(&mut layers, &above, &below, &adjacent);
    let mut centers = coordinates(extents, pins, &layers, &above, gap, rank_gap);
    if pins.iter().all(Option::is_none) {
        balance(&mut centers, extents, &layers, &below, gap);
    }
    centers
}

/// Each vertex's rank: the longest path to it from a source (a vertex no link points to), ignoring
/// the links that close cycles. A depth-first walk from the sources, then from any vertex left,
/// finds those links.
fn ranks(count: usize, links: &[[u32; 2]]) -> Vec<u32> {
    const NEW: u8 = 0;
    const WALKING: u8 = 1;
    const DONE: u8 = 2;
    let mut next = Runs::new(count, links.iter().map(|&[from, to]| (from as usize, to)));
    next.sort_each();
    let mut pointed = vec![false; count];
    for &[_, to] in links {
        pointed[to as usize] = true;
    }
    let mut roots: Vec<u32> = (0..count as u32).collect();
    crate::order::by_key(&mut roots, |&vertex| u64::from(pointed[vertex as usize]));
    // A link into a vertex still on the walk closes a cycle; every other link keeps its direction.
    let mut state = vec![NEW; count];
    let mut forward: Vec<[u32; 2]> = Vec::with_capacity(links.len());
    let mut walk: Vec<(u32, usize)> = Vec::new();
    for &root in &roots {
        if state[root as usize] != NEW {
            continue;
        }
        state[root as usize] = WALKING;
        walk.push((root, 0));
        while let Some(top) = walk.last_mut() {
            let at = top.0;
            let Some(&to) = next.get(at as usize).get(top.1) else {
                state[at as usize] = DONE;
                walk.pop();
                continue;
            };
            top.1 += 1;
            if state[to as usize] == WALKING {
                continue;
            }
            forward.push([at, to]);
            if state[to as usize] == NEW {
                state[to as usize] = WALKING;
                walk.push((to, 0));
            }
        }
    }
    let after = Runs::new(count, forward.iter().map(|&[from, to]| (from as usize, to)));
    let mut waiting = vec![0_u32; count];
    for &[_, to] in &forward {
        waiting[to as usize] += 1;
    }
    let mut rank = vec![0_u32; count];
    let mut queue: Vec<u32> = roots.iter().copied().filter(|&vertex| waiting[vertex as usize] == 0).collect();
    let mut head = 0;
    while let Some(&from) = queue.get(head) {
        head += 1;
        for &to in after.get(from as usize) {
            rank[to as usize] = rank[to as usize].max(rank[from as usize] + 1);
            waiting[to as usize] -= 1;
            if waiting[to as usize] == 0 {
                queue.push(to);
            }
        }
    }
    rank
}

/// Orders each rank to reduce edge crossings. Barycenter sweeps alternate: down the ranks, sorting
/// each by the mean position of its vertices' neighbors in earlier ranks, then up, by neighbors in
/// later ranks. The order with the fewest crossings between adjacent ranks is kept.
fn reorder(layers: &mut Runs<u32>, above: &Runs<u32>, below: &Runs<u32>, adjacent: &Runs<[u32; 2]>) {
    let mut position = vec![0_u32; above.len()];
    for k in 0..layers.len() {
        settle(layers.get(k), &mut position);
    }
    let mut crossings = Crossings::default();
    let mut fewest = crossings.count(layers, &position, adjacent);
    let mut best = layers.items.clone();
    let mut score = vec![0.0; above.len()];
    for sweep in 0..SWEEPS {
        if fewest == 0 {
            break;
        }
        let down = sweep % 2 == 0;
        let neighbors = if down { above } else { below };
        for step in 0..layers.len() {
            let layer = layers.get_mut(if down { step } else { layers.len() - 1 - step });
            for &vertex in &*layer {
                let near = neighbors.get(vertex as usize);
                score[vertex as usize] = if near.is_empty() {
                    f64::from(position[vertex as usize])
                } else {
                    near.iter().map(|&other| f64::from(position[other as usize])).sum::<f64>() / near.len() as f64
                };
            }
            crate::order::by_key(layer, |&a| crate::order::number(score[a as usize]));
            settle(layer, &mut position);
        }
        let crossed = crossings.count(layers, &position, adjacent);
        if crossed < fewest {
            fewest = crossed;
            best.clone_from(&layers.items);
        }
    }
    layers.items = best;
}

/// Records where each vertex of `layer` sits in it.
fn settle(layer: &[u32], position: &mut [u32]) {
    for (at, &vertex) in layer.iter().enumerate() {
        position[vertex as usize] = at as u32;
    }
}

/// Counts edge crossings between adjacent ranks, reusing its buffers from one count to the next.
#[derive(Default)]
struct Crossings {
    /// Each edge's position in the earlier rank and in the later rank.
    ends: Vec<(u32, u32)>,
    /// A Fenwick tree counting the edges seen so far that end at each position of the later rank.
    ended: Vec<u32>,
}

impl Crossings {
    /// The number of crossing edge pairs between adjacent ranks, given each vertex's position in
    /// its rank. With edges sorted by start, each edge crosses the earlier ones that end after it.
    fn count(&mut self, layers: &Runs<u32>, position: &[u32], adjacent: &Runs<[u32; 2]>) -> u64 {
        let mut total = 0;
        for k in 1..layers.len() {
            let edges = adjacent.get(k - 1);
            if edges.len() < 2 {
                continue;
            }
            self.ends.clear();
            self.ends.extend(edges.iter().map(|&[early, late]| (position[early as usize], position[late as usize])));
            self.ends.sort_unstable();
            self.ended.clear();
            self.ended.resize(layers.get(k).len() + 1, 0);
            for (seen, &(_, end)) in self.ends.iter().enumerate() {
                let mut at_or_before = 0;
                let mut node = end as usize + 1;
                while node > 0 {
                    at_or_before += self.ended[node] as usize;
                    node &= node - 1;
                }
                total += (seen - at_or_before) as u64;
                let mut node = end as usize + 1;
                while node < self.ended.len() {
                    self.ended[node] += 1;
                    node += node.isolate_lowest_one();
                }
            }
        }
        total
    }
}

/// Each vertex's center in flow coordinates. Ranks run `rank_gap` apart along the flow, each
/// vertex centered in its rank's band. Across the flow, each vertex lines up with the median of
/// its neighbors in earlier ranks, unless that brings it within `gap` of the previous vertex in its
/// rank. A rank holding pinned vertices starts where they do, and vertices step past pinned ones
/// they would come within `gap` of.
fn coordinates(
    extents: &[[f64; 2]],
    pins: &[Option<[f64; 2]>],
    layers: &Runs<u32>,
    above: &Runs<u32>,
    gap: f64,
    rank_gap: f64,
) -> Vec<[f64; 2]> {
    let mut centers: Vec<[f64; 2]> = pins.iter().map(|pin| pin.unwrap_or_default()).collect();
    let length_of = |vertex: u32| extents[vertex as usize][0];
    let bands: Vec<f64> =
        (0..layers.len()).map(|k| layers.get(k).iter().map(|&i| length_of(i)).fold(0.0, f64::max)).collect();
    // Where a rank's pinned vertices begin along the flow.
    let lead = |k: usize| {
        layers.get(k).iter().filter_map(|&i| pins[i as usize].map(|pin| pin[0] - length_of(i) / 2.0)).reduce(f64::min)
    };
    let first = (0..layers.len()).find_map(|k| lead(k).map(|at| (k, at)));
    // Ranks before the first rank with a pinned vertex end where that rank starts.
    let mut major = first.map_or(0.0, |(k, at)| at - bands[..k].iter().map(|band| band + rank_gap).sum::<f64>());
    let mut obstacles = first.map(|_| Obstacles::new(extents, pins, [gap.min(rank_gap), gap]));
    let mut wanted: Vec<f64> = Vec::new();
    for (k, &band) in bands.iter().enumerate() {
        if let Some(at) = lead(k) {
            major = at;
        }
        let along = major + band / 2.0;
        let mut floor: Option<f64> = None;
        for &i in layers.get(k) {
            let i = i as usize;
            if pins[i].is_some() {
                continue;
            }
            let [length, span] = extents[i];
            wanted.clear();
            wanted.extend(above.get(i).iter().map(|&other| centers[other as usize][1] - span / 2.0));
            let median = (!wanted.is_empty()).then(|| {
                let middle = (wanted.len() - 1) / 2;
                *wanted.select_nth_unstable_by(middle, f64::total_cmp).1
            });
            let mut low = match (median, floor) {
                (Some(median), Some(floor)) => median.max(floor),
                (Some(at), None) | (None, Some(at)) => at,
                (None, None) => 0.0,
            };
            let (start, end) = (along - length / 2.0, along + length / 2.0);
            if let Some(obstacles) = &obstacles {
                while let Some(high) = obstacles.reach([start, low, end, low + span]) {
                    low = high + gap;
                }
            }
            let high = low + span;
            centers[i] = [along, low + span / 2.0];
            if let Some(obstacles) = &mut obstacles {
                obstacles.add([start, low, end, high]);
            }
            floor = Some(high + gap);
        }
        major += band + rank_gap;
    }
    centers
}

/// Moves each vertex across the flow toward the median of its neighbors in later ranks, last ranks
/// first, as far as its neighbors in its rank allow at `gap` apart. A source centers among the
/// vertices it fans out to, and a chain stays in line.
fn balance(centers: &mut [[f64; 2]], extents: &[[f64; 2]], layers: &Runs<u32>, below: &Runs<u32>, gap: f64) {
    let mut across: Vec<f64> = Vec::new();
    let mut goals: Vec<Option<f64>> = Vec::new();
    for k in (0..layers.len()).rev() {
        let layer = layers.get(k);
        goals.clear();
        for &vertex in layer {
            let near = below.get(vertex as usize);
            across.clear();
            across.extend(near.iter().map(|&other| centers[other as usize][1]));
            crate::order::numbers(&mut across);
            let middle = across.len() / 2;
            goals.push(match across.len() {
                0 => None,
                count if count % 2 == 1 => Some(across[middle]),
                _ => Some(across[middle - 1].midpoint(across[middle])),
            });
        }
        // Toward greater across, the last vertex first, each held short of the one after it.
        let mut ceiling = f64::INFINITY;
        for (&vertex, goal) in layer.iter().zip(&goals).rev() {
            let half = extents[vertex as usize][1] / 2.0;
            let center = &mut centers[vertex as usize][1];
            if let Some(goal) = *goal
                && goal > *center
            {
                *center = goal.min(ceiling - half).max(*center);
            }
            ceiling = *center - half - gap;
        }
        // Then toward lesser across, the first vertex first, each held short of the one before it.
        let mut floor = f64::NEG_INFINITY;
        for (&vertex, goal) in layer.iter().zip(&goals) {
            let half = extents[vertex as usize][1] / 2.0;
            let center = &mut centers[vertex as usize][1];
            if let Some(goal) = *goal
                && goal < *center
            {
                *center = goal.max(floor + half).min(*center);
            }
            floor = *center + half + gap;
        }
    }
}

/// Placed boxes in flow coordinates, bucketed in square cells to find those near a box quickly.
struct Obstacles {
    /// A cell's side.
    cell: f64,
    /// The clearance boxes keep between them, along the flow and across it.
    room: [f64; 2],
    /// Each box: its least along and across, then its greatest.
    boxes: Vec<[f64; 4]>,
    /// The boxes reaching into each cell.
    cells: FxHashMap<[i64; 2], Vec<u32>>,
}

impl Obstacles {
    /// Obstacles holding the pinned vertices' boxes, keeping `room` between boxes. Cells span a few
    /// vertices, so each box reaches few cells.
    fn new(extents: &[[f64; 2]], pins: &[Option<[f64; 2]>], room: [f64; 2]) -> Obstacles {
        let largest = extents.iter().flatten().fold(0.0, |largest: f64, &side| largest.max(side));
        let cell = (room[1] * 8.0).max(largest * 2.0);
        let mut obstacles = Obstacles {
            cell: if cell > 0.0 { cell } else { 1.0 },
            room,
            boxes: Vec::new(),
            cells: FxHashMap::default(),
        };
        for (pin, &[length, span]) in pins.iter().zip(extents) {
            if let Some([along, across]) = *pin {
                obstacles.add([along - length / 2.0, across - span / 2.0, along + length / 2.0, across + span / 2.0]);
            }
        }
        obstacles
    }

    /// Adds a placed box.
    fn add(&mut self, placed: [f64; 4]) {
        let id = self.boxes.len() as u32;
        self.boxes.push(placed);
        for key in cells(self.cell, placed) {
            self.cells.entry(key).or_default().push(id);
        }
    }

    /// The greatest across edge among the boxes that `query` comes within `room` of, if any.
    fn reach(&self, query: [f64; 4]) -> Option<f64> {
        let [along, across] = self.room;
        let grown = [query[0] - along, query[1] - across, query[2] + along, query[3] + across];
        let mut reach: Option<f64> = None;
        for key in cells(self.cell, grown) {
            for &id in self.cells.get(&key).into_iter().flatten() {
                let other = self.boxes[id as usize];
                let near = other[0] < query[2] + along
                    && query[0] < other[2] + along
                    && other[1] < query[3] + across
                    && query[1] < other[3] + across;
                if near {
                    reach = Some(reach.map_or(other[3], |reach| reach.max(other[3])));
                }
            }
        }
        reach
    }
}

/// The cells of side `cell` that `area` reaches into.
fn cells(cell: f64, area: [f64; 4]) -> impl Iterator<Item = [i64; 2]> {
    let index = |at: f64| (at / cell).floor() as i64;
    let (across_from, across_to) = (index(area[1]), index(area[3]));
    (index(area[0])..=index(area[2]))
        .flat_map(move |along| (across_from..=across_to).map(move |across| [along, across]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: [f64; 2] = [20.0, 10.0];

    fn options(flow: Direction) -> Layered {
        Layered { flow, gap: 10.0, rank_gap: 40.0 }
    }

    /// A graph's columns, owned.
    struct Columns {
        sizes: Vec<[f64; 2]>,
        edges: Vec<[u32; 2]>,
        pinned: Vec<Option<[f64; 2]>>,
        groups: Vec<Option<u32>>,
        pads: Vec<[f64; 4]>,
    }

    impl Columns {
        /// `count` vertices of [`SIZE`] joined by `edges`, none pinned or grouped. A group pads its
        /// members by half a gap.
        fn new(count: usize, edges: &[[u32; 2]]) -> Columns {
            Columns {
                sizes: vec![SIZE; count],
                edges: edges.to_vec(),
                pinned: vec![None; count],
                groups: vec![None; count],
                pads: vec![[5.0; 4]; count],
            }
        }

        fn layout(&self, options: &Layered) -> Vec<[f64; 2]> {
            let graph = Graph {
                sizes: &self.sizes,
                links: &self.edges,
                pinned: &self.pinned,
                groups: &self.groups,
                pads: &self.pads,
            };
            layered(&graph, options)
        }

        /// Vertex `v`'s box: a group's is its members' bounds, padded.
        fn frame(&self, centers: &[[f64; 2]], v: usize, padding: f64) -> [f64; 4] {
            let members: Vec<usize> = (0..self.sizes.len()).filter(|&m| self.groups[m] == Some(v as u32)).collect();
            if members.is_empty() {
                return frame(centers[v], self.sizes[v]);
            }
            let inner = bounds(members.iter().map(|&m| self.frame(centers, m, padding)));
            [inner[0] - padding, inner[1] - padding, inner[2] + padding, inner[3] + padding]
        }
    }

    /// Whether two boxes share more than an edge.
    fn overlap(a: [f64; 4], b: [f64; 4]) -> bool {
        const SLACK: f64 = 1e-6;
        a[0] < b[2] - SLACK && b[0] < a[2] - SLACK && a[1] < b[3] - SLACK && b[1] < a[3] - SLACK
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    /// How many edge pairs cross between the same two ranks of a rightward flow.
    fn crossings(edges: &[[u32; 2]], centers: &[[f64; 2]]) -> usize {
        let mut count = 0;
        for (k, first) in edges.iter().enumerate() {
            for second in &edges[k + 1..] {
                let [from, to] = first.map(|vertex| centers[vertex as usize]);
                let [other_from, other_to] = second.map(|vertex| centers[vertex as usize]);
                let same_ranks = near(from[0], other_from[0]) && near(to[0], other_to[0]);
                if same_ranks && (from[1] - other_from[1]) * (to[1] - other_to[1]) < 0.0 {
                    count += 1;
                }
            }
        }
        count
    }

    #[test]
    fn a_chain_ranks_along_the_flow_in_order() {
        let graph = Columns::new(4, &[[2, 3], [0, 1], [1, 2]]);
        for flow in [Direction::Right, Direction::Left, Direction::Down, Direction::Up] {
            let centers = graph.layout(&options(flow));
            let (along, across, sign) = match flow {
                Direction::Right => (0, 1, 1.0),
                Direction::Left => (0, 1, -1.0),
                Direction::Down => (1, 0, -1.0),
                Direction::Up => (1, 0, 1.0),
            };
            let length = SIZE[along];
            for pair in centers.windows(2) {
                let step = (pair[1][along] - pair[0][along]) * sign;
                assert!(near(step, length + 40.0), "{flow:?}: ranks a rank gap apart: {centers:?}");
                assert!(near(pair[1][across], pair[0][across]), "{flow:?}: in line with its source: {centers:?}");
            }
        }
    }

    #[test]
    fn a_source_centers_on_its_fan() {
        // 0 fans out to 1, 2, and 3; 3 runs on to 4.
        let centers = Columns::new(5, &[[0, 1], [0, 2], [0, 3], [3, 4]]).layout(&options(Direction::Down));
        assert!(near(centers[0][0], centers[2][0]), "the source is centered on its fan: {centers:?}");
        assert!(near(centers[3][0], centers[4][0]), "a chain stays in line: {centers:?}");
        assert!(centers[1][0] < centers[2][0] && centers[2][0] < centers[3][0], "{centers:?}");
    }

    #[test]
    fn pinned_vertices_stay_put() {
        let mut graph = Columns::new(5, &[[0, 1], [1, 2], [1, 3], [3, 4]]);
        graph.pinned[1] = Some([500.0, -300.0]);
        graph.pinned[3] = Some([620.0, -260.0]);
        let centers = graph.layout(&options(Direction::Right));
        assert_eq!(centers[1], [500.0, -300.0]);
        assert_eq!(centers[3], [620.0, -260.0]);
        assert!(centers[0][0] < centers[1][0] && centers[2][0] > centers[1][0], "{centers:?}");
        for a in 0..5 {
            for b in a + 1..5 {
                assert!(!overlap(frame(centers[a], SIZE), frame(centers[b], SIZE)), "{a} and {b}: {centers:?}");
            }
        }
    }

    #[test]
    fn disconnected_parts_do_not_overlap() {
        let graph = Columns::new(8, &[[0, 1], [1, 2], [3, 4], [4, 5]]);
        let centers = graph.layout(&options(Direction::Right));
        for a in 0..8 {
            for b in a + 1..8 {
                assert!(!overlap(frame(centers[a], SIZE), frame(centers[b], SIZE)), "{a} and {b}: {centers:?}");
            }
        }
        let first = bounds((0..3).map(|v| frame(centers[v], SIZE)));
        assert!(near(first[0], 0.0) && near(first[3], 0.0), "the first part's top left is the origin: {first:?}");
    }

    #[test]
    fn a_cycle_still_lays_out() {
        let graph = Columns::new(4, &[[0, 1], [1, 2], [2, 0], [2, 3]]);
        let centers = graph.layout(&options(Direction::Right));
        assert!(centers.iter().flatten().all(|at| at.is_finite()));
        assert!(
            centers.windows(2).all(|pair| pair[1][0] > pair[0][0]),
            "the cycle breaks at its back edge: {centers:?}"
        );
    }

    #[test]
    fn sweeps_untangle_crossings() {
        // A K2,2 minus one edge in two ranks of two, and a graph in three ranks of three. Both
        // cross when laid out in index order.
        let small = [[0, 3], [1, 2], [1, 3]];
        let large = [[0, 5], [1, 4], [2, 3], [2, 4], [3, 8], [4, 7], [5, 6]];
        for (count, width, edges) in [(4, 2, &small[..]), (9, 3, &large[..])] {
            let in_index_order: Vec<[f64; 2]> = (0..count).map(|v| [(v / width) as f64, (v % width) as f64]).collect();
            assert!(crossings(edges, &in_index_order) > 0);
            let centers = Columns::new(count, edges).layout(&options(Direction::Right));
            assert_eq!(crossings(edges, &centers), 0, "{centers:?}");
        }
    }

    #[test]
    fn groups_contain_their_members_and_keep_other_vertices_out() {
        // Group 0 holds 1 → 2 → 3 and group 6, which holds 7 → 8. Vertex 4 feeds group 0, and 5
        // drains it.
        let mut graph = Columns::new(9, &[[1, 2], [2, 3], [4, 1], [3, 5], [2, 7], [7, 8]]);
        graph.groups = vec![None, Some(0), Some(0), Some(0), None, None, Some(0), Some(6), Some(6)];
        let options = options(Direction::Right);
        let centers = graph.layout(&options);
        let padding = options.gap / 2.0;
        let frame = |v: usize| graph.frame(&centers, v, padding);
        for (group, members) in [(0, &[1, 2, 3, 6][..]), (6, &[7, 8][..])] {
            let outer = frame(group);
            let middle = [outer[0].midpoint(outer[2]), outer[1].midpoint(outer[3])];
            assert!(near(centers[group][0], middle[0]) && near(centers[group][1], middle[1]), "{centers:?}");
            for &m in members {
                let inner = frame(m);
                assert!(inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]);
            }
        }
        for (a, b) in [(0, 4), (0, 5), (4, 5), (6, 1), (6, 2), (6, 3), (1, 2), (2, 3), (1, 3), (7, 8)] {
            assert!(!overlap(frame(a), frame(b)), "{a} and {b}: {centers:?}");
        }
        assert!(frame(4)[2] < frame(0)[0] && frame(0)[2] < frame(5)[0], "the group ranks as one vertex: {centers:?}");
    }

    #[test]
    fn a_pinned_member_fixes_its_group_and_a_pinned_group_moves_its_members() {
        let mut graph = Columns::new(7, &[[1, 2], [3, 0], [5, 6], [4, 5]]);
        graph.groups = vec![None, Some(0), Some(0), None, None, Some(4), Some(4)];
        graph.pinned[1] = Some([300.0, 200.0]);
        graph.pinned[4] = Some([-1000.0, 1000.0]);
        let options = options(Direction::Right);
        let centers = graph.layout(&options);
        assert_eq!(centers[1], [300.0, 200.0]);
        assert!(near(centers[4][0], -1000.0) && near(centers[4][1], 1000.0), "{centers:?}");
        let frame = |v: usize| graph.frame(&centers, v, options.gap / 2.0);
        let group = frame(4);
        assert!(near(group[0].midpoint(group[2]), -1000.0) && near(group[1].midpoint(group[3]), 1000.0));
        assert!(!overlap(frame(3), frame(0)) && frame(3)[2] < frame(0)[0], "{centers:?}");
    }

    #[test]
    fn large_graphs_lay_out_without_overlaps() {
        // Fifty groups of twenty, and edges joining random vertices, many against the flow.
        let count = 10_000;
        let mut seed = 0x9e37_79b9_u32;
        let mut random = move |below: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as usize % below
        };
        let mut edges: Vec<[u32; 2]> = (51..count).map(|v| [(50 + random(v - 50)) as u32, v as u32]).collect();
        edges.extend((0..count / 2).map(|_| [(50 + random(count - 50)) as u32, (50 + random(count - 50)) as u32]));
        let mut graph = Columns::new(count, &edges);
        for v in 50..1050 {
            graph.groups[v] = Some(((v - 50) / 20) as u32);
        }
        let options = options(Direction::Down);
        let centers = graph.layout(&options);
        assert!(centers.iter().flatten().all(|at| at.is_finite()));
        let mut frames: Vec<(usize, [f64; 4])> = (50..count).map(|v| (v, frame(centers[v], SIZE))).collect();
        frames.extend((0..50).map(|g| (g, graph.frame(&centers, g, options.gap / 2.0))));
        // Ranks run down the page, so sweeping down it compares each frame with few others.
        crate::order::by_key(&mut frames, |a| crate::order::number(a.1[1]));
        for (k, &(a, first)) in frames.iter().enumerate() {
            for &(b, second) in frames[k + 1..].iter().take_while(|(_, second)| second[1] < first[3]) {
                let held = graph.groups[a] == Some(b as u32) || graph.groups[b] == Some(a as u32);
                assert!(held || !overlap(first, second), "{a} {first:?} and {b} {second:?}");
            }
        }
    }
}
