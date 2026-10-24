//! Reading data back without moving it: what a dataset holds, and a sampled field's extremes over
//! spans of its axis.

use super::column::{PAGE_BITS, PAGE_MASK};
use super::ids::Ids;
use super::name::Name;
use super::snapshot::Snapshot;
use super::table::{Field, Table};
use super::values::Kind;
use crate::{Error, Result};

/// The most values an envelope holds, least and greatest each: rows times spans.
const ENVELOPE_VALUES: usize = 1 << 26;

/// What a dataset holds: its tables, their rows and fields, and the axis its sampled fields are
/// recorded over and span.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct Description {
    /// The dataset's name.
    pub name: Name,
    /// The axis's name and unit.
    pub axis: Option<[Name; 2]>,
    /// The first and last coordinates its sampled fields hold.
    pub span: Option<[f64; 2]>,
    /// Its tables, by name.
    pub tables: Vec<TableDescription>,
}

/// A table described: its rows, and its fields by name.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct TableDescription {
    /// The table's name.
    pub name: Name,
    /// How many rows it has.
    pub rows: usize,
    /// Its fields, by name.
    pub fields: Vec<FieldDescription>,
}

/// A field described: what it holds, the table a reference names, the coordinates samples span.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct FieldDescription {
    /// The field's name.
    pub name: Name,
    /// What it holds.
    pub kind: Kind,
    /// The table a reference names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<Name>,
    /// The first and last coordinates a sampled field holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<[f64; 2]>,
}

/// Rows' least and greatest values of a sampled field over equal spans of the axis, to read back:
/// field `field` of table `table` over `spans` equal spans from `range[0]` to `range[1]`, of every
/// row or of the rows `ids` names, in its order. Plain data, like a query.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EnvelopeRequest {
    /// The table read.
    pub table: Name,
    /// The sampled field read.
    pub field: Name,
    /// The axis coordinates the spans cover, from the first to the last.
    pub range: [f64; 2],
    /// How many equal spans the range is cut into.
    pub spans: usize,
    /// The rows read, in this order; every row unless set.
    #[serde(default)]
    pub ids: Option<Ids>,
}

impl Snapshot {
    /// What the dataset holds: tables, rows, fields and their kinds, the axis and its span.
    pub fn describe(&self) -> Description {
        Description {
            name: self.name().clone(),
            axis: self.axis().map(|(name, unit)| [name.into(), unit.into()]),
            span: self.span(),
            tables: self.tables().map(Table::describe).collect(),
        }
    }

    /// Each row's least and greatest value of a sampled field over equal spans of the axis, as
    /// `request` asks: row after row, NaN where a span holds no frame. A span reads the coarsest
    /// levels of detail the field holds that fit inside it, so it costs a few reads, however many
    /// frames it covers; where the field holds only coarser ones, as time tiles still loading leave
    /// it, those stand in.
    ///
    /// ```
    /// # use latkit::{Data, EnvelopeRequest, Ids, Patch, Table};
    /// let grid = Data::new("grid");
    /// grid.apply(Table::new("Bus", Ids::count(1)))?;
    /// grid.apply(Patch::new().append("Bus", [0.0, 1.0, 2.0, 3.0], [("vm", vec![1.0, 0.9, 1.1, 1.0])]))?;
    /// let request = EnvelopeRequest { table: "Bus".into(), field: "vm".into(), range: [0.0, 4.0], spans: 2, ids: None };
    /// let envelope = grid.snapshot().envelope(&request)?;
    /// assert_eq!(envelope.least, [0.9, 1.0]);
    /// # Ok::<(), latkit::Error>(())
    /// ```
    pub fn envelope(&self, request: &EnvelopeRequest) -> Result<Envelope> {
        let EnvelopeRequest { table, field, range, spans, ids } = request;
        let rows = self.table(table).ok_or_else(|| Error::invalid("no such table").at(table.as_str()))?;
        rows.envelope(field, *range, *spans, ids.as_ref()).map_err(|e| e.at(table.as_str()))
    }
}

