//! npm's input types are written from `npm/schema.json`, so it must be what the forms say, and the
//! documentation's colors from `docs/_static/theme.json`, so it must be latkit's default themes:
//! `LATKIT_BLESS=1 cargo test -p latkit --test schema` writes both, and `node npm/build.mjs schema`
//! writes the types.

#![cfg(feature = "gpu")]

use std::path::Path;

#[test]
fn npm_schema_is_the_forms() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../npm/schema.json");
    let schemas = serde_json::to_string_pretty(&latkit::schemas()).expect("schemas serialize") + "\n";
    if std::env::var_os("LATKIT_BLESS").is_some() {
        std::fs::write(&path, &schemas).expect("npm/schema.json written");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        committed == schemas,
        "npm/schema.json is not what the forms say: run LATKIT_BLESS=1 cargo test -p latkit --test schema, \
         then node npm/build.mjs schema"
    );
}

#[test]
fn docs_palette_is_the_default_themes() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/_static/theme.json");
    let themes = serde_json::json!({ "light": latkit::Theme::light(), "dark": latkit::Theme::dark() });
    let text = serde_json::to_string_pretty(&themes).expect("themes serialize") + "\n";
    if std::env::var_os("LATKIT_BLESS").is_some() {
        std::fs::write(&path, &text).expect("docs/_static/theme.json written");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        committed == text,
        "docs/_static/theme.json is not latkit's default themes: run LATKIT_BLESS=1 cargo test -p latkit --test schema"
    );
}

#[test]
fn every_input_has_a_schema_and_reads_what_it_describes() {
    let schemas = latkit::schemas();
    let inputs = [
        "Scene",
        "Data",
        "Patch",
        "Query",
        "EnvelopeRequest",
        "Camera",
        "Fit",
        "Budget",
        "Shot",
        "Expr",
        "Theme",
        "Mark",
    ];
    for name in inputs {
        assert!(schemas["$defs"][name].is_object(), "{name} has a schema");
    }
    let diagram = &schemas["$defs"]["DiagramTheme"];
    assert!(diagram.to_string().contains("groupPadding"), "options are in camelCase");
    let names = &schemas["$defs"]["ColormapName"]["enum"];
    assert!(names.as_array().is_some_and(|n| n.iter().any(|n| n == "viridis")), "the catalog names its maps");
}
