use std::sync::{Arc, OnceLock};

use super::name::PageId;
use super::values::{Kind, Picks, Value, Values};
use crate::Result;

/// Log2 of the rows per page (4,096). A page is the unit of sharing between versions, of GPU
/// upload, of residency when a paged table is drawn, and of a mark's per-row evaluation.
pub(crate) const PAGE_BITS: u32 = 12;
pub(crate) const PAGE_ROWS: usize = 1 << PAGE_BITS;
pub(crate) const PAGE_MASK: usize = PAGE_ROWS - 1;

/// How many writes back a page records which rows changed. Beyond that, the page counts as
/// entirely rewritten.
const REMEMBERED: u8 = 8;

/// One page of a column. It holds up to [`PAGE_ROWS`] values and an id unique to these contents. A
/// page made by writing over another records that page and the rows written (`written`). It also
/// caches its geometry's point count.
#[derive(Clone, Debug)]
pub(crate) struct Page {
    pub(crate) id: PageId,
    pub(crate) values: Values,
    pub(crate) written: Option<Arc<Written>>,
    /// Computed on first use and cached, since pages are immutable.
    points: OnceLock<usize>,
}

/// How a page was written. It records the page it copied (`from`), the rows written or added as
/// offsets into the page, and how `from` was written in turn (`before`), up to [`REMEMBERED`]
/// writes back.
#[derive(Debug)]
pub(crate) struct Written {
    pub(crate) from: PageId,
    pub(crate) rows: Box<[u32]>,
    pub(crate) before: Option<Arc<Written>>,
    depth: u8,
}

impl Page {
    pub(crate) fn new(values: Values) -> Page {
        Page { id: PageId::next(), values, written: None, points: OnceLock::new() }
    }

    /// A new page holding `values`, made by writing `rows` (offsets into the page) over `old`.
    fn over(values: Values, old: &Page, rows: Vec<u32>) -> Page {
        let before = old.written.clone().filter(|w| w.depth < REMEMBERED);
        let depth = before.as_ref().map_or(1, |w| w.depth + 1);
        let written = Written { from: old.id, rows: rows.into(), before, depth };
        Page { id: PageId::next(), values, written: Some(Arc::new(written)), points: OnceLock::new() }
    }

    /// The page's geometry point count as shaders read it. See [`Values::points`].
    pub(crate) fn points(&self) -> usize {
        *self.points.get_or_init(|| self.values.points())
    }

    /// The rows written since page `before`, as sorted offsets into the page. Empty if this page is
    /// `before`. `None` unless this page was written from `before` and still remembers it (see
    /// [`REMEMBERED`]).
    pub(crate) fn rows_since(&self, before: PageId) -> Option<Vec<u32>> {
        if self.id == before {
            return Some(Vec::new());
        }
        let mut rows = Vec::new();
        let mut at = self.written.as_deref();
        while let Some(written) = at {
            rows.extend_from_slice(&written.rows);
            if written.from == before {
                rows.sort_unstable();
                rows.dedup();
                return Some(rows);
            }
            at = written.before.as_deref();
        }
        None
    }
}

/// A field's values in pages of [`PAGE_ROWS`] rows. Writes replace only the pages they touch. The
/// others keep their ids.
///
/// Missing values fit any kind. A column's kind is fixed once it holds a value: until then, values
/// of any kind can be written to it, and it takes their kind. Values that are all missing can be
/// written to a column of any kind.
#[derive(Clone, Debug)]
pub(crate) struct Column {
    len: usize,
    pages: Arc<[Page]>,
    /// An empty slice with the column's storage type, so an empty column still knows its kind.
    like: Values,
    /// Whether the column has held a value. Until then its kind is not fixed.
    fixed: bool,
}

impl Column {
    pub(crate) fn new(values: &Values) -> Column {
        let len = values.len();
        let pages = (0..len.div_ceil(PAGE_ROWS))
            .map(|p| Page::new(values.slice(p * PAGE_ROWS..len.min((p + 1) * PAGE_ROWS))))
            .collect();
        Column { len, pages, like: values.slice(0..0), fixed: values.holds_any() }
    }

    /// A column of `len` missing values with the storage of `like`.
    pub(crate) fn missing(like: &Values, len: usize) -> Column {
        let empty = Column { len: 0, pages: Arc::new([]), like: like.slice(0..0), fixed: false };
        empty.write(len, &[], &empty).expect("same storage")
    }

