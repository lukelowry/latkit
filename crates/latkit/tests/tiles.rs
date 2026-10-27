//! Tiles: the vector tiles the camera needs and the time tiles a plot window needs are fetched
//! from the host once for all views, decoded, and drawn as a dataset in each view. GeoJSON reads
//! as data.

#![cfg(feature = "gpu")]

mod common;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use common::{SETTLE, SIZE, at, errors, frame, gpu, plain_theme, step};
use latkit::Tiles;
use latkit::host::{Host, Raster, Request, TextRun};
use latkit::{
    Areas, Axis, Camera, Color, Data, Earth, Ids, Lines, Patch, Pending, Plot, Projection, Query, Reading, Scene,
    Source, Table, Vertices, View,
};

const C: u32 = SIZE / 2;

/// Writes protocol buffer fields.
#[derive(Default)]
struct Writer(Vec<u8>);

impl Writer {
    fn varint(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.0.push((v as u8) | 0x80);
            v >>= 7;
        }
        self.0.push(v as u8);
    }

    fn bytes(&mut self, field: u64, bytes: &[u8]) {
        self.varint(field << 3 | 2);
        self.varint(bytes.len() as u64);
        self.0.extend_from_slice(bytes);
    }

    fn packed(&mut self, field: u64, values: &[u32]) {
        let mut inner = Writer::default();
        for &v in values {
            inner.varint(u64::from(v));
        }
        self.bytes(field, &inner.0);
    }
}

fn zig(v: i64) -> u32 {
    ((v << 1) ^ (v >> 63)) as u32
}

/// A tile whose layer `water` has a square named `bay` that covers the tile and extends into its
/// buffer. Clipped, it covers the tile exactly.
fn tile() -> Vec<u8> {
    let (x, side) = (-64_i64, 4224_i64);
    tile_of(&[9, zig(x), zig(x), 26, zig(side), 0, 0, zig(side), zig(-side), 0, 15])
}

/// A tile whose layer `water` has a feature named `bay` of 2,025 small squares: more points than a
/// frame can afford to shape.
fn dense_tile() -> Vec<u8> {
    let (step, side) = (90_i64, 80_i64);
    let mut geometry = Vec::new();
    let mut cursor = [0_i64, 0];
    for i in 0..45 {
        for j in 0..45 {
            let [x, y] = [5 + step * i, 5 + step * j];
            let to = [zig(x - cursor[0]), zig(y - cursor[1])];
            geometry.extend([9, to[0], to[1], 26, zig(side), 0, 0, zig(side), zig(-side), 0, 15]);
            cursor = [x, y + side];
        }
    }
    tile_of(&geometry)
}

/// A tile whose layer `water` has one polygon feature named `bay` with `geometry`.
fn tile_of(geometry: &[u32]) -> Vec<u8> {
    let mut feature = Writer::default();
    feature.packed(2, &[0, 0]);
    feature.varint(3 << 3);
    feature.varint(3);
    feature.packed(4, geometry);
    let mut value = Writer::default();
    value.bytes(1, b"bay");
    let mut layer = Writer::default();
    layer.bytes(1, b"water");
    layer.bytes(2, &feature.0);
    layer.bytes(3, b"name");
    layer.bytes(4, &value.0);
    let mut tile = Writer::default();
    tile.bytes(3, &layer.0);
    tile.0
}

/// A host serving every `tiles/{z}/{x}/{y}` tile as [`tile`], or as [`dense_tile`] with `dense`,
/// and recording the fetches.
#[derive(Default)]
struct Served {
    fetched: Mutex<Vec<String>>,
    dense: bool,
}

/// The host given to the GPU: the served tiles, shared with the test.
struct Serving(Arc<Served>);

impl Host for Serving {
    fn rasterize(&self, _: &TextRun) -> latkit::Result<Raster> {
        Err(latkit::Error::Unsupported("no text in this test host".into()))
    }

    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        self.0.fetched.lock().expect("unpoisoned").push(request.url.to_string());
        let tile = if self.0.dense { dense_tile } else { tile };
        Pending::ready(Ok(if request.url.starts_with("tiles/") { tile() } else { Vec::new() }))
    }
}

