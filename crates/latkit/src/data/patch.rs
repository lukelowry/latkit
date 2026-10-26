use std::sync::{Arc, OnceLock};

use super::bytes::DecodeLimits;
use super::column::Column;
use super::ids::Ids;
use super::name::{Name, Version};
use super::samples::{Run, Samples};
use super::snapshot::Inner;
use super::table::{Field, Reference, Table};
use super::values::Values;
use crate::{Error, Result};

/// A list of changes to a dataset, applied in order and atomically by
/// [`Data::apply`](crate::Data::apply): every change applies, or none does.
///
/// Patches are built in code or decoded from bytes and JSON; every change reaches a dataset this
/// way. A patch made by [`Patch::to`] names its dataset, as patches in a stream of several
/// datasets do, and applying it to another dataset is an error.
#[derive(Clone, Default, Debug)]
pub struct Patch {
    pub(crate) data: Option<Name>,
    pub(crate) ops: Vec<Op>,
}

#[derive(Clone, Debug)]
pub(crate) enum Op {
    /// Sets the axis sampled fields are recorded over.
    Axis { name: Name, unit: Name },
    /// Replaces a whole table, sampled fields included.
    Replace(Table),
    /// Writes the given fields of the given rows. Unknown ids add rows; an unknown table is added.
    Set(Table),
    /// Removes rows by id; ids that name no row are ignored.
    Remove { table: Name, ids: Ids },
    /// Records frames of sampled fields, values frame-major. Covers every row, or the rows `ids`
    /// names; other rows keep their last values.
    Append { table: Name, at: Vec<f64>, ids: Option<Ids>, fields: Vec<(Name, Values)> },
    /// Forgets every sampled field's frames before a coordinate.
    Forget { before: f64 },
    /// Inserts a run of a sampled field's entries: their coordinates, and their values entry-major.
    Frames { table: Name, field: Name, run: Run, at: Vec<f64>, values: Vec<f32> },
}

impl Patch {
    /// An empty patch that applies to any dataset.
    pub fn new() -> Patch {
        Patch::default()
    }

    /// An empty patch for dataset `data` only; applying it to another dataset is an error.
    pub fn to(data: impl Into<Name>) -> Patch {
        Patch { data: Some(data.into()), ops: Vec::new() }
    }

    /// The dataset the patch changes, when it names one.
    pub fn data(&self) -> Option<&Name> {
        self.data.as_ref()
    }

    /// Sets the axis that sampled fields are recorded over, such as `("time", "s")`.
    #[must_use]
    pub fn axis(mut self, name: impl Into<Name>, unit: impl Into<Name>) -> Patch {
        self.ops.push(Op::Axis { name: name.into(), unit: unit.into() });
        self
    }

    /// Replaces table `table.name()` with `table`, sampled fields included, or adds it.
    #[must_use]
    pub fn replace(mut self, table: Table) -> Patch {
        self.ops.push(Op::Replace(table));
        self
    }

    /// Writes `table`'s fields for its rows. Rows with existing ids are updated, new ids add rows,
    /// and fields `table` leaves out keep their values (missing for added rows). Adds the table if
    /// none has its name.
    #[must_use]
    pub fn set(mut self, table: Table) -> Patch {
        self.ops.push(Op::Set(table));
        self
    }

    /// Removes the rows of `table` with `ids`. Ids that match no row are ignored; a missing table
    /// is an error.
    #[must_use]
    pub fn remove(mut self, table: impl Into<Name>, ids: impl Into<Ids>) -> Patch {
        self.ops.push(Op::Remove { table: table.into(), ids: ids.into() });
        self
    }

    /// Records a frame of `table` at each axis coordinate in `at`. Each field gives a value per row
    /// per coordinate, frame-major: every row's value at the first coordinate, then at the next.
    ///
    /// A field's first frame makes it sampled. Coordinates must be finite and must not decrease; at
    /// equal coordinates, reads return the last frame.
    #[must_use]
    pub fn append<F, V>(
        mut self,
        table: impl Into<Name>,
        at: impl AsRef<[f64]>,
        fields: impl IntoIterator<Item = (F, V)>,
    ) -> Patch
    where
        F: Into<Name>,
        V: Into<Values>,
    {
        let fields = fields.into_iter().map(|(name, values)| (name.into(), values.into())).collect();
        self.ops.push(Op::Append { table: table.into(), at: at.as_ref().to_vec(), ids: None, fields });
        self
    }

    /// Like [`append`](Patch::append), but records values only for the rows `ids` names: one per
    /// named row per coordinate, frame-major. Other rows keep their last value. An id that names no
    /// row is an error.
    #[must_use]
    pub fn append_rows<F, V>(
        mut self,
        table: impl Into<Name>,
        at: impl AsRef<[f64]>,
        fields: impl IntoIterator<Item = (F, V)>,
        ids: impl Into<Ids>,
    ) -> Patch
    where
        F: Into<Name>,
        V: Into<Values>,
    {
        let fields = fields.into_iter().map(|(name, values)| (name.into(), values.into())).collect();
        self.ops.push(Op::Append { table: table.into(), at: at.as_ref().to_vec(), ids: Some(ids.into()), fields });
        self
    }

