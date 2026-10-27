//! Interaction events. A secondary click, or a touch held still, requests a menu of the rows under
//! it. Dragging from a port connects to the vertex it is released over, and dragging an edge
//! detaches its nearer end. A dragged row keeps its grab point under the pointer. A double click
//! opens the row it hits, clicking again cycles through the rows under the point, and Delete
//! reports the selection. Keys can step through rows too.
//!
//! Hover is reported whether or not it glows, and follows the frame. A lit row keeps its ports on
//! top. Setters emit no events. A scene's first frame requests every pipeline its input can use.
//! The wheel zooms as the controls say, and reduced motion applies every move at once. A flight
//! takes the seconds it is given. A flat map keeps the camera over its one world, and a frame
//! reports moving it there.

#![cfg(feature = "gpu")]

mod common;

use std::time::Duration;

use common::{SIZE, TICK, camera, diagram, frame, gpu, plain_theme, step};
use latkit::{
    Button, Camera, Controls, Data, Device, Edges, End, Event, Ids, Input, Key, Modifiers, Motion, Patch, Phase, Row,
    Rows, Scene, Side, Table, Vertices, View, Zoom, field,
};

const C: f32 = SIZE as f32 / 2.0;

/// Three nodes and a link from node 1 to node 3. Each node has an empty `net` reference for its
/// port.
fn graph() -> Data {
    let data = Data::new("graph");
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
    data
}

/// The graph in a diagram, with nodes 16 units across and a port on each node's right.
fn scene(controls: Controls) -> Scene {
    Scene::new(diagram())
        .theme(plain_theme())
        .controls(controls)
        .draw(Edges::of("graph", "Link").ends("from", "to").width(3.0))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(8.0).port("net", Side::Right))
}

fn view(gpu: &latkit::Gpu, controls: Controls) -> View {
    view_of(gpu, controls, &graph())
}

/// A view of `graph`, rendered until settled.
fn view_of(gpu: &latkit::Gpu, controls: Controls, graph: &Data) -> View {
    let mut view = View::new(gpu, scene(controls)).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([graph]).expect("a source");
    frame(gpu, &mut view);
    view
}

fn editing() -> Controls {
    Controls { connect: true, delete: true, ..Controls::default() }
}

/// Feeds `inputs`, rendering two frames after each, then renders until `wanted` matches an event.
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
fn secondary_clicks_request_a_menu() {
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
    // Node 1's port sits on its right side, 8 units from its center.
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
fn a_dragged_row_keeps_its_grab_point_under_the_pointer() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(Table::new("Node", vec![1_u64]).field("x", vec![-40.0]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(diagram())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(8.0).drag(true));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    // Grabbed 5 units right of its center, then moved 30 right and 20 down (y points down).
    let grab = [C - 35.0, C];
    let inputs = [moved(grab), down(grab, Button::Primary), moved([C - 25.0, C + 10.0]), moved([C - 5.0, C + 20.0])];
    let dragged =
        |e: &Event| if let Event::Drag { phase: Phase::Move, position, .. } = e { Some(*position) } else { None };
    let position = after(&gpu, &mut view, &inputs, dragged);
    let off = (position[0] + 10.0).hypot(position[1] - 20.0);
    assert!(off < 0.5, "the grab point stays under the pointer: {position:?}");
}

#[test]
fn a_lit_block_keeps_its_ports_on_top() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls::default());
    // Node 1's port is hollow, centered on its right edge 8 units from its center. One unit inside
    // the block, the pixel within the port stays the same, lit or not.
    let port = |pixels: &[[u8; 4]]| common::at(pixels, C as u32 - 33, C as u32);
    let before = port(&step(&gpu, &mut view));
    view.input(&moved([C - 40.0, C]), common::now());
    let mut pixels = Vec::new();
    for _ in 0..30 {
        pixels = step(&gpu, &mut view);
    }
    assert_eq!(view.hovered().map(|hit| hit.row.clone()), Some(Row::new("graph", "Node", 1_u64)), "node 1 is lit");
    assert!(common::close(port(&pixels), before), "the port is unchanged: lit {:?}, unlit {before:?}", port(&pixels));
}

