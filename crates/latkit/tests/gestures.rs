//! Interaction events: a secondary click asks for a menu of what lies under it, dragging from a port
//! draws a connection to the vertex it is released over, an edge's end can be dragged off it, a
//! double click opens what it hits, and Delete tells the selection. The keys point at rows too;
//! hover is state whether or not it glows and follows the frame; setters tell nothing.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, camera, diagram, frame, gpu, plain_theme, step};
use latkit::{
    Button, Camera, Controls, Data, Device, Edges, End, Event, Input, Key, Modifiers, Patch, Row, Scene, Side, Table,
    Vertices, View,
};

const C: f32 = SIZE as f32 / 2.0;

/// Three nodes, a link from node 1 to node 3, and a port on each node's right, in a diagram.
fn view(gpu: &latkit::Gpu, controls: Controls) -> View {
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(
                Table::new("Node", vec![1_u64, 2, 3])
                    .field("x", vec![-40.0, 40.0, 0.0])
                    .field("y", vec![0.0, 0.0, -40.0])
                    .reference("net", "Net", vec![None::<u64>, None, None]),
            )
            .set(Table::new("Net", 0))
            .set(Table::new("Link", 1).reference("from", "Node", vec![1_u64]).reference("to", "Node", vec![3_u64])),
    )
    .expect("valid");
    let scene = Scene::new(diagram())
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

fn editing() -> Controls {
    Controls { connect: true, delete: true, ..Controls::default() }
}

/// Feeds `inputs`, rendering a frame after each, then renders until `wanted` finds its event.
fn after<T>(gpu: &latkit::Gpu, view: &mut View, inputs: &[Input], wanted: impl Fn(&Event) -> Option<T>) -> T {
    for input in inputs {
        view.input(input, common::now());
        step(gpu, view);
        step(gpu, view);
    }
    for _ in 0..common::SETTLE {
        if let Some(found) = view.events().find_map(|e| wanted(&e)) {
            return found;
        }
        step(gpu, view);
    }
    panic!("the event arrives within {} frames", common::SETTLE);
}

fn down(point: [f32; 2], button: Button) -> Input {
    Input::Down { pointer: 1, point, button, modifiers: Modifiers::default(), device: Device::Mouse }
}

fn moved(point: [f32; 2]) -> Input {
    Input::Move { pointer: 1, point, modifiers: Modifiers::default(), device: Device::Mouse }
}

fn up(point: [f32; 2]) -> Input {
    Input::Up { pointer: 1, point, modifiers: Modifiers::default() }
}

fn key(key: Key) -> Input {
    Input::Key { key, down: true, modifiers: Modifiers::default() }
}

fn connected(e: &Event) -> Option<(End, Option<End>, Option<Row>)> {
    if let Event::Connect { from, to, edge, .. } = e { Some((from.clone(), to.clone(), edge.clone())) } else { None }
}

#[test]
fn secondary_clicks_ask_for_a_menu() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let at = [C - 40.0, C];
    let inputs = [moved(at), down(at, Button::Secondary), up(at)];
    let menu = |e: &Event| {
        if let Event::Menu { hits, trigger } = e { Some((hits.clone(), trigger.device)) } else { None }
    };
    let (hits, device) = after(&gpu, &mut view, &inputs, menu);
    assert_eq!(device, Device::Mouse);
    assert_eq!(hits.first().map(|h| h.row.clone()), Some(Row::new("graph", "Node", 1_u64)));
    let (_, device) = after(&gpu, &mut view, &[key(Key::Menu)], menu);
    assert_eq!(device, Device::Keyboard);
}

#[test]
fn dragging_from_a_port_connects() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    // Node 1's port sits on its right side, 8 units from its middle.
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
    let mut view = view(&gpu, editing());
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
fn a_double_click_faster_than_its_probe_opens() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    // Both clicks land before any frame answers what lies under them.
    let at = [C + 40.0, C];
    for input in [down(at, Button::Primary), up(at), down(at, Button::Primary), up(at)] {
        view.input(&input, common::now());
    }
    let opened =
        after(&gpu, &mut view, &[], |e| if let Event::Open { hit, .. } = e { Some(hit.row.clone()) } else { None });
    assert_eq!(opened, Row::new("graph", "Node", 2_u64));
}

#[test]
fn the_selection_lets_go_of_rows_the_data_drops() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    view.select([Row::new("graph", "Node", 2_u64), Row::new("graph", "Node", 3_u64)]);
    let mut data = view.data("graph").expect("shown").clone();
    data.apply(Patch::new().remove("Node", vec![2_u64])).expect("valid");
    view.set_data(data);
    let selected = after(&gpu, &mut view, &[], |e| match e {
        Event::Select { rows, trigger } => Some((rows.clone(), *trigger)),
        _ => None,
    });
    assert_eq!(selected, (vec![Row::new("graph", "Node", 3_u64)], None), "the data's doing, no trigger");
    assert_eq!(view.selection(), &[Row::new("graph", "Node", 3_u64)]);
}

