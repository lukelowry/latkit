//! Interaction events: a secondary click asks for a menu of what lies under it, dragging from a port
//! draws a connection to the vertex it is released over, an edge's end can be dragged off it, and
//! Delete tells the selection.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, camera, frame, gpu, plain_theme, plane, step};
use latkit::{
    Button, Controls, Data, Edges, End, Event, Input, Key, Modifiers, Patch, Row, Scene, Side, Table, Vertices, View,
};

const C: f32 = SIZE as f32 / 2.0;

fn view(gpu: &latkit::Gpu) -> View {
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(
                Table::new("Node", vec![1_u64, 2, 3])
                    .field("x", vec![-40.0, 40.0, 0.0])
                    .field("y", vec![0.0, 0.0, 40.0])
                    .reference("net", "Net", vec![None::<u64>, None, None]),
            )
            .set(Table::new("Net", 0))
            .set(Table::new("Link", 1).reference("from", "Node", vec![1_u64]).reference("to", "Node", vec![3_u64])),
    )
    .expect("valid");
    let controls = Controls { connect: true, delete: true, ..Controls::default() };
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .controls(controls)
        .draw(Edges::of("graph", "Link").ends("from", "to").width(3.0))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(8.0).port("net", Side::Right));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    frame(gpu, &mut view);
    view
}

/// Feeds `inputs`, rendering a frame after each, then renders until `wanted` finds its event.
fn after<T>(gpu: &latkit::Gpu, view: &mut View, inputs: &[Input], wanted: impl Fn(&Event) -> Option<T>) -> T {
    for input in inputs {
        view.input(input);
        step(gpu, view);
        step(gpu, view);
    }
    let started = std::time::Instant::now();
    loop {
        if let Some(found) = view.events().find_map(|e| wanted(&e)) {
            return found;
        }
        assert!(started.elapsed() < common::SETTLE, "the event arrives within {:?}", common::SETTLE);
        step(gpu, view);
    }
}

fn down(point: [f32; 2], button: Button) -> Input {
    Input::Down { pointer: 1, point, button, modifiers: Modifiers::default(), touch: false }
}

fn moved(point: [f32; 2]) -> Input {
    Input::Move { pointer: 1, point, modifiers: Modifiers::default() }
}

fn up(point: [f32; 2]) -> Input {
    Input::Up { pointer: 1, point, modifiers: Modifiers::default() }
}

fn connected(e: &Event) -> Option<(End, Option<End>, Option<Row>)> {
    if let Event::Connect { from, to, edge, .. } = e { Some((from.clone(), to.clone(), edge.clone())) } else { None }
}

#[test]
fn secondary_clicks_ask_for_a_menu() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu);
    let at = [C - 40.0, C];
    let inputs = [moved(at), down(at, Button::Secondary), up(at)];
    let menu =
        |e: &Event| if let Event::Menu { hits, keyboard, .. } = e { Some((hits.clone(), *keyboard)) } else { None };
    let (hits, keyboard) = after(&gpu, &mut view, &inputs, menu);
    assert!(!keyboard);
    assert_eq!(hits.first().map(|h| h.row.clone()), Some(Row::new("graph", "Node", 1_u64)));
    let key = Input::Key { key: Key::Menu, down: true, modifiers: Modifiers::default() };
    let (_, keyboard) = after(&gpu, &mut view, &[key], menu);
    assert!(keyboard);
}

#[test]
fn dragging_from_a_port_connects() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu);
    // Node 1's port sits on its right side, 8 pixels from its middle.
    let port = [C - 32.0, C];
    let target = [C + 40.0, C];
    let inputs = [
        moved(port),
        down(port, Button::Primary),
        moved([C - 20.0, C]),
        moved([C + 20.0, C]),
        moved(target),
        up(target),
    ];
    let (from, to, edge) = after(&gpu, &mut view, &inputs, connected);
    assert_eq!(from, End { row: Row::new("graph", "Node", 1_u64), port: Some("net".into()) });
    assert_eq!(to.map(|t| t.row), Some(Row::new("graph", "Node", 2_u64)));
    assert_eq!(edge, None);
}

#[test]
fn dragging_an_edge_lets_go_of_its_nearer_end() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu);
    // The link runs from node 1 up to node 3; pressed nearer node 3, it lets go of that end.
    let near_three = [C - 10.0, C - 30.0];
    let target = [C + 40.0, C];
    let inputs = [
        moved(near_three),
        down(near_three, Button::Primary),
        moved([C, C - 20.0]),
        moved([C + 30.0, C - 5.0]),
        moved(target),
        up(target),
    ];
    let (from, to, edge) = after(&gpu, &mut view, &inputs, connected);
    assert_eq!(from.row, Row::new("graph", "Node", 1_u64), "the end that stays");
    assert_eq!(to.map(|t| t.row), Some(Row::new("graph", "Node", 2_u64)));
    assert_eq!(edge, Some(Row::new("graph", "Link", 0_u64)));
}

#[test]
fn delete_tells_the_selection() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu);
    let at = [C + 40.0, C];
    let key = Input::Key { key: Key::Delete, down: true, modifiers: Modifiers::default() };
    let inputs = [moved(at), down(at, Button::Primary), up(at), key];
    let rows = after(&gpu, &mut view, &inputs, |e| if let Event::Delete(rows) = e { Some(rows.clone()) } else { None });
    assert_eq!(rows, vec![Row::new("graph", "Node", 2_u64)]);
}
