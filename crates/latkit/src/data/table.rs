use std::sync::{Arc, OnceLock};

use super::bits::Bits;
use super::column::Column;
use super::ids::{Ids, Index, RowIds};
use super::name::{Id, IdRef, Name, PageId, Version};
use super::samples::Samples;
use super::values::{Array, Kind, Value, Values};
use crate::{Error, Result};

/// A named set of rows with fields: the rows of one type in a dataset, or rows to write into one.
///
/// ```
/// # use latkit::Table;
/// let buses = Table::new("Bus", vec![101_u64, 102, 103])
///     .field("lon", vec![-97.7, -97.6, -97.5])
///     .field("name", vec!["North", "Mid", "South"]);
/// let branches = Table::new("Branch", 2).reference("from", "Bus", vec![101_u64, 102]);
/// ```
#[derive(Clone)]
pub struct Table {
    pub(crate) name: Name,
    pub(crate) ids: RowIds,
    pub(crate) index: Arc<OnceLock<Index>>,
    pub(crate) fields: Vec<(Name, Field)>,
    /// Changes when rows are added or removed.
    pub(crate) structure: Version,
    /// Changes when rows are removed, which moves the rows after them.
    pub(crate) order: Version,
}

/// The values of one field of a table.
#[derive(Clone)]
pub(crate) enum Field {
    Values(Column, Version),
    Reference(Reference),
    Sampled(Samples, Version),
}

/// A field naming rows of another table by id. Row indices derive from the ids and the target's rows.
#[derive(Clone)]
pub(crate) struct Reference {
    pub(crate) to: Name,
    pub(crate) ids: Column,
    /// Target row of each row as `u32`; missing where unwired or the id names no row. Its pages align
    /// with the pages of `ids`.
    pub(crate) rows: Column,
    /// What each page of `rows` was resolved from.
    pub(crate) resolved: Arc<[Resolved]>,
    pub(crate) version: Version,
    /// The rows naming each target row, built on first use from `rows`, and shared by every snapshot
    /// holding them.
    pub(crate) inverse: Arc<OnceLock<Inverse>>,
}

/// A reference row's target where it names no row.
pub(crate) const UNWIRED: u32 = u32::MAX;

/// The rows naming each target row of a reference: target `t`'s are `rows[starts[t]..starts[t + 1]]`,
/// in row order.
#[derive(Default)]
pub(crate) struct Inverse {
    starts: Vec<u32>,
    rows: Vec<u32>,
}

impl Inverse {
    /// The rows naming target row `target`.
    pub(crate) fn of(&self, target: usize) -> &[u32] {
        match (self.starts.get(target), self.starts.get(target + 1)) {
            (Some(&start), Some(&end)) => &self.rows[start as usize..end as usize],
            _ => &[],
        }
    }
}

/// The inputs one page of a reference's rows was resolved from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Resolved {
    pub(crate) ids: PageId,
    pub(crate) order: Version,
    pub(crate) structure: Version,
    /// Whether an id on the page named no row.
    pub(crate) dangling: bool,
}

impl Field {
    pub(crate) fn kind(&self) -> Kind {
        match self {
            Field::Values(column, _) => column.kind(),
            Field::Reference(_) => Kind::Reference,
            Field::Sampled(..) => Kind::Sampled,
        }
    }

    /// Changes whenever the field's values do.
    pub(crate) fn version(&self) -> Version {
        match self {
            Field::Values(_, v) | Field::Sampled(_, v) => *v,
            Field::Reference(r) => r.version,
        }
    }
}

impl Reference {
    pub(crate) fn new(to: Name, ids: Column) -> Reference {
        let rows = Column::missing(&Values::from(Vec::<u32>::new()), 0);
        Reference { to, ids, rows, resolved: Arc::new([]), version: Version::next(), inverse: Arc::default() }
    }

    /// The target row row `row` names.
    pub(crate) fn target(&self, row: usize) -> Option<u32> {
        match self.rows.get(row)? {
            Value::Number(n) => Some(n as u32),
            _ => None,
        }
    }

