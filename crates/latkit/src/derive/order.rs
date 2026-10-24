//! Orders: how a table drawn in part draws its rows. Every per-row input a mark reads of such a table,
//! and every per-row word it keeps, lies in pages of its order, so the camera choosing tiles chooses
//! ranges of pages and nothing is gathered as it moves. Until its pyramid lands a table draws an even
//! sample of its rows first, after the rows the edges a sample draws end at, which land with those
//! edges as in a pyramid; a pyramid serves while the rows it was made from hold, the rows appended
//! since drawing after them in their own order.

use std::sync::Arc;

use super::pyramid::Pyramid;
use super::stamp_of;
use crate::gpu::shaders::PAGE_ROWS;

/// Rows a page of an order holds: a held page.

#[derive(Clone, Debug)]
pub(crate) enum Order {
    /// The rows `lifted` lists first; then every `step`th of the rest of a table's `rows` rows, then
    /// the rest, each in their own order.
    Sampled { rows: u32, step: u32, lifted: Lifted },
    /// A pyramid's order of a table's first rows, then the rest of its `rows` rows, appended since,
    /// in their own order.
    Pyramid { pyramid: Arc<Pyramid>, rows: u32 },
}

/// The rows a sample draws before its own, as a pyramid lands a vertex with the coarsest edge ending
/// at it: those the edges a sample draws end at. Ascending, with where each draws in the sample
/// without them, ascending too.
#[derive(Clone, Debug, Default)]
pub(crate) struct Lifted {
    rows: Arc<[u32]>,
    places: Arc<[u32]>,
    stamp: u64,
}

impl Lifted {
    /// `rows` of a table of `len` rows sampled every `step`th.
    pub(crate) fn new(mut rows: Vec<u32>, len: u32, step: u32) -> Lifted {
        rows.retain(|&r| r < len);
        rows.sort_unstable();
        rows.dedup();
        let mut places: Vec<u32> = rows.iter().map(|&r| sample_rank(r, len, step)).collect();
        places.sort_unstable();
        let stamp = stamp_of(&rows);
        Lifted { rows: rows.into(), places: places.into(), stamp }
    }

    fn len(&self) -> u32 {
        self.rows.len() as u32
    }
}

/// Where row `r` draws in an even sample of `rows` rows every `step`th: the sample first, then the
/// rest, each in their own order.
fn sample_rank(r: u32, rows: u32, step: u32) -> u32 {
    if r.is_multiple_of(step) { r / step } else { rows.div_ceil(step) + r - r / step - 1 }
}

/// The row drawn at `d` in an even sample of `rows` rows every `step`th.
fn sample_source(d: u32, rows: u32, step: u32) -> u32 {
    let first = rows.div_ceil(step);
    if d < first || step <= 1 {
        return d * step;
    }
    // Each step's rows but its first, in their own order.
    let k = d - first;
    (k / (step - 1)) * step + k % (step - 1) + 1
}

