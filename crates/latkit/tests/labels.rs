//! Labels show beside their rows once the host rasterizes their text, or inside a block while they
//! fit. Where labels would overlap, the label of the row drawn on top shows. An empty text gives no
//! label. Only labels that show near the view have their text rasterized, so a dense view settles.
//! A conditional text labels only the rows it names, a number label writes its value, and a label
//! keeps showing while its mark gains texts.

#![cfg(feature = "gpu")]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{SETTLE, SIZE, at, camera, errors, frame, gpu, haloless, plain_theme, plane, step};
use latkit::Ids;
use latkit::host::{Host, Raster, TextRun};
use latkit::{Color, Data, Edges, Expr, Label, Patch, Scene, Table, Vertices, View, field, when};

/// A host that rasterizes text as a solid box, 0.6 × size wide per character and `size` tall.
struct Boxes;

impl Host for Boxes {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        let size = [(0.6 * (run.text.chars().count() as u32 * run.size_px) as f32) as u32, run.size_px];
        let line_box = [0.0, 0.0, size[0] as f32, size[1] as f32];
        Ok(Raster { size, coverage: vec![255; (size[0] * size[1]) as usize], baseline: size[1] as f32 * 0.8, line_box })
    }
}

/// `Boxes` with 2 blank pixels on each side, as a font host pads every run, so an empty text
/// rasterizes to a blank box.
struct Padded;

impl Host for Padded {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        let inner = Boxes.rasterize(run)?;
        let size = [inner.size[0] + 4, inner.size[1]];
        let mut coverage = vec![0; (size[0] * size[1]) as usize];
        for (row, line) in inner.coverage.chunks(inner.size[0].max(1) as usize).enumerate() {
            let at = row * size[0] as usize + 2;
            coverage[at..at + line.len()].copy_from_slice(line);
        }
        let [l, t, r, b] = inner.line_box;
        Ok(Raster { size, coverage, baseline: inner.baseline, line_box: [l + 2.0, t, r + 2.0, b] })
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
    let mut view = View::new(gpu, scene);
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
fn panning_reclaims_labels_for_rows_entering_the_view() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, vec![0.0, 500.0]);
    let c = SIZE / 2;
    let first = at(&frame(&gpu, &mut view), c + 12, c);
    assert!(first[0] > 200 && first[2] < 60, "the initial row's label: {first:?}");
    let latkit::Camera::Map { zoom, pitch, bearing, .. } = camera() else { unreachable!() };
    view.set_camera(latkit::Camera::Map { center: [500.0, 0.0, 0.0], zoom, pitch, bearing });
    let entered = at(&frame(&gpu, &mut view), c + 12, c);
    assert!(entered[2] > 200 && entered[0] < 60, "the entering row's label: {entered:?}");
    view.set_camera(camera());
    let returned = at(&frame(&gpu, &mut view), c + 12, c);
    assert!(returned[0] > 200 && returned[2] < 60, "the returning row's label: {returned:?}");
}

