//! Lengths that are one number for a whole mark or theme: CSS pixels, or position units.

use schemars::JsonSchema;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};

/// A length: a plain number in CSS pixels, the same at any zoom, or `{ "units": n }` in position
/// units (degrees on the earth), which scale with the zoom.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Length {
    /// CSS pixels.
    Px(f32),
    /// Position units (degrees on the earth).
    Units(f32),
}

impl Length {
    /// The number, in the length's own unit.
    pub(crate) fn value(self) -> f32 {
        match self {
            Length::Px(v) | Length::Units(v) => v,
        }
    }

    /// Whether `other` is in the same unit.
    pub(crate) fn alike(self, other: Length) -> bool {
        std::mem::discriminant(&self) == std::mem::discriminant(&other)
    }
}

/// A length's JSON form: a number, or `{ "units": n }` with no other keys.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum LengthForm {
    Px(f32),
    Units(UnitsLength),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitsLength {
    units: f32,
}

impl Serialize for Length {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match *self {
            Length::Px(px) => LengthForm::Px(px),
            Length::Units(units) => LengthForm::Units(UnitsLength { units }),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Length {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Length, D::Error> {
        LengthForm::deserialize(deserializer)
            .map(|form| match form {
                LengthForm::Px(px) => Length::Px(px),
                LengthForm::Units(UnitsLength { units }) => Length::Units(units),
            })
            .map_err(|_| de::Error::custom("a length must be a number or { units: n }"))
    }
}

impl JsonSchema for Length {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Length".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "A length: a number in CSS pixels, or `{ units }` in position units (degrees on the earth), which grow as the view zooms in.",
            "anyOf": [
                { "type": "number" },
                {
                    "type": "object",
                    "properties": { "units": { "type": "number", "description": "Position units (degrees on the earth), which grow as the view zooms in." } },
                    "required": ["units"],
                    "additionalProperties": false,
                },
            ],
        })
    }
}

impl From<f32> for Length {
    fn from(px: f32) -> Length {
        Length::Px(px)
    }
}
