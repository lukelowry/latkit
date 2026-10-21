//! Scale: what a view draws always fits. Tables too large to draw whole draw the tiles in view,
//! traces too large thin in time, what matters more draws on top, a page never outgrows a chunk, and
//! a view sleeps while it waits.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, close, errors, frame, gpu, plain_theme, plane};
use latkit::{
    Axis, Budget, Camera, Color, Data, Edges, Fit, Frame, Ids, Lines, Patch, Plot, Row, Scene, Table, Vertices, View,
    field, when,
};

/// A grid of `columns` by `rows` vertices a unit apart, from the origin, and an edge from each to
/// the next in its row.
fn lattice(columns: usize, rows: usize) -> Data {
    let n = columns * rows;
    let x: Vec<f64> = (0..n).map(|i| (i % columns) as f64).collect();
    let y: Vec<f64> = (0..n).map(|i| (i / columns) as f64).collect();
    let links: Vec<usize> = (0..n).filter(|i| i % columns + 1 < columns).collect();
    let from: Vec<u64> = links.iter().map(|&i| i as u64).collect();
    let to: Vec<u64> = links.iter().map(|&i| i as u64 + 1).collect();
    let mut data = Data::new("grid");
    data.apply(Patch::new().set(Table::new("Bus", Ids::count(n as u32)).field("x", x).field("y", y)).set(
        Table::new("Line", Ids::count(links.len() as u32)).reference("from", "Bus", from).reference("to", "Bus", to),
    ))
    .expect("valid");
    data
}

#[test]
fn what_matters_more_draws_on_top() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(
        Table::new("Node", Ids::count(2))
            .field("x", vec![0.0, 0.0])
            .field("y", vec![0.0, 0.0])
            .field("p", vec![2.0, 1.0])
            .field("kind", vec!["a", "b"]),
    )
    .expect("valid");
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);
    let mark = Vertices::of("graph", "Node")
        .position("x", "y")
        .radius(8.0)
        .color(when(field("kind").is("a")).then(red).otherwise(blue));
    let center = SIZE / 2;
    for (priority, want) in [(false, [0, 0, 255, 255]), (true, [255, 0, 0, 255])] {
        let mark = if priority { mark.clone().priority(field("p")) } else { mark.clone() };
        let mut view = View::new(&gpu, Scene::new(plane()).theme(plain_theme()).draw(mark)).expect("valid scene");
        view.set_camera(camera());
        view.set_data(data.clone());
        let pixels = frame(&gpu, &mut view);
        assert!(close(at(&pixels, center, center), want), "priority {priority}: {:?}", at(&pixels, center, center));
    }
}

#[test]
fn a_table_that_starts_empty_draws_its_rows() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(0)).field("x", Vec::<f64>::new()).field("y", Vec::<f64>::new()))
        .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data.clone());
    frame(&gpu, &mut view);
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "its constant color and visibility evaluate");
}

#[test]
fn a_dense_table_draws_the_tiles_in_view_and_keeps_what_is_selected() {
    let Some(gpu) = gpu() else { return };
    let (columns, rows) = (600, 500);
    let data = lattice(columns, rows);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    let stats = view.stats();
    assert_eq!(stats.rows, (columns * rows) as u64);
    assert!(stats.drawn > 0 && stats.drawn < stats.rows / 4, "the tiles in view: {} of {}", stats.drawn, stats.rows);
    // Zoomed in, every row in view draws: rows a unit apart are eight pixels apart.
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "a row at the middle");
    assert!(close(at(&pixels, center + 4, center + 4), [0, 0, 0, 255]), "and none between rows");
    // A row far from the tiles in view stays selected, and draws.
    let far = Row::new("grid", "Bus", 7_u64);
    view.select([far.clone().into()]);
    frame(&gpu, &mut view);
    assert_eq!(view.selection(), [latkit::Rows::from(far)]);
    assert_eq!(view.stats().drawn, stats.drawn + 1, "the selected row draws whatever its tile");
}