#[test]
fn an_edge_label_follows_its_unlabeled_endpoints() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    let data = Data::new("d");
    data.apply(
        Patch::new().set(Table::new("V", Ids::count(2)).field("x", vec![-40.0, 40.0]).field("y", vec![-25.0; 2])).set(
            Table::new("E", Ids::count(1))
                .reference("from", "V", vec![0_u64])
                .reference("to", "V", vec![1_u64])
                .field("name", vec!["abcdef"]),
        ),
    )
    .expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let scene = Scene::new(plane())
        .theme(haloless())
        .ease(std::time::Duration::ZERO)
        .draw(Vertices::of("d", "V").position(field("x"), field("y")).radius(2.0).pick(false))
        .draw(Edges::of("d", "E").ends("from", "to").width(1.0).pick(false).label(label));
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let c = SIZE / 2;
    let initial = frame(&gpu, &mut view);
    assert!(at(&initial, c, c + 25)[0] > 200, "the edge is labeled at its first position");
    // The edge's own fields are unchanged. Only the mark supplying its endpoints moves.
    data.apply(Table::new("V", Ids::count(2)).field("y", vec![25.0; 2])).expect("valid");
    let moved = frame(&gpu, &mut view);
    let label = at(&moved, c, c - 25);
    assert!(label[0] > 200 && label[1] < 60, "the label follows its endpoints: {label:?}");
    assert!(at(&moved, c, c + 25)[0] < 60, "no label remains at the old position");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_label_follows_every_frame_of_its_rows_transition() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(1)).field("x", vec![-35.0]).field("name", vec!["abc"])).expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let scene = Scene::new(plane()).theme(haloless()).ease(std::time::Duration::from_millis(400)).draw(
        Vertices::of("d", "V")
            .position(field("x"), 0.0)
            .radius(4.0)
            .color(Color::rgb(0.0, 1.0, 0.0))
            .pick(false)
            .label(label),
    );
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    data.apply(Table::new("V", Ids::count(1)).field("x", vec![15.0])).expect("valid");
    let mut positions = Vec::new();
    for _ in 0..30 {
        let pixels = step(&gpu, &mut view);
        let row = |x| at(&pixels, x, SIZE / 2);
        let marker: Vec<_> = (0..SIZE)
            .filter(|&x| {
                let p = row(x);
                p[1] > 200 && p[0] < 60
            })
            .collect();
        let text = (0..SIZE)
            .find(|&x| {
                let p = row(x);
                p[0] > 200 && p[1] < 60
            })
            .expect("the text shows");
        let center =
            (marker.first().expect("the marker shows") + marker.last().expect("the marker shows")) as f32 / 2.0;
        assert!((text as f32 - center - 8.0).abs() < 2.0, "label {text} follows marker {center}");
        positions.push(center.round() as u32);
    }
    positions.dedup();
    assert!(positions.len() > 5, "the assertion covers intermediate positions: {positions:?}");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn dense_label_draws_keep_the_same_winners_as_a_small_scene() {
    let Some(gpu) = gpu() else { return };
    // Enough offscreen rows switch glyph enumeration from rows to collision cells. The visible
    // rows include an overlap and several labels spanning multiple cells; each winner draws once.
    let visible = vec![-50.0, -46.0, 10.0, 14.0];
    let mut sparse = view(&gpu, visible.clone());
    let expected = frame(&gpu, &mut sparse);
    let mut many = visible;
    many.resize(2000, 10_000.0);
    let mut dense = view(&gpu, many);
    let actual = frame(&gpu, &mut dense);
    assert!(actual.iter().zip(&expected).all(|(&a, &b)| common::close(a, b)), "cell enumeration preserves the image");
    assert_eq!(errors(&mut dense), Vec::new());
    // Moving the camera changes the first winning cells, including labels clipped by the edge.
    let latkit::Camera::Map { zoom, pitch, bearing, .. } = camera() else { unreachable!() };
    for center in [[-30.0, 0.0, 0.0], [20.0, 0.0, 0.0]] {
        let moved = latkit::Camera::Map { center, zoom, pitch, bearing };
        sparse.set_camera(moved);
        dense.set_camera(moved);
        let expected = frame(&gpu, &mut sparse);
        let actual = frame(&gpu, &mut dense);
        assert!(actual.iter().zip(&expected).all(|(&a, &b)| common::close(a, b)), "panned claims preserve the image");
    }
}

