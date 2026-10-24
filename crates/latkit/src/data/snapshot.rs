use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rustc_hash::FxHasher;

use super::name::{Id, Name, Row, Version};
use super::patch::{Appends, Op, Patch};
use super::samples::Samples;
use super::table::{Field, Table};
use super::values::Value;
use crate::{Error, Result};

/// One version of a dataset: immutable, O(1) to keep, and sharing every page with the versions
/// before and after it. [`Data::snapshot`](crate::Data::snapshot) takes one; a view given one draws
/// it as it is.
///
/// It reads alike whatever came of it since: what it holds described, values, queries, and envelopes.
///
/// ```
/// # use latkit::{Data, Patch, Table, Value};
/// let grid = Data::new("grid");
/// grid.apply(Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0]))?;
/// let before = grid.snapshot();
/// grid.apply(Patch::new().remove("Bus", [2_u64]))?;
/// assert_eq!(before.get("Bus", 2_u64, "kv", None), Some(Value::Number(115.0)));
/// assert_eq!(grid.snapshot().get("Bus", 2_u64, "kv", None), None);
/// # Ok::<(), latkit::Error>(())
/// ```
#[derive(Clone)]
pub struct Snapshot(pub(crate) Arc<Inner>);

#[derive(Clone)]
pub(crate) struct Inner {
    pub(crate) name: Name,
    pub(crate) axis: Option<(Name, Name)>,
    /// Sorted by name.
    pub(crate) tables: Vec<Table>,
    pub(crate) version: Version,
    /// The version the dataset began at, which every version applied from it shares: a view eases
    /// rows from one of them to the next, and replaces the rows of another dataset of the same name.
    pub(crate) origin: Version,
    /// Changes when a table, field, or kind is added or changed; marks recompile only then.
    pub(crate) schema: u64,
}

impl Snapshot {
    /// An empty dataset named `name`.
    pub(crate) fn new(name: impl Into<Name>) -> Snapshot {
        let version = Version::next();
        Snapshot(Arc::new(Inner {
            name: name.into(),
            axis: None,
            tables: Vec::new(),
            version,
            origin: version,
            schema: 0,
        }))
    }

    /// The dataset's name.
    pub fn name(&self) -> &Name {
        &self.0.name
    }

    /// The name and unit of the axis sampled fields are recorded over.
    pub(crate) fn axis(&self) -> Option<(&str, &str)> {
        self.0.axis.as_ref().map(|(name, unit)| (name.as_str(), unit.as_str()))
    }

