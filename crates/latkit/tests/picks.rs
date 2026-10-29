//! Queries answered from what the frame drew: every row near a point, nearest first, the rows in a
//! Shift-drag box, a row's screen position, and the sample a traced line passes through.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, answer, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{
    Axis, Button, Camera, Controls, Data, Device, Edges, Event, Faces, Ids, Input, Lines, Modifiers, Patch, Plot,
    Scene, Table, Vertices, View, field,
};

fn graph() -> Data {
    let data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(
                Table::new("Node", vec![1_u64, 2, 3])
                    .field("x", vec![0.0, 10.0, -40.0])
                    .field("y", vec![0.0, 0.0, 30.0]),
            )
            .set(Table::new("Link", Ids::count(1)).reference("from", "Node", vec![1_u64]).reference(
                "to",
                "Node",
                vec![3_u64],
            )),
    )
    .expect("valid");
    data
}

fn view(gpu: &latkit::Gpu, controls: Controls) -> View {
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .controls(controls)
        .draw(Edges::of("graph", "Link").ends("from", "to").width(3.0))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(4.0));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([graph()]).expect("a source");
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
fn a_hit_reports_the_row_and_position_from_its_frame() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls::default());
    let c = SIZE as f32 / 2.0;
    let pending = view.pick([c, c], 6.0);
    // The answering frame draws node 1 at the center. Before its answer arrives, the nodes are
    // reordered and the camera moves away.
    step(&gpu, &mut view);
    let data = graph();
    let reordered =
        Table::new("Node", vec![3_u64, 2, 1]).field("x", vec![-40.0, 10.0, 0.0]).field("y", vec![30.0, 0.0, 0.0]);
    data.apply(Patch::new().replace(reordered)).expect("valid");
    view.set_sources([&data]).expect("a source");
    view.set_camera(Camera::Map { center: [500.0, 0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
    let hits = answer(&gpu, &mut view, pending);
    let first = hits.first().expect("a hit");
    assert_eq!(first.row, latkit::Row::new("graph", "Node", 1_u64), "{hits:?}");
    assert!(first.position[0].abs() < 1.0, "where its frame drew it: {:?}", first.position);
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn every_hit_of_geodesic_edges_lies_in_reach() {
    let Some(gpu) = gpu() else { return };
    // A lattice on the globe. Geodesic edges draw through a segment list, which holds fewer
    // segments than the query's list is sized for.
    let side = 24_usize;
    let (mut lon, mut lat, mut from, mut to) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for i in 0..side * side {
        lon.push(-170.0 + 340.0 * (i % side) as f64 / (side - 1) as f64);
        lat.push(-75.0 + 150.0 * (i / side) as f64 / (side - 1) as f64);
        if i % side < side - 1 {
            from.push(i as u64);
            to.push(i as u64 + 1);
        }
        if i + side < side * side {
            from.push(i as u64);
            to.push((i + side) as u64);
        }
    }
    let data = Data::new("grid");
    let lines = from.len();
    data.apply(
        Patch::new().set(Table::new("Bus", Ids::count((side * side) as u32)).field("lon", lon).field("lat", lat)).set(
            Table::new("Line", Ids::count(lines as u32)).reference("from", "Bus", from).reference("to", "Bus", to),
        ),
    )
    .expect("valid");
    let earth = latkit::Earth { graticule: false, ..latkit::Earth::default().projection(latkit::Projection::Globe) };
    let scene = Scene::new(earth)
        .theme(plain_theme())
        .draw(Edges::of("grid", "Line").ends("from", "to"))
        .draw(Vertices::of("grid", "Bus").position(field("lon"), field("lat")));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_sources([&data]).expect("a source");
    view.fit(latkit::Fit::All);
    frame(&gpu, &mut view);
    let c = SIZE as f32 / 2.0;
    // A wide pick leaves its counts in the lists buffer. A later narrow pick must not add to them.
    for radius in [40.0, 4.0] {
        let pending = view.pick([c, c], radius);
        let hits = answer(&gpu, &mut view, pending);
        assert!(!hits.is_empty(), "the middle of the lattice is in reach");
        for hit in &hits {
            // A vertex is within the radius at its outline, but its point is its center, a marker
            // radius further.
            let reach = (hit.point[0] - c).hypot(hit.point[1] - c);
            let what = format!("{} {} at {:?}, {reach} away", hit.row.table, hit.row.id, hit.point);
            assert!(hit.distance <= radius && reach <= radius + 8.0, "{what}");
        }
    }
}

#[test]
fn locate_finds_a_row_on_screen() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls::default());
    let pending = view.screen_of(&latkit::Row::new("graph", "Node", 3_u64), None);
    let point = answer(&gpu, &mut view, pending).expect("in view");
    let c = SIZE as f32 / 2.0;
    assert!((point[0] - (c - 40.0)).abs() < 0.5 && (point[1] - (c - 30.0)).abs() < 0.5, "{point:?}");
    let pending = view.screen_of(&latkit::Row::new("graph", "Node", 99_u64), None);
    assert_eq!(answer(&gpu, &mut view, pending), None, "no such row");
}

#[test]
fn hidden_rows_have_no_screen_position() {
    let Some(gpu) = gpu() else { return };
    let data = graph();
    let links = Table::new("Link", vec![0_u64, 1])
        .reference("from", "Node", vec![1_u64, 1])
        .reference("to", "Node", vec![3_u64, 2])
        .field("on", vec![false, true]);
    let faces = Table::new("Face", vec![0_u64, 1])
        .reference("a", "Node", vec![1_u64, 1])
        .reference("b", "Node", vec![2_u64, 2])
        .reference("c", "Node", vec![3_u64, 3])
        .field("on", vec![false, true]);
    data.apply(Patch::new().replace(links).set(faces)).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Faces::of("graph", "Face").corners("a", "b", "c").visible(field("on")))
        .draw(Edges::of("graph", "Link").ends("from", "to").width(3.0).visible(field("on")))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    let mut screen_of = |table: &str, id: u64| {
        let pending = view.screen_of(&latkit::Row::new("graph", table, id), None);
        answer(&gpu, &mut view, pending)
    };
    let c = SIZE as f32 / 2.0;
    let link = screen_of("Link", 1).expect("a shown edge");
    assert!((link[0] - (c + 5.0)).abs() < 1.0 && (link[1] - c).abs() < 1.0, "the edge's middle: {link:?}");
    assert_eq!(screen_of("Link", 0), None, "a hidden edge");
    let face = screen_of("Face", 1).expect("a shown face");
    assert!((face[0] - (c - 10.0)).abs() < 1.0 && (face[1] - (c - 10.0)).abs() < 1.0, "the centroid: {face:?}");
    assert_eq!(screen_of("Face", 0), None, "a hidden face");
}

