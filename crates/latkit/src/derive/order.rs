//! Draw orders of paged tables.
//!
//! A mark lays out every per-row input and every per-row GPU word of a paged table in pages of its
//! order. Choosing tiles then chooses ranges of pages, so nothing is gathered as the camera moves.
//!
//! Until its pyramid arrives, a table draws an even sample of its rows first. The rows that sampled
//! edges end at come before the sample, as a pyramid would show them with those edges. A pyramid
//! serves while the rows it was made from are unchanged; rows appended since draw after them, in
//! table order.
//!
//! A table of vector tiles draws in table order, its tiles' rows appended as they arrive, so its
//! tiles are already ranges of its order and appending moves no row.

use std::sync::Arc;

use super::pyramid::Pyramid;
use super::stamp_of;
use crate::data::Version;
use crate::gpu::shaders::PAGE_ROWS;

/// A paged table's draw order: which row draws at each place.
#[derive(Clone, Debug)]
pub(crate) enum Order {
    /// The rows in `lifted` first; then every `step`th row of the table's `rows` rows (those at
    /// multiples of `step`) not lifted; then the remaining rows. Each group is in table order.
    Sampled { rows: u32, step: u32, lifted: Lifted },
    /// A pyramid's order of the table's first rows, then the rows appended since, in table order,
    /// up to `rows` rows.
    Pyramid { pyramid: Arc<Pyramid>, rows: u32 },
    /// The table's `rows` rows in table order, while its row order version (`Table::order`) is
    /// `order`. Rows appended draw after the rest; removing rows changes the version, and so the
    /// order.
    Table { rows: u32, order: Version },
}

/// The rows a sample draws before its own: the rows the sampled edges end at, just as a pyramid
/// shows a vertex at least as coarse as the coarsest edge ending at it. Holds the rows ascending,
/// each row's place in the plain sample (without lifted rows) ascending, and a stamp of the rows.
#[derive(Clone, Debug, Default)]
pub(crate) struct Lifted {
    rows: Arc<[u32]>,
    places: Arc<[u32]>,
    stamp: u64,
}

impl Lifted {
    /// Lifts `rows` of a table of `len` rows into a sample of `sample` rows. The lifted rows count
    /// toward the sample; returns them with the step of the even sample that fills the rest.
    pub(crate) fn within(rows: Vec<u32>, len: u32, sample: u32) -> (Lifted, u32) {
        let rows = ascending(rows, len);
        let step = len.div_ceil(sample.saturating_sub(rows.len() as u32).max(1)).max(1);
        (Lifted::new(rows, len, step), step)
    }

    /// Lifts `rows` of a table of `len` rows into a sample taking every `step`th row.
    fn new(rows: Vec<u32>, len: u32, step: u32) -> Lifted {
        let rows = ascending(rows, len);
        let mut places: Vec<u32> = rows.iter().map(|&r| sample_rank(r, len, step)).collect();
        places.sort_unstable();
        let stamp = stamp_of(&rows);
        Lifted { rows: rows.into(), places: places.into(), stamp }
    }

    fn len(&self) -> u32 {
        self.rows.len() as u32
    }
}

/// The `rows` below `len`, sorted ascending without duplicates.
fn ascending(mut rows: Vec<u32>, len: u32) -> Vec<u32> {
    rows.retain(|&r| r < len);
    rows.sort_unstable();
    rows.dedup();
    rows
}

/// The place of row `r` in an even sample of `rows` rows taking every `step`th: the sampled rows
/// first, then the rest, each in table order.
fn sample_rank(r: u32, rows: u32, step: u32) -> u32 {
    if r.is_multiple_of(step) { r / step } else { rows.div_ceil(step) + r - r / step - 1 }
}

/// The row at place `d` in an even sample of `rows` rows taking every `step`th; the inverse of
/// `sample_rank`.
fn sample_source(d: u32, rows: u32, step: u32) -> u32 {
    let first = rows.div_ceil(step);
    if d < first || step <= 1 {
        return d * step;
    }
    // Past the sample: each step's rows except its first, in table order.
    let k = d - first;
    (k / (step - 1)) * step + k % (step - 1) + 1
}

