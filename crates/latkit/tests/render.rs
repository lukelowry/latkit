//! Frames rendered headless and read back: what each mark draws lands where and how it should.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, close, frame, gpu, plain_theme, plane, step};
use latkit::{
    Axis, Button, Camera, Color, Colormap, Data, Device, Earth, Edges, Event, Faces, Ids, Input, Lines, Modifiers,
    Patch, Phase, Plot, Scene, Table, Theme, Vertices, View, field,
};

#[test]
fn vertices_draw_at_their_positions_in_their_colors() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Table::new("Node", Ids::count(2))
            .field("x", vec![0.0, 30.0])
            .field("y", vec![0.0, 20.0])
            .field("kind", vec!["a", "b"]),
    )
    .expect("valid");
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("graph", "Node")
            .position("x", "y")
            .radius(6.0)
            .color(latkit::when(field("kind").is("a")).then(red).otherwise(blue)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 0, 0, 255]), "{:?}", at(&pixels, center, center));
    assert!(
        close(at(&pixels, center + 30, center - 20), [0, 0, 255, 255]),
        "{:?}",
        at(&pixels, center + 30, center - 20)
    );
    assert!(close(at(&pixels, center + 15, center), [0, 0, 0, 255]), "background between vertices");
}

#[test]
fn channels_follow_the_selection_and_the_zoom() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(2)).field("x", vec![0.0, 30.0]).field("y", vec![0.0, 0.0]))
        .expect("valid");
    let [red, green, blue] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]].map(|[r, g, b]| Color::rgb(r, g, b));
    let color = latkit::when(latkit::selected()).then(red).when(latkit::zoom().ge(1.0)).then(green).otherwise(blue);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(6.0).color(color));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let center = SIZE / 2;
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, center + 30, center), [0, 0, 255, 255]), "{:?}", at(&pixels, center + 30, center));
    view.select([latkit::Rows::new("graph", "Node", [1_u64])]);
    let pixels = frame(&gpu, &mut view);
    assert!(
        close(at(&pixels, center + 30, center), [255, 0, 0, 255]),
        "selected: {:?}",
        at(&pixels, center + 30, center)
    );
    // What the selection leaves out dims, in its own color.
    let [r, g, b, _] = at(&pixels, center, center);
    assert!(b > 60 && r.max(g) < 20, "not selected: {:?}", [r, g, b]);
    view.set_camera(Camera::Map { center: [0.0; 3], zoom: 1.0, pitch: 0.0, bearing: 0.0 });
    let pixels = frame(&gpu, &mut view);
    let [r, g, b, _] = at(&pixels, center, center);
    assert!(g > 60 && r.max(b) < 20, "zoomed in: {:?}", [r, g, b]);
}