#[test]
fn panning_a_dense_table_draws_every_row_in_view_as_tiles_come_and_go() {
    let Some(gpu) = gpu() else { return };
    let (columns, rows) = (600, 500);
    // Without an ease, rows arriving draw at once.
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(lattice(columns, rows));
    let center = SIZE / 2;
    let camera = |x: f64| Camera::Map { center: [x, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 };
    let mut in_place = 0;
    for step in 0..6 {
        view.set_camera(camera(100.0 + 60.0 * f64::from(step)));
        // While the rows still drawn stay where they were, those arriving in holes and past the last
        // row, every row in view draws.
        for _ in 0..4 {
            let pixels = common::step(&gpu, &mut view);
            let waiting = view.stats().waiting;
            if step > 0 && !waiting.data && !waiting.marks && !view.complete() {
                let pixel = |dx: u32, dy: u32| at(&pixels, center + dx, center + dy);
                assert!(close(pixel(0, 0), [255, 255, 255, 255]), "step {step}, in place: {:?}", pixel(0, 0));
                assert!(close(pixel(4, 0), [0, 255, 0, 255]), "step {step}, in place: {:?}", pixel(4, 0));
                in_place += 1;
            }
        }
        let pixels = frame(&gpu, &mut view);
        assert_eq!(errors(&mut view), []);
        assert!(view.complete(), "every row laid out in drawing order once the camera rests");
        let stats = view.stats();
        assert!(stats.drawn > 0 && stats.drawn < stats.rows / 4, "step {step}: {} of {}", stats.drawn, stats.rows);
        let pixel = |dx: u32, dy: u32| at(&pixels, center + dx, center + dy);
        assert!(close(pixel(0, 0), [255, 255, 255, 255]), "step {step}: a row at the middle: {:?}", pixel(0, 0));
        assert!(close(pixel(4, 4), [0, 0, 0, 255]), "step {step}: none between rows: {:?}", pixel(4, 4));
        assert!(close(pixel(4, 0), [0, 255, 0, 255]), "step {step}: an edge between two: {:?}", pixel(4, 0));
    }
    assert!(in_place > 0, "rows were written in place");
    // A row picked by id is found among the rows drawn, holes and all.
    let selected = Row::new("grid", "Bus", (250 * columns + 400) as u64);
    view.select([selected.clone().into()]);
    view.set_camera(camera(380.0));
    frame(&gpu, &mut view);
    assert_eq!(view.selection(), [latkit::Rows::from(selected)], "what is selected stays so");
    assert_eq!(errors(&mut view), []);
}

#[test]
fn a_change_to_one_row_drawn_in_part_writes_that_row_alone() {
    let Some(gpu) = gpu() else { return };
    // Four pages of rows drawn whole in priority order, so each is drawn far from its place in the
    // table; every row lies off view but one, at the middle.
    let (rows, middle) = (200_000_u32, 12_345_u32);
    let n = rows as usize;
    let off = |r: usize| if r == middle as usize { 0.0 } else { 1000.0 };
    let mut data = Data::new("points");
    data.apply(
        Table::new("P", Ids::count(rows))
            .field("x", (0..n).map(off).collect::<Vec<_>>())
            .field("y", vec![0.0; n])
            .field("p", (0..n).map(|r| ((r * 7919) % n) as f64).collect::<Vec<_>>())
            .field("v", vec![0.0; n]),
    )
    .expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).ease(std::time::Duration::ZERO).draw(
        Vertices::of("points", "P")
            .position("x", "y")
            .radius(4.0)
            .priority(field("p"))
            .color(field("v").colormap(latkit::Colormap::GRAYS).domain(0.0..=1.0)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data.clone());
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert_eq!(view.stats().drawn, u64::from(rows), "every row draws, in priority order");
    let before = gpu.work();
    data.apply(Table::new("P", vec![u64::from(middle)]).field("v", vec![1.0])).expect("valid");
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let work = gpu.work() - before;
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "{:?}", at(&pixels, center, center));
    assert!(work.evaluated <= 1 << 16, "one page of the rows drawn evaluates: {}", work.evaluated);
    assert!(work.uploaded <= 8 << 16, "one page of the field drawn uploads: {} bytes", work.uploaded);
}

#[test]
fn a_field_drawn_in_part_that_changes_kind_gathers_afresh() {
    let Some(gpu) = gpu() else { return };
    // Two marks of one table drawn in part: one reads `v` as a number, the other as a text, so `v` is
    // read before and after it changes kind.
    let n = 1000_usize;
    let table = |v: latkit::Values| {
        Table::new("P", Ids::count(n as u32))
            .field("x", vec![0.0; n])
            .field("y", vec![0.0; n])
            .field("p", (0..n).map(|r| r as f64).collect::<Vec<_>>())
            .field("v", v)
    };
    let mut data = Data::new("points");
    data.apply(table(vec![0.5; n].into())).expect("valid");
    let number = Vertices::of("points", "P")
        .position("x", "y")
        .priority(field("p"))
        .color(field("v").colormap(latkit::Colormap::GRAYS));
    let text = Vertices::of("points", "P")
        .named("text")
        .position("x", "y")
        .color(when(field("v").is("a")).then(Color::WHITE).otherwise(Color::BLACK));
    let mut view = View::new(&gpu, Scene::new(plane()).theme(plain_theme()).draw(number).draw(text)).expect("valid");
    view.set_camera(camera());
    view.set_data(data.clone());
    frame(&gpu, &mut view);
    assert_eq!(view.failures().count(), 1, "the text mark fails while `v` holds numbers");
    data.apply(Patch::new().replace(table(vec!["a"; n].into()))).expect("valid");
    view.set_data(data);
    for _ in 0..10 {
        common::step(&gpu, &mut view);
    }
    frame(&gpu, &mut view);
    let failed: Vec<String> = view.failures().map(|e| e.to_string()).collect();
    assert_eq!(failed.len(), 1, "now the number mark fails: {failed:?}");
    assert!(failed[0].starts_with("marks[0]"), "{failed:?}");
}

