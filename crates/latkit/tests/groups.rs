//! Groups: a diagram's vertex mark whose rows contain rows draws each as a container around its
//! members, padded and with its title's header on top, the same at every zoom; lit, it glows about
//! its border and hides nothing it holds.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, errors, frame, gpu, plain_theme};
use latkit::{Camera, Color, Data, Edges, Ids, Patch, Scene, Table, Theme, Vertices, View};

const C: u32 = SIZE / 2;

/// Two nodes in area 1 and one outside it, linked in a chain; y runs down.
fn graph() -> Data {
    let data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(Table::new("Area", vec![1_u64]))
            .set(
                Table::new("Node", vec![1_u64, 2, 3])
                    .field("x", vec![-15.0, 15.0, 40.0])
                    .field("y", vec![0.0, 0.0, 40.0])
                    .reference("area", "Area", vec![Some(1_u64), Some(1), None]),
            )
            .set(Table::new("Link", Ids::count(2)).reference("from", "Node", vec![1_u64, 2]).reference(
                "to",
                "Node",
                vec![2_u64, 3],
            )),
    )
    .expect("valid");
    data
}

fn view(gpu: &latkit::Gpu, zoom: f64) -> View {
    let plain = plain_theme();
    let diagram = latkit::DiagramTheme { group: Color::rgb(0.0, 0.0, 1.0), group_padding: 10.0, ..plain.diagram };
    let theme = Theme { diagram, ..plain };
    let scene = Scene::new(common::diagram())
        .theme(theme)
        .draw(Vertices::of("graph", "Area").contains("Node", "area"))
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0).color(Color::rgb(1.0, 0.0, 0.0)));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom, pitch: 0.0, bearing: 0.0 });
    view.set_sources([graph()]).expect("a source");
    view
}

fn blue(pixels: &[[u8; 4]], x: u32, y: u32) -> bool {
    let p = at(pixels, x, y);
    p[2] > 90 && p[0] < 60 && p[1] < 60
}

#[test]
fn groups_stand_around_their_members() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, 0.0);
    let pixels = frame(&gpu, &mut view);
    // Members span −19…19 across and −4…4 down; the group pads them by 10 units.
    assert!(blue(&pixels, C - 27, C) && blue(&pixels, C + 27, C) && blue(&pixels, C, C - 12), "around the members");
    assert!(!blue(&pixels, C - 31, C) && !blue(&pixels, C + 31, C) && !blue(&pixels, C, C + 16), "and no further");
    assert!(at(&pixels, C - 15, C)[0] > 120, "members draw over it");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_lit_group_glows_about_its_border_and_hides_nothing() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, 0.0);
    frame(&gpu, &mut view);
    // The pointer over the group's padding, away from its members: the group lights.
    let point = [C as f32 - 26.0, C as f32 + 12.0];
    let device = latkit::Device::Mouse;
    view.input(&latkit::Input::Move { pointer: 1, point, modifiers: latkit::Modifiers::default(), device }, 0.0);
    let mut pixels = Vec::new();
    for _ in 0..30 {
        pixels = common::step(&gpu, &mut view);
    }
    assert_eq!(view.hovered().map(|hit| hit.row.table.to_string()), Some("Area".into()), "the group is lit");
    assert!(at(&pixels, C - 15, C)[0] > 120, "its members still draw over it");
    assert!(blue(&pixels, C, C + 7), "its body shows away from its border");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn groups_scale_with_the_zoom_and_nothing_else() {
    let Some(gpu) = gpu() else { return };
    // At twice the zoom the container is twice as wide: the sheet is one fixed picture.
    let mut view = view(&gpu, 1.0);
    let pixels = frame(&gpu, &mut view);
    assert!(blue(&pixels, C - 56, C) && blue(&pixels, C + 56, C), "twice as far out");
    assert!(!blue(&pixels, C - 60, C) && !blue(&pixels, C + 60, C), "and no further");
    assert_eq!(errors(&mut view), Vec::new());
}
