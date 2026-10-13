//! Frames rendered headless and read back: what each mark draws lands where and how it should.

#![cfg(feature = "gpu")]

use latkit::{
    Axis, Button, Camera, Color, Colormap, Data, Edges, Event, Faces, Gpu, Grid, Input, Lines, Modifiers, Patch, Phase,
    Plane, Plot, Scene, Table, Target, Theme, Vertices, View, field,
};

const SIZE: u32 = 128;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A device, or `None` where the machine has no adapter at all.
fn gpu() -> Option<Gpu> {
    match pollster::block_on(Gpu::new()) {
        Ok(gpu) => Some(gpu),
        Err(error) => {
            eprintln!("skipping GPU test: {error}");
            None
        }
    }
}

/// The longest the GPU may take to finish a frame in these tests.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

fn wait(gpu: &Gpu) {
    let wait = wgpu::PollType::Wait { submission_index: None, timeout: Some(DEADLINE) };
    gpu.device().poll(wait).expect("the GPU finishes within the deadline");
}

/// Renders frames until the view is settled, then reads the target's pixels.
fn frame(gpu: &Gpu, view: &mut View) -> Vec<[u8; 4]> {
    let device = gpu.device();
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("target"),
        size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let target = Target { view: &target_view, format: FORMAT, size: [SIZE, SIZE], pixel_ratio: 1.0 };
    for _ in 0..16 {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        view.render(&mut encoder, &target);
        gpu.queue().submit([encoder.finish()]);
        wait(gpu);
        if !view.needs_render() {
            break;
        }
    }
    assert!(!view.needs_render(), "the view settles within sixteen frames");
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: u64::from(SIZE * SIZE * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(SIZE * 4),
                rows_per_image: Some(SIZE),
            },
        },
        wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
    );
    gpu.queue().submit([encoder.finish()]);
    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    wait(gpu);
    bytemuck::cast_slice::<u8, [u8; 4]>(&slice.get_mapped_range().expect("mapped")).to_vec()
}

fn at(pixels: &[[u8; 4]], x: u32, y: u32) -> [u8; 4] {
    pixels[(y * SIZE + x) as usize]
}

fn close(a: [u8; 4], b: [u8; 4]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 3)
}

fn plain_theme() -> Theme {
    Theme { background: Color::BLACK, ..Theme::dark() }
}

fn plane() -> Plane {
    Plane { grid: Grid::Off }
}

fn camera() -> Camera {
    Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 }
}

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
    let axis = Axis { label: None, grid: false, hidden: true };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").samples("v").color(Color::rgb(1.0, 0.0, 0.0)).width(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, 10.0], y: Some([0.0, 1.0]) });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 0, 0, 255]), "{:?}", at(&pixels, center, center));
    assert!(close(at(&pixels, center, center - 20), [0, 0, 0, 255]), "only the line is drawn");
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
