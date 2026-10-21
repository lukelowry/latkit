//! Nested graphs laid out a level at a time. A level is the vertices of the top, or the members of
//! one group. A group's members are placed first, innermost groups first; the group then stands as
//! one vertex of its box's size in the level holding it, with links between members of different
//! groups lifted to the groups they meet in. Every layout places one level at a time, so every
//! layout nests alike.

use std::cmp::Reverse;

/// A graph to lay out, plane units with y up: each vertex's width and height, its center when it has
/// one, the group holding it, and how far a group's box reaches past its members (left, bottom,
/// right, top); and links between vertices, from one to another where a layout reads direction.
pub(crate) struct Graph<'a> {
    pub(crate) sizes: &'a [[f64; 2]],
    pub(crate) links: &'a [[u32; 2]],
    pub(crate) pinned: &'a [Option<[f64; 2]>],
    pub(crate) groups: &'a [Option<u32>],
    pub(crate) pads: &'a [[f64; 4]],
}

/// One level to place: its vertices' sizes and pins, and the links among them, by index within it.
pub(crate) struct Level {
    pub(crate) sizes: Vec<[f64; 2]>,
    pub(crate) links: Vec<[u32; 2]>,
    pub(crate) pinned: Vec<Option<[f64; 2]>>,
}

/// Every vertex's center, `place` answering each level's. A group's center is the middle of its box:
/// its members' bounds grown by its pads. A pinned member holds its group where its members settled;
/// a group's own pin moves its members only when none of them is pinned. Groups out of range, of
/// themselves, or closing a cycle hold nothing.
pub(crate) fn nested(graph: &Graph<'_>, mut place: impl FnMut(&Level) -> Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let count = graph.sizes.len();
    assert!(
        graph.pinned.len() == count && graph.groups.len() == count && graph.pads.len() == count,
        "a pin, a group, and pads for each vertex"
    );
    let parent = tree(graph.groups);
    let depth = depths(&parent);
    // Level 0 is the top, then the groups innermost first.
    let mut holds = vec![false; count];
    for &group in parent.iter().flatten() {
        holds[group as usize] = true;
    }
    let mut groups: Vec<usize> = (0..count).filter(|&group| holds[group]).collect();
    groups.sort_by_key(|&group| Reverse(depth[group]));
    let mut level = vec![0; count];
    for (k, &group) in groups.iter().enumerate() {
        level[group] = k + 1;
    }
    let level_of = |vertex: usize| parent[vertex].map_or(0, |group| level[group as usize]);
    let members = Runs::new(groups.len() + 1, (0..count).map(|vertex| (level_of(vertex), vertex as u32)));
    let lifted: Vec<[u32; 2]> = graph.links.iter().filter_map(|&[from, to]| lift(from, to, &parent, &depth)).collect();
    let links = Runs::new(groups.len() + 1, lifted.iter().map(|&link| (level_of(link[0] as usize), link)));

    let mut sizes: Vec<[f64; 2]> =
        graph.sizes.iter().map(|&[width, height]| [width.max(0.0), height.max(0.0)]).collect();
    let mut pins: Vec<Option<[f64; 2]>> =
        graph.pinned.iter().map(|pin| pin.filter(|at| at[0].is_finite() && at[1].is_finite())).collect();
    // Centers within each vertex's level, and each group's members' middle within its own.
    let mut centers = vec![[0.0; 2]; count];
    let mut middles = vec![[0.0; 2]; count];
    let mut local = vec![0_u32; count];
    let mut lay = |inside: &[u32], joins: &[[u32; 2]], sizes: &[[f64; 2]], pins: &[Option<[f64; 2]>]| {
        for (i, &vertex) in inside.iter().enumerate() {
            local[vertex as usize] = i as u32;
        }
        let level = Level {
            sizes: inside.iter().map(|&vertex| sizes[vertex as usize]).collect(),
            links: joins.iter().map(|&[from, to]| [local[from as usize], local[to as usize]]).collect(),
            pinned: inside.iter().map(|&vertex| pins[vertex as usize]).collect(),
        };
        place(&level)
    };
    for (k, &group) in groups.iter().enumerate() {
        let inside = members.get(k + 1);
        for (&vertex, center) in inside.iter().zip(lay(inside, links.get(k + 1), &sizes, &pins)) {
            centers[vertex as usize] = center;
        }
        let bounds = bounds(inside.iter().map(|&vertex| frame(centers[vertex as usize], sizes[vertex as usize])));
        let [left, bottom, right, top] = graph.pads[group];
        let grown = [bounds[0] - left, bounds[1] - bottom, bounds[2] + right, bounds[3] + top];
        middles[group] = [grown[0].midpoint(grown[2]), grown[1].midpoint(grown[3])];
        sizes[group] = [grown[2] - grown[0], grown[3] - grown[1]];
        if inside.iter().any(|&vertex| pins[vertex as usize].is_some()) {
            pins[group] = Some(middles[group]);
        }
    }
    let top = members.get(0);
    for (&vertex, center) in top.iter().zip(lay(top, links.get(0), &sizes, &pins)) {
        centers[vertex as usize] = center;
    }
    // Each group's members move with it, outermost first.
    let mut shifts = vec![[0.0; 2]; count];
    for &group in groups.iter().rev() {
        let outer = parent[group].map_or([0.0; 2], |up| shifts[up as usize]);
        shifts[group] =
            [centers[group][0] + outer[0] - middles[group][0], centers[group][1] + outer[1] - middles[group][1]];
    }
    centers
        .iter()
        .zip(&parent)
        .map(|(center, group)| {
            let shift = group.map_or([0.0; 2], |group| shifts[group as usize]);
            [center[0] + shift[0], center[1] + shift[1]]
        })
        .collect()
}

