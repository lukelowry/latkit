//! The graph: edges joining the same two vertices bow into lanes, edges bend through the points of
//! a path field, and edges end in arrowheads; in a diagram, nets join the ports of the vertices
//! naming them, and orthogonal wires route around blocks.

#![cfg(feature = "gpu")]

mod common;

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use common::{SIZE, at, camera, diagram, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Data, Edges, Patch, Port, Scene, Side, Table, Vertices, View};

const C: u32 = SIZE / 2;

fn lit(pixel: [u8; 4]) -> bool {
    pixel[0].max(pixel[1]).max(pixel[2]) > 60
}

fn show(gpu: &latkit::Gpu, scene: Scene, data: Data) -> View {
    let mut view = View::new(gpu, scene.theme(plain_theme())).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    view
}

fn nodes(x: Vec<f64>, y: Vec<f64>) -> Table {
    let ids: Vec<u64> = (1..=x.len() as u64).collect();
    Table::new("Node", ids).field("x", x).field("y", y)
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
fn edges_joining_the_same_vertices_bow_into_lanes_in_world_units() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Patch::new().set(nodes(vec![-40.0, 40.0], vec![0.0, 0.0])).set(
            Table::new("Link", 2).reference("from", "Node", vec![1_u64, 2]).reference("to", "Node", vec![2_u64, 1]),
        ),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(2.0));
    let mut view = show(&gpu, scene, data);
    // Half a lane each way, bowing 0.12 of the edges' 80 units a lane: 4.8 units off at the middle,
    // which zooming in scales as it does the rest of the drawing.
    for (zoom, off) in [(0.0, 5), (1.0, 10)] {
        view.set_camera(latkit::Camera::Map { center: [0.0; 3], zoom, pitch: 0.0, bearing: 0.0 });
        let pixels = frame(&gpu, &mut view);
        assert!(lit(at(&pixels, C, C - off)) && lit(at(&pixels, C, C + off)), "two lanes at zoom {zoom}");
        assert!(!lit(at(&pixels, C, C)), "apart at zoom {zoom}: {:?}", at(&pixels, C, C));
    }
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn edges_bend_through_their_points_and_pick_there() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    let bends: Vec<Vec<[f64; 2]>> = vec![vec![[0.0, 30.0]], vec![]];
    data.apply(
        Patch::new().set(nodes(vec![-40.0, 40.0, 40.0], vec![0.0, 0.0, -40.0])).set(
            Table::new("Link", 2)
                .reference("from", "Node", vec![1_u64, 2])
                .reference("to", "Node", vec![2_u64, 3])
                .field("bends", bends),
        ),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .draw(Edges::of("graph", "Link").ends("from", "to").bends("bends").width(3.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(2.0));
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    assert!(lit(at(&pixels, C, C - 30)), "through its bend");
    assert!(!lit(at(&pixels, C, C)), "not straight across");
    assert!(lit(at(&pixels, C + 40, C + 20)), "a row without bends runs straight");
    let pending = view.pick([C as f32, C as f32 - 30.0], 4.0);
    let hits = answer(&gpu, &mut view, pending);
    assert_eq!(
        hits.first().map(|h| (h.row.table.to_string(), h.row.id.to_string())),
        Some(("Link".into(), "0".into()))
    );
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn nets_join_the_ports_naming_them() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(nodes(vec![-40.0, 40.0, 0.0, 0.0], vec![0.0, 0.0, -40.0, 50.0]).reference(
                "net",
                "Net",
                vec![1_u64, 1, 2, 2],
            ))
            .set(Table::new("Net", vec![1_u64, 2])),
    )
    .expect("valid");
    let scene = Scene::new(diagram())
        .draw(Edges::of("graph", "Net").width(3.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(5.0).port("net", Port::new(Side::Top)));
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    // Net 1 joins the tops of nodes 1 and 2, five units above their centers.
    assert!(lit(at(&pixels, C, C - 5)), "between the ports");
    assert!(!lit(at(&pixels, C - 20, C)), "not between the centers");
    // Net 2 joins node 3, above, to node 4, below, from top to top.
    assert!(lit(at(&pixels, C, C + 20)), "a net of two runs straight");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn nets_of_more_than_two_meet_at_a_junction() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(nodes(vec![-40.0, 40.0, 0.0], vec![0.0, 0.0, 45.0]).reference("net", "Net", vec![1_u64, 1, 1]))
            .set(Table::new("Net", vec![1_u64])),
    )
    .expect("valid");
    let scene = Scene::new(diagram())
        .draw(Edges::of("graph", "Net").width(3.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(2.0).port("net", Side::Left));
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    // The junction sits at the middle of the three ports, 15 units down and 2 left.
    assert!(lit(at(&pixels, C - 2, C + 15)), "at the junction");
    assert!(lit(at(&pixels, C - 2, C + 30)), "to the third terminal");
    assert!(!lit(at(&pixels, C, C - 20)), "nothing above");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn arrows_draw_heads_at_second_ends() {
    let Some(gpu) = gpu() else { return };
    let count = |arrows: bool| {
        let mut data = Data::new("graph");
        data.apply(
            Patch::new()
                .set(nodes(vec![-40.0, 40.0], vec![0.0, 0.0]))
                .set(Table::new("Link", 1).reference("from", "Node", vec![1_u64]).reference("to", "Node", vec![2_u64])),
        )
        .expect("valid");
        let scene = Scene::new(plane())
            .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).arrows(arrows).color(latkit::Color::WHITE))
            .draw(Vertices::of("graph", "Node").position("x", "y").radius(1.0));
        let mut view = show(&gpu, scene, data);
        let pixels = frame(&gpu, &mut view);
        assert_eq!(errors(&mut view), Vec::new());
        pixels.iter().filter(|&&p| lit(p)).count()
    };
    let (plain, headed) = (count(false), count(true));
    assert!(headed > plain + 20, "{plain} → {headed}");
}

