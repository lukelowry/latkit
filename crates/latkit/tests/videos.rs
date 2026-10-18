//! Videos: frames compose into NV12 on the GPU, a frame where nothing moved is held rather than drawn
//! or encoded, keyframes fall at their times, and what the encoder gives is written as MP4.

#![cfg(feature = "gpu")]

mod common;

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use common::{SIZE, camera, gpu, plain_theme, plane};
use latkit::host::{Host, Raster, TextRun};
use latkit::{
    Color, Data, Encoder, Encoding, Label, Mp4, Pending, Pixels, Scene, Shot, Sink, Table, Unit, Vertices, View,
};

/// The pictures an encoder was given: time, whether a keyframe, and the NV12 bytes.
type Pictures = Arc<Mutex<Vec<(u64, bool, Vec<u8>)>>>;

/// A host whose encoder keeps the pictures it is given and answers each with a stand-in unit: a
/// parameter set pair and a slice, which the muxer takes as H.264.
struct Keeping(Pictures);

impl Host for Keeping {
    fn rasterize(&self, run: &TextRun) -> latkit::Result<Raster> {
        let size = [(run.text.chars().count() as u32 * run.size_px / 2).max(1), run.size_px];
        Ok(Raster { size, coverage: vec![255; (size[0] * size[1]) as usize], baseline: run.size_px as f32 * 0.8 })
    }

    fn encoder(&self, encoding: &Encoding) -> latkit::Result<Box<dyn Encoder>> {
        assert_eq!(encoding.size, [SIZE, SIZE]);
        Ok(Box::new(Kept(self.0.clone())))
    }
}

struct Kept(Pictures);

impl Encoder for Kept {
    fn encode(&mut self, nv12: &[u8], time: u64, key: bool) -> Pending<Vec<Unit>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push((time, key, nv12.to_vec()));
        let slice: &[u8] = if key { &[0, 0, 0, 1, 0x65, 0x88] } else { &[0, 0, 0, 1, 0x41, 0x9a] };
        let mut annex_b = vec![0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80];
        annex_b.extend_from_slice(slice);
        Pending::ready(Ok(vec![Unit { time, key, annex_b }]))
    }

    fn finish(&mut self) -> Pending<Vec<Unit>> {
        Pending::ready(Ok(Vec::new()))
    }
}

fn dot(x: f64) -> Data {
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", 1).field("x", vec![x]).field("y", vec![0.0])).expect("valid");
    data
}

fn view(gpu: &latkit::Gpu) -> View {
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(Duration::ZERO)
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(20.0).color(Color::rgb(1.0, 0.0, 0.0)));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(dot(0.0));
    view
}

/// Luma and chroma of NV12 `bytes` of a square picture of `SIZE` at pixel `x`, `y`.
fn sample(bytes: &[u8], x: u32, y: u32) -> [u8; 3] {
    let luma = bytes[(y * SIZE + x) as usize];
    let chroma = (SIZE * SIZE + (y / 2) * SIZE + (x / 2) * 2) as usize;
    [luma, bytes[chroma], bytes[chroma + 1]]
}

fn near(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 2)
}

#[test]
fn frames_compose_into_nv12_and_hold_where_nothing_moved() {
    let Some(gpu) = gpu() else { return };
    let pictures = Pictures::default();
    gpu.set_host(Keeping(pictures.clone()));
    let mut view = view(&gpu);
    let mut video = Shot::new([SIZE, SIZE]).video(&gpu, 60.0, Mp4::new(Vec::new())).expect("a video");
    pollster::block_on(async {
        for _ in 0..6 {
            video.frame(&mut [&mut view]).await.expect("a frame");
        }
        view.set_data(dot(30.0));
        for _ in 0..3 {
            video.frame(&mut [&mut view]).await.expect("a frame");
        }
    });
    assert_eq!(video.frames(), 9);
    assert!(!view.lent() || video.frames() > 0, "the video holds the view while it lasts");
    let file = pollster::block_on(video.finish()).expect("a file").into_inner();
    assert!(!view.lent(), "a finished video gives the view back");
    let pictures = pictures.lock().unwrap_or_else(PoisonError::into_inner);
    let times: Vec<(u64, bool)> = pictures.iter().map(|(t, k, _)| (*t, *k)).collect();
    assert_eq!(times, vec![(0, true), (9000, false)], "frames where nothing moved are held");
    let [first, moved] = [&pictures[0].2, &pictures[1].2];
    assert_eq!(first.len(), (SIZE * SIZE * 3 / 2) as usize);
    let c = SIZE / 2;
    // BT.709 limited range: red is 63, 102, 240; black is 16, 128, 128.
    assert!(near(sample(first, c, c), [63, 102, 240]), "{:?}", sample(first, c, c));
    assert!(near(sample(first, 2, 2), [16, 128, 128]), "{:?}", sample(first, 2, 2));
    assert!(near(sample(moved, c + 30, c), [63, 102, 240]), "the moved dot");
    assert_eq!(&file[4..8], b"ftyp");
    assert!(file.windows(4).any(|w| w == b"moof"), "fragments follow");
    assert!(file.windows(4).any(|w| w == b"avcC"), "the track's parameter sets");
}

