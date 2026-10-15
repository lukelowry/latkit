//! Queries answer through what the frame drew: every row within reach of a point, nearest first; the
//! rows in a box a Shift drag draws; where a row lies; and the sample a traced line passes through.

#![cfg(feature = "gpu")]

mod common;

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use common::{SIZE, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{
    Axis, Button, Camera, Controls, Data, Edges, Event, Input, Lines, Modifiers, Patch, Plot, Scene, Table, Vertices,
    View,
};

/// Renders frames until `pending` resolves, within the settle deadline.
fn answer<T>(gpu: &latkit::Gpu, view: &mut View, pending: impl Future<Output = latkit::Result<T>>) -> T {
    let mut pending = pin!(pending);
    let mut context = Context::from_waker(Waker::noop());
    for _ in 0..common::SETTLE {
        if let Poll::Ready(value) = pending.as_mut().poll(&mut context) {
            return value.expect("an answer");
        }
        step(gpu, view);
    }
    panic!("the query answers within {} frames", common::SETTLE);
}

fn graph() -> Data {
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(
                Table::new("Node", vec![1_u64, 2, 3])
                    .field("x", vec![0.0, 10.0, -40.0])
                    .field("y", vec![0.0, 0.0, 30.0]),
            )
            .set(Table::new("Link", 1).reference("from", "Node", vec![1_u64]).reference("to", "Node", vec![3_u64])),
    )
    .expect("valid");
    data
}

fn view(gpu: &latkit::Gpu, controls: Controls) -> View {
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .controls(controls)
        .draw(Edges::of("graph", "Link").ends("from", "to").width(3.0))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(graph());
    frame(gpu, &mut view);
    view
}

#[test]
fn picks_list_every_row_in_reach_nearest_first() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls::default());
    let c = SIZE as f32 / 2.0;
    let pending = view.pick([c + 3.0, c], 12.0);
    let hits = answer(&gpu, &mut view, pending);
    let ids: Vec<String> = hits.iter().map(|h| format!("{}{}", h.row.table, h.row.id)).collect();
    assert_eq!(ids.first().map(String::as_str), Some("Node1"), "{ids:?}");
    assert!(ids.contains(&"Node2".to_owned()) && ids.contains(&"Link0".to_owned()), "{ids:?}");
    assert!(!ids.contains(&"Node3".to_owned()), "out of reach: {ids:?}");
    assert!(hits.windows(2).all(|w| w[0].distance <= w[1].distance), "nearest first");
    assert!((hits[0].position[0]).abs() < 1.0, "where it lies: {:?}", hits[0].position);
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn locate_finds_a_row_on_screen() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls::default());
    let pending = view.locate(&latkit::Row::new("graph", "Node", 3_u64));
    let point = answer(&gpu, &mut view, pending).expect("in view");
    let c = SIZE as f32 / 2.0;
    assert!((point[0] - (c - 40.0)).abs() < 0.5 && (point[1] - (c - 30.0)).abs() < 0.5, "{point:?}");
    let pending = view.locate(&latkit::Row::new("graph", "Node", 99_u64));
    assert_eq!(answer(&gpu, &mut view, pending), None, "no such row");
}

#[test]
fn a_shift_drag_selects_the_rows_in_its_box() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { select_box: true, ..Controls::default() });
    let c = SIZE as f32 / 2.0;
    let shift = Modifiers { shift: true, ..Modifiers::default() };
    view.input(
        &Input::Down { pointer: 1, point: [c - 5.0, c - 5.0], button: Button::Primary, modifiers: shift, touch: false },
        common::now(),
    );
    view.input(&Input::Move { pointer: 1, point: [c + 15.0, c + 5.0], modifiers: shift }, common::now());
    view.input(&Input::Up { pointer: 1, point: [c + 15.0, c + 5.0], modifiers: shift }, common::now());
    frame(&gpu, &mut view);
    let selected: Vec<Vec<latkit::Row>> =
        view.events().filter_map(|e| if let Event::Select(rows) = e { Some(rows) } else { None }).collect();
    let rows = selected.last().expect("a selection");
    let mut ids: Vec<String> = rows.iter().map(|r| format!("{}{}", r.table, r.id)).collect();
    ids.sort();
    assert_eq!(ids, ["Link0", "Node1", "Node2"]);
    assert_eq!(view.camera(), &camera(), "the box does not turn or pan");
}

#[test]
fn hovering_a_trace_names_its_sample() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Table::new("Signal", 1)).expect("valid");
    for t in 0..=10 {
        data.apply(Patch::new().append(f64::from(t), "Signal", [("v", vec![f64::from(t) / 10.0])])).expect("frame");
    }
    let axis = Axis { hidden: true, grid: false, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").width(3.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_data(data);
    frame(&gpu, &mut view);
    let at = view.point([7.0, 0.7, 0.0]).expect("on the plot");
    let pending = view.pick(at, 6.0);
    let hits = answer(&gpu, &mut view, pending);
    let sample = hits.first().and_then(|h| h.sample).expect("a sample");
    assert_eq!(sample.frame, 7);
    assert!((sample.at - 7.0).abs() < 1e-9 && (sample.value - 0.7).abs() < 1e-6, "{sample:?}");
}