    /// A column of `pages`, each given a new id. Every page but the last must hold [`PAGE_ROWS`]
    /// values.
    pub(crate) fn from_pages(pages: Vec<Values>, like: &Values) -> Column {
        debug_assert!(pages.iter().rev().skip(1).all(|p| p.len() == PAGE_ROWS));
        let len = pages.iter().map(Values::len).sum();
        let fixed = pages.iter().any(Values::holds_any);
        Column { len, pages: pages.into_iter().map(Page::new).collect(), like: like.slice(0..0), fixed }
    }

    /// A column of existing `pages`, keeping their ids. Every page but the last must hold
    /// [`PAGE_ROWS`] values.
    pub(crate) fn of_pages(pages: Vec<Page>, like: &Values) -> Column {
        debug_assert!(pages.iter().rev().skip(1).all(|p| p.values.len() == PAGE_ROWS));
        let len = pages.iter().map(|p| p.values.len()).sum();
        let fixed = pages.iter().any(|p| p.values.holds_any());
        Column { len, pages: pages.into(), like: like.slice(0..0), fixed }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn kind(&self) -> Kind {
        self.like.kind()
    }

    /// Whether the column has held a value, which fixes its kind.
    pub(crate) fn fixed(&self) -> bool {
        self.fixed
    }

    pub(crate) fn pages(&self) -> &[Page] {
        &self.pages
    }

    /// Whether `other` has the same length and page ids. That means the values are equal, without
    /// comparing any.
    pub(crate) fn shares(&self, other: &Column) -> bool {
        self.len == other.len && self.pages.iter().zip(other.pages.iter()).all(|(a, b)| a.id == b.id)
    }

    pub(crate) fn like(&self) -> &Values {
        &self.like
    }

    pub(crate) fn get(&self, row: usize) -> Option<Value> {
        self.pages.get(row >> PAGE_BITS)?.values.get(row & PAGE_MASK)
    }

    /// The values of the page holding row `row`, and the row's index in them. `None` past the
    /// column's end.
    pub(crate) fn at(&self, row: usize) -> Option<(&Values, usize)> {
        let values = &self.pages.get(row >> PAGE_BITS)?.values;
        let i = row & PAGE_MASK;
        (i < values.len()).then_some((values, i))
    }

    /// The values of rows `rows`, in that order, for GPU upload. Rows past the column's end come
    /// back missing, because a placeholder derived table, shown until its job finishes, can be
    /// shorter than the rows requested.
    pub(crate) fn pick(&self, rows: &[u32]) -> Values {
        let from: Vec<Option<usize>> = rows.iter().map(|&r| Some(r as usize).filter(|&r| r < self.len)).collect();
        let sources: Vec<&Values> = std::iter::once(&self.like).chain(self.pages.iter().map(|p| &p.values)).collect();
        Values::assemble(&sources, Picks::Writes { from: &from, kept: 0 }).expect("one storage")
    }

    /// A copy with `len` rows (at least the current count) and `writes` applied.
    ///
    /// `writes` are `(row, source row)` pairs sorted by row, each row at most once. Pages that no
    /// write touches and that keep their length keep their ids. New rows not written are missing.
    /// Returns an error if both hold values, of different kinds. A column that holds no value takes
    /// the kind of `source`, and a `source` that holds none writes missing values of this kind.
    pub(crate) fn write(&self, len: usize, writes: &[(usize, usize)], source: &Column) -> Result<Column> {
        if self.kind() != source.kind() {
            if !self.fixed {
                return Column::missing(&source.like, self.len).write(len, writes, source);
            }
            if !source.fixed {
                return self.write(len, writes, &Column::missing(&self.like, source.len));
            }
        }
        debug_assert!(len >= self.len);
        debug_assert!(writes.windows(2).all(|w| w[0].0 < w[1].0));
        let count = len.div_ceil(PAGE_ROWS);
        let mut pages: Vec<Page> = Vec::with_capacity(count);
        let mut sources: Vec<&Values> = vec![&self.like];
        sources.extend(source.pages.iter().map(|p| &p.values));
        sources.push(&source.like);
        let mut next = 0;
        let mut fixed = self.fixed;
        for p in 0..count {
            let start = p * PAGE_ROWS;
            let page_len = (len - start).min(PAGE_ROWS);
            let first = next;
            while next < writes.len() && writes[next].0 < start + page_len {
                next += 1;
            }
            let page_writes = &writes[first..next];
            let old = self.pages.get(p);
            if page_writes.is_empty()
                && let Some(old) = old
                && old.values.len() == page_len
            {
                pages.push(old.clone());
                continue;
            }
            let mut from = vec![None; page_len];
            for &(row, k) in page_writes {
                from[row - start] = Some(k);
            }
            sources[0] = old.map_or(&self.like, |o| &o.values);
            let kept = sources[0].len();
            let values = Values::assemble(&sources, Picks::Writes { from: &from, kept })?;
            fixed |= source.fixed && values.holds_any();
            pages.push(match old {
                // Record the rows written, plus the rows added past the old page's end.
                Some(old) => {
                    let mut rows: Vec<u32> = page_writes.iter().map(|&(row, _)| (row - start) as u32).collect();
                    rows.extend(kept as u32..page_len as u32);
                    Page::over(values, old, rows)
                }
                None => Page::new(values),
            });
        }
        Ok(Column { len, pages: pages.into(), like: self.like.clone(), fixed })
    }

    /// The rows written since `before`, in order, where this column was written from `before` a
    /// few writes back. `None` if the row count changed or a changed page no longer remembers
    /// `before`. A row rewritten with its old value still counts.
    pub(crate) fn rows_since(&self, before: &Column) -> Option<Vec<usize>> {
        if self.len != before.len {
            return None;
        }
        let mut rows = Vec::new();
        for (p, (now, then)) in self.pages.iter().zip(before.pages.iter()).enumerate() {
            if now.id != then.id {
                rows.extend(now.rows_since(then.id)?.into_iter().map(|r| p * PAGE_ROWS + r as usize));
            }
        }
        Some(rows)
    }

    /// Whether the first `rows` rows are unchanged since `before`, which this column was written
    /// from a few writes back. That holds when every write since is at row `rows` or later, as with
    /// appends. Writes that a page no longer remembers count as changes.
    pub(crate) fn kept_below(&self, before: &Column, rows: usize) -> bool {
        (0..rows.div_ceil(PAGE_ROWS)).all(|p| {
            let (Some(now), Some(then)) = (self.pages.get(p), before.pages.get(p)) else { return false };
            let start = p * PAGE_ROWS;
            now.id == then.id
                || now.rows_since(then.id).is_some_and(|written| written.iter().all(|&r| start + r as usize >= rows))
        })
    }

    /// The rows written or added since `before`, in order. For each page that differs from
    /// `before`'s, these are the rows it remembers writing since, or all its rows if it does not
    /// remember `before`'s page. A page that `before` lacks counts in full. Rows of `before` past
    /// this column's end are not included.
    pub(crate) fn written_since(&self, before: &Column) -> Vec<usize> {
        let mut rows = Vec::new();
        for (p, now) in self.pages.iter().enumerate() {
            let start = p * PAGE_ROWS;
            match before.pages.get(p) {
                Some(then) if then.id == now.id => {}
                Some(then) => match now.rows_since(then.id) {
                    Some(written) => rows.extend(written.into_iter().map(|r| start + r as usize)),
                    None => rows.extend(start..start + now.values.len()),
                },
                None => rows.extend(start..start + now.values.len()),
            }
        }
        rows
    }

    /// All values in row order as one [`Values`]. A single-page column returns its page without
    /// copying. Otherwise the pages are concatenated.
    pub(crate) fn values(&self) -> Values {
        match &self.pages[..] {
            [] => self.like.clone(),
            [page] => page.values.clone(),
            pages => Values::concat(&pages.iter().map(|p| &p.values).collect::<Vec<_>>()),
        }
    }

    /// The rows whose values differ from `before`'s, in order. When the pages remember the rows
    /// written since, only those rows are compared. Otherwise every row of each changed page is
    /// compared (see [`differing`](Column::differing)).
    pub(crate) fn changed_since(&self, before: &Column) -> Vec<usize> {
        let Some(written) = self.rows_since(before) else { return self.differing(before) };
        written
            .into_iter()
            .filter(|&row| !self.holds(row, &before.pages[row / PAGE_ROWS].values, row % PAGE_ROWS))
            .collect()
    }

    /// Whether row `row` equals row `at` of `values`, as stored (see [`Values::same_row`]).
    pub(crate) fn holds(&self, row: usize, values: &Values, at: usize) -> bool {
        self.pages[row / PAGE_ROWS].values.same_row(row % PAGE_ROWS, values, at)
    }

    /// The rows whose values differ from `before`'s, in order. Pages with the same id are skipped,
    /// and the rest are compared row by row. Rows past the shorter column's end count as different.
    pub(crate) fn differing(&self, before: &Column) -> Vec<usize> {
        let mut rows = Vec::new();
        for p in 0..self.pages.len().max(before.pages.len()) {
            let (now, then) = (self.pages.get(p), before.pages.get(p));
            if let (Some(a), Some(b)) = (now, then)
                && a.id == b.id
            {
                continue;
            }
            let (a, b) = (now.map_or(&self.like, |a| &a.values), then.map_or(&before.like, |b| &b.values));
            let (start, both) = (p * PAGE_ROWS, a.len().min(b.len()));
            rows.extend((0..a.len().max(b.len())).filter(|&i| i >= both || !a.same_row(i, b, i)).map(|i| start + i));
        }
        rows
    }

    /// A column of rows `rows` of this one, in that order. Leading whole pages whose rows are
    /// unchanged (`rows[i] == i`) keep their ids.
    pub(crate) fn gather(&self, rows: &[usize]) -> Column {
        let kept = rows.iter().enumerate().take_while(|&(i, &r)| i == r).count();
        let kept_pages = (kept / PAGE_ROWS).min(rows.len() / PAGE_ROWS);
        let sources: Vec<&Values> = std::iter::once(&self.like).chain(self.pages.iter().map(|p| &p.values)).collect();
        let mut pages: Vec<Page> = self.pages[..kept_pages].to_vec();
        for p in kept_pages..rows.len().div_ceil(PAGE_ROWS) {
            let chunk = &rows[p * PAGE_ROWS..rows.len().min((p + 1) * PAGE_ROWS)];
            pages.push(Page::new(Values::assemble(&sources, Picks::Rows(chunk)).expect("one storage")));
        }
        let fixed = self.fixed && pages.iter().any(|p| p.values.holds_any());
        Column { len: rows.len(), pages: pages.into(), like: self.like.clone(), fixed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(n: usize) -> Values {
        Values::from((0..n).map(|i| i as f64).collect::<Vec<_>>())
    }

    #[test]
    fn writes_touch_only_their_pages() {
        let column = Column::new(&numbers(PAGE_ROWS * 2 + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64]));
        let written = column.write(column.len(), &[(PAGE_ROWS + 3, 0)], &source).expect("numbers");
        assert_eq!(written.pages()[0].id, column.pages()[0].id);
        assert_ne!(written.pages()[1].id, column.pages()[1].id);
        assert_eq!(written.pages()[2].id, column.pages()[2].id);
        assert_eq!(written.get(PAGE_ROWS + 3), Some(Value::Number(-1.0)));
        assert_eq!(written.get(PAGE_ROWS + 4), Some(Value::Number((PAGE_ROWS + 4) as f64)));
    }

    #[test]
    fn growth_pads_with_missing() {
        let column = Column::new(&numbers(3));
        let grown = column.write(5, &[(4, 0)], &Column::new(&Values::from(vec![9.0_f64]))).expect("numbers");
        assert_eq!(grown.len(), 5);
        assert_eq!(grown.get(3), None);
        assert_eq!(grown.get(4), Some(Value::Number(9.0)));
        assert_eq!(Column::missing(&numbers(0), 4).get(2), None);
    }

    #[test]
    fn differing_rows_are_found_in_the_pages_that_changed() {
        let column = Column::new(&numbers(PAGE_ROWS * 2 + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64, (PAGE_ROWS + 4) as f64]));
        // Row 3 of the second page changes. Its row 4 is rewritten with the value it already had.
        let written = column.write(column.len(), &[(PAGE_ROWS + 3, 0), (PAGE_ROWS + 4, 1)], &source);
        let written = written.expect("numbers");
        assert_eq!(written.differing(&column), [PAGE_ROWS + 3]);
        assert_eq!(column.differing(&column), Vec::<usize>::new(), "a column does not differ from itself");
        let longer = column.write(column.len() + 2, &[], &source).expect("numbers");
        assert_eq!(longer.differing(&column), [PAGE_ROWS * 2 + 10, PAGE_ROWS * 2 + 11], "added rows differ");
    }

    #[test]
    fn written_pages_remember_the_rows_written_since() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64, -2.0]));
        let once = column.write(column.len(), &[(3, 0), (PAGE_ROWS + 4, 1)], &source).expect("numbers");
        let twice = once.write(once.len(), &[(5, 0)], &source).expect("numbers");
        assert_eq!(twice.rows_since(&column), Some(vec![3, 5, PAGE_ROWS + 4]), "every write since, in order");
        assert_eq!(twice.rows_since(&once), Some(vec![5]));
        assert_eq!(twice.rows_since(&twice), Some(Vec::new()));
        assert_eq!(column.rows_since(&twice), None, "an older column is not written from a newer one");
        assert_eq!(Column::new(&numbers(PAGE_ROWS + 10)).rows_since(&column), None, "nor from another column");
        let grown = column.write(column.len() + 2, &[], &source).expect("numbers");
        assert_eq!(grown.rows_since(&column), None, "a changed row count lists no rows");
        // A page remembers a few writes back. Beyond that it counts as entirely rewritten.
        let mut near = once.clone();
        for _ in 1..REMEMBERED {
            near = near.write(near.len(), &[(7, 0)], &source).expect("numbers");
        }
        assert_eq!(near.rows_since(&column), Some(vec![3, 7, PAGE_ROWS + 4]));
        let far = near.write(near.len(), &[(7, 0)], &source).expect("numbers");
        assert_eq!(far.rows_since(&column), None);
        assert_eq!(far.rows_since(&near), Some(vec![7]));
    }

    #[test]
    fn rows_written_or_added_since_are_found_page_by_page() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64]));
        let written = column.write(PAGE_ROWS + 12, &[(3, 0)], &source).expect("numbers");
        assert_eq!(
            written.written_since(&column),
            [3, PAGE_ROWS + 10, PAGE_ROWS + 11],
            "the row written, and the rows added past the end"
        );
        let fresh = Column::new(&numbers(PAGE_ROWS + 10));
        assert_eq!(fresh.written_since(&column).len(), PAGE_ROWS + 10, "an unrelated page counts every row");
        assert_eq!(column.written_since(&column), Vec::<usize>::new(), "nothing written since itself");
    }

    #[test]
    fn appends_leave_earlier_rows_unchanged() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        let source = Column::new(&Values::from(vec![-1.0_f64]));
        let appended = column.write(PAGE_ROWS + 12, &[(PAGE_ROWS + 11, 0)], &source).expect("numbers");
        assert!(appended.kept_below(&column, PAGE_ROWS + 10), "rows appended after them leave them unchanged");
        let written = appended.write(appended.len(), &[(PAGE_ROWS + 9, 0)], &source).expect("numbers");
        assert!(written.kept_below(&appended, PAGE_ROWS + 9), "a row written after the rows checked");
        assert!(!written.kept_below(&appended, PAGE_ROWS + 10), "a row written within them");
        assert!(!Column::new(&numbers(PAGE_ROWS + 10)).kept_below(&column, 1), "an unrelated column keeps no rows");
    }

    #[test]
    fn rows_rewritten_with_the_same_value_are_unchanged() {
        let column = Column::new(&numbers(PAGE_ROWS + 10));
        // Row 4 holds 4.
        let source = Column::new(&Values::from(vec![-1.0_f64, 4.0]));
        let written = column.write(column.len(), &[(3, 0), (4, 1), (PAGE_ROWS + 4, 0)], &source).expect("numbers");
        assert_eq!(written.rows_since(&column), Some(vec![3, 4, PAGE_ROWS + 4]), "every row written");
        assert_eq!(written.changed_since(&column), vec![3, PAGE_ROWS + 4], "the rows whose values changed");
        let far = (0..REMEMBERED).fold(written, |c, _| c.write(c.len(), &[(3, 0)], &source).expect("numbers"));
        assert_eq!(far.changed_since(&column), vec![3, PAGE_ROWS + 4], "compared once pages forget their writes");
    }

    #[test]
    fn a_page_counts_its_points_once_and_a_rewritten_page_recounts() {
        let path = |n: usize| (0..n).map(|i| [i as f64, 0.0]).collect::<Vec<_>>();
        let column = Column::new(&Values::from(vec![path(3), path(5)]));
        let page = &column.pages()[0];
        assert_eq!(page.points.get(), None, "nothing counted until asked");
        assert_eq!(page.points(), 8);
        assert_eq!(page.points.get(), Some(&8), "counted once, then cached");
        assert_eq!(column.clone().pages()[0].points.get(), Some(&8), "a copy of the column shares the count");
        let source = Column::new(&Values::from(vec![path(10)]));
        let written = column.write(column.len(), &[(0, 0)], &source).expect("paths");
        assert_eq!(written.pages()[0].points(), 15, "the rewritten page counts its own points");
    }

    #[test]
    fn gather_keeps_leading_pages() {
        let column = Column::new(&numbers(PAGE_ROWS + 5));
        let rows: Vec<usize> = (0..PAGE_ROWS).chain([PAGE_ROWS + 2, PAGE_ROWS + 4]).collect();
        let gathered = column.gather(&rows);
        assert_eq!(gathered.len(), PAGE_ROWS + 2);
        assert_eq!(gathered.pages()[0].id, column.pages()[0].id);
        assert_eq!(gathered.get(PAGE_ROWS + 1), Some(Value::Number((PAGE_ROWS + 4) as f64)));
    }
}