/// The `e`th place (from 0) missing from `places`, which ascends. A binary search.
fn unlisted(places: &[u32], e: u32) -> u32 {
    let (mut lo, mut hi) = (e, e + places.len() as u32);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        // How many places up to `mid` are missing from `places`.
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
    /// The number of rows it orders: every row of its table.
    pub(crate) fn len(&self) -> u32 {
        match self {
            Order::Sampled { rows, .. } | Order::Pyramid { rows, .. } | Order::Table { rows, .. } => *rows,
        }
    }

    /// The number of pages it spans.
    pub(crate) fn pages(&self) -> u32 {
        self.len().div_ceil(PAGE_ROWS)
    }

    /// How many rows a sample draws first: the lifted rows plus the sample's own. 0 for the other
    /// orders.
    pub(crate) fn sampled(&self) -> u32 {
        match self {
            Order::Sampled { rows, step, lifted } => {
                let first = rows.div_ceil(*step);
                lifted.len() + first - lifted.places.partition_point(|&p| p < first) as u32
            }
            Order::Pyramid { .. } | Order::Table { .. } => 0,
        }
    }

    /// The row drawn at place `d`.
    pub(crate) fn source(&self, d: u32) -> u32 {
        match self {
            Order::Sampled { rows, step, lifted } => match lifted.rows.get(d as usize) {
                Some(&r) => r,
                None => sample_source(unlisted(&lifted.places, d - lifted.len()), *rows, *step),
            },
            Order::Pyramid { pyramid, .. } => pyramid.order.get(d as usize).copied().unwrap_or(d),
            Order::Table { .. } => d,
        }
    }

    /// The place where row `r` draws; the inverse of `source`.
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
            Order::Table { .. } => r,
        }
    }

    /// The rows on page `page`, in order.
    pub(crate) fn page(&self, page: u32) -> Vec<u32> {
        let (start, end) = (page * PAGE_ROWS, ((page + 1) * PAGE_ROWS).min(self.len()));
        let Order::Sampled { rows, step, lifted } = self else { return (start..end).map(|d| self.source(d)).collect() };
        // The page's lifted rows, then the sample's rows in turn, skipping lifted places.
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

    /// The key that identifies pages packed in this order. A pyramid's id ignores rows appended
    /// since, and so does table order's; a sample's depends on its row count, step, and lifted
    /// rows.
    pub(crate) fn id(&self) -> u64 {
        match self {
            Order::Sampled { rows, step, lifted } => stamp_of(("sampled", rows, step, lifted.stamp)),
            Order::Pyramid { pyramid, .. } => stamp_of(pyramid.made),
            Order::Table { order, .. } => stamp_of(("table", order)),
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
            assert_eq!(order.rank(r), d as u32, "row {r}'s rank is its place");
        }
        assert_eq!(order.sampled(), 4);
        assert_eq!(sample(4, 1).page(0), [0, 1, 2, 3], "a step of one keeps table order");
    }

    #[test]
    fn lifted_rows_draw_before_the_sample_and_only_once() {
        // Rows 4 and 6 lifted: 6 was a sample's row, 4 was not.
        let order = Order::Sampled { rows: 10, step: 3, lifted: Lifted::new(vec![6, 4, 6, 12], 10, 3) };
        let drawn: Vec<u32> = (0..10).map(|d| order.source(d)).collect();
        assert_eq!(drawn, [4, 6, 0, 3, 9, 1, 2, 5, 7, 8]);
        for (d, &r) in drawn.iter().enumerate() {
            assert_eq!(order.rank(r), d as u32, "row {r}'s rank is its place");
        }
        assert_eq!(order.sampled(), 5, "2 lifted rows plus 3 sampled rows");
        assert_ne!(order.id(), sample(10, 3).id(), "lifted rows change the order's id");
        // Each page lists the same rows as `source` gives place by place.
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
    fn rows_appended_after_a_pyramid_draw_after_it_in_table_order() {
        let pyramid = Arc::new(Pyramid::new(vec![2, 0, 1], Vec::new()));
        let order = Order::Pyramid { pyramid, rows: 5 };
        assert_eq!(order.page(0), [2, 0, 1, 3, 4]);
        assert_eq!((order.rank(2), order.rank(4)), (0, 4));
    }

    #[test]
    fn table_order_keeps_its_id_while_rows_are_only_appended() {
        let version = Version::next();
        let order = Order::Table { rows: 3, order: version };
        assert_eq!(order.page(0), [0, 1, 2]);
        assert_eq!((order.source(2), order.rank(1), order.sampled()), (2, 1, 0));
        let grown = Order::Table { rows: PAGE_ROWS + 5, order: version };
        assert_eq!(grown.id(), order.id(), "pages packed before rows were appended stay valid");
        assert_eq!(grown.page(1), (PAGE_ROWS..PAGE_ROWS + 5).collect::<Vec<_>>());
        let removed = Order::Table { rows: 2, order: Version::next() };
        assert_ne!(removed.id(), order.id(), "removing rows makes another order");
    }
}
