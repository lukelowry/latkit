//! What latkit reads, as JSON Schema: scenes, datasets, patches, queries, cameras, fits, budgets, and
//! shots. Each type deserializes from a form, a plain struct or enum serde reads, and its schema is
//! that form's, so the decoder and its schema never part. `latkit schema` prints them, and npm's input
//! types are written from them.

/// The JSON Schema of what `T` deserializes from, its definitions under `$defs`.
///
/// ```
/// let scene = latkit::schema::<latkit::Scene>();
/// assert!(scene["properties"]["marks"].is_object());
/// ```
pub fn schema<T: schemars::JsonSchema>() -> serde_json::Value {
    schemars::SchemaGenerator::default().into_root_schema_for::<T>().to_value()
}

/// Every input's JSON Schema in one document, each under its name in `$defs` with what it is built
/// of: `Scene`, `Data` (a dataset's document), `Patch`, `Query`, `Camera`, `Fit`, `Budget`, `Shot`.
///
/// ```
/// let schemas = latkit::schemas();
/// assert!(schemas["$defs"]["Theme"].is_object());
/// ```
#[cfg(feature = "gpu")]
pub fn schemas() -> serde_json::Value {
    let mut generator = schemars::SchemaGenerator::default();
    generator.subschema_for::<crate::Scene>();
    generator.subschema_for::<crate::Data>();
    generator.subschema_for::<crate::Patch>();
    generator.subschema_for::<crate::Query>();
    generator.subschema_for::<crate::Camera>();
    generator.subschema_for::<crate::Fit>();
    generator.subschema_for::<crate::Budget>();
    generator.subschema_for::<crate::Shot>();
    let defs = generator.take_definitions(true);
    serde_json::json!({ "$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": defs })
}

/// Each type deserializes from its form, built by the form's `build`, and has the form's schema under
/// the type's own name.
#[cfg(feature = "gpu")]
macro_rules! from_form {
    ($($ty:ident => $form:ty),* $(,)?) => {$(
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<$ty, D::Error> {
                <$form as serde::Deserialize>::deserialize(deserializer)?.build()
            }
        }

        impl schemars::JsonSchema for $ty {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($ty).into()
            }

            fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                <$form as schemars::JsonSchema>::json_schema(generator)
            }
        }
    )*};
}

#[cfg(feature = "gpu")]
pub(crate) use from_form;

/// `name` read as one of the names `T` deserializes from: an unknown name is an error that lists
/// them. Untagged forms read names as text through it, so their errors stay precise.
#[cfg(feature = "gpu")]
pub(crate) fn named<'a, T: serde::Deserialize<'a>, E: serde::de::Error>(name: &'a str) -> Result<T, E> {
    T::deserialize(serde::de::value::BorrowedStrDeserializer::<E>::new(name))
}
