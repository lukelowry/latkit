//! Queries read a page of a table's rows, filtered and sorted, with their fields or computed
//! values. They evaluate on the CPU with the same expressions marks draw with, reading a plain
//! field a page at a time. The result is a table, so it has the same shape as the input.

use std::cmp::Ordering;

use super::ids::Ids;
use super::name::Name;
use super::ordered::Ordered;
use super::table::{Field, Table};
use super::values::Values;
use super::{Snapshot, column::Column};
use crate::expr::Expr;
use crate::expr::cpu::Rows;
use crate::{Error, Result};

/// A request to read rows of a table. It starts from the rows in `ids` (default: every row), keeps
/// the rows `filter` accepts, sorts them by `sort`, and returns up to `limit` of them starting at
/// `offset`. Each row comes with the fields `select` names or computes (default: every field).
/// Sampled fields are read at axis coordinate `at` (default: their last frame). Like a scene, it is
/// plain data that deserializes from JSON.
///
/// ```
/// use latkit::{Data, Ids, Order, Query, Table, field};
/// let data = Data::new("grid");
/// data.apply(Table::new("Branch", Ids::count(3)).field("loading", vec![40.0, 95.0, 120.0]).field("name", vec!["a", "b", "c"]))?;
/// let hot = data.snapshot().query(&Query::of("Branch").filter(field("loading").gt(90.0)).sort(field("loading"), Order::Descending).limit(1))?;
/// assert_eq!(hot.table.get(2_u64, "name"), Some(latkit::Value::Text("c".into())));
/// assert_eq!((hot.table.len(), hot.total), (1, 2));
/// # Ok::<(), latkit::Error>(())
/// ```
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(description = "The rows of a table to read back, run through the expressions marks draw with.")]
pub struct Query {
    /// The table to read.
    of: Name,
    /// The rows to read, in this order unless sorted. Defaults to every row. Ids that name no row
    /// are skipped.
    #[serde(default)]
    ids: Option<Ids>,
    /// Keeps only the rows for which this is true.
    #[serde(default)]
    filter: Option<Expr>,
    /// Keys to sort by. Each key breaks ties left by the keys before it. Rows where a key has no
    /// value sort last, and rows equal on every key keep their order.
    #[serde(default)]
    sort: Vec<(Expr, Order)>,
    /// How many of the kept rows to skip.
    #[serde(default)]
    offset: usize,
    /// The most rows to return. When sorting with a limit, the first `offset + limit` rows are
    /// selected in linear time and only those are sorted.
    limit: Option<usize>,
    /// Fields to return, by output name. A plain field returns that field as stored, and any other
    /// expression returns numbers. Defaults to every field. An empty object returns the ids alone.
    #[serde(default)]
    select: Option<Ordered<Expr>>,
    /// The axis coordinate at which sampled fields are read. Defaults to their last frame.
    at: Option<f64>,
}

/// Sort direction. Rows where the key has no value sort last in either direction.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    /// Smallest first.
    #[default]
    Ascending,
    /// Largest first.
    Descending,
}

impl Query {
    /// A query for every row and field of table `table`.
    pub fn of(table: impl Into<Name>) -> Query {
        Query {
            of: table.into(),
            ids: None,
            filter: None,
            sort: Vec::new(),
            offset: 0,
            limit: None,
            select: None,
            at: None,
        }
    }

    /// Reads only the rows `ids` names, in that order unless sorted. Ids that name no row are
    /// skipped.
    #[must_use]
    pub fn ids(mut self, ids: impl Into<Ids>) -> Query {
        self.ids = Some(ids.into());
        self
    }

    /// Keeps only the rows for which `keep` is true.
    #[must_use]
    pub fn filter(mut self, keep: impl Into<Expr>) -> Query {
        self.filter = Some(keep.into());
        self
    }

    /// Sorts by `key`, breaking ties left by earlier keys. Rows equal on every key keep their
    /// order, and rows where `key` has no value sort last.
    #[must_use]
    pub fn sort(mut self, key: impl Into<Expr>, order: Order) -> Query {
        self.sort.push((key.into(), order));
        self
    }

    /// Skips the first `offset` kept rows, after sorting.
    #[must_use]
    pub fn offset(mut self, offset: usize) -> Query {
        self.offset = offset;
        self
    }

    /// Returns at most `limit` rows.
    #[must_use]
    pub fn limit(mut self, limit: usize) -> Query {
        self.limit = Some(limit);
        self
    }

    /// Adds output field `name`, computed by `value`. A plain field returns that field as stored,
    /// and any other expression returns numbers. Without any `select`, every field is returned.
    #[must_use]
    pub fn select(mut self, name: impl Into<Name>, value: impl Into<Expr>) -> Query {
        self.select.get_or_insert_with(Ordered::default).0.push((name.into(), value.into()));
        self
    }

