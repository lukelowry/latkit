//! Shots: a picture draws what a view shows at a size of its own once it is complete and still,
//! panels compose side by side, a transparent picture keeps its alpha, and a frame tells whether
//! anything stood in for work under way.

#![cfg(feature = "gpu")]

mod common;

use std::time::Duration;

use common::{SIZE, at, camera, close, frame, gpu, plain_theme, plane, step};
use latkit::{Color, Data, Ids, Image, Scene, Shot, Table, Theme, Vertices, View};

const RED: [u8; 4] = [255, 0, 0, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

fn dot(x: f64, color: Color) -> (Scene, Data) {
    let data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![x]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(6.0).color(color));
    (scene, data)
}

fn view(gpu: &latkit::Gpu, scene: Scene, data: &Data) -> View {
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([data]).expect("a source");
    view
}

fn pixel(image: &Image, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * image.size[0] + x) * 4) as usize;
    image.rgba[i..i + 4].try_into().expect("four bytes")
}

#[test]
fn a_picture_draws_what_the_view_shows() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(20.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene, &data);
    let shown = frame(&gpu, &mut view);
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).image(&mut [&mut view])).expect("a picture");
    assert_eq!(image.size, [SIZE, SIZE]);
    for (x, y) in [(SIZE / 2 + 20, SIZE / 2), (SIZE / 2, SIZE / 2), (3, 3)] {
        assert!(close(pixel(&image, x, y), at(&shown, x, y)), "{:?} at {x}, {y}", pixel(&image, x, y));
    }
    assert!(close(pixel(&image, SIZE / 2 + 20, SIZE / 2), RED));
}

#[test]
fn pictures_make_only_what_they_draw_with() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(20.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene, &data);
    let shot = Shot::new([SIZE, SIZE]);
    pollster::block_on(shot.image(&mut [&mut view])).expect("a picture");
    let made = gpu.work().pipelines;
    pollster::block_on(shot.image(&mut [&mut view])).expect("a picture");
    // A picture takes no input, so it never makes the probes a pointer would need, and what it makes
    // it asked for first.
    assert_eq!(gpu.work().pipelines, made, "another picture makes nothing");
    assert_eq!(gpu.work().late, 0, "nothing made where it was first used");
}

#[test]
fn a_scaled_picture_draws_the_same_view_sharper() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(20.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene, &data);
    let image =
        pollster::block_on(Shot::new([2 * SIZE, 2 * SIZE]).scale(2.0).image(&mut [&mut view])).expect("a picture");
    assert_eq!(image.size, [2 * SIZE, 2 * SIZE]);
    // The same CSS layout at twice the pixels: the dot sits twice as far out, in twice the pixels.
    assert!(close(pixel(&image, SIZE + 40, SIZE), RED), "{:?}", pixel(&image, SIZE + 40, SIZE));
    assert!(close(pixel(&image, SIZE + 40 + 10, SIZE), RED), "a radius of 6 CSS pixels is 12 pixels");
    assert!(close(pixel(&image, SIZE, SIZE), BLACK));
}

#[test]
fn panels_compose_side_by_side() {
    let Some(gpu) = gpu() else { return };
    let (red_scene, red) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let (blue_scene, blue) = dot(0.0, Color::rgb(0.0, 0.0, 1.0));
    let mut left = view(&gpu, red_scene, &red);
    let mut right = view(&gpu, blue_scene, &blue);
    let shot = Shot::new([2 * SIZE, SIZE]).panels([[0.0, 0.0, 0.5, 1.0], [0.5, 0.0, 0.5, 1.0]]);
    let image = pollster::block_on(shot.image(&mut [&mut left, &mut right])).expect("a picture");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), RED), "{:?}", pixel(&image, SIZE / 2, SIZE / 2));
    assert!(close(pixel(&image, SIZE + SIZE / 2, SIZE / 2), [0, 0, 255, 255]));
    assert!(close(pixel(&image, SIZE, SIZE / 2), BLACK), "each panel's own background between");
    assert_eq!(gpu.work().late, 0, "what composes the panels was asked for first");
    let wrong = pollster::block_on(shot.image(&mut [&mut left]));
    assert!(wrong.is_err(), "a view per panel");
}

