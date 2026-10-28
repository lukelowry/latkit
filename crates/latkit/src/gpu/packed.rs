//! Packed pages of paged tables. A paged table's column is packed into the words its marks read,
//! one page of its draw order at a time, the first time a view draws that page. Packed pages are
//! keyed by their source. So views that draw a table the same way share its pages, a page the
//! camera returns to is the same page, and a write repacks only the pages its rows draw in. A table
//! drawn in its own order reads its data's pages directly. The exception is a reference to a table
//! drawn in another order: its pages are packed through that order's ranks.

use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::data::{Column, Name, PageId, Reference, Samples, Table, UNWIRED, Version};
use crate::derive::order::Order;
use crate::expr::compile::Words;
use crate::gpu::arena::page_words;
use crate::gpu::shaders::PAGE_ROWS;
use crate::gpu::shaders::{MISSING, NONE};
use crate::gpu::work::{Count, Counters};

/// Most packed columns kept. Past this, the least recently used half is forgotten.
const KEPT: usize = 4096;

/// The key of one packed column: the order, the dataset (`origin`) and table, the field and how it
/// is read, whether the field is derived beside the table rather than the table's own, and anything
/// else its words depend on (`reads`: a reference's target order, the frame of samples shown, or the
/// rows a join reads).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Packing {
    pub(crate) order: u64,
    pub(crate) origin: Version,
    pub(crate) table: Name,
    pub(crate) field: Name,
    pub(crate) derived: bool,
    pub(crate) words: Words,
    pub(crate) low: bool,
    pub(crate) reads: u64,
}

/// A column's packed pages: their source column, each page's id once packed, the samples gathered
/// for each traced page, and when they were last used.
struct Pages {
    source: Option<Column>,
    ids: Vec<Option<PageId>>,
    samples: Vec<Option<Samples>>,
    used: u64,
}

/// Every packed column, shared by the GPU's views, and the counters for rows packed.
pub(crate) struct Packed {
    counters: Arc<Counters>,
    columns: FxHashMap<Packing, Pages>,
    /// Reference pages of tables drawn in their own order, packed through the ranks of the target
    /// table's draw order. Keyed by page and that order.
    ranked: FxHashMap<(PageId, u64), (PageId, u64)>,
    uses: u64,
}

impl Packed {
    pub(crate) fn new(counters: Arc<Counters>) -> Packed {
        Packed { counters, columns: FxHashMap::default(), ranked: FxHashMap::default(), uses: 0 }
    }

    /// Counts `rows` rows packed.
    pub(crate) fn count(&self, rows: usize) {
        self.counters.add(Count::Packed, rows as u64);
    }

    /// The counters for rows packed, for packing done later.
    pub(crate) fn counters(&self) -> Arc<Counters> {
        self.counters.clone()
    }

    /// The pages of `packing`, packed from the current `source`. A page is kept while none of its
    /// rows was written since. `page_of` maps a row to its page. Without a source, pages are kept
    /// as long as `packing` matches.
    fn pages(
        &mut self,
        packing: &Packing,
        source: Option<&Column>,
        page_of: impl Fn(u32) -> Option<usize>,
    ) -> &mut Pages {
        self.uses += 1;
        if !self.columns.contains_key(packing) && self.columns.len() >= KEPT {
            forget(&mut self.columns, |p| p.used);
        }
        let pages = self.columns.entry(packing.clone()).or_insert_with(|| Pages {
            source: source.cloned(),
            ids: Vec::new(),
            samples: Vec::new(),
            used: 0,
        });
        pages.used = self.uses;
        if let Some(source) = source
            && !pages.source.as_ref().is_some_and(|s| s.shares(source))
        {
            if let Some(before) = &pages.source {
                for page in source.written_since(before).into_iter().filter_map(|row| page_of(row as u32)) {
                    if let Some(id) = pages.ids.get_mut(page) {
                        *id = None;
                    }
                    if let Some(samples) = pages.samples.get_mut(page) {
                        *samples = None;
                    }
                }
            } else {
                pages.ids.clear();
                pages.samples.clear();
            }
            pages.source = Some(source.clone());
        }
        pages
    }

    /// The id of page `page` of `packing`, packed from `source` in `order`.
    pub(crate) fn page(&mut self, packing: &Packing, order: &Order, source: Option<&Column>, page: u32) -> PageId {
        self.pages_of(packing, order, source, &[page])[0]
    }

    /// The ids of pages `wanted` of `packing`, packed from `source` in `order`, looking the column
    /// up once.
    pub(crate) fn pages_of(
        &mut self,
        packing: &Packing,
        order: &Order,
        source: Option<&Column>,
        wanted: &[u32],
    ) -> Vec<PageId> {
        let pages = self.pages(packing, source, |row| Some((order.rank(row) / PAGE_ROWS) as usize));
        wanted
            .iter()
            .map(|&k| {
                let k = k as usize;
                if pages.ids.len() <= k {
                    pages.ids.resize(k + 1, None);
                }
                *pages.ids[k].get_or_insert_with(PageId::next)
            })
            .collect()
    }

    /// The id of `packing`'s page of kept rows, packed from `source`. The page is kept while none
    /// of its rows (those `holds` accepts) was written since.
    pub(crate) fn kept(&mut self, packing: &Packing, source: Option<&Column>, holds: impl Fn(u32) -> bool) -> PageId {
        let pages = self.pages(packing, source, |row| holds(row).then_some(0));
        if pages.ids.is_empty() {
            pages.ids.push(None);
        }
        *pages.ids[0].get_or_insert_with(PageId::next)
    }