#[test]
fn edges_join_their_ends_and_colormaps_fit_the_values() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("grid");
    data.apply(
        Patch::new()
            .set(
                Table::new("Bus", vec![1_u64, 2, 3])
                    .field("x", vec![-40.0, 0.0, 40.0])
                    .field("y", vec![0.0, 0.0, 0.0])
                    .field("v", vec![0.0, 0.5, 1.0]),
            )
            .set(Table::new("Line", Ids::count(1)).reference("from", "Bus", vec![1_u64]).reference(
                "to",
                "Bus",
                vec![3_u64],
            )),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .theme(Theme { edge: Some(Color::rgb(0.0, 1.0, 0.0)), ..plain_theme() })
        .draw(Edges::of("grid", "Line").ends("from", "to").width(4.0))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(5.0).color(field("v").colormap(Colormap::GRAYS)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(
        close(at(&pixels, center - 20, center), [0, 255, 0, 255]),
        "edge between the ends: {:?}",
        at(&pixels, center - 20, center)
    );
    assert!(
        close(at(&pixels, center - 40, center), [0, 0, 0, 255]),
        "fitted domain starts black: {:?}",
        at(&pixels, center - 40, center)
    );
    assert!(
        close(at(&pixels, center + 40, center), [255, 255, 255, 255]),
        "and ends white: {:?}",
        at(&pixels, center + 40, center)
    );
    let middle = at(&pixels, center, center);
    // Grays run evenly in lightness: the middle is OKLab's half lightness, about 100.
    assert!(middle[0] > 80 && middle[0] < 130, "the middle value is grey: {middle:?}");
}

#[test]
fn edges_ending_far_ahead_and_behind_the_eye_draw_whole() {
    let Some(gpu) = gpu() else { return };
    // A plane seen steeply from close by: from the middle one edge runs far ahead, its far end deep in
    // the view, the other far back, under and past the eye. Each draws all the way across the view:
    // the one ahead unbroken however differently deep its ends are, the one back cut where it leaves
    // the view, not dropped.
    let mut data = Data::new("grid");
    data.apply(
        Patch::new()
            .set(Table::new("Bus", vec![1_u64, 2, 3]).field("x", vec![0.0; 3]).field("y", vec![0.0, 1000.0, -1000.0]))
            .set(Table::new("Line", Ids::count(2)).reference("from", "Bus", vec![1_u64, 1]).reference(
                "to",
                "Bus",
                vec![2_u64, 3],
            )),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .theme(Theme { edge: Some(Color::rgb(0.0, 1.0, 0.0)), ..plain_theme() })
        .draw(Edges::of("grid", "Line").ends("from", "to").width(4.0))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(1.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 60.0, bearing: 0.0 });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let middle = SIZE / 2;
    let column: String = (0..SIZE).map(|y| if at(&pixels, middle, y)[1] > 128 { '#' } else { '.' }).collect();
    assert!(!column.contains('.'), "the edges down the middle, top to bottom: {column}");
}

#[test]
fn great_circles_longer_than_their_list_coarsen_instead_of_stopping_short() {
    let Some(gpu) = gpu() else { return };
    // One edge a third of the way around the equator: sixty arcs, where its list first keeps six.
    let mut data = Data::new("grid");
    data.apply(
        Patch::new()
            .set(Table::new("Bus", vec![1_u64, 2]).field("lon", vec![-60.0, 60.0]).field("lat", vec![0.0, 0.0]))
            .set(Table::new("Line", Ids::count(1)).reference("from", "Bus", vec![1_u64]).reference(
                "to",
                "Bus",
                vec![2_u64],
            )),
    )
    .expect("valid");
    let scene = Scene::new(Earth { surface: Some(Color::BLACK), graticule: false, ..Earth::mercator() })
        .theme(Theme { edge: Some(Color::rgb(0.0, 1.0, 0.0)), ..plain_theme() })
        .draw(Edges::of("grid", "Line").ends("from", "to").width(4.0))
        .draw(Vertices::of("grid", "Bus").position("lon", "lat").radius(1.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom: -1.5, pitch: 0.0, bearing: 0.0 });
    view.set_data(data);
    let green = |view: &View, pixels: &[[u8; 4]], lon: f64| {
        let [x, y] = view.point([lon, 0.0, 0.0]).expect("in view").map(|v| v.round() as u32);
        let [r, g, ..] = at(pixels, x.min(SIZE - 1), y.min(SIZE - 1));
        g > 150 && r < 80
    };
    // Every frame that draws the edge draws it whole, coarsely while its list is too small.
    let mut drawn = 0;
    for frame in 0..12 {
        let pixels = step(&gpu, &mut view);
        if green(&view, &pixels, -50.0) {
            assert!(green(&view, &pixels, 50.0), "frame {frame}: the edge stops short of its far end");
            drawn += 1;
        }
    }
    assert!(drawn > 2, "the edge drew in {drawn} frames");
}

#[test]
fn new_data_versions_show_and_fit_frames_them() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![1000.0]).field("y", vec![1000.0])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(8.0).color(Color::WHITE));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data.clone());
    view.fit(latkit::Fit::All);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "fit centers the only vertex");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![1010.0])).expect("valid");
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, center, center), [0, 0, 0, 255]), "the vertex moved away");
}

#[test]
fn a_fit_frames_what_draws_while_another_mark_has_no_rows() {
    let Some(gpu) = gpu() else { return };
    // The links table is empty: it has nothing to frame, and holds no fit back.
    let mut data = Data::new("graph");
    data.apply(
        Patch::new().set(Table::new("Node", Ids::count(1)).field("x", vec![1000.0]).field("y", vec![1000.0])).set(
            Table::new("Link", Ids::count(0)).reference("from", "Node", Vec::<u64>::new()).reference(
                "to",
                "Node",
                Vec::<u64>::new(),
            ),
        ),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(8.0).color(Color::WHITE));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data);
    view.fit(latkit::Fit::All);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "fit centers the only vertex");
    assert!(view.complete(), "waiting on {}", view.stats().waiting);
}

#[test]
fn a_fit_frames_data_whatever_its_units_and_its_markers_pixels() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(2)).field("x", vec![0.0, 1.0]).field("y", vec![0.0, 1.0])).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Vertices::of("graph", "Node").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data);
    view.fit(latkit::Fit::All);
    for _ in 0..4 {
        frame(&gpu, &mut view);
    }
    // Markers a few pixels across leave a unit square filling the view, not lost in its middle.
    let [a, b] = [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]].map(|p| view.point(p).expect("in view"));
    let across = (b[0] - a[0]).abs().min((b[1] - a[1]).abs());
    assert!(across > SIZE as f32 * 0.5, "the unit square spans {across} of {SIZE} pixels");
}