#[test]
fn ports_draw_on_their_sides_and_pick_by_name() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(nodes(vec![-40.0, 40.0], vec![0.0, 0.0]).reference("in", "Net", vec![1_u64, 1]).reference(
                "out",
                "Net",
                vec![2_u64, 2],
            ))
            .set(Table::new("Net", vec![1_u64, 2])),
    )
    .expect("valid");
    let scene = Scene::new(diagram()).draw(
        Vertices::of("graph", "Node")
            .position("x", "y")
            .radius(8.0)
            .color(latkit::Color::WHITE)
            .port("in", Side::Left)
            .port("out", Port::output(Side::Right)),
    );
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    assert!(lit(at(&pixels, C - 50, C)) && lit(at(&pixels, C - 30, C)), "a port on each side");
    assert!(!lit(at(&pixels, C - 40, C - 11)), "none on top");
    let pending = view.pick([C as f32 - 50.0, C as f32], 2.0);
    let hits = answer(&gpu, &mut view, pending);
    assert_eq!(hits.first().and_then(|h| h.port.as_ref()).map(ToString::to_string).as_deref(), Some("in"));
    let pending = view.pick([C as f32 + 50.0, C as f32], 2.0);
    let hits = answer(&gpu, &mut view, pending);
    assert_eq!(hits.first().and_then(|h| h.port.as_ref()).map(ToString::to_string).as_deref(), Some("out"));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn orthogonal_routes_run_around_vertices() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(nodes(vec![-50.0, 50.0, 0.0], vec![0.0, 0.0, 0.0]))
            .set(Table::new("Link", 1).reference("from", "Node", vec![1_u64]).reference("to", "Node", vec![2_u64])),
    )
    .expect("valid");
    let scene = Scene::new(diagram())
        .draw(
            Edges::of("graph", "Link")
                .ends("from", "to")
                .route(latkit::Route::Orthogonal)
                .width(2.0)
                .color(latkit::Color::rgb(0.0, 1.0, 0.0)),
        )
        .draw(
            Vertices::of("graph", "Node")
                .position("x", "y")
                .size(20.0, 20.0)
                .marker(latkit::Shape::Rectangle)
                .color(latkit::Color::rgb(1.0, 0.0, 0.0)),
        );
    let mut view = show(&gpu, scene, data);
    let pixels = frame(&gpu, &mut view);
    let green = |y: u32| at(&pixels, C, y)[1] > 120 && at(&pixels, C, y)[0] < 60;
    // A straight edge would run under node 3, hidden; the route goes over or under it.
    let around = (C - 45..C - 11).chain(C + 11..C + 45).any(green);
    assert!(around, "around the vertex between");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn many_routes_route_in_a_job_and_land() {
    let Some(gpu) = gpu() else { return };
    let links = |n: usize| {
        let mut data = Data::new("graph");
        data.apply(Patch::new().set(nodes(vec![-50.0, 50.0, 0.0], vec![0.0, 0.0, 0.0])).set(
            Table::new("Link", n).reference("from", "Node", vec![1_u64; n]).reference("to", "Node", vec![2_u64; n]),
        ))
        .expect("valid");
        data
    };
    let scene = Scene::new(diagram())
        .draw(Edges::of("graph", "Link").ends("from", "to").route(latkit::Route::Orthogonal).width(2.0))
        .draw(Vertices::of("graph", "Node").position("x", "y").size(20.0, 20.0).marker(latkit::Shape::Rectangle));
    let mut view = show(&gpu, scene, links(1));
    frame(&gpu, &mut view);
    // More wires than route on the frame: they draw as elbows until the job's routes land.
    view.set_data(links(64));
    for _ in 0..4 {
        step(&gpu, &mut view);
    }
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn neighbors_follow_edges_and_nets() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(nodes(vec![-40.0, 0.0, 40.0], vec![0.0, 0.0, 0.0]).reference("net", "Net", vec![1_u64, 1, 2]))
            .set(Table::new("Net", vec![1_u64, 2]))
            .set(Table::new("Link", 1).reference("from", "Node", vec![2_u64]).reference("to", "Node", vec![3_u64])),
    )
    .expect("valid");
    let scene = Scene::new(diagram())
        .draw(Edges::of("graph", "Link").ends("from", "to"))
        .draw(Edges::of("graph", "Net"))
        .draw(Vertices::of("graph", "Node").position("x", "y").port("net", Side::Top));
    let mut view = show(&gpu, scene, data);
    frame(&gpu, &mut view);
    let node = |id: u64| latkit::Row::new("graph", "Node", id);
    assert_eq!(view.neighbors(&node(2)), vec![node(3), node(1)]);
    assert_eq!(view.neighbors(&node(1)), vec![node(2)]);
    assert_eq!(view.neighbors(&latkit::Row::new("graph", "Link", 0_u64)), vec![node(2), node(3)]);
    assert_eq!(view.neighbors(&latkit::Row::new("graph", "Net", 1_u64)), vec![node(1), node(2)]);
}