#[test]
fn an_index_that_is_not_tile_json_fails_as_invalid_input() {
    let Some(gpu) = gpu() else { return };
    // The host serves empty bytes for anything outside `tiles/`.
    gpu.set_host(Serving(Arc::new(Served::default())));
    let scene = Scene::new(Earth::default()).draw(Areas::of("base", "water"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_sources([&Tiles::new("base", "index.json")]).expect("a source");
    frame(&gpu, &mut view);
    let errors = errors(&mut view);
    let [latkit::Error::Invalid { path, .. }] = errors.as_slice() else { panic!("one invalid input: {errors:?}") };
    assert_eq!(path.to_string(), "base", "named by the tiles' dataset");
}

#[test]
fn tiles_the_camera_needs_draw_as_a_dataset() {
    let Some(gpu) = gpu() else { return };
    let served = Arc::new(Served::default());
    gpu.set_host(Serving(served.clone()));
    let earth = Earth { graticule: false, ..Earth::default() };
    let scene = Scene::new(earth)
        .draw(Areas::of("base", "water").color(Color::hex("#ff0000").expect("hex")))
        .theme(plain_theme());
    let camera = Camera::Map { center: [0.0, 0.0, 0.0], zoom: 2.0, pitch: 0.0, bearing: 0.0 };
    let tiles = Tiles::new("base", "tiles/{z}/{x}/{y}.pbf");
    let mut view = View::new(&gpu, scene.clone()).expect("valid scene");
    view.set_camera(camera);
    view.set_sources([&tiles]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    let fetched = served.fetched.lock().expect("unpoisoned").clone();
    assert!(!fetched.is_empty() && fetched.iter().all(|url| url.starts_with("tiles/")), "{fetched:?}");
    let ids = |view: &View| -> Vec<latkit::Id> {
        let water = Query::of("water").ids_alone();
        view.snapshot("base").and_then(|d| d.query(&water).ok()).expect("the tiles' dataset").table.ids().collect()
    };
    let before = ids(&view);
    assert!(before.len() >= 4, "a row per tile drawn: {}", before.len());
    let stats = view.stats();
    assert_eq!((stats.tiles, stats.tiles_loading), (before.len() as u64, 0), "stats count the tiles drawn");
    assert!(at(&pixels, C + 8, C + 8)[0] > 150, "filled: {:?}", at(&pixels, C + 8, C + 8));
    assert_eq!(errors(&mut view), Vec::new());
    // A second view of the same tiles draws what the first fetched, without fetching again.
    let mut second = View::new(&gpu, scene).expect("valid scene");
    second.set_camera(camera);
    second.set_sources([&tiles]).expect("a source");
    let asked = served.fetched.lock().expect("unpoisoned").len();
    frame(&gpu, &mut second);
    assert_eq!(served.fetched.lock().expect("unpoisoned").len(), asked, "fetched once for every view");
    assert_eq!(ids(&second), before, "the same rows");
    drop(second);
    // Zooming in needs finer tiles, which replace their ancestors in the frame where the last of
    // them arrives.
    view.set_camera(Camera::Map { center: [10.0, 10.0, 0.0], zoom: 6.0, pitch: 0.0, bearing: 0.0 });
    let mut loading = false;
    for _ in 0..SETTLE {
        step(&gpu, &mut view);
        let now = view.stats().tiles_loading > 0;
        if loading && !now {
            break;
        }
        loading |= now;
    }
    assert!(ids(&view).iter().all(|id| !before.contains(id)), "finer tiles replace their ancestors on arrival");
    view.set_sources::<Source>([]).expect("no sources");
    assert!(view.snapshot("base").is_none(), "a dataset no source provides is removed");
}

#[test]
fn tiles_arrive_shaped_by_the_jobs_that_decode_them() {
    let Some(gpu) = gpu() else { return };
    let served = Arc::new(Served { dense: true, ..Served::default() });
    gpu.set_host(Serving(served.clone()));
    let earth = Earth { graticule: false, ..Earth::default() };
    let scene = Scene::new(earth).draw(Areas::of("base", "water")).theme(plain_theme());
    let mut view = View::new(&gpu, scene).expect("valid scene");
    let camera = |zoom| Camera::Map { center: [10.0, 10.0, 0.0], zoom, pitch: 0.0, bearing: 0.0 };
    view.set_camera(camera(2.0));
    view.set_sources([&Tiles::new("base", "tiles/{z}/{x}/{y}.pbf")]).expect("a source");
    frame(&gpu, &mut view);
    // As the camera zooms in and out, tiles come and go. A job decodes each tile and shapes its
    // rows, and no frame shapes them again, even when it draws rows an earlier frame loaded.
    let fetches = || served.fetched.lock().expect("unpoisoned").len() as u64;
    let (jobs, asked) = (gpu.work().jobs, fetches());
    for zoom in [6.0, 0.0] {
        view.set_camera(camera(zoom));
        frame(&gpu, &mut view);
    }
    assert!(fetches() > asked, "tiles were fetched");
    assert_eq!(gpu.work().jobs - jobs, fetches() - asked, "one job per tile");
    assert_eq!(errors(&mut view), Vec::new());
}

/// A host serving files by path, recording the requested paths.
struct Files {
    files: BTreeMap<String, Vec<u8>>,
    asked: Mutex<Vec<String>>,
}

/// The host given to the GPU: the files, shared with the test.
struct ServingFiles(Arc<Files>);

impl Host for ServingFiles {
    fn rasterize(&self, _: &TextRun) -> latkit::Result<Raster> {
        Err(latkit::Error::Unsupported("no text in this test host".into()))
    }

    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        self.0.asked.lock().expect("unpoisoned").push(request.url.to_string());
        Pending::ready(self.0.files.get(&*request.url).cloned().ok_or_else(|| latkit::Error::Io("no such file".into())))
    }
}

#[test]
fn time_tiles_draw_the_spans_a_plot_window_needs() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("signals");
    data.apply(Patch::new().axis("time", "s").set(Table::new("Signal", Ids::count(1)))).expect("valid");
    let times: Vec<f64> = (0..20_000).map(f64::from).collect();
    let values: Vec<f64> = times.iter().map(|t| 0.5 + 0.4 * (t / 50.0).sin()).collect();
    data.apply(Patch::new().append("Signal", &times, [("v", values)])).expect("frames");
    let mut files = BTreeMap::new();
    data.snapshot()
        .to_tiles(256, |path, bytes| {
            files.insert(format!("history/{path}"), bytes.to_vec());
            Ok(())
        })
        .expect("tiles");
    let written = files.len();
    let served = Arc::new(Files { files, asked: Mutex::default() });
    gpu.set_host(ServingFiles(served.clone()));
    let axis = Axis { grid: false, hidden: true, ..Axis::default() };
    let red = Color::rgb(1.0, 0.0, 0.0);
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(red).width(2.0));
    let camera = Camera::Plot { x: [1000.0, 1400.0], y: Some([0.0, 1.0]) };
    let mut whole = View::new(&gpu, scene.clone()).expect("valid scene");
    whole.set_sources([&data]).expect("a source");
    whole.set_camera(camera);
    let expected = frame(&gpu, &mut whole);
    let mut tiled = View::new(&gpu, scene).expect("valid scene");
    tiled.set_sources([Tiles::new("signals", "history/frames.json")]).expect("a source");
    tiled.set_camera(camera);
    let pixels = frame(&gpu, &mut tiled);
    assert_eq!(errors(&mut tiled), Vec::new());
    let stats = tiled.stats();
    assert_eq!(stats.tiles_loading, 0, "every requested span arrived");
    let differing = pixels.iter().zip(&expected).filter(|(a, b)| !common::close(**a, **b)).count();
    if differing > SIZE as usize {
        let ascii = |p: &[[u8; 4]]| {
            (0..SIZE / 4)
                .map(|y| {
                    (0..SIZE / 2).map(|x| if at(p, x * 2, y * 4)[0] > 100 { '#' } else { '.' }).collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        eprintln!("whole:\n{}\ntiled:\n{}", ascii(&expected), ascii(&pixels));
        eprintln!("asked: {:?}", served.asked.lock().expect("unpoisoned"));
    }
    assert!(differing <= SIZE as usize, "the window draws as the whole history does: {differing} pixels differ");
    assert!(pixels.iter().any(|p| p[0] > 200), "the trace draws");
    let asked = served.asked.lock().expect("unpoisoned").clone();
    assert!(asked.len() * 8 < written, "only the spans the window draws are fetched: {asked:?} of {written}");
}

#[test]
fn geojson_draws_as_lines_and_vertices_on_the_globe() {
    let Some(gpu) = gpu() else { return };
    let bytes = br#"{"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "border"},
         "geometry": {"type": "LineString", "coordinates": [[-60, 0], [60, 0]]}},
        {"type": "Feature", "properties": {"name": "center"},
         "geometry": {"type": "Point", "coordinates": [0, 30]}}]}"#;
    let data =
        pollster::block_on(Data::read(bytes, Reading { name: Some("map"), ..Reading::default() })).expect("GeoJSON");
    let earth = Earth { graticule: false, ..Earth::default().projection(Projection::Globe) };
    let red = Color::hex("#ff0000").expect("hex");
    let scene = Scene::new(earth)
        .draw(Lines::of("map", "lines").width(3.0).color(red))
        .draw(Vertices::of("map", "points").radius(6.0).color(red))
        .theme(plain_theme());
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0, 0.0, 0.0], zoom: 0.5, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert!(at(&pixels, C, C)[0] > 150, "the long line bends over the globe through its middle");
    let dot = view.screen([0.0, 30.0, 0.0]).expect("in view");
    assert!(at(&pixels, dot[0] as u32, dot[1] as u32)[0] > 150, "the point");
    assert_eq!(errors(&mut view), Vec::new());
}
