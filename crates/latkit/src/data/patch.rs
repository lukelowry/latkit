use std::sync::Arc;

use super::column::Column;
use super::data::Inner;
use super::ids::Ids;
use super::name::{Name, Version};
use super::samples::Samples;
use super::table::{Field, Reference, Table};
use super::values::Values;
use crate::{Error, Result};

/// Changes to a dataset, applied in order and all at once by [`Data::apply`](crate::Data::apply).
///
/// Code builds patches and sockets carry them as bytes; every change reaches a dataset the same way.
#[derive(Clone, Default, Debug)]
pub struct Patch {
    pub(crate) ops: Vec<Op>,
}

#[derive(Clone, Debug)]
pub(crate) enum Op {
    /// Names the axis sampled fields are recorded over.
    Axis { name: Name, unit: Name },
    /// Replaces a whole table, sampled fields included.
    Put(Table),
    /// Writes the given fields of the given rows; unknown ids add rows, unknown tables are added.
    Set(Table),
    /// Removes rows by id; ids that name no row are ignored.
    Remove { table: Name, ids: Ids },
    /// Records frames of sampled fields: `at.len()` frames of every row, frame-major.
    Append { table: Name, at: Vec<f64>, fields: Vec<(Name, Values)> },
    /// Forgets every sampled field's frames before a coordinate.
    Forget { before: f64 },
}

impl Patch {
    /// An empty patch.
    pub fn new() -> Patch {
        Patch::default()
    }

    /// Names the axis sampled fields are recorded over, such as `("time", "s")`.
    #[must_use]
    pub fn axis(mut self, name: impl Into<Name>, unit: impl Into<Name>) -> Patch {
        self.ops.push(Op::Axis { name: name.into(), unit: unit.into() });
        self
    }

    /// Replaces table `table.name()` with `table`, or adds it.
    #[must_use]
    pub fn put(mut self, table: Table) -> Patch {
        self.ops.push(Op::Put(table));
        self
    }

    /// Writes `table`'s fields for its rows: rows with known ids change, others are added, and fields
    /// it leaves out keep their values. Adds the table when there is none of its name.
    #[must_use]
    pub fn set(mut self, table: Table) -> Patch {
        self.ops.push(Op::Set(table));
        self
    }

    /// Removes the rows of `table` with `ids`.
    #[must_use]
    pub fn remove(mut self, table: impl Into<Name>, ids: impl Into<Ids>) -> Patch {
        self.ops.push(Op::Remove { table: table.into(), ids: ids.into() });
        self
    }

    /// Records one frame at axis coordinate `at`: one value per row of `table` for each field.
    ///
    /// A field's first frame makes it sampled. Coordinates never decrease; at equal coordinates the
    /// last frame reads.
    #[must_use]
    pub fn append<F, V>(mut self, at: f64, table: impl Into<Name>, fields: impl IntoIterator<Item = (F, V)>) -> Patch
    where
        F: Into<Name>,
        V: Into<Values>,
    {
        let fields = fields.into_iter().map(|(name, values)| (name.into(), values.into())).collect();
        self.ops.push(Op::Append { table: table.into(), at: vec![at], fields });
        self
    }

    /// Forgets every sampled field's frames before axis coordinate `before`. Whole frame pages drop,
    /// so it costs O(pages); older versions of the dataset keep what they read.
    #[must_use]
    pub fn forget(mut self, before: f64) -> Patch {
        self.ops.push(Op::Forget { before });
        self
    }

    /// This patch followed by `next`.
    #[must_use]
    pub fn then(mut self, next: Patch) -> Patch {
        self.ops.extend(next.ops);
        self
    }

    /// Whether the patch changes nothing.
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// The patch as bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        super::bytes::encode("", self)
    }

    /// A patch from [`Patch::to_bytes`] or [`Data::to_bytes`](crate::Data::to_bytes).
    pub fn from_bytes(bytes: &[u8]) -> Result<Patch> {
        super::bytes::decode(bytes).map(|(_, patch)| patch)
    }
}

impl From<Table> for Patch {
    fn from(table: Table) -> Patch {
        Patch::new().set(table)
    }
}

