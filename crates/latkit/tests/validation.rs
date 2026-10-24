//! Batch validation uses the rendering compiler without requesting an adapter.
#![cfg(feature = "gpu")]

use latkit::{Data, Diagram, Error, Ids, Label, Plane, Scene, Table, Vertices};

fn data() -> Data {
    let mut data = Data::new("grid");
    data.apply(
        Table::new("Bus", Ids::count(2))
            .field("x", vec![0.0, 1.0])
            .field("y", vec![1.0, 2.0])
            .field("name", vec!["A", "B"]),
    )
    .unwrap();
    data
}

#[test]
fn validation_requires_unique_datasets_and_drawn_tables() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").position("x", "y"));
    assert!(scene.validate(&[data()], &[]).is_ok());
    assert!(matches!(scene.validate(&[], &[]), Err(Error::Invalid { .. })));
    assert!(scene.validate(&[data(), data()], &[]).unwrap_err().to_string().contains("duplicate"));
    assert!(scene.validate(&[Data::new("grid")], &[]).unwrap_err().to_string().contains("Bus"));
    let tiles = [latkit::Tiles::new("grid", "history/frames.json")];
    assert!(scene.validate(&[], &tiles).is_ok(), "tiles' marks are checked once they land");
}

#[test]
fn validation_checks_expression_types_and_gives_the_mark_path() {
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").position("name", "y"));
    let Error::Invalid { path, .. } = scene.validate(&[data()], &[]).unwrap_err() else { panic!("invalid expression") };
    assert!(path.to_string().starts_with("marks[0]."));
    let scene = Scene::new(Plane::default()).draw(Vertices::of("grid", "Bus").label(Label::new("missing")));
    assert!(scene.validate(&[data()], &[]).is_err());
}

#[test]
fn diagrams_allow_positions_to_be_derived_by_layout() {
    let scene = Scene::new(Diagram::default()).draw(Vertices::of("grid", "Bus")).layout(latkit::Layered::default());
    assert!(scene.validate(&[data()], &[]).is_ok());
}

#[test]
fn shadows_drop_onto_a_diagram_sheet_alone() {
    let block = Vertices::of("grid", "Bus").position("x", "y").shadow(true);
    let on_a_plane = Scene::new(Plane::default()).draw(block.clone()).validate(&[data()], &[]);
    assert!(on_a_plane.unwrap_err().to_string().contains("only a diagram has"), "refused on a plane");
    assert!(Scene::new(Diagram::default()).draw(block).validate(&[data()], &[]).is_ok());
}

#[test]
fn huge_durations_are_input_errors_instead_of_panics() {
    assert!(serde_json::from_str::<Scene>(r#"{"space":"plane","ease":1e100}"#).is_err());
}
