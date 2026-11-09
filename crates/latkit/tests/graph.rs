//! Graphs. Edges between the same two vertices bow into lanes, edges bend through the points of a
//! path field, edges end in arrowheads, and great-circle edges settle while their vertices animate.
//! Neighbors follow edges and nets.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, answer, at, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Data, Edges, Ids, Patch, Scene, Table, Vertices, View, field};

const C: u32 = SIZE / 2;

fn lit(pixel: [u8; 4]) -> bool {
    pixel[0].max(pixel[1]).max(pixel[2]) > 60
}

fn view(gpu: &latkit::Gpu, scene: Scene, data: &Data) -> View {
    let mut view = View::new(gpu, scene.theme(plain_theme()));
    view.set_camera(camera());
    view.set_sources([data]).expect("a source");
    view
}

fn nodes(x: Vec<f64>, y: Vec<f64>) -> Table {
    let ids: Vec<u64> = (1..=x.len() as u64).collect();
    Table::new("Node", ids).field("x", x).field("y", y)
}

#[test]
fn edges_joining_the_same_vertices_bow_into_lanes_in_world_units() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(Patch::new().set(nodes(vec![-40.0, 40.0], vec![0.0, 0.0])).set(
        Table::new("Link", Ids::count(2)).reference("from", "Node", vec![1_u64, 2]).reference(
            "to",
            "Node",
            vec![2_u64, 1],
        ),
    ))
    .expect("valid");
    let scene = Scene::new(plane())
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(2.0));
    let mut view = view(&gpu, scene, &data);
    // The two edges bow half a lane each way. A lane is 0.12 of their 80-unit length, so each is
    // 4.8 units off center at the middle. Zooming scales that like the rest of the drawing.
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
    let data = Data::new("graph");
    let bends: Vec<Vec<[f64; 2]>> = vec![vec![[0.0, 30.0]], vec![]];
    data.apply(
        Patch::new().set(nodes(vec![-40.0, 40.0, 40.0], vec![0.0, 0.0, -40.0])).set(
            Table::new("Link", Ids::count(2))
                .reference("from", "Node", vec![1_u64, 2])
                .reference("to", "Node", vec![2_u64, 3])
                .field("bends", bends),
        ),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .draw(Edges::of("graph", "Link").ends("from", "to").bends("bends").width(3.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(2.0));
    let mut view = view(&gpu, scene, &data);
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
fn edges_along_great_circles_settle_while_their_vertices_pulse() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(
                Table::new("Node", Ids::count(3))
                    .field("lon", vec![-60.0, 60.0, 0.0])
                    .field("lat", vec![0.0, 0.0, 50.0]),
            )
            .set(Table::new("Link", Ids::count(2)).reference("from", "Node", vec![0_u64, 1]).reference(
                "to",
                "Node",
                vec![1_u64, 2],
            )),
    )
    .expect("valid");
    // The vertices' color reads the clock, so they evaluate every frame, but nothing the arcs
    // depend on moves.
    let pulse = latkit::elapsed().sin().colormap(latkit::Colormap::VIRIDIS).domain(-1.0..=1.0);
    let scene = Scene::new(latkit::Earth {
        graticule: false,
        ..latkit::Earth::default().projection(latkit::Projection::Globe)
    })
    .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0))
    .draw(Vertices::of("graph", "Node").position(field("lon"), field("lat")).color(pulse));
    let mut view = View::new(&gpu, scene.theme(plain_theme()));
    view.set_sources([&data]).expect("a source");
    view.fit(latkit::Fit::All);
    for _ in 0..60 {
        step(&gpu, &mut view);
    }
    assert!(view.complete(), "waiting on {}", view.waiting());
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn arrows_draw_heads_at_second_ends() {
    let Some(gpu) = gpu() else { return };
    let count = |arrows: bool| {
        let data = Data::new("graph");
        data.apply(Patch::new().set(nodes(vec![-40.0, 40.0], vec![0.0, 0.0])).set(
            Table::new("Link", Ids::count(1)).reference("from", "Node", vec![1_u64]).reference(
                "to",
                "Node",
                vec![2_u64],
            ),
        ))
        .expect("valid");
        let scene = Scene::new(plane())
            .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).arrows(arrows).color(latkit::Color::WHITE))
            .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(1.0));
        let mut view = view(&gpu, scene, &data);
        let pixels = frame(&gpu, &mut view);
        assert_eq!(errors(&mut view), Vec::new());
        pixels.iter().filter(|&&p| lit(p)).count()
    };
    let (plain, headed) = (count(false), count(true));
    assert!(headed > plain + 20, "{plain} → {headed}");
}

#[test]
fn neighbors_follow_edges_and_nets() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(nodes(vec![-40.0, 0.0, 40.0], vec![0.0, 0.0, 0.0]).reference("net", "Net", vec![1_u64, 1, 2]))
            .set(Table::new("Net", vec![1_u64, 2]))
            .set(Table::new("Link", Ids::count(1)).reference("from", "Node", vec![2_u64]).reference(
                "to",
                "Node",
                vec![3_u64],
            )),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .draw(Edges::of("graph", "Link").ends("from", "to"))
        .draw(Edges::of("graph", "Net").joins("Node", "net"))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")));
    let mut view = view(&gpu, scene, &data);
    frame(&gpu, &mut view);
    let nodes = |ids: &[u64]| vec![latkit::Rows::new("graph", "Node", ids.iter().copied())];
    let node = |id: u64| latkit::Row::new("graph", "Node", id);
    assert_eq!(view.neighbors(&node(2)), nodes(&[3, 1]));
    assert_eq!(view.neighbors(&node(1)), nodes(&[2]));
    assert_eq!(view.neighbors(&latkit::Row::new("graph", "Link", 0_u64)), nodes(&[2, 3]));
    assert_eq!(view.neighbors(&latkit::Row::new("graph", "Net", 1_u64)), nodes(&[1, 2]));
}
