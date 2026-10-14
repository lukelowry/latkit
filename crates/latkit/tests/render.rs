//! Frames rendered headless and read back: what each mark draws lands where and how it should.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, close, frame, gpu, plain_theme, plane, step};
use latkit::{
    Axis, Button, Camera, Color, Colormap, Data, Earth, Edges, Event, Faces, Input, Lines, Modifiers, Patch, Phase,
    Plot, Scene, Table, Theme, Vertices, View, field,
};

#[test]
fn vertices_draw_at_their_positions_in_their_colors() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Table::new("Node", 2).field("x", vec![0.0, 30.0]).field("y", vec![0.0, 20.0]).field("kind", vec!["a", "b"]),
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
            .set(Table::new("Line", 1).reference("from", "Bus", vec![1_u64]).reference("to", "Bus", vec![3_u64])),
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
    assert!(middle[0] > 100 && middle[0] < 160, "the middle value is grey: {middle:?}");
}

#[test]
fn great_circles_longer_than_their_list_coarsen_instead_of_stopping_short() {
    let Some(gpu) = gpu() else { return };
    // One edge a third of the way around the equator: sixty arcs, where its list first keeps six.
    let mut data = Data::new("grid");
    data.apply(
        Patch::new()
            .set(Table::new("Bus", vec![1_u64, 2]).field("lon", vec![-60.0, 60.0]).field("lat", vec![0.0, 0.0]))
            .set(Table::new("Line", 1).reference("from", "Bus", vec![1_u64]).reference("to", "Bus", vec![2_u64])),
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
    data.apply(Table::new("Node", 1).field("x", vec![1000.0]).field("y", vec![1000.0])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(8.0).color(Color::WHITE));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data.clone());
    view.fit(latkit::Fit::All);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "fit centers the only vertex");
    data.apply(Table::new("Node", 1).field("x", vec![1010.0])).expect("valid");
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, center, center), [0, 0, 0, 255]), "the vertex moved away");
}

#[test]
fn sampled_fields_read_at_the_shown_coordinate() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("grid");
    data.apply(Table::new("Bus", 1).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    data.apply(Patch::new().append(0.0, "Bus", [("v", vec![0.0])]).append(10.0, "Bus", [("v", vec![1.0])]))
        .expect("frames");
    let gray = |v: latkit::Expr| v.colormap(Colormap::GRAYS).domain(0.0..=1.0);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(8.0).color(gray(field("v"))));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let center = SIZE / 2;
    for (t, want) in [(0.0, 0), (10.0, 255), (5.0, 128), (20.0, 255), (-1.0, 0)] {
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
                Table::new("Vertex", 5)
                    .field("x", vec![-40.0, 40.0, 0.0, 0.0, 20.0])
                    .field("y", vec![-30.0, -30.0, 40.0, 0.0, 0.0])
                    .field("z", vec![0.0, 0.0, 0.0, -20.0, 20.0])
                    .field("hue", vec![0.0, 0.0, 0.0, 1.0, 1.0]),
            )
            .set(
                Table::new("Face", 1)
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
    let press = |view: &mut View, point: [f32; 2]| {
        view.input(&Input::Down { pointer: 1, point, button: Button::Primary, modifiers, touch: false });
    };
    press(&mut view, [center + 40.0, center]);
    view.input(&Input::Up { pointer: 1, point: [center + 40.0, center], modifiers });
    frame(&gpu, &mut view);
    let events: Vec<Event> = view.events().collect();
    let clicked = events.iter().find_map(|e| if let Event::Click(hit) = e { Some(hit) } else { None });
    assert_eq!(clicked.map(|hit| hit.row.id.clone()), Some(8_u64.into()), "{events:?}");
    assert!(events.iter().any(|e| matches!(e, Event::Select(rows) if rows.len() == 1)));

    press(&mut view, [center, center]);
    frame(&gpu, &mut view);
    view.input(&Input::Move { pointer: 1, point: [center + 10.0, center - 20.0], modifiers });
    view.input(&Input::Up { pointer: 1, point: [center + 10.0, center - 20.0], modifiers });
    let drags: Vec<_> =
        view.events().filter_map(|e| if let Event::Drag(drag) = e { Some(drag) } else { None }).collect();
    assert_eq!(drags.iter().map(|d| d.phase).collect::<Vec<_>>(), [Phase::Start, Phase::End]);
    let end = drags.last().expect("an end").position;
    assert!((end[0] - 10.0).abs() < 0.5 && (end[1] - 20.0).abs() < 0.5, "the pointer's position: {end:?}");
    assert_eq!(view.camera(), &camera(), "dragging a row does not pan");
}

