//! Overlap removal: pushes points apart until no two are within a clearance of each other along
//! both axes.

use rustc_hash::FxHashMap;

/// Rounds of pairwise pushing before a sweep separates the points still too close.
const ROUNDS: usize = 40;

/// Each point once no two of `points` are within `clearance` of each other along both x and y.
/// Pinned points never move, and two pinned points may still be close.
///
/// First come rounds of pushing. A pair too close parts along the axis where it is closer to clear.
/// Each point moves half the shortfall, or the free point moves all of it when the other is pinned.
/// This moves points least, but a crowd can jam. If close pairs remain after `ROUNDS`, a sweep
/// places the free points in order of x after the pinned ones. Each is pushed right past any placed
/// point it is too close to. Pairs are found in a grid of cells `clearance` wide, so each round and
/// the sweep are linear in the number of points.
pub(crate) fn separate(points: &[[f64; 2]], pinned: &[bool], clearance: f64) -> Vec<[f64; 2]> {
    let mut centers = points.to_vec();
    if clearance <= 0.0 {
        return centers;
    }
    let grid = Grid { cell: clearance };
    // Shortfalls this small are rounding error.
    let slack = clearance * 1e-9;
    let short = |centers: &[[f64; 2]], i: usize, j: usize| {
        let over = [0, 1].map(|k| clearance - (centers[j][k] - centers[i][k]).abs());
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
                let Some(over) = short(&centers, i, j) else { continue };
                let d = [0, 1].map(|k| centers[j][k] - centers[i][k]);
                // Coincident points part along x or y, alternating with the parity of `i + j`.
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
    crate::order::by_key(&mut order, |&a| crate::order::number(centers[a][0]));
    grid.fill(&mut cells, &centers, (0..centers.len()).filter(|&i| pinned[i]));
    for i in order {
        // Push it right past the placed points it is too close to until it is clear of all.
        while let Some(x) = grid
            .near(&cells, centers[i])
            .filter_map(|j| short(&centers, j, i).map(|_| centers[j][0] + clearance))
            .reduce(f64::max)
        {
            centers[i][0] = x;
        }
        cells.entry(grid.key(centers[i])).or_default().push(i as u32);
    }
    centers
}

/// A grid of square cells holding points, as wide as the clearance, so points too close are in the
/// same or neighboring cells.
struct Grid {
    cell: f64,
}

impl Grid {
    fn key(&self, c: [f64; 2]) -> (i64, i64) {
        ((c[0] / self.cell).floor() as i64, (c[1] / self.cell).floor() as i64)
    }

    /// Empties `cells`, then fills them with the points `which`.
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

    /// The points in the 3 × 3 cells around `at`.
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

    fn clear(centers: &[[f64; 2]], clearance: f64) -> bool {
        (0..centers.len()).all(|i| {
            (i + 1..centers.len()).all(|j| (0..2).any(|k| (centers[i][k] - centers[j][k]).abs() >= clearance - 1e-6))
        })
    }

    #[test]
    fn a_pair_separates_along_its_smaller_shortfall() {
        // 4 apart across and 1 along, with a clearance of 10: across falls 6 short, along 9.
        let centers = separate(&[[0.0, 0.0], [4.0, 1.0]], &[false, false], 10.0);
        assert_eq!(centers, vec![[-3.0, 0.0], [7.0, 1.0]]);
    }

    #[test]
    fn pinned_points_stay_put() {
        let centers = separate(&[[0.0, 0.0], [5.0, 0.0]], &[true, false], 10.0);
        assert_eq!(centers, vec![[0.0, 0.0], [10.0, 0.0]]);
    }

    #[test]
    fn a_crowd_at_one_point_spreads_until_all_are_clear() {
        let points = vec![[0.0; 2]; 60];
        let pinned: Vec<bool> = (0..60).map(|i| i == 7).collect();
        let centers = separate(&points, &pinned, 2.0);
        assert!(clear(&centers, 2.0), "{centers:?}");
        assert_eq!(centers[7], [0.0, 0.0], "the pinned point stays put");
    }
}