    /// Every table, by name.
    pub(crate) fn tables(&self) -> impl Iterator<Item = &Table> + '_ {
        self.0.tables.iter()
    }

    /// The table named `name`.
    pub(crate) fn table(&self, name: &str) -> Option<&Table> {
        self.0.table(name)
    }

    /// The axis coordinates the sampled fields span.
    pub(crate) fn span(&self) -> Option<[f64; 2]> {
        let spans = self.0.tables.iter().flat_map(|t| &t.fields).filter_map(|(_, field)| match field {
            Field::Sampled(samples, _) => samples.span(),
            _ => None,
        });
        spans.reduce(|a, b| [a[0].min(b[0]), a[1].max(b[1])])
    }

    /// The value of `field` for the row of `table` with `id`; `None` where it is missing. A sampled
    /// field reads its last frame at or before axis coordinate `at`, its last frame unless given; a
    /// reference reads the row it names.
    pub fn get(&self, table: &str, id: impl Into<Id>, field: &str, at: impl Into<Option<f64>>) -> Option<Value> {
        let rows = self.table(table)?;
        let index = rows.row(id.into().as_ref())?;
        match rows.field_named(field)? {
            Field::Reference(reference) => {
                let Value::Number(target) = reference.rows.get(index)? else { return None };
                let id = self.table(&reference.to)?.ids.id(target as usize)?;
                Some(Value::Row(Row { data: self.0.name.clone(), table: reference.to.clone(), id }))
            }
            _ => rows.value(index, field, at.into().unwrap_or(f64::INFINITY)),
        }
    }

    /// The version `patch` makes of this one: every change in it, or none of them when one is invalid,
    /// as an error whose path names the change and part, such as `patch[1].Bus.kv`. A patch to another
    /// dataset is an error.
    pub(crate) fn applied(&self, patch: Patch) -> Result<Snapshot> {
        if let Some(data) = &patch.data
            && *data != self.0.name
        {
            return Err(Error::invalid(format!("a patch to '{data}' applied to '{}'", self.0.name)));
        }
        if patch.ops.is_empty() {
            return Ok(self.clone());
        }
        let mut next = (*self.0).clone();
        let mut ops = patch.ops.into_iter().enumerate().peekable();
        while let Some((i, op)) = ops.next() {
            let op = match op {
                // A run of appends to the same fields of every row of a table records as one.
                Op::Append { table, at, ids: None, fields } => {
                    let rows = next.table(&table).map(Table::len);
                    let mut run = Appends::new(table, at, fields);
                    while let Some((_, Op::Append { table, at, ids: None, fields })) = ops.peek()
                        && run.continues(table, at, fields, rows)
                    {
                        let Some((_, Op::Append { at, fields, .. })) = ops.next() else { break };
                        run.push(at, fields);
                    }
                    run.op()
                }
                op => op,
            };
            op.apply(&mut next).map_err(|e| e.at(i).at("patch"))?;
        }
        next.resolve()?;
        next.schema = next.signature();
        next.version = Version::next();
        Ok(Snapshot(Arc::new(next)))
    }

    /// The patch to this dataset that builds it from an empty one.
    pub fn to_patch(&self) -> Patch {
        let mut patch = Patch::to(self.0.name.clone());
        if let Some((name, unit)) = &self.0.axis {
            patch = patch.axis(name, unit);
        }
        self.0.tables.iter().fold(patch, |patch, table| patch.replace(table.clone()))
    }

    /// The dataset as bytes: the patch to it that builds it.
    pub fn to_bytes(&self) -> Vec<u8> {
        self.to_patch().to_bytes()
    }

    /// The dataset the bytes of a patch to a dataset build.
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Snapshot> {
        let patch = Patch::from_bytes(bytes)?;
        let Some(name) = patch.data.clone() else {
            return Err(Error::invalid("the bytes hold a patch to no dataset").at("bytes"));
        };
        Snapshot::new(name).applied(patch)
    }

    /// The same tables as dataset `name`: another dataset, which views draw apart from this one.
    pub(crate) fn renamed(&self, name: impl Into<Name>) -> Snapshot {
        let version = Version::next();
        Snapshot(Arc::new(Inner { name: name.into(), version, origin: version, ..(*self.0).clone() }))
    }

    /// Which version of its dataset this is: two snapshots of the same version are the same.
    pub(crate) fn version(&self) -> Version {
        self.0.version
    }

    pub(crate) fn schema(&self) -> u64 {
        self.0.schema
    }

    /// The version the dataset began at; see [`Inner::origin`].
    pub(crate) fn origin(&self) -> Version {
        self.0.origin
    }

    /// Changes sampled field `field` of table `table` with `change`, starting it empty where the table
    /// has no field of its name: what time tiles put in and let go of. Whether anything changed: not
    /// where `change` says so, or where there is no such table or the field holds no samples.
    pub(crate) fn sampled(&mut self, table: &str, field: &str, change: impl FnOnce(&mut Samples) -> bool) -> bool {
        let Ok(i) = self.0.position(table) else { return false };
        let mut samples = match self.0.tables[i].field_named(field) {
            None => Samples::default(),
            Some(Field::Sampled(samples, _)) => samples.clone(),
            Some(_) => return false,
        };
        if !change(&mut samples) {
            return false;
        }
        let mut next = (*self.0).clone();
        next.tables[i].insert(field.into(), Field::Sampled(samples, Version::next()));
        next.schema = next.signature();
        next.version = Version::next();
        self.0 = Arc::new(next);
        true
    }
}

impl PartialEq for Snapshot {
    fn eq(&self, other: &Snapshot) -> bool {
        self.0.version == other.0.version
    }
}

impl std::fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Snapshot").field("name", &self.0.name).field("tables", &self.0.tables).finish()
    }
}

impl Inner {
    pub(crate) fn table(&self, name: &str) -> Option<&Table> {
        let i = self.tables.binary_search_by(|t| t.name.as_str().cmp(name)).ok()?;
        Some(&self.tables[i])
    }

    pub(crate) fn position(&self, name: &str) -> std::result::Result<usize, usize> {
        self.tables.binary_search_by(|t| t.name.as_str().cmp(name))
    }

    /// Resolves every reference whose ids or target rows changed.
    fn resolve(&mut self) -> Result<()> {
        for t in 0..self.tables.len() {
            for f in 0..self.tables[t].fields.len() {
                let (name, Field::Reference(reference)) = &self.tables[t].fields[f] else { continue };
                let target = self.table(&reference.to).ok_or_else(|| {
                    Error::invalid(format!("no table {}", reference.to)).at(name).at(&self.tables[t].name)
                })?;
                if !reference.stale(target.order, target.structure) {
                    continue;
                }
                let resolved = reference.resolve(target)?;
                self.tables[t].fields[f].1 = Field::Reference(resolved);
            }
        }
        Ok(())
    }

    /// A deterministic digest of every table's name and every field's name, kind, and target.
    fn signature(&self) -> u64 {
        let mut hasher = FxHasher::default();
        for table in &self.tables {
            table.name.hash(&mut hasher);
            for (name, field) in &table.fields {
                name.hash(&mut hasher);
                field.kind().hash(&mut hasher);
                if let Field::Reference(reference) = field {
                    reference.to.hash(&mut hasher);
                }
            }
        }
        hasher.finish()
    }
}