    /// Forgets every sampled field's frames before axis coordinate `before`. Whole pages are
    /// dropped, so the cost is O(pages). Later frames keep their numbers, and older snapshots still
    /// read the forgotten frames.
    #[must_use]
    pub fn forget(mut self, before: f64) -> Patch {
        self.ops.push(Op::Forget { before });
        self
    }

    /// Inserts a run of entries of sampled field `field` at level `level`, numbered from `first`,
    /// as time tiles (such as `latkit tile` writes) store them. At level 0 the entries are frames:
    /// one coordinate each in `at` and one value per row of `table` in `values`. At level `k` they
    /// are buckets of `8^k` frames: each bucket's first and last frame's coordinates in `at`, and
    /// in `values` every bucket's least value per row, followed by every bucket's greatest. NaN is
    /// missing.
    ///
    /// None of the entries may already be present. Entries outside the field's frame range extend
    /// it, and frames in any gap stay missing.
    ///
    /// ```
    /// # use latkit::{Data, Ids, Patch, Table};
    /// let grid = Data::new("grid");
    /// grid.apply(Patch::new().replace(Table::new("Bus", Ids::count(2))))?;
    /// // Frames 100 and 101, then the bucket of frames 0..8.
    /// grid.apply(Patch::new().frames("Bus", "vm", 0, 100, [100.0, 101.0], [1.0, 0.9, 1.02, 0.98]))?;
    /// grid.apply(Patch::new().frames("Bus", "vm", 1, 0, [0.0, 7.0], [0.95, 0.9, 1.05, 1.0]))?;
    /// assert_eq!(grid.snapshot().describe().span, Some([0.0, 101.0]));
    /// # Ok::<(), latkit::Error>(())
    /// ```
    #[must_use]
    pub fn frames(
        mut self,
        table: impl Into<Name>,
        field: impl Into<Name>,
        level: u32,
        first: u64,
        at: impl Into<Vec<f64>>,
        values: impl Into<Vec<f32>>,
    ) -> Patch {
        self.ops.push(Op::frames(table.into(), field.into(), level, first, at.into(), values.into()));
        self
    }

    /// This patch followed by `next`'s changes. The result keeps this patch's dataset.
    #[must_use]
    pub fn extend(mut self, next: Patch) -> Patch {
        self.ops.extend(next.ops);
        self
    }

    /// Whether the patch changes nothing.
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// Encodes the patch as one binary frame, including its dataset's name when it has one.
    pub fn to_bytes(&self) -> Vec<u8> {
        super::bytes::encode(self)
    }

    /// Decodes one whole frame written by [`Patch::to_bytes`] or
    /// [`Snapshot::to_bytes`](crate::Snapshot::to_bytes), with default [`DecodeLimits`]. Errors if
    /// `bytes` are malformed, truncated, or extend past the frame.
    pub fn from_bytes(bytes: &[u8]) -> Result<Patch> {
        super::bytes::decode(bytes)
    }

    /// Decodes the back-to-back frames `read` carries, as from a file, pipe, or socket, yielding
    /// each patch once its frame has fully arrived. Each frame states its length up front, so one
    /// longer than `limits` allows fails with [`Error::Limit`](crate::Error::Limit) before its body
    /// is read, and an untrusted stream buffers only one frame at a time. The iterator ends when
    /// the input ends between frames, or after the first error.
    ///
    /// ```
    /// # use latkit::{DecodeLimits, Ids, Patch, Table};
    /// let mut bytes = Patch::to("grid").set(Table::new("Bus", Ids::count(1))).to_bytes();
    /// bytes.extend(Patch::to("grid").remove("Bus", [0_u64]).to_bytes());
    /// let patches = Patch::stream(&bytes[..], DecodeLimits::default()).collect::<latkit::Result<Vec<_>>>()?;
    /// assert_eq!(patches.len(), 2);
    /// assert_eq!(patches[1].data().map(|d| d.as_str()), Some("grid"));
    /// let small = DecodeLimits { frame_bytes: 16, ..DecodeLimits::default() };
    /// assert!(Patch::stream(&bytes[..], small).all(|patch| patch.is_err()), "longer than the limit");
    /// # Ok::<(), latkit::Error>(())
    /// ```
    pub fn stream<R: std::io::Read>(read: R, limits: DecodeLimits) -> impl Iterator<Item = Result<Patch>> {
        super::bytes::stream(read, limits)
    }
}

impl From<Table> for Patch {
    fn from(table: Table) -> Patch {
        Patch::new().set(table)
    }
}

/// Consecutive appends to the same fields of every row of one table, merged into one append so
/// each field is written once, however many changes carried its frames.
pub(crate) struct Appends {
    table: Name,
    at: Vec<f64>,
    fields: Vec<(Name, Vec<Values>)>,
}

impl Appends {
    pub(crate) fn new(table: Name, at: Vec<f64>, fields: Vec<(Name, Values)>) -> Appends {
        Appends { table, at, fields: fields.into_iter().map(|(name, values)| (name, vec![values])).collect() }
    }