#[test]
fn a_label_moves_outward_when_its_hovered_marker_grows() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(1)).field("name", vec!["abc"])).expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let scene = Scene::new(plane())
        .theme(haloless())
        .draw(Vertices::of("d", "V").position(0.0, 0.0).radius(10.0).color(Color::rgb(0.0, 1.0, 0.0)).label(label));
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let first = |pixels: &[[u8; 4]]| {
        (0..SIZE)
            .find(|&x| {
                let p = at(pixels, x, SIZE / 2);
                p[0] > 200 && p[1] < 60
            })
            .expect("the text shows")
    };
    let normal = first(&frame(&gpu, &mut view));
    let pointer = |point| latkit::Input::Move {
        pointer: 1,
        point,
        modifiers: latkit::Modifiers::default(),
        device: latkit::Device::Mouse,
    };
    view.input(&pointer([SIZE as f32 / 2.0; 2]), common::now());
    let hovered = first(&frame(&gpu, &mut view));
    assert!(hovered > normal, "the growing marker moves its label outward: {normal} -> {hovered}");
    view.input(&pointer([0.0; 2]), common::now());
    assert_eq!(first(&frame(&gpu, &mut view)), normal, "the label returns when the hover leaves");
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
    gpu.set_host(Padded);
    let c = SIZE / 2;
    // The rows of the overlap above, with the second row's text empty: it draws on top but has no
    // label, so the first row's label shows.
    let data = Data::new("d");
    let rows = Table::new("V", Ids::count(2)).field("x", vec![0.0, 4.0]).field("y", vec![0.0; 2]);
    data.apply(rows.field("name", vec!["abcdef", ""])).expect("valid");
    let label = Label::new(field("name")).size(10.0).color(Color::rgb(1.0, 0.0, 0.0));
    let mark = Vertices::of("d", "V").position(field("x"), field("y")).radius(2.0).pick(false).label(label);
    let mut view = View::new(&gpu, Scene::new(plane()).theme(haloless()).draw(mark));
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
    let mut view = View::new(&gpu, scene);
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
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert!(view.complete(), "waiting on {}", view.waiting());
    // A 128 pixel square holds a few dozen labels 10 pixels tall.
    let texts = set.load(Ordering::Relaxed);
    assert!(texts < 200, "texts for the labels that fit: {texts}");
}

#[test]
fn a_one_row_label_edit_evaluates_one_page() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    // Twenty thousand labeled rows (five pages), drawn with the default ease.
    let n = 20_000;
    let x: Vec<f64> = (0..n).map(|i| f64::from((i * 37) % 128) - 64.0).collect();
    let y: Vec<f64> = (0..n).map(|i| f64::from((i * 53) % 128) - 64.0).collect();
    let names: Vec<String> = (0..n).map(|i| format!("row {i}")).collect();
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(n as u32)).field("x", x).field("y", y).field("name", names)).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("d", "V").position(field("x"), field("y")).radius(1.0).label(Label::new(field("name")).size(10.0)),
    );
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    let before = gpu.work();
    data.apply(Table::new("V", vec![7_u64]).field("name", vec!["renamed"])).expect("valid");
    frame(&gpu, &mut view);
    // A text never eases, so the edit starts no transition: only its page evaluates.
    let work = gpu.work() - before;
    assert!(work.evaluated <= 4096, "only one page evaluates: {}", work.evaluated);
    assert_eq!(errors(&mut view), Vec::new());
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
    let mut view = View::new(&gpu, scene);
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
fn a_number_label_writes_its_value_as_an_axis_writes_ticks() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Boxes);
    // Boxes sets each character as a box about 6 pixels wide: "12.34%", "3e7%", and "-0.5%".
    let data = Data::new("d");
    let rows = Table::new("V", Ids::count(3)).field("x", vec![-60.0, -15.0, 25.0]).field("y", vec![0.0; 3]);
    data.apply(rows.field("v", vec![12.345, 3.0e7, -0.5])).expect("valid");
    let label = Label::new(field("v")).size(10.0).unit("%").color(Color::rgb(1.0, 0.0, 0.0));
    let marks = Vertices::of("d", "V").position(field("x"), field("y")).radius(2.0).pick(false);
    let scene = Scene::new(plane()).theme(haloless()).draw(marks.color(Color::rgb(0.0, 0.0, 1.0)).label(label));
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // Each label's width: from its first red pixel to its last.
    let width = |columns: std::ops::Range<u32>| {
        let red: Vec<u32> = columns.filter(|&x| at(&pixels, x, c)[0] > 200).collect();
        red.last().zip(red.first()).map_or(0.0, |(last, first)| (last - first + 1) as f32)
    };
    let widths = [width(c - 60..c - 15), width(c - 15..c + 25), width(c + 25..SIZE)];
    let chars = [6.0, 4.0, 5.0];
    assert!(widths.iter().zip(chars).all(|(w, n)| (w - n * 6.0).abs() <= 2.5), "{widths:?}");
    assert!(view.complete(), "waiting on {}", view.waiting());
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
    let mut view = View::new(&gpu, scene);
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
