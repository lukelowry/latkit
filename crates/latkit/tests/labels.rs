//! Labels show beside their rows once the host sets their texts, or inside a block while they fit;
//! where two would overlap, the one of higher priority shows, and only labels that show have their
//! texts set. A diagram's labels scale with the sheet and fade out once too small to read.

#![cfg(feature = "gpu")]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{SIZE, at, camera, diagram, errors, frame, gpu, plain_theme, plane};
use latkit::Ids;
use latkit::host::{Host, Raster, TextRun};
use latkit::{Camera, Color, Data, Label, Marker, Scene, Table, Vertices, View, field};

/// Sets a text as a solid box six tenths of its size wide per character, as tall as its size.
struct Boxes;

impl Host for Boxes {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        let size = [(0.6 * (run.text.chars().count() as u32 * run.size_px) as f32) as u32, run.size_px];
        Ok(Raster { size, coverage: vec![255; (size[0] * size[1]) as usize], baseline: size[1] as f32 * 0.8 })
    }
}

/// Boxes, counting the texts it sets.
struct Counted(Arc<AtomicUsize>);

impl Host for Counted {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Boxes.rasterize(run)
    }

    // Measuring sets no text.
    fn measure(&self, run: &TextRun) -> latkit::Result<[f32; 2]> {
        Boxes.measure(run)
    }
}

fn view(gpu: &latkit::Gpu, x: Vec<f64>, priority: Vec<f64>) -> View {
    shown(gpu, x, priority, |v| v.radius(2.0))
}

fn shown(gpu: &latkit::Gpu, x: Vec<f64>, priority: Vec<f64>, shape: impl Fn(Vertices) -> Vertices) -> View {
    gpu.set_host(Boxes);
    let mut data = Data::new("d");
    let n = x.len();
    data.apply(
        Table::new("V", Ids::count(n as u32))
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
        .draw(shape(Vertices::of("d", "V").position("x", "y")).pick(false).label(label));
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
fn a_color_changing_every_frame_leaves_labels_placed() {
    let Some(gpu) = gpu() else { return };
    // A pulse reads the clock, so the mark evaluates every frame; nothing that places its labels moved.
    let pulse = latkit::elapsed().sin().colormap(latkit::Colormap::VIRIDIS).domain(-1.0..=1.0);
    let mut view = shown(&gpu, vec![-50.0, 10.0], vec![0.0, 0.0], |v| v.radius(2.0).color(pulse.clone()));
    for _ in 0..30 {
        common::step(&gpu, &mut view);
    }
    assert!(view.complete(), "waiting on {}", view.stats().waiting);
}

#[test]
fn a_block_holds_its_label_while_it_fits() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    let green = Color::rgb(0.0, 1.0, 0.0);
    // The label is 36 by 10 pixels: a 60 by 20 block holds it, a 20 by 20 one does not.
    let mut wide = shown(&gpu, vec![0.0], vec![0.0], |v| v.size(60.0, 20.0).color(green));
    let middle = at(&frame(&gpu, &mut wide), c, c);
    assert!(middle[0] > 200 && middle[1] < 60, "the label inside: {middle:?}");
    let mut narrow = shown(&gpu, vec![0.0], vec![0.0], |v| v.size(20.0, 20.0).color(green));
    let middle = at(&frame(&gpu, &mut narrow), c, c);
    assert!(middle[1] > 200 && middle[0] < 60, "only the block: {middle:?}");
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

#[test]
fn only_labels_that_show_have_their_texts_set() {
    let Some(gpu) = gpu() else { return };
    let set = Arc::new(AtomicUsize::new(0));
    gpu.set_host(Counted(set.clone()));
    // Two thousand rows in view, each named apart: far more labels than fit.
    let n = 2000;
    let x: Vec<f64> = (0..n).map(|i| f64::from((i * 37) % 120) - 60.0).collect();
    let y: Vec<f64> = (0..n).map(|i| f64::from((i * 53) % 120) - 60.0).collect();
    let names: Vec<String> = (0..n).map(|i| format!("row {i}")).collect();
    let mut data = Data::new("d");
    data.apply(Table::new("V", Ids::count(n as u32)).field("x", x).field("y", y).field("name", names)).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("d", "V")
            .position("x", "y")
            .radius(1.0)
            .color(Color::rgb(0.0, 0.0, 1.0))
            .pick(false)
            .label(Label::new("name").size(10.0).color(Color::rgb(1.0, 0.0, 0.0))),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let count = set.load(Ordering::Relaxed);
    assert!(count > 0 && count < 200, "texts set: {count}");
    let red = pixels.iter().filter(|p| p[0] > 200 && p[1] < 60).count();
    assert!(red > 200, "labels show: {red} pixels");
    assert_eq!(errors(&mut view), Vec::new());
}

/// A block in a diagram, 60 by 20 units, labeled in red at size 10, seen at `zoom`.
fn diagram_block(gpu: &latkit::Gpu, zoom: f64) -> Vec<[u8; 4]> {
    gpu.set_host(Boxes);
    let mut data = Data::new("d");
    data.apply(
        Table::new("V", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("name", vec!["abcdef"]),
    )
    .expect("valid");
    let label = Label::new("name").size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let scene = Scene::new(diagram()).theme(latkit::Theme { halo: 0.0, ..plain_theme() }).draw(
        Vertices::of("d", "V")
            .position("x", "y")
            .size(60.0, 20.0)
            .marker(Marker::block())
            .color(Color::rgb(0.0, 1.0, 0.0))
            .pick(false)
            .label(label),
    );
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom, pitch: 0.0, bearing: 0.0 });
    view.set_data(data);
    let pixels = frame(gpu, &mut view);
    assert_eq!(errors(&mut view), Vec::new());
    pixels
}

#[test]
fn diagram_labels_scale_with_the_sheet() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    let red = |p: [u8; 4]| p[0] > 200 && p[1] < 60;
    // At zoom 0 the label is 36 by 10 pixels; at zoom 1 twice that, still inside its block.
    let near = diagram_block(&gpu, 0.0);
    assert!(red(at(&near, c + 15, c)) && !red(at(&near, c + 21, c)), "36 wide at zoom 0");
    let closer = diagram_block(&gpu, 1.0);
    assert!(red(at(&closer, c + 33, c)) && !red(at(&closer, c + 39, c)), "72 wide at zoom 1");
}