    /// The samples of `samples`' rows `rows`, for page `page` of `packing`, gathered once.
    pub(crate) fn samples(&mut self, packing: &Packing, page: u32, rows: &[u32], samples: &Samples) -> Samples {
        let counters = self.counters.clone();
        let pages = self.pages(packing, None, |_| None);
        let k = page as usize;
        if pages.samples.len() <= k {
            pages.samples.resize(k + 1, None);
        }
        pages.samples[k]
            .get_or_insert_with(|| {
                let rows: Vec<usize> = rows.iter().map(|&r| r as usize).collect();
                counters.add(Count::Packed, rows.len() as u64);
                samples.gather(&rows)
            })
            .clone()
    }

    /// The id of reference page `page` of a table drawn in its own order, packed through the ranks
    /// of `order`, the target table's draw order.
    pub(crate) fn ranked(&mut self, page: PageId, order: u64) -> PageId {
        self.uses += 1;
        if self.ranked.len() >= KEPT && !self.ranked.contains_key(&(page, order)) {
            forget(&mut self.ranked, |&(_, used)| used);
        }
        let uses = self.uses;
        let entry = self.ranked.entry((page, order)).or_insert_with(|| (PageId::next(), 0));
        entry.1 = uses;
        entry.0
    }
}

/// Drops the least recently used half of `kept`, by the use time `used` returns.
fn forget<K: Clone + Eq + std::hash::Hash, V>(kept: &mut FxHashMap<K, V>, used: impl Fn(&V) -> u64) {
    let mut uses: Vec<u64> = kept.values().map(&used).collect();
    let half = uses.len() / 2;
    let (_, &mut cut, _) = uses.select_nth_unstable(half);
    kept.retain(|_, v| used(v) > cut);
}

/// A page of words for `column`'s rows `rows`, padded with missing values past the rows.
pub(crate) fn values(column: &Column, rows: &[u32], words: Words, low: bool) -> Vec<u32> {
    let mut out = page_words(&column.pick(rows), words, low);
    out.resize(PAGE_ROWS as usize, if words == Words::Bits { NONE } else { MISSING });
    out
}

/// A page of the target rows that `reference` gives for rows `rows`. Each target is its place in
/// `rank` (its table's draw order), or the row itself when that table is drawn whole. `NONE` where
/// a row references nothing.
pub(crate) fn targets(reference: &Reference, rows: &[u32], rank: Option<&Order>) -> Vec<u32> {
    let mut out: Vec<u32> = rows
        .iter()
        .map(|&r| match reference.target_row(r as usize) {
            UNWIRED => NONE,
            t => rank.map_or(t, |order| order.rank(t)),
        })
        .collect();
    out.resize(PAGE_ROWS as usize, NONE);
    out
}

/// The words of reference page `page` of a table drawn in its own order. Each word is the target
/// row's place in `rank`, the target table's draw order.
pub(crate) fn ranked_page(reference: &Reference, page: usize, rank: &Order) -> Vec<u32> {
    let start = page * PAGE_ROWS as usize;
    let len = reference.rows.pages().get(page).map_or(0, |p| p.values.len());
    (start..start + len)
        .map(|r| match reference.target_row(r) {
            UNWIRED => NONE,
            t => rank.rank(t),
        })
        .collect()
}

/// A page of the values of `samples`' rows `rows` at frame `frame`, padded with missing values.
pub(crate) fn frame(samples: &Samples, rows: &[u32], frame: Option<u64>) -> Vec<u32> {
    let mut out: Vec<u32> = rows
        .iter()
        .map(|&r| frame.and_then(|f| samples.value(r as usize, f)).map_or(MISSING, |v| (v as f32).to_bits()))
        .collect();
    out.resize(PAGE_ROWS as usize, MISSING);
    out
}

/// A page of the rows of `other` with the ids of `table`'s rows `rows`. `NONE` where `other` has
/// no such row.
pub(crate) fn joined(table: &Table, rows: &[u32], other: &Table) -> Vec<u32> {
    let mut out: Vec<u32> = rows
        .iter()
        .map(|&r| table.ids.key(r as usize).and_then(|key| other.row(key)).map_or(NONE, |o| o as u32))
        .collect();
    out.resize(PAGE_ROWS as usize, NONE);
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::data::Values;
    use crate::derive::pyramid::Pyramid;

    fn packing() -> Packing {
        Packing {
            order: 1,
            origin: Version::next(),
            table: "T".into(),
            field: "v".into(),
            derived: false,
            words: Words::Values,
            low: false,
            reads: 0,
        }
    }

    #[test]
    fn a_write_repacks_only_the_pages_its_rows_draw_in() {
        let n = 3 * PAGE_ROWS as usize;
        let column = Column::new(&Values::from((0..n).map(|i| i as f64).collect::<Vec<_>>()));
        // The order draws the rows backward: the last page of rows is its first page.
        let order = Order::Pyramid {
            pyramid: Arc::new(Pyramid::new((0..n as u32).rev().collect(), Vec::new())),
            rows: n as u32,
        };
        let mut packed = Packed::new(Arc::default());
        let packing = packing();
        let ids: Vec<PageId> = (0..3).map(|p| packed.page(&packing, &order, Some(&column), p)).collect();
        let written = column.write(n, &[(5, 0)], &Column::new(&Values::from(vec![-1.0_f64]))).expect("numbers");
        let after: Vec<PageId> = (0..3).map(|p| packed.page(&packing, &order, Some(&written), p)).collect();
        assert_eq!((after[0], after[1]), (ids[0], ids[1]), "pages without row 5 are reused");
        assert_ne!(after[2], ids[2], "row 5 is in the last page, which is repacked");
        let words = values(&written, &order.page(2), Words::Values, false);
        assert_eq!(f32::from_bits(words[PAGE_ROWS as usize - 1 - 5]), -1.0, "row 5 is packed at its place");
    }
}
