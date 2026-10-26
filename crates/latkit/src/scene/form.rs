//! JSON reading for scenes. Each type deserializes and derives its schema from its own definition;
//! a type with presets also accepts a preset's name, such as `"inspect"`, `"earth"`, or `"stress"`.

use std::fmt;
use std::marker::PhantomData;
use std::time::Duration;

use schemars::{Schema, json_schema};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde_json::Value;

/// A type with named presets.
pub(crate) trait Presets: Sized {
    /// The preset names, in the order the schema lists them.
    const NAMES: &'static [&'static str];

    /// The preset named `name`, if any.
    fn preset(name: &str) -> Option<Self>;

    /// Reads the type from its options object with the derived implementation.
    fn options<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error>;
}

/// Reads `T` from a preset name or from its options. Options are read in place, so an error names
/// the path to the option that failed.
pub(crate) fn preset_or<'de, D: Deserializer<'de>, T: Presets>(deserializer: D) -> Result<T, D::Error> {
    struct Named<T>(PhantomData<T>);

    impl<'de, T: Presets> Visitor<'de> for Named<T> {
        type Value = T;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "one of {}, or options", T::NAMES.join(", "))
        }

        fn visit_str<E: de::Error>(self, name: &str) -> Result<T, E> {
            T::preset(name)
                .ok_or_else(|| E::custom(format!("unknown name {name:?}, expected one of {}", T::NAMES.join(", "))))
        }

        fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
            T::options(MapAccessDeserializer::new(map))
        }
    }

    deserializer.deserialize_any(Named(PhantomData))
}

/// Rewrites `T`'s derived schema to accept a preset name or the derived form, moving the
/// description to the whole.
pub(crate) fn presets<T: Presets>(schema: &mut Schema) {
    let mut derived = std::mem::replace(schema, json_schema!({}));
    let description = derived.remove("description");
    // Drop unit variants that a preset already names; the preset's name covers them.
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

/// Reads a duration in seconds; errors on negative or out-of-range values.
pub(crate) fn seconds<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Duration, D::Error> {
    let seconds = f64::deserialize(deserializer)?;
    Duration::try_from_secs_f64(seconds).map_err(|_| de::Error::custom("seconds must be finite and not negative"))
}
