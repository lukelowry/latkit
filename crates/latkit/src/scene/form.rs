//! What scenes read as JSON. Each type deserializes as itself and its schema is derived from it; a
//! type a name can stand for also reads one of its presets' names, such as `"inspect"`, `"globe"`, or
//! `"stress"`.

use std::time::Duration;

use schemars::{Schema, json_schema};
use serde::Deserialize;
use serde::de::{self, Deserializer};
use serde_json::Value;

/// A type a name can stand for.
pub(crate) trait Presets: Sized {
    /// The names, as the schema lists them.
    const NAMES: &'static [&'static str];

    /// The value `name` stands for.
    fn preset(name: &str) -> Option<Self>;
}

/// `T` read from one of its presets' names, or by `object` from anything else.
pub(crate) fn preset_or<'de, D: Deserializer<'de>, T: Presets>(
    deserializer: D,
    object: fn(Value) -> Result<T, serde_json::Error>,
) -> Result<T, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::String(name) => T::preset(&name).ok_or_else(|| {
            de::Error::custom(format!("unknown name {name:?}, expected one of {}", T::NAMES.join(", ")))
        }),
        value => object(value).map_err(de::Error::custom),
    }
}

/// `T`'s schema as one of its presets' names or what it derived, its description kept on the whole.
pub(crate) fn presets<T: Presets>(schema: &mut Schema) {
    let mut derived = std::mem::replace(schema, json_schema!({}));
    let description = derived.remove("description");
    // A variant without options that a preset names already is the preset.
    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = derived.get_mut(key).and_then(Value::as_array_mut) {
            variants.retain(|v| !v.get("const").and_then(Value::as_str).is_some_and(|name| T::NAMES.contains(&name)));
        }
    }
    *schema = json_schema!({ "anyOf": [{ "type": "string", "enum": T::NAMES }, derived] });
    if let Some(description) = description {
        schema.insert("description".into(), description);
    }
}

/// A duration read as seconds.
pub(crate) fn seconds<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Duration, D::Error> {
    let seconds = f64::deserialize(deserializer)?;
    Duration::try_from_secs_f64(seconds).map_err(|_| de::Error::custom("seconds from 0, within range"))
}
