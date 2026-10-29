//! The npm package's input types are generated from `npm/schema.json`, so it must match latkit's
//! schemas, and its colormap catalog from `npm/colormaps.json`, which must match latkit's. The
//! documentation's colors come from `docs/_static/theme.json`, so it must match latkit's default
//! themes. `LATKIT_BLESS=1 cargo test -p latkit --test schema` writes these files, and
//! `node npm/build.mjs schema` regenerates the types and the catalog.

#![cfg(feature = "gpu")]

use std::path::Path;

use serde_json::Value;

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
    // The platform's `powf` and `cbrt` round some colors a step apart, so channels may differ by one.
    blessed_by("npm/colormaps.json", &serde_json::Value::from(catalog), within_a_step);
}

/// Checks that file `path`, from the repository's root, holds `value`, or writes it as pretty JSON
/// with `LATKIT_BLESS` set.
fn blessed(path: &str, value: &Value) {
    blessed_by(path, value, |committed, value| committed == value);
}

/// [`blessed`], with the committed JSON compared to `value` by `same`. Both are read from their text,
/// so numbers compare as written.
fn blessed_by(path: &str, value: &Value, same: impl Fn(&Value, &Value) -> bool) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(path);
    let text = serde_json::to_string_pretty(value).expect("values serialize") + "\n";
    if std::env::var_os("LATKIT_BLESS").is_some() {
        std::fs::write(&file, &text).expect("the file written");
        return;
    }
    let read = |text: &str| serde_json::from_str::<Value>(text).ok();
    let committed = std::fs::read_to_string(&file).ok().and_then(|committed| read(&committed));
    assert!(
        committed.zip(read(&text)).is_some_and(|(committed, value)| same(&committed, &value)),
        "{path} is out of date: run LATKIT_BLESS=1 cargo test -p latkit --test schema, then node npm/build.mjs schema"
    );
}

/// Whether `a` and `b` are the same JSON, except that `#rrggbb` colors may differ by one in each
/// channel.
fn within_a_step(a: &Value, b: &Value) -> bool {
    let channels =
        |s: &str| s.strip_prefix('#').and_then(|hex| u32::from_str_radix(hex, 16).ok()).map(u32::to_be_bytes);
    match (a, b) {
        (Value::String(a), Value::String(b)) if a.len() == 7 && b.len() == 7 => match (channels(a), channels(b)) {
            (Some(a), Some(b)) => a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 1),
            _ => a == b,
        },
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| within_a_step(a, b)),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| within_a_step(a, b)))
        }
        _ => a == b,
    }
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