#[test]
fn sampled_fields_read_at_the_shown_coordinate() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("grid");
    data.apply(Table::new("Bus", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    data.apply(Patch::new().append([0.0], "Bus", [("v", vec![0.0])]).append([10.0], "Bus", [("v", vec![1.0])]))
        .expect("frames");
    let gray = |v: latkit::Expr| v.colormap(Colormap::GRAYS).domain(0.0..=1.0);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(8.0).color(gray(field("v"))));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let center = SIZE / 2;
    // Halfway is OKLab's half lightness: about 100.
    for (t, want) in [(0.0, 0), (10.0, 255), (5.0, 100), (20.0, 255), (-1.0, 0)] {
        view.set_at(t);
        let pixel = at(&frame(&gpu, &mut view), center, center);
        if t < 0.0 {
            // Before the first frame there is no value: the vertex takes the theme's color.
            assert_ne!(pixel, [0, 0, 0, 255], "at {t}");
        } else {
            assert!(pixel[0].abs_diff(want) <= 3, "at {t}: {pixel:?}");
        }
    }
    view.show(
        Scene::new(plane())
            .theme(plain_theme())
            .draw(Vertices::of("grid", "Bus").position("x", "y").radius(8.0).color(gray(field("v").step()))),
    )
    .expect("valid scene");
    view.set_at(5.0);
    let pixel = at(&frame(&gpu, &mut view), center, center);
    assert!(close(pixel, [0, 0, 0, 255]), "a step reads the last frame: {pixel:?}");
}

#[test]
fn faces_blend_their_corners_and_hide_what_lies_behind() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("mesh");
    data.apply(
        Patch::new()
            .set(
                Table::new("Vertex", Ids::count(5))
                    .field("x", vec![-40.0, 40.0, 0.0, 0.0, 20.0])
                    .field("y", vec![-30.0, -30.0, 40.0, 0.0, 0.0])
                    .field("z", vec![0.0, 0.0, 0.0, -20.0, 20.0])
                    .field("hue", vec![0.0, 0.0, 0.0, 1.0, 1.0]),
            )
            .set(
                Table::new("Face", Ids::count(1))
                    .reference("a", "Vertex", vec![0_u64])
                    .reference("b", "Vertex", vec![1_u64])
                    .reference("c", "Vertex", vec![2_u64]),
            ),
    )
    .expect("valid");
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Faces::of("mesh", "Face").corners("a", "b", "c")).draw(
        Vertices::of("mesh", "Vertex")
            .position("x", "y")
            .elevation("z")
            .radius(4.0)
            .color(latkit::when(field("hue").gt(0.5)).then(blue).otherwise(red)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center - 10, center + 10), [255, 0, 0, 255]), "a face seen from above shows its color");
    assert!(close(at(&pixels, center, center), [255, 0, 0, 255]), "the vertex below the face is hidden");
    assert!(close(at(&pixels, center + 20, center), [0, 0, 255, 255]), "the vertex above it shows");
}

#[test]
fn presses_click_and_drag_the_rows_they_hit() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", vec![7_u64, 8]).field("x", vec![0.0, 40.0]).field("y", vec![0.0, 0.0]))
        .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(6.0).drag(true));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    frame(&gpu, &mut view);
    let center = SIZE as f32 / 2.0;
    let modifiers = Modifiers::default();
    let device = Device::Mouse;
    let press = |view: &mut View, point: [f32; 2]| {
        view.input(&Input::Down { pointer: 1, point, button: Button::Primary, modifiers, device }, common::now());
    };
    press(&mut view, [center + 40.0, center]);
    view.input(&Input::Up { pointer: 1, point: [center + 40.0, center], modifiers }, common::now());
    frame(&gpu, &mut view);
    let events: Vec<Event> = view.events().collect();
    let clicked = events.iter().find_map(|e| if let Event::Click { hit, .. } = e { Some(hit) } else { None });
    assert_eq!(clicked.map(|hit| hit.row.id.clone()), Some(8_u64.into()), "{events:?}");
    assert!(events.iter().any(|e| matches!(e, Event::Select { rows, trigger: Some(_) } if rows.len() == 1)));

    press(&mut view, [center, center]);
    frame(&gpu, &mut view);
    view.input(&Input::Move { pointer: 1, point: [center + 10.0, center - 20.0], modifiers, device }, common::now());
    view.input(&Input::Up { pointer: 1, point: [center + 10.0, center - 20.0], modifiers }, common::now());
    let drags: Vec<(Phase, [f64; 3])> = view
        .events()
        .filter_map(|e| if let Event::Drag { phase, position, .. } = e { Some((phase, position)) } else { None })
        .collect();
    assert_eq!(drags.iter().map(|d| d.0).collect::<Vec<_>>(), [Phase::Start, Phase::End]);
    let end = drags.last().expect("an end").1;
    assert!((end[0] - 10.0).abs() < 0.5 && (end[1] - 20.0).abs() < 0.5, "the pointer's position: {end:?}");
    assert_eq!(view.camera(), &camera(), "dragging a row does not pan");
}

