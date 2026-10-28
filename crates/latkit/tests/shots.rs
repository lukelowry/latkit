//! Shots: a picture draws what a view shows, at its own size, once the view is complete and still.
//! Panels compose side by side, a transparent picture keeps its alpha, and a frame reports whether
//! it drew placeholders for pending work. Legends draw colormaps and named categories.

#![cfg(feature = "gpu")]

mod common;

use std::time::Duration;

use common::{SIZE, at, camera, close, frame, gpu, plain_theme, plane, step};
use latkit::{
    Areas, Color, Data, Edges, Faces, Fit, Ids, Image, Label, Lines, Patch, Scene, Shot, Table, Theme, Vertices, View,
    field,
};

const RED: [u8; 4] = [255, 0, 0, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

fn dot(x: f64, color: Color) -> (Scene, Data) {
    let data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![x]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(6.0).color(color));
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
fn a_picture_draws_the_same_pixels_as_the_view() {
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
fn every_kind_of_mark_draws_with_the_pipelines_it_requested() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    let square = vec![vec![[-60.0, -60.0], [-40.0, -60.0], [-40.0, -40.0], [-60.0, -40.0], [-60.0, -60.0]]];
    let nodes = Table::new("Node", vec![1_u64, 2, 3])
        .field("x", vec![-20.0, 20.0, 0.0])
        .field("y", vec![0.0, 0.0, 20.0])
        .field("name", vec!["a", "b", "c"]);
    let link =
        Table::new("Link", vec![1_u64]).reference("from", "Node", vec![1_u64]).reference("to", "Node", vec![2_u64]);
    let face = Table::new("Face", vec![1_u64])
        .reference("a", "Node", vec![1_u64])
        .reference("b", "Node", vec![2_u64])
        .reference("c", "Node", vec![3_u64]);
    let zone = Table::new("Zone", vec![1_u64]).field("geometry", vec![square]);
    data.apply(Patch::new().set(nodes).set(link).set(face).set(zone)).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Areas::of("graph", "Zone"))
        .draw(Lines::of("graph", "Zone"))
        .draw(Faces::of("graph", "Face").corners("a", "b", "c"))
        .draw(Edges::of("graph", "Link").ends("from", "to"))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).label(Label::new(field("name"))));
    let mut view = view(&gpu, scene, &data);
    // A fit measures every mark that frames it.
    view.fit(Fit::All);
    let shot = Shot::new([SIZE, SIZE]);
    pollster::block_on(shot.image(&mut [&mut view])).expect("first capture");
    let pipelines = gpu.work().pipelines;
    pollster::block_on(shot.image(&mut [&mut view])).expect("second capture");
    assert_eq!(gpu.work().pipelines, pipelines, "another capture reuses its pipelines");
    assert_eq!(gpu.work().late, 0, "every pipeline drawn with was requested, by the same name");
}

#[test]
fn a_scaled_picture_draws_the_same_view_sharper() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(20.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene, &data);
    let image =
        pollster::block_on(Shot::new([2 * SIZE, 2 * SIZE]).scale(2.0).image(&mut [&mut view])).expect("a picture");
    assert_eq!(image.size, [2 * SIZE, 2 * SIZE]);
    // The same CSS layout at twice the pixels: the dot is twice as far out and twice as large.
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
    assert!(close(pixel(&image, SIZE, SIZE / 2), BLACK), "each panel's own background shows between the dots");
    assert_eq!(gpu.work().late, 0, "the compose pipeline was requested ahead of use");
    let wrong = pollster::block_on(shot.image(&mut [&mut left]));
    assert!(wrong.is_err(), "a shot needs a view per panel");
}

#[test]
fn a_transparent_picture_keeps_its_alpha() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let scene = scene.theme(Theme { background: Color::TRANSPARENT, ..plain_theme() });
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).transparent().image(&mut [&mut view])).expect("a picture");
    assert_eq!(pixel(&image, 3, 3)[3], 0, "undrawn pixels are clear");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), RED), "{:?}", pixel(&image, SIZE / 2, SIZE / 2));
    let png = Image::from_png(&image.encode(latkit::ImageFormat::Png).expect("written")).expect("a PNG");
    assert_eq!(png, image);
}

#[test]
fn a_picture_waits_for_easing_to_finish() {
    let Some(gpu) = gpu() else { return };
    let (scene, data) = dot(0.0, Color::rgb(1.0, 0.0, 0.0));
    let mut view = view(&gpu, scene.ease(Duration::from_secs(2)), &data);
    frame(&gpu, &mut view);
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![40.0])).expect("valid");
    step(&gpu, &mut view);
    assert!(view.needs_render(), "the dot eases over two seconds");
    let image = pollster::block_on(Shot::new([SIZE, SIZE]).image(&mut [&mut view])).expect("a picture");
    assert!(close(pixel(&image, SIZE / 2 + 40, SIZE / 2), RED), "the picture shows the dot at its final position");
    assert!(close(pixel(&image, SIZE / 2, SIZE / 2), BLACK));
}

