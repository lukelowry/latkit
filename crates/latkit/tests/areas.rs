//! Areas: polygons filled through the triangles the view derives for them, holes left open, picked
//! where they cover, framed by a fit, outlined by lines along their rings; on the earth whole across
//! the antimeridian, and shaped in a job when too large for the frame.

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

/// A dataset of one table of polygons, each row its rings.
fn polygons(rows: Vec<Vec<Ring>>) -> Data {
    let ids: Vec<u64> = (1..=rows.len() as u64).collect();
    let mut data = Data::new("map");
    data.apply(Patch::new().set(Table::new("Zone", ids).field("geometry", rows))).expect("valid");
    data
}

fn show(gpu: &latkit::Gpu, scene: Scene, data: Data) -> View {
    let mut view = View::new(gpu, scene.theme(plain_theme())).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    view
}

/// Renders frames until `pending` resolves, within the settle deadline.
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
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C - 25, C)), "filled: {:?}", at(&pixels, C - 25, C));
    assert!(dark(at(&pixels, C, C)), "the hole is open: {:?}", at(&pixels, C, C));
    assert!(dark(at(&pixels, 4, 4)), "outside is open");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn areas_asked_to_pick_pick_their_rows_and_frame_a_fit() {
    let Some(gpu) = gpu() else { return };
    let data = polygons(vec![vec![square(100.0, 100.0, 40.0)], vec![square(300.0, 100.0, 40.0)]]);
    // Areas are geometry: they answer the pointer only when asked to.
    let areas = Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")).pick(true);
    let scene = Scene::new(plane()).draw(areas);
    let mut view = show(&gpu, scene, data);
    view.fit(Fit::All);
    frame(&gpu, &mut view);
    let Camera::Map { center, .. } = *view.camera() else { panic!("a map camera") };
    assert!((center[0] - 220.0).abs() < 1.0 && (center[1] - 120.0).abs() < 1.0, "framed: {center:?}");
    let left = view.point([120.0, 120.0, 0.0]).expect("in view");
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
    let mut view = show(&gpu, scene, data);
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
    let earth = Earth { graticule: false, ..Earth::mercator() };
    let scene = Scene::new(earth).draw(Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")));
    let mut view = show(&gpu, scene, data);
    view.set_camera(Camera::Map { center: [180.0, 0.0, 0.0], zoom: 2.0, pitch: 0.0, bearing: 0.0 });
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C, C)), "across the antimeridian: {:?}", at(&pixels, C, C));
    assert!(red(at(&pixels, C - 10, C)) && red(at(&pixels, C + 10, C)), "on both sides");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn large_areas_triangulate_in_a_job_and_then_draw() {
    let Some(gpu) = gpu() else { return };
    // A ring of 40,000 points: past what a frame triangulates.
    let ring: Ring = (0..=40_000)
        .map(|k| {
            let a = f64::from(k) / 40_000.0 * std::f64::consts::TAU;
            [40.0 * a.cos(), 40.0 * a.sin()]
        })
        .collect();
    let data = polygons(vec![vec![ring]]);
    let scene = Scene::new(plane()).draw(Areas::of("map", "Zone").color(Color::hex("#ff0000").expect("hex")));
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, C, C)), "drawn once the job lands: {:?}", at(&pixels, C, C));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_polygon_field_is_what_areas_fill() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("map");
    data.apply(
        Patch::new().set(Table::new("Zone", Ids::count(1)).field("geometry", vec![vec![[0.0, 0.0], [1.0, 1.0]]])),
    )
    .expect("valid");
    let mut view = show(&gpu, Scene::new(plane()), data);
    let refused = view.show(Scene::new(plane()).draw(Areas::of("map", "Zone")));
    assert!(refused.is_err(), "a path field is no polygon field");
}