#[test]
fn lines_trace_their_samples_across_a_plot() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Table::new("Signal", Ids::count(1))).expect("valid");
    for t in 0..=10 {
        data.apply(Patch::new().append([f64::from(t)], "Signal", [("v", vec![0.5])])).expect("frame");
    }
    let axis = Axis { grid: false, hidden: true, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(Color::rgb(1.0, 0.0, 0.0)).width(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 0, 0, 255]), "{:?}", at(&pixels, center, center));
    assert!(close(at(&pixels, center, center - 20), [0, 0, 0, 255]), "only the line is drawn");
}

#[test]
fn lines_traced_in_priority_order_draw_their_whole_span() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Patch::new().axis("time", "s").set(Table::new("Signal", Ids::count(1)).field("rank", vec![1.0])))
        .expect("valid");
    for t in 0..=10 {
        data.apply(Patch::new().append([f64::from(t)], "Signal", [("v", vec![0.5])])).expect("frame");
    }
    let axis = Axis { grid: false, hidden: true, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis }).theme(plain_theme()).draw(
        Lines::of("signals", "Signal").trace("v").priority(field("rank")).color(Color::rgb(1.0, 0.0, 0.0)).width(4.0),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_at(0.0);
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    // Ordered by priority, the table draws in part; its trace still spans every frame, not only
    // those about the coordinate shown, at its start.
    for x in [center - 40, center, center + 40] {
        assert!(close(at(&pixels, x, center), [255, 0, 0, 255]), "at {x}: {:?}", at(&pixels, x, center));
    }
}

#[test]
fn a_plot_frames_its_traces_whole_span_wherever_it_shows() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Table::new("Signal", Ids::count(1))).expect("valid");
    for t in 0..=10 {
        data.apply(Patch::new().append([f64::from(t) * 6.0], "Signal", [("v", vec![f64::from(t)])])).expect("frame");
    }
    let scene = Scene::new(Plot::default()).draw(Lines::of("signals", "Signal").trace("v"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data);
    view.set_at(0.0);
    view.fit(latkit::Fit::All);
    frame(&gpu, &mut view);
    let Camera::Plot { x, .. } = *view.camera() else { panic!("a plot camera") };
    assert_eq!(x, [0.0, 60.0], "the whole span, though only its first sample shows");
}

#[test]
fn lines_wait_for_the_first_frame_of_the_field_they_trace() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Patch::new().axis("time", "s").set(Table::new("Signal", Ids::count(1)))).expect("valid");
    let scene = Scene::new(Plot::default())
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(Color::rgb(1.0, 0.0, 0.0)).width(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data.clone());
    frame(&gpu, &mut view);
    assert_eq!(common::errors(&mut view), Vec::new(), "a field not recorded yet is no error");
    for t in 0..3 {
        data.apply(Patch::new().append([f64::from(t)], "Signal", [("v", vec![f64::from(t)])])).expect("valid");
    }
    view.set_data(data);
    view.set_camera(Camera::Plot { x: [0.0, 2.0], y: Some([0.0, 2.0]) });
    let pixels = frame(&gpu, &mut view);
    assert!(pixels.iter().any(|p| p[0] > 200 && p[1] < 60), "the trace draws once recorded");
    assert_eq!(common::errors(&mut view), Vec::new());
}