#[test]
fn a_frame_reports_whether_it_drew_placeholders() {
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
    let scene = Scene::new(latkit::Diagram::default())
        .draw(Vertices::of("labels", "Node").label(latkit::Label::new(field("name"))));
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
            .position(field("x"), field("y"))
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
            .position(field("x"), field("y"))
            .radius(4.0)
            .color(Color::rgb(1.0, 0.0, 0.0))
            .label(latkit::Label::new(field("name")).color(Color::WHITE).size(18.0)),
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
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(4.0).color(colors).legend(""));
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([400, 200]).image(&mut [&mut view])).expect("a picture");
    // The bar ends 16 px from the right edge. Its middle row is above the tick labels.
    let y = 200 - 16 - 16 - 4 - 4;
    let near = |a: [u8; 4], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 24);
    let low = pixel(&image, 400 - 16 - 218, y);
    let high = pixel(&image, 400 - 16 - 2, y);
    assert!(near(low, [68, 1, 84]), "viridis's low end: {low:?}");
    assert!(near(high, [253, 231, 37]), "viridis's high end: {high:?}");
    let scene = Scene::new(plane()).draw(Vertices::of("graph", "Node").position(field("x"), field("y")).legend(""));
    assert!(View::new(&gpu, scene).is_err(), "a legend needs a colormap");
}

#[test]
fn a_legend_shows_the_domain_a_colormap_fits_to_its_values() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(
        Table::new("Node", Ids::count(2))
            .field("x", vec![-1.0, 1.0])
            .field("y", vec![0.0, 0.0])
            .field("v", vec![10.0, 20.0]),
    )
    .expect("valid");
    let colors = latkit::field("v").colormap(latkit::Colormap::VIRIDIS);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(4.0).color(colors).legend(""));
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([400, 200]).image(&mut [&mut view])).expect("a picture");
    let y = 200 - 16 - 16 - 4 - 4;
    let near = |a: [u8; 4], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 24);
    let (low, high) = (pixel(&image, 400 - 16 - 218, y), pixel(&image, 400 - 16 - 2, y));
    assert!(near(low, [68, 1, 84]) && near(high, [253, 231, 37]), "viridis across the fitted domain: {low:?} {high:?}");
}

#[test]
fn a_colormap_over_equal_values_draws_its_middle() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("v", vec![5.0]))
        .expect("valid");
    let colors = latkit::field("v").colormap(latkit::Colormap::VIRIDIS);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(20.0).color(colors));
    let mut view = view(&gpu, scene, &data);
    let image = pollster::block_on(Shot::new([64, 64]).image(&mut [&mut view])).expect("a picture");
    let middle = pixel(&image, 32, 32);
    assert!(middle.iter().zip([33, 145, 140]).all(|(x, y)| x.abs_diff(y) <= 24), "viridis's middle: {middle:?}");
}

#[test]
fn a_plots_legend_stays_clear_of_its_axes() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("d");
    let frames: Vec<f64> = (0..10).map(f64::from).collect();
    let values: Vec<f32> = (0..10_u8).map(f32::from).collect();
    data.apply(Patch::new().axis("time", "s").replace(Table::new("S", Ids::count(1)).field("k", vec![1.0])).append(
        "S",
        frames,
        [("v", values)],
    ))
    .expect("valid");
    let colors = field("k").colormap(latkit::Colormap::VIRIDIS).domain(0.0..=1.0);
    // The lowest row holding the colormap's yellow high end: the bottom of the legend's bar.
    let bar_bottom = |scene: Scene| {
        let mut view = view(&gpu, scene, &data);
        let image = pollster::block_on(Shot::new([400, 200]).image(&mut [&mut view])).expect("a picture");
        let yellow = |p: [u8; 4]| p[0] > 200 && p[1] > 190 && p[2] < 90;
        (0..200).rev().find(|&y| (300..400).any(|x| yellow(pixel(&image, x, y)))).expect("a legend")
    };
    let on_plane = bar_bottom(
        Scene::new(plane())
            .theme(plain_theme())
            .draw(Vertices::of("d", "S").position(0.0, 0.0).color(colors.clone()).legend("")),
    );
    let on_plot = bar_bottom(
        Scene::new(latkit::Plot::default())
            .theme(plain_theme())
            .draw(Lines::of("d", "S").trace("v").color(colors).legend("")),
    );
    assert!(on_plot + 20 < on_plane, "above the axis labels: {on_plot} on the plot, {on_plane} on a plane");
}

#[test]
fn a_legend_lists_named_categories_by_their_colors() {
    use latkit::{Colormap, ColormapKind};
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
    let node = Vertices::of("graph", "Node").position(field("x"), field("y")).radius(4.0);
    let scene = Scene::new(plane()).theme(plain_theme());
    let unnamed = scene.clone().draw(node.clone().color(field("k").colormap(map.clone())).legend(""));
    assert!(View::new(&gpu, unnamed).is_ok(), "categories without names show a cell for each");
    let named = field("k").colormap(map.categories(["red", "blue"]));
    let mut view = view(&gpu, scene.draw(node.color(named).legend("")), &data);
    let image = pollster::block_on(Shot::new([400, 200]).image(&mut [&mut view])).expect("a picture");
    // Without a host no names are rasterized, so the swatches end at the right margin, one row each
    // above the bottom margin: rows of 16.5 px, starting 16 px above the bottom.
    let x = 400 - 16 - 4;
    assert!(close(pixel(&image, x, 200 - 16 - 25), RED), "the first category: {:?}", pixel(&image, x, 159));
    assert!(close(pixel(&image, x, 200 - 16 - 8), [0, 0, 255, 255]), "the second: {:?}", pixel(&image, x, 176));
}
