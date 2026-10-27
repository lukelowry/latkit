use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::{self, Deserializer};

use crate::Expr;
use crate::expr::form::Written;

/// Text for each row, placed beside, inside, or along the row's shape and following it every frame:
/// a text field, or options. A label shows wherever its row shows and its text fits the room the
/// row gives it, such as inside a block. Labels beside or along their rows never overlap: where they
/// would, the label of the row drawn on top shows, so a mark's `priority` decides, and a dense view
/// labels as many rows as fit. A row whose text is missing or empty has no label, so a `when` choosing
/// between the text field and missing labels only the rows it names. In a diagram a label is part
/// of the drawing: it scales with the zoom, fades out when too small to read, and shows wherever it
/// fits its vertex.
///
/// ```
/// # use latkit::{field, when, zoom, Expr, Label, Vertices};
/// let named = when(zoom().ge(6.0)).then(field("name")).otherwise(Expr::missing());
/// let buses = Vertices::of("grid", "Bus").position(field("lon"), field("lat"));
/// let labeled = buses.label(Label::new(named));
/// ```
#[derive(Clone, PartialEq, Debug, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = text_or_options)]
pub struct Label {
    /// The text field to show, or a `when` whose values are each that field or missing. A row
    /// whose text is missing or empty has no label. In a diagram the text reads only data, since the sheet
    /// sizes blocks around it.
    pub(crate) text: Expr,
    /// Font size in the space's unit (units in a diagram, CSS pixels elsewhere); the theme's
    /// `text.size` unless set.
    #[serde(default)]
    pub(crate) size: Option<f32>,
    /// Each row's text color; the theme's text color unless set.
    #[serde(default)]
    pub(crate) color: Option<Expr>,
    /// The width at which lines wrap, in the space's unit (units in a diagram, CSS pixels
    /// elsewhere).
    #[serde(default)]
    pub(crate) max_width: Option<f32>,
    /// The CSS font family list for the text; the theme's `text.font` unless set.
    #[serde(default)]
    pub(crate) font: Option<Arc<str>>,
}

/// Reads a label from a text field alone, or from an options object with `text`.
impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Label, D::Error> {
        let label = |written: Written| match written {
            Written::Object(form) if form.text.is_some() => {
                form.only("a label", &["text", "size", "color", "maxWidth", "font"])?;
                Ok(Label {
                    text: form.text.expect("present"),
                    color: form.color,
                    size: form.size,
                    max_width: form.max_width,
                    font: form.font,
                })
            }
            written => written.expr().map(Label::new),
        };
        label(Written::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// A label's schema: a text field, or its options, with the description moved to the whole.
fn text_or_options(schema: &mut schemars::Schema) {
    let mut options = std::mem::replace(schema, schemars::json_schema!({}));
    let description = options.remove("description");
    *schema = schemars::json_schema!({ "anyOf": [{ "$ref": "#/$defs/Expr" }, options] });
    if let Some(description) = description {
        schema.insert("description".into(), description);
    }
}

impl Label {
    /// Labels each row with a text field's value, or with a `when` choosing between that field and
    /// missing; a row whose text is missing or empty has no label.
    pub fn new(text: impl Into<Expr>) -> Label {
        Label { text: text.into(), size: None, color: None, max_width: None, font: None }
    }

    /// Sets the font size in the space's unit (units in a diagram, CSS pixels elsewhere); the
    /// theme's text size unless set.
    #[must_use]
    pub fn size(mut self, size: f32) -> Label {
        self.size = Some(size);
        self
    }

    /// Sets each row's text color; the theme's text color unless set.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Sets the width at which lines wrap, in the space's unit (units in a diagram, CSS pixels
    /// elsewhere).
    #[must_use]
    pub fn max_width(mut self, width: f32) -> Label {
        self.max_width = Some(width);
        self
    }

    /// Sets the CSS font family list for the text; the theme's font unless set.
    #[must_use]
    pub fn font(mut self, font: impl Into<Arc<str>>) -> Label {
        self.font = Some(font.into());
        self
    }
}
