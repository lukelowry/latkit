//! A spatial index of boxes that change: a packed R-tree whose leaves refit as their boxes change,
//! plus a list of items given boxes since packing, which every query also scans until there are
//! enough to repack. Queries and changes take about O(log n), and the root holds the extent of all
//! boxes, so keeping the index current never walks every box (except when repacking).

use super::rect::{EMPTY, Rect, meets, union, valid};

/// Children per node.
const NODE: usize = 16;

/// How many items may get boxes after packing before the index is repacked.
const FRESH: usize = 64;

/// Boxes by item (`EMPTY` where an item has none), with a spatial index.
pub(crate) struct Boxes {
    rects: Vec<Rect>,
    index: Index,
    /// Each item's leaf; `usize::MAX` for an item that had no box when packed.
    leaves: Vec<usize>,
    /// Items given a box since packing; they have no leaf.
    fresh: Vec<usize>,
}

impl Default for Boxes {
    fn default() -> Boxes {
        Boxes::new(Vec::new())
    }
}

impl Boxes {
    /// Packs `boxes`, by item, into a new index.
    pub(crate) fn new(boxes: Vec<Rect>) -> Boxes {
        let index = Index::new(&boxes);
        let mut leaves = vec![usize::MAX; boxes.len()];
        for (leaf, &item) in index.items.iter().enumerate() {
            leaves[item] = leaf;
        }
        Boxes { rects: boxes, index, leaves, fresh: Vec::new() }
    }

    /// Sets item `item`'s box to `rect` (`EMPTY` for none), adding items as needed.
    pub(crate) fn set(&mut self, item: usize, rect: Rect) {
        if item >= self.rects.len() {
            self.rects.resize(item + 1, EMPTY);
            self.leaves.resize(item + 1, usize::MAX);
        }
        if self.rects[item] == rect {
            return;
        }
        self.rects[item] = rect;
        match self.leaves[item] {
            usize::MAX if valid(&rect) && !self.fresh.contains(&item) => {
                self.fresh.push(item);
                if self.fresh.len() > FRESH {
                    *self = Boxes::new(std::mem::take(&mut self.rects));
                }
            }
            usize::MAX => {}
            leaf => self.index.refit(leaf, if valid(&rect) { rect } else { EMPTY }),
        }
    }

    /// Item `item`'s box, where it has one.
    pub(crate) fn get(&self, item: usize) -> Option<Rect> {
        self.rects.get(item).copied().filter(valid)
    }

    /// Visits the items whose boxes meet `region` until `visit` returns true. Returns whether it
    /// did.
    pub(crate) fn some(&self, region: Rect, visit: &mut impl FnMut(usize) -> bool) -> bool {
        let mut seen = |item: usize| self.get(item).is_some_and(|b| meets(&b, &region)) && visit(item);
        self.index.some(region, &mut seen) || self.fresh.iter().any(|&item| seen(item))
    }

    /// The box around all boxes.
    pub(crate) fn extent(&self) -> Rect {
        self.fresh.iter().fold(self.index.root(), |extent, &item| union(extent, self.rects[item]))
    }

    /// Every item's box, `EMPTY` where it has none, in the form a job takes them.
    pub(crate) fn all(&self) -> &[Rect] {
        &self.rects
    }
}

/// A packed R-tree over the valid boxes: leaves sorted in Z-order of their centers, [`NODE`]
/// children per node.
struct Index {
    /// The item at each leaf.
    items: Vec<usize>,
    /// Each node's box: the leaves, then each level up to the root.
    nodes: Vec<Rect>,
    /// Where each level's nodes start, leaves first; the last is the node count.
    starts: Vec<usize>,
}

impl Index {
    /// An index over `boxes`, leaving out those that are not [`valid`].
    fn new(boxes: &[Rect]) -> Index {
        let mut items: Vec<usize> = (0..boxes.len()).filter(|&item| valid(&boxes[item])).collect();
        let extent = items.iter().fold(EMPTY, |extent, &item| union(extent, boxes[item]));
        let cell =
            |v: f64, lo: f64, hi: f64| if hi > lo { ((v - lo) / (hi - lo) * f64::from(u16::MAX)) as u32 } else { 0 };
        crate::order::by_key(&mut items, |&item| {
            let middle = [boxes[item][0].midpoint(boxes[item][2]), boxes[item][1].midpoint(boxes[item][3])];
            let at = morton(cell(middle[0], extent[0], extent[2]), cell(middle[1], extent[1], extent[3]));
            crate::order::pair(at, item as u32)
        });
        let mut nodes: Vec<Rect> = items.iter().map(|&item| boxes[item]).collect();
        let mut starts = vec![0];
        let mut level = 0;
        loop {
            let next = nodes.len();
            starts.push(next);
            for first in (level..next).step_by(NODE) {
                let node = nodes[first..(first + NODE).min(next)].iter().fold(EMPTY, |node, child| union(node, *child));
                nodes.push(node);
            }
            if nodes.len() - next <= 1 {
                break;
            }
            level = next;
        }
        starts.push(nodes.len());
        Index { items, nodes, starts }
    }

