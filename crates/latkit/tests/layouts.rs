//! Layouts place a diagram's vertices its data gives no position: layered in ranks along the flow,
//! nets running from their outputs, stress at graph distances with boxes parted; on a plane, points
//! among their neighbors. Vertices with positions stay where they are, places hold once given, and
//! rows added later are placed around the rest until the view arranges every row again, answering
//! with a patch that writes the places into the data.

#![cfg(feature = "gpu")]

mod common;

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use common::{diagram, errors, frame, gpu, plain_theme, step};
use latkit::{Camera, Data, Edges, Ids, Layered, Layout, Patch, Port, Row, Scene, Side, Stress, Table, Vertices, View};

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

/// A chain 1 → 2 → 3 and a branch 2 → 4; node 1 at `pin` when given.
fn graph(pin: Option<[f64; 2]>) -> Data {
    let (x, y) = match pin {
        Some([x, y]) => (vec![Some(x), None, None, None], vec![Some(y), None, None, None]),
        None => (vec![None; 4], vec![None; 4]),
    };
    let data = Data::new("graph");
    data.apply(Patch::new().set(Table::new("Node", vec![1_u64, 2, 3, 4]).field("x", x).field("y", y)).set(
        Table::new("Link", Ids::count(3)).reference("from", "Node", vec![1_u64, 2, 2]).reference(
            "to",
            "Node",
            vec![2_u64, 3, 4],
        ),
    ))
    .expect("valid");
    data
}

fn scene(layout: impl Into<Layout>) -> Scene {
    Scene::new(diagram())
        .theme(plain_theme())
        .layout(layout)
        .draw(Edges::of("graph", "Link").ends("from", "to"))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0))
}

fn view(gpu: &latkit::Gpu, scene: Scene, data: &Data) -> View {
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [0.0; 3], zoom: -2.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([data]).expect("a source");
    frame(gpu, &mut view);
    view
}

/// Where each of nodes 1 to `count` stands, units with y down, as the view locates it on screen.
fn located(gpu: &latkit::Gpu, view: &mut View, count: u64) -> Vec<[f64; 2]> {
    let projected = |p: [f32; 2]| {
        // A quarter pixel per unit, about the middle of the view.
        let c = f64::from(common::SIZE) / 2.0;
        [(f64::from(p[0]) - c) * 4.0, (f64::from(p[1]) - c) * 4.0]
    };
    (1..=count)
        .map(|id| {
            let pending = view.screen_of(&Row::new("graph", "Node", id));
            answer(gpu, view, pending).map_or([f64::NAN; 2], projected)
        })
        .collect()
}

/// Where each node settled under `layout`, units.
fn placed(layout: impl Into<Layout>, pin: Option<[f64; 2]>) -> Vec<[f64; 2]> {
    let Some(gpu) = gpu() else { return Vec::new() };
    let mut view = view(&gpu, scene(layout), &graph(pin));
    let p = located(&gpu, &mut view, 4);
    assert_eq!(errors(&mut view), Vec::new());
    p
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
    // Markers of radius 4 are 8 units across; ranks and rows of a rank stand their gaps apart edge to
    // edge.
    let size = 8.0;
    let rank_gap = Layered::default().rank_gap;
    assert!((p[1][0] - p[0][0] - rank_gap - size).abs() < 1.0, "a rank apart: {p:?}");
    assert!((p[2][0] - p[1][0] - rank_gap - size).abs() < 1.0, "a rank apart: {p:?}");
    assert!((p[2][0] - p[3][0]).abs() < 1.0, "3 and 4 share a rank: {p:?}");
    assert!(((p[2][1] - p[3][1]).abs() - Layered::default().gap - size).abs() < 1.0, "a gap apart: {p:?}");
}

