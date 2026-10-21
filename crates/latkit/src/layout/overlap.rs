//! Overlap removal: boxes pushed apart until no two come within a clearance of each other.

use rustc_hash::FxHashMap;

/// Rounds of pairwise pushing, before a sweep parts what they leave.
const ROUNDS: usize = 40;

/// Each box's center once no two of `boxes` (center, then half width and height) come within
/// `clearance` of each other, pinned ones aside. First rounds of pushing: a pair too close parts
/// along the axis it overlaps least, each half the way, or a free box all of it when the other is
/// pinned. That moves boxes least, but a crowd jams; a sweep along x then places each box after the
/// pinned ones, in order, right of any placed box it overlaps. Pairs are found in a grid of cells as
/// wide as the widest box, so each round, and the sweep, is linear in the boxes for boxes of like
/// sizes.
pub(crate) fn separate(boxes: &[[f64; 4]], pinned: &[bool], clearance: f64) -> Vec<[f64; 2]> {
    let mut centers: Vec<[f64; 2]> = boxes.iter().map(|b| [b[0], b[1]]).collect();
    let half: Vec<[f64; 2]> = boxes.iter().map(|b| [b[2], b[3]].map(|h| h.max(0.0) + clearance / 2.0)).collect();
    let grid = Grid { cell: 2.0 * half.iter().flatten().copied().fold(1e-9, f64::max) };
    // Overlaps this small are rounding, not overlap.
    let slack = grid.cell * 1e-9;
    let overlap = |centers: &[[f64; 2]], i: usize, j: usize| {
        let over = [0, 1].map(|k| half[i][k] + half[j][k] - (centers[j][k] - centers[i][k]).abs());
        (over[0] > slack && over[1] > slack).then_some(over)
    };
    let mut cells = FxHashMap::default();
    for _ in 0..ROUNDS {
        grid.fill(&mut cells, &centers, 0..centers.len());
        let mut moved = false;
        for i in 0..centers.len() {
            for j in grid.near(&cells, centers[i]) {
                if j <= i || (pinned[i] && pinned[j]) {
                    continue;
                }
                let Some(over) = overlap(&centers, i, j) else { continue };
                let d = [0, 1].map(|k| centers[j][k] - centers[i][k]);
                // Boxes at one point part by their order, across and along by turns.
                let k = if d == [0.0; 2] { (i + j) % 2 } else { usize::from(over[1] < over[0]) };
                let sign = if d[k] == 0.0 { 1.0 } else { d[k].signum() };
                let share = if pinned[i] {
                    0.0
                } else if pinned[j] {
                    1.0
                } else {
                    0.5
                };
                centers[i][k] -= sign * over[k] * share;
                centers[j][k] += sign * over[k] * (1.0 - share);
                moved = true;
            }
        }
        if !moved {
            return centers;
        }
    }
    let mut order: Vec<usize> = (0..centers.len()).filter(|&i| !pinned[i]).collect();
    order.sort_by(|&a, &b| centers[a][0].total_cmp(&centers[b][0]).then(a.cmp(&b)));
    grid.fill(&mut cells, &centers, (0..centers.len()).filter(|&i| pinned[i]));
    for i in order {
        // Right past the placed boxes it overlaps, until it overlaps none.
        while let Some(x) = grid
            .near(&cells, centers[i])
            .filter_map(|j| overlap(&centers, j, i).map(|_| centers[j][0] + half[j][0] + half[i][0]))
            .reduce(f64::max)
        {
            centers[i][0] = x;
        }
        cells.entry(grid.key(centers[i])).or_default().push(i as u32);
    }
    centers
}

/// Square cells of boxes' centers, wide enough that boxes that overlap stand in neighboring cells.
struct Grid {
    cell: f64,
}

impl Grid {
    fn key(&self, c: [f64; 2]) -> (i64, i64) {
        ((c[0] / self.cell).floor() as i64, (c[1] / self.cell).floor() as i64)
    }

    /// Fills `cells` with the boxes `which`.
    fn fill(
        &self,
        cells: &mut FxHashMap<(i64, i64), Vec<u32>>,
        centers: &[[f64; 2]],
        which: impl Iterator<Item = usize>,
    ) {
        cells.values_mut().for_each(Vec::clear);
        for i in which {
            cells.entry(self.key(centers[i])).or_default().push(i as u32);
        }
    }

    /// The boxes in the cells around `at`.
    fn near<'a>(&self, cells: &'a FxHashMap<(i64, i64), Vec<u32>>, at: [f64; 2]) -> impl Iterator<Item = usize> + 'a {
        let (x, y) = self.key(at);
        [-1, 0, 1]
            .into_iter()
            .flat_map(move |dx| [-1, 0, 1].map(|dy| (x + dx, y + dy)))
            .filter_map(|key| cells.get(&key))
            .flatten()
            .map(|&j| j as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear(boxes: &[[f64; 4]], centers: &[[f64; 2]], clearance: f64) -> bool {
        (0..boxes.len()).all(|i| {
            (i + 1..boxes.len()).all(|j| {
                (0..2).any(|k| {
                    (centers[i][k] - centers[j][k]).abs() >= boxes[i][k + 2] + boxes[j][k + 2] + clearance - 1e-6
                })
            })
        })
    }

    #[test]
    fn a_pair_parts_along_its_lesser_overlap() {
        // Each half grows by half the clearance: 12 and 12 overlap 15 apart by 9 across, 22 along.
        let boxes = [[0.0, 0.0, 10.0, 10.0], [15.0, 2.0, 10.0, 10.0]];
        let centers = separate(&boxes, &[false, false], 4.0);
        assert_eq!(centers, vec![[-4.5, 0.0], [19.5, 2.0]]);
    }

    #[test]
    fn pinned_boxes_hold() {
        let boxes = [[0.0, 0.0, 10.0, 10.0], [15.0, 0.0, 10.0, 10.0]];
        let centers = separate(&boxes, &[true, false], 0.0);
        assert_eq!(centers, vec![[0.0, 0.0], [20.0, 0.0]]);
    }

    #[test]
    fn a_crowd_at_one_point_spreads_until_none_overlap() {
        let boxes: Vec<[f64; 4]> = (0..60).map(|i| [0.0, 0.0, 5.0 + f64::from(i % 3), 4.0]).collect();
        let pinned: Vec<bool> = (0..60).map(|i| i == 7).collect();
        let centers = separate(&boxes, &pinned, 2.0);
        assert!(clear(&boxes, &centers, 2.0), "{centers:?}");
        assert_eq!(centers[7], [0.0, 0.0], "the pinned box holds");
    }
}