#[test]
fn new_data_and_the_scene_reading_it_change_together() {
    let Some(gpu) = gpu() else { return };
    let dataset = |field_name: &str| {
        let mut data = Data::new("d");
        data.apply(
            Table::new("T", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field(field_name, vec![1.0]),
        )
        .expect("valid");
        data
    };
    let reading = |field_name: &str| {
        Scene::new(plane()).theme(plain_theme()).draw(
            Vertices::of("d", "T")
                .position("x", "y")
                .radius(6.0)
                .color(field(field_name).colormap(Colormap::GRAYS).domain(0.0..=1.0)),
        )
    };
    let mut view = View::new(&gpu, reading("a")).expect("valid scene");
    view.set_camera(camera());
    view.set_data(dataset("a"));
    frame(&gpu, &mut view);
    // Data the mark no longer fits, then the scene that fits it, before the frame: nothing to report.
    view.set_data(dataset("b"));
    view.show(reading("b")).expect("valid scene");
    let pixels = frame(&gpu, &mut view);
    assert_eq!(common::errors(&mut view), Vec::new());
    let center = SIZE / 2;
    assert!(at(&pixels, center, center)[0] > 200, "the new mark draws: {:?}", at(&pixels, center, center));
    // Data no mark fits by the frame is told then, once, and listed until data fits it again.
    view.set_data(dataset("a"));
    frame(&gpu, &mut view);
    let errors = common::errors(&mut view);
    assert!(errors.len() == 1 && errors[0].to_string().contains("no field b"), "{errors:?}");
    assert_eq!(view.failures().collect::<Vec<_>>(), errors, "listed as it was told");
    view.set_camera(Camera::Map { center: [5.0, 0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
    frame(&gpu, &mut view);
    assert_eq!(common::errors(&mut view), Vec::new(), "told once");
    view.set_data(dataset("b"));
    frame(&gpu, &mut view);
    assert_eq!(view.failures().count(), 0, "data that fits clears it");
}

#[test]
fn a_dataset_not_given_is_waited_on_and_a_table_it_lacks_fails() {
    let Some(gpu) = gpu() else { return };
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Vertices::of("d", "Bus").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    frame(&gpu, &mut view);
    assert!(view.stats().waiting.data, "waits for the dataset it names");
    let mut data = Data::new("d");
    data.apply(Table::new("Buses", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    view.set_data(data);
    frame(&gpu, &mut view);
    let errors = common::errors(&mut view);
    assert!(errors.len() == 1 && errors[0].to_string().contains("no table 'Bus'"), "{errors:?}");
    assert!(view.complete(), "a mark that failed stands in for nothing");
}

#[test]
fn hover_reaches_what_faces_leave_in_view() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("mesh");
    data.apply(
        Patch::new()
            .set(
                Table::new("Vertex", Ids::count(5))
                    .field("x", vec![-40.0, 40.0, 0.0, 0.0, 20.0])
                    .field("y", vec![-30.0, -30.0, 40.0, 0.0, 0.0])
                    .field("z", vec![0.0, 0.0, 0.0, -20.0, 20.0]),
            )
            .set(
                Table::new("Face", Ids::count(1))
                    .reference("a", "Vertex", vec![0_u64])
                    .reference("b", "Vertex", vec![1_u64])
                    .reference("c", "Vertex", vec![2_u64]),
            ),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Faces::of("mesh", "Face").corners("a", "b", "c").pick(false))
        .draw(Vertices::of("mesh", "Vertex").position("x", "y").elevation("z").radius(3.0).drag(true));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    frame(&gpu, &mut view);
    let center = SIZE as f32 / 2.0;
    let hover = |view: &mut View, point: [f32; 2]| {
        let modifiers = Modifiers::default();
        view.input(&Input::Move { pointer: 1, point, modifiers, device: Device::Mouse }, common::now());
        frame(&gpu, view);
        view.events().filter_map(|e| if let Event::Hover { hit, .. } = e { Some(hit) } else { None }).last()
    };
    let above = hover(&mut view, [center + 20.0, center]).expect("a hover event");
    assert_eq!(above.map(|hit| hit.row.id), Some(4_u64.into()), "the vertex above the face");
    let below = hover(&mut view, [center, center]).expect("a hover event");
    assert_eq!(below, None, "the vertex below the face is hidden");
}

#[test]
fn a_streamed_tilted_mesh_answers_hover_and_drags() {
    let Some(gpu) = gpu() else { return };
    // An octahedron standing on the ground, its corners streamed as sampled fields.
    let corners: [[f64; 3]; 6] =
        [[0.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [-1.0, 0.0, 1.0], [0.0, -1.0, 1.0], [0.0, 0.0, 2.0]];
    let faces = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]];
    let column = |k: usize| corners.iter().map(|c| c[k]).collect::<Vec<_>>();
    let corner = |k: usize| faces.iter().map(|f| f[k] as u64).collect::<Vec<_>>();
    let mut data = Data::new("mesh");
    data.apply(
        Patch::new()
            .set(Table::new("Vertex", Ids::count(6)))
            .set(
                Table::new("Face", Ids::count(8))
                    .reference("a", "Vertex", corner(0))
                    .reference("b", "Vertex", corner(1))
                    .reference("c", "Vertex", corner(2)),
            )
            .append([0.0], "Vertex", [("x", column(0)), ("y", column(1)), ("z", column(2))]),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Faces::of("mesh", "Face").corners("a", "b", "c").pick(false).shadow(true))
        .draw(Vertices::of("mesh", "Vertex").position("x", "y").elevation("z").radius(2.0).select(false).drag(true));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 58.0, bearing: 30.0 });
    view.fit(latkit::Fit::Bounds { min: [-2.0, -2.0, 0.0], max: [2.0, 2.0, 2.0] });
    view.set_data(data);
    frame(&gpu, &mut view);
    let top = view.point([0.0, 0.0, 2.0]).expect("the top is in view");
    let (modifiers, device) = (Modifiers::default(), Device::Mouse);
    view.input(&Input::Move { pointer: 1, point: top, modifiers, device }, common::now());
    frame(&gpu, &mut view);
    let hovered = view.events().find_map(|e| if let Event::Hover { hit, .. } = e { hit } else { None });
    assert_eq!(hovered.map(|hit| hit.row.id), Some(5_u64.into()), "the top vertex is hovered");
    assert_eq!(view.hovered().map(|hit| hit.row.id.clone()), Some(5_u64.into()), "and reads as hovered");
    assert_eq!(view.cursor(), latkit::Cursor::Grab);
    view.input(&Input::Down { pointer: 1, point: top, button: Button::Primary, modifiers, device }, common::now());
    view.input(&Input::Move { pointer: 1, point: [top[0], top[1] - 30.0], modifiers, device }, common::now());
    let (phase, position) = view
        .events()
        .find_map(|e| if let Event::Drag { phase, position, .. } = e { Some((phase, position)) } else { None })
        .expect("a drag");
    assert_eq!(phase, Phase::Start);
    assert!(position[2] > 2.0, "dragged up: {position:?}");
}

#[test]
fn long_histories_draw_from_their_levels_of_detail() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Table::new("Signal", Ids::count(1))).expect("valid");
    // Twenty thousand frames on a 128 pixel plot: buckets of 64 frames, with a spike in one.
    let mut patch = Patch::new();
    for t in 0..20_000 {
        let v = if t == 10_000 { 0.9 } else { 0.1 };
        patch = patch.append([f64::from(t)], "Signal", [("v", vec![v])]);
    }
    data.apply(patch).expect("frames");
    let axis = Axis { grid: false, hidden: true, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(Color::rgb(1.0, 0.0, 0.0)).width(2.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 20_000.0], y: Some([0.0, 1.0]) });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let spike = view.point([10_000.0, 0.85, 0.0]).expect("on the plot");
    let pixel = at(&pixels, spike[0].round() as u32, spike[1].round() as u32);
    assert!(pixel[0] > 150, "the one-frame spike survives in its bucket: {pixel:?}");
    let base = view.point([5_000.0, 0.1, 0.0]).expect("on the plot");
    assert!(at(&pixels, base[0].round() as u32, base[1].round() as u32)[0] > 150, "and the level line draws");
    let stats = view.stats();
    assert_eq!(stats.rows, 1);
}