#[test]
fn nets_run_from_their_outputs() {
    // Nodes 1 and 2 drive the net from their outputs, 3 reads it, and 4 drives 1.
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(
                Table::new("Node", vec![1_u64, 2, 3, 4])
                    .field("x", vec![None::<f64>; 4])
                    .field("y", vec![None::<f64>; 4])
                    .reference("out", "Net", vec![Some(1_u64), Some(1), None, Some(2)])
                    .reference("in", "Net", vec![Some(2_u64), None, Some(1), None]),
            )
            .set(Table::new("Net", vec![1_u64, 2])),
    )
    .expect("valid");
    let scene = Scene::new(diagram()).layout(Layered::default()).draw(Edges::of("graph", "Net")).draw(
        Vertices::of("graph", "Node")
            .position("x", "y")
            .radius(4.0)
            .port("in", Side::Left)
            .port("out", Port::output(Side::Right)),
    );
    let mut view = view(&gpu, scene, &data);
    let p = located(&gpu, &mut view, 4);
    let gap = Layered::default().rank_gap;
    assert!(p[0][0] - p[3][0] > gap, "1 a rank after 4, which drives it: {p:?}");
    assert!((p[1][0] - p[3][0]).abs() < 1.0, "2 drives the net 3 reads, so it shares 4's rank: {p:?}");
    assert!(p[2][0] - p[0][0] > gap, "3 reads after both drivers: {p:?}");
    assert_eq!(errors(&mut view), Vec::new());
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
fn stress_parts_the_boxes_it_crowds() {
    let Some(gpu) = gpu() else { return };
    let scene = Scene::new(diagram())
        .theme(plain_theme())
        .layout(Stress::default())
        .draw(Edges::of("graph", "Link").ends("from", "to"))
        .draw(Vertices::of("graph", "Node").position("x", "y").size(60.0, 20.0));
    let mut view = view(&gpu, scene, &graph(None));
    let p = located(&gpu, &mut view, 4);
    // Stress puts neighbors 40 units apart; their 60 by 20 boxes part, a quarter of the gap clear.
    for i in 0..4 {
        for j in i + 1..4 {
            let (dx, dy) = ((p[i][0] - p[j][0]).abs(), (p[i][1] - p[j][1]).abs());
            assert!(dx >= 64.0 || dy >= 24.0, "{i} and {j} overlap: {p:?}");
        }
    }
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn pinned_vertices_stay_put() {
    for layout in [Layout::from(Stress::default()), Layout::from(Layered::default())] {
        let p = placed(layout, Some([-100.0, 60.0]));
        if p.is_empty() {
            return;
        }
        assert!(apart(p[0], [-100.0, 60.0]) < 4.0, "{layout:?}: {p:?}");
        assert!(p.iter().all(|v| v[0].is_finite()), "{layout:?}: every node placed: {p:?}");
    }
}

#[test]
fn rows_added_later_move_nothing_else() {
    let Some(gpu) = gpu() else { return };
    let data = graph(None);
    let mut view = view(&gpu, scene(Layered::default()), &data);
    let before = located(&gpu, &mut view, 4);
    // A fifth node joins the end of the chain: the four placed hold, and it is placed after them.
    data.apply(
        Patch::new()
            .set(Table::new("Node", vec![5_u64]).field("x", vec![None::<f64>]).field("y", vec![None::<f64>]))
            .set(Table::new("Link", vec![3_u64]).reference("from", "Node", vec![3_u64]).reference(
                "to",
                "Node",
                vec![5_u64],
            )),
    )
    .expect("valid");
    frame(&gpu, &mut view);
    let after = located(&gpu, &mut view, 5);
    for k in 0..4 {
        assert!(apart(before[k], after[k]) < 1e-3, "node {} held: {before:?} → {after:?}", k + 1);
    }
    assert!(after[4][0] > after[2][0], "the new node after the one it follows: {after:?}");
    // Arranged, every row is laid out again, and the answer writes the places into the data.
    let pending = view.arrange();
    let patches = answer(&gpu, &mut view, pending);
    frame(&gpu, &mut view);
    let arranged = located(&gpu, &mut view, 5);
    assert!(arranged.iter().all(|p| p[0].is_finite()), "every node placed again: {arranged:?}");
    let [patch] = &patches[..] else { panic!("one dataset's patch: {patches:?}") };
    assert_eq!(patch.data().map(latkit::Name::as_str), Some("graph"));
    data.apply(patch.clone()).expect("valid");
    let node = data.snapshot().query(&latkit::Query::of("Node")).expect("nodes").table;
    assert!(node.ids().all(|id| node.get(id, "x").is_some()), "every node has its place as data");
    frame(&gpu, &mut view);
    let pinned = located(&gpu, &mut view, 5);
    for k in 0..5 {
        assert!(apart(arranged[k], pinned[k]) < 0.5, "node {} holds its place: {arranged:?} → {pinned:?}", k + 1);
    }
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_plane_places_points_without_positions_by_its_layout() {
    let Some(gpu) = gpu() else { return };
    let scene = |layout: Layout| {
        Scene::new(latkit::Plane::default())
            .theme(plain_theme())
            .layout(layout)
            .draw(Edges::of("graph", "Link").ends("from", "to"))
            .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0))
    };
    let mut view = view(&gpu, scene(Stress { gap: 40.0 }.into()), &graph(Some([-100.0, 60.0])));
    let p = located(&gpu, &mut view, 4);
    // The plane runs y up: on screen node 1 stands 60 units above the middle.
    assert!(apart(p[0], [-100.0, -60.0]) < 1.0, "node 1 where its data says: {p:?}");
    assert!(p.iter().all(|v| v[0].is_finite()), "every node placed: {p:?}");
    assert!((apart(p[0], p[1]) - 40.0).abs() < 15.0, "node 2 a gap from node 1: {p:?}");
    // Without a layout, rows without positions are not drawn.
    view.set_scene(scene(Layout::None)).expect("valid scene");
    frame(&gpu, &mut view);
    assert!(located(&gpu, &mut view, 2)[1][0].is_nan(), "unplaced");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn layouts_answer_the_same_for_the_same_graph() {
    for layout in [Layout::from(Stress::default()), Layout::from(Layered::default())] {
        let (a, b) = (placed(layout, None), placed(layout, None));
        assert_eq!(a, b, "{layout:?}");
    }
}
