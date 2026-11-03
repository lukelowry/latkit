//! Guides and failures. A legend on a side takes room from the marks, so a fit frames them clear of
//! it. Text aligns by its line box, whatever the host pads its raster with. A twin mark draws
//! nothing, and a picture draws a view with failures as the view does.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, frame, gpu, plain_theme, plane};
use latkit::host::{Host, Raster, TextRun};
use latkit::{Color, Data, Fit, Ids, Legend, Place, Scene, Shot, Table, Vertices, View, field};

/// Two vertices 100 units apart, colored through viridis.
fn pair() -> Data {
    let data = Data::new("d");
    let table = Table::new("V", Ids::count(2)).field("x", vec![-50.0, 50.0]).field("y", vec![0.0, 0.0]);
    data.apply(table.field("v", vec![0.0, 1.0])).expect("valid");
    data
}

fn dots(legend: Legend) -> Scene {
    let color = field("v").colormap(latkit::Colormap::VIRIDIS).domain(0.0..=1.0);
    Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("d", "V").position(field("x"), field("y")).radius(4.0).color(color).legend(legend))
}

#[test]
fn a_legend_on_a_side_takes_room_from_a_fit() {
    let Some(gpu) = gpu() else { return };
    let data = pair();
    // Where the right vertex lands once a fit frames both.
    let right = |scene: Scene| {
        let mut view = View::new(&gpu, scene);
        view.set_sources([&data]).expect("a source");
        view.fit(Fit::All);
        frame(&gpu, &mut view);
        view.screen([50.0, 0.0, 0.0]).expect("in view")[0]
    };
    let over = right(dots(Legend::new("v")));
    let beside = right(dots(Legend::new("v").place(Place::Right)));
    assert!(beside + 20.0 < over, "the legend's room moves the fit left: {beside} beside, {over} over");
}

/// A host that rasterizes text as a solid box `size` tall and 0.6 × size wide per character, with 2
/// blank pixels on each side, as a font host pads every run.
struct Padded;

impl Host for Padded {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        let width = (0.6 * (run.text.chars().count() as u32 * run.size_px) as f32) as u32;
        let size = [width + 4, run.size_px];
        let mut coverage = vec![0; (size[0] * size[1]) as usize];
        for row in coverage.chunks_mut(size[0] as usize) {
            row[2..2 + width as usize].fill(255);
        }
        let line_box = [2.0, 0.0, (width + 2) as f32, size[1] as f32];
        Ok(Raster { size, coverage, baseline: size[1] as f32 * 0.8, line_box })
    }
}

#[test]
fn a_title_aligns_its_text_with_the_padding() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Padded);
    let theme =
        latkit::Theme { text: latkit::TextTheme { color: Color::WHITE, ..plain_theme().text }, ..plain_theme() };
    let mut view = View::new(&gpu, Scene::new(plane()).theme(theme).title("Grid"));
    view.set_camera(common::camera());
    let pixels = frame(&gpu, &mut view);
    // The text starts 1.5 ems, 16.5 pixels at 11-pixel text, from the view's top left, without the
    // padding of its raster or of its distance field.
    let lit = |x: u32, y: u32| at(&pixels, x, y)[0] > 128;
    let left = (0..SIZE).find(|&x| (0..SIZE / 2).any(|y| lit(x, y))).expect("a title");
    let top = (0..SIZE / 2).find(|&y| (0..SIZE).any(|x| lit(x, y))).expect("a title");
    assert!((16..=17).contains(&left) && (16..=17).contains(&top), "the title starts at ({left}, {top})");
}

#[test]
fn a_twin_mark_draws_nothing_and_the_rest_draws() {
    let Some(gpu) = gpu() else { return };
    let data = pair();
    let dot = Vertices::of("d", "V").position(field("x"), field("y")).radius(6.0).color(Color::WHITE);
    let scene = Scene::new(plane()).theme(plain_theme()).draw(dot.clone()).draw(dot.clone().radius(20.0));
    let mut view = View::new(&gpu, scene.clone());
    view.set_camera(common::camera());
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    let failures: Vec<String> = view.failures().map(|f| f.to_string()).collect();
    assert_eq!(failures, ["marks[1]: draws the same table as an earlier mark of its kind. Give one a `name`."]);
    let c = SIZE / 2;
    assert!(at(&pixels, c + 50, c)[0] > 200, "the first mark draws");
    assert!(at(&pixels, c + 60, c)[0] < 60, "its twin, 20 pixels wide, does not");
    // The same scene again keeps the first mark and its twin apart.
    view.set_scene(scene);
    frame(&gpu, &mut view);
    assert_eq!(view.failures().count(), 1);
    view.set_scene(Scene::new(plane()).theme(plain_theme()).draw(dot.clone()).draw(dot.radius(20.0).named("big")));
    let pixels = frame(&gpu, &mut view);
    assert_eq!(view.failures().count(), 0, "a name tells them apart");
    assert!(at(&pixels, c + 60, c)[0] > 200, "and both draw");
}

#[test]
fn a_picture_draws_a_view_with_failures_as_the_view_does() {
    let Some(gpu) = gpu() else { return };
    let data = pair();
    // A color that reads a missing field draws as if unset, in the theme's vertex color.
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("d", "V").position(field("x"), field("y")).radius(6.0).color(field("missing")));
    let mut view = View::new(&gpu, scene);
    view.set_camera(common::camera());
    view.set_sources([&data]).expect("a source");
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).image(&mut [&mut view])).expect("a picture");
    let c = SIZE / 2;
    let i = ((c * SIZE + c + 50) * 4) as usize;
    assert!(image.rgba[i..i + 3].iter().any(|&v| v > 60), "the vertex draws: {:?}", &image.rgba[i..i + 4]);
    assert_eq!(view.failures().count(), 1, "and its color is listed");
}
