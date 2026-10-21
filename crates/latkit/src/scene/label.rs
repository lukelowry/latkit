use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::{self, Deserializer};
use serde_json::Value;

use crate::Expr;

/// A row's text, placed beside, inside, or along what its mark draws, following it every frame: a
/// text field, or options. Labels that would overlap give way by priority; among equals, those
/// already shown keep their place. In a diagram a label is part of the drawing: it scales with the
/// zoom, fades out once too small to read, and shows wherever it fits its vertex.
///
/// ```
/// # use latkit::{field, Label, Vertices};
/// let buses = Vertices::of("grid", "Bus").position("lon", "lat").label(Label::new("name").priority(field("kv")));
/// ```
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = text_or_options)]
pub struct Label {
    /// A text field.
    pub(crate) text: Expr,
    /// CSS pixels, or units in a diagram; the theme's font size unless set.
    #[serde(default)]
    pub(crate) size: Option<f32>,
    /// Each row's text color; the theme's text color unless set.
    #[serde(default)]
    pub(crate) color: Option<Expr>,
    /// Where labels would overlap, the higher shows; the mark's priority unless set.
    #[serde(default)]
    pub(crate) priority: Option<Expr>,
    /// How far a line runs before it wraps: CSS pixels, or units in a diagram.
    #[serde(default)]
    pub(crate) max_width: Option<f32>,
    /// The CSS font family list its texts are set in; the theme's font unless set.
    #[serde(default)]
    pub(crate) font: Option<Arc<str>>,
    /// The most labels shown at once, those of highest priority among the rows in view; where they
    /// would overlap, fewer.
    #[serde(default)]
    pub(crate) max: Option<u32>,
}

/// A label reads a text field as its text alone, or an object with `text` as its options.
impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Label, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if value.as_object().is_some_and(|map| map.contains_key("text")) {
            return Label::deserialize(value).map_err(de::Error::custom);
        }
        Expr::from_value(value).map(Label::new).map_err(de::Error::custom)
    }
}

/// A label's schema: a text field, or its options.
fn text_or_options(schema: &mut schemars::Schema) {
    let options = std::mem::replace(schema, schemars::json_schema!({}));
    *schema = schemars::json_schema!({ "anyOf": [{ "$ref": "#/$defs/Expr" }, options] });
}

impl Label {
    /// Labels each row with a text field's value.
    pub fn new(text: impl Into<Expr>) -> Label {
        Label { text: text.into(), size: None, color: None, priority: None, max_width: None, font: None, max: None }
    }

    /// Text size, CSS pixels, or units in a diagram; the theme's font size unless set.
    #[must_use]
    pub fn size(mut self, size: f32) -> Label {
        self.size = Some(size);
        self
    }

    /// Each row's text color; the theme's text color unless set.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Each row's priority: where labels would overlap, the higher shows. The mark's priority
    /// unless set.
    #[must_use]
    pub fn priority(mut self, priority: impl Into<Expr>) -> Label {
        self.priority = Some(priority.into());
        self
    }

    /// How far a line of text runs before it wraps: CSS pixels, or units in a diagram.
    #[must_use]
    pub fn max_width(mut self, width: f32) -> Label {
        self.max_width = Some(width);
        self
    }

    /// The CSS font family list its texts are set in; the theme's font unless set.
    #[must_use]
    pub fn font(mut self, font: impl Into<Arc<str>>) -> Label {
        self.font = Some(font.into());
        self
    }

    /// Shows at most `max` labels at once, those of highest priority among the rows in view; where
    /// they would overlap, fewer.
    #[must_use]
    pub fn max(mut self, max: u32) -> Label {
        self.max = Some(max);
        self
    }
}
