use std::hash::BuildHasher;

use hashbrown::HashTable;
use hashbrown::hash_table::Entry;
use rustc_hash::FxBuildHasher;

use super::column::{Column, PAGE_BITS, PAGE_MASK};
use super::name::{Id, IdRef};
use super::values::{Array, Values};
use crate::{Error, Result};

/// Row ids, as given to [`Table::new`](crate::Table::new) or [`Patch::remove`](crate::Patch::remove),
/// and the target ids of a reference.
///
/// [`Ids::count`] names rows `0..n`. Lists convert from vectors, arrays, and slices of numbers or
/// texts; for a reference, `None` leaves a row unwired. A bare number is never a count.
///
/// ```
/// # use latkit::{Ids, Table};
/// let buses = Table::new("Bus", Ids::count(3));          // ids 0, 1, 2
/// let lines = Table::new("Line", [101_u64, 205]);       // ids 101 and 205
/// ```
#[derive(Clone, Debug)]
pub struct Ids(pub(crate) IdList);

#[derive(Clone, Debug)]
pub(crate) enum IdList {
    Count(u32),
    Listed(Values),
}

/// Ids are equal when they name the same rows in the same order.
impl PartialEq for Ids {
    fn eq(&self, other: &Ids) -> bool {
        self.len() == other.len() && (0..self.len()).all(|i| self.key(i) == other.key(i))
    }
}

impl Ids {
    /// Ids `0..n`, one per row in row order.
    pub fn count(n: u32) -> Ids {
        Ids(IdList::Count(n))
    }

    /// The number of ids.
    pub fn len(&self) -> usize {
        match &self.0 {
            IdList::Count(n) => *n as usize,
            IdList::Listed(v) => v.len(),
        }
    }

    /// Whether there are no ids.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(crate) fn key(&self, i: usize) -> Option<IdRef<'_>> {
        match &self.0 {
            IdList::Count(_) => Some(IdRef::Number(i as u64)),
            IdList::Listed(values) => key(values, i),
        }
    }
}

pub(crate) fn key(values: &Values, i: usize) -> Option<IdRef<'_>> {
    if !values.is_valid(i) {
        return None;
    }
    match &values.array {
        Array::U64(v) => Some(IdRef::Number(v[i])),
        Array::Text(v) => Some(IdRef::Text(v.get(i))),
        _ => None,
    }
}

macro_rules! listed {
    ($($t:ty),*) => {$(
        impl From<$t> for Ids {
            fn from(ids: $t) -> Ids {
                Ids::listed(Values::from(ids))
            }
        }
    )*};
}

listed!(
    Vec<u64>,
    &[u64],
    Vec<Option<u64>>,
    Vec<String>,
    &[String],
    Vec<&str>,
    &[&str],
    Vec<Option<String>>,
    Vec<Option<&str>>
);

impl<const N: usize> From<[&str; N]> for Ids {
    fn from(ids: [&str; N]) -> Ids {
        Ids::listed(Values::from(ids))
    }
}

impl<const N: usize> From<[u64; N]> for Ids {
    fn from(ids: [u64; N]) -> Ids {
        Ids::listed(Values::from(ids))
    }
}

impl From<Vec<u32>> for Ids {
    fn from(ids: Vec<u32>) -> Ids {
        Ids::listed(Values::from(ids.into_iter().map(u64::from).collect::<Vec<_>>()))
    }
}

impl From<&[u32]> for Ids {
    fn from(ids: &[u32]) -> Ids {
        Ids::listed(Values::from(ids.iter().copied().map(u64::from).collect::<Vec<_>>()))
    }
}

impl From<Vec<Option<u32>>> for Ids {
    fn from(ids: Vec<Option<u32>>) -> Ids {
        Ids::listed(Values::from(ids.into_iter().map(|id| id.map(u64::from)).collect::<Vec<_>>()))
    }
}

impl From<Vec<Id>> for Ids {
    fn from(ids: Vec<Id>) -> Ids {
        Ids::from(ids.into_iter().map(Some).collect::<Vec<_>>())
    }
}

