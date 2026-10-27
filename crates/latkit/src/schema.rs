//! JSON Schemas for latkit's inputs and outputs. Inputs are scenes, datasets, patches, queries,
//! cameras, fits, budgets, and shots. Outputs are events, hits, stats, work, and descriptions.
//!
//! Each schema derives from the same declaration as its type's serde code, so the two cannot drift
//! apart. `latkit schema` prints them, and the npm package's types are generated from them.

use schemars::generate::SchemaSettings;
use schemars::transform::RecursiveTransform;

/// Settings for every schema: draft 2020-12 with `default` keywords removed, since descriptions
/// state latkit's defaults.
fn settings() -> SchemaSettings {
    SchemaSettings::draft2020_12().with_transform(RecursiveTransform(|schema: &mut schemars::Schema| {
        schema.remove("default");
    }))
}

/// The JSON Schema `T` deserializes from, with its definitions under `$defs`.
///
/// ```
/// let data = latkit::schema::<latkit::Data>();
/// assert!(data["properties"]["patch"].is_object());
/// ```
pub fn schema<T: schemars::JsonSchema>() -> serde_json::Value {
    settings().into_generator().into_root_schema_for::<T>().to_value()
}

/// Every input and output JSON Schema in one document.
///
/// Inputs, and the types they are built from, are under `$defs` by name: `Scene`, `Data` (a
/// dataset's document), `Patch`, `Query`, `EnvelopeRequest`, `Camera`, `Fit`, `Budget`, and `Shot`.
/// Outputs, in their serialized form, are under `outputs`: `ViewEvent`, `Stats`, `Work`,
/// `Description`, `Rows`, `Camera`, `Budget`, `Value`, and `Failure` (an error).
///
/// ```
/// let schemas = latkit::schemas();
/// assert!(schemas["$defs"]["Theme"].is_object());
/// assert!(schemas["outputs"]["Hit"].is_object());
/// ```
#[cfg(feature = "gpu")]
pub fn schemas() -> serde_json::Value {
    let mut inputs = settings().into_generator();
    inputs.subschema_for::<crate::Scene>();
    inputs.subschema_for::<crate::Data>();
    inputs.subschema_for::<crate::Patch>();
    inputs.subschema_for::<crate::Query>();
    inputs.subschema_for::<crate::EnvelopeRequest>();
    inputs.subschema_for::<crate::Camera>();
    inputs.subschema_for::<crate::Fit>();
    inputs.subschema_for::<crate::Budget>();
    inputs.subschema_for::<crate::Shot>();
    let mut settings = settings().for_serialize();
    settings.definitions_path = "/outputs".into();
    let mut outputs = settings.into_generator();
    outputs.subschema_for::<crate::Event>();
    outputs.subschema_for::<crate::Stats>();
    outputs.subschema_for::<crate::Work>();
    outputs.subschema_for::<crate::Description>();
    outputs.subschema_for::<crate::Rows>();
    outputs.subschema_for::<crate::Camera>();
    outputs.subschema_for::<crate::Budget>();
    outputs.subschema_for::<crate::Value>();
    outputs.subschema_for::<crate::Error>();
    serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": inputs.take_definitions(true),
        "outputs": outputs.take_definitions(true),
    })
}
