//! Labels show beside their rows once the host sets their texts; where two would overlap, the one of
//! higher priority shows.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, errors, frame, gpu, plain_theme, plane};
use latkit::host::{Host, Raster, TextRun};
use latkit::{Color, Data, Label, Scene, Table, Vertices, View, field};

/// Sets a text as a solid box six pixels wide per character, as tall as its size.
struct Boxes;

impl Host for Boxes {
    fn rasterize(&self, run: &TextRun) -> Option<Raster> {
        let size = [6 * run.text.chars().count() as u32, run.size_px];
        Some(Raster { size, coverage: vec![255; (size[0] * size[1]) as usize], baseline: size[1] as f32 * 0.8 })
    }
}

fn view(gpu: &latkit::Gpu, x: Vec<f64>, priority: Vec<f64>) -> View {
    gpu.set_host(Boxes);
    let mut data = Data::new("d");
    let n = x.len();
    data.apply(
        Table::new("V", n)
            .field("x", x)
            .field("y", vec![0.0; n])
            .field("name", vec!["abcdef"; n])
            .field("p", priority)
            .field("hue", (0..n).map(|i| i as f64).collect::<Vec<_>>()),
    )
    .expect("valid");
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);
    let label = Label::new("name")
        .size(10.0)
        .priority(field("p"))
        .color(latkit::when(field("hue").lt(0.5)).then(red).otherwise(blue));
    let scene = Scene::new(plane())
        .theme(latkit::Theme { halo: 0.0, ..plain_theme() })
        .draw(Vertices::of("d", "V").position("x", "y").radius(2.0).pick(false).label(label));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    view
}

#[test]
fn labels_show_beside_their_rows() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, vec![-50.0, 10.0], vec![0.0, 0.0]);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // A label starts four pixels past its marker's right edge, centered on it.
    let first = at(&pixels, c - 50 + 12, c);
    let second = at(&pixels, c + 10 + 12, c);
    assert!(first[0] > 200 && first[2] < 60, "the first row's label: {first:?}");
    assert!(second[2] > 200 && second[0] < 60, "the second row's label: {second:?}");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn overlapping_labels_give_way_by_priority() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, vec![0.0, 4.0], vec![1.0, 5.0]);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    let shared = at(&pixels, c + 20, c);
    assert!(shared[2] > 200 && shared[0] < 60, "the higher priority label shows: {shared:?}");
    let only_first = at(&pixels, c + 7, c);
    assert!(only_first[0] < 60, "the lower one gave way: {only_first:?}");
}