#[test]
fn a_transparent_picture_keeps_its_alpha() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let scene = scene.theme(Theme { background: Color::TRANSPARENT, ..plain_theme() });
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).transparent().image(&mut [&mut view])).expect("a picture");
    assert_eq!(pixel(&image, 3, 3)[3], 0, "nothing drawn is clear");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), RED), "{:?}", pixel(&image, SIZE / 2, SIZE / 2));
    let png = Image::from_png(&image.encode(latkit::ImageFormat::Png).expect("written")).expect("a PNG");
    assert_eq!(png, image);
}

#[test]
fn a_picture_waits_for_what_eases_to_land() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene.ease(Duration::from_secs(2)), &data);
    frame(&gpu, &mut view);
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![40.0])).expect("valid");
    step(&gpu, &mut view);
    assert!(view.needs_render(), "the dot eases over two seconds");
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).image(&mut [&mut view])).expect("a picture");
    assert!(close(pixel(&image, SIZE / 2 + 40, SIZE / 2), RED), "the picture shows where it lands");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), BLACK));
}

#[test]
fn a_frame_tells_whether_anything_stood_in() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    assert!(!view.complete(), "nothing drawn yet");
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert!(view.complete());
    let waiting = view.waiting();
    assert!(waiting.is_empty(), "waiting on {waiting}");
}

#[test]
fn timeouts_and_font_errors_return_the_view_without_a_partial_image() {
    use latkit::host::{Host, Raster, TextRun};
    struct BrokenText;
    impl Host for BrokenText {
        fn rasterize(&self, _: &TextRun) -> latkit::Result<Raster> {
            Err(latkit::Error::Unsupported("test font failure".into()))
        }
    }
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene, &data);
    let result = pollster::block_on(Shot::new([33, 35]).deadline(Some(Duration::ZERO)).image(&mut [&mut view]));
    assert_eq!(result.unwrap_err(), latkit::Error::Timeout);
    assert!(!view.lent());
    gpu.set_host(BrokenText);
    let data = Data::new("labels");
    data.apply(Table::new("Node", Ids::count(1)).field("name", vec!["Hello"])).unwrap();
    let scene =
        Scene::new(latkit::Diagram::default()).draw(Vertices::of("labels", "Node").label(latkit::Label::new("name")));
    view.set_scene(scene).unwrap();
    view.set_sources([&data]).expect("a source");
    let error = pollster::block_on(Shot::new([128, 128]).image(&mut [&mut view])).unwrap_err();
    assert!(error.to_string().contains("test font failure"));
    assert!(!view.lent());
    assert!(view.events().any(|event| matches!(event, latkit::Event::Error(_))));
}

