//! Tests that scenes read from JSON equal the same scenes built in Rust, field for field.

use std::time::Duration;

use super::*;
use crate::{Color, Colormap, ColormapKind, Expr, field, px, units};

fn scene(json: &str) -> Scene {
    serde_json::from_str(json).expect("a scene")
}

#[test]
fn scenes_match_builders() {
    let json = r#"{
        "space": { "earth": { "projection": "globe" } },
        "marks": [
            { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "width": { "px": 2 } } },
            { "vertices": { "of": ["grid", "Bus"], "position": ["lon", "lat"], "radius": { "units": 3 },
                "color": { "colormap": "balance", "value": "vm", "domain": [0.95, 1.05] } } }
        ],
        "theme": { "base": "light", "vertex": { "radius": 5 } },
        "ease": 0
    }"#;
    let light = Theme::light();
    let built = Scene::new(Earth::default().projection(Projection::Globe))
        .theme(Theme { vertex: VertexTheme { radius: 5.0, ..light.vertex }, ..light })
        .ease(Duration::ZERO)
        .draw(Edges::of("grid", "Branch").ends("from", "to").width(px(2.0)))
        .draw(
            Vertices::of("grid", "Bus")
                .position("lon", "lat")
                .radius(units(3.0))
                .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05)),
        );
    assert_eq!(scene(json), built);
}

#[test]
fn every_mark_defaults_as_its_json_form_does() {
    let json = |kind: &str| -> Mark {
        serde_json::from_str(&format!(r#"{{ "{kind}": {{ "of": ["d", "t"] }} }}"#)).expect(kind)
    };
    assert_eq!(json("vertices"), Vertices::of("d", "t").into());
    assert_eq!(json("edges"), Edges::of("d", "t").into());
    assert_eq!(json("faces"), Faces::of("d", "t").into());
    assert_eq!(json("lines"), Lines::of("d", "t").into());
    assert_eq!(json("areas"), Areas::of("d", "t").into());
}

#[test]
fn rows_pick_by_default_and_geometry_only_when_asked() {
    let picks = |mark: Mark| mark.picks();
    assert!(picks(Vertices::of("d", "t").into()) && picks(Edges::of("d", "t").into()), "vertices and edges");
    assert!(picks(Lines::of("d", "t").trace("v").into()), "a plot's traces");
    assert!(!picks(Lines::of("d", "t").into()) && !picks(Areas::of("d", "t").into()), "geometry");
    assert!(picks(Areas::of("d", "t").pick(true).into()) && !picks(Vertices::of("d", "t").pick(false).into()));
    let marks = scene(
        r#"{ "space": "earth", "marks": [ { "areas": { "of": ["m", "states"] } },
        { "areas": { "of": ["m", "states"], "pick": true } } ] }"#,
    )
    .marks;
    assert_eq!(marks.iter().map(Mark::picks).collect::<Vec<_>>(), [false, true], "JSON says the same");
}

#[test]
fn faces_lines_and_controls_match_builders() {
    let json = r##"{
        "space": "plane",
        "controls": { "turn": false, "pickRadius": 12 },
        "marks": [
            { "faces": { "of": ["mesh", "Face"], "corners": ["a", "b", "c"], "pick": false } },
            { "lines": { "of": ["mesh", "Body"], "geometry": "outline", "color": "#66c7ff", "width": 2, "flow": 8 } },
            { "vertices": { "of": ["mesh", "Vertex"], "select": false, "drag": true, "ring": "red" } }
        ]
    }"##;
    let built = Scene::new(Plane::default())
        .controls(Controls { turn: false, pick_radius: 12.0, ..Controls::default() })
        .draw(Faces::of("mesh", "Face").corners("a", "b", "c").pick(false))
        .draw(
            Lines::of("mesh", "Body")
                .geometry("outline")
                .color(Color::hex("#66c7ff").expect("hex"))
                .width(2.0)
                .flow(8.0),
        )
        .draw(Vertices::of("mesh", "Vertex").select(false).drag(true).ring(Color::rgb(1.0, 0.0, 0.0)));
    assert_eq!(scene(json), built);
}

