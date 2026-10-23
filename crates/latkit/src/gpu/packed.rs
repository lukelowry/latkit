//! Pages packed in an order: a column of a table drawn in part, a page of its order at a time, the
//! first time a view draws that page, as the words its marks read. Each is kept by what it was
//! packed from, so views drawing a table alike share its pages, a page the camera comes back to is
//! the one it left, and a write repacks only the pages its rows draw in. A table drawn in its own
//! order reads its data's pages as they are, but a reference to a table drawn in another order, whose
//! pages are packed through that order's ranks.

use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::data::{Column, Name, PAGE_ROWS, PageId, Reference, Samples, Table, UNWIRED, Version};
use crate::derive::order::{Order, PAGE};
use crate::expr::compile::Words;
use crate::gpu::arena::page_words;
use crate::gpu::shaders::{MISSING, NONE};
use crate::gpu::work::{Count, Counters};

/// Columns of pages kept at most: past them, the half used least recently is forgotten.
const KEPT: usize = 4096;

/// What one column of pages packed in an order is: the order, the dataset and table, the field and
/// how it is read, and what else its words read (a reference's target order, the frame of samples
/// shown, the rows a join reads).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Packing {
    pub(crate) order: u64,
    pub(crate) origin: Version,
    pub(crate) table: Name,
    pub(crate) field: Name,
    pub(crate) words: Words,
    pub(crate) low: bool,
    pub(crate) reads: u64,
}

/// A column's pages: what they were packed from, each page's id once packed, the samples a traced
/// page was gathered as, and when they were last used.
struct Pages {
    source: Option<Column>,
    ids: Vec<Option<PageId>>,
    samples: Vec<Option<Samples>>,
    used: u64,
}

/// Every column of pages packed in an order, on the GPU's views' behalf, and what counts the rows
/// packed.
pub(crate) struct Packed {
    counters: Arc<Counters>,
    columns: FxHashMap<Packing, Pages>,
    /// Pages of a table's own order whose reference rows are packed through the ranks of the order
    /// their table draws in, by the page and that order.
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

    /// What counts the rows packed, for packing that may happen later.
    pub(crate) fn counters(&self) -> Arc<Counters> {
        self.counters.clone()
    }

    /// The pages of `packing`, packed from `source` as it is now, in `order`: kept while no row they
    /// hold was written since. Without a source, kept while `packing` is the same.
    fn pages(&mut self, packing: &Packing, order: &Order, source: Option<&Column>) -> &mut Pages {
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
                for row in source.written_since(before) {
                    let page = (order.rank(row as u32) / PAGE) as usize;
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
        let pages = self.pages(packing, order, source);
        let k = page as usize;
        if pages.ids.len() <= k {
            pages.ids.resize(k + 1, None);
        }
        *pages.ids[k].get_or_insert_with(PageId::next)
    }

    /// Samples `samples`' rows `rows` hold, page `page` of `packing`, gathered once.
    pub(crate) fn samples(
        &mut self,
        packing: &Packing,
        order: &Order,
        page: u32,
        rows: &[u32],
        samples: &Samples,
    ) -> Samples {
        let counters = self.counters.clone();
        let pages = self.pages(packing, order, None);
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

    /// The id of reference page `page` of a table drawn in its own order, packed through the ranks of
    /// the order `order` its target draws in.
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

/// Drops the half of `kept` used least recently, by when `used` says each was.
fn forget<K: Clone + Eq + std::hash::Hash, V>(kept: &mut FxHashMap<K, V>, used: impl Fn(&V) -> u64) {
    let mut uses: Vec<u64> = kept.values().map(&used).collect();
    let half = uses.len() / 2;
    let (_, &mut cut, _) = uses.select_nth_unstable(half);
    kept.retain(|_, v| used(v) > cut);
}

/// The words `column`'s rows `rows` are read as, a page of them, missing past the rows.
pub(crate) fn values(column: &Column, rows: &[u32], words: Words, low: bool) -> Vec<u32> {
    let mut out = page_words(&column.pick(rows), words, low);
    out.resize(PAGE as usize, if words == Words::Bits { NONE } else { MISSING });
    out
}

/// Words of the rows `reference` names for rows `rows`, a page of them: where each draws in `rank`,
/// the order its table draws in, or as it is in a table drawn whole; `NONE` where a row names none.
pub(crate) fn targets(reference: &Reference, rows: &[u32], rank: Option<&Order>) -> Vec<u32> {
    let mut out: Vec<u32> = rows
        .iter()
        .map(|&r| match reference.target_row(r as usize) {
            UNWIRED => NONE,
            t => rank.map_or(t, |order| order.rank(t)),
        })
        .collect();
    out.resize(PAGE as usize, NONE);
    out
}

/// The words of reference page `page` of a table drawn in its own order: the rows it names, as
/// `rank`, the order their table draws in, places them.
pub(crate) fn ranked_page(reference: &Reference, page: usize, rank: &Order) -> Vec<u32> {
    let start = page * PAGE_ROWS;
    let len = reference.rows.pages().get(page).map_or(0, |p| p.values.len());
    (start..start + len)
        .map(|r| match reference.target_row(r) {
            UNWIRED => NONE,
            t => rank.rank(t),
        })
        .collect()
}

/// Values of `samples`' rows `rows` at frame `frame`, a page of them, missing past the rows.
pub(crate) fn frame(samples: &Samples, rows: &[u32], frame: Option<u64>) -> Vec<u32> {
    let mut out: Vec<u32> = rows
        .iter()
        .map(|&r| frame.and_then(|f| samples.value(r as usize, f)).map_or(MISSING, |v| (v as f32).to_bits()))
        .collect();
    out.resize(PAGE as usize, MISSING);
    out
}

/// The rows of `other` with the ids of `table`'s rows `rows`, a page of them; `NONE` where none.
pub(crate) fn joined(table: &Table, rows: &[u32], other: &Table) -> Vec<u32> {
    let mut out: Vec<u32> = rows
        .iter()
        .map(|&r| table.ids.key(r as usize).and_then(|key| other.row(key)).map_or(NONE, |o| o as u32))
        .collect();
    out.resize(PAGE as usize, NONE);
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
            words: Words::Values,
            low: false,
            reads: 0,
        }
    }

    #[test]
    fn a_write_repacks_only_the_pages_its_rows_draw_in() {
        let n = 3 * PAGE as usize;
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
        assert_eq!((after[0], after[1]), (ids[0], ids[1]), "pages not drawing row 5 are kept");
        assert_ne!(after[2], ids[2], "row 5 draws in the last page, which packs again");
        let words = values(&written, &order.page(2), Words::Values, false);
        assert_eq!(f32::from_bits(words[PAGE as usize - 1 - 5]), -1.0, "row 5 packed where it draws");
    }
}
