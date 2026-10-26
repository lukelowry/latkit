use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::{self, Deserializer};

use crate::expr::form::Written;
use crate::{Expr, Paint};

/// Text for each row, placed beside, inside, or along the row's shape and following it every frame:
/// a text field, or options. Where labels would overlap, the higher priority shows; among equals,
/// labels already shown stay. In a diagram a label is part of the drawing: it scales with the zoom,
/// fades out when too small to read, and shows wherever it fits its vertex.
///
/// ```
/// # use latkit::{field, Label, Vertices};
/// let buses = Vertices::of("grid", "Bus").position("lon", "lat").label(Label::new("name").priority(field("kv")));
/// ```
#[derive(Clone, PartialEq, Debug, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = text_or_options)]
pub struct Label {
    /// The text field to show.
    pub(crate) text: Expr,
    /// Font size in the space's unit (units in a diagram, CSS pixels elsewhere); the theme's
    /// `text.size` unless set.
    #[serde(default)]
    pub(crate) size: Option<f32>,
    /// Each row's text color; the theme's text color unless set.
    #[serde(default)]
    pub(crate) color: Option<Paint>,
    /// Where labels would overlap, the higher priority shows; the mark's `priority` unless set.
    #[serde(default)]
    pub(crate) priority: Option<Expr>,
    /// The width at which lines wrap, in the space's unit (units in a diagram, CSS pixels
    /// elsewhere).
    #[serde(default)]
    pub(crate) max_width: Option<f32>,
    /// The CSS font family list for the text; the theme's `text.font` unless set.
    #[serde(default)]
    pub(crate) font: Option<Arc<str>>,
    /// The most labels shown at once: those of highest priority among the rows in view, or fewer
    /// where they would overlap. No limit unless set.
    #[serde(default)]
    pub(crate) max: Option<u32>,
}

/// Reads a label from a text field alone, or from an options object with `text`.
impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Label, D::Error> {
        let label = |written: Written| match written {
            Written::Object(mut form) if form.text.is_some() => {
                form.only("a label", &["text", "size", "color", "priority", "maxWidth", "font", "max"])?;
                Ok(Label {
                    color: form.color()?.map(Paint),
                    text: form.text.expect("present"),
                    size: form.size,
                    priority: form.priority,
                    max_width: form.max_width,
                    font: form.font,
                    max: form.max,
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
    /// Labels each row with a text field's value.
    pub fn new(text: impl Into<Expr>) -> Label {
        Label { text: text.into(), size: None, color: None, priority: None, max_width: None, font: None, max: None }
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
    pub fn color(mut self, color: impl Into<Paint>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Sets each row's label priority: where labels would overlap, the higher priority shows. The
    /// mark's priority unless set.
    #[must_use]
    pub fn priority(mut self, priority: impl Into<Expr>) -> Label {
        self.priority = Some(priority.into());
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

    /// Shows at most `max` labels at once: those of highest priority among the rows in view, or
    /// fewer where they would overlap.
    #[must_use]
    pub fn max(mut self, max: u32) -> Label {
        self.max = Some(max);
        self
    }
}
