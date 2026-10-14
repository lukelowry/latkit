//! Covering: a mark drawing enough instances to crowd the screen leaves out the small ones a later
//! one covers in their cells, and still draws what they show: the last drawn where they pile up, and
//! every one standing apart.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, close, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Color, Data, Lines, Scene, Table, Vertices, View, field, when};

/// Rows enough to cover.
const N: usize = 40_000;

#[test]
fn a_crowded_mark_draws_what_its_last_instances_show() {
    let Some(gpu) = gpu() else { return };
    // Every row piles up at the middle but one standing apart, early among them; the last is white.
    let mut x = vec![0.0; N];
    let mut hue = vec![0.0; N];
    x[1] = 30.0;
    hue[1] = 2.0;
    hue[N - 1] = 1.0;
    let mut data = Data::new("d");
    data.apply(Table::new("V", N).field("x", x).field("y", vec![0.0; N]).field("hue", hue)).expect("valid");
    let green = Color::rgb(0.0, 1.0, 0.0);
    let color = when(field("hue").eq(1.0))
        .then(Color::WHITE)
        .otherwise(when(field("hue").eq(2.0)).then(green).otherwise(Color::rgb(1.0, 0.0, 0.0)));
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("d", "V").position("x", "y").radius(2.0).color(color));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    assert!(close(at(&pixels, c, c), [255, 255, 255, 255]), "the last of the pile shows: {:?}", at(&pixels, c, c));
    let apart = at(&pixels, c + 30, c);
    assert!(apart[1] > 200 && apart[0] < 60, "one standing apart shows, early as it was drawn: {apart:?}");
    // The pass counted the pile: all of it but its last left out.
    let started = std::time::Instant::now();
    while view.stats().covered == 0 {
        assert!(started.elapsed() < common::SETTLE, "the count lands within {:?}", common::SETTLE);
        step(&gpu, &mut view);
    }
    assert_eq!(view.stats().covered, N as u64 - 2);
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_crowded_path_draws_whole() {
    let Some(gpu) = gpu() else { return };
    // A path of forty thousand segments, each too short to see: leaving out the segments under the
    // next would break it into dots, so a path's segments never cover.
    let n = 40_000;
    let points: Vec<[f64; 2]> = (0..=n).map(|i| [-40.0 + 80.0 * f64::from(i) / f64::from(n), 0.0]).collect();
    let mut data = Data::new("d");
    data.apply(Table::new("Path", 1).field("geometry", vec![points])).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Lines::of("d", "Path").width(2.0).color(Color::WHITE));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    let gaps: Vec<u32> = (c - 35..c + 35).filter(|&x| at(&pixels, x, c)[0] < 200).collect();
    assert!(gaps.is_empty(), "the path draws without gaps: {gaps:?}");
    for _ in 0..4 {
        step(&gpu, &mut view);
    }
    assert_eq!(view.stats().covered, 0);
    assert_eq!(errors(&mut view), Vec::new());
}
