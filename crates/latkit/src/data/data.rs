use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rustc_hash::FxHasher;

use super::name::{Name, Row, Version};
use super::patch::Patch;
use super::table::{Field, Table};
use super::values::Value;
use crate::{Error, Result};

/// A named, immutable collection of tables.
///
/// Cloning is O(1) and a clone is a snapshot: [`apply`](Data::apply) changes only `self`, and every
/// page it does not write stays shared with earlier snapshots.
///
/// ```
/// # use latkit::{Data, Patch, Table};
/// let mut grid = Data::new("grid");
/// grid.apply(
///     Patch::new()
///         .axis("time", "s")
///         .set(Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0]))
///         .set(Table::new("Branch", 1).reference("from", "Bus", vec![1_u64]).reference("to", "Bus", vec![2_u64])),
/// )?;
/// grid.apply(Patch::new().append(0.0, "Bus", [("vm", vec![1.01, 0.99])]))?;
/// # Ok::<(), latkit::Error>(())
/// ```
#[derive(Clone)]
pub struct Data(pub(crate) Arc<Inner>);

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

impl Data {
    /// An empty dataset named `name`.
    pub fn new(name: impl Into<Name>) -> Data {
        let version = Version::next();
        Data(Arc::new(Inner { name: name.into(), axis: None, tables: Vec::new(), version, origin: version, schema: 0 }))
    }

    /// The dataset's name.
    pub fn name(&self) -> &Name {
        &self.0.name
    }

    /// The name and unit of the axis sampled fields are recorded over.
    pub fn axis(&self) -> Option<(&str, &str)> {
        self.0.axis.as_ref().map(|(name, unit)| (name.as_str(), unit.as_str()))
    }

    /// Every table, by name.
    pub fn tables(&self) -> impl Iterator<Item = &Table> + '_ {
        self.0.tables.iter()
    }

    /// The table named `name`.
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.0.table(name)
    }

    /// The axis coordinates the sampled fields span.
    pub fn span(&self) -> Option<[f64; 2]> {
        let spans = self.0.tables.iter().flat_map(|t| &t.fields).filter_map(|(_, field)| match field {
            Field::Sampled(samples, _) => samples.span(),
            _ => None,
        });
        spans.reduce(|a, b| [a[0].min(b[0]), a[1].max(b[1])])
    }

    /// The value of `field` for `row`; a sampled field reads its last frame.
    pub fn get(&self, row: &Row, field: &str) -> Option<Value> {
        self.get_at(row, field, f64::INFINITY)
    }

    /// The value of `field` for `row` at axis coordinate `at`: the last frame at or before it.
    pub fn get_at(&self, row: &Row, field: &str, at: f64) -> Option<Value> {
        if row.data != self.0.name {
            return None;
        }
        let table = self.table(&row.table)?;
        let index = table.row(row.id.as_ref())?;
        match table.field_named(field)? {
            Field::Reference(reference) => {
                let Value::Number(target) = reference.rows.get(index)? else { return None };
                let target_table = self.table(&reference.to)?;
                let id = target_table.ids.id(target as usize)?;
                Some(Value::Row(Row { data: self.0.name.clone(), table: reference.to.clone(), id }))
            }
            _ => table.value(index, field, at),
        }
    }

    /// Applies every change in `patch`, or none of them when one is invalid.
    ///
    /// The error's path names the change and part, such as `ops[1].Bus.kv`.
    pub fn apply(&mut self, patch: impl Into<Patch>) -> Result<()> {
        let patch = patch.into();
        if patch.ops.is_empty() {
            return Ok(());
        }
        let mut next = (*self.0).clone();
        for (i, op) in patch.ops.into_iter().enumerate() {
            op.apply(&mut next).map_err(|e| e.at(i).at("ops"))?;
        }
        next.resolve()?;
        next.schema = next.signature();
        next.version = Version::next();
        self.0 = Arc::new(next);
        Ok(())
    }

    /// The patch that builds this dataset from an empty one.
    pub fn to_patch(&self) -> Patch {
        let mut patch = Patch::new();
        if let Some((name, unit)) = &self.0.axis {
            patch = patch.axis(name, unit);
        }
        self.0.tables.iter().fold(patch, |patch, table| patch.put(table.clone()))
    }

    /// The dataset as bytes: its name and the patch that builds it.
    pub fn to_bytes(&self) -> Vec<u8> {
        super::bytes::encode(&self.0.name, &self.to_patch())
    }

    /// A dataset from [`to_bytes`](Data::to_bytes).
    pub fn from_bytes(bytes: &[u8]) -> Result<Data> {
        let (name, patch) = super::bytes::decode(bytes)?;
        if name.is_empty() {
            return Err(Error::invalid("the bytes hold a patch, not a dataset").at("bytes"));
        }
        let mut data = Data::new(name);
        data.apply(patch)?;
        Ok(data)
    }

    pub(crate) fn schema(&self) -> u64 {
        self.0.schema
    }

    /// The version the dataset began at; see [`Inner::origin`].
    pub(crate) fn origin(&self) -> Version {
        self.0.origin
    }
}

impl PartialEq for Data {
    fn eq(&self, other: &Data) -> bool {
        self.0.version == other.0.version
    }
}

impl std::fmt::Debug for Data {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Data").field("name", &self.0.name).field("tables", &self.0.tables).finish()
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
