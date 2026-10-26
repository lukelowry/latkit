//! Markers draw from their inputs: a gauge filled to its value, a pie's slices, an icon, a custom
//! WGSL marker, and a status ring. A custom marker that fails to compile is reported as an error,
//! not drawn.

#![cfg(feature = "gpu")]

mod common;

use std::sync::Arc;

use common::{SIZE, at, camera, close, errors, frame, gpu, plain_theme, plane};
use latkit::{Color, Data, Event, Expr, Ids, Image, Marker, Scene, Shape, Table, Vertices, View, field, when};

fn one(marker: Marker) -> (View, latkit::Gpu) {
    let gpu = gpu().expect("a GPU");
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("v", vec![0.5]))
        .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("d", "V").position("x", "y").radius(20.0).color(Color::WHITE).marker(marker));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    (view, gpu)
}

const WHITE: [u8; 4] = [255, 255, 255, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

#[test]
fn a_gauge_fills_up_to_its_value() {
    if common::gpu().is_none() {
        return;
    }
    let (mut view, gpu) = one(Marker::Gauge { fill: field("v"), shape: Shape::Rectangle });
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    assert!(close(at(&pixels, c, c + 10), WHITE), "filled below half: {:?}", at(&pixels, c, c + 10));
    assert!(close(at(&pixels, c, c - 10), BLACK), "empty above: {:?}", at(&pixels, c, c - 10));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_pie_cuts_slices_in_their_colors() {
    if common::gpu().is_none() {
        return;
    }
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);
    let (mut view, gpu) = one(Marker::Pie { slices: vec![1.0.into(), 1.0.into()], colors: vec![red, blue], hole: 0.0 });
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // Slices run clockwise from the top: the first fills the right half.
    assert!(close(at(&pixels, c + 10, c), [255, 0, 0, 255]), "{:?}", at(&pixels, c + 10, c));
    assert!(close(at(&pixels, c - 10, c), [0, 0, 255, 255]), "{:?}", at(&pixels, c - 10, c));
}

#[test]
fn icons_show_the_image_at_their_index() {
    if common::gpu().is_none() {
        return;
    }
    let solid = |rgba: [u8; 4]| Image { size: [2, 2], rgba: Arc::from(rgba.repeat(4)) };
    let images = vec![solid([255, 0, 0, 255]), solid([0, 255, 0, 255])];
    let (mut view, gpu) = one(Marker::Icon { images, index: 1.0.into() });
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    assert!(close(at(&pixels, c + 5, c + 5), [0, 255, 0, 255]), "{:?}", at(&pixels, c + 5, c + 5));
}

#[test]
fn custom_markers_draw_their_wgsl_and_bad_ones_are_reported() {
    if common::gpu().is_none() {
        return;
    }
    let source = "fn marker(f: MarkerFragment) -> MarkerColor {
        let d = max(abs(f.p.x), abs(f.p.y)) - f.half.x;
        return filled(vec4f(f.input[0], 1.0, 0.0, 1.0), d);
    }";
    let (mut view, gpu) = one(Marker::Wgsl { source: source.into(), inputs: vec![field("v")] });
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    let pixel = at(&pixels, c + 15, c + 15);
    assert!(pixel[0].abs_diff(128) <= 4 && pixel[1] == 255, "a square in the input's color: {pixel:?}");
    assert_eq!(errors(&mut view), Vec::new());

    let (mut view, gpu) =
        one(Marker::Wgsl { source: "fn marker(f: MarkerFragment) -> MarkerColor { oops }".into(), inputs: vec![] });
    frame(&gpu, &mut view);
    frame(&gpu, &mut view);
    let told = view.events().any(|e| matches!(e, Event::Error(error) if error.to_string().contains("custom marker")));
    assert!(told, "the broken marker is reported");
}

#[test]
fn status_rings_surround_their_markers() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("d", "V").position("x", "y").radius(10.0).color(Color::WHITE).ring(Color::rgb(1.0, 0.0, 0.0)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    let ring = at(&pixels, c + 11, c);
    assert!(ring[0] > 200 && ring[1] < 80, "a red ring just outside: {ring:?}");
    assert!(close(at(&pixels, c, c), WHITE));
}

#[test]
fn a_missing_status_draws_no_ring_in_either_branch() {
    let Some(gpu) = gpu() else { return };
    let red = Color::rgb(1.0, 0.0, 0.0);
    // Only the alarmed row, on the left, gets a ring.
    let forms: [Expr; 2] = [
        when(field("alarm").gt(0.5)).then(red).otherwise(Expr::missing()),
        when(field("alarm").lt(0.5)).then(Expr::missing()).otherwise(red),
    ];
    for status in forms {
        let data = Data::new("d");
        let table = Table::new("V", Ids::count(2)).field("x", vec![-30.0, 30.0]).field("y", vec![0.0, 0.0]);
        data.apply(table.field("alarm", vec![1.0, 0.0])).expect("valid");
        let scene = Scene::new(plane())
            .theme(plain_theme())
            .draw(Vertices::of("d", "V").position("x", "y").radius(10.0).color(Color::WHITE).ring(status));
        let mut view = View::new(&gpu, scene).expect("valid scene");
        view.set_camera(camera());
        view.set_sources([&data]).expect("a source");
        let pixels = frame(&gpu, &mut view);
        let c = SIZE / 2;
        let alarmed = at(&pixels, c - 30 + 11, c);
        assert!(alarmed[0] > 200 && alarmed[1] < 80, "the alarmed row has a ring: {alarmed:?}");
        let quiet = at(&pixels, c + 30 + 11, c);
        assert!(quiet[0] < 80, "the quiet row does not: {quiet:?}");
        assert_eq!(errors(&mut view), Vec::new());
    }
}
