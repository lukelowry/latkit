//! Labels show beside their rows once the host rasterizes their text, or inside a block while they
//! fit. Where labels would overlap, the label of the row drawn on top shows, an empty text gives no
//! label, and only labels that
//! show near the view have their text rasterized, so a dense view settles. A conditional text labels
//! only the rows it names, and a label keeps showing while its mark gains texts. A diagram's labels
//! scale with the sheet and fade out once too small to read.

#![cfg(feature = "gpu")]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{SETTLE, SIZE, at, camera, diagram, errors, frame, gpu, haloless, plain_theme, plane, step};
use latkit::Ids;
use latkit::host::{Host, Raster, TextRun};
use latkit::{Camera, Color, Data, Expr, Label, Marker, Scene, Table, Vertices, View, field, when};

/// A host that rasterizes text as a solid box, 0.6 × size wide per character and `size` tall.
struct Boxes;

impl Host for Boxes {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        let size = [(0.6 * (run.text.chars().count() as u32 * run.size_px) as f32) as u32, run.size_px];
        Ok(Raster { size, coverage: vec![255; (size[0] * size[1]) as usize], baseline: size[1] as f32 * 0.8 })
    }
}

/// `Boxes`, counting the texts it rasterizes.
struct Counted(Arc<AtomicUsize>);

impl Host for Counted {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Boxes.rasterize(run)
    }
}

fn view(gpu: &latkit::Gpu, x: Vec<f64>) -> View {
    shown(gpu, x, |v| v.radius(2.0))
}

fn shown(gpu: &latkit::Gpu, x: Vec<f64>, shape: impl Fn(Vertices) -> Vertices) -> View {
    gpu.set_host(Boxes);
    let data = Data::new("d");
    let n = x.len();
    data.apply(
        Table::new("V", Ids::count(n as u32))
            .field("x", x)
            .field("y", vec![0.0; n])
            .field("name", vec!["abcdef"; n])
            .field("hue", (0..n).map(|i| i as f64).collect::<Vec<_>>()),
    )
    .expect("valid");
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);
    let label = Label::new(field("name")).size(10.0).color(when(field("hue").lt(0.5)).then(red).otherwise(blue));
    let scene = Scene::new(plane())
        .theme(haloless())
        .draw(shape(Vertices::of("d", "V").position(field("x"), field("y"))).pick(false).label(label));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    view
}

#[test]
fn labels_show_beside_their_rows() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, vec![-50.0, 10.0]);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // A label starts four pixels past its marker's right edge, vertically centered on it.
    let first = at(&pixels, c - 50 + 12, c);
    let second = at(&pixels, c + 10 + 12, c);
    assert!(first[0] > 200 && first[2] < 60, "the first row's label: {first:?}");
    assert!(second[2] > 200 && second[0] < 60, "the second row's label: {second:?}");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_color_changing_every_frame_leaves_labels_placed() {
    let Some(gpu) = gpu() else { return };
    // A pulse reads the clock, so the mark evaluates every frame, but nothing that places its
    // labels moves.
    let pulse = latkit::elapsed().sin().colormap(latkit::Colormap::VIRIDIS).domain(-1.0..=1.0);
    let mut view = shown(&gpu, vec![-50.0, 10.0], |v| v.radius(2.0).color(pulse.clone()));
    for _ in 0..30 {
        step(&gpu, &mut view);
    }
    assert!(view.complete(), "waiting on {}", view.waiting());
}

#[test]
fn a_block_shows_its_label_inside_while_it_fits() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    let green = Color::rgb(0.0, 1.0, 0.0);
    // The label is 36 by 10 pixels. A 60 by 20 block fits it, and a 20 by 20 block does not.
    let mut wide = shown(&gpu, vec![0.0], |v| v.size(60.0, 20.0).color(green));
    let middle = at(&frame(&gpu, &mut wide), c, c);
    assert!(middle[0] > 200 && middle[1] < 60, "the label inside: {middle:?}");
    let mut narrow = shown(&gpu, vec![0.0], |v| v.size(20.0, 20.0).color(green));
    let middle = at(&frame(&gpu, &mut narrow), c, c);
    assert!(middle[1] > 200 && middle[0] < 60, "only the block: {middle:?}");
}