/// Each vertex's group: groups out of range or of themselves dropped, and each cycle of groups cut where a walk up it
/// closes.
fn tree(groups: &[Option<u32>]) -> Vec<Option<u32>> {
    const NEW: u8 = 0;
    const WALKING: u8 = 1;
    const DONE: u8 = 2;
    let count = groups.len();
    let mut parent: Vec<Option<u32>> = groups
        .iter()
        .enumerate()
        .map(|(vertex, group)| group.filter(|&group| (group as usize) < count && group as usize != vertex))
        .collect();
    let mut state = vec![NEW; count];
    let mut walk: Vec<usize> = Vec::new();
    for start in 0..count {
        let mut at = start;
        loop {
            if state[at] != NEW {
                if state[at] == WALKING {
                    parent[*walk.last().expect("a walk reaches itself only after a step")] = None;
                }
                break;
            }
            state[at] = WALKING;
            walk.push(at);
            match parent[at] {
                Some(group) => at = group as usize,
                None => break,
            }
        }
        for vertex in walk.drain(..) {
            state[vertex] = DONE;
        }
    }
    parent
}

/// How many groups hold each vertex.
fn depths(parent: &[Option<u32>]) -> Vec<u32> {
    let mut depth = vec![u32::MAX; parent.len()];
    let mut walk: Vec<usize> = Vec::new();
    for start in 0..parent.len() {
        let mut at = start;
        while depth[at] == u32::MAX {
            walk.push(at);
            match parent[at] {
                Some(group) => at = group as usize,
                None => break,
            }
        }
        // The walk ends at a vertex already counted, or at the top, which it holds.
        let mut next = if depth[at] == u32::MAX { 0 } else { depth[at] + 1 };
        while let Some(vertex) = walk.pop() {
            depth[vertex] = next;
            next += 1;
        }
    }
    depth
}

/// The link `from` → `to` between the outermost groups (or vertices) that hold each end and share a level; `None` for
/// a link within one of them or with an end out of range.
fn lift(from: u32, to: u32, parent: &[Option<u32>], depth: &[u32]) -> Option<[u32; 2]> {
    if from as usize >= parent.len() || to as usize >= parent.len() {
        return None;
    }
    let up = |vertex: usize| parent[vertex].expect("a held vertex has a group") as usize;
    let (mut from, mut to) = (from as usize, to as usize);
    while depth[from] > depth[to] {
        from = up(from);
    }
    while depth[to] > depth[from] {
        to = up(to);
    }
    while parent[from] != parent[to] {
        (from, to) = (up(from), up(to));
    }
    (from != to).then_some([from as u32, to as u32])
}

/// The box of a vertex centered at `center`: its least x and y, then its greatest.
pub(crate) fn frame(center: [f64; 2], size: [f64; 2]) -> [f64; 4] {
    let half = [size[0] / 2.0, size[1] / 2.0];
    [center[0] - half[0], center[1] - half[1], center[0] + half[0], center[1] + half[1]]
}

/// The box holding `boxes`; a point at the origin for none.
pub(crate) fn bounds(boxes: impl Iterator<Item = [f64; 4]>) -> [f64; 4] {
    boxes.reduce(super::rect::union).unwrap_or([0.0; 4])
}

/// Items bucketed by key, each bucket's in the order given: bucket `k` is `items[offsets[k]..offsets[k + 1]]`.
pub(crate) struct Runs<T> {
    offsets: Vec<usize>,
    /// Every bucket's items, bucket after bucket; reordered within buckets, they stay bucketed.
    pub(crate) items: Vec<T>,
}

impl<T: Copy + Default> Runs<T> {
    /// `keyed` items in `buckets` buckets, each item's key below `buckets`.
    pub(crate) fn new(buckets: usize, keyed: impl Iterator<Item = (usize, T)> + Clone) -> Runs<T> {
        let mut offsets = vec![0; buckets + 1];
        for (key, _) in keyed.clone() {
            offsets[key] += 1;
        }
        let mut total = 0;
        for offset in &mut offsets {
            (*offset, total) = (total, total + *offset);
        }
        let mut items = vec![T::default(); total];
        let mut fill = offsets.clone();
        for (key, item) in keyed {
            items[fill[key]] = item;
            fill[key] += 1;
        }
        Runs { offsets, items }
    }
}

impl<T> Runs<T> {
    /// How many buckets.
    pub(crate) fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    /// Bucket `k`'s items.
    pub(crate) fn get(&self, k: usize) -> &[T] {
        &self.items[self.offsets[k]..self.offsets[k + 1]]
    }

    /// Bucket `k`'s items, to change.
    pub(crate) fn get_mut(&mut self, k: usize) -> &mut [T] {
        &mut self.items[self.offsets[k]..self.offsets[k + 1]]
    }
}

impl<T: Ord> Runs<T> {
    /// Sorts the items within each bucket.
    pub(crate) fn sort_each(&mut self) {
        for k in 0..self.len() {
            self.get_mut(k).sort_unstable();
        }
    }
}