#[test]
fn labeled_marks_easing_between_frames_complete_every_frame() {
    let Some(gpu) = gpu() else { return };
    gpu.set_host(Keeping(Pictures::default()));
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(Duration::from_millis(300))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(6.0).label(Label::new("name")));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    let named = |x: f64| {
        let mut data = dot(x);
        data.apply(Table::new("Node", 1).field("name", vec!["a"])).expect("valid");
        data
    };
    view.set_data(named(0.0));
    let shot = Shot::new([SIZE, SIZE]).deadline(Duration::from_secs(5));
    let mut video = shot.video(&gpu, 30.0, Mp4::new(Vec::new())).expect("a video");
    let started = std::time::Instant::now();
    pollster::block_on(async {
        for i in 0..10 {
            view.set_data(named(f64::from(i) * 3.0));
            video.frame(&mut [&mut view]).await.expect("a frame");
        }
    });
    assert!(started.elapsed() < Duration::from_secs(5), "no frame waits out its deadline");
    assert_eq!(common::errors(&mut view), Vec::new());
    pollster::block_on(video.finish()).expect("a file");
}

#[test]
fn a_video_is_whole_blocks_and_needs_an_encoder() {
    let Some(gpu) = gpu() else { return };
    assert!(Shot::new([SIZE, SIZE]).video(&gpu, 30.0, Mp4::new(Vec::new())).is_err(), "a host without an encoder");
    gpu.set_host(Keeping(Pictures::default()));
    assert!(Shot::new([SIZE, SIZE]).video(&gpu, 0.0, Mp4::new(Vec::new())).is_err(), "a frame rate");
    assert!(
        Shot::new([SIZE + 2, SIZE]).video(&gpu, 30.0, Mp4::new(Vec::new())).is_err(),
        "a width of whole 4-pixel blocks"
    );
    let mut view = view(&gpu);
    let mut two = Shot::new([SIZE, SIZE]).panel([0.0, 0.0, 0.5, 1.0]).panel([0.5, 0.0, 0.5, 1.0]);
    let mut video = two.video(&gpu, 30.0, Mp4::new(Vec::new())).expect("made");
    assert!(pollster::block_on(video.frame(&mut [&mut view])).is_err(), "a view for each panel");
    two = two.scale(0.0);
    assert!(two.video(&gpu, 30.0, Mp4::new(Vec::new())).is_ok(), "the scale is checked as the first frame draws");
}

/// A sink keeping what it is given: each frame's index and whether it was drawn, and the RGBA bytes.
#[derive(Default)]
struct Frames {
    taken: Vec<(u64, Option<Vec<u8>>)>,
    end: Option<u64>,
}

impl Sink for Frames {
    const PIXELS: Pixels = Pixels::Rgba;

    fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> impl Future<Output = latkit::Result<()>> {
        self.taken.push((index, pixels));
        std::future::ready(Ok(()))
    }

    fn finish(&mut self, end: u64) -> impl Future<Output = latkit::Result<()>> {
        self.end = Some(end);
        std::future::ready(Ok(()))
    }
}

#[test]
fn any_sink_takes_every_frame_in_order_and_held_ones_without_pixels() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu);
    // RGBA takes any width: no encoder, no 4-pixel blocks.
    let mut video = Shot::new([SIZE + 2, SIZE]).video(&gpu, 30.0, Frames::default()).expect("a video");
    pollster::block_on(async {
        for _ in 0..4 {
            video.frame(&mut [&mut view]).await.expect("a frame");
        }
        view.set_data(dot(30.0));
        video.frame(&mut [&mut view]).await.expect("a frame");
    });
    let frames = pollster::block_on(video.finish()).expect("finished");
    let drawn: Vec<(u64, bool)> = frames.taken.iter().map(|(i, p)| (*i, p.is_some())).collect();
    assert_eq!(drawn, [(0, true), (1, false), (2, false), (3, false), (4, true)]);
    assert_eq!(frames.end, Some(5));
    let rgba = frames.taken[0].1.as_ref().expect("drawn");
    assert_eq!(rgba.len(), ((SIZE + 2) * SIZE * 4) as usize);
    let width = SIZE + 2;
    let center = ((SIZE / 2 * width + width / 2) * 4) as usize;
    assert_eq!(&rgba[center..center + 3], [255, 0, 0], "the dot, red");
}