impl Op {
    pub(crate) fn apply(self, data: &mut Inner) -> Result<()> {
        match self {
            Op::Axis { name, unit } => {
                data.axis = Some((name, unit));
                Ok(())
            }
            Op::Put(table) => {
                let name = table.name.clone();
                table.check().map_err(|e| e.at(&name))?;
                match data.position(&name) {
                    Ok(i) => data.tables[i] = table,
                    Err(i) => data.tables.insert(i, table),
                }
                Ok(())
            }
            Op::Set(table) => {
                let name = table.name.clone();
                table.check().map_err(|e| e.at(&name))?;
                if let Some((field, _)) = table.fields.iter().find(|(_, f)| matches!(f, Field::Sampled(..))) {
                    return Err(Error::invalid("set writes values and references; append records samples")
                        .at(field)
                        .at(&name));
                }
                match data.position(&name) {
                    Ok(i) => data.tables[i] = set(&data.tables[i], table).map_err(|e| e.at(&name))?,
                    Err(i) => data.tables.insert(i, table),
                }
                Ok(())
            }
            Op::Remove { table, ids } => {
                let i = data.position(&table).map_err(|_| Error::invalid("no such table").at(&table))?;
                data.tables[i] = remove(&data.tables[i], &ids).map_err(|e| e.at(&table))?;
                Ok(())
            }
            Op::Append { table, at, fields } => {
                let i = data.position(&table).map_err(|_| Error::invalid("no such table").at(&table))?;
                let target = &mut data.tables[i];
                for (name, values) in fields {
                    let mut samples = match target.field_named(&name) {
                        None => Samples::default(),
                        Some(Field::Sampled(samples, _)) => samples.clone(),
                        Some(_) => {
                            return Err(Error::invalid("not a sampled field").at(&name).at(&table));
                        }
                    };
                    samples.append(&at, &values, target.len()).map_err(|e| e.at(&name).at(&table))?;
                    target.insert(name, Field::Sampled(samples, Version::next()));
                }
                Ok(())
            }
            Op::Forget { before } => {
                for table in &mut data.tables {
                    for (_, field) in &mut table.fields {
                        if let Field::Sampled(samples, version) = field
                            && samples.forget(before)
                        {
                            *version = Version::next();
                        }
                    }
                }
                Ok(())
            }
        }
    }
}

/// `existing` with `input`'s fields written for `input`'s rows.
fn set(existing: &Table, input: Table) -> Result<Table> {
    let index = existing.index()?;
    let mut added = Vec::new();
    let mut writes = Vec::with_capacity(input.len());
    for k in 0..input.len() {
        let key = input.ids.key(k).expect("checked ids");
        let row = index.get(&existing.ids, key).unwrap_or_else(|| {
            added.push(key.to_id());
            existing.len() + added.len() - 1
        });
        writes.push((row, k));
    }
    writes.sort_unstable();
    let len = existing.len() + added.len();
    let mut table = existing.clone();
    if !added.is_empty() {
        table.ids = existing.ids.extend(&added).map_err(|e| e.at("ids"))?;
        table.index = Arc::default();
        table.structure = Version::next();
    }
    for (name, field) in input.fields {
        let next = match (existing.field_named(&name), field) {
            (Some(Field::Values(column, _)), Field::Values(source, _)) => {
                Field::Values(column.write(len, &writes, &source).map_err(|e| e.at(&name))?, Version::next())
            }
            (None, Field::Values(source, _)) => {
                let column = Column::missing(source.like(), existing.len()).write(len, &writes, &source)?;
                Field::Values(column, Version::next())
            }
            (Some(Field::Reference(old)), Field::Reference(source)) if old.to == source.to => {
                let ids = old.ids.write(len, &writes, &source.ids).map_err(|e| e.at(&name))?;
                Field::Reference(Reference { ids, version: Version::next(), inverse: Arc::default(), ..old.clone() })
            }
            (None, Field::Reference(source)) => {
                let ids = Column::missing(source.ids.like(), existing.len()).write(len, &writes, &source.ids)?;
                Field::Reference(Reference::new(source.to, ids))
            }
            (Some(old), new) => {
                let reason = format!("{:?} values for a {:?} field", new.kind(), old.kind());
                return Err(Error::invalid(reason).at(&name));
            }
            (None, Field::Sampled(..)) => unreachable!("set refuses sampled fields"),
        };
        table.insert(name, next);
    }
    if !added.is_empty() {
        for (_, field) in &mut table.fields {
            match field {
                Field::Values(column, version) if column.len() < len => {
                    *column = column.write(len, &[], column)?;
                    *version = Version::next();
                }
                Field::Reference(reference) if reference.ids.len() < len => {
                    reference.ids = reference.ids.write(len, &[], &reference.ids)?;
                    reference.version = Version::next();
                }
                _ => {}
            }
        }
    }
    Ok(table)
}

/// `existing` without the rows named by `ids`.
fn remove(existing: &Table, ids: &Ids) -> Result<Table> {
    let index = existing.index()?;
    let mut doomed = vec![false; existing.len()];
    let mut any = false;
    for i in 0..ids.len() {
        if let Some(row) = ids.key(i).and_then(|key| index.get(&existing.ids, key)) {
            doomed[row] = true;
            any = true;
        }
    }
    if !any {
        return Ok(existing.clone());
    }
    let keep: Vec<usize> = (0..existing.len()).filter(|&r| !doomed[r]).collect();
    let mut table = existing.clone();
    table.ids = existing.ids.gather(&keep);
    table.index = Arc::default();
    let version = Version::next();
    table.structure = version;
    table.order = version;
    for (_, field) in &mut table.fields {
        *field = match field {
            Field::Values(column, _) => Field::Values(column.gather(&keep), Version::next()),
            Field::Reference(reference) => Field::Reference(Reference {
                ids: reference.ids.gather(&keep),
                version: Version::next(),
                inverse: Arc::default(),
                ..reference.clone()
            }),
            Field::Sampled(samples, _) => Field::Sampled(samples.gather(&keep), Version::next()),
        };
    }
    Ok(table)
}
