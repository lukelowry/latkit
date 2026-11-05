//! A scene's failures, found with the rendering compiler without requesting an adapter.
#![cfg(feature = "gpu")]

use latkit::{
    Color, Colormap, Data, Expr, Ids, Label, Plane, Plot, Scene, Source, Table, Tiles, Vertices, field, from_json,
    when, zoom,
};

fn data() -> Source {
    let data = Data::new("grid");
    data.apply(
        Table::new("Bus", Ids::count(2))
            .field("x", vec![0.0, 1.0])
            .field("y", vec![1.0, 2.0])
            .field("name", vec!["A", "B"]),
    )
    .unwrap();
    data.into()
}

/// Each failure of `scene` drawn from `sources`, as text.
fn failures(scene: &Scene, sources: &[Source]) -> Vec<String> {
    scene.failures(sources).unwrap().iter().map(ToString::to_string).collect()
}

/// The first failure of `scene` drawn from `sources`, as text. Empty when everything draws.
fn failure(scene: &Scene, sources: &[Source]) -> String {
    failures(scene, sources).into_iter().next().unwrap_or_default()
}

#[test]
fn failures_name_missing_datasets_and_tables() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").position(field("x"), field("y")));
    assert_eq!(failures(&scene, &[data()]), Vec::<String>::new());
    assert!(failure(&scene, &[]).contains("no source provides dataset 'grid'"));
    assert!(scene.failures(&[data(), data()]).unwrap_err().to_string().contains("two sources named"));
    assert!(failure(&scene, &[Data::new("grid").into()]).contains("Bus"));
    let tiles = [Tiles::new("grid", "history/frames.json").into()];
    assert_eq!(failures(&scene, &tiles), Vec::<String>::new(), "tiles' marks are checked once the tiles arrive");
}

#[test]
fn failures_check_expression_types_and_give_the_option_path() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").position(field("name"), field("y")));
    assert!(failure(&scene, &[data()]).starts_with("marks[0]."));
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").label(Label::new(field("missing"))));
    assert!(failure(&scene, &[data()]).starts_with("marks[0].label"));
}

#[test]
fn a_label_text_chooses_between_one_text_field_and_missing() {
    let on_a_plane = |text: Expr| {
        let buses = Vertices::of("grid", "Bus").position(field("x"), field("y")).label(Label::new(text));
        failure(&Scene::new(Plane::default()).draw(buses), &[data()])
    };
    let some = when(field("x").gt(0.5)).then(field("name")).otherwise(Expr::missing());
    assert_eq!(on_a_plane(some), "", "the field where the condition holds, else no label");
    let two = when(field("x").gt(0.5)).then(field("name")).otherwise(field("other"));
    assert!(on_a_plane(two).starts_with("marks[0].label.text:"));
    let number = when(field("x").gt(0.5)).then(field("name")).otherwise(1.0);
    assert!(!on_a_plane(number).is_empty(), "a value other than the field or missing");
    let zoomed = when(zoom().ge(3.0)).then(field("name")).otherwise(Expr::missing());
    assert_eq!(on_a_plane(zoomed), "", "the zoom chooses");
}

#[test]
fn a_color_option_computes_a_color() {
    let colored = |color: Expr| {
        let buses = Vertices::of("grid", "Bus").position(field("x"), field("y")).color(color);
        failure(&Scene::new(Plane::default()).draw(buses), &[data()])
    };
    assert_eq!(colored(Color::rgb(1.0, 0.0, 0.0).into()), "");
    assert_eq!(colored(field("x").colormap(Colormap::VIRIDIS).into()), "");
    assert_eq!(colored(when(field("x").gt(0.5)).then(Color::WHITE).otherwise(Expr::missing())), "");
    let error = colored(field("x"));
    assert!(error.starts_with("marks[0].color"), "the error names the option: {error}");
    assert!(error.contains("found a number; map a number to colors with colormap"), "{error}");
    assert!(!colored(field("name")).is_empty(), "a text is no color");
}

#[test]
fn a_layout_places_rows_without_positions() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus")).layout(latkit::Layered::default());
    assert_eq!(failures(&scene, &[data()]), Vec::<String>::new());
}

#[test]
fn options_a_scene_cannot_use_draw_as_if_unset() {
    let laid = Scene::new(Plot::default()).layout(latkit::Stress::default());
    assert!(failure(&laid, &[data()]).starts_with("layout: a plot cannot have a layout"));
    let bus = Vertices::of("grid", "Bus").position(field("x"), field("y"));
    let twins = Scene::new(Plane::default()).draw(bus.clone()).draw(bus.clone().radius(9.0));
    assert!(failure(&twins, &[data()]).starts_with("marks[1]: draws the same table as an earlier mark"));
    let uncolored = Scene::new(Plane::default()).draw(bus.legend("Buses"));
    assert!(failure(&uncolored, &[data()]).starts_with("marks[0].legend: a legend needs a color mapped"));
    let laid = Scene::new(Plot::default()).layout(latkit::Layered::default());
    assert!(failure(&laid, &[data()]).starts_with("layout: a plot cannot have a layout"));
}

#[test]
fn options_json_cannot_read_are_left_out_with_their_paths() {
    let scene: Scene = from_json(
        r#"{"space": "plane", "ease": 1e100, "title": 7, "subtitle": "gone",
            "marks": [{"vertices": ["grid", "Bus"], "colour": "red", "radius": "big", "position": ["$x", "$y"]}]}"#,
    )
    .unwrap();
    let paths: Vec<String> =
        failures(&scene, &[data()]).iter().map(|f| f.split(':').next().unwrap_or_default().to_owned()).collect();
    assert_eq!(paths, ["ease", "title", "subtitle", "marks[0].colour", "marks[0].radius"]);
    assert!(from_json::<Scene>(r#"{"space": "plnae"}"#).unwrap_err().to_string().starts_with("space"));
    let unreadable = from_json::<Scene>(r#"{"space": "plane", "marks": [{"vertices": 3}]}"#).unwrap_err();
    assert!(unreadable.to_string().starts_with("marks[0].vertices"), "{unreadable}");
}