#[test]
fn the_first_frame_requests_every_pipeline_the_scene_can_use() {
    let Some(gpu) = gpu() else { return };
    // The first frame requests every pipeline the scene can use. A menu, a connection, a selection,
    // the keys, and a later transition then need no pipeline requested late.
    let scene = scene(editing()).ease(std::time::Duration::from_millis(200));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([graph()]).expect("a source");
    frame(&gpu, &mut view);
    let at = [C - 40.0, C];
    let menu = |e: &Event| matches!(e, Event::Menu { .. }).then_some(());
    after(&gpu, &mut view, &[moved(at), down(at, Button::Secondary), up(at)], menu);
    let (port, target) = ([C - 32.0, C], [C + 40.0, C]);
    after(
        &gpu,
        &mut view,
        &[moved(port), down(port, Button::Primary), moved([C, C]), moved(target), up(target)],
        connected,
    );
    let selected = |e: &Event| matches!(e, Event::Selection { .. }).then_some(());
    after(&gpu, &mut view, &[moved(at), down(at, Button::Primary), up(at)], selected);
    after(&gpu, &mut view, &[key(Key::Menu)], menu);
    let moved_graph = graph();
    moved_graph
        .apply(Patch::new().set(Table::new("Node", vec![1_u64, 2, 3]).field("x", vec![-20.0, 20.0, 0.0])))
        .expect("valid");
    view.set_sources([&moved_graph]).expect("a source");
    frame(&gpu, &mut view);
    assert_eq!(gpu.work().late, 0, "every pipeline was requested at the first frame");
}

#[test]
fn dragging_an_edge_detaches_its_nearer_end() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    // The link runs from node 1 up to node 3. Pressed nearer node 3, it detaches that end.
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
fn a_double_click_before_any_probe_answer_still_opens() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    // Both clicks arrive before any frame reports the rows under them.
    let at = [C + 40.0, C];
    for input in [down(at, Button::Primary), up(at), down(at, Button::Primary), up(at)] {
        view.input(&input, common::now());
    }
    let opened =
        after(&gpu, &mut view, &[], |e| if let Event::Open { hit, .. } = e { Some(hit.row.clone()) } else { None });
    assert_eq!(opened, Row::new("graph", "Node", 2_u64));
}

#[test]
fn the_selection_drops_rows_removed_from_the_data() {
    let Some(gpu) = gpu() else { return };
    let data = graph();
    let mut view = view_of(&gpu, editing(), &data);
    view.set_selection([Rows::new("graph", "Node", [2_u64, 3])]);
    data.apply(Patch::new().remove("Node", vec![2_u64])).expect("valid");
    let selected = after(&gpu, &mut view, &[], |e| match e {
        Event::Selection { rows, trigger } => Some((rows.clone(), *trigger)),
        _ => None,
    });
    let kept = vec![Rows::new("graph", "Node", [3_u64])];
    assert_eq!(selected, (kept.clone(), None), "a data change has no trigger");
    assert_eq!(view.selection(), kept);
}

#[test]
fn delete_reports_the_selection() {
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
fn a_shift_click_toggles_when_box_select_is_on() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { select_box: true, ..Controls::default() });
    let (at, shift) = ([C + 40.0, C], Modifiers { shift: true, ..Modifiers::default() });
    let press = Input::Down { pointer: 1, point: at, button: Button::Primary, modifiers: shift, device: Device::Mouse };
    let release = Input::Up { pointer: 1, point: at, modifiers: shift };
    let toggled = after(&gpu, &mut view, &[moved(at), press, release], |e| match e {
        Event::Selection { rows, trigger: Some(trigger) } => Some((rows.clone(), trigger.modifiers.shift)),
        _ => None,
    });
    assert_eq!(toggled, (vec![Rows::new("graph", "Node", [2_u64])], true), "a click, not an empty box");
}

#[test]
fn the_keys_step_open_and_select() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let link = Row::new("graph", "Link", 0_u64);
    // Tab waits for the rows nearest the center, then hovers the nearest one: the link.
    let hovered = after(&gpu, &mut view, &[key(Key::Tab)], |e| match e {
        Event::Hovered { hit: Some(hit), trigger } => Some((hit.row.clone(), trigger.device)),
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
        Event::Selection { rows, .. } => Some(rows.clone()),
        _ => None,
    });
    assert_eq!(selected, vec![Rows::from(link)]);
    // Shift+Tab past the first row goes unused, so focus leaves the view and the hover clears.
    let back = Input::Key { key: Key::Tab, down: true, modifiers: Modifiers { shift: true, ..Modifiers::default() } };
    assert!(!view.input(&back, common::now()), "focus leaves the view");
    let left =
        after(&gpu, &mut view, &[], |e| if let Event::Hovered { hit, .. } = e { Some(hit.clone()) } else { None });
    assert_eq!(left, None);
}

