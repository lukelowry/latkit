//! The device views draw with. Every view reports each error the device raises once, whichever
//! draws first. Memory latkit replaces, or a view or picture leaves behind, is freed once the GPU is
//! done with it, instead of whenever the platform collects it. The default budget stays within 1
//! GiB. A view moved to a new device stays the same view: whatever waited on the old device is
//! answered on the new one, and the move is not an error.

#![cfg(feature = "gpu")]

mod common;

use common::{answer, camera, errors, failures, frame, gpu, plain_theme, plane};
use latkit::{Color, Data, Event, Fit, Gpu, Ids, Scene, Shot, Table, Vertices, View, field};

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
fn a_moved_view_answers_what_waited_on_its_old_device() {
    let (Some(old), Some(new)) = (gpu(), gpu()) else { return };
    let data = data();
    let mut view = dots(&old, &data);
    // Asked before any frame drew, so all of it still waits when the view moves.
    view.fit(Fit::All);
    let framed = view.framed();
    let done = view.done();
    let middle = (common::SIZE / 2) as f32;
    let picked = view.pick([middle, middle], 4.0);
    view.move_to(&new);
    assert!(answer(&new, &mut view, framed).is_some(), "the fit applies on the new device");
    answer(&new, &mut view, done);
    assert_eq!(answer(&new, &mut view, picked).len(), 1, "the pick answers there");
    assert_eq!(errors(&mut view), Vec::new(), "and the move is no error");
}

#[test]
fn a_moved_view_tells_its_failures_and_errors_only_when_they_change() {
    let (Some(old), Some(new)) = (gpu(), gpu()) else { return };
    let data = data();
    // A color that reads a missing field draws as if unset, and is a failure.
    let mark = Vertices::of("d", "V").position(field("x"), field("y")).color(field("missing"));
    let mut view = View::new(&old, Scene::new(plane()).theme(plain_theme()).draw(mark));
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&old, &mut view);
    assert_eq!(failures(&mut view).map(|f| f.len()), Some(1));
    view.move_to(&new);
    frame(&new, &mut view);
    let events: Vec<Event> = view.events().collect();
    assert!(!events.iter().any(|e| matches!(e, Event::Failures(_) | Event::Error(_))), "{events:?}");
    assert_eq!(view.failures().count(), 1, "the failure still holds");
}

#[test]
fn the_default_budget_stays_within_a_gibibyte() {
    let Some(gpu) = gpu() else { return };
    assert!(gpu.budget().bytes <= 1 << 30, "{} bytes", gpu.budget().bytes);
}
