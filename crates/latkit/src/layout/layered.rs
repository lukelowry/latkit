use rustc_hash::FxHashMap;

use super::graph::{Graph, Runs, bounds};
use super::pack;
use crate::scene::{Direction, Layered};

/// The target width over height of the rows that parts with no pinned vertex pack into.
const ASPECT: f64 = 16.0 / 9.0;
/// Crossing-reduction sweeps, alternately down and up the ranks.
const SWEEPS: usize = 8;

/// Every vertex's center from a layered layout. Pinned vertices stay put. The others go in ranks
/// along `options.direction` (`Direction::Up` is toward +y), `options.gap` apart within a rank and
/// `options.rank_gap` between ranks, ordered to reduce crossings. Links are directed, and cycles
/// are broken.
///
/// Each connected part is laid out separately, and parts with no pinned vertex pack into rows
/// (aspect 16:9) below the pinned ones, tallest first. Across the direction, each vertex lines up
/// with its sources. In a part with no pinned vertex, each source then centers among the vertices
/// it fans out to.
pub(crate) fn layered(graph: &Graph<'_>, options: &Layered) -> Vec<[f64; 2]> {
    let (count, pins, links) = (graph.len(), graph.pins(), graph.links());
    let mut centers = vec![[0.0; 2]; count];
    let (part, parts) = parts(count, &links);
    let inside = Runs::new(parts, (0..count).map(|i| (part[i] as usize, i as u32)));
    let joins = Runs::new(parts, links.iter().map(|&link| (part[link[0] as usize] as usize, link)));
    // Each member's index within its part. A part's members are in index order.
    let mut slot = vec![0_u32; count];
    for p in 0..parts {
        for (s, &i) in inside.get(p).iter().enumerate() {
            slot[i as usize] = s as u32;
        }
    }
    let vertex = |i: u32| i as usize;
    let direction = options.direction;
    let mut anchored: Vec<[f64; 2]> = Vec::new();
    let mut loose: Vec<(usize, [f64; 4])> = Vec::new();
    for p in 0..parts {
        let part_members = inside.get(p);
        let free = part_members.iter().filter(|&&i| pins[vertex(i)].is_none()).count();
        if free > 0 && part_members.len() > 1 {
            let fixed: Vec<Option<[f64; 2]>> =
                part_members.iter().map(|&i| pins[vertex(i)].map(|pin| to_ranks(direction, pin))).collect();
            let part_links: Vec<[u32; 2]> =
                joins.get(p).iter().map(|&[from, to]| [slot[from as usize], slot[to as usize]]).collect();
            let placed = ranked(&fixed, &part_links, options.gap, options.rank_gap);
            for (&i, &at) in part_members.iter().zip(&placed) {
                centers[vertex(i)] = from_ranks(direction, at);
            }
        }
        for &i in part_members {
            if let Some(pin) = pins[vertex(i)] {
                centers[vertex(i)] = pin;
            }
        }
        let points = part_members.iter().map(|&i| centers[vertex(i)]);
        if free == part_members.len() {
            loose.push((p, bounds(points)));
        } else {
            anchored.extend(points);
        }
    }
    if loose.is_empty() {
        return centers;
    }
    let anchored = (!anchored.is_empty()).then(|| bounds(anchored.into_iter()));
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

/// Rank coordinates `[along, across]` of plane coordinates, rotated so `direction` runs along the
/// first axis. Across runs down for a sideways direction, and right for an upward or
/// downward one.
fn to_ranks(direction: Direction, [x, y]: [f64; 2]) -> [f64; 2] {
    match direction {
        Direction::Right => [x, -y],
        Direction::Left => [-x, -y],
        Direction::Down => [-y, x],
        Direction::Up => [y, x],
    }
}

/// Plane coordinates of rank coordinates `[along, across]`. Undoes [`to_ranks`].
fn from_ranks(direction: Direction, [along, across]: [f64; 2]) -> [f64; 2] {
    match direction {
        Direction::Right => [along, -across],
        Direction::Left => [-along, -across],
        Direction::Down => [across, -along],
        Direction::Up => [across, along],
    }
}

/// One part's centers in rank coordinates (see [`to_ranks`]). `pins` are the centers of pinned
/// vertices, and `links` are directed.
fn ranked(pins: &[Option<[f64; 2]>], links: &[[u32; 2]], gap: f64, rank_gap: f64) -> Vec<[f64; 2]> {
    let count = pins.len();
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
    let mut centers = coordinates(pins, &layers, &above, gap, rank_gap);
    if pins.iter().all(Option::is_none) {
        balance(&mut centers, &layers, &below, gap);
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
    // A link into a vertex still on the walk closes a cycle. Every other link keeps its direction.
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

/// Each vertex's center in rank coordinates. Ranks run `rank_gap` apart along the direction.
/// Across the direction, each vertex lines up with the median of its neighbors in earlier ranks,
/// unless that brings it within `gap` of the previous vertex in its rank. A rank holding pinned
/// vertices sits where the first of them does, and vertices step past pinned ones they would come
/// within `gap` of.
fn coordinates(
    pins: &[Option<[f64; 2]>],
    layers: &Runs<u32>,
    above: &Runs<u32>,
    gap: f64,
    rank_gap: f64,
) -> Vec<[f64; 2]> {
    let mut centers: Vec<[f64; 2]> = pins.iter().map(|pin| pin.unwrap_or_default()).collect();
    // Where a rank's pinned vertices begin along the direction.
    let lead = |k: usize| layers.get(k).iter().filter_map(|&i| pins[i as usize].map(|pin| pin[0])).reduce(f64::min);
    let first = (0..layers.len()).find_map(|k| lead(k).map(|at| (k, at)));
    // Ranks before the first rank with a pinned vertex end where that rank starts.
    let mut along = first.map_or(0.0, |(k, at)| at - k as f64 * rank_gap);
    let mut obstacles = first.map(|_| Obstacles::new(pins, [gap.min(rank_gap), gap]));
    let mut wanted: Vec<f64> = Vec::new();
    for k in 0..layers.len() {
        if let Some(at) = lead(k) {
            along = at;
        }
        let mut floor: Option<f64> = None;
        for &i in layers.get(k) {
            let i = i as usize;
            if pins[i].is_some() {
                continue;
            }
            wanted.clear();
            wanted.extend(above.get(i).iter().map(|&other| centers[other as usize][1]));
            let median = (!wanted.is_empty()).then(|| {
                let middle = (wanted.len() - 1) / 2;
                *wanted.select_nth_unstable_by(middle, f64::total_cmp).1
            });
            let mut across = match (median, floor) {
                (Some(median), Some(floor)) => median.max(floor),
                (Some(at), None) | (None, Some(at)) => at,
                (None, None) => 0.0,
            };
            if let Some(obstacles) = &obstacles {
                while let Some(reach) = obstacles.reach([along, across]) {
                    across = reach + gap;
                }
            }
            centers[i] = [along, across];
            if let Some(obstacles) = &mut obstacles {
                obstacles.add([along, across]);
            }
            floor = Some(across + gap);
        }
        along += rank_gap;
    }
    centers
}

/// Moves each vertex across the direction toward the median of its neighbors in later ranks, last
/// ranks first, as far as its neighbors in its rank allow at `gap` apart. A source centers among
/// the vertices it fans out to, and a chain stays in line.
fn balance(centers: &mut [[f64; 2]], layers: &Runs<u32>, below: &Runs<u32>, gap: f64) {
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
            let center = &mut centers[vertex as usize][1];
            if let Some(goal) = *goal
                && goal > *center
            {
                *center = goal.min(ceiling).max(*center);
            }
            ceiling = *center - gap;
        }
        // Then toward lesser across, the first vertex first, each held short of the one before it.
        let mut floor = f64::NEG_INFINITY;
        for (&vertex, goal) in layer.iter().zip(&goals) {
            let center = &mut centers[vertex as usize][1];
            if let Some(goal) = *goal
                && goal < *center
            {
                *center = goal.max(floor).min(*center);
            }
            floor = *center + gap;
        }
    }
}

/// Placed points in rank coordinates, bucketed in square cells to find those near a point quickly.
struct Obstacles {
    /// A cell's side.
    cell: f64,
    /// The clearance points keep between them, along the direction and across it.
    room: [f64; 2],
    /// Each point: along, then across.
    points: Vec<[f64; 2]>,
    /// The points in each cell.
    cells: FxHashMap<[i64; 2], Vec<u32>>,
}

impl Obstacles {
    /// Obstacles holding the pinned vertices, keeping `room` between points. Cells span a few gaps.
    fn new(pins: &[Option<[f64; 2]>], room: [f64; 2]) -> Obstacles {
        let cell = room[1] * 8.0;
        let mut obstacles = Obstacles {
            cell: if cell > 0.0 { cell } else { 1.0 },
            room,
            points: Vec::new(),
            cells: FxHashMap::default(),
        };
        for pin in pins.iter().flatten() {
            obstacles.add(*pin);
        }
        obstacles
    }

    /// Adds a placed point.
    fn add(&mut self, point: [f64; 2]) {
        let id = self.points.len() as u32;
        self.points.push(point);
        self.cells.entry(self.key(point)).or_default().push(id);
    }

    /// The cell holding `point`.
    fn key(&self, [along, across]: [f64; 2]) -> [i64; 2] {
        [(along / self.cell).floor() as i64, (across / self.cell).floor() as i64]
    }

    /// The greatest across among the points that `query` comes within `room` of, if any.
    fn reach(&self, query: [f64; 2]) -> Option<f64> {
        let [along, across] = self.room;
        let [from_along, from_across] = self.key([query[0] - along, query[1] - across]);
        let [to_along, to_across] = self.key([query[0] + along, query[1] + across]);
        let mut reach: Option<f64> = None;
        for key in (from_along..=to_along).flat_map(|a| (from_across..=to_across).map(move |c| [a, c])) {
            for &id in self.cells.get(&key).into_iter().flatten() {
                let other = self.points[id as usize];
                if (other[0] - query[0]).abs() < along && (other[1] - query[1]).abs() < across {
                    reach = Some(reach.map_or(other[1], |reach| reach.max(other[1])));
                }
            }
        }
        reach
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(direction: Direction) -> Layered {
        Layered { direction, gap: 10.0, rank_gap: 40.0 }
    }

    /// `count` vertices joined by `links`, laid out with the pins `pinned` lists.
    fn layout(count: usize, links: &[[u32; 2]], pinned: &[(usize, [f64; 2])], options: &Layered) -> Vec<[f64; 2]> {
        let mut pins = vec![None; count];
        for &(v, at) in pinned {
            pins[v] = Some(at);
        }
        layered(&Graph { pinned: &pins, links }, options)
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    /// Whether every two of `centers` are at least `gap` apart along x or y.
    fn clear(centers: &[[f64; 2]], gap: f64) -> bool {
        (0..centers.len()).all(|a| {
            (a + 1..centers.len()).all(|b| (0..2).any(|k| (centers[a][k] - centers[b][k]).abs() >= gap - 1e-6))
        })
    }

    /// How many edge pairs cross between the same two ranks of a rightward layout.
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
    fn a_chain_ranks_along_the_direction_in_order() {
        for direction in [Direction::Right, Direction::Left, Direction::Down, Direction::Up] {
            let centers = layout(4, &[[2, 3], [0, 1], [1, 2]], &[], &options(direction));
            let (along, across, sign) = match direction {
                Direction::Right => (0, 1, 1.0),
                Direction::Left => (0, 1, -1.0),
                Direction::Down => (1, 0, -1.0),
                Direction::Up => (1, 0, 1.0),
            };
            for pair in centers.windows(2) {
                let step = (pair[1][along] - pair[0][along]) * sign;
                assert!(near(step, 40.0), "{direction:?}: ranks a rank gap apart: {centers:?}");
                assert!(near(pair[1][across], pair[0][across]), "{direction:?}: in line with its source: {centers:?}");
            }
        }
    }

    #[test]
    fn a_source_centers_on_its_fan() {
        // 0 fans out to 1, 2, and 3; 3 runs on to 4.
        let centers = layout(5, &[[0, 1], [0, 2], [0, 3], [3, 4]], &[], &options(Direction::Down));
        assert!(near(centers[0][0], centers[2][0]), "the source is centered on its fan: {centers:?}");
        assert!(near(centers[3][0], centers[4][0]), "a chain stays in line: {centers:?}");
        assert!(centers[1][0] < centers[2][0] && centers[2][0] < centers[3][0], "{centers:?}");
    }

    #[test]
    fn pinned_vertices_stay_put() {
        let pinned = [(1, [500.0, -300.0]), (3, [620.0, -260.0])];
        let centers = layout(5, &[[0, 1], [1, 2], [1, 3], [3, 4]], &pinned, &options(Direction::Right));
        assert_eq!(centers[1], [500.0, -300.0]);
        assert_eq!(centers[3], [620.0, -260.0]);
        assert!(centers[0][0] < centers[1][0] && centers[2][0] > centers[1][0], "{centers:?}");
        assert!(clear(&centers, 10.0), "{centers:?}");
    }

    #[test]
    fn disconnected_parts_keep_apart() {
        let centers = layout(8, &[[0, 1], [1, 2], [3, 4], [4, 5]], &[], &options(Direction::Right));
        assert!(clear(&centers, 10.0), "{centers:?}");
        let first = bounds((0..3).map(|v| centers[v]));
        assert!(near(first[0], 0.0) && near(first[3], 0.0), "the first part's top left is the origin: {first:?}");
    }

    #[test]
    fn a_cycle_still_lays_out() {
        let centers = layout(4, &[[0, 1], [1, 2], [2, 0], [2, 3]], &[], &options(Direction::Right));
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
            let centers = layout(count, edges, &[], &options(Direction::Right));
            assert_eq!(crossings(edges, &centers), 0, "{centers:?}");
        }
    }

    #[test]
    fn large_graphs_lay_out_a_gap_apart() {
        // Edges joining random vertices, many against the direction.
        let count = 10_000;
        let mut seed = 0x9e37_79b9_u32;
        let mut random = move |below: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as usize % below
        };
        let mut edges: Vec<[u32; 2]> = (1..count).map(|v| [random(v) as u32, v as u32]).collect();
        edges.extend((0..count / 2).map(|_| [random(count) as u32, random(count) as u32]));
        let mut centers = layout(count, &edges, &[], &options(Direction::Down));
        assert!(centers.iter().flatten().all(|at| at.is_finite()));
        // Ranks run down the page, and within a rank, vertices are a gap apart.
        centers.sort_by(|a, b| a[1].total_cmp(&b[1]).then(a[0].total_cmp(&b[0])));
        for pair in centers.windows(2) {
            if near(pair[0][1], pair[1][1]) {
                assert!(pair[1][0] - pair[0][0] >= 10.0 - 1e-6, "{pair:?}");
            }
        }
    }
}