#[test]
fn a_shift_drag_selects_the_rows_in_its_box() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, Controls { select_box: true, ..Controls::default() });
    let c = SIZE as f32 / 2.0;
    let (shift, device) = (Modifiers { shift: true, ..Modifiers::default() }, Device::Mouse);
    let down = Input::Down { pointer: 1, point: [c - 5.0, c - 5.0], button: Button::Primary, modifiers: shift, device };
    view.input(&down, common::now());
    view.input(&Input::Move { pointer: 1, point: [c + 15.0, c + 5.0], modifiers: shift, device }, common::now());
    view.input(&Input::Up { pointer: 1, point: [c + 15.0, c + 5.0], modifiers: shift }, common::now());
    frame(&gpu, &mut view);
    let selected: Vec<Vec<latkit::Rows>> = view
        .events()
        .filter_map(|e| if let Event::Selection { rows, trigger: Some(_) } = e { Some(rows) } else { None })
        .collect();
    let rows = selected.last().expect("a selection");
    let mut ids: Vec<String> =
        rows.iter().flat_map(latkit::Rows::rows).map(|r| format!("{}{}", r.table, r.id)).collect();
    ids.sort();
    assert_eq!(ids, ["Link0", "Node1", "Node2"]);
    assert_eq!(view.camera(), &camera(), "the box does not turn or pan");
}

#[test]
fn picking_a_trace_returns_its_sample() {
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
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    let at = view.screen([7.0, 0.7, 0.0]).expect("on the plot");
    let pending = view.pick(at, 6.0);
    let hits = answer(&gpu, &mut view, pending);
    let sample = hits.first().and_then(|h| h.sample).expect("a sample");
    assert_eq!(sample.frame, 7);
    assert!((sample.at - 7.0).abs() < 1e-9 && (sample.value - 0.7).abs() < 1e-6, "{sample:?}");
}

#[test]
fn a_trace_keeps_large_absolute_indexes_on_the_gpu() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("signals");
    data.apply(Table::new("Signal", Ids::count(1))).expect("valid");
    let first = (1_u64 << 32) + 123;
    data.apply(Patch::new().frames(
        "Signal",
        "v",
        0,
        first,
        (0..=10).map(f64::from).collect::<Vec<_>>(),
        (0..=10).map(|t| t as f32 / 10.0).collect::<Vec<_>>(),
    ))
    .unwrap();
    let axis = Axis { hidden: true, grid: false, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").width(3.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    let at = view.screen([7.0, 0.7, 0.0]).expect("on the plot");
    let pending = view.pick(at, 6.0);
    let hits = answer(&gpu, &mut view, pending);
    let sample = hits.first().and_then(|h| h.sample).expect("a sample");
    assert_eq!(sample.frame, first + 7);
    assert!((sample.at - 7.0).abs() < 1e-9 && (sample.value - 0.7).abs() < 1e-6, "{sample:?}");
}