#[test]
fn frames_tell_what_they_cost_the_gpu_where_it_measures() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device().features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return;
    }
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Vertices::of("graph", "Node").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    for _ in 0..common::SETTLE {
        if view.stats().gpu_ms > 0.0 {
            break;
        }
        common::finish(&gpu);
        step(&gpu, &mut view);
    }
    // Milliseconds, measured: no frame passes the deadline `finish` holds it to, even on a CPU
    // renderer under load, while a count of nanoseconds would.
    let ms = view.stats().gpu_ms;
    assert!(ms > 0.0 && ms < common::DEADLINE.as_secs_f32() * 1000.0, "{ms} ms");
}

#[test]
fn frames_count_their_draws_and_instances() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(3)).field("x", vec![-1.0, 0.0, 1.0]).field("y", vec![0.0; 3]))
        .expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Vertices::of("graph", "Node").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    frame(&gpu, &mut view);
    let stats = view.stats();
    // The backdrop's one triangle, then the mark's three points.
    assert_eq!((stats.draws, stats.instances), (2, 4), "{stats:?}");
    assert_eq!(stats.tiles, 0);
}

#[test]
fn dashes_run_on_across_a_paths_segments() {
    let Some(gpu) = gpu() else { return };
    // A path of a hundred segments a pixel long, dashed. Were each segment to start its dashes
    // afresh, each would show only the blank first half of a dash, and the path nothing.
    let points: Vec<[f64; 2]> = (0..=100).map(|i| [f64::from(i) - 50.0, 0.0]).collect();
    let mut data = Data::new("d");
    data.apply(Table::new("Path", Ids::count(1)).field("geometry", vec![points])).expect("valid");
    let scene =
        Scene::new(plane()).theme(plain_theme()).draw(Lines::of("d", "Path").width(3.0).dash(true).color(Color::WHITE));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    let on = (c - 40..c + 40).filter(|&x| at(&pixels, x, c)[0] > 128).count();
    assert!(on > 20 && on < 60, "about half of the path dashes: {on} of 80 pixels");
}

/// A view of a gray line a pixel wide from x -50 to 50, its comets red and 8 pixels wide, 30 apart
/// with tails of 8, in position units when `units`; flowing at `speed`, or not at all.
fn comets(gpu: &latkit::Gpu, units: bool, speed: Option<f64>) -> View {
    let mut data = Data::new("d");
    data.apply(Table::new("Path", Ids::count(1)).field("geometry", vec![vec![[-50.0, 0.0], [50.0, 0.0]]]))
        .expect("valid");
    let mut view = View::new(gpu, comets_scene(units, speed)).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    view
}

fn comets_scene(units: bool, speed: Option<f64>) -> Scene {
    let flow = latkit::Flow { color: Color::rgb(1.0, 0.0, 0.0), spacing: 30.0, length: 8.0, width: 8.0, units };
    let line = Lines::of("d", "Path").width(1.0).color(Color::rgb(0.25, 0.25, 0.25));
    let line = match speed {
        Some(speed) => line.flow(speed),
        None => line,
    };
    Scene::new(plane()).theme(Theme { flow, ..plain_theme() }).ease(std::time::Duration::ZERO).draw(line)
}