#[test]
fn diagram_labels_fade_once_too_small_to_read() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    // At zoom −2 the text is 2.5 pixels tall: past reading, it is gone, and the block shows.
    let far = diagram_block(&gpu, -2.0);
    let middle = at(&far, c, c);
    assert!(middle[1] > 120 && middle[0] < 60, "only the block: {middle:?}");
}

#[test]
fn a_cap_shows_only_the_labels_of_highest_priority() {
    let Some(gpu) = gpu() else { return };
    let set = Arc::new(AtomicUsize::new(0));
    gpu.set_host(Counted(set.clone()));
    // Four rows one above another, apart enough that none would give way, priorities rising upward.
    let ys = [-45.0, -15.0, 15.0, 45.0];
    let mut data = Data::new("d");
    data.apply(
        Table::new("V", Ids::count(4))
            .field("x", vec![-30.0; 4])
            .field("y", ys.to_vec())
            .field("name", vec!["abc", "bcd", "cde", "def"])
            .field("p", vec![1.0, 2.0, 3.0, 4.0]),
    )
    .expect("valid");
    let label = Label::new("name").size(10.0).priority(field("p")).color(Color::rgb(1.0, 0.0, 0.0)).max(2);
    let marks = Vertices::of("d", "V").position("x", "y").radius(1.0).color(Color::rgb(0.0, 0.0, 1.0)).pick(false);
    let scene = Scene::new(plane()).theme(latkit::Theme { halo: 0.0, ..plain_theme() }).draw(marks.label(label));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // The plane runs y up; each label starts beside its marker.
    let labeled = |y: f64| {
        let row = (f64::from(c) - y) as u32;
        (c - 30 + 4..c - 30 + 20).any(|x| at(&pixels, x, row)[0] > 200)
    };
    assert!(labeled(45.0) && labeled(15.0), "the two of highest priority show");
    assert!(!labeled(-15.0) && !labeled(-45.0), "the rest give way to the cap");
    assert_eq!(set.load(Ordering::Relaxed), 2, "only the labels shown have their texts set");
    assert_eq!(errors(&mut view), Vec::new());
}
