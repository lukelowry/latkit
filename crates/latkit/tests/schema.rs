//! The npm package's input types are generated from `npm/schema.json`, so it must match latkit's
//! schemas, and its colormap catalog from `npm/colormaps.json`, which must match latkit's. The
//! documentation's colors come from `docs/_static/theme.json`, so it must match latkit's default
//! themes. `LATKIT_BLESS=1 cargo test -p latkit --test schema` writes these files, and
//! `node npm/build.mjs schema` regenerates the types and the catalog.

#![cfg(feature = "gpu")]

use std::path::Path;

#[test]
fn npm_schema_matches_the_input_schemas() {
    blessed("npm/schema.json", &latkit::schemas());
}

#[test]
fn docs_palette_matches_the_default_themes() {
    let themes = serde_json::json!({ "light": latkit::Theme::light(), "dark": latkit::Theme::dark() });
    blessed("docs/_static/theme.json", &themes);
}

#[test]
fn npm_colormaps_match_the_catalog() {
    let hex = |color: latkit::Color| {
        let [r, g, b, _] = color.to_rgba8();
        format!("#{r:02x}{g:02x}{b:02x}")
    };
    // A catalog map's colors in the form a custom colormap takes: each category's color, or 17
    // evenly placed colors.
    let catalog: Vec<serde_json::Value> = latkit::Colormap::catalog()
        .map(|map| {
            let colors: Vec<serde_json::Value> = if map.kind() == latkit::ColormapKind::Categorical {
                (0..map.count()).map(|i| hex(map.sample(i as f32)).into()).collect()
            } else {
                (0..=16_u8)
                    .map(|i| serde_json::json!([f32::from(i) / 16.0, hex(map.sample(f32::from(i) / 16.0))]))
                    .collect()
            };
            serde_json::json!({ "name": map.name(), "label": map.label(), "kind": map.kind(), "colors": colors })
        })
        .collect();
    blessed("npm/colormaps.json", &serde_json::Value::from(catalog));
}

/// Checks that file `path`, from the repository's root, holds `value` as pretty JSON, or writes it
/// with `LATKIT_BLESS` set.
fn blessed(path: &str, value: &serde_json::Value) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(path);
    let text = serde_json::to_string_pretty(value).expect("values serialize") + "\n";
    if std::env::var_os("LATKIT_BLESS").is_some() {
        std::fs::write(&file, &text).expect("the file written");
        return;
    }
    let committed = std::fs::read_to_string(&file).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        committed == text,
        "{path} is out of date: run LATKIT_BLESS=1 cargo test -p latkit --test schema, then node npm/build.mjs schema"
    );
}

#[test]
fn every_input_has_a_schema_matching_its_json_form() {
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
    assert!(names.as_array().is_some_and(|n| n.iter().any(|n| n == "viridis")), "the schema lists the colormap names");
}