/// The `e`th place, from 0, that `places`, ascending, does not list.
fn unlisted(places: &[u32], e: u32) -> u32 {
    let (mut lo, mut hi) = (e, e + places.len() as u32);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        // Places up to `mid` it does not list.
        let free = mid + 1 - places.partition_point(|&p| p <= mid) as u32;
        if free > e {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

impl Order {
    /// Rows it orders: every row of its table.
    pub(crate) fn len(&self) -> u32 {
        match self {
            Order::Sampled { rows, .. } | Order::Pyramid { rows, .. } => *rows,
        }
    }

    /// Pages of it.
    pub(crate) fn pages(&self) -> u32 {
        self.len().div_ceil(PAGE_ROWS)
    }

    /// The rows a sample draws first: those lifted, then its own.
    pub(crate) fn sampled(&self) -> u32 {
        match self {
            Order::Sampled { rows, step, lifted } => {
                let first = rows.div_ceil(*step);
                lifted.len() + first - lifted.places.partition_point(|&p| p < first) as u32
            }
            Order::Pyramid { .. } => 0,
        }
    }

    /// The row drawn at `d`.
    pub(crate) fn source(&self, d: u32) -> u32 {
        match self {
            Order::Sampled { rows, step, lifted } => match lifted.rows.get(d as usize) {
                Some(&r) => r,
                None => sample_source(unlisted(&lifted.places, d - lifted.len()), *rows, *step),
            },
            Order::Pyramid { pyramid, .. } => pyramid.order.get(d as usize).copied().unwrap_or(d),
        }
    }

    /// Where row `r` draws.
    pub(crate) fn rank(&self, r: u32) -> u32 {
        match self {
            Order::Sampled { rows, step, lifted } => {
                if let Ok(i) = lifted.rows.binary_search(&r) {
                    return i as u32;
                }
                let place = sample_rank(r, *rows, *step);
                lifted.len() + place - lifted.places.partition_point(|&p| p < place) as u32
            }
            Order::Pyramid { pyramid, .. } => pyramid.rank.get(r as usize).copied().unwrap_or(r),
        }
    }

    /// The rows page `page` holds, in order.
    pub(crate) fn page(&self, page: u32) -> Vec<u32> {
        let (start, end) = (page * PAGE_ROWS, ((page + 1) * PAGE_ROWS).min(self.len()));
        let Order::Sampled { rows, step, lifted } = self else { return (start..end).map(|d| self.source(d)).collect() };
        // The rows lifted it holds, then the sample's in turn, stepping past the places lifted.
        let m = lifted.len();
        let mut out: Vec<u32> =
            lifted.rows.get(start.min(m) as usize..end.min(m) as usize).unwrap_or_default().to_vec();
        if end > m {
            let places = &lifted.places;
            let mut place = unlisted(places, start.max(m) - m);
            let mut next = places.partition_point(|&p| p <= place);
            for _ in start.max(m)..end {
                out.push(sample_source(place, *rows, *step));
                place += 1;
                while places.get(next) == Some(&place) {
                    (place, next) = (place + 1, next + 1);
                }
            }
        }
        out
    }

    /// What pages packed in it are kept by: one pyramid's whatever rows were appended since, a
    /// sample's by its rows and those it lifts.
    pub(crate) fn id(&self) -> u64 {
        match self {
            Order::Sampled { rows, step, lifted } => stamp_of(("sampled", rows, step, lifted.stamp)),
            Order::Pyramid { pyramid, .. } => stamp_of(pyramid.made),
        }
    }
}

impl PartialEq for Order {
    fn eq(&self, other: &Order) -> bool {
        self.id() == other.id() && self.len() == other.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(rows: u32, step: u32) -> Order {
        Order::Sampled { rows, step, lifted: Lifted::default() }
    }

    #[test]
    fn samples_draw_every_step_first_then_the_rest() {
        let order = sample(10, 3);
        let drawn: Vec<u32> = (0..10).map(|d| order.source(d)).collect();
        assert_eq!(drawn, [0, 3, 6, 9, 1, 2, 4, 5, 7, 8]);
        for (d, &r) in drawn.iter().enumerate() {
            assert_eq!(order.rank(r), d as u32, "row {r} draws where its rank says");
        }
        assert_eq!(order.sampled(), 4);
        assert_eq!(sample(4, 1).page(0), [0, 1, 2, 3], "a step of one is the rows' own order");
    }

    #[test]
    fn rows_lifted_draw_before_the_sample_and_leave_it() {
        // Rows 4 and 6 lifted: 6 was a sample's row, 4 was not.
        let order = Order::Sampled { rows: 10, step: 3, lifted: Lifted::new(vec![6, 4, 6, 12], 10, 3) };
        let drawn: Vec<u32> = (0..10).map(|d| order.source(d)).collect();
        assert_eq!(drawn, [4, 6, 0, 3, 9, 1, 2, 5, 7, 8]);
        for (d, &r) in drawn.iter().enumerate() {
            assert_eq!(order.rank(r), d as u32, "row {r} draws where its rank says");
        }
        assert_eq!(order.sampled(), 5, "the rows lifted, then the sample's own");
        assert_ne!(order.id(), sample(10, 3).id(), "pages packed in it are its own");
        // A page steps through the sample past the places lifted, as each row's source finds them.
        let rows = 3 * PAGE_ROWS + 17;
        let lifted = Lifted::new((0..rows).filter(|r| r % 5 == 1 || r % 7 == 0).collect(), rows, 4);
        let order = Order::Sampled { rows, step: 4, lifted };
        for page in 0..order.pages() {
            let one: Vec<u32> =
                (page * PAGE_ROWS..((page + 1) * PAGE_ROWS).min(rows)).map(|d| order.source(d)).collect();
            assert_eq!(order.page(page), one, "page {page}");
        }
    }

    #[test]
    fn rows_appended_after_a_pyramid_draw_after_it_in_their_own_order() {
        let pyramid = Arc::new(Pyramid::new(vec![2, 0, 1], Vec::new()));
        let order = Order::Pyramid { pyramid, rows: 5 };
        assert_eq!(order.page(0), [2, 0, 1, 3, 4]);
        assert_eq!((order.rank(2), order.rank(4)), (0, 4));
    }
}
