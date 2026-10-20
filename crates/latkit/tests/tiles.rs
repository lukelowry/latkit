//! Tiles: the vector tiles the camera asks for and the time tiles a plot window asks for, fetched from
//! the host, decoded, and drawn as a dataset the view owns; GeoJSON read as data.

#![cfg(feature = "gpu")]

mod common;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use common::{SIZE, at, errors, frame, gpu, plain_theme};
use latkit::Tiles;
use latkit::host::{Host, Raster, Request, TextRun};
use latkit::{Areas, Axis, Camera, Color, Data, Earth, Ids, Lines, Patch, Pending, Plot, Scene, Table, Vertices, View};

const C: u32 = SIZE / 2;

/// Protocol buffer fields, written.
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

/// A tile whose layer `water` holds a square covering it and reaching into its buffer, named `bay`:
/// clipped, it covers the tile exactly.
fn tile() -> Vec<u8> {
    let (x, side) = (-64_i64, 4224_i64);
    let geometry = [9, zig(x), zig(x), 26, zig(side), 0, 0, zig(side), zig(-side), 0, 15];
    let mut feature = Writer::default();
    feature.packed(2, &[0, 0]);
    feature.varint(3 << 3);
    feature.varint(3);
    feature.packed(4, &geometry);
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

/// A host serving every tile of `tiles/{z}/{x}/{y}` as [`tile`], counting the fetches.
#[derive(Default)]
struct Served {
    fetched: Mutex<Vec<String>>,
}

/// What the GPU is given as its host: the served tiles, shared with the test.
struct Serving(Arc<Served>);

impl Host for Serving {
    fn rasterize(&self, _: &TextRun) -> latkit::Result<Raster> {
        Err(latkit::Error::Unsupported("no text in this test host".into()))
    }

    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        self.0.fetched.lock().expect("unpoisoned").push(request.url.to_string());
        Pending::ready(Ok(if request.url.starts_with("tiles/") { tile() } else { Vec::new() }))
    }
}

#[test]
fn tiles_the_camera_asks_for_draw_as_a_dataset() {
    let Some(gpu) = gpu() else { return };
    let served = Arc::new(Served::default());
    gpu.set_host(Serving(served.clone()));
    let earth = Earth { graticule: false, ..Earth::mercator() };
    let scene = Scene::new(earth)
        .draw(Areas::of("base", "water").color(Color::hex("#ff0000").expect("hex")))
        .theme(plain_theme());
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0, 0.0, 0.0], zoom: 2.0, pitch: 0.0, bearing: 0.0 });
    view.set_tiles(Tiles::new("base", "tiles/{z}/{x}/{y}.pbf"));
    let pixels = frame(&gpu, &mut view);
    let fetched = served.fetched.lock().expect("unpoisoned").clone();
    assert!(!fetched.is_empty() && fetched.iter().all(|url| url.starts_with("tiles/")), "{fetched:?}");
    let before: Vec<latkit::Id> =
        view.data("base").and_then(|d| d.table("water")).expect("the tiles' dataset").ids().collect();
    assert!(before.len() >= 4, "a row per tile drawn: {}", before.len());
    let stats = view.stats();
    assert_eq!((stats.tiles, stats.tiles_loading), (before.len() as u64, 0), "stats count the tiles drawn");
    assert!(at(&pixels, C + 8, C + 8)[0] > 150, "filled: {:?}", at(&pixels, C + 8, C + 8));
    assert_eq!(errors(&mut view), Vec::new());
    // Zooming in asks for finer tiles, which replace their ancestors.
    view.set_camera(Camera::Map { center: [10.0, 10.0, 0.0], zoom: 6.0, pitch: 0.0, bearing: 0.0 });
    frame(&gpu, &mut view);
    let after: Vec<latkit::Id> = view.data("base").and_then(|d| d.table("water")).expect("rows").ids().collect();
    assert!(after.iter().all(|id| !before.contains(id)), "finer tiles' rows");
    view.remove_data("base");
    assert!(view.data("base").is_none());
}

/// A host serving files by path, keeping the paths asked for.
struct Files {
    files: BTreeMap<String, Vec<u8>>,
    asked: Mutex<Vec<String>>,
}

/// What the GPU is given as its host: the files, shared with the test.
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
fn time_tiles_draw_the_spans_a_plot_window_asks_for() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("signals");
    data.apply(Patch::new().axis("time", "s").set(Table::new("Signal", Ids::count(1)))).expect("valid");
    let times: Vec<f64> = (0..20_000).map(f64::from).collect();
    let values: Vec<f64> = times.iter().map(|t| 0.5 + 0.4 * (t / 50.0).sin()).collect();
    data.apply(Patch::new().append(&times, "Signal", [("v", values)])).expect("frames");
    let mut files = BTreeMap::new();
    data.to_tiles(256, |path, bytes| {
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
    whole.set_data(data);
    whole.set_camera(camera);
    let expected = frame(&gpu, &mut whole);
    let mut tiled = View::new(&gpu, scene).expect("valid scene");
    tiled.set_tiles(Tiles::new("signals", "history/frames.json"));
    tiled.set_camera(camera);
    let pixels = frame(&gpu, &mut tiled);
    assert_eq!(errors(&mut tiled), Vec::new());
    let stats = tiled.stats();
    assert_eq!(stats.tiles_loading, 0, "every span asked for landed");
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
    assert!(asked.len() * 8 < written, "only the spans the window draws: {asked:?} of {written}");
}

#[test]
fn geojson_draws_as_lines_and_vertices_on_the_globe() {
    let Some(gpu) = gpu() else { return };
    let bytes = br#"{"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "border"},
         "geometry": {"type": "LineString", "coordinates": [[-60, 0], [60, 0]]}},
        {"type": "Feature", "properties": {"name": "center"},
         "geometry": {"type": "Point", "coordinates": [0, 30]}}]}"#;
    let data = Data::read(bytes, Some("map")).expect("GeoJSON");
    let earth = Earth { graticule: false, ..Earth::globe() };
    let red = Color::hex("#ff0000").expect("hex");
    let scene = Scene::new(earth)
        .draw(Lines::of("map", "lines").width(3.0).color(red))
        .draw(Vertices::of("map", "points").radius(6.0).color(red))
        .theme(plain_theme());
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0, 0.0, 0.0], zoom: 0.5, pitch: 0.0, bearing: 0.0 });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    assert!(at(&pixels, C, C)[0] > 150, "the long line bends over the globe through its middle");
    let dot = view.point([0.0, 30.0, 0.0]).expect("in view");
    assert!(at(&pixels, dot[0] as u32, dot[1] as u32)[0] > 150, "the point");
    assert_eq!(errors(&mut view), Vec::new());
}
