//! Stress majorization: places vertices at their graph distances, then separates their boxes.
//!
//! Each vertex's terms are its neighbors, a gap away, and a few pivots at their graph distance, so
//! a round costs O(vertices × pivots). Pinned vertices stay put and anchor the rest. Vertices start
//! near the pinned vertices they connect to, or around their part's most linked vertex, and parts
//! with no pinned vertex pack apart. Groups nest as [`nested`] lays them out: a group's members
//! settle by stress among themselves, and the group among the vertices and groups beside it.

use std::collections::VecDeque;

use super::levels::{Graph, Level, nested};
use super::overlap::separate;
use super::pack::pack;

/// Jacobi iterations per level.
const ROUNDS: usize = 240;
/// The most pivots stress measures graph distances from.
const PIVOTS: usize = 32;
/// The most graph distances it stores in all (pivots × vertices).
const DISTANCES: usize = 8_000_000;
/// The fraction of the gap that vertices' boxes keep clear of each other.
const CLEARANCE: f64 = 0.25;

/// Every vertex's center from a stress layout: neighbors `gap` apart, pinned vertices fixed, and
/// boxes a quarter gap clear of each other. Link direction is ignored.
pub(crate) fn stress(graph: &Graph<'_>, gap: f64) -> Vec<[f64; 2]> {
    nested(graph, |level| place(level, gap))
}

/// One level's centers: `ROUNDS` Jacobi iterations, then overlap removal.
fn place(level: &Level, gap: f64) -> Vec<[f64; 2]> {
    let n = level.sizes.len();
    if n == 0 {
        return Vec::new();
    }
    let (offsets, targets) = neighbors(n, &level.links);
    let terms = terms(n, gap, &offsets, &targets);
    let mut position = start(level, gap, &offsets, &targets);
    let mut next = position.clone();
    for _ in 0..ROUNDS {
        for v in 0..n {
            if let Some(pin) = level.pinned[v] {
                next[v] = pin;
                continue;
            }
            let here = position[v];
            let (mut sum, mut weights) = ([0.0; 2], 0.0);
            for &(other, distance, weight) in &terms[v] {
                let there = position[other as usize];
                let apart = [here[0] - there[0], here[1] - there[1]];
                let length = apart[0].hypot(apart[1]);
                // Coincident vertices separate along a direction derived from their index.
                let toward = if length > 1e-9 {
                    [apart[0] / length, apart[1] / length]
                } else {
                    let angle = v as f64;
                    [angle.cos(), angle.sin()]
                };
                sum = [
                    sum[0] + weight * (there[0] + distance * toward[0]),
                    sum[1] + weight * (there[1] + distance * toward[1]),
                ];
                weights += weight;
            }
            next[v] = if weights > 0.0 { [sum[0] / weights, sum[1] / weights] } else { here };
        }
        std::mem::swap(&mut position, &mut next);
    }
    let boxes: Vec<[f64; 4]> =
        position.iter().zip(&level.sizes).map(|(p, s)| [p[0], p[1], s[0] / 2.0, s[1] / 2.0]).collect();
    let pinned: Vec<bool> = level.pinned.iter().map(Option::is_some).collect();
    separate(&boxes, &pinned, gap * CLEARANCE)
}

/// Each vertex's terms as (other vertex, target distance, weight): its neighbors one `gap` away,
/// weighted by the inverse square of that distance; and pivots at their graph distance times
/// `gap`, weighted by the inverse square times how many vertices of the pivot's region lie within
/// half that distance of it.
fn terms(n: usize, gap: f64, offsets: &[u32], targets: &[u32]) -> Vec<Vec<(u32, f64, f64)>> {
    let degree = |v: usize| offsets[v + 1] - offsets[v];
    // Pivots far apart: each is the vertex farthest from the earlier ones, so vertices they cannot
    // reach (other parts) come first.
    let count = PIVOTS.min(n).min((DISTANCES / n.max(1)).max(2));
    let mut pivots: Vec<(usize, Vec<u32>)> = Vec::with_capacity(count);
    let mut nearest = vec![u32::MAX; n];
    let mut next = (0..n).max_by_key(|&v| degree(v)).unwrap_or(0);
    while pivots.len() < count {
        let distance = hops(next, offsets, targets);
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
        let closest = pivots.iter().enumerate().map(|(p, (_, d))| (p, d[v])).filter(|&(_, d)| d != u32::MAX);
        if let Some((p, d)) = closest.min_by_key(|&(_, d)| d) {
            regions[p].push(d);
        }
    }
    for region in &mut regions {
        region.sort_unstable();
    }
    let weight = 1.0 / (gap * gap);
    (0..n)
        .map(|v| {
            let mut own: Vec<(u32, f64, f64)> =
                targets[offsets[v] as usize..offsets[v + 1] as usize].iter().map(|&w| (w, gap, weight)).collect();
            for (p, (pivot, distance)) in pivots.iter().enumerate() {
                let d = distance[v];
                if *pivot == v || d == u32::MAX || d <= 1 {
                    continue;
                }
                let held = regions[p].partition_point(|&r| 2 * r <= d).max(1) as f64;
                let apart = gap * f64::from(d);
                own.push((*pivot as u32, apart, held / (apart * apart)));
            }
            own
        })
        .collect()
}

