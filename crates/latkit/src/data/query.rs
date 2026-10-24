//! Reading data back: the rows of a table a query keeps, in the order it sorts them, a page of them,
//! with their fields or what expressions make of them. Queries run on the CPU through the same
//! expressions marks draw with, a plain field read page by page, and read back a table, so what
//! comes back has the shape of what goes in.

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

/// The rows of a table to read back: of the rows `ids` names (every row unless set), those `filter`
/// keeps, sorted by `sort`, a page of them from `offset` of at most `limit`, with the fields `select`
/// names or computes, every field unless it is set; sampled fields read at axis coordinate `at`, their
/// last frame by default. Plain data, like a scene.
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
    /// The table read.
    of: Name,
    /// The rows read, in this order unless sorted; every row unless set. Ids that name no row are
    /// passed over.
    #[serde(default)]
    ids: Option<Ids>,
    /// Keeps the rows it is true for.
    #[serde(default)]
    filter: Option<Expr>,
    /// Keys to sort by, each after those before it; rows a key reads nothing for come last, and rows
    /// all keys order alike keep their order.
    #[serde(default)]
    sort: Vec<(Expr, Order)>,
    /// The kept rows skipped first.
    #[serde(default)]
    offset: usize,
    /// The most rows read; a limit picks them in linear time before sorting only those.
    limit: Option<usize>,
    /// Fields to read by name: a field as it is, anything else as numbers. Every field unless set;
    /// none set reads the ids alone.
    #[serde(default)]
    select: Option<Ordered<Expr>>,
    /// The axis coordinate sampled fields are read at; their last frame unless set.
    at: Option<f64>,
}

/// Which way a sort runs; rows a key reads nothing for come last either way.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    /// Least first.
    #[default]
    Ascending,
    /// Greatest first.
    Descending,
}

impl Query {
    /// Every row of table `table`, every field.
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

    /// Reads only the rows `ids` names, in that order unless sorted.
    #[must_use]
    pub fn ids(mut self, ids: impl Into<Ids>) -> Query {
        self.ids = Some(ids.into());
        self
    }

    /// Keeps the rows `keep` is true for.
    #[must_use]
    pub fn filter(mut self, keep: impl Into<Expr>) -> Query {
        self.filter = Some(keep.into());
        self
    }

    /// Sorts by `key`, after the keys given before; rows it orders alike keep their order.
    #[must_use]
    pub fn sort(mut self, key: impl Into<Expr>, order: Order) -> Query {
        self.sort.push((key.into(), order));
        self
    }

    /// Skips the first `offset` rows kept.
    #[must_use]
    pub fn offset(mut self, offset: usize) -> Query {
        self.offset = offset;
        self
    }

    /// Reads at most `limit` rows.
    #[must_use]
    pub fn limit(mut self, limit: usize) -> Query {
        self.limit = Some(limit);
        self
    }

    /// Reads field `name` as `value` makes it: a field as it is, anything else as numbers. With none
    /// selected, every field is read.
    #[must_use]
    pub fn select(mut self, name: impl Into<Name>, value: impl Into<Expr>) -> Query {
        self.select.get_or_insert_with(Ordered::default).0.push((name.into(), value.into()));
        self
    }

    /// Reads the rows' ids alone, no field.
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

/// What a query read: the rows it kept, a page of them in order, as a table of their own, and how
/// many rows it kept before the page.
#[derive(Clone, Debug)]
pub struct QueryResult {
    /// The rows read, named as the table they were read from: their ids, and their fields or what
    /// the query computes, sampled fields read at its coordinate.
    pub table: Table,
    /// The rows the query kept before paging.
    pub total: usize,
}

impl Snapshot {
    /// The rows of a table `query` asks for, as a table of their own, and how many rows its filter
    /// kept, before the page. A limit picks its rows in linear time before sorting only them.
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

/// How two sort keys order rows: missing last, whichever way the sort runs.
fn compare(a: f64, b: f64, order: Order) -> Ordering {
    match (a.is_finite(), b.is_finite()) {
        (true, true) if order == Order::Descending => b.total_cmp(&a),
        (true, true) => a.total_cmp(&b),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => Ordering::Equal,
    }
}

/// `field` of rows `rows` as plain values: a sampled field read at `at`, one frame, not its history.
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