#[test]
fn hover_is_reported_without_glow_and_follows_the_frame() {
    let Some(gpu) = gpu() else { return };
    let data = graph();
    let mut view = view_of(&gpu, Controls { hover: false, ..Controls::default() }, &data);
    let at = [C + 40.0, C];
    let hovered = after(&gpu, &mut view, &[moved(at)], |e| match e {
        Event::Hovered { hit: Some(hit), trigger } => Some((hit.row.clone(), trigger.device)),
        _ => None,
    });
    assert_eq!(hovered, (Row::new("graph", "Node", 2_u64), Device::Mouse));
    // The node moves out from under the still pointer, and the hover follows.
    data.apply(Patch::new().set(Table::new("Node", vec![2_u64]).field("x", vec![200.0]))).expect("valid");
    let left =
        after(&gpu, &mut view, &[], |e| if let Event::Hovered { hit, .. } = e { Some(hit.clone()) } else { None });
    assert_eq!(left, None);
}

#[test]
fn setters_emit_no_events_but_a_flight_reports_the_camera() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let set = Camera::Map { center: [10.0, 0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 };
    view.set_camera(set);
    view.set_selection([Rows::new("graph", "Node", [1_u64])]);
    frame(&gpu, &mut view);
    let told: Vec<Event> = view.events().filter(|e| matches!(e, Event::Camera(_) | Event::Selection { .. })).collect();
    assert_eq!(told, Vec::new(), "setters emit no events");
    view.fly(Camera::Map { center: [-10.0, 0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 }, None);
    let flown = after(&gpu, &mut view, &[], |e| if let Event::Camera(camera) = e { Some(*camera) } else { None });
    assert_ne!(flown, set, "a flight reports where it moved");
}

#[test]
fn a_flight_takes_the_seconds_it_is_given() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let Camera::Map { center, zoom, pitch, bearing } = *view.camera() else { unreachable!("a plane's camera") };
    let x = |view: &View| if let Camera::Map { center, .. } = view.camera() { center[0] } else { f64::NAN };
    let to = Camera::Map { center: [center[0] + 1.0, center[1], center[2]], zoom, pitch, bearing };
    view.fly(to, Some(Duration::from_secs(2)));
    // One second of frames in, halfway through the two seconds, smoothstep puts the camera halfway.
    let second = (1.0 / TICK).round() as usize;
    for _ in 0..second {
        step(&gpu, &mut view);
    }
    assert!((x(&view) - (center[0] + 0.5)).abs() < 1e-9, "halfway: {}", x(&view));
    for _ in 0..second {
        step(&gpu, &mut view);
    }
    assert_eq!(*view.camera(), to, "arrives on time");
}

#[test]
fn waiting_reports_when_the_frame_is_complete() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, editing());
    let waiting = after(&gpu, &mut view, &[], |e| if let Event::Waiting(waiting) = e { Some(*waiting) } else { None });
    assert!(waiting.is_empty() && view.complete(), "the latest waiting event reports a complete frame: {waiting}");
}

fn selected(e: &Event) -> Option<Vec<Rows>> {
    if let Event::Selection { rows, .. } = e { Some(rows.clone()) } else { None }
}

#[test]
fn clicking_again_cycles_through_the_rows_under_the_point() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { cycle: true, ..Controls::default() });
    // Inside node 1, 6 units toward node 3: 2 units short of where the link leaves its outline.
    let s = 6.0 / std::f32::consts::SQRT_2;
    let at = [C - 40.0 + s, C - s];
    let (node, link) = (Row::new("graph", "Node", 1_u64), Row::new("graph", "Link", 0_u64));
    let click = [down(at, Button::Primary), up(at)];
    assert_eq!(after(&gpu, &mut view, &[&[moved(at)][..], &click].concat(), selected), vec![Rows::from(node.clone())]);
    // Clicks slower than a double click, without moving, select the next row under the point, then
    // wrap back.
    common::wait(1.0);
    assert_eq!(after(&gpu, &mut view, &click, selected), vec![Rows::from(link)]);
    common::wait(1.0);
    assert_eq!(after(&gpu, &mut view, &click, selected), vec![Rows::from(node)]);
}

#[test]
fn a_touch_held_still_requests_a_menu_and_does_not_click() {
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
        !view.events().any(|e| matches!(e, Event::Click { .. } | Event::Selection { .. })),
        "the release neither clicks nor selects"
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
    assert!(!view.input(&wheel(false), common::now()), "the plain wheel is left to scroll the page");
    assert!(view.input(&wheel(true), common::now()), "Control+wheel (a trackpad pinch) zooms");
    let mut view = view_off(&gpu);
    assert!(!view.input(&wheel(true), common::now()), "nothing zooms");
}