/// Where stress starts each vertex. In a part with pinned vertices, each free vertex starts on a
/// golden-angle spiral around its nearest pinned vertex, a gap per hop away. A part with no pinned
/// vertex starts on a spiral around its most linked vertex, and such parts pack in rows below the
/// pinned vertices.
fn start(level: &Level, gap: f64, offsets: &[u32], targets: &[u32]) -> Vec<[f64; 2]> {
    let n = level.sizes.len();
    let mut start = vec![[0.0; 2]; n];
    let mut part = vec![u32::MAX; n];
    let mut parts: Vec<Vec<usize>> = Vec::new();
    let mut order: Vec<usize> = (0..n).collect();
    crate::order::by_key(&mut order, |&v| {
        crate::order::pair(u32::from(level.pinned[v].is_none()), !(offsets[v + 1] - offsets[v]))
    });
    for &root in &order {
        if part[root] != u32::MAX {
            continue;
        }
        let id = parts.len() as u32;
        part[root] = id;
        let mut inside = vec![root];
        let mut k = 0;
        while k < inside.len() {
            let v = inside[k];
            k += 1;
            for &w in &targets[offsets[v] as usize..offsets[v + 1] as usize] {
                if part[w as usize] == u32::MAX {
                    part[w as usize] = id;
                    inside.push(w as usize);
                }
            }
        }
        parts.push(inside);
    }
    let mut loose: Vec<(usize, [f64; 2])> = Vec::new();
    let spiral = |v: usize, hops: u32| {
        let angle = v as f64 * 2.399_963_229_728_653;
        let radius = gap * f64::from(hops) + gap * 0.1 * (v % 7) as f64;
        [radius * angle.cos(), radius * angle.sin()]
    };
    for (p, inside) in parts.iter().enumerate() {
        let pins: Vec<[f64; 2]> = inside.iter().filter_map(|&v| level.pinned[v]).collect();
        // Hops from the pinned vertices, or else from the part's first vertex, its most linked.
        let sources: Vec<usize> = if pins.is_empty() {
            vec![inside[0]]
        } else {
            inside.iter().copied().filter(|&v| level.pinned[v].is_some()).collect()
        };
        let mut hop = vec![u32::MAX; n];
        let mut from = vec![usize::MAX; n];
        let mut queue: VecDeque<usize> = VecDeque::new();
        for &s in &sources {
            hop[s] = 0;
            from[s] = s;
            queue.push_back(s);
        }
        while let Some(v) = queue.pop_front() {
            for &w in &targets[offsets[v] as usize..offsets[v + 1] as usize] {
                if hop[w as usize] == u32::MAX {
                    hop[w as usize] = hop[v] + 1;
                    from[w as usize] = from[v];
                    queue.push_back(w as usize);
                }
            }
        }
        if pins.is_empty() {
            let mut reach: f64 = 0.0;
            for &v in inside {
                start[v] = spiral(v, hop[v]);
                reach = reach.max(start[v][0].hypot(start[v][1]));
            }
            loose.push((p, [2.0 * reach + gap, 2.0 * reach + gap]));
            continue;
        }
        for &v in inside {
            start[v] = level.pinned[v].unwrap_or_else(|| {
                let anchor = level.pinned[from[v]].unwrap_or(pins[0]);
                let offset = spiral(v, hop[v]);
                [anchor[0] + offset[0], anchor[1] + offset[1]]
            });
        }
    }
    if loose.is_empty() {
        return start;
    }
    // Parts with no pinned vertex pack in rows below the pinned vertices.
    let pinned: Vec<[f64; 2]> = level.pinned.iter().flatten().copied().collect();
    let below = pinned.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
    let left = pinned.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
    let origin = if pinned.is_empty() { [0.0, 0.0] } else { [left, below - 2.0 * gap] };
    let boxes: Vec<[f64; 2]> = loose.iter().map(|(_, b)| *b).collect();
    for ((p, size), corner) in loose.iter().zip(pack(&boxes, gap, 16.0 / 9.0)) {
        let center = [origin[0] + corner[0] + size[0] / 2.0, origin[1] + corner[1] - size[1] / 2.0];
        for &v in &parts[*p] {
            start[v] = [center[0] + start[v][0], center[1] + start[v][1]];
        }
    }
    start
}

