//! Shots: a picture draws what a view shows at a size of its own once it is complete and still,
//! panels compose side by side, a transparent picture keeps its alpha, and a frame tells whether
//! anything stood in for work under way.

#![cfg(feature = "gpu")]

mod common;

use std::time::Duration;

use common::{SIZE, at, camera, close, frame, gpu, plain_theme, plane, step};
use latkit::{Color, Data, Image, Scene, Shot, Table, Theme, Vertices, View};

const RED: [u8; 4] = [255, 0, 0, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

fn dot(x: f64, color: Color) -> (Scene, Data) {
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", 1).field("x", vec![x]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(6.0).color(color));
    (scene, data)
}

fn view(gpu: &latkit::Gpu, scene: Scene, data: Data) -> View {
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
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
    let mut view = view(&gpu, scene, data);
    let shown = frame(&gpu, &mut view);
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).image(&mut [&mut view])).expect("a picture");
    assert_eq!(image.size, [SIZE, SIZE]);
    for (x, y) in [(SIZE / 2 + 20, SIZE / 2), (SIZE / 2, SIZE / 2), (3, 3)] {
        assert!(close(pixel(&image, x, y), at(&shown, x, y)), "{:?} at {x}, {y}", pixel(&image, x, y));
    }
    assert!(close(pixel(&image, SIZE / 2 + 20, SIZE / 2), RED));
}

#[test]
fn a_scaled_picture_draws_the_same_view_sharper() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(20.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene, data);
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
    let mut left = view(&gpu, red_scene, red);
    let mut right = view(&gpu, blue_scene, blue);
    let shot = Shot::new([2 * SIZE, SIZE]).panel([0.0, 0.0, 0.5, 1.0]).panel([0.5, 0.0, 0.5, 1.0]);
    let image = pollster::block_on(shot.image(&mut [&mut left, &mut right])).expect("a picture");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), RED), "{:?}", pixel(&image, SIZE / 2, SIZE / 2));
    assert!(close(pixel(&image, SIZE + SIZE / 2, SIZE / 2), [0, 0, 255, 255]));
    assert!(close(pixel(&image, SIZE, SIZE / 2), BLACK), "each panel's own background between");
    let wrong = pollster::block_on(shot.image(&mut [&mut left]));
    assert!(wrong.is_err(), "a view per panel");
}

#[test]
fn a_transparent_picture_keeps_its_alpha() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let scene = scene.theme(Theme { background: Color::TRANSPARENT, ..plain_theme() });
    let mut view = view(&gpu, scene, data);
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).transparent().image(&mut [&mut view])).expect("a picture");
    assert_eq!(pixel(&image, 3, 3)[3], 0, "nothing drawn is clear");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), RED), "{:?}", pixel(&image, SIZE / 2, SIZE / 2));
    let png = Image::from_png(&image.png()).expect("a PNG");
    assert_eq!(png, image);
}

#[test]
fn a_picture_waits_for_what_eases_to_land() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene.ease(Duration::from_secs(2)), data.clone());
    frame(&gpu, &mut view);
    let mut moved = data;
    moved.apply(Table::new("Node", 1).field("x", vec![40.0])).expect("valid");
    view.set_data(moved);
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
    view.set_data(data);
    frame(&gpu, &mut view);
    assert!(view.complete());
    let waiting = view.stats().waiting;
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
    let mut view = view(&gpu, scene, data);
    let result = pollster::block_on(Shot::new([33, 35]).deadline(Duration::ZERO).image(&mut [&mut view]));
    assert_eq!(result.unwrap_err(), latkit::Error::Timeout);
    assert!(!view.lent());
    gpu.set_host(BrokenText);
    let mut data = Data::new("labels");
    data.apply(Table::new("Node", 1).field("name", vec!["Hello"])).unwrap();
    let scene =
        Scene::new(latkit::Diagram::default()).draw(Vertices::of("labels", "Node").label(latkit::Label::new("name")));
    view.show(scene).unwrap();
    view.set_data(data);
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
    let mut view = view(&gpu, scene, data);
    let shot = Shot::new([127, 129]).elapsed(Duration::ZERO);
    let first = pollster::block_on(shot.image(&mut [&mut view])).unwrap();
    let later = pollster::block_on(shot.clone().elapsed(Duration::from_secs(12)).image(&mut [&mut view])).unwrap();
    let again = pollster::block_on(shot.image(&mut [&mut view])).unwrap();
    assert_ne!(first, later);
    assert_eq!(first, again);
    assert_eq!(Image::from_png(&first.png()).unwrap(), first);
}

#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
#[test]
fn native_fonts_draw_visible_glyphs_into_the_export() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(latkit::host::Native::new());
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", 1).field("x", vec![0.0]).field("y", vec![0.0]).field("name", vec!["Hello"])).unwrap();
    let scene = Scene::new(plane()).theme(plain_theme()).ease(Duration::ZERO).draw(
        Vertices::of("graph", "Node")
            .position("x", "y")
            .radius(4.0)
            .color(Color::rgb(1.0, 0.0, 0.0))
            .label(latkit::Label::new("name").color(Color::WHITE).size(18.0)),
    );
    let mut view = view(&gpu, scene, data);
    let image = pollster::block_on(Shot::new([127, 129]).image(&mut [&mut view])).unwrap();
    let white =
        image.rgba.as_chunks::<4>().0.iter().filter(|pixel| pixel[0] > 180 && pixel[1] > 180 && pixel[2] > 180).count();
    assert!(white > 15, "the image contains real white glyphs, not just the red vertex: {white}");
}
