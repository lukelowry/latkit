use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::{self, Deserializer};

use crate::expr::form::Written;
use crate::{Expr, Format, Length, Name, Place};

/// Text for each row, placed beside, inside, or along the row's shape and moving with it: a text
/// field, a number, or options. A label shows when its row is visible. A block, or a marker with a
/// width and height, holds its label inside where the text fits, and otherwise the label shows
/// beside it, on the right unless `place` names another side. Text inside a shape or block keeps
/// a 4.5:1 contrast with the row's color, lighter or darker as it needs, and its halo is that
/// color.
///
/// Labels never overlap. Where they would, the row drawn on top keeps its label (so `priority`
/// decides), and a dense view labels as many rows as fit. A label inside a marker takes the
/// marker's room, so where such markers overlap, only the top one's label shows. No label shows under
/// a title or legend in a corner. A row whose text is missing or empty has no label, so a `when`
/// that returns the field or missing labels only some rows.
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
    /// can follow a sampled field.
    pub(crate) text: Expr,
    /// Font size: a number in CSS pixels, or `{ units }` in position units, so the text grows with
    /// the drawing as the view zooms in. Defaults to the theme's `text.size`.
    #[serde(default)]
    pub(crate) size: Option<Length>,
    /// The side or corner of its row the text sits outside of, or a text field that names one for
    /// each row, as `"$side"`. A side centers the text on it, and a corner sets the text
    /// diagonally out from it. A row whose field names no place takes the default: inside a marker
    /// that holds it, else right of a marker, and on the middle of a stroke or area.
    #[serde(default)]
    pub(crate) place: Option<Placed>,
    /// How far the text moves from its place on screen, right then down: each a number in CSS
    /// pixels, or `{ units }` in position units. Defaults to none.
    #[serde(default)]
    pub(crate) offset: Option<[Length; 2]>,
    /// Each row's text color. Defaults to the theme's text color. Inside a shape or block, it keeps a
    /// 4.5:1 contrast with the row's color.
    #[serde(default)]
    pub(crate) color: Option<Expr>,
    /// The width at which lines wrap, in the unit of `size`.
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

/// Where a label sits: at one place for every row, or at the place a text field names for each.
#[derive(Clone, PartialEq, Debug)]
pub(crate) enum Placed {
    At(Place),
    Field(Name),
}

impl Placed {
    /// The place JSON writes as `text`: a place's name, or a text field as `"$name"`.
    fn read(text: &str) -> Result<Placed, String> {
        if let Some(field) = text.strip_prefix('$').filter(|name| !name.is_empty()) {
            return Ok(Placed::Field(field.into()));
        }
        let named = Place::ALL.into_iter().find(|place| place.name() == text);
        named.map(Placed::At).ok_or_else(|| format!("{text:?} is not a place; \"${text}\" reads field {text}"))
    }
}

impl JsonSchema for Placed {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Placed".into()
    }

    fn inline_schema() -> bool {
        true
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let place = generator.subschema_for::<Place>();
        schemars::json_schema!({
            "anyOf": [place, { "type": "string", "pattern": "^\\$." }],
            "tsType": "Place | `$${string}`",
        })
    }
}

/// Reads a label from a text field alone, or from an options object with `text`.
impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Label, D::Error> {
        let label = |written: Written| match written {
            Written::Object(form) if form.text.is_some() => {
                let keys =
                    ["text", "size", "place", "offset", "color", "maxWidth", "font", "format", "precision", "unit"];
                form.only("a label", &keys)?;
                Ok(Label {
                    text: form.text.expect("present"),
                    color: form.color,
                    size: form.size,
                    place: form.place.as_deref().map(Placed::read).transpose()?,
                    offset: form.offset,
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
            place: None,
            offset: None,
            color: None,
            max_width: None,
            font: None,
            format: Format::Auto,
            precision: None,
            unit: None,
        }
    }

    /// Sets the font size: a number of CSS pixels, or [`Length::Units`] to grow with the drawing.
    /// Defaults to the theme's text size.
    #[must_use]
    pub fn size(mut self, size: impl Into<Length>) -> Label {
        self.size = Some(size.into());
        self
    }

    /// Sets the side or corner of its row every label sits outside of. Defaults to inside a marker
    /// that holds it, else right of a marker, and on the middle of a stroke or area.
    #[must_use]
    pub fn place(mut self, place: Place) -> Label {
        self.place = Some(Placed::At(place));
        self
    }

    /// Sets the text field that names each row's place, such as `"top"` or `"bottom-left"`. A
    /// row whose field names no place takes the default.
    #[must_use]
    pub fn place_by(mut self, field: impl Into<Name>) -> Label {
        self.place = Some(Placed::Field(field.into()));
        self
    }

    /// Sets how far the text moves from its place on screen: right, then down.
    #[must_use]
    pub fn offset(mut self, right: impl Into<Length>, down: impl Into<Length>) -> Label {
        self.offset = Some([right.into(), down.into()]);
        self
    }

    /// Sets each row's text color. Defaults to the theme's text color.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Sets the width at which lines wrap, in the unit of the size.
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