impl Table {
    /// What the table holds: its rows, and its fields' kinds, targets, and spans.
    pub fn describe(&self) -> TableDescription {
        let fields = self.fields.iter().map(|(name, field)| FieldDescription {
            name: name.clone(),
            kind: field.kind(),
            to: match field {
                Field::Reference(reference) => Some(reference.to.clone()),
                _ => None,
            },
            span: match field {
                Field::Sampled(samples, _) => samples.span(),
                _ => None,
            },
        });
        TableDescription { name: self.name.clone(), rows: self.len(), fields: fields.collect() }
    }

    /// Each row's least and greatest value of sampled field `field` over `spans` equal spans of the
    /// axis from `range[0]` to `range[1]`: see [`Snapshot::envelope`].
    pub(crate) fn envelope(&self, field: &str, range: [f64; 2], spans: usize, ids: Option<&Ids>) -> Result<Envelope> {
        let Some(Field::Sampled(samples, _)) = self.field_named(field) else {
            return Err(Error::invalid("not a sampled field").at(field));
        };
        if !(range[0].is_finite() && range[1].is_finite() && range[0] <= range[1]) || spans == 0 {
            return Err(Error::invalid("an envelope spans a finite range, in one span or more"));
        }
        let rows: Vec<usize> = match ids {
            None => (0..self.len()).collect(),
            Some(ids) => (0..ids.len())
                .map(|i| ids.key(i).and_then(|key| self.row(key)).ok_or_else(|| Error::invalid("no such row").at(i)))
                .collect::<Result<_>>()?,
        };
        if rows.len().saturating_mul(spans) > ENVELOPE_VALUES {
            return Err(Error::Limit(
                format!("an envelope holds at most {ENVELOPE_VALUES} values: rows times spans").into(),
            ));
        }
        let width = (range[1] - range[0]) / spans as f64;
        let at: Vec<f64> =
            (0..=spans).map(|s| if s == spans { range[1] } else { range[0] + width * s as f64 }).collect();
        // A span holds the frames from its start up to the next span's; the last holds its end too.
        let bounds: Vec<u64> = at.iter().enumerate().map(|(s, &t)| samples.bound(t, s == spans)).collect();
        let pieces: Vec<Vec<(u32, u64)>> = bounds.windows(2).map(|b| samples.pieces(b[0]..b[1])).collect();
        let mut least = vec![f32::NAN; rows.len() * spans];
        let mut greatest = least.clone();
        // Rows by block, so each piece's page is read once for all of a block's rows.
        let mut by_block: Vec<(usize, usize)> =
            rows.iter().enumerate().map(|(i, &row)| (row >> PAGE_BITS, i)).collect();
        by_block.sort_unstable();
        for run in by_block.chunk_by(|a, b| a.0 == b.0) {
            let block = run[0].0;
            let mut extent =
                vec![[f32::NAN; 2]; run.iter().map(|&(_, i)| (rows[i] & PAGE_MASK) + 1).max().unwrap_or(0)];
            for (s, pieces) in pieces.iter().enumerate() {
                extent.fill([f32::NAN; 2]);
                for &piece in pieces {
                    samples.fold(block, piece, &mut extent);
                }
                for &(_, i) in run {
                    let [lo, hi] = extent[rows[i] & PAGE_MASK];
                    (least[i * spans + s], greatest[i * spans + s]) = (lo, hi);
                }
            }
        }
        Ok(Envelope { at, least, greatest })
    }
}

/// Rows' least and greatest values of a sampled field over spans of its axis.
#[derive(Clone, PartialEq, Debug, serde::Serialize)]
pub struct Envelope {
    /// Where each span starts, then where the last ends: one more coordinate than spans.
    pub at: Vec<f64>,
    /// Each row's least value in each span, row after row: NaN where it has none.
    pub least: Vec<f32>,
    /// Each row's greatest value in each span, row after row: NaN where it has none.
    pub greatest: Vec<f32>,
}