#[test]
fn a_text_in_a_color_option_is_a_color_and_elsewhere_a_field() {
    let json = r##"{
        "space": "plane",
        "marks": [{ "vertices": { "of": ["grid", "Bus"], "position": ["x", "y"], "radius": "r",
            "color": { "when": [[{ "field": "on" }, "#ffb000"]], "otherwise": "gray" },
            "label": { "text": "name", "color": "white" } } }]
    }"##;
    let css = |css: &str| Color::css(css).expect("a CSS color");
    let built = Scene::new(Plane::default()).draw(
        Vertices::of("grid", "Bus")
            .position("x", "y")
            .radius("r")
            .color(crate::when(field("on")).then(css("#ffb000")).otherwise(css("gray")))
            .label(Label::new("name").color(css("white"))),
    );
    assert_eq!(scene(json), built);
    let error = serde_json::from_str::<Scene>(
        r#"{ "space": "plane", "marks": [{ "vertices": { "of": ["grid", "Bus"], "color": "kv" } }] }"#,
    )
    .expect_err("a field's name where a color goes");
    assert!(error.to_string().contains(r#"not a CSS color: "kv"; for a field, use field("kv")"#), "{error}");
}

#[test]
fn joins_read_from_another_table() {
    let json = r#"{
        "space": "plane",
        "marks": [{ "vertices": { "of": ["grid", "Bus"], "position": ["x", "y"],
            "radius": { "field": "r", "from": ["weather", "Station"] } } }]
    }"#;
    let built = Scene::new(Plane::default())
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(field("r").from_table("weather", "Station")));
    assert_eq!(scene(json), built);
}

#[test]
fn areas_and_earth_options_match_builders() {
    let json = r##"{
        "space": { "earth": { "projection": "globe", "daylight": 1782043200, "atmosphere": true } },
        "marks": [
            { "areas": { "of": ["map", "states"], "geometry": "outline", "color": "#336699" } },
            { "lines": { "of": ["map", "states"], "geometry": "outline" } }
        ],
        "theme": { "area": { "color": "#223344" }, "earth": { "night": 0.4 } }
    }"##;
    let dark = Theme::dark();
    let theme = Theme {
        area: AreaTheme { color: Color::hex("#223344").expect("hex") },
        earth: EarthTheme { night: 0.4, ..dark.earth },
        ..dark
    };
    let built = Scene::new(Earth::default().projection(Projection::Globe).daylight(1_782_043_200.0).atmosphere(true))
        .theme(theme)
        .draw(Areas::of("map", "states").geometry("outline").color(Color::hex("#336699").expect("hex")))
        .draw(Lines::of("map", "states").geometry("outline"));
    assert_eq!(scene(json), built);
}

#[test]
fn comets_and_named_categories_match_builders() {
    let json = r##"{
        "space": "plane",
        "marks": [
            { "vertices": { "of": ["grid", "Bus"], "legend": "Kind",
                "color": { "colormap": { "kind": "categorical", "colors": ["#ff0000", "#0000ff"],
                    "categories": ["red", "blue"] }, "value": "k" } } }
        ],
        "theme": { "flow": { "color": "#00ff00", "width": 6, "spacing": { "units": 40 }, "length": { "units": 30 } } }
    }"##;
    let map = Colormap::new(ColormapKind::Categorical, [Color::rgb(1.0, 0.0, 0.0), Color::rgb(0.0, 0.0, 1.0)]).unwrap();
    let flow = FlowTheme {
        color: Color::rgb(0.0, 1.0, 0.0),
        width: 6.0,
        spacing: Length::Units(40.0),
        length: Length::Units(30.0),
    };
    let built = Scene::new(Plane::default())
        .theme(Theme { flow, ..Theme::default() })
        .draw(Vertices::of("grid", "Bus").legend("Kind").color(field("k").colormap(map.categories(["red", "blue"]))));
    assert_eq!(scene(json), built);
    let continuous =
        r#"{ "colormap": { "kind": "sequential", "colors": ["red"], "categories": ["a"] }, "value": "k" }"#;
    assert!(serde_json::from_str::<Expr>(continuous).is_err(), "only a categorical map has categories");
    let mixed = Scene::new(Plane::default())
        .theme(Theme { flow: FlowTheme { spacing: Length::Units(40.0), ..Theme::default().flow }, ..Theme::default() });
    let error = mixed.check().expect_err("spacing and length in two units");
    assert!(error.to_string().starts_with("theme.flow.length: "), "{error}");
}

