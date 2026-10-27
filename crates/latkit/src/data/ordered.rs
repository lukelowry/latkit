//! JSON objects read as named entries in the order written. Used where key order matters, such as
//! a query's selected fields or a message's patches by dataset.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};

use super::name::Name;

/// Entries in the order written. Each name appears once.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Ordered<V>(pub(crate) Vec<(Name, V)>);

impl<V> Default for Ordered<V> {
    fn default() -> Ordered<V> {
        Ordered(Vec::new())
    }
}

/// The schema is an object of `V` values by name.
impl<V: schemars::JsonSchema> schemars::JsonSchema for Ordered<V> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("Ordered_{}", V::schema_name()).into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <std::collections::BTreeMap<String, V>>::json_schema(generator)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for Ordered<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Ordered<V>, D::Error> {
        struct Entries<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for Entries<V> {
            type Value = Ordered<V>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object with unique names")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered<V>, A::Error> {
                let mut entries: Vec<(Name, V)> = Vec::new();
                while let Some(name) = map.next_key::<String>()? {
                    if entries.iter().any(|(n, _)| n.as_str() == name) {
                        return Err(de::Error::custom(format!("{name} appears twice")));
                    }
                    entries.push((name.into(), map.next_value()?));
                }
                Ok(Ordered(entries))
            }
        }
        deserializer.deserialize_map(Entries(PhantomData))
    }
}