impl From<Vec<Option<Id>>> for Ids {
    fn from(ids: Vec<Option<Id>>) -> Ids {
        if ids.iter().flatten().all(|id| matches!(id, Id::Number(_))) {
            let numbers = ids.into_iter().map(|id| id.map(|id| if let Id::Number(n) = id { n } else { 0 }));
            return Ids::from(numbers.collect::<Vec<_>>());
        }
        Ids::from(ids.into_iter().map(|id| id.map(|id| id.to_string())).collect::<Vec<_>>())
    }
}

impl Ids {
    fn listed(values: Values) -> Ids {
        Ids(IdList::Listed(values))
    }
}

/// A table's row ids: a count when they are `0..n` in row order, else a paged column.
#[derive(Clone, Debug)]
pub(crate) enum RowIds {
    Count(u32),
    Listed(Column),
}

impl RowIds {
    pub(crate) fn new(ids: &Ids) -> RowIds {
        match &ids.0 {
            IdList::Count(n) => RowIds::Count(*n),
            IdList::Listed(values) => RowIds::Listed(Column::new(values)),
        }
    }

    pub(crate) fn len(&self) -> usize {
        match self {
            RowIds::Count(n) => *n as usize,
            RowIds::Listed(c) => c.len(),
        }
    }

    pub(crate) fn key(&self, row: usize) -> Option<IdRef<'_>> {
        match self {
            RowIds::Count(_) => Some(IdRef::Number(row as u64)),
            RowIds::Listed(c) => key(&c.pages()[row >> PAGE_BITS].values, row & PAGE_MASK),
        }
    }

    pub(crate) fn id(&self, row: usize) -> Option<Id> {
        self.key(row).map(IdRef::to_id)
    }

    /// The ids with `added` appended; a count stays a count while the new ids continue it. Ids of
    /// another kind than the table's (texts for a table of numbers) are an error.
    pub(crate) fn extend(&self, added: &[Id]) -> Result<RowIds> {
        if added.is_empty() {
            return Ok(self.clone());
        }
        if let RowIds::Count(n) = self
            && added.iter().enumerate().all(|(i, id)| *id == Id::Number(u64::from(*n) + i as u64))
        {
            return Ok(RowIds::Count(n + added.len() as u32));
        }
        let column = self.listed();
        let IdList::Listed(source) = Ids::from(added.to_vec()).0 else { unreachable!("a list of ids") };
        if source.kind() != column.kind() {
            return Err(Error::invalid("ids of another kind than the table's: numbers and texts do not mix"));
        }
        let len = column.len() + added.len();
        let writes: Vec<(usize, usize)> = (0..added.len()).map(|k| (column.len() + k, k)).collect();
        Ok(RowIds::Listed(column.write(len, &writes, &Column::new(&source))?))
    }

    /// The ids with `len` rows (at least the current count) and `writes` applied, `(row, row of
    /// source)` by row, a hole where the row of source is a [`HOLE`](super::values::HOLE). Pages no
    /// write touches keep their ids.
    pub(crate) fn write(&self, len: usize, writes: &[(usize, usize)], source: &RowIds) -> Result<RowIds> {
        // The ids written, gathered first, so a count's ids are made only for those.
        let from: Vec<usize> = writes.iter().map(|&(_, s)| s).collect();
        let written = match source {
            RowIds::Count(_) => {
                let ids: Vec<Option<u64>> =
                    from.iter().map(|&s| (s != super::values::HOLE).then_some(s as u64)).collect();
                Column::new(&Values::from(ids))
            }
            RowIds::Listed(column) => column.gather(&from),
        };
        let at: Vec<(usize, usize)> = writes.iter().enumerate().map(|(k, &(row, _))| (row, k)).collect();
        Ok(RowIds::Listed(self.listed().write(len, &at, &written)?))
    }

    /// The ids of `rows`, in that order.
    pub(crate) fn gather(&self, rows: &[usize]) -> RowIds {
        if rows.iter().enumerate().all(|(i, &r)| i == r) {
            return match self {
                RowIds::Count(_) => RowIds::Count(rows.len() as u32),
                RowIds::Listed(c) => RowIds::Listed(c.gather(rows)),
            };
        }
        RowIds::Listed(self.listed().gather(rows))
    }

    fn listed(&self) -> Column {
        match self {
            RowIds::Count(n) => Column::new(&Values::from((0..u64::from(*n)).collect::<Vec<_>>())),
            RowIds::Listed(c) => c.clone(),
        }
    }

    /// Every page's numbered ids, when every id is a number: what lookups read without matching each
    /// id's kind.
    pub(crate) fn numbers(&self) -> Option<Vec<&[u64]>> {
        let RowIds::Listed(column) = self else { return None };
        column
            .pages()
            .iter()
            .map(|page| match (&page.values.array, &page.values.valid) {
                (Array::U64(v), None) => Some(&v[..]),
                _ => None,
            })
            .collect()
    }

    /// The first row without an id: a hole, which only the rows a view draws of a table drawn through
    /// tiles have.
    pub(crate) fn hole(&self) -> Option<usize> {
        let RowIds::Listed(column) = self else { return None };
        let mut start = 0;
        for page in column.pages() {
            if let Some(valid) = &page.values.valid
                && let Some(i) = (0..page.values.len()).find(|&i| !valid.get(i))
            {
                return Some(start + i);
            }
            start += page.values.len();
        }
        None
    }

    /// How many rows are holes, without an id.
    pub(crate) fn holes(&self) -> usize {
        let RowIds::Listed(column) = self else { return 0 };
        column.pages().iter().filter_map(|p| p.values.valid.as_ref().map(|v| p.values.len() - v.count())).sum()
    }

    /// The id → row index, past holes; an error names a repeated id.
    pub(crate) fn index(&self) -> Result<Index> {
        let RowIds::Listed(_) = self else { return Ok(Index::Identity(self.len() as u32)) };
        if let Some(pages) = self.numbers() {
            return numbered(&pages, self.len());
        }
        let mut table = HashTable::with_capacity(self.len());
        for row in 0..self.len() {
            let Some(key) = self.key(row) else { continue };
            let eq = |&r: &u32| self.key(r as usize) == Some(key);
            let rehash = |&r: &u32| hash(self.key(r as usize).expect("indexed rows have ids"));
            match table.entry(hash(key), eq, rehash) {
                Entry::Occupied(_) => return Err(Error::invalid(format!("id {key:?} appears twice")).at(row)),
                Entry::Vacant(slot) => {
                    slot.insert(row as u32);
                }
            }
        }
        Ok(Index::Table(table))
    }
}

