//! Areas: polygons filled through triangles the view derives, with holes left open. Areas pick
//! where they cover, a fit frames them, and lines trace their rings. On the earth they stay whole
//! across the antimeridian. Polygons too large for one frame are triangulated in a job, and ease in
//! with each row's color when it lands.

#![cfg(feature = "gpu")]

mod common;

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use common::{SIZE, at, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Areas, Camera, Color, Data, Earth, Fit, Ids, Lines, Patch, Scene, Table, View};

const C: u32 = SIZE / 2;

type Ring = Vec<[f64; 2]>;

fn square(x: f64, y: f64, side: f64) -> Ring {
    vec![[x, y], [x + side, y], [x + side, y + side], [x, y + side], [x, y]]
}

fn red(pixel: [u8; 4]) -> bool {
    pixel[0] > 150 && pixel[1] < 80 && pixel[2] < 80
}

fn dark(pixel: [u8; 4]) -> bool {
    pixel[0].max(pixel[1]).max(pixel[2]) < 30
}

/// A dataset with one table of polygons, each row a list of rings.
fn polygons(rows: Vec<Vec<Ring>>) -> Data {
    let ids: Vec<u64> = (1..=rows.len() as u64).collect();
    let data = Data::new("map");
    data.apply(Patch::new().set(Table::new("Zone", ids).field("geometry", rows))).expect("valid");
    data
}

fn view(gpu: &latkit::Gpu, scene: Scene, data: &Data) -> View {
    let mut view = View::new(gpu, scene.theme(plain_theme())).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([data]).expect("a source");
    view
}

/// Renders frames until `pending` resolves, within `SETTLE` frames.
fn answer<T>(gpu: &latkit::Gpu, view: &mut View, pending: impl Future<Output = latkit::Result<T>>) -> T {
    let mut pending = pin!(pending);
    let mut context = Context::from_waker(Waker::noop());
    for _ in 0..common::SETTLE {
        if let Poll::Ready(value) = pending.as_mut().poll(&mut context) {
            return value.expect("an answer");
        }
        step(gpu, view);
    }
    panic!("the query answers within {} frames", common::SETTLE);
}