    /// Visits the items meeting `region` until `visit` returns true. Returns whether it did.
    fn some(&self, region: Rect, visit: &mut impl FnMut(usize) -> bool) -> bool {
        let top = self.starts.len() - 2;
        !self.items.is_empty()
            && meets(&self.nodes[self.starts[top]], &region)
            && self.descend(top, self.starts[top], region, visit)
    }

    /// [`Index::some`] within the subtree of `node` at `level`.
    fn descend(&self, level: usize, node: usize, region: Rect, visit: &mut impl FnMut(usize) -> bool) -> bool {
        let first = self.starts[level - 1] + (node - self.starts[level]) * NODE;
        let last = (first + NODE).min(self.starts[level]);
        (first..last).any(|child| {
            meets(&self.nodes[child], &region)
                && if level > 1 { self.descend(level - 1, child, region, visit) } else { visit(self.items[child]) }
        })
    }

    /// Sets leaf `leaf`'s box to `rect`, and refits every node above it to its children.
    fn refit(&mut self, leaf: usize, rect: Rect) {
        self.nodes[leaf] = rect;
        let mut child = leaf;
        for level in 1..self.starts.len() - 1 {
            let parent = self.starts[level] + (child - self.starts[level - 1]) / NODE;
            let first = self.starts[level - 1] + (parent - self.starts[level]) * NODE;
            let last = (first + NODE).min(self.starts[level]);
            self.nodes[parent] = self.nodes[first..last].iter().fold(EMPTY, |node, child| union(node, *child));
            child = parent;
        }
    }

    /// The box around its leaves.
    fn root(&self) -> Rect {
        if self.items.is_empty() { EMPTY } else { self.nodes[self.starts[self.starts.len() - 2]] }
    }
}

/// Position along a Z-order curve on a 65536² grid.
fn morton(x: u32, y: u32) -> u32 {
    let spread = |v: u32| {
        let v = v & 0xffff;
        let v = (v | (v << 8)) & 0x00ff_00ff;
        let v = (v | (v << 4)) & 0x0f0f_0f0f;
        let v = (v | (v << 2)) & 0x3333_3333;
        (v | (v << 1)) & 0x5555_5555
    };
    spread(x) | (spread(y) << 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::rect::grow;

    /// The next pseudo-random whole number below `n`, from `seed`.
    fn random(seed: &mut u64, n: u32) -> f64 {
        *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        f64::from(((*seed >> 33) % u64::from(n)) as u32)
    }

    /// A random box within 1000 units, at most 30 across.
    fn somewhere(seed: &mut u64) -> Rect {
        let [x, y] = [random(seed, 1000), random(seed, 1000)];
        [x, y, x + random(seed, 30), y + random(seed, 30)]
    }

    #[test]
    fn queries_and_extent_match_a_brute_force_scan_after_edits() {
        let mut seed = 3;
        let mut all: Vec<Rect> = (0..500).map(|_| somewhere(&mut seed)).collect();
        let mut boxes = Boxes::new(all.clone());
        for round in 0..300 {
            // A box moves, is removed, or is added past the last item.
            let item = random(&mut seed, 560) as usize;
            let rect = if round % 7 == 0 { EMPTY } else { somewhere(&mut seed) };
            if item >= all.len() {
                all.resize(item + 1, EMPTY);
            }
            all[item] = rect;
            boxes.set(item, rect);
            let region = grow(somewhere(&mut seed), 40.0);
            let mut found = Vec::new();
            boxes.some(region, &mut |item| {
                found.push(item);
                false
            });
            found.sort_unstable();
            let want: Vec<usize> = (0..all.len()).filter(|&i| valid(&all[i]) && meets(&all[i], &region)).collect();
            assert_eq!(found, want, "round {round}");
            let extent = all.iter().filter(|r| valid(r)).fold(EMPTY, |e, &r| union(e, r));
            assert_eq!(boxes.extent(), extent, "round {round}");
        }
    }
}