    /// Whether an append of `fields` at `at` to `table` (with `rows` rows) can join this run: the
    /// same table, the same fields of the same kinds, a value for every row at each coordinate, and
    /// finite coordinates that do not decrease. An append that cannot join is applied alone, so its
    /// error names it.
    pub(crate) fn continues(&self, table: &Name, at: &[f64], fields: &[(Name, Values)], rows: Option<usize>) -> bool {
        let Some(rows) = rows else { return false };
        let last = self.at.last().copied().unwrap_or(f64::NEG_INFINITY);
        *table == self.table
            && fields.len() == self.fields.len()
            && fields.iter().zip(&self.fields).all(|((name, values), (run, parts))| {
                name == run && values.kind() == parts[0].kind() && values.len() == at.len() * rows
            })
            && at.iter().all(|t| t.is_finite())
            && at.first().is_none_or(|&first| first >= last)
            && at.windows(2).all(|w| w[0] <= w[1])
    }

    pub(crate) fn push(&mut self, at: Vec<f64>, fields: Vec<(Name, Values)>) {
        self.at.extend(at);
        for ((_, parts), (_, values)) in self.fields.iter_mut().zip(fields) {
            parts.push(values);
        }
    }

    /// The run as one append.
    pub(crate) fn op(self) -> Op {
        let fields = self
            .fields
            .into_iter()
            .map(|(name, mut parts)| {
                let values = if parts.len() == 1 {
                    parts.pop().expect("a part")
                } else {
                    Values::concat(&parts.iter().collect::<Vec<_>>())
                };
                (name, values)
            })
            .collect();
        Op::Append { table: self.table, at: self.at, ids: None, fields }
    }
}

impl Op {
    /// An [`Op::Frames`] of entries of `level` from `first`; the entry count follows from the
    /// number of coordinates in `at`.
    pub(crate) fn frames(table: Name, field: Name, level: u32, first: u64, at: Vec<f64>, values: Vec<f32>) -> Op {
        let entries = (at.len() / super::samples::coordinates(level)) as u64;
        let run = Run { level, entries: first..first.saturating_add(entries) };
        Op::Frames { table, field, run, at, values }
    }

    pub(crate) fn apply(self, data: &mut Inner) -> Result<()> {
        match self {
            Op::Axis { name, unit } => {
                data.axis = Some((name, unit));
                Ok(())
            }
            Op::Replace(table) => {
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
                    return Err(Error::invalid("sampled fields are written with append, not with set")
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
            Op::Append { table, at, ids, fields } => {
                let i = data.position(&table).map_err(|_| Error::invalid("no such table").at(&table))?;
                let target = &mut data.tables[i];
                let rows = ids.map(|ids| rows_named(target, &ids)).transpose().map_err(|e| e.at(&table))?;
                for (name, values) in fields {
                    let mut samples = match target.field_named(&name) {
                        None => Samples::default(),
                        Some(Field::Sampled(samples, _)) => samples.clone(),
                        Some(_) => {
                            return Err(Error::invalid("not a sampled field").at(&name).at(&table));
                        }
                    };
                    let appended = match &rows {
                        None => samples.append(&at, &values, target.len()),
                        Some(rows) => samples.append_rows(&at, &values, rows, target.len()),
                    };
                    appended.map_err(|e| e.at(&name).at(&table))?;
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
            Op::Frames { table, field, run, at, values } => {
                let i = data.position(&table).map_err(|_| Error::invalid("no such table").at(&table))?;
                let target = &mut data.tables[i];
                let per_row = run.len() * super::samples::sides(run.level);
                let rows = values.len().checked_div(per_row).unwrap_or(0);
                if rows > target.len() {
                    return Err(Error::invalid(format!("values for {rows} rows, but the table has {}", target.len()))
                        .at(&field)
                        .at(&table));
                }
                let mut samples = match target.field_named(&field) {
                    None => Samples::default(),
                    Some(Field::Sampled(samples, _)) => samples.clone(),
                    Some(_) => return Err(Error::invalid("not a sampled field").at(&field).at(&table)),
                };
                samples.insert(&run, &at, &values, rows).map_err(|e| e.at(&field).at(&table))?;
                target.insert(field, Field::Sampled(samples, Version::next()));
                Ok(())
            }
        }
    }
}

/// The row of `table` for each id in `ids`. An id that names no row is an error, since an append
/// records frames only for existing rows.
fn rows_named(table: &Table, ids: &Ids) -> Result<Vec<usize>> {
    let index = table.index()?;
    (0..ids.len())
        .map(|k| {
            let key = ids.key(k).ok_or_else(|| Error::invalid("a row needs an id").at(k).at("ids"))?;
            index.get(&table.ids, key).ok_or_else(|| Error::invalid(format!("no row {key:?}")).at(k).at("ids"))
        })
        .collect()
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
        let index = index.extended(&table.ids, existing.len()).map_err(|e| e.at("ids"))?;
        table.index = Arc::new(OnceLock::from(index));
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
    let mut table = existing.rows(&keep);
    table.index = Arc::new(OnceLock::from(index.without(&doomed, &table.ids)?));
    Ok(table)
}
