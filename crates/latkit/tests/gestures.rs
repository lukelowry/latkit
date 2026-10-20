//! Interaction events: a secondary click asks for a menu of what lies under it, as a touch held still
//! does; dragging from a port draws a connection to the vertex it is released over, an edge's end can
//! be dragged off it, a double click opens what it hits, a click again can cycle through the rows
//! under it, and Delete tells the selection. The keys point at rows too; hover is state whether or
//! not it glows and follows the frame; setters tell nothing. The wheel zooms as the controls say, and
//! reduced motion pays every move at once.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, camera, diagram, frame, gpu, plain_theme, step};
use latkit::{
    Button, Camera, Controls, Data, Device, Edges, End, Event, Ids, Input, Key, Modifiers, Motion, Patch, Row, Rows,
    Scene, Side, Table, Vertices, View, Zoom,
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
            .set(Table::new("Net", Ids::count(0)))
            .set(Table::new("Link", Ids::count(1)).reference("from", "Node", vec![1_u64]).reference(
                "to",
                "Node",
                vec![3_u64],
            )),
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
    view.select([Rows::new("graph", "Node", [2_u64, 3])]);
    let mut data = view.data("graph").expect("shown").clone();
    data.apply(Patch::new().remove("Node", vec![2_u64])).expect("valid");
    view.set_data(data);
    let selected = after(&gpu, &mut view, &[], |e| match e {
        Event::Select { rows, trigger } => Some((rows.clone(), *trigger)),
        _ => None,
    });
    let kept = vec![Rows::new("graph", "Node", [3_u64])];
    assert_eq!(selected, (kept.clone(), None), "the data's doing, no trigger");
    assert_eq!(view.selection(), kept);
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
    assert_eq!(rows, vec![Rows::new("graph", "Node", [2_u64])]);
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
    assert_eq!(toggled, (vec![Rows::new("graph", "Node", [2_u64])], true), "a click, not an empty box");
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
    assert_eq!(selected, vec![Rows::from(link)]);
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
    view.select([Rows::new("graph", "Node", [1_u64])]);
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

fn selected(e: &Event) -> Option<Vec<Rows>> {
    if let Event::Select { rows, .. } = e { Some(rows.clone()) } else { None }
}

#[test]
fn clicking_again_cycles_through_the_rows_under_the_point() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { cycle: true, ..Controls::default() });
    // Inside node 1, 6 units toward node 3, where the link leaves node 1's outline 2 units away.
    let s = 6.0 / std::f32::consts::SQRT_2;
    let at = [C - 40.0 + s, C - s];
    let (node, link) = (Row::new("graph", "Node", 1_u64), Row::new("graph", "Link", 0_u64));
    let click = [down(at, Button::Primary), up(at)];
    assert_eq!(after(&gpu, &mut view, &[&[moved(at)][..], &click].concat(), selected), vec![Rows::from(node.clone())]);
    // Slower than a double click, where nothing moved: the next row under the point, then back.
    common::wait(1.0);
    assert_eq!(after(&gpu, &mut view, &click, selected), vec![Rows::from(link)]);
    common::wait(1.0);
    assert_eq!(after(&gpu, &mut view, &click, selected), vec![Rows::from(node)]);
}

#[test]
fn a_touch_held_still_asks_for_a_menu_and_does_not_click() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls::default());
    let at = [C - 40.0, C];
    let touch = Input::Down {
        pointer: 1,
        point: at,
        button: Button::Primary,
        modifiers: Modifiers::default(),
        device: Device::Touch,
    };
    let (hits, device) = after(&gpu, &mut view, &[touch], |e| {
        if let Event::Menu { hits, trigger } = e { Some((hits.clone(), trigger.device)) } else { None }
    });
    assert_eq!(device, Device::Touch);
    assert_eq!(hits.first().map(|h| h.row.clone()), Some(Row::new("graph", "Node", 1_u64)));
    view.input(&up(at), common::now());
    for _ in 0..10 {
        step(&gpu, &mut view);
    }
    assert!(
        !view.events().any(|e| matches!(e, Event::Click { .. } | Event::Select { .. })),
        "the release only lets go"
    );
}

#[test]
fn the_wheel_zooms_as_the_controls_say() {
    let Some(gpu) = gpu() else { return };
    let wheel = |control| Input::Wheel {
        point: [C, C],
        delta: [0.0, -120.0],
        modifiers: Modifiers { control, ..Modifiers::default() },
    };
    let mut view = view(&gpu, Controls { zoom: Zoom::Modifier, ..Controls::default() });
    assert!(!view.input(&wheel(false), common::now()), "the plain wheel is the page's to scroll");
    assert!(view.input(&wheel(true), common::now()), "a trackpad's pinch, the wheel with Control, zooms");
    let mut view = view_off(&gpu);
    assert!(!view.input(&wheel(true), common::now()), "nothing zooms");
}

fn view_off(gpu: &latkit::Gpu) -> View {
    view(gpu, Controls { zoom: Zoom::Off, ..Controls::default() })
}

fn zoom(view: &View) -> f64 {
    let Camera::Map { zoom, .. } = *view.camera() else { panic!("a diagram's camera") };
    zoom
}

#[test]
fn reduced_motion_pays_every_move_at_once() {
    let Some(gpu) = gpu() else { return };
    let wheel = Input::Wheel { point: [C, C], delta: [0.0, -120.0], modifiers: Modifiers::default() };
    // With motion, a wheel notch glides over frames; without, it lands in one.
    let mut moving = view(&gpu, Controls { motion: Motion::Full, ..Controls::default() });
    let before = zoom(&moving);
    moving.input(&wheel, common::now());
    step(&gpu, &mut moving);
    let glided = zoom(&moving) - before;
    assert!(glided > 0.0 && glided < 0.29, "glides: {glided}");
    let mut still = view(&gpu, Controls { motion: Motion::Reduced, ..Controls::default() });
    still.input(&wheel, common::now());
    step(&gpu, &mut still);
    assert!((zoom(&still) - before - 0.3).abs() < 1e-6, "lands at once: {}", zoom(&still) - before);
    // The system's preference reduces it too, and a flight jumps.
    let mut system = view(&gpu, Controls::default());
    system.set_reduced_motion(true);
    let to = Camera::Map { center: [-10.0, 5.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 };
    system.fly(to);
    step(&gpu, &mut system);
    step(&gpu, &mut system);
    assert_eq!(*system.camera(), to);
    assert!(!system.needs_render(), "nothing moves on its own");
}
