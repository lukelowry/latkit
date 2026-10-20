//! What latkit reads and writes, as JSON Schema: scenes, datasets, patches, queries, cameras, fits,
//! budgets, and shots in; events, hits, stats, work, and descriptions out. Each type serializes or
//! deserializes as itself and its schema derives from the same declaration, so the code and its
//! schema never part. `latkit schema` prints them, and npm's types are written from them.

use schemars::generate::SchemaSettings;
use schemars::transform::RecursiveTransform;

/// The settings every schema is made with: draft 2020-12, saying what is read or written and not
/// latkit's defaults, which descriptions say.
fn settings() -> SchemaSettings {
    SchemaSettings::draft2020_12().with_transform(RecursiveTransform(|schema: &mut schemars::Schema| {
        schema.remove("default");
    }))
}

/// The JSON Schema of what `T` deserializes from, its definitions under `$defs`.
///
/// ```
/// let data = latkit::schema::<latkit::Data>();
/// assert!(data["properties"]["patch"].is_object());
/// ```
pub fn schema<T: schemars::JsonSchema>() -> serde_json::Value {
    settings().into_generator().into_root_schema_for::<T>().to_value()
}

/// Every input's JSON Schema in one document, each under its name in `$defs` with what it is built
/// of: `Scene`, `Data` (a dataset's document), `Patch`, `Query`, `Camera`, `Fit`, `Budget`, `Shot`.
/// What latkit writes is under `outputs`, as it serializes: `ViewEvent`, `Stats`, `Work`,
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