/// Each vertex's neighbors, each once, ignoring direction, self-links, and links out of range: as
/// offsets into one list of targets.
fn neighbors(n: usize, links: &[[u32; 2]]) -> (Vec<u32>, Vec<u32>) {
    let mut pairs: Vec<(u32, u32)> = links
        .iter()
        .filter(|[a, b]| a != b && (*a as usize) < n && (*b as usize) < n)
        .flat_map(|&[a, b]| [(a, b), (b, a)])
        .collect();
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

/// Hop counts from `from` to every vertex; `u32::MAX` where unreachable.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn apart(a: [f64; 2], b: [f64; 2]) -> f64 {
        (a[0] - b[0]).hypot(a[1] - b[1])
    }

    /// `sizes` laid out by stress with `links`, `pinned`, and `groups` (groups pad members by 5).
    fn laid(
        sizes: &[[f64; 2]],
        links: &[[u32; 2]],
        pinned: &[Option<[f64; 2]>],
        groups: &[Option<u32>],
        gap: f64,
    ) -> Vec<[f64; 2]> {
        let pads = vec![[5.0; 4]; sizes.len()];
        stress(&Graph { sizes, links, pinned, groups, pads: &pads }, gap)
    }

    #[test]
    fn neighbors_settle_a_gap_apart_and_leaves_spread() {
        // A chain 0 → 1 → 2 and a branch 1 → 3.
        let p = laid(&[[4.0, 4.0]; 4], &[[0, 1], [1, 2], [1, 3]], &[None; 4], &[None; 4], 40.0);
        for (a, b) in [(0, 1), (1, 2), (1, 3)] {
            assert!((apart(p[a], p[b]) - 40.0).abs() < 14.0, "{a}–{b}: {p:?}");
        }
        assert!(apart(p[2], p[3]) > 56.0, "leaves spread: {p:?}");
    }

    #[test]
    fn pins_stay_put_and_boxes_do_not_overlap() {
        let pinned = [Some([-100.0, 60.0]), None, None, None];
        let p = laid(&[[60.0, 20.0]; 4], &[[0, 1], [1, 2], [1, 3]], &pinned, &[None; 4], 10.0);
        assert_eq!(p[0], [-100.0, 60.0]);
        for i in 0..4 {
            for j in i + 1..4 {
                let (dx, dy) = ((p[i][0] - p[j][0]).abs(), (p[i][1] - p[j][1]).abs());
                assert!(dx >= 60.0 || dy >= 20.0, "{i} and {j} overlap: {p:?}");
            }
        }
    }

    #[test]
    fn group_boxes_do_not_overlap() {
        // Groups 0 and 1 hold three linked vertices each, and link through their members.
        let sizes =
            [[0.0; 2], [0.0; 2], [20.0, 10.0], [20.0, 10.0], [20.0, 10.0], [20.0, 10.0], [20.0, 10.0], [20.0, 10.0]];
        let groups = [None, None, Some(0), Some(0), Some(0), Some(1), Some(1), Some(1)];
        let links = [[2, 3], [3, 4], [5, 6], [6, 7], [4, 5]];
        let p = laid(&sizes, &links, &[None; 8], &groups, 40.0);
        let frame = |members: &[usize]| {
            let boxes = members.iter().map(|&m| super::super::levels::frame(p[m], sizes[m]));
            let b = super::super::levels::bounds(boxes);
            [b[0] - 5.0, b[1] - 5.0, b[2] + 5.0, b[3] + 5.0]
        };
        let (a, b) = (frame(&[2, 3, 4]), frame(&[5, 6, 7]));
        let overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        assert!(!overlap, "the groups' boxes do not overlap: {a:?} {b:?}");
    }
}
