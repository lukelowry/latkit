use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::{self, Deserializer};

use crate::expr::form::Written;
use crate::{Expr, Format};

/// Text for each row, placed beside, inside, or along the row's shape and moving with it: a text
/// field, a number, or options. A label shows when its row is visible and its text fits, for
/// example inside a block.
///
/// Labels beside or along their rows never overlap. Where they would, the row drawn on top keeps
/// its label (so `priority` decides), and a dense view labels as many rows as fit. A row whose text
/// is missing or empty has no label, so a `when` that returns the field or missing labels only
/// some rows. In a diagram, a label scales with the zoom, fades out when too small to read, and
/// shows wherever it fits its vertex.
///
/// ```
/// # use latkit::{field, when, zoom, Expr, Label, Vertices};
/// let named = when(zoom().ge(6.0)).then(field("name")).otherwise(Expr::missing());
/// let buses = Vertices::of("grid", "Bus").position(field("lon"), field("lat"));
/// let labeled = buses.label(Label::new(named));
/// let voltages = Label::new(field("vm")).precision(3).unit(" pu");
/// ```
#[derive(Clone, PartialEq, Debug, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = text_or_options)]
pub struct Label {
    /// The text field to show, a number to write, or a `when` that returns either or missing. A
    /// row whose text is missing or empty has no label. The GPU writes a number each frame, so it
    /// can follow a sampled field. In a diagram, a text may read only data, since the sheet sizes
    /// blocks around it, and a number shows where it fits its block.
    pub(crate) text: Expr,
    /// Font size in CSS pixels, or diagram units in a diagram. Defaults to the theme's
    /// `text.size`.
    #[serde(default)]
    pub(crate) size: Option<f32>,
    /// Each row's text color. Defaults to the theme's text color.
    #[serde(default)]
    pub(crate) color: Option<Expr>,
    /// The width at which lines wrap, in CSS pixels, or diagram units in a diagram.
    #[serde(default)]
    pub(crate) max_width: Option<f32>,
    /// The CSS font family list for the text. Defaults to the theme's `text.font`.
    #[serde(default)]
    pub(crate) font: Option<Arc<str>>,
    /// How a number is written, as an axis writes its ticks. Defaults to `auto`.
    #[serde(default)]
    pub(crate) format: Format,
    /// Decimal places of a number, or of the significand in scientific and engineering formats. At
    /// most 7. Defaults to at most 2, without trailing zeros.
    #[serde(default)]
    #[schemars(range(max = 7))]
    pub(crate) precision: Option<u8>,
    /// Text written after a number, such as `" kV"` or `"%"`.
    #[serde(default)]
    pub(crate) unit: Option<Arc<str>>,
}

/// Reads a label from a text field alone, or from an options object with `text`.
impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Label, D::Error> {
        let label = |written: Written| match written {
            Written::Object(form) if form.text.is_some() => {
                let keys = ["text", "size", "color", "maxWidth", "font", "format", "precision", "unit"];
                form.only("a label", &keys)?;
                Ok(Label {
                    text: form.text.expect("present"),
                    color: form.color,
                    size: form.size,
                    max_width: form.max_width,
                    font: form.font,
                    format: form.format.unwrap_or_default(),
                    precision: form.precision,
                    unit: form.unit,
                })
            }
            written => written.expr().map(Label::new),
        };
        label(Written::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// A label's schema: a text field or its options. The description moves to the combined schema.
fn text_or_options(schema: &mut schemars::Schema) {
    let mut options = std::mem::replace(schema, schemars::json_schema!({}));
    let description = options.remove("description");
    *schema = schemars::json_schema!({ "anyOf": [{ "$ref": "#/$defs/Expr" }, options] });
    if let Some(description) = description {
        schema.insert("description".into(), description);
    }
}

impl Label {
    /// Labels each row with a text field's value or a number, or with a `when` that returns either
    /// or missing. A row whose text is missing or empty has no label.
    pub fn new(text: impl Into<Expr>) -> Label {
        Label {
            text: text.into(),
            size: None,
            color: None,
            max_width: None,
            font: None,
            format: Format::Auto,
            precision: None,
            unit: None,
        }
    }

    /// Sets the font size in CSS pixels, or diagram units in a diagram. Defaults to the theme's
    /// text size.
    #[must_use]
    pub fn size(mut self, size: f32) -> Label {
        self.size = Some(size);
        self
    }

    /// Sets each row's text color. Defaults to the theme's text color.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Sets the width at which lines wrap, in CSS pixels, or diagram units in a diagram.
    #[must_use]
    pub fn max_width(mut self, width: f32) -> Label {
        self.max_width = Some(width);
        self
    }

    /// Sets the CSS font family list for the text. Defaults to the theme's font.
    #[must_use]
    pub fn font(mut self, font: impl Into<Arc<str>>) -> Label {
        self.font = Some(font.into());
        self
    }

    /// Sets how a number is written. Defaults to [`Format::Auto`].
    #[must_use]
    pub fn format(mut self, format: Format) -> Label {
        self.format = format;
        self
    }

    /// Sets a number's decimal places, at most 7. Defaults to at most 2, without trailing zeros.
    #[must_use]
    pub fn precision(mut self, places: u8) -> Label {
        self.precision = Some(places);
        self
    }

    /// Sets text written after a number, such as `" kV"` or `"%"`.
    #[must_use]
    pub fn unit(mut self, unit: impl Into<Arc<str>>) -> Label {
        self.unit = Some(unit.into());
        self
    }
}
