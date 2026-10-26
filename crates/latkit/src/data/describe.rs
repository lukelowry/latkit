//! Summaries of a dataset: a [`Description`] of its tables and fields, and an [`Envelope`] of each
//! row's least and greatest value of a sampled field over spans of the axis.

use super::column::{PAGE_BITS, PAGE_MASK};
use super::ids::Ids;
use super::name::Name;
use super::snapshot::Snapshot;
use super::table::{Field, Table};
use super::values::Kind;
use crate::{Error, Result};

/// The largest envelope allowed, as rows times spans. `least` and `greatest` each hold this many
/// values at most.
const ENVELOPE_VALUES: usize = 1 << 26;

/// A summary of a dataset: its tables with their rows and fields, the axis sampled fields are
/// recorded over, and the part of the axis they cover.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct Description {
    /// The dataset's name.
    pub name: Name,
    /// The axis name and unit, if set.
    pub axis: Option<[Name; 2]>,
    /// The first and last axis coordinates held by any sampled field; `None` when none holds any.
    pub span: Option<[f64; 2]>,
    /// Its tables, sorted by name.
    pub tables: Vec<TableDescription>,
}

/// A summary of one table: its row count and its fields, sorted by name.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct TableDescription {
    /// The table's name.
    pub name: Name,
    /// The number of rows.
    pub rows: usize,
    /// Its fields, sorted by name.
    pub fields: Vec<FieldDescription>,
}

/// A summary of one field: its kind, plus its target table or axis span where those apply.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct FieldDescription {
    /// The field's name.
    pub name: Name,
    /// The kind of values it holds.
    pub kind: Kind,
    /// For a reference, the target table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<Name>,
    /// For a sampled field, the first and last axis coordinates it holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<[f64; 2]>,
}

/// A request for each row's least and greatest value of a sampled field over equal spans of the
/// axis: field `field` of table `table`, over `spans` equal spans from `range[0]` to `range[1]`,
/// for every row or for the rows `ids` names, in that order. Plain data that deserializes from
/// JSON, like a query.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EnvelopeRequest {
    /// The table to read.
    pub table: Name,
    /// The sampled field to read.
    pub field: Name,
    /// The axis range the spans cover, `[first, last]`: finite, with `first <= last`.
    pub range: [f64; 2],
    /// The number of equal spans to divide the range into; at least 1.
    pub spans: usize,
    /// The rows to read, in this order; every row when unset.
    #[serde(default)]
    pub ids: Option<Ids>,
}

impl Snapshot {
    /// A summary of the dataset: its tables, rows, fields and their kinds, and the axis and its
    /// span.
    pub fn describe(&self) -> Description {
        Description {
            name: self.name().clone(),
            axis: self.axis().map(|(name, unit)| [name.into(), unit.into()]),
            span: self.span(),
            tables: self.tables().map(Table::describe).collect(),
        }
    }

    /// Each row's least and greatest value of a sampled field over equal spans of the axis, as
    /// `request` describes. Values are laid out row by row, with NaN where a span holds no frame.
    ///
    /// Each span reads the coarsest stored levels of detail that fit inside it, so it costs a few
    /// reads regardless of how many frames it covers. Where only coarser levels are present, as
    /// while time tiles are loading, those are used instead and may include frames just outside
    /// the span.
    ///
    /// Errors if the table, the field, or a requested row does not exist, the field is not
    /// sampled, the range is not finite and ordered, `spans` is 0, or rows times spans exceeds
    /// 2^26.
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
    /// A summary of the table: its row count and each field's kind, reference target, and span.
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
    /// axis from `range[0]` to `range[1]`. See [`Snapshot::envelope`].
    pub(crate) fn envelope(&self, field: &str, range: [f64; 2], spans: usize, ids: Option<&Ids>) -> Result<Envelope> {
        let Some(Field::Sampled(samples, _)) = self.field_named(field) else {
            return Err(Error::invalid("not a sampled field").at(field));
        };
        if !(range[0].is_finite() && range[1].is_finite() && range[0] <= range[1]) || spans == 0 {
            return Err(Error::invalid("an envelope needs a finite, ordered range and at least one span"));
        }
        let rows: Vec<usize> = match ids {
            None => (0..self.len()).collect(),
            Some(ids) => (0..ids.len())
                .map(|i| ids.key(i).and_then(|key| self.row(key)).ok_or_else(|| Error::invalid("no such row").at(i)))
                .collect::<Result<_>>()?,
        };
        if rows.len().saturating_mul(spans) > ENVELOPE_VALUES {
            return Err(Error::Limit(
                format!("an envelope holds at most {ENVELOPE_VALUES} values (rows times spans)").into(),
            ));
        }
        let width = (range[1] - range[0]) / spans as f64;
        let at: Vec<f64> =
            (0..=spans).map(|s| if s == spans { range[1] } else { range[0] + width * s as f64 }).collect();
        // Each span covers frames from its start up to the next span's start; the last span also
        // includes its end.
        let bounds: Vec<u64> = at.iter().enumerate().map(|(s, &t)| samples.bound(t, s == spans)).collect();
        let pieces: Vec<Vec<(u32, u64)>> = bounds.windows(2).map(|b| samples.pieces(b[0]..b[1])).collect();
        let mut least = vec![f32::NAN; rows.len() * spans];
        let mut greatest = least.clone();
        // Group rows by row block, so each piece's page is read once for all of a block's rows.
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

/// Each row's least and greatest value of a sampled field over spans of the axis, as
/// [`Snapshot::envelope`] returns them.
#[derive(Clone, PartialEq, Debug, serde::Serialize)]
pub struct Envelope {
    /// Each span's start coordinate, then the last span's end: one more value than spans.
    pub at: Vec<f64>,
    /// The least value of each requested row in each span, row-major (`row * spans + span`); NaN
    /// where the span has no value.
    pub least: Vec<f32>,
    /// The greatest value of each requested row in each span, row-major (`row * spans + span`);
    /// NaN where the span has no value.
    pub greatest: Vec<f32>,
}
