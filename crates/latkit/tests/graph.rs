//! Graphs. Edges between the same two vertices run side by side, edges bend through the points of a
//! path field, edges end in arrowheads, and great-circle edges settle while their vertices animate.
//! Comets keep their spacing on screen along every kind of edge. Neighbors follow edges and nets.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, answer, at, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Data, Edges, Ids, Length, Patch, Scene, Table, Vertices, View, field};

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
fn edges_joining_the_same_vertices_run_side_by_side_a_step_apart_at_any_zoom() {
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
    let fan = latkit::Parallel { gap: 3.0, converge: latkit::Converge::Fan };
    let theme =
        latkit::Theme { edge: latkit::EdgeTheme { parallel: Some(fan), ..plain_theme().edge }, ..plain_theme() };
    let scene = Scene::new(plane())
        .theme(theme)
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).color(latkit::Color::WHITE.alpha(0.5)))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(4.0));
    let mut view = View::new(&gpu, scene);
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    // A step is the width plus the gap, 5 pixels, so the two edges run 2.5 pixels either side of
    // the middle, whatever the zoom.
    for zoom in [0.0, 1.0] {
        view.set_camera(latkit::Camera::Map { center: [0.0; 3], zoom, pitch: 0.0, bearing: 0.0 });
        let pixels = frame(&gpu, &mut view);
        assert!(lit(at(&pixels, C, C - 3)) && lit(at(&pixels, C, C + 2)), "two lanes at zoom {zoom}");
        assert!(!lit(at(&pixels, C, C)) && !lit(at(&pixels, C, C - 1)), "apart at zoom {zoom}");
        // Each lane draws as one stroke, its fans included: half white where it covers a pixel
        // fully, and no brighter where its pieces meet. Every column along the upper lane has such
        // a pixel.
        for x in C - 28..=C + 28 {
            let peak = (C - 12..C).map(|y| at(&pixels, x, y)[0]).max().unwrap_or(0);
            assert!((120..=136).contains(&peak), "column {x} at zoom {zoom} peaks at {peak}");
        }
    }
    // A vertex that moves takes its lanes along without their segments being listed again: each
    // frame draws the instances it drew before and reads no count back.
    let (drawn, before) = (view.stats().instances, gpu.work());
    for y in [2.0, 4.0, 6.0] {
        data.apply(Table::new("Node", vec![1_u64]).field("y", vec![y])).expect("valid");
        step(&gpu, &mut view);
        assert_eq!(view.stats().instances, drawn, "as many instances with the vertex at {y}");
    }
    assert_eq!((gpu.work() - before).readbacks, 0, "no segment is counted again");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn comets_keep_their_spacing_on_screen_along_every_path() {
    let Some(gpu) = gpu() else { return };
    // Near 60°N, where a degree of latitude draws twice as long as one of longitude: an edge running
    // north, a great circle running east, and three edges joining the same two vertices, the outer
    // two fanning into them. Red comets 12 pixels apart move so slowly they stand still, on lines
    // and vertices with no red.
    let data = Data::new("graph");
    let x = vec![0.0, 0.0, 0.08, 0.58, 0.08, 0.58];
    let y = vec![59.92, 60.16, 60.13, 60.13, 59.98, 59.98];
    let links = Table::new("Link", Ids::count(5)).reference("from", "Node", vec![1_u64, 3, 5, 5, 5]).reference(
        "to",
        "Node",
        vec![2_u64, 4, 6, 6, 6],
    );
    data.apply(Patch::new().set(nodes(x.clone(), y.clone())).set(links)).expect("valid");
    let red = latkit::Color::rgb(1.0, 0.0, 0.0);
    let flow = latkit::FlowTheme { color: red, spacing: Length::Px(12.0), length: Length::Px(4.0), width: 4.0 };
    let fan = latkit::Parallel { gap: 3.0, converge: latkit::Converge::Fan };
    let edge = latkit::EdgeTheme { parallel: Some(fan), ..plain_theme().edge };
    let theme = latkit::Theme { flow, edge, ..plain_theme() };
    let green = latkit::Color::rgb(0.0, 0.3, 0.0);
    for projection in [latkit::Projection::Mercator, latkit::Projection::Globe] {
        let earth = latkit::Earth { grid: latkit::Grid::Off, ..latkit::Earth::default().projection(projection) };
        let scene = Scene::new(earth)
            .theme(theme.clone())
            .draw(Edges::of("graph", "Link").ends("from", "to").width(1.0).color(green).flow(1e-4))
            .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(1.0).color(green));
        let mut view = View::new(&gpu, scene);
        view.set_sources([&data]).expect("a source");
        // Two zooms looking straight down, and tilted. The frame after the camera moves paints comets
        // with their rows, and the frames after it, where only comets move, draw them apart.
        for (zoom, pitch) in [(8.0, 0.0), (7.5, 0.0), (8.0, 40.0)] {
            view.set_camera(latkit::Camera::Map { center: [0.3, 60.04, 0.0], zoom, pitch, bearing: 0.0 });
            let frames: Vec<_> = (0..4).map(|_| step(&gpu, &mut view)).collect();
            let on = |i: usize| view.screen([x[i], y[i], 0.0]).expect("on screen");
            // The middle of each path, and of each lane beside the family's middle: a step apart,
            // its width plus the gap.
            let middle = |a: [f32; 2], b: [f32; 2], beside: f32| {
                let (d, n) = ([b[0] - a[0], b[1] - a[1]], (b[0] - a[0]).hypot(b[1] - a[1]));
                let at = |t: f32| [0, 1].map(|k| a[k] + d[k] * t + [-d[1], d[0]][k] / n * beside);
                (at(0.25), at(0.75))
            };
            let paths = [
                ("north", middle(on(0), on(1), 0.0)),
                ("great circle", middle(on(2), on(3), 0.0)),
                ("fan", middle(on(4), on(5), 4.0)),
                ("other fan", middle(on(4), on(5), -4.0)),
            ];
            for ((path, (a, b)), pixels) in paths.into_iter().flat_map(|p| [(p, &frames[0]), (p, &frames[3])]) {
                let heads = common::heads_along(pixels, a, b);
                let gaps: Vec<u32> = heads.windows(2).map(|w| w[1] - w[0]).collect();
                assert!(
                    !gaps.is_empty() && gaps.iter().all(|&gap| gap.abs_diff(12) <= 2),
                    "{projection:?} at zoom {zoom}, pitch {pitch}: comets along the {path} lie {gaps:?} apart"
                );
            }
        }
    }
}

#[test]
fn a_theme_without_parallel_edges_draws_edges_joining_the_same_vertices_over_one_another() {
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
    let straight = latkit::EdgeTheme { parallel: None, ..plain_theme().edge };
    let scene = Scene::new(plane())
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).color(latkit::Color::WHITE))
        .draw(Vertices::of("graph", "Node").position(field("x"), field("y")).radius(2.0));
    let mut view = View::new(&gpu, scene.theme(latkit::Theme { edge: straight, ..plain_theme() }));
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert!(lit(at(&pixels, C, C)), "both run through the middle: {:?}", at(&pixels, C, C));
    assert!(!lit(at(&pixels, C, C - 5)) && !lit(at(&pixels, C, C + 5)), "and neither runs beside the other");
    // The backdrop, and one instance an edge and a vertex: no lane is derived or listed.
    assert_eq!(view.stats().instances, 5);
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
        grid: latkit::Grid::Off,
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