#[test]
fn zooming_at_the_zoom_limit_moves_nothing() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { motion: Motion::Reduced, ..Controls::default() });
    view.fit(latkit::Fit::All);
    frame(&gpu, &mut view);
    let Camera::Map { zoom: framed, .. } = *view.camera() else { panic!("a diagram's camera") };
    // Just short of the deepest zoom the framed content allows, the wheel zooms toward a corner.
    let near = Camera::Map { center: [5.0, -3.0, 0.0], zoom: framed + 7.95, pitch: 0.0, bearing: 0.0 };
    view.set_camera(near);
    let wheel = Input::Wheel { point: [C + 30.0, C - 20.0], delta: [0.0, -400.0], modifiers: Modifiers::default() };
    view.input(&wheel, common::now());
    step(&gpu, &mut view);
    let at_limit = *view.camera();
    assert!((zoom(&view) - (framed + 8.0)).abs() < 1e-9, "the zoom stops at its limit: {}", zoom(&view));
    for _ in 0..3 {
        view.input(&wheel, common::now());
        step(&gpu, &mut view);
        assert_eq!(*view.camera(), at_limit, "past the limit neither the zoom nor the center moves");
    }
}

fn view_off(gpu: &latkit::Gpu) -> View {
    view(gpu, Controls { zoom: Zoom::Off, ..Controls::default() })
}

fn zoom(view: &View) -> f64 {
    let Camera::Map { zoom, .. } = *view.camera() else { panic!("a diagram's camera") };
    zoom
}

#[test]
fn reduced_motion_applies_every_move_at_once() {
    let Some(gpu) = gpu() else { return };
    let wheel = Input::Wheel { point: [C, C], delta: [0.0, -120.0], modifiers: Modifiers::default() };
    // With motion, a wheel notch glides over several frames. Without, it applies in one.
    let mut moving = view(&gpu, Controls { motion: Motion::Full, ..Controls::default() });
    let before = zoom(&moving);
    moving.input(&wheel, common::now());
    step(&gpu, &mut moving);
    let glided = zoom(&moving) - before;
    assert!(glided > 0.0 && glided < 0.29, "glides: {glided}");
    let mut still = view(&gpu, Controls { motion: Motion::Reduced, ..Controls::default() });
    still.input(&wheel, common::now());
    step(&gpu, &mut still);
    assert!((zoom(&still) - before - 0.3).abs() < 1e-6, "applies at once: {}", zoom(&still) - before);
    // The system preference reduces motion too, and a flight jumps to its end.
    let mut system = view(&gpu, Controls::default());
    system.set_reduced_motion(true);
    let to = Camera::Map { center: [-10.0, 5.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 };
    system.fly(to, None);
    step(&gpu, &mut system);
    step(&gpu, &mut system);
    assert_eq!(*system.camera(), to);
    assert!(!system.needs_render(), "nothing moves on its own");
}

#[test]
fn a_flat_map_keeps_the_camera_over_its_one_world() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, Scene::new(latkit::Earth::default()).theme(plain_theme())).expect("valid scene");
    // Set before the first frame gives the view its size, the camera moves within its limits on
    // that frame, which reports it. At zoom 4 the world is 4096 pixels across, and the center keeps
    // half the view's width from the antimeridian.
    view.set_camera(Camera::Map { center: [180.0, 0.0, 0.0], zoom: 4.0, pitch: 0.0, bearing: 0.0 });
    frame(&gpu, &mut view);
    let Camera::Map { center, .. } = *view.camera() else { panic!("a map camera") };
    assert!((center[0] - 180.0 * (1.0 - f64::from(SIZE) / 4096.0)).abs() < 1e-9, "{center:?}");
    assert!(view.events().any(|e| matches!(e, Event::Camera(_))), "the frame reports the move");
    // Once the view has its size, a camera set past its limits is kept within them at once. Zoomed
    // all the way out, the whole world just fits the view, centered.
    view.set_camera(Camera::Map { center: [90.0, 60.0, 0.0], zoom: -3.0, pitch: 0.0, bearing: 0.0 });
    let Camera::Map { center, zoom, .. } = *view.camera() else { panic!("a map camera") };
    assert!((zoom + 1.0).abs() < 1e-9 && center[0].abs() < 1e-9 && center[1].abs() < 1e-9, "{center:?} {zoom}");
}
