//! Focus shared between views. A view keeps selected and hovered rows that no mark of it draws, and
//! the rows one reference from them, such as the machines of a selected bus, read as related. A
//! hover the application sets stays until the pointer hovers a row, and the pointer moving along
//! one traced line reports each sample it passes.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{
    Axis, Camera, Color, Data, Device, Event, Ids, Input, Lines, Modifiers, Patch, Plot, Row, Rows, Scene, Table,
    Vertices, View, field, related, when,
};

const C: u32 = SIZE / 2;
const RED: Color = Color::rgb(1.0, 0.0, 0.0);

/// Two buses, and a machine at each: machine 10 at bus 1 on the left, machine 20 at bus 2 on the
/// right.
fn grid() -> Data {
    let data = Data::new("grid");
    let buses = Table::new("Bus", vec![1_u64, 2]).field("x", vec![-30.0, 30.0]).field("y", vec![0.0, 0.0]);
    let machines = Table::new("Machine", vec![10_u64, 20])
        .field("x", vec![-30.0, 30.0])
        .field("y", vec![0.0, 0.0])
        .reference("bus", "Bus", vec![1_u64, 2]);
    data.apply(Patch::new().set(buses).set(machines)).expect("valid");
    data
}

/// A view of the machines alone: red where related to a selected or hovered row, else white.
fn machines(gpu: &latkit::Gpu, data: &Data) -> View {
    let color = when(related()).then(RED).otherwise(Color::WHITE);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("grid", "Machine").position(field("x"), field("y")).radius(6.0).color(color));
    let mut view = View::new(gpu, scene);
    view.set_camera(camera());
    view.set_sources([data]).expect("a source");
    view
}

fn moved(point: [f32; 2]) -> Input {
    Input::Move { pointer: 1, point, modifiers: Modifiers::default(), device: Device::Mouse }
}

#[test]
fn a_view_keeps_a_shared_selection_and_lights_its_related_rows() {
    let Some(gpu) = gpu() else { return };
    let data = grid();
    let mut view = machines(&gpu, &data);
    frame(&gpu, &mut view);
    let bus = Rows::new("grid", "Bus", [2_u64]);
    view.set_selection([bus.clone()]);
    let pixels = frame(&gpu, &mut view);
    assert_eq!(view.selection(), [bus], "a selected row no mark here draws stays selected");
    // The machine at the selected bus is related, and bright. The other dims.
    let (left, right) = (at(&pixels, C - 30, C), at(&pixels, C + 30, C));
    assert!(right[0] > 200 && right[1] < 60, "machine 20, at bus 2, is related: {right:?}");
    assert!((40..140).contains(&left[1]), "machine 10 dims: {left:?}");
    // A row the data drops leaves the selection.
    data.apply(Patch::new().remove("Bus", [2_u64])).expect("valid");
    frame(&gpu, &mut view);
    assert_eq!(view.selection(), Vec::<Rows>::new());
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_hover_the_application_sets_stays_until_the_pointer_hovers_a_row() {
    let Some(gpu) = gpu() else { return };
    let data = grid();
    let mut view = machines(&gpu, &data);
    frame(&gpu, &mut view);
    let bus = Row::new("grid", "Bus", 1_u64);
    view.set_hovered(Some(bus.clone()));
    let pixels = frame(&gpu, &mut view);
    assert_eq!(view.hovered(), Some(&bus));
    assert!(!view.events().any(|e| matches!(e, Event::Hovered { .. })), "setting it reports nothing");
    let (left, right) = (at(&pixels, C - 30, C), at(&pixels, C + 30, C));
    assert!(left[0] > 200 && left[1] < 60, "machine 10, at bus 1, is related: {left:?}");
    assert!(right[1] > 200, "machine 20 is not, and nothing dims: {right:?}");
    // The pointer over nothing leaves it. Over machine 20, the pointer's row replaces it.
    view.input(&moved([C as f32, (C + 40) as f32]), common::now());
    for _ in 0..30 {
        step(&gpu, &mut view);
    }
    assert_eq!(view.hovered(), Some(&bus));
    view.input(&moved([(C + 30) as f32, C as f32]), common::now());
    for _ in 0..30 {
        step(&gpu, &mut view);
    }
    assert_eq!(view.hovered(), Some(&Row::new("grid", "Machine", 20_u64)));
    let pixels = frame(&gpu, &mut view);
    assert!(at(&pixels, C - 30, C)[1] > 200, "machine 10 is no longer related: {:?}", at(&pixels, C - 30, C));
}

#[test]
fn moving_along_a_trace_reports_each_sample_it_hovers() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("signals");
    data.apply(Table::new("Signal", Ids::count(1))).expect("valid");
    for t in 0..=10 {
        data.apply(Patch::new().append("Signal", [f64::from(t)], [("v", vec![f64::from(t) / 10.0])])).expect("frame");
    }
    let axis = Axis { hidden: true, grid: false, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").width(3.0));
    let mut view = View::new(&gpu, scene);
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    let mut hovered = |at: f64| {
        let point = view.screen([at, at / 10.0, 0.0]).expect("on the plot");
        view.input(&moved(point), common::now());
        for _ in 0..30 {
            step(&gpu, &mut view);
        }
        view.events().find_map(|e| match e {
            Event::Hovered { hit: Some(hit), .. } => hit.sample.map(|s| s.frame),
            _ => None,
        })
    };
    assert_eq!(hovered(3.0), Some(3));
    assert_eq!(hovered(7.0), Some(7), "the same row, at another sample");
}
