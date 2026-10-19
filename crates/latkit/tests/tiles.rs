//! Tiles: the vector tiles the camera asks for, fetched from the host, decoded, and drawn as a dataset
//! the view owns; GeoJSON read as data.

#![cfg(feature = "gpu")]

mod common;

use std::sync::{Arc, Mutex};

use common::{SIZE, at, errors, frame, gpu, plain_theme};
use latkit::geo::{Tiles, geojson};
use latkit::host::{Host, Raster, Request, TextRun};
use latkit::{Areas, Camera, Color, Earth, Lines, Pending, Scene, Vertices, View};

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
    view.set_tiles(Tiles::vector("base", "tiles/{z}/{x}/{y}.pbf"));
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
    view.remove_tiles("base");
    assert!(view.data("base").is_none());
}

#[test]
fn geojson_draws_as_lines_and_vertices_on_the_globe() {
    let Some(gpu) = gpu() else { return };
    let bytes = br#"{"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "border"},
         "geometry": {"type": "LineString", "coordinates": [[-60, 0], [60, 0]]}},
        {"type": "Feature", "properties": {"name": "center"},
         "geometry": {"type": "Point", "coordinates": [0, 30]}}]}"#;
    let data = geojson("map", bytes).expect("GeoJSON");
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
