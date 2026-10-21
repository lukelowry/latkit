//! Scenes read as JSON match the builders, field for field.

use std::time::Duration;

use super::*;
use crate::{Color, Colormap, ColormapKind, Expr, field};

fn scene(json: &str) -> Scene {
    serde_json::from_str(json).expect("a scene")
}

#[test]
fn scenes_match_builders() {
    let json = r#"{
        "space": "globe",
        "marks": [
            { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "width": 2 } },
            { "vertices": { "of": ["grid", "Bus"], "position": ["lon", "lat"], "radius": { "units": 3 },
                "color": { "colormap": "balance", "value": "vm", "domain": [0.95, 1.05] } } }
        ],
        "theme": { "base": "light", "vertexRadius": 5 },
        "ease": 0
    }"#;
    let built = Scene::new(Earth::globe())
        .theme(Theme { vertex_radius: 5.0, ..Theme::light() })
        .ease(Duration::ZERO)
        .draw(Edges::of("grid", "Branch").ends("from", "to").width(2.0))
        .draw(
            Vertices::of("grid", "Bus")
                .position("lon", "lat")
                .radius(crate::units(3.0))
                .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05)),
        );
    assert_eq!(scene(json), built);
}

#[test]
fn things_pick_and_geometry_does_not_unless_asked() {
    let picks = |mark: Mark| mark.picks();
    assert!(picks(Vertices::of("d", "t").into()) && picks(Edges::of("d", "t").into()), "rows that are things");
    assert!(picks(Lines::of("d", "t").trace("v").into()), "a plot's traces");
    assert!(!picks(Lines::of("d", "t").into()) && !picks(Areas::of("d", "t").into()), "geometry");
    assert!(picks(Areas::of("d", "t").pick(true).into()) && !picks(Vertices::of("d", "t").pick(false).into()));
    let marks = scene(
        r#"{ "space": "mercator", "marks": [ { "areas": { "of": ["m", "states"] } },
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
            { "faces": { "of": ["mesh", "Face"], "corners": ["a", "b", "c"], "pick": false, "shadow": true } },
            { "lines": { "of": ["mesh", "Body"], "geometry": "outline", "color": "#66c7ff", "width": 2, "flow": 8 } },
            { "vertices": { "of": ["mesh", "Vertex"], "select": false, "drag": true, "ring": "#ff0000" } }
        ]
    }"##;
    let built = Scene::new(Plane::default())
        .controls(Controls { turn: false, pick_radius: 12.0, ..Controls::default() })
        .draw(Faces::of("mesh", "Face").corners("a", "b", "c").pick(false).shadow(true))
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
fn areas_and_the_earths_look_match_builders() {
    let json = r##"{
        "space": { "earth": { "projection": "globe", "daylight": 1782043200, "atmosphere": true } },
        "marks": [
            { "areas": { "of": ["map", "states"], "geometry": "outline", "color": "#336699" } },
            { "lines": { "of": ["map", "states"], "geometry": "outline" } }
        ],
        "theme": { "area": "#223344", "night": 0.4 }
    }"##;
    let built = Scene::new(Earth::globe().daylight(1_782_043_200.0).atmosphere(true))
        .theme(Theme { area: Color::hex("#223344").expect("hex"), night: 0.4, ..Theme::default() })
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
        "theme": { "flow": { "color": "#00ff00", "width": 6 } }
    }"##;
    let map = Colormap::new(ColormapKind::Categorical, [Color::rgb(1.0, 0.0, 0.0), Color::rgb(0.0, 0.0, 1.0)]).unwrap();
    let flow = Flow { color: Color::rgb(0.0, 1.0, 0.0), width: 6.0, ..Theme::default().flow };
    let built = Scene::new(Plane::default())
        .theme(Theme { flow, ..Theme::default() })
        .draw(Vertices::of("grid", "Bus").legend("Kind").color(field("k").colormap(map.categories(["red", "blue"]))));
    assert_eq!(scene(json), built);
    let continuous =
        r#"{ "colormap": { "kind": "sequential", "colors": ["red"], "categories": ["a"] }, "value": "k" }"#;
    assert!(serde_json::from_str::<Expr>(continuous).is_err(), "only a categorical map has categories");
}

#[test]
fn themes_read_a_base_and_options_over_it() {
    let theme = |json: &str| serde_json::from_str::<Theme>(json).expect("a theme");
    assert_eq!(theme(r#""light""#), Theme::light());
    assert_eq!(theme("{}"), Theme::dark());
    assert!(Theme::default().selected.is_some());
    assert_eq!(theme(r#"{ "selected": null }"#).selected, None, "null clears a color");
    assert_eq!(theme(r#"{ "base": "light", "glow": 3 }"#), Theme { glow: 3.0, ..Theme::light() });
    assert!(serde_json::from_str::<Theme>(r#"{ "glw": 3 }"#).is_err(), "a typo");
}

#[test]
fn presets_stand_for_values() {
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
    assert!(serde_json::from_str::<Controls>(r#"{ "zoom": true }"#).is_err(), "zoom names what zooms");
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
    assert!(serde_json::from_str::<Space>(r#""earth""#).is_err(), "the earth is a mercator map or a globe");
}

#[test]
fn unknown_options_are_refused() {
    let error = serde_json::from_str::<Scene>(
        r#"{"space": "plane", "marks": [{"vertices": {"of": ["a", "b"], "colour": "x"}}]}"#,
    )
    .expect_err("a typo");
    assert!(error.to_string().contains("colour"), "{error}");
}