/// Where comets' heads are along row `y`, CSS pixels: the reddest pixel of each run of red.
fn heads(pixels: &[[u8; 4]], y: u32) -> Vec<u32> {
    let red = |x: u32| at(pixels, x, y)[0];
    let mut heads = Vec::new();
    let mut x = 0;
    while x < SIZE {
        if red(x) <= 60 {
            x += 1;
            continue;
        }
        let start = x;
        while x < SIZE && red(x) > 60 {
            x += 1;
        }
        heads.extend((start..x).max_by_key(|&x| red(x)));
    }
    heads
}

#[test]
fn comets_run_wider_than_their_line() {
    let Some(gpu) = gpu() else { return };
    let mut view = comets(&gpu, false, Some(40.0));
    let c = SIZE / 2;
    let red = |pixels: &[[u8; 4]], y: u32| (c - 45..c + 45).filter(|&x| at(pixels, x, y)[0] > 100).count();
    // Comets never settle: a few frames draw them.
    let pixels = (0..3).map(|_| step(&gpu, &mut view)).last().expect("frames");
    assert!(view.needs_render(), "comets travel every frame");
    let beside = red(&pixels, c + 2);
    assert!(beside > 0 && beside < 60, "comets reach past the line, spaced apart: {beside} of 90 pixels");
    assert_eq!(red(&pixels, c + 6), 0, "and no further than their width");
    view.show(comets_scene(false, None)).expect("valid scene");
    assert_eq!(red(&frame(&gpu, &mut view), c + 2), 0, "a line without flow has no comets");
}

#[test]
fn comets_carry_on_from_where_they_are_when_their_flow_changes() {
    let Some(gpu) = gpu() else { return };
    let mut view = comets(&gpu, false, Some(40.0));
    for _ in 0..3 {
        step(&gpu, &mut view);
    }
    // Long after the view began, as a page left running is, a pause moves them a tenth of a second.
    common::wait(100_000.0);
    let paused = heads(&step(&gpu, &mut view), SIZE / 2 + 2);
    let before = heads(&step(&gpu, &mut view), SIZE / 2 + 2);
    let moved = |a: &[u32], b: &[u32]| a.iter().zip(b).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(99);
    assert!(!before.is_empty() && moved(&paused, &before) <= 2, "{paused:?} then {before:?}");
    view.show(comets_scene(false, Some(41.0))).expect("valid scene");
    let after = heads(&step(&gpu, &mut view), SIZE / 2 + 2);
    assert_eq!(before.len(), after.len(), "{before:?} then {after:?}");
    assert!(moved(&before, &after) <= 2, "a new speed moves comets a frame's way: {before:?} then {after:?}");
}

#[test]
fn comets_follow_their_rows_when_rows_move_without_easing() {
    let Some(gpu) = gpu() else { return };
    // Two lines whose comets travel at different speeds, so each row's travel is its own.
    let mut data = Data::new("d");
    let paths = vec![vec![[-50.0, 30.0], [50.0, 30.0]], vec![[-50.0, 0.0], [50.0, 0.0]]];
    data.apply(Table::new("Path", vec!["a", "b"]).field("geometry", paths).field("speed", vec![17.0, 40.0]))
        .expect("valid");
    let flow = latkit::Flow { color: Color::rgb(1.0, 0.0, 0.0), spacing: 30.0, length: 8.0, width: 8.0, units: false };
    let line = Lines::of("d", "Path").width(1.0).color(Color::rgb(0.25, 0.25, 0.25)).flow(field("speed"));
    let scene = Scene::new(plane()).theme(Theme { flow, ..plain_theme() }).ease(std::time::Duration::ZERO).draw(line);
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data.clone());
    for _ in 0..40 {
        step(&gpu, &mut view);
    }
    let before = heads(&step(&gpu, &mut view), SIZE / 2 + 2);
    // Row b moves up to row 0 at once: its comets carry on from where they were, not from a's.
    data.apply(Patch::new().remove("Path", vec!["a"])).expect("valid");
    view.set_data(data);
    let after = heads(&step(&gpu, &mut view), SIZE / 2 + 2);
    let moved = before.iter().zip(&after).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(99);
    assert!(!before.is_empty() && before.len() == after.len() && moved <= 2, "{before:?} then {after:?}");
}