    /// Every row's target row, [`UNWIRED`] where it names none: read page by page, not value by value.
    pub(crate) fn targets(&self) -> Vec<u32> {
        let mut out = Vec::with_capacity(self.rows.len());
        for page in self.rows.pages() {
            let values = &page.values;
            match (&values.array, &values.valid) {
                (Array::U32(rows), None) => out.extend_from_slice(rows),
                (Array::U32(rows), Some(valid)) => {
                    out.extend(rows.iter().enumerate().map(|(i, &t)| if valid.get(i) { t } else { UNWIRED }));
                }
                _ => out.extend((0..values.len()).map(|i| match values.get(i) {
                    Some(Value::Number(n)) => n as u32,
                    _ => UNWIRED,
                })),
            }
        }
        out
    }

    /// The rows naming each target row: counted, the counts summed, then each row written at its
    /// target's place.
    pub(crate) fn inverse(&self) -> &Inverse {
        self.inverse.get_or_init(|| {
            let targets = self.targets();
            let count = targets.iter().filter(|&&t| t != UNWIRED).max().map_or(0, |&t| t as usize + 1);
            let mut starts = vec![0_u32; count + 1];
            for &t in targets.iter().filter(|&&t| t != UNWIRED) {
                starts[t as usize + 1] += 1;
            }
            for t in 0..count {
                starts[t + 1] += starts[t];
            }
            let mut next = starts.clone();
            let mut rows = vec![0_u32; starts[count] as usize];
            for (row, &t) in targets.iter().enumerate() {
                if t != UNWIRED {
                    rows[next[t as usize] as usize] = row as u32;
                    next[t as usize] += 1;
                }
            }
            Inverse { starts, rows }
        })
    }

    /// Whether `rows` must be resolved again against a target with these versions.
    pub(crate) fn stale(&self, order: Version, structure: Version) -> bool {
        self.resolved.len() != self.ids.pages().len()
            || self
                .ids
                .pages()
                .iter()
                .zip(self.resolved.iter())
                .any(|(page, r)| r.ids != page.id || r.order != order || (r.dangling && r.structure != structure))
    }

    /// Resolves the pages whose inputs changed against `target`.
    pub(crate) fn resolve(&self, target: &Table) -> Result<Reference> {
        let index = target.index()?;
        let (order, structure) = (target.order, target.structure);
        let mut pages = Vec::with_capacity(self.ids.pages().len());
        let mut resolved = Vec::with_capacity(self.ids.pages().len());
        for (p, page) in self.ids.pages().iter().enumerate() {
            let old = self.resolved.get(p).zip(self.rows.pages().get(p));
            if let Some((r, rows)) = old
                && r.ids == page.id
                && r.order == order
                && (!r.dangling || r.structure == structure)
            {
                pages.push(rows.values.clone());
                resolved.push(*r);
                continue;
            }
            let (rows, dangling) = index.resolve(&target.ids, &page.values, UNWIRED);
            let valid = Bits::from_fn(rows.len(), |i| rows[i] != UNWIRED);
            pages.push(Values { array: Array::U32(rows.into()), valid: (!valid.all()).then_some(valid) });
            resolved.push(Resolved { ids: page.id, order, structure, dangling });
        }
        Ok(Reference {
            to: self.to.clone(),
            ids: self.ids.clone(),
            rows: Column::from_pages(pages, &Values::from(Vec::<u32>::new())),
            resolved: resolved.into(),
            version: Version::next(),
            inverse: Arc::default(),
        })
    }
}

impl Table {
    /// A table named `name` with rows `ids`: a count for rows `0..n`, or a list of numbers or texts.
    pub fn new(name: impl Into<Name>, ids: impl Into<Ids>) -> Table {
        let version = Version::next();
        Table {
            name: name.into(),
            ids: RowIds::new(&ids.into()),
            index: Arc::default(),
            fields: Vec::new(),
            structure: version,
            order: version,
        }
    }