#[test]
fn themes_read_a_base_and_options_over_it() {
    let theme = |json: &str| serde_json::from_str::<Theme>(json).expect("a theme");
    assert_eq!(theme(r#""light""#), Theme::light());
    assert_eq!(theme("{}"), Theme::dark());
    assert!(Theme::default().focus.selected.is_some());
    assert_eq!(theme(r#"{ "focus": { "selected": null } }"#).focus.selected, None, "null clears a color");
    let light = Theme::light();
    let glow = theme(r#"{ "base": "light", "focus": { "glow": 3 } }"#);
    assert_eq!(glow, Theme { focus: FocusTheme { glow: 3.0, ..light.focus }, ..light });
    assert!(serde_json::from_str::<Theme>(r#"{ "focus": { "glw": 3 } }"#).is_err(), "a typo");
}

#[test]
fn presets_equal_their_values() {
    let controls = |json: &str| serde_json::from_str::<Controls>(json).expect("controls");
    assert_eq!(controls(r#""inspect""#), Controls::inspect());
    assert_eq!(controls(r#""none""#), Controls::none());
    let options = controls(r#"{ "zoom": "modifier", "cycle": true, "press": 0.8, "motion": "reduced" }"#);
    let expected = Controls {
        zoom: Zoom::Modifier,
        cycle: true,
        press: Duration::from_millis(800),
        motion: Motion::Reduced,
        ..Controls::default()
    };
    assert_eq!(options, expected);
    assert!(serde_json::from_str::<Controls>(r#"{ "zoom": true }"#).is_err(), "zoom names an input, not a boolean");
    assert_eq!(serde_json::from_str::<Layout>(r#""layered""#).expect("a layout"), Layout::Layered(Layered::default()));
    let layered = r#"{ "layered": { "flow": "down", "rankGap": 40 } }"#;
    let layered = serde_json::from_str::<Layout>(layered).expect("a layout");
    assert_eq!(layered, Layout::Layered(Layered { flow: Direction::Down, rank_gap: 40.0, ..Layered::default() }));
    assert_eq!(serde_json::from_str::<Marker>(r#""block""#).expect("a marker"), Marker::block());
    let gauge = serde_json::from_str::<Marker>(r#"{ "gauge": { "fill": "f" } }"#).expect("a marker");
    assert_eq!(gauge, Marker::Gauge { fill: field("f"), shape: Shape::Ellipse });
    assert_eq!(serde_json::from_str::<Port>(r#""left""#).expect("a port"), Port::new(Side::Left));
    let output = serde_json::from_str::<Port>(r#"{ "side": "right", "output": true }"#).expect("a port");
    assert_eq!(output, Port::output(Side::Right));
    assert_eq!(serde_json::from_str::<Label>(r#""name""#).expect("a label"), Label::new("name"));
    let label = serde_json::from_str::<Label>(r#"{ "text": "name", "max": 20 }"#).expect("a label");
    assert_eq!(label, Label::new("name").max(20));
    let grid = r#"{ "diagram": { "grid": { "dots": { "pitch": 10, "snap": true } } } }"#;
    let space = serde_json::from_str::<Space>(grid).expect("a space");
    assert_eq!(space, Space::Diagram(Diagram { grid: Grid::Dots { pitch: 10.0, snap: true } }));
    assert_eq!(serde_json::from_str::<Space>(r#""earth""#).expect("a space"), Space::Earth(Earth::default()));
}

#[test]
fn unknown_options_are_refused() {
    let error = serde_json::from_str::<Scene>(
        r#"{"space": "plane", "marks": [{"vertices": {"of": ["a", "b"], "colour": "x"}}]}"#,
    )
    .expect_err("a typo");
    assert!(error.to_string().contains("colour"), "{error}");
}
