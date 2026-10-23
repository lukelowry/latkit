use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rustc_hash::FxHasher;

use super::name::{Name, Row, Version};
use super::patch::{Appends, Op, Patch};
use super::samples::Samples;
use super::table::{Field, Table};
use super::values::Value;
use crate::{Error, Result};

/// A named collection of tables, changed in place by patches.
///
/// Cloning is O(1) and a clone is a snapshot: [`apply`](Data::apply) changes only `self`, and every
/// page it does not write stays shared with earlier snapshots.
///
/// ```
/// # use latkit::{Data, Ids, Patch, Table};
/// let mut grid = Data::new("grid");
/// grid.apply(
///     Patch::new()
///         .axis("time", "s")
///         .replace(Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0]))
///         .replace(Table::new("Branch", Ids::count(1)).reference("from", "Bus", vec![1_u64]).reference("to", "Bus", vec![2_u64])),
/// )?;
/// grid.apply(Patch::new().append([0.0], "Bus", [("vm", vec![1.01, 0.99])]))?;
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

    /// Applies every change in `patch`, or none of them when one is invalid. A patch to another
    /// dataset is an error.
    ///
    /// The error's path names the change and part, such as `patch[1].Bus.kv`.
    pub fn apply(&mut self, patch: impl Into<Patch>) -> Result<()> {
        let patch = patch.into();
        if let Some(data) = &patch.data
            && *data != self.0.name
        {
            return Err(Error::invalid(format!("a patch to '{data}' applied to '{}'", self.0.name)));
        }
        if patch.ops.is_empty() {
            return Ok(());
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
        self.0 = Arc::new(next);
        Ok(())
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

    /// A dataset from [`to_bytes`](Data::to_bytes), or any bytes of a patch to a dataset.
    pub fn from_bytes(bytes: &[u8]) -> Result<Data> {
        let patch = Patch::from_bytes(bytes)?;
        let Some(name) = patch.data.clone() else {
            return Err(Error::invalid("the bytes hold a patch to no dataset").at("bytes"));
        };
        let mut data = Data::new(name);
        data.apply(patch)?;
        Ok(data)
    }

    /// A dataset from bytes: latkit's own, as [`to_bytes`](Data::to_bytes) writes them, or GeoJSON,
    /// gzip-compressed or not. GeoJSON's features become rows of tables `points`, `lines`, and
    /// `polygons` by their geometry, each with its geometry as field `geometry` and its properties as
    /// fields. `name` names the dataset, as GeoJSON needs; latkit's bytes name their own unless given
    /// one.
    ///
    /// ```
    /// let city = latkit::Data::read(br#"{"type": "Feature", "properties": {"name": "Hall"},
    ///     "geometry": {"type": "Point", "coordinates": [-97.74, 30.27]}}"#, Some("city"))?;
    /// assert_eq!(city.table("points").map(latkit::Table::len), Some(1));
    /// # Ok::<(), latkit::Error>(())
    /// ```
    pub fn read(bytes: &[u8], name: Option<&str>) -> Result<Data> {
        if bytes.starts_with(b"LATK") {
            let data = Data::from_bytes(bytes)?;
            return Ok(match name {
                Some(name) if name != data.name().as_str() => data.renamed(name),
                _ => data,
            });
        }
        let name = name.ok_or_else(|| Error::invalid("GeoJSON names its dataset").at("name"))?;
        crate::geo::geojson(name, bytes)
    }

    /// The same tables as dataset `name`: another dataset, which views draw apart from this one.
    #[must_use]
    pub fn renamed(&self, name: impl Into<Name>) -> Data {
        let version = Version::next();
        Data(Arc::new(Inner { name: name.into(), version, origin: version, ..(*self.0).clone() }))
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