#[test]
fn edges_drawn_through_tiles_show_with_their_ends() {
    let Some(gpu) = gpu() else { return };
    let data = lattice(600, 500);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(1.0).color(Color::rgb(0.0, 0.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.5, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert!(view.stats().drawn < view.stats().rows / 4, "edges and vertices both draw the tiles in view");
    // Half a unit up from the middle, between rows of edges; at the middle's row, an edge between
    // two vertices.
    let center = SIZE / 2;
    assert!(close(at(&pixels, center + 4, center + 4), [0, 255, 0, 255]), "{:?}", at(&pixels, center + 4, center + 4));
    assert!(close(at(&pixels, center + 4, center), [0, 0, 0, 255]), "{:?}", at(&pixels, center + 4, center));
}

#[test]
fn a_tiny_budget_never_fails() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 32 << 20 });
    let n = 200_000_u32;
    let mut data = Data::new("points");
    data.apply(
        Table::new("Point", Ids::count(n))
            .field("x", (0..n).map(|i| f64::from(i % 500)).collect::<Vec<_>>())
            .field("y", (0..n).map(|i| f64::from(i / 500)).collect::<Vec<_>>())
            .field("v", (0..n).map(f64::from).collect::<Vec<_>>()),
    )
    .expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(
        Vertices::of("points", "Point")
            .position("x", "y")
            .radius(field("v") / 1e5 + 1.0)
            .color(Color::rgb(1.0, 1.0, 1.0)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_data(data);
    view.fit(Fit::All);
    frame(&gpu, &mut view);
    assert!(errors(&mut view).is_empty(), "nothing fails");
    let stats = view.stats();
    assert!(stats.resident <= 8 << 20, "{} bytes resident", stats.resident);
    assert!(stats.drawn > 0 && stats.drawn < u64::from(n), "{} of {n} rows draw", stats.drawn);
    let Camera::Map { center, .. } = *view.camera() else { panic!("a map camera") };
    assert!((center[0] - 249.5).abs() < 5.0 && (center[1] - 199.5).abs() < 5.0, "a fit frames every row: {center:?}");
}

#[test]
fn traces_too_large_for_the_budget_thin_in_time() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 32 << 20 });
    // Every frame of every row would take 12 MB: past the budget, so the traces draw coarser.
    let (rows, frames) = (20_000_usize, 150_u32);
    let mut patch = Patch::new().set(Table::new("Signal", Ids::count(rows as u32)));
    for t in 0..frames {
        patch = patch.append([f64::from(t)], "Signal", [("v", vec![0.5; rows])]);
    }
    let mut data = Data::new("signals");
    data.apply(patch).expect("valid");
    let axis = Axis { grid: false, hidden: true, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(Color::rgb(1.0, 0.0, 0.0)).width(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, f64::from(frames - 1)], y: Some([0.0, 1.0]) });
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    let stats = view.stats();
    assert_eq!(stats.drawn, rows as u64, "every row traces");
    assert_eq!(stats.uploading, 0, "nothing waits for room");
    assert!(stats.resident <= 8 << 20, "{} bytes resident", stats.resident);
    for x in [SIZE / 4, SIZE / 2, SIZE * 3 / 4] {
        assert!(close(at(&pixels, x, SIZE / 2), [255, 0, 0, 255]), "at {x}: {:?}", at(&pixels, x, SIZE / 2));
    }
}

#[test]
fn a_path_longer_than_a_chunk_draws_whole() {
    let Some(gpu) = gpu() else { return };
    let points = 100_000_u32;
    let path: Vec<[f64; 2]> =
        (0..points).map(|i| [-60.0 + 120.0 * f64::from(i) / f64::from(points - 1), 0.0]).collect();
    let mut data = Data::new("roads");
    data.apply(Table::new("Road", Ids::count(1)).field("geometry", vec![path])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Lines::of("roads", "Road").width(3.0).color(Color::rgb(1.0, 1.0, 0.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    for x in [center - 50, center, center + 50] {
        assert!(
            close(at(&pixels, x, center), [255, 255, 0, 255]),
            "along the path at {x}: {:?}",
            at(&pixels, x, center)
        );
    }
}

#[test]
fn a_view_sleeps_while_it_waits() {
    let Some(gpu) = gpu() else { return };
    let mut data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Vertices::of("graph", "Node").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data);
    frame(&gpu, &mut view);
    assert!(!view.needs_render(), "settled");
    let _hits = view.pick([64.0, 64.0], 4.0);
    assert!(view.needs_render(), "a query waits for a frame");
    let texture = gpu.device().create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: common::FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let target_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let target = Frame {
        target: &target_view,
        format: common::FORMAT,
        size: [SIZE, SIZE],
        pixel_ratio: 1.0,
        time: common::now(),
    };
    let mut encoder = gpu.device().create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    view.render(&mut encoder, &target);
    gpu.queue().submit([encoder.finish()]);
    assert!(!view.needs_render(), "while the answer is read back, the view sleeps");
    common::finish(&gpu);
    assert!(view.needs_render(), "the answer landing wakes it");
}