#[test]
fn delete_tells_the_selection() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let at = [C + 40.0, C];
    let inputs = [moved(at), down(at, Button::Primary), up(at), key(Key::Delete)];
    let (rows, device) = after(&gpu, &mut view, &inputs, |e| {
        if let Event::Delete { rows, trigger } = e { Some((rows.clone(), trigger.device)) } else { None }
    });
    assert_eq!(rows, vec![Row::new("graph", "Node", 2_u64)]);
    assert_eq!(device, Device::Keyboard);
}

#[test]
fn a_shift_click_toggles_where_boxes_select() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { select_box: true, ..Controls::default() });
    let (at, shift) = ([C + 40.0, C], Modifiers { shift: true, ..Modifiers::default() });
    let press = Input::Down { pointer: 1, point: at, button: Button::Primary, modifiers: shift, device: Device::Mouse };
    let release = Input::Up { pointer: 1, point: at, modifiers: shift };
    let toggled = after(&gpu, &mut view, &[moved(at), press, release], |e| match e {
        Event::Select { rows, trigger: Some(trigger) } => Some((rows.clone(), trigger.modifiers.shift)),
        _ => None,
    });
    assert_eq!(toggled, (vec![Row::new("graph", "Node", 2_u64)], true), "a click, not an empty box");
}

#[test]
fn the_keys_step_open_and_select() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let link = Row::new("graph", "Link", 0_u64);
    // Tab waits for the rows nearest the middle, then points at the nearest: the link.
    let hovered = after(&gpu, &mut view, &[key(Key::Tab)], |e| match e {
        Event::Hover { hit: Some(hit), trigger } => Some((hit.row.clone(), trigger.device)),
        _ => None,
    });
    assert_eq!(hovered, (link.clone(), Device::Keyboard));
    assert_eq!(view.hovered().map(|hit| &hit.row), Some(&link));
    let opened = after(&gpu, &mut view, &[key(Key::Enter)], |e| match e {
        Event::Open { hit, trigger } => Some((hit.row.clone(), trigger.device)),
        _ => None,
    });
    assert_eq!(opened, (link.clone(), Device::Keyboard));
    let selected = after(&gpu, &mut view, &[key(Key::Space)], |e| match e {
        Event::Select { rows, .. } => Some(rows.clone()),
        _ => None,
    });
    assert_eq!(selected, vec![link]);
    // Before the first row, Shift+Tab is not used, so focus moves on, and nothing stays pointed at.
    let back = Input::Key { key: Key::Tab, down: true, modifiers: Modifiers { shift: true, ..Modifiers::default() } };
    assert!(!view.input(&back, common::now()), "focus moves on");
    let left = after(&gpu, &mut view, &[], |e| if let Event::Hover { hit, .. } = e { Some(hit.clone()) } else { None });
    assert_eq!(left, None);
}

#[test]
fn hover_is_told_without_its_glow_and_follows_the_frame() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { hover: false, ..Controls::default() });
    let at = [C + 40.0, C];
    let hovered = after(&gpu, &mut view, &[moved(at)], |e| match e {
        Event::Hover { hit: Some(hit), trigger } => Some((hit.row.clone(), trigger.device)),
        _ => None,
    });
    assert_eq!(hovered, (Row::new("graph", "Node", 2_u64), Device::Mouse));
    // The node moves out from under the still pointer: the hover follows.
    let mut data = view.data("graph").expect("shown").clone();
    data.apply(Patch::new().set(Table::new("Node", vec![2_u64]).field("x", vec![200.0]))).expect("valid");
    view.set_data(data);
    let left = after(&gpu, &mut view, &[], |e| if let Event::Hover { hit, .. } = e { Some(hit.clone()) } else { None });
    assert_eq!(left, None);
}

#[test]
fn setters_tell_nothing_while_motion_tells_the_camera() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let set = Camera::Map { center: [10.0, 0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 };
    view.set_camera(set);
    view.select([Row::new("graph", "Node", 1_u64)]);
    frame(&gpu, &mut view);
    let told: Vec<Event> = view.events().filter(|e| matches!(e, Event::Camera(_) | Event::Select { .. })).collect();
    assert_eq!(told, Vec::new(), "setters tell nothing");
    view.fly(Camera::Map { center: [-10.0, 0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
    let flown = after(&gpu, &mut view, &[], |e| if let Event::Camera(camera) = e { Some(*camera) } else { None });
    assert_ne!(flown, set, "a flight tells where it moved");
}

#[test]
fn waiting_tells_when_the_frame_is_complete() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let waiting = after(&gpu, &mut view, &[], |e| if let Event::Waiting(waiting) = e { Some(*waiting) } else { None });
    assert!(waiting.is_empty() && view.complete(), "the last change told is the complete frame: {waiting}");
}
