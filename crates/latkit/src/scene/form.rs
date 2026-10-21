//! What scenes read as JSON. Each type deserializes as itself and its schema is derived from it; a
//! type a name can stand for also reads one of its presets' names, such as `"inspect"`, `"globe"`, or
//! `"stress"`.

use std::fmt;
use std::marker::PhantomData;
use std::time::Duration;

use schemars::{Schema, json_schema};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde_json::Value;

/// A type a name can stand for.
pub(crate) trait Presets: Sized {
    /// The names, as the schema lists them.
    const NAMES: &'static [&'static str];

    /// The value `name` stands for.
    fn preset(name: &str) -> Option<Self>;

    /// The value its options, written out, make: what its derive reads.
    fn options<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error>;
}

/// `T` read from one of its presets' names, or from its options, read where they are written so an
/// error names the path to the option it could not read.
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