/// The index of numbered ids, read page by page.
fn numbered(pages: &[&[u64]], len: usize) -> Result<Index> {
    let id = |r: u32| pages[r as usize >> PAGE_BITS][r as usize & PAGE_MASK];
    let mut table = HashTable::with_capacity(len);
    for (p, page) in pages.iter().enumerate() {
        for (i, &n) in page.iter().enumerate() {
            let row = p << PAGE_BITS | i;
            match table.entry(hash(IdRef::Number(n)), |&r| id(r) == n, |&r| hash(IdRef::Number(id(r)))) {
                Entry::Occupied(_) => return Err(Error::invalid(format!("id {n} appears twice")).at(row)),
                Entry::Vacant(slot) => {
                    slot.insert(row as u32);
                }
            }
        }
    }
    Ok(Index::Table(table))
}

/// Finds a row by id without allocating.
#[derive(Debug)]
pub(crate) enum Index {
    Identity(u32),
    Table(HashTable<u32>),
}

pub(crate) fn hash(key: IdRef<'_>) -> u64 {
    FxBuildHasher.hash_one(key)
}

impl Index {
    /// The rows numbered ids `ids` name, `unwired` where one names none or is missing, and whether a
    /// present id named no row: the loop chosen once for the ids' and the rows' kinds.
    pub(crate) fn resolve(&self, rows: &RowIds, ids: &Values, unwired: u32) -> (Vec<u32>, bool) {
        let valid = |i: usize| ids.valid.as_ref().is_none_or(|v| v.get(i));
        let mut dangling = false;
        let mut found = |row: Option<usize>| {
            dangling |= row.is_none();
            row.map_or(unwired, |r| r as u32)
        };
        let resolved = match (self, &ids.array, rows.numbers()) {
            (Index::Identity(count), Array::U64(v), _) => {
                let count = u64::from(*count);
                v.iter()
                    .enumerate()
                    .map(|(i, &n)| if valid(i) { found((n < count).then_some(n as usize)) } else { unwired })
                    .collect()
            }
            (Index::Table(table), Array::U64(v), Some(pages)) => {
                let id = |r: u32| pages[r as usize >> PAGE_BITS][r as usize & PAGE_MASK];
                v.iter()
                    .enumerate()
                    .map(|(i, &n)| {
                        if !valid(i) {
                            return unwired;
                        }
                        found(table.find(hash(IdRef::Number(n)), |&r| id(r) == n).map(|&r| r as usize))
                    })
                    .collect()
            }
            _ => (0..ids.len()).map(|i| key(ids, i).map_or(unwired, |key| found(self.get(rows, key)))).collect(),
        };
        (resolved, dangling)
    }