#[test]
fn where_labels_would_overlap_the_row_drawn_on_top_shows_its_label() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    // The two labels, each 36 pixels wide, would start 4 pixels apart: the first red, the second
    // blue. The second row draws on top, so its label shows and the first's does not.
    let pixels = frame(&gpu, &mut view(&gpu, vec![0.0, 4.0]));
    let first = at(&pixels, c + 7, c);
    assert!(first[0] < 60, "no first label: {first:?}");
    let second = at(&pixels, c + 20, c);
    assert!(second[2] > 200 && second[0] < 60, "the second label: {second:?}");
    // Given a higher priority, the first row draws on top instead, and its label shows.
    let mut first_on_top = shown(&gpu, vec![0.0, 4.0], |v| v.radius(2.0).priority(-field("hue")));
    let pixels = frame(&gpu, &mut first_on_top);
    let first = at(&pixels, c + 7, c);
    assert!(first[0] > 200 && first[2] < 60, "the first label: {first:?}");
    let after = at(&pixels, c + 44, c);
    assert!(after[2] < 60, "no second label past the first: {after:?}");
}

#[test]
fn an_empty_text_gives_no_label_and_claims_no_room() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    let c = SIZE / 2;
    // The rows of the overlap above, with the second row's text empty: it draws on top but has no
    // label, so the first row's label shows.
    let data = Data::new("d");
    let rows = Table::new("V", Ids::count(2)).field("x", vec![0.0, 4.0]).field("y", vec![0.0; 2]);
    data.apply(rows.field("name", vec!["abcdef", ""])).expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let mark = Vertices::of("d", "V").position(field("x"), field("y")).radius(2.0).pick(false).label(label);
    let mut view = View::new(&gpu, Scene::new(plane()).theme(haloless()).draw(mark)).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let first = at(&frame(&gpu, &mut view), c + 7, c);
    assert!(first[0] > 200, "the first label: {first:?}");
    assert!(view.complete(), "waiting on {}", view.waiting());
}

#[test]
fn only_labels_that_show_near_the_view_have_their_text_rasterized() {
    let Some(gpu) = gpu() else { return };
    let set = Arc::new(AtomicUsize::new(0));
    gpu.set_host(Counted(set.clone()));
    // Two thousand rows, each with a distinct name: forty crowded in view, the rest far beyond it.
    let n = 2000;
    let x: Vec<f64> =
        (0..n).map(|i| if i < 40 { f64::from((i * 37) % 120) - 60.0 } else { 10_000.0 + f64::from(i) }).collect();
    let y: Vec<f64> = (0..n).map(|i| f64::from((i * 53) % 120) - 60.0).collect();
    let names: Vec<String> = (0..n).map(|i| format!("row {i}")).collect();
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(n as u32)).field("x", x).field("y", y).field("name", names)).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("d", "V")
            .position(field("x"), field("y"))
            .radius(1.0)
            .color(Color::rgb(0.0, 0.0, 1.0))
            .pick(false)
            .label(Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0))),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    // Only the labels that keep their room among the forty need texts.
    let texts = set.load(Ordering::Relaxed);
    assert!((1..40).contains(&texts), "some of the texts of the rows in view, and no others: {texts}");
    let red = pixels.iter().filter(|p| p[0] > 200 && p[1] < 60).count();
    assert!(red > 200, "labels show: {red} pixels");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_dense_view_settles_with_texts_for_the_labels_that_fit() {
    let Some(gpu) = gpu() else { return };
    let set = Arc::new(AtomicUsize::new(0));
    gpu.set_host(Counted(set.clone()));
    // Twenty thousand rows with distinct names, all in view: far more texts than the atlas holds.
    let n = 20_000;
    let x: Vec<f64> = (0..n).map(|i| f64::from((i * 37) % 128) - 64.0).collect();
    let y: Vec<f64> = (0..n).map(|i| f64::from((i * 53) % 128) - 64.0).collect();
    let names: Vec<String> = (0..n).map(|i| format!("row {i}")).collect();
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(n as u32)).field("x", x).field("y", y).field("name", names)).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("d", "V")
            .position(field("x"), field("y"))
            .radius(1.0)
            .pick(false)
            .label(Label::new(field("name")).size(10.0)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert!(view.complete(), "waiting on {}", view.waiting());
    // A 128 pixel square holds a few dozen labels 10 pixels tall.
    let texts = set.load(Ordering::Relaxed);
    assert!(texts < 200, "texts for the labels that fit: {texts}");
}

