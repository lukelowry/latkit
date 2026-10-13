//! Frames rendered headless and read back: what each mark draws lands where and how it should.

#![cfg(feature = "gpu")]

use latkit::{
    Camera, Color, Colormap, Data, Edges, Gpu, Grid, Patch, Plane, Scene, Table, Target, Theme, Vertices, View, field,
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
    Theme { background: Color::BLACK, shadows: false, ..Theme::dark() }
}

fn plane() -> Plane {
    Plane { grid: Grid::Off }
}

fn camera() -> Camera {
    Camera::Map { center: [0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 }
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
    view.fit();
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