    /// Adds or replaces field `name`: one value per row.
    #[must_use]
    pub fn field(mut self, name: impl Into<Name>, values: impl Into<Values>) -> Table {
        let column = Column::new(&values.into());
        self.insert(name.into(), Field::Values(column, Version::next()));
        self
    }

    /// Adds or replaces field `name` naming rows of table `to` by id; `None` leaves a row unwired.
    #[must_use]
    pub fn reference(mut self, name: impl Into<Name>, to: impl Into<Name>, ids: impl Into<Ids>) -> Table {
        let ids = match RowIds::new(&ids.into()) {
            RowIds::Count(n) => Column::new(&Values::from((0..u64::from(n)).collect::<Vec<_>>())),
            RowIds::Listed(column) => column,
        };
        self.insert(name.into(), Field::Reference(Reference::new(to.into(), ids)));
        self
    }

    /// The table's name.
    pub fn name(&self) -> &Name {
        &self.name
    }

    /// The number of rows.
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Whether the table has no rows.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every row's id, in row order.
    pub fn ids(&self) -> impl Iterator<Item = Id> + '_ {
        (0..self.len()).filter_map(|row| self.ids.id(row))
    }

    /// Every field's name and kind, by name.
    pub fn fields(&self) -> impl Iterator<Item = (&Name, Kind)> + '_ {
        self.fields.iter().map(|(name, field)| (name, field.kind()))
    }

    /// What field `name` holds.
    pub fn kind(&self, name: &str) -> Option<Kind> {
        self.field_named(name).map(Field::kind)
    }

    /// The value of `field` for the row with `id`. A sampled field reads its last frame; a reference
    /// reads the target's id.
    pub fn get(&self, id: impl Into<Id>, field: &str) -> Option<Value> {
        let row = self.row(id.into().as_ref())?;
        self.value(row, field, f64::INFINITY)
    }

    pub(crate) fn value(&self, row: usize, field: &str, at: f64) -> Option<Value> {
        match self.field_named(field)? {
            Field::Values(column, _) => column.get(row),
            Field::Reference(reference) => reference.ids.get(row),
            Field::Sampled(samples, _) => samples.value(row, samples.frame_at(at)?).map(Value::Number),
        }
    }

    /// The row with `id`.
    pub(crate) fn row(&self, id: IdRef<'_>) -> Option<usize> {
        self.index().ok()?.get(&self.ids, id)
    }

    pub(crate) fn index(&self) -> Result<&Index> {
        if let Some(index) = self.index.get() {
            return Ok(index);
        }
        let index = self.ids.index()?;
        Ok(self.index.get_or_init(|| index))
    }

    pub(crate) fn field_named(&self, name: &str) -> Option<&Field> {
        let i = self.fields.binary_search_by(|(n, _)| n.as_str().cmp(name)).ok()?;
        Some(&self.fields[i].1)
    }

    pub(crate) fn insert(&mut self, name: Name, field: Field) {
        match self.fields.binary_search_by(|(n, _)| n.cmp(&name)) {
            Ok(i) => self.fields[i].1 = field,
            Err(i) => self.fields.insert(i, (name, field)),
        }
    }

    /// Checks that every field has one value per row and the ids are present and unique.
    pub(crate) fn check(&self) -> Result<()> {
        if self.name.is_empty() {
            return Err(Error::invalid("a table needs a name"));
        }
        self.index().map_err(|e| e.at("ids"))?;
        for (name, field) in &self.fields {
            let len = match field {
                Field::Values(column, _) => column.len(),
                Field::Reference(reference) => reference.ids.len(),
                Field::Sampled(..) => continue,
            };
            if len != self.len() {
                return Err(Error::invalid(format!("{len} values for {} rows", self.len())).at(name));
            }
        }
        Ok(())
    }
}

impl std::fmt::Debug for Table {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Table")
            .field("name", &self.name)
            .field("rows", &self.len())
            .field("fields", &self.fields().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}
