//! Batch validation uses the rendering compiler without requesting an adapter.
#![cfg(feature = "gpu")]

use latkit::{
    Color, Colormap, Data, Diagram, Error, Expr, Ids, Label, Plane, Scene, Source, Table, Tiles, Vertices, field, when,
    zoom,
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

#[test]
fn validation_requires_unique_datasets_and_drawn_tables() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").position(field("x"), field("y")));
    assert!(scene.validate(&[data()]).is_ok());
    assert!(matches!(scene.validate(&[]), Err(Error::Invalid { .. })));
    assert!(scene.validate(&[data(), data()]).unwrap_err().to_string().contains("two sources named"));
    assert!(scene.validate(&[Data::new("grid").into()]).unwrap_err().to_string().contains("Bus"));
    let tiles = [Tiles::new("grid", "history/frames.json").into()];
    assert!(scene.validate(&tiles).is_ok(), "tiles' marks are checked once the tiles arrive");
}

#[test]
fn validation_checks_expression_types_and_gives_the_mark_path() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").position(field("name"), field("y")));
    let Error::Invalid { path, .. } = scene.validate(&[data()]).unwrap_err() else { panic!("invalid expression") };
    assert!(path.to_string().starts_with("marks[0]."));
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").label(Label::new(field("missing"))));
    assert!(scene.validate(&[data()]).is_err());
}

#[test]
fn a_label_text_chooses_between_one_text_field_and_missing() {
    let on_a_plane = |text: Expr| {
        let buses = Vertices::of("grid", "Bus").position(field("x"), field("y")).label(Label::new(text));
        Scene::new(Plane::default()).draw(buses).validate(&[data()])
    };
    let some = when(field("x").gt(0.5)).then(field("name")).otherwise(Expr::missing());
    assert!(on_a_plane(some).is_ok(), "the field where the condition holds, else no label");
    let two = when(field("x").gt(0.5)).then(field("name")).otherwise(field("other"));
    let Error::Invalid { path, .. } = on_a_plane(two).unwrap_err() else { panic!("two fields") };
    assert_eq!(path.to_string(), "marks[0].label.text");
    let number = when(field("x").gt(0.5)).then(field("name")).otherwise(1.0);
    assert!(on_a_plane(number).is_err(), "a value other than the field or missing");
    let zoomed = when(zoom().ge(3.0)).then(field("name")).otherwise(Expr::missing());
    assert!(on_a_plane(zoomed.clone()).is_ok(), "the zoom chooses on a plane");
    let blocks = Vertices::of("grid", "Bus").position(field("x"), field("y")).label(Label::new(zoomed));
    let in_a_diagram = Scene::new(Diagram::default()).draw(blocks).validate(&[data()]);
    assert!(in_a_diagram.unwrap_err().to_string().contains("not the zoom"), "a diagram's text reads only data");
}

#[test]
fn a_color_option_computes_a_color() {
    let colored = |color: Expr| {
        let buses = Vertices::of("grid", "Bus").position(field("x"), field("y")).color(color);
        Scene::new(Plane::default()).draw(buses).validate(&[data()])
    };
    assert!(colored(Color::rgb(1.0, 0.0, 0.0).into()).is_ok());
    assert!(colored(field("x").colormap(Colormap::VIRIDIS).into()).is_ok());
    assert!(colored(when(field("x").gt(0.5)).then(Color::WHITE).otherwise(Expr::missing())).is_ok());
    let error = colored(field("x")).unwrap_err().to_string();
    assert!(error.starts_with("marks[0].color"), "the error names the option: {error}");
    assert!(error.contains("found a number; map a number to colors with colormap"), "{error}");
    assert!(colored(field("name")).is_err(), "a text is no color");
}

#[test]
fn diagrams_allow_positions_to_be_derived_by_layout() {
    let scene = Scene::new(Diagram::default()).draw(Vertices::of("grid", "Bus")).layout(latkit::Layered::default());
    assert!(scene.validate(&[data()]).is_ok());
}

#[test]
fn shadows_are_valid_only_on_a_diagram() {
    let block = Vertices::of("grid", "Bus").position(field("x"), field("y")).shadow(true);
    let on_a_plane = Scene::new(Plane::default()).draw(block.clone()).validate(&[data()]);
    assert!(on_a_plane.unwrap_err().to_string().contains("only a diagram has"), "refused on a plane");
    assert!(Scene::new(Diagram::default()).draw(block).validate(&[data()]).is_ok());
}

#[test]
fn huge_durations_are_input_errors_instead_of_panics() {
    assert!(serde_json::from_str::<Scene>(r#"{"space":"plane","ease":1e100}"#).is_err());
}
