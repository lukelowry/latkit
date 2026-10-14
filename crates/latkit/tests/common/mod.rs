//! What every GPU test shares: a device, frames rendered headless and read back, and plain scenes.

#![allow(dead_code, unreachable_pub, reason = "each test file uses some")]

use latkit::{Camera, Color, Diagram, Gpu, Grid, Plane, Target, Theme, View};

pub const SIZE: u32 = 128;
pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A device, or `None` where the machine has no adapter at all.
pub fn gpu() -> Option<Gpu> {
    match pollster::block_on(Gpu::new()) {
        Ok(gpu) => Some(gpu),
        Err(error) => {
            eprintln!("skipping GPU test: {error}");
            None
        }
    }
}

/// The longest the GPU may take to finish a frame in these tests.
pub const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
/// The longest a view may take to settle: uploads, probes, and a transition.
pub const SETTLE: std::time::Duration = std::time::Duration::from_secs(3);

pub fn wait(gpu: &Gpu) {
    let wait = wgpu::PollType::Wait { submission_index: None, timeout: Some(DEADLINE) };
    gpu.device().poll(wait).expect("the GPU finishes within the deadline");
}

/// Renders frames until the view is settled, transitions included, then reads the target's pixels.
/// The time to settle counts from the first frame, which makes the scene's pipelines; the browser
/// gate holds those to their own budget.
pub fn frame(gpu: &Gpu, view: &mut View) -> Vec<[u8; 4]> {
    let mut pixels = step(gpu, view);
    let started = std::time::Instant::now();
    loop {
        if !view.needs_render() {
            return pixels;
        }
        assert!(started.elapsed() < SETTLE, "the view settles within {SETTLE:?}");
        std::thread::sleep(std::time::Duration::from_millis(8));
        pixels = step(gpu, view);
    }
}

/// Renders one frame and reads the target's pixels.
pub fn step(gpu: &Gpu, view: &mut View) -> Vec<[u8; 4]> {
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
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    view.render(&mut encoder, &target);
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
    wait(gpu);
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