#[test]
fn areas_fill_their_polygons_and_leave_their_holes() {
    let Some(gpu) = gpu() else { return };
    let data = polygons(vec![vec![square(-40.0, -40.0, 80.0), square(-10.0, -10.0, 20.0)]]);
    let scene = Scene::new(plane()).draw(Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")));
    let mut view = view(&gpu, scene, &data);
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C - 25, C)), "filled: {:?}", at(&pixels, C - 25, C));
    assert!(dark(at(&pixels, C, C)), "the hole is open: {:?}", at(&pixels, C, C));
    assert!(dark(at(&pixels, 4, 4)), "outside is open");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn areas_triangulated_in_a_job_ease_in_with_each_row_s_color() {
    let Some(gpu) = gpu() else { return };
    // A page of unit squares, more than one frame triangulates, valued from 0 to 1 row by row.
    let side = 64_u32;
    let cells: Vec<Vec<Ring>> =
        (0..side * side).map(|i| vec![square(f64::from(i % side), f64::from(i / side), 1.0)]).collect();
    let values: Vec<f64> = (0..side * side).map(|i| f64::from(i) / f64::from(side * side - 1)).collect();
    let data = Data::new("map");
    data.apply(Table::new("Zone", Ids::count(side * side)).field("geometry", cells).field("v", values)).expect("valid");
    let color = latkit::field("v").colormap(latkit::Colormap::VIRIDIS).domain(0.0..=1.0);
    let mut view = view(&gpu, Scene::new(plane()).draw(Areas::of("map", "Zone").color(color)), &data);
    let middle = f64::from(side) / 2.0;
    view.set_camera(Camera::Map { center: [middle, middle, 0.0], zoom: 0.75, pitch: 0.0, bearing: 0.0 });
    // The triangles landing start a transition; once it settles, each row shows its own color.
    let pixels = frame(&gpu, &mut view);
    let cell = |x: f64, y: f64| {
        let [px, py] = view.screen([x + 0.5, y + 0.5, 0.0]).expect("in view");
        at(&pixels, px as u32, py as u32)
    };
    // Viridis runs from dark purple through teal to yellow.
    let far = f64::from(side - 3);
    let [low, half, high] = [cell(2.0, 2.0), cell(2.0, middle), cell(far, far)];
    assert!(low[0] < 90 && low[1] < 20 && low[2] > 60, "0 is purple: {low:?}");
    assert!(half[1] > 120 && half[2] > 120 && half[0] < 60, "0.5 is teal: {half:?}");
    assert!(high[0] > 200 && high[1] > 200 && high[2] < 80, "1 is yellow: {high:?}");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn pickable_areas_return_their_rows_and_a_fit_frames_them() {
    let Some(gpu) = gpu() else { return };
    let data = polygons(vec![vec![square(100.0, 100.0, 40.0)], vec![square(300.0, 100.0, 40.0)]]);
    // Areas respond to the pointer only when `pick` is on.
    let areas = Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")).pick(true);
    let scene = Scene::new(plane()).draw(areas);
    let mut view = view(&gpu, scene, &data);
    view.fit(Fit::All);
    frame(&gpu, &mut view);
    let Camera::Map { center, .. } = *view.camera() else { panic!("a map camera") };
    assert!((center[0] - 220.0).abs() < 1.0 && (center[1] - 120.0).abs() < 1.0, "framed: {center:?}");
    let left = view.screen([120.0, 120.0, 0.0]).expect("in view");
    let pending = view.pick(left, 2.0);
    let hits = answer(&gpu, &mut view, pending);
    assert_eq!(hits.first().map(|h| h.row.id.clone()), Some(1_u64.into()), "{hits:?}");
}

#[test]
fn lines_trace_the_rings_of_polygons() {
    let Some(gpu) = gpu() else { return };
    let data = polygons(vec![vec![square(-40.0, -40.0, 80.0)]]);
    let scene =
        Scene::new(plane()).draw(Lines::of("map", "Zone").width(3.0).color(Color::hex("#ff0000").expect("hex")));
    let mut view = view(&gpu, scene, &data);
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C - 40, C)), "the ring: {:?}", at(&pixels, C - 40, C));
    assert!(dark(at(&pixels, C, C)), "inside stays open");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn earth_areas_stay_whole_across_the_antimeridian() {
    let Some(gpu) = gpu() else { return };
    let ring = vec![[170.0, -10.0], [-170.0, -10.0], [-170.0, 10.0], [170.0, 10.0], [170.0, -10.0]];
    let data = polygons(vec![vec![ring]]);
    let earth = Earth { graticule: false, ..Earth::default() };
    let scene = Scene::new(earth).draw(Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")));
    let mut view = view(&gpu, scene, &data);
    // A flat map is one world, so the camera looks just short of the antimeridian, whose edge lies
    // past the view's at zoom 4. An area streaked the other way around the world would leave this
    // side of it empty.
    view.set_camera(Camera::Map { center: [174.0, 0.0, 0.0], zoom: 4.0, pitch: 0.0, bearing: 0.0 });
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C, C)), "whole up to the antimeridian: {:?}", at(&pixels, C, C));
    assert!(red(at(&pixels, C - 10, C)) && red(at(&pixels, C + 10, C)), "on both sides of the middle");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn large_areas_triangulate_in_a_job_and_then_draw() {
    let Some(gpu) = gpu() else { return };
    // A ring of 40,000 points, more than one frame triangulates.
    let ring: Ring = (0..=40_000)
        .map(|k| {
            let a = f64::from(k) / 40_000.0 * std::f64::consts::TAU;
            [40.0 * a.cos(), 40.0 * a.sin()]
        })
        .collect();
    let data = polygons(vec![vec![ring]]);
    let scene = Scene::new(plane()).draw(Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")));
    let mut view = view(&gpu, scene, &data);
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C, C)), "drawn once the job finishes: {:?}", at(&pixels, C, C));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn areas_require_a_polygon_field() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("map");
    data.apply(
        Patch::new().set(Table::new("Zone", Ids::count(1)).field("geometry", vec![vec![[0.0, 0.0], [1.0, 1.0]]])),
    )
    .expect("valid");
    let mut view = view(&gpu, Scene::new(plane()), &data);
    let refused = view.set_scene(Scene::new(plane()).draw(Areas::of("map", "Zone")));
    assert!(refused.is_err(), "areas reject a path field");
}
