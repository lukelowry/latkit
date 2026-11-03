//! The device views draw with. Every view reports each error the device raises once, whichever
//! draws first. Memory latkit replaces, or a view or picture leaves behind, is freed once the GPU is
//! done with it, instead of whenever the platform collects it. The default budget stays within 1
//! GiB.

#![cfg(feature = "gpu")]

mod common;

use common::{camera, errors, frame, gpu, plain_theme, plane};
use latkit::{Color, Data, Gpu, Ids, Scene, Shot, Table, Vertices, View, field};

fn data() -> Data {
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    data
}

fn dots(gpu: &Gpu, data: &Data) -> View {
    let mark = Vertices::of("d", "V").position(field("x"), field("y")).radius(4.0).color(Color::WHITE);
    let mut view = View::new(gpu, Scene::new(plane()).theme(plain_theme()).draw(mark));
    view.set_camera(camera());
    view.set_sources([data]).expect("a source");
    view
}

#[test]
fn every_view_reports_each_device_error_once() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let (mut first, mut second) = (dots(&gpu, &data), dots(&gpu, &data));
    frame(&gpu, &mut first);
    frame(&gpu, &mut second);
    let error = wgpu::Error::Validation { source: Box::new(std::fmt::Error), description: "a broken buffer".into() };
    // A broken resource fails every frame the same way.
    gpu.device_events().error(&error);
    gpu.device_events().error(&error);
    let told = |view: &mut View| errors(view).iter().filter(|e| e.to_string().contains("a broken buffer")).count();
    frame(&gpu, &mut first);
    frame(&gpu, &mut second);
    assert_eq!(told(&mut first), 1, "the view that draws first reports it once");
    assert_eq!(told(&mut second), 1, "and so does the other");
    frame(&gpu, &mut first);
    assert_eq!(told(&mut first), 0, "and never again");
    let mut later = dots(&gpu, &data);
    frame(&gpu, &mut later);
    assert_eq!(told(&mut later), 0, "a view made after it does not report it");
}

#[test]
fn memory_replaced_or_left_behind_is_freed_by_the_next_frame() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let (mut kept, mut left) = (dots(&gpu, &data), dots(&gpu, &data));
    frame(&gpu, &mut kept);
    frame(&gpu, &mut left);
    let before = gpu.work().destroyed;
    // A picture's buffer and the targets it replaces in its view, and a dropped view's textures.
    pollster::block_on(Shot::new([96, 96]).image(&mut [&mut kept])).expect("a picture");
    drop(left);
    frame(&gpu, &mut kept);
    let freed = gpu.work().destroyed - before;
    // The picture's buffer and panel, 96 × 96 × 4 bytes each, and the dropped view's depth target.
    let least = 2 * 96 * 96 * 4 + u64::from(common::SIZE * common::SIZE) * 4;
    assert!(freed >= least, "{freed} bytes freed, at least {least}");
}

#[test]
fn the_default_budget_stays_within_a_gibibyte() {
    let Some(gpu) = gpu() else { return };
    assert!(gpu.budget().bytes <= 1 << 30, "{} bytes", gpu.budget().bytes);
}