    /// The row with id `key`. A numbered row is also named by its id in decimal text, as ids too
    /// large for a JSON or JavaScript number are written.
    pub(crate) fn get(&self, ids: &RowIds, key: IdRef<'_>) -> Option<usize> {
        let number = |text: &str| text.parse::<u64>().ok().and_then(|n| self.get(ids, IdRef::Number(n)));
        match (self, key) {
            (Index::Identity(n), IdRef::Number(i)) => (i < u64::from(*n)).then_some(i as usize),
            (Index::Identity(_), IdRef::Text(text)) => number(text),
            (Index::Table(table), key) => table
                .find(hash(key), |&r| ids.key(r as usize) == Some(key))
                .map(|&r| r as usize)
                .or_else(|| if let IdRef::Text(text) = key { number(text) } else { None }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_extend_as_counts() {
        let ids = RowIds::Count(3).extend(&[Id::Number(3), Id::Number(4)]).expect("numbers");
        assert!(matches!(ids, RowIds::Count(5)));
        let ids = ids.extend(&[Id::Number(9)]).expect("numbers");
        assert_eq!(ids.len(), 6);
        assert_eq!(ids.id(5), Some(Id::Number(9)));
        let index = ids.index().expect("unique");
        assert_eq!(index.get(&ids, IdRef::Number(9)), Some(5));
        assert_eq!(index.get(&ids, IdRef::Number(2)), Some(2));
        assert!(ids.extend(&[Id::from("a")]).is_err(), "texts do not join numbers");
    }

    #[test]
    fn repeated_ids_are_invalid() {
        let ids = RowIds::new(&Ids::from(vec!["a", "b", "a"]));
        assert!(ids.index().is_err());
    }

    #[test]
    fn gather_keeps_ids() {
        let ids = RowIds::new(&Ids::from(vec!["a", "b", "c"])).gather(&[2, 0]);
        assert_eq!(ids.id(0), Some(Id::from("c")));
        assert_eq!(RowIds::Count(4).gather(&[0, 2]).id(1), Some(Id::Number(2)));
    }

    #[test]
    fn holes_have_no_id_and_index_past() {
        let ids = RowIds::new(&Ids::from(vec!["a", "b", "c"])).gather(&[2, super::super::values::HOLE, 0]);
        assert_eq!((ids.id(1), ids.hole()), (None, Some(1)));
        let index = ids.index().expect("unique past the hole");
        assert_eq!(index.get(&ids, IdRef::Text("a")), Some(2));
        let numbered = RowIds::Count(3).gather(&[1, super::super::values::HOLE]);
        assert_eq!(numbered.index().expect("unique").get(&numbered, IdRef::Number(1)), Some(0));
    }
}
