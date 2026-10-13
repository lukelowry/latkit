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
/// A count `n` names rows `0..n`. Lists convert from vectors and slices of numbers or texts; for a
/// reference, `None` leaves a row unwired.
#[derive(Clone, Debug)]
pub struct Ids(pub(crate) IdList);

#[derive(Clone, Debug)]
pub(crate) enum IdList {
    Count(u32),
    Listed(Values),
}

impl Ids {
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

fn key(values: &Values, i: usize) -> Option<IdRef<'_>> {
    if !values.is_valid(i) {
        return None;
    }
    match &values.array {
        Array::U64(v) => Some(IdRef::Number(v[i])),
        Array::Text(v) => Some(IdRef::Text(v.get(i))),
        _ => None,
    }
}

impl From<usize> for Ids {
    fn from(count: usize) -> Ids {
        Ids(IdList::Count(u32::try_from(count).expect("a table holds at most 2^32 rows")))
    }
}

impl From<u32> for Ids {
    fn from(count: u32) -> Ids {
        Ids(IdList::Count(count))
    }
}

impl From<i32> for Ids {
    fn from(count: i32) -> Ids {
        Ids(IdList::Count(u32::try_from(count).expect("a row count is not negative")))
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

    /// The id → row index; an error names a missing or repeated id.
    pub(crate) fn index(&self) -> Result<Index> {
        let RowIds::Listed(_) = self else { return Ok(Index::Identity(self.len() as u32)) };
        let mut table = HashTable::with_capacity(self.len());
        for row in 0..self.len() {
            let key = self.key(row).ok_or_else(|| Error::invalid("a row needs an id").at(row))?;
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
    pub(crate) fn get(&self, ids: &RowIds, key: IdRef<'_>) -> Option<usize> {
        match (self, key) {
            (Index::Identity(n), IdRef::Number(i)) => (i < u64::from(*n)).then_some(i as usize),
            (Index::Identity(_), IdRef::Text(_)) => None,
            (Index::Table(table), key) => {
                table.find(hash(key), |&r| ids.key(r as usize) == Some(key)).map(|&r| r as usize)
            }
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
}
