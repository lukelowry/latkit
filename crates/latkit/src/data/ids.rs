use std::hash::BuildHasher;
use std::ops::Range;

use hashbrown::HashTable;
use hashbrown::hash_table::Entry;
use rustc_hash::FxBuildHasher;

use super::column::{Column, PAGE_BITS, PAGE_MASK};
use super::name::{Id, IdRef};
use super::values::{Array, Values};
use crate::{Error, Result};

/// Row ids, as given to [`Table::new`](crate::Table::new) or
/// [`Patch::remove`](crate::Patch::remove), or the target ids of a reference.
///
/// [`Ids::count`] names rows `0..n`. Lists convert from vectors, arrays, and slices of numbers or
/// texts. For a reference, `None` leaves a row unwired. A bare number is never a count. Use
/// [`Ids::count`], or `{"count": n}` in JSON.
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

/// Ids are equal when they list the same ids in the same order, whether counted or listed.
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
    /// The kind of the ids: numbers or texts.
    pub(crate) fn kind(&self) -> super::values::Kind {
        match self {
            RowIds::Count(_) => super::values::Kind::Number,
            RowIds::Listed(column) => column.kind(),
        }
    }

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

    /// The id of row `row`, or `None` past the last row.
    pub(crate) fn key(&self, row: usize) -> Option<IdRef<'_>> {
        match self {
            RowIds::Count(n) => (row < *n as usize).then_some(IdRef::Number(row as u64)),
            RowIds::Listed(c) => c.at(row).and_then(|(values, i)| key(values, i)),
        }
    }

    pub(crate) fn id(&self, row: usize) -> Option<Id> {
        self.key(row).map(IdRef::to_id)
    }

    /// The ids with `added` appended. A count stays a count when the new ids continue it. Errors
    /// if `added` holds another kind of id than the table's, such as texts for a table of numbers.
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
            return Err(Error::invalid("ids must be the same kind as the table's ids (numbers or texts)"));
        }
        let len = column.len() + added.len();
        let writes: Vec<(usize, usize)> = (0..added.len()).map(|k| (column.len() + k, k)).collect();
        Ok(RowIds::Listed(column.write(len, &writes, &Column::new(&source))?))
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

    /// Each page's `u64` ids, when every page stores numbers with none missing. Lookups use them to
    /// read ids without matching each one's kind.
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

    /// The first row with a missing id. Tables must not have one.
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

    /// Builds the id-to-row index, skipping rows without ids. Errors on a repeated id, naming its
    /// row.
    pub(crate) fn index(&self) -> Result<Index> {
        let RowIds::Listed(_) = self else { return Ok(Index::Identity(self.len() as u32)) };
        let mut table = HashTable::with_capacity(self.len());
        self.insert(&mut table, 0..self.len())?;
        Ok(Index::Table(table))
    }

    /// Adds rows `rows` to `table`, skipping rows without ids. Errors on a repeated id. When every
    /// id is a number, ids are read page by page without matching each one's kind.
    fn insert(&self, table: &mut HashTable<u32>, rows: Range<usize>) -> Result<()> {
        if let Some(pages) = self.numbers() {
            let id = |r: u32| pages[r as usize >> PAGE_BITS][r as usize & PAGE_MASK];
            for row in rows {
                let n = id(row as u32);
                match table.entry(hash(IdRef::Number(n)), |&r| id(r) == n, |&r| hash(IdRef::Number(id(r)))) {
                    Entry::Occupied(_) => return Err(Error::invalid(format!("id {n} appears twice")).at(row)),
                    Entry::Vacant(slot) => {
                        slot.insert(row as u32);
                    }
                }
            }
            return Ok(());
        }
        for row in rows {
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
        Ok(())
    }
}

/// Finds a row by id without allocating. Counted ids are their own row numbers. Other ids use a
/// hash table of row numbers.
#[derive(Debug)]
pub(crate) enum Index {
    Identity(u32),
    Table(HashTable<u32>),
}

pub(crate) fn hash(key: IdRef<'_>) -> u64 {
    FxBuildHasher.hash_one(key)
}

impl Index {
    /// The index of `ids`, which are this index's ids followed by new ones from row `from` on.
    /// Copies this index and adds only the new rows, without rehashing the existing ones. Rebuilds
    /// it when counted ids became a list.
    pub(crate) fn extended(&self, ids: &RowIds, from: usize) -> Result<Index> {
        match (self, ids) {
            (Index::Identity(_), RowIds::Count(n)) => Ok(Index::Identity(*n)),
            (Index::Table(table), RowIds::Listed(_)) => {
                let mut table = table.clone();
                ids.insert(&mut table, from..ids.len())?;
                Ok(Index::Table(table))
            }
            _ => ids.index(),
        }
    }

    /// The index of `ids`, which are this index's ids without the rows flagged in `doomed`. Drops
    /// those rows and renumbers the rest to close the gaps, without rehashing. Rebuilds it for
    /// counted ids.
    pub(crate) fn without(&self, doomed: &[bool], ids: &RowIds) -> Result<Index> {
        let (Index::Table(table), RowIds::Listed(_)) = (self, ids) else { return ids.index() };
        let mut moved = Vec::with_capacity(doomed.len());
        let mut next = 0;
        for &gone in doomed {
            moved.push(next);
            next += u32::from(!gone);
        }
        let mut table = table.clone();
        table.retain(|r| !doomed[*r as usize]);
        for r in &mut table {
            *r = moved[*r as usize];
        }
        Ok(Index::Table(table))
    }

    /// The row number each id in `ids` names, or `unwired` where the id is missing or names no row,
    /// plus whether any present id named no row. Picks one loop for the storage of the ids and rows
    /// up front, so it does not match storage per id.
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

    /// The row with id `key`. A numeric id can also be given as its decimal text, which is how ids
    /// too large for JSON or JavaScript numbers are written.
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
        assert!(ids.extend(&[Id::from("a")]).is_err(), "text ids cannot extend numeric ids");
    }

    #[test]
    fn indexes_follow_rows_added_and_removed() {
        let ids = RowIds::new(&Ids::from(vec![10_u64, 20, 30]));
        let index = ids.index().expect("unique");
        let more = ids.extend(&[Id::Number(40), Id::Number(50)]).expect("numbers");
        let extended = index.extended(&more, 3).expect("unique");
        assert_eq!(extended.get(&more, IdRef::Number(50)), Some(4));
        assert_eq!(extended.get(&more, IdRef::Number(20)), Some(1));
        assert!(index.extended(&more.extend(&[Id::Number(10)]).expect("numbers"), 5).is_err(), "repeated id");
        // Remove rows 1 and 3. The others move up to close the gaps.
        let doomed = [false, true, false, true, false];
        let kept = more.gather(&[0, 2, 4]);
        let fewer = extended.without(&doomed, &kept).expect("unique");
        assert_eq!(fewer.get(&kept, IdRef::Number(50)), Some(2));
        assert_eq!(fewer.get(&kept, IdRef::Number(30)), Some(1));
        assert_eq!(fewer.get(&kept, IdRef::Number(20)), None);
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
}
