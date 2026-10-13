//! Layouts place the vertices their data gives no position: layered in ranks along the flow, stress
//! at graph distances; vertices with positions stay where they are.

#![cfg(feature = "gpu")]

mod common;

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use common::{SIZE, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Camera, Data, Edges, Layered, Layout, Patch, Scene, Stress, Table, Vertices, View};

/// Renders frames until `pending` resolves, within the settle deadline.
fn answer<T>(gpu: &latkit::Gpu, view: &mut View, pending: impl Future<Output = latkit::Result<T>>) -> T {
    let mut pending = pin!(pending);
    let mut context = Context::from_waker(Waker::noop());
    let started = std::time::Instant::now();
    loop {
        if let Poll::Ready(value) = pending.as_mut().poll(&mut context) {
            return value.expect("an answer");
        }
        assert!(started.elapsed() < common::SETTLE, "the query answers within {:?}", common::SETTLE);
        step(gpu, view);
    }
}

/// A chain 1 → 2 → 3 and a branch 2 → 4; node 1 at `pin` when given.
fn graph(pin: Option<[f64; 2]>) -> Data {
    let (x, y) = match pin {
        Some([x, y]) => (vec![Some(x), None, None, None], vec![Some(y), None, None, None]),
        None => (vec![None; 4], vec![None; 4]),
    };
    let mut data = Data::new("graph");
    data.apply(Patch::new().set(Table::new("Node", vec![1_u64, 2, 3, 4]).field("x", x).field("y", y)).set(
        Table::new("Link", 3).reference("from", "Node", vec![1_u64, 2, 2]).reference("to", "Node", vec![2_u64, 3, 4]),
    ))
    .expect("valid");
    data
}

/// Where each node settled, by id.
fn placed(layout: impl Into<Layout>, pin: Option<[f64; 2]>) -> Vec<[f64; 2]> {
    let Some(gpu) = gpu() else { return Vec::new() };
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .layout(layout)
        .draw(Edges::of("graph", "Link").ends("from", "to"))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom: -2.0, pitch: 0.0, bearing: 0.0 });
    view.set_data(graph(pin));
    frame(&gpu, &mut view);
    let c = SIZE as f32 / 2.0;
    let pending = view.pick([c, c], SIZE as f32);
    let hits = answer(&gpu, &mut view, pending);
    assert_eq!(errors(&mut view), Vec::new());
    (1..=4_u64)
        .map(|id| {
            let row = latkit::Row::new("graph", "Node", id);
            hits.iter().find(|h| h.row == row).map_or([f64::NAN; 2], |h| [h.position[0], h.position[1]])
        })
        .collect()
}

fn apart(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

#[test]
fn layered_ranks_follow_the_flow() {
    let p = placed(Layered::default(), None);
    if p.is_empty() {
        return;
    }
    assert!(p.iter().all(|v| v[0].is_finite()), "every node placed and drawn: {p:?}");
    // Markers of 4 pixels at a quarter pixel per unit are 32 units across; ranks and rows of a rank
    // stand their gaps apart edge to edge.
    let size = 32.0;
    let rank_gap = Layered::default().rank_gap;
    assert!((p[1][0] - p[0][0] - rank_gap - size).abs() < 1.0, "a rank apart: {p:?}");
    assert!((p[2][0] - p[1][0] - rank_gap - size).abs() < 1.0, "a rank apart: {p:?}");
    assert!((p[2][0] - p[3][0]).abs() < 1.0, "3 and 4 share a rank: {p:?}");
    assert!(((p[2][1] - p[3][1]).abs() - Layered::default().gap - size).abs() < 1.0, "a gap apart: {p:?}");
}

#[test]
fn stress_puts_neighbors_a_gap_apart() {
    let p = placed(Stress::default(), None);
    if p.is_empty() {
        return;
    }
    let gap = Stress::default().gap;
    assert!(p.iter().all(|v| v[0].is_finite()), "every node placed and drawn: {p:?}");
    for (a, b) in [(0, 1), (1, 2), (1, 3)] {
        let d = apart(p[a], p[b]);
        assert!((d - gap).abs() < 0.35 * gap, "{a}–{b} {d} apart: {p:?}");
    }
    assert!(apart(p[2], p[3]) > 1.4 * gap, "leaves spread: {p:?}");
}

#[test]
fn pinned_vertices_stay_put() {
    for layout in [Layout::from(Stress::default()), Layout::from(Layered::default())] {
        let p = placed(layout, Some([-100.0, 60.0]));
        if p.is_empty() {
            return;
        }
        assert!(apart(p[0], [-100.0, 60.0]) < 2.0, "{layout:?}: {p:?}");
        assert!(p.iter().all(|v| v[0].is_finite()), "{layout:?}: every node placed: {p:?}");
    }
}