    /// Returns only the rows' ids, with no fields.
    #[must_use]
    pub fn ids_alone(mut self) -> Query {
        self.select = Some(Ordered::default());
        self
    }

    /// Reads sampled fields at axis coordinate `at`.
    #[must_use]
    pub fn at(mut self, at: f64) -> Query {
        self.at = Some(at);
        self
    }
}

/// The result of [`Snapshot::query`]: the requested page of rows as a table, and how many rows
/// passed the filter.
#[derive(Clone, Debug)]
pub struct QueryResult {
    /// The page of rows, as a table with the source table's name. It holds their ids and their
    /// selected fields or computed values. Sampled fields come back as plain values read at the
    /// query's coordinate.
    pub table: Table,
    /// The number of rows that passed the filter, before `offset` and `limit`.
    pub total: usize,
}

impl Snapshot {
    /// Returns the page of rows `query` describes, as a table, and the number of rows that passed
    /// the filter. When sorting with a limit, the rows are selected in linear time and
    /// only those are sorted. Errors if the table or a selected field does not exist.
    pub fn query(&self, query: &Query) -> Result<QueryResult> {
        let table = self.table(&query.of).ok_or_else(|| Error::invalid("no such table").at(query.of.as_str()))?;
        let at = query.at.unwrap_or(f64::INFINITY);
        let all = std::slice::from_ref(self);
        let rows = Rows::new(table, all).at(at);
        let named: Vec<usize> = match &query.ids {
            Some(ids) => (0..ids.len()).filter_map(|k| table.row(ids.key(k)?)).collect(),
            None => (0..table.len()).collect(),
        };
        let mut picked: Vec<usize> = match &query.filter {
            Some(keep) => {
                let kept = rows.numbers(keep, |x| x > 0.5);
                named.into_iter().filter(|&r| kept[r]).collect()
            }
            None => named,
        };
        let total = picked.len();
        let end = query.limit.map_or(picked.len(), |limit| query.offset.saturating_add(limit).min(picked.len()));
        if !query.sort.is_empty() {
            let keys: Vec<(Vec<f64>, Order)> =
                query.sort.iter().map(|(key, order)| (rows.numbers(key, |x| x), *order)).collect();
            let compare = |a: &usize, b: &usize| {
                keys.iter()
                    .map(|(values, order)| compare(values[*a], values[*b], *order))
                    .find(|o| o.is_ne())
                    .unwrap_or(Ordering::Equal)
                    .then(a.cmp(b))
            };
            if end < picked.len() {
                picked.select_nth_unstable_by(end, compare);
                picked.truncate(end);
            }
            picked.sort_unstable_by(compare);
        }
        let page = &picked[query.offset.min(end)..end];
        let version = super::name::Version::next();
        let mut out = Table {
            name: table.name.clone(),
            ids: table.ids.gather(page),
            index: std::sync::Arc::default(),
            fields: Vec::new(),
            structure: version,
            order: version,
        };
        let Some(select) = &query.select else {
            for (name, field) in &table.fields {
                out.insert(name.clone(), plain(field, at, page));
            }
            return Ok(QueryResult { table: out, total });
        };
        for (name, value) in &select.0 {
            let field = if let Some(f) = value.field_name() {
                let Some(field) = table.field_named(f) else {
                    return Err(Error::invalid(format!("no field {f}")).at(name.as_str()).at("select"));
                };
                plain(field, at, page)
            } else {
                let numbers = rows.numbers(value, |x| x.is_finite().then_some(x));
                let values = Values::from(page.iter().map(|&r| numbers[r]).collect::<Vec<_>>());
                Field::Values(Column::new(&values), super::name::Version::next())
            };
            out.insert(name.clone(), field);
        }
        Ok(QueryResult { table: out, total })
    }
}

/// Orders two sort-key values. Non-finite (missing) values sort last in either direction.
fn compare(a: f64, b: f64, order: Order) -> Ordering {
    match (a.is_finite(), b.is_finite()) {
        (true, true) if order == Order::Descending => b.total_cmp(&a),
        (true, true) => a.total_cmp(&b),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => Ordering::Equal,
    }
}

/// `field` for rows `rows` as plain values. A sampled field becomes its values in the frame at
/// `at`, without its history.
fn plain(field: &Field, at: f64, rows: &[usize]) -> Field {
    match field {
        Field::Sampled(samples, _) => {
            let frame = samples.frame_at(at);
            let values: Vec<Option<f64>> = rows.iter().map(|&row| frame.and_then(|f| samples.value(row, f))).collect();
            Field::Values(Column::new(&Values::from(values)), super::name::Version::next())
        }
        other => other.gather(rows),
    }
}