/// A block in a diagram, 60 by 20 units, labeled in red at size 10, seen at `zoom`.
fn diagram_block(gpu: &latkit::Gpu, zoom: f64) -> Vec<[u8; 4]> {
    gpu.set_host(Boxes);
    let data = Data::new("d");
    data.apply(
        Table::new("V", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("name", vec!["abcdef"]),
    )
    .expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let scene = Scene::new(diagram()).theme(haloless()).draw(
        Vertices::of("d", "V")
            .position(field("x"), field("y"))
            .size(60.0, 20.0)
            .marker(Marker::block())
            .color(Color::rgb(0.0, 1.0, 0.0))
            .pick(false)
            .label(label),
    );
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    let pixels = frame(gpu, &mut view);
    assert_eq!(errors(&mut view), Vec::new());
    pixels
}

#[test]
fn diagram_labels_scale_with_the_sheet() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    let red = |p: [u8; 4]| p[0] > 200 && p[1] < 60;
    // At zoom 0 the label is 36 by 10 pixels. At zoom 1 it is twice that, still inside its block.
    let near = diagram_block(&gpu, 0.0);
    assert!(red(at(&near, c + 15, c)) && !red(at(&near, c + 21, c)), "36 wide at zoom 0");
    let closer = diagram_block(&gpu, 1.0);
    assert!(red(at(&closer, c + 33, c)) && !red(at(&closer, c + 39, c)), "72 wide at zoom 1");
}

#[test]
fn diagram_labels_fade_once_too_small_to_read() {
    let Some(gpu) = gpu() else { return };
    let c = SIZE / 2;
    // At zoom −2 the text is 2.5 pixels tall, too small to read, so it hides and the block shows.
    let far = diagram_block(&gpu, -2.0);
    let middle = at(&far, c, c);
    assert!(middle[1] > 120 && middle[0] < 60, "only the block: {middle:?}");
}

#[test]
fn a_conditional_text_labels_only_the_rows_it_names() {
    let Some(gpu) = gpu() else { return };
    let set = Arc::new(AtomicUsize::new(0));
    gpu.set_host(Counted(set.clone()));
    // Four rows stacked vertically, far enough apart not to overlap, `p` rising upward. Only rows
    // with `p` of 3 or more have a text.
    let ys = [-45.0, -15.0, 15.0, 45.0];
    let data = Data::new("d");
    data.apply(
        Table::new("V", Ids::count(4))
            .field("x", vec![-30.0; 4])
            .field("y", ys.to_vec())
            .field("name", vec!["abc", "bcd", "cde", "def"])
            .field("p", vec![1.0, 2.0, 3.0, 4.0]),
    )
    .expect("valid");
    let text = when(field("p").ge(3.0)).then(field("name")).otherwise(Expr::missing());
    let label = Label::new(text).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let marks = Vertices::of("d", "V")
        .position(field("x"), field("y"))
        .radius(1.0)
        .color(Color::rgb(0.0, 0.0, 1.0))
        .pick(false);
    let scene = Scene::new(plane()).theme(haloless()).draw(marks.label(label));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // Y points up on the plane. Each label starts beside its marker.
    let labeled = |y: f64| {
        let row = (f64::from(c) - y) as u32;
        (c - 30 + 4..c - 30 + 20).any(|x| at(&pixels, x, row)[0] > 200)
    };
    assert!(labeled(45.0) && labeled(15.0), "the rows the text names are labeled");
    assert!(!labeled(-15.0) && !labeled(-45.0), "the rest have no label");
    assert_eq!(set.load(Ordering::Relaxed), 2, "only the texts shown are rasterized");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_label_keeps_showing_while_its_mark_gains_texts() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    // Row 0 in view, and `n - 1` more rows with names of their own far beyond it.
    let table = |n: u32| {
        let x: Vec<f64> = (0..n).map(|i| if i == 0 { -50.0 } else { 10_000.0 + f64::from(i) }).collect();
        let names: Vec<String> = (0..n).map(|i| if i == 0 { "abcdef".into() } else { format!("row {i}") }).collect();
        Table::new("V", Ids::count(n)).field("x", x).field("y", vec![0.0; n as usize]).field("name", names)
    };
    let data = Data::new("d");
    data.apply(table(1)).expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let marks = Vertices::of("d", "V").position(field("x"), field("y")).radius(2.0).pick(false);
    let scene = Scene::new(plane()).theme(haloless()).draw(marks.label(label));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let c = SIZE / 2;
    let red = |pixels: &[[u8; 4]]| {
        let p = at(pixels, c - 50 + 12, c);
        p[0] > 200 && p[2] < 60
    };
    assert!(red(&frame(&gpu, &mut view)), "the label shows");
    // Seventy more names outgrow the mark's run table of 64 texts. The table grows, and the label
    // shows in every frame while it does.
    data.apply(table(71)).expect("valid");
    for _ in 0..SETTLE {
        assert!(red(&step(&gpu, &mut view)), "the label shows in every frame");
        if !view.needs_render() {
            return;
        }
    }
    panic!("the view settles within {SETTLE} frames");
}