#[test]
fn lines_trace_their_samples_across_a_plot() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Table::new("Signal", 1)).expect("valid");
    for t in 0..=10 {
        data.apply(Patch::new().append(f64::from(t), "Signal", [("v", vec![0.5])])).expect("frame");
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
fn lines_wait_for_the_first_frame_of_the_field_they_trace() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Patch::new().axis("time", "s").set(Table::new("Signal", 1))).expect("valid");
    let scene = Scene::new(Plot::default())
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(Color::rgb(1.0, 0.0, 0.0)).width(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data.clone());
    frame(&gpu, &mut view);
    assert_eq!(common::errors(&mut view), Vec::new(), "a field not recorded yet is no error");
    for t in 0..3 {
        data.apply(Patch::new().append(f64::from(t), "Signal", [("v", vec![f64::from(t)])])).expect("valid");
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
        data.apply(Table::new("T", 1).field("x", vec![0.0]).field("y", vec![0.0]).field(field_name, vec![1.0]))
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
    // Data no mark fits by the frame is reported then.
    view.set_data(dataset("a"));
    frame(&gpu, &mut view);
    let errors = common::errors(&mut view);
    assert!(errors.len() == 1 && errors[0].to_string().contains("no field b"), "{errors:?}");
}

#[test]
fn hover_reaches_what_faces_leave_in_view() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("mesh");
    data.apply(
        Patch::new()
            .set(
                Table::new("Vertex", 5)
                    .field("x", vec![-40.0, 40.0, 0.0, 0.0, 20.0])
                    .field("y", vec![-30.0, -30.0, 40.0, 0.0, 0.0])
                    .field("z", vec![0.0, 0.0, 0.0, -20.0, 20.0]),
            )
            .set(
                Table::new("Face", 1)
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
        view.input(&Input::Move { pointer: 1, point, modifiers: Modifiers::default() });
        frame(&gpu, view);
        view.events().filter_map(|e| if let Event::Hover(hit) = e { Some(hit) } else { None }).last()
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
            .set(Table::new("Vertex", 6))
            .set(
                Table::new("Face", 8)
                    .reference("a", "Vertex", corner(0))
                    .reference("b", "Vertex", corner(1))
                    .reference("c", "Vertex", corner(2)),
            )
            .append(0.0, "Vertex", [("x", column(0)), ("y", column(1)), ("z", column(2))]),
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
    view.input(&Input::Move { pointer: 1, point: top, modifiers: Modifiers::default() });
    frame(&gpu, &mut view);
    let hovered = view.events().find_map(|e| if let Event::Hover(hit) = e { hit } else { None });
    assert_eq!(hovered.map(|hit| hit.row.id), Some(5_u64.into()), "the top vertex is hovered");
    assert_eq!(view.cursor(), latkit::Cursor::Grab);
    let modifiers = Modifiers::default();
    view.input(&Input::Down { pointer: 1, point: top, button: Button::Primary, modifiers, touch: false });
    view.input(&Input::Move { pointer: 1, point: [top[0], top[1] - 30.0], modifiers });
    let drag = view.events().find_map(|e| if let Event::Drag(drag) = e { Some(drag) } else { None }).expect("a drag");
    assert_eq!(drag.phase, Phase::Start);
    assert!(drag.position[2] > 2.0, "dragged up: {:?}", drag.position);
}

#[test]
fn long_histories_draw_from_their_levels_of_detail() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Table::new("Signal", 1)).expect("valid");
    // Twenty thousand frames on a 128 pixel plot: buckets of 64 frames, with a spike in one.
    let mut patch = Patch::new();
    for t in 0..20_000 {
        let v = if t == 10_000 { 0.9 } else { 0.1 };
        patch = patch.append(f64::from(t), "Signal", [("v", vec![v])]);
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
