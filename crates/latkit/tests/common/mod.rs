//! What every GPU test shares: a device, frames rendered headless on a clock the test steps and
//! read back, and plain scenes.

#![allow(dead_code, unreachable_pub, reason = "each test file uses some")]

use std::cell::Cell;

use latkit::{Camera, Color, Diagram, Frame, Gpu, Grid, Plane, Theme, View};

/// Seconds a frame steps the test's clock: frames run as a display's would, however fast they draw.
pub const TICK: f64 = 1.0 / 60.0;

thread_local! {
    /// The test's clock: every frame steps it, and inputs read it.
    static NOW: Cell<f64> = const { Cell::new(0.0) };
}

/// The test's clock, for inputs.
pub fn now() -> f64 {
    NOW.with(Cell::get)
}

/// Steps the test's clock `seconds` without drawing.
pub fn wait(seconds: f64) {
    NOW.with(|now| now.set(now.get() + seconds));
}

pub const SIZE: u32 = 128;
pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A device, or `None` where the machine has no adapter at all, which only `LATKIT_REQUIRE_GPU`
/// makes a failure.
pub fn gpu() -> Option<Gpu> {
    match pollster::block_on(Gpu::new()) {
        Ok(gpu) => Some(gpu),
        Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
        Err(error) => {
            eprintln!("skipping GPU test: {error}");
            None
        }
    }
}

/// The longest the GPU may take to finish a frame in these tests.
pub const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
/// The most frames a view may take to settle: uploads, probes, and a transition of two seconds.
pub const SETTLE: u32 = 600;

pub fn finish(gpu: &Gpu) {
    let wait = wgpu::PollType::Wait { submission_index: None, timeout: Some(DEADLINE) };
    gpu.device().poll(wait).expect("the GPU finishes within the deadline");
}

/// Renders frames until the view is settled, transitions included, then reads the target's pixels.
pub fn frame(gpu: &Gpu, view: &mut View) -> Vec<[u8; 4]> {
    let mut pixels = step(gpu, view);
    for _ in 0..SETTLE {
        if !view.needs_render() {
            return pixels;
        }
        pixels = step(gpu, view);
    }
    panic!("the view settles within {SETTLE} frames");
}

/// Steps the test's clock a frame, renders one frame, and reads the target's pixels.
pub fn step(gpu: &Gpu, view: &mut View) -> Vec<[u8; 4]> {
    wait(TICK);
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
    let frame = Frame { target: &target_view, format: FORMAT, size: [SIZE, SIZE], pixel_ratio: 1.0, time: now() };
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    view.render(&mut encoder, &frame);
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: u64::from(SIZE * SIZE * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
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
    finish(gpu);
    bytemuck::cast_slice::<u8, [u8; 4]>(&slice.get_mapped_range().expect("mapped")).to_vec()
}

/// The errors a view reported since its events were last drained, other events dropped.
pub fn errors(view: &mut View) -> Vec<latkit::Error> {
    view.events().filter_map(|e| if let latkit::Event::Error(e) = e { Some(e) } else { None }).collect()
}

pub fn at(pixels: &[[u8; 4]], x: u32, y: u32) -> [u8; 4] {
    pixels[(y * SIZE + x) as usize]
}

pub fn close(a: [u8; 4], b: [u8; 4]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 3)
}

pub fn plain_theme() -> Theme {
    Theme { background: Color::BLACK, ..Theme::dark() }
}

pub fn plane() -> Plane {
    Plane { grid: Grid::Off }
}

/// A diagram without a grid: y runs down, and at zoom 0 a unit is a pixel.
pub fn diagram() -> Diagram {
    Diagram { grid: Grid::Off }
}

pub fn camera() -> Camera {
    Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 }
}