#[test]
fn fixed_effect_time_is_repeatable_and_independent_of_capture_steps() {
    let Some(gpu) = gpu() else { return };
    let (_, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let scene = Scene::new(plane()).theme(plain_theme()).ease(Duration::ZERO).draw(
        Vertices::of("graph", "Node")
            .position("x", "y")
            .radius(latkit::elapsed() + 4.0)
            .color(Color::rgb(1.0, 0.0, 0.0)),
    );
    let mut view = view(&gpu, scene, &data);
    let shot = Shot::new([127, 129]).elapsed(Duration::ZERO);
    let first = pollster::block_on(shot.image(&mut [&mut view])).unwrap();
    let later = pollster::block_on(shot.clone().elapsed(Duration::from_secs(12)).image(&mut [&mut view])).unwrap();
    let again = pollster::block_on(shot.image(&mut [&mut view])).unwrap();
    assert_ne!(first, later);
    assert_eq!(first, again);
    assert_eq!(Image::from_png(&first.encode(latkit::ImageFormat::Png).unwrap()).unwrap(), first);
}

#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
#[test]
fn native_fonts_draw_visible_glyphs_into_the_export() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(latkit::host::Native::new());
    let data = Data::new("graph");
    data.apply(
        Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("name", vec!["Hello"]),
    )
    .unwrap();
    let scene = Scene::new(plane()).theme(plain_theme()).ease(Duration::ZERO).draw(
        Vertices::of("graph", "Node")
            .position("x", "y")
            .radius(4.0)
            .color(Color::rgb(1.0, 0.0, 0.0))
            .label(latkit::Label::new("name").color(Color::WHITE).size(18.0)),
    );
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([127, 129]).image(&mut [&mut view])).unwrap();
    let white =
        image.rgba.as_chunks::<4>().0.iter().filter(|pixel| pixel[0] > 180 && pixel[1] > 180 && pixel[2] > 180).count();
    assert!(white > 15, "the image contains real white glyphs, not just the red vertex: {white}");
}

#[test]
fn a_legend_draws_its_marks_colormap_across_the_domain() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(
        Table::new("Node", Ids::count(2))
            .field("x", vec![-1.0, 1.0])
            .field("y", vec![0.0, 0.0])
            .field("v", vec![0.0, 1.0]),
    )
    .expect("valid");
    let colors = latkit::field("v").colormap(latkit::Colormap::VIRIDIS).domain(0.0..=1.0);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0).color(colors).legend(""));
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([400, 200]).image(&mut [&mut view])).expect("a picture");
    // The bar ends 16 px from the right; its middle row sits above the ticks' labels.
    let y = 200 - 16 - 16 - 4 - 4;
    let near = |a: [u8; 4], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 24);
    let low = pixel(&image, 400 - 16 - 218, y);
    let high = pixel(&image, 400 - 16 - 2, y);
    assert!(near(low, [68, 1, 84]), "viridis's low end: {low:?}");
    assert!(near(high, [253, 231, 37]), "viridis's high end: {high:?}");
    let scene = Scene::new(plane()).draw(Vertices::of("graph", "Node").position("x", "y").legend(""));
    assert!(View::new(&gpu, scene).is_err(), "a legend needs a colormap with a domain");
}

#[test]
fn a_legend_lists_named_categories_by_their_colors() {
    use latkit::{Colormap, ColormapKind, field};
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(
        Table::new("Node", Ids::count(2))
            .field("x", vec![-1.0, 1.0])
            .field("y", vec![0.0, 0.0])
            .field("k", vec![0.0, 1.0]),
    )
    .expect("valid");
    let map = Colormap::new(ColormapKind::Categorical, [Color::rgb(1.0, 0.0, 0.0), Color::rgb(0.0, 0.0, 1.0)])
        .expect("two categories");
    let node = Vertices::of("graph", "Node").position("x", "y").radius(4.0);
    let scene = Scene::new(plane()).theme(plain_theme());
    let unnamed = scene.clone().draw(node.clone().color(field("k").colormap(map.clone())).legend(""));
    assert!(View::new(&gpu, unnamed).is_err(), "categories without names need a domain");
    let named = field("k").colormap(map.categories(["red", "blue"]));
    let mut view = view(&gpu, scene.draw(node.color(named).legend("")), &data);
    let image = pollster::block_on(Shot::new([400, 200]).image(&mut [&mut view])).expect("a picture");
    // Without a host no names are set, so the swatches end at the right margin, a row each above the
    // bottom one: rows of 16.5 px up from 16 px above the bottom.
    let x = 400 - 16 - 4;
    assert!(close(pixel(&image, x, 200 - 16 - 25), RED), "the first category: {:?}", pixel(&image, x, 159));
    assert!(close(pixel(&image, x, 200 - 16 - 8), [0, 0, 255, 255]), "the second: {:?}", pixel(&image, x, 176));
}