#[test]
fn comets_in_units_stay_on_their_lines_as_the_view_zooms() {
    let Some(gpu) = gpu() else { return };
    let c = f64::from(SIZE / 2);
    // Where comets' heads stand in position units at zoom 0 and zoom 1, so slow they stand still.
    let heads_at = |units: bool| {
        let mut view = comets(&gpu, units, Some(1e-4));
        [0.0, 1.0].map(|zoom: f64| {
            view.set_camera(Camera::Map { center: [0.0; 3], zoom, pitch: 0.0, bearing: 0.0 });
            step(&gpu, &mut view);
            let heads = heads(&step(&gpu, &mut view), SIZE / 2 + 2);
            heads.into_iter().map(|x| (f64::from(x) - c) / 2f64.powf(zoom)).collect::<Vec<_>>()
        })
    };
    let stayed = |[near, zoomed]: &[Vec<f64>; 2]| zoomed.iter().all(|z| near.iter().any(|n| (n - z).abs() <= 1.5));
    let drawn = heads_at(true);
    assert!(drawn[1].len() >= 2, "comets 30 units apart across 64: {drawn:?}");
    assert!(stayed(&drawn), "comets in units stay where they were: {drawn:?}");
    let on_screen = heads_at(false);
    assert!(!stayed(&on_screen), "comets in pixels keep their spacing on screen instead: {on_screen:?}");
}

#[test]
fn sizes_in_units_keep_within_their_pixels() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("d");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    // Pixels across a red marker through the middle, at zoom 0: a unit a pixel.
    let across = |radius: latkit::Size| {
        let marker = Vertices::of("d", "Node").position("x", "y").radius(radius).color(Color::rgb(1.0, 0.0, 0.0));
        let mut view = View::new(&gpu, Scene::new(plane()).theme(plain_theme()).draw(marker)).expect("valid scene");
        view.set_camera(camera());
        view.set_data(data.clone());
        let pixels = frame(&gpu, &mut view);
        (0..SIZE).filter(|&x| at(&pixels, x, SIZE / 2)[0] > 128).count()
    };
    assert!(across(latkit::units(0.01)) <= 1, "a hundredth of a unit is no pixel at all");
    let held = across(latkit::units(0.01).at_least(5.0));
    assert!((9..=11).contains(&held), "a radius of at least 5 pixels: {held} across");
    let capped = across(latkit::units(1000.0).at_most(6.0));
    assert!((11..=13).contains(&capped), "a radius of at most 6 pixels: {capped} across");
}

#[test]
fn poles_stand_from_each_vertex_down_to_the_ground() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("d");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("z", vec![40.0]))
        .expect("valid");
    let scene = |poles: bool| {
        let vertices = Vertices::of("d", "Node")
            .position("x", "y")
            .elevation(field("z"))
            .radius(3.0)
            .color(Color::rgb(0.0, 0.0, 1.0));
        let pole = Edges::of("d", "Node").poles().width(3.0).color(Color::rgb(1.0, 0.0, 0.0));
        let scene = Scene::new(plane()).theme(plain_theme()).draw(vertices);
        if poles { scene.draw(pole) } else { scene }
    };
    let red = |poles: bool| {
        let mut view = View::new(&gpu, scene(poles)).expect("valid scene");
        // Tilted, so a pole stands up the screen.
        view.set_camera(Camera::Map { center: [0.0, 0.0, 20.0], zoom: 0.0, pitch: 60.0, bearing: 0.0 });
        view.set_data(data.clone());
        let pixels = frame(&gpu, &mut view);
        (0..SIZE).filter(|&y| (SIZE / 2 - 2..SIZE / 2 + 3).any(|x| at(&pixels, x, y)[0] > 128)).count()
    };
    assert_eq!(red(false), 0, "no pole, no red");
    let tall = red(true);
    assert!(tall >= 15, "the pole runs up the screen from the ground to its vertex: {tall} rows");
}

#[test]
fn nets_off_a_diagram_join_their_members_as_stars() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("d");
    data.apply(
        Patch::new().set(Table::new("Net", Ids::count(1))).set(
            Table::new("Bus", Ids::count(3))
                .field("x", vec![-30.0, 30.0, 0.0])
                .field("y", vec![-15.0, -15.0, 30.0])
                .reference("net", "Net", vec![0_u64, 0, 0]),
        ),
    )
    .expect("valid");
    let buses = Vertices::of("d", "Bus").position("x", "y").radius(2.0).color(Color::rgb(0.0, 0.0, 1.0));
    let net = Edges::of("d", "Net").joins("Bus", "net").width(2.0).color(Color::rgb(1.0, 0.0, 0.0));
    let mut view =
        View::new(&gpu, Scene::new(plane()).theme(plain_theme()).draw(net).draw(buses)).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let red = |x: u32, y: u32| at(&pixels, x, y)[0] > 128;
    // The members' middle is the origin: the spokes meet there, and run out to each member.
    let c = SIZE / 2;
    assert!(red(c, c), "the star's middle");
    assert!(red(c, c - 15), "the spoke up to the member at the top (y up)");
    assert!(!red(c + 20, c - 20), "nothing where no spoke runs");
}
