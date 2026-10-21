use std::sync::Arc;

use super::name::PageId;
use super::values::{Kind, Picks, Value, Values};
use crate::Result;

/// Rows per page: pages are the unit of sharing between versions and of upload to the GPU.
pub(crate) const PAGE_BITS: u32 = 16;
pub(crate) const PAGE_ROWS: usize = 1 << PAGE_BITS;
pub(crate) const PAGE_MASK: usize = PAGE_ROWS - 1;

/// One page of a column: up to [`PAGE_ROWS`] values and the id of exactly these contents.
#[derive(Clone, Debug)]
pub(crate) struct Page {
    pub(crate) id: PageId,
    pub(crate) values: Values,
}

impl Page {
    pub(crate) fn new(values: Values) -> Page {
        Page { id: PageId::next(), values }
    }
}

/// A field's values in pages. Writes replace only the pages they touch; others keep their ids.
#[derive(Clone, Debug)]
pub(crate) struct Column {
    len: usize,
    pages: Arc<[Page]>,
    /// An empty slice of the column's storage, so an empty column still knows what it holds.
    like: Values,
}

impl Column {
    pub(crate) fn new(values: &Values) -> Column {
        let len = values.len();
        let pages = (0..len.div_ceil(PAGE_ROWS))
            .map(|p| Page::new(values.slice(p * PAGE_ROWS..len.min((p + 1) * PAGE_ROWS))))
            .collect();
        Column { len, pages, like: values.slice(0..0) }
    }

    /// `len` missing values stored like `like`.
    pub(crate) fn missing(like: &Values, len: usize) -> Column {
        let empty = Column { len: 0, pages: Arc::new([]), like: like.slice(0..0) };
        empty.write(len, &[], &empty).expect("same storage")
    }

    /// A column of whole pages; every page but the last holds [`PAGE_ROWS`] values.
    pub(crate) fn from_pages(pages: Vec<Values>, like: &Values) -> Column {
        debug_assert!(pages.iter().rev().skip(1).all(|p| p.len() == PAGE_ROWS));
        let len = pages.iter().map(Values::len).sum();
        Column { len, pages: pages.into_iter().map(Page::new).collect(), like: like.slice(0..0) }
    }

    /// A column of `pages` as they are, their ids kept; every page but the last holds
    /// [`PAGE_ROWS`] values.
    pub(crate) fn of_pages(pages: Vec<Page>, like: &Values) -> Column {
        debug_assert!(pages.iter().rev().skip(1).all(|p| p.values.len() == PAGE_ROWS));
        let len = pages.iter().map(|p| p.values.len()).sum();
        Column { len, pages: pages.into(), like: like.slice(0..0) }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn kind(&self) -> Kind {
        self.like.kind()
    }

    pub(crate) fn pages(&self) -> &[Page] {
        &self.pages
    }

    pub(crate) fn like(&self) -> &Values {
        &self.like
    }

    pub(crate) fn get(&self, row: usize) -> Option<Value> {
        self.pages.get(row >> PAGE_BITS)?.values.get(row & PAGE_MASK)
    }

    /// The column with `len` rows (at least the current count) and `writes` applied.
    ///
    /// `writes` are `(row, row of source)` sorted by row with no row twice; a [`HOLE`](super::values::HOLE)
    /// for the row of source writes a missing value. Pages that no write touches and whose length does
    /// not change keep their ids; new rows not written are missing.
    pub(crate) fn write(&self, len: usize, writes: &[(usize, usize)], source: &Column) -> Result<Column> {
        debug_assert!(len >= self.len);
        debug_assert!(writes.windows(2).all(|w| w[0].0 < w[1].0));
        let count = len.div_ceil(PAGE_ROWS);
        let mut pages: Vec<Page> = Vec::with_capacity(count);
        let mut sources: Vec<&Values> = vec![&self.like];
        sources.extend(source.pages.iter().map(|p| &p.values));
        sources.push(&source.like);
        let mut next = 0;
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
            pages.push(Page::new(values));
        }
        Ok(Column { len, pages: pages.into(), like: self.like.clone() })
    }

    /// Every value in row order, as one run: a single page's without copying, else the pages copied
    /// one after another.
    pub(crate) fn values(&self) -> Values {
        match &self.pages[..] {
            [] => self.like.clone(),
            [page] => page.values.clone(),
            pages => Values::concat(&pages.iter().map(|p| &p.values).collect::<Vec<_>>()),
        }
    }

    /// The rows whose values differ from `before`'s, in order. A page both share holds the same values,
    /// so only the pages that changed are compared, row by row; rows past the shorter column differ.
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

    /// The column of rows `rows`, in that order, missing for a [`HOLE`](super::values::HOLE). Leading
    /// pages whose rows are unchanged keep their ids.
    pub(crate) fn gather(&self, rows: &[usize]) -> Column {
        let kept = rows.iter().enumerate().take_while(|&(i, &r)| i == r).count();
        let kept_pages = (kept / PAGE_ROWS).min(rows.len() / PAGE_ROWS);
        let sources: Vec<&Values> = std::iter::once(&self.like).chain(self.pages.iter().map(|p| &p.values)).collect();
        let mut pages: Vec<Page> = self.pages[..kept_pages].to_vec();
        for p in kept_pages..rows.len().div_ceil(PAGE_ROWS) {
            let chunk = &rows[p * PAGE_ROWS..rows.len().min((p + 1) * PAGE_ROWS)];
            pages.push(Page::new(Values::assemble(&sources, Picks::Rows(chunk)).expect("one storage")));
        }
        Column { len: rows.len(), pages: pages.into(), like: self.like.clone() }
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
    fn holes_write_and_gather_missing() {
        let column = Column::new(&numbers(4));
        let source = Column::new(&Values::from(vec![7.0_f64]));
        let written = column.write(5, &[(1, super::super::values::HOLE), (4, 0)], &source).expect("numbers");
        assert_eq!(
            (written.get(0), written.get(1), written.get(4)),
            (Some(Value::Number(0.0)), None, Some(Value::Number(7.0)))
        );
        let gathered = column.gather(&[3, super::super::values::HOLE, 0]);
        assert_eq!((gathered.get(0), gathered.get(1)), (Some(Value::Number(3.0)), None));
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
        // Row 3 of the second page changes; its row 4 is written the value it already held.
        let written = column.write(column.len(), &[(PAGE_ROWS + 3, 0), (PAGE_ROWS + 4, 1)], &source);
        let written = written.expect("numbers");
        assert_eq!(written.differing(&column), [PAGE_ROWS + 3]);
        assert_eq!(column.differing(&column), Vec::<usize>::new(), "a column holds what it holds");
        let longer = column.write(column.len() + 2, &[], &source).expect("numbers");
        assert_eq!(longer.differing(&column), [PAGE_ROWS * 2 + 10, PAGE_ROWS * 2 + 11], "rows past it differ");
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
