//! Scale: a view's drawing always fits its budget. Paged tables draw the tiles in view, traces too
//! large thin in time, higher-priority rows draw on top, a path longer than an arena chunk still
//! draws whole, and a view sleeps while it waits.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, close, errors, frame, gpu, plain_theme, plane, step};
use latkit::host::{Host, Job, Raster, TextRun};
use latkit::{
    Areas, Axis, Budget, Camera, Color, Data, Edges, Fit, Frame, Ids, Lines, Patch, Pending, Plot, Row, Scene, Table,
    Vertices, View, Waiting, field, when,
};

/// A host that runs jobs on separate threads, finishing frames later, as a page's workers do.
struct Threads;

impl Host for Threads {
    fn rasterize(&self, _: &TextRun) -> latkit::Result<Raster> {
        Err(latkit::Error::Unsupported("these views draw no text".into()))
    }

    fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        let (pending, resolver) = Pending::new();
        std::thread::spawn(move || resolver.resolve(Ok(job.run())));
        pending
    }
}

/// A grid of `columns` by `rows` vertices one unit apart, starting at the origin, each with
/// `v` = 0, and an edge from each vertex to the next in its row.
fn lattice(columns: usize, rows: usize) -> Data {
    let n = columns * rows;
    let x: Vec<f64> = (0..n).map(|i| (i % columns) as f64).collect();
    let y: Vec<f64> = (0..n).map(|i| (i / columns) as f64).collect();
    let links: Vec<usize> = (0..n).filter(|i| i % columns + 1 < columns).collect();
    let from: Vec<u64> = links.iter().map(|&i| i as u64).collect();
    let to: Vec<u64> = links.iter().map(|&i| i as u64 + 1).collect();
    let data = Data::new("grid");
    let buses = Table::new("Bus", Ids::count(n as u32)).field("x", x).field("y", y).field("v", vec![0.0; n]);
    data.apply(Patch::new().set(buses).set(
        Table::new("Line", Ids::count(links.len() as u32)).reference("from", "Bus", from).reference("to", "Bus", to),
    ))
    .expect("valid");
    data
}

#[test]
fn higher_priority_rows_draw_on_top() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
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
        view.set_sources([&data]).expect("a source");
        let pixels = frame(&gpu, &mut view);
        assert!(close(at(&pixels, center, center), want), "priority {priority}: {:?}", at(&pixels, center, center));
    }
}

#[test]
fn a_table_that_starts_empty_draws_its_rows() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(0)).field("x", Vec::<f64>::new()).field("y", Vec::<f64>::new()))
        .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    let pixels = frame(&gpu, &mut view);
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "its constant color and visibility evaluate");
}

#[test]
fn a_paged_table_draws_the_tiles_in_view_and_its_selected_rows() {
    let Some(gpu) = gpu() else { return };
    let (columns, rows) = (600, 500);
    let data = lattice(columns, rows);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
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
    view.set_selection([far.clone().into()]);
    frame(&gpu, &mut view);
    assert_eq!(view.selection(), [latkit::Rows::from(far)]);
    assert_eq!(view.stats().drawn, stats.drawn + 1, "the selected row draws regardless of its tile");
}

#[test]
fn panning_a_paged_table_draws_every_row_in_view_as_tiles_change() {
    let Some(gpu) = gpu() else { return };
    let (columns, rows) = (600, 500);
    // Without an ease, arriving rows draw at once.
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    let data = lattice(columns, rows);
    view.set_sources([&data]).expect("a source");
    let center = SIZE / 2;
    let camera = |x: f64| Camera::Map { center: [x, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 };
    let mut whole = 0;
    for step in 0..6 {
        view.set_camera(camera(100.0 + 60.0 * f64::from(step)));
        // Every frame not waiting on a page draws every row in view. After a camera move, the
        // view is complete, with edges and their endpoints.
        for _ in 0..4 {
            let pixels = common::step(&gpu, &mut view);
            let waiting = view.waiting();
            if step > 0 && !waiting.data && !waiting.marks {
                let pixel = |dx: u32, dy: u32| at(&pixels, center + dx, center + dy);
                assert!(close(pixel(0, 0), [255, 255, 255, 255]), "step {step}, as pages arrive: {:?}", pixel(0, 0));
                assert!(close(pixel(4, 0), [0, 255, 0, 255]), "step {step}, as pages arrive: {:?}", pixel(4, 0));
                whole += 1;
            }
        }
        let pixels = frame(&gpu, &mut view);
        assert_eq!(errors(&mut view), []);
        assert!(view.complete(), "every row in view draws once the camera rests");
        let stats = view.stats();
        assert!(stats.drawn > 0 && stats.drawn < stats.rows / 4, "step {step}: {} of {}", stats.drawn, stats.rows);
        let pixel = |dx: u32, dy: u32| at(&pixels, center + dx, center + dy);
        assert!(close(pixel(0, 0), [255, 255, 255, 255]), "step {step}: a row at the middle: {:?}", pixel(0, 0));
        assert!(close(pixel(4, 4), [0, 0, 0, 255]), "step {step}: none between rows: {:?}", pixel(4, 4));
        assert!(close(pixel(4, 0), [0, 255, 0, 255]), "step {step}: an edge between two: {:?}", pixel(4, 0));
    }
    assert!(whole > 0, "frames drew as their pages arrived");
    // A row written far from the camera's starting point leaves the pages there resident.
    let last = (columns * rows - 1) as u64;
    data.apply(Table::new("Bus", vec![last]).field("v", vec![1.0])).expect("valid");
    frame(&gpu, &mut view);
    // Back at the starting point, its pages are still resident, so nothing packs, uploads, or
    // evaluates again.
    let before = gpu.work();
    view.set_camera(camera(100.0));
    let pixels = frame(&gpu, &mut view);
    let work = gpu.work() - before;
    assert_eq!((work.packed, work.uploaded, work.evaluated), (0, 0, 0), "returning needs no work");
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "{:?}", at(&pixels, center, center));
    // A row selected by id is found among the drawn rows.
    let selected = Row::new("grid", "Bus", (250 * columns + 400) as u64);
    view.set_selection([selected.clone().into()]);
    view.set_camera(camera(380.0));
    frame(&gpu, &mut view);
    assert_eq!(view.selection(), [latkit::Rows::from(selected)], "the selected row stays selected");
    assert_eq!(errors(&mut view), []);
}

#[test]
fn appending_to_a_paged_table_never_thins_it() {
    let Some(gpu) = gpu() else { return };
    let (columns, rows) = (600, 500);
    let data = lattice(columns, rows);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert!(view.complete(), "complete, drawing from its pyramid");
    let drawn = view.stats().drawn;
    let center = SIZE / 2;
    let before = gpu.work();
    for added in 0..4_u32 {
        // One row per step, far from the view. Until a pyramid includes it, it draws last.
        let id = (columns * rows) as u64 + u64::from(added);
        let row = Table::new("Bus", vec![id]).field("x", vec![-50.0]).field("y", vec![f64::from(added)]);
        data.apply(row).expect("valid");
        let pixels = common::step(&gpu, &mut view);
        assert_eq!(errors(&mut view), []);
        let pixel = |dx: u32| at(&pixels, center + dx, center);
        assert!(close(pixel(0), [255, 255, 255, 255]), "append {added}: a row at the middle: {:?}", pixel(0));
        assert!(close(pixel(8), [255, 255, 255, 255]), "append {added}: and its neighbor: {:?}", pixel(8));
        assert!(view.stats().drawn >= drawn, "append {added}: {} drawn, {drawn} before", view.stats().drawn);
    }
    // The pyramid serves appended rows as they arrive, and only the page they join evaluates.
    let work = gpu.work() - before;
    assert_eq!(work.jobs, 0, "a few appended rows start no job");
    assert!(work.evaluated <= 4 << 12, "at most a page per append evaluates: {}", work.evaluated);
}

#[test]
fn a_change_to_one_rows_color_moves_no_row() {
    let Some(gpu) = gpu() else { return };
    // A grid on the globe, drawn as a paged table. Its lines are great circles whose pieces depend
    // on the bus positions.
    let (columns, rows) = (600, 500);
    let n = columns * rows;
    let links: Vec<usize> = (0..n).filter(|i| i % columns + 1 < columns).collect();
    let data = Data::new("grid");
    data.apply(
        Patch::new()
            .set(
                Table::new("Bus", Ids::count(n as u32))
                    .field("lon", (0..n).map(|i| -170.0 + 340.0 * (i % columns) as f64 / 599.0).collect::<Vec<_>>())
                    .field("lat", (0..n).map(|i| -75.0 + 150.0 * (i / columns) as f64 / 499.0).collect::<Vec<_>>())
                    .field("v", vec![0.0; n]),
            )
            .set(
                Table::new("Line", Ids::count(links.len() as u32))
                    .reference("from", "Bus", links.iter().map(|&i| i as u64).collect::<Vec<_>>())
                    .reference("to", "Bus", links.iter().map(|&i| i as u64 + 1).collect::<Vec<_>>()),
            ),
    )
    .expect("valid");
    let scene = Scene::new(latkit::Earth::default().projection(latkit::Projection::Globe))
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Edges::of("grid", "Line").ends("from", "to"))
        .draw(
            Vertices::of("grid", "Bus")
                .position("lon", "lat")
                .color(field("v").colormap(latkit::Colormap::GRAYS).domain(0.0..=1.0)),
        );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [10.0, 10.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert!(view.stats().drawn < view.stats().rows / 4, "the grid is paged");
    // One bus far out of view, one in it. Neither changes a line's pieces, so nothing is read back.
    for id in [0, 250 * columns + 300] {
        let before = gpu.work();
        data.apply(Table::new("Bus", vec![id as u64]).field("v", vec![1.0])).expect("valid");
        frame(&gpu, &mut view);
        let work = gpu.work() - before;
        assert_eq!(work.readbacks, 0, "bus {id}: no line counts its pieces again");
        assert!(work.evaluated <= 1 << 12, "bus {id}: at most a page evaluates: {}", work.evaluated);
        assert_eq!(work.resolved, 0, "bus {id}: no line resolves its endpoints again");
    }
}

#[test]
fn a_frame_waiting_for_pages_packs_nothing_again() {
    let Some(gpu) = gpu() else { return };
    let budget = gpu.budget();
    let scene = Scene::new(plane()).theme(plain_theme()).ease(std::time::Duration::ZERO).draw(
        Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(field("x").colormap(latkit::Colormap::GRAYS)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([lattice(600, 500)]).expect("a source");
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    // Pages upload a few at a time, so the area the camera moves to waits for them.
    gpu.set_budget(Budget { upload_per_frame: 16 << 10, ..budget });
    view.set_camera(Camera::Map { center: [80.0, 60.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    let before = gpu.work();
    common::step(&gpu, &mut view);
    let packed = (gpu.work() - before).packed;
    assert!(packed > 0 && view.waiting().data, "the pages at the new camera pack, then wait to upload");
    let mut waited = 0;
    while view.waiting().data && waited < common::SETTLE {
        common::step(&gpu, &mut view);
        waited += 1;
    }
    assert!(waited > 1, "it waited several frames for pages");
    assert_eq!((gpu.work() - before).packed, packed, "the waiting frames packed nothing again");
    gpu.set_budget(budget);
}

#[test]
fn a_fitted_domain_covers_every_row_of_a_paged_table() {
    let Some(gpu) = gpu() else { return };
    // A lattice whose rows have v = x / 600, plus one far in a corner with v = 10 and the lowest
    // priority. It falls among the finest rows, in no page drawn around the center.
    let (columns, rows) = (600_usize, 500_usize);
    let n = columns * rows;
    let mut x: Vec<f64> = (0..n).map(|i| (i % columns) as f64).collect();
    let mut y: Vec<f64> = (0..n).map(|i| (i / columns) as f64).collect();
    let mut v: Vec<f64> = x.iter().map(|x| x / 600.0).collect();
    x.push(599.5);
    y.push(499.5);
    v.push(10.0);
    let p: Vec<f64> = v.iter().map(|v| -v).collect();
    let data = Data::new("grid");
    data.apply(Table::new("Bus", Ids::count(n as u32 + 1)).field("x", x).field("y", y).field("v", v).field("p", p))
        .expect("valid");
    // A blue background, so a gray row is distinguishable from no row.
    let theme = latkit::Theme { background: Color::rgb(0.0, 0.0, 1.0), ..plain_theme() };
    let scene = Scene::new(plane()).theme(theme).ease(std::time::Duration::ZERO).draw(
        Vertices::of("grid", "Bus")
            .position("x", "y")
            .radius(3.0)
            .priority(field("p"))
            .color(field("v").colormap(latkit::Colormap::GRAYS)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert!(view.stats().drawn < view.stats().rows / 4, "the table is paged");
    // The domain is fitted over every row, 0 to 10, so the center row's 0.5 draws near black, not
    // the mid gray a domain fitted to the resident rows would give.
    let center = at(&pixels, SIZE / 2, SIZE / 2);
    let gray = center[0].abs_diff(center[2]) <= 3 && center[1].abs_diff(center[2]) <= 3;
    assert!(gray && center[0] < 90, "the middle row draws near black: {center:?}");
}

#[test]
fn a_join_into_a_paged_table_reads_every_row() {
    let Some(gpu) = gpu() else { return };
    let (columns, rows) = (600, 500);
    let n = columns * rows;
    let data = lattice(columns, rows);
    // Bus 7 lies far from the view. A probe at the center reads its value by id.
    let v: Vec<f64> = (0..n).map(|i| if i == 7 { 1.0 } else { 0.0 }).collect();
    data.apply(
        Patch::new()
            .set(Table::new("Bus", Ids::count(n as u32)).field("v", v))
            .set(Table::new("Probe", vec![7_u64]).field("x", vec![300.5]).field("y", vec![250.5])),
    )
    .expect("valid");
    let gray = Color::rgb(0.2, 0.2, 0.2);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(1.0).color(gray))
        .draw(
            Vertices::of("grid", "Probe")
                .position("x", "y")
                .radius(4.0)
                .color(field("v").from_table("grid", "Bus").colormap(latkit::Colormap::GRAYS).domain(0.0..=1.0)),
        );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert!(view.stats().drawn < view.stats().rows / 4, "the buses are paged");
    let probe = view.screen([300.5, 250.5, 0.0]).expect("in view");
    let pixel = at(&pixels, probe[0] as u32, probe[1] as u32);
    assert!(close(pixel, [255, 255, 255, 255]), "bus 7's value, though no tile in view contains it: {pixel:?}");
}

#[test]
fn pages_made_resident_mid_ease_enter_as_the_rest_keep_easing() {
    let Some(gpu) = gpu() else { return };
    let camera = |zoom: f64| Camera::Map { center: [300.0, 250.0, 0.0], zoom, pitch: 0.0, bearing: 0.0 };
    let view = |zoom: f64| {
        let scene = Scene::new(plane())
            .theme(plain_theme())
            .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
        let mut view = View::new(&gpu, scene).expect("valid scene");
        view.set_camera(camera(zoom));
        view.set_sources([lattice(600, 500)]).expect("a source");
        view
    };
    let mut pulled = view(1.0);
    let want = frame(&gpu, &mut pulled);
    // A sample draws first. Then the pyramid arrives, and its rows ease in from the sample...
    let mut easing = view(3.0);
    common::step(&gpu, &mut easing);
    common::step(&gpu, &mut easing);
    // ...while the camera pulls back, needing more resident pages than before.
    easing.set_camera(camera(1.0));
    let pixels = frame(&gpu, &mut easing);
    assert_eq!(errors(&mut easing), []);
    let differ = pixels.iter().zip(&want).filter(|(a, b)| !close(**a, **b)).count();
    assert_eq!(differ, 0, "settles to the frame of a view pulled back at once");
}

#[test]
fn paged_areas_fill_the_drawn_pages_as_the_camera_moves() {
    let Some(gpu) = gpu() else { return };
    // A lattice of cells one unit apart, each a square half a unit across: too many to draw whole.
    let (columns, rows) = (600_usize, 500_usize);
    let cells: Vec<Vec<Vec<[f64; 2]>>> = (0..columns * rows)
        .map(|i| {
            let (x, y) = ((i % columns) as f64, (i / columns) as f64);
            vec![vec![[x, y], [x + 0.5, y], [x + 0.5, y + 0.5], [x, y + 0.5], [x, y]]]
        })
        .collect();
    let data = Data::new("map");
    data.apply(Table::new("Cell", Ids::count((columns * rows) as u32)).field("geometry", cells)).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Areas::of("map", "Cell").color(Color::rgb(1.0, 0.0, 0.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    let camera = |x: f64, y: f64| Camera::Map { center: [x, y, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 };
    view.set_sources([&data]).expect("a source");
    for (x, y) in [(300.25, 250.25), (80.25, 60.25)] {
        view.set_camera(camera(x, y));
        let pixels = frame(&gpu, &mut view);
        assert_eq!(errors(&mut view), []);
        let stats = view.stats();
        assert!(stats.drawn < stats.rows / 4, "the cells are paged: {} of {} draw", stats.drawn, stats.rows);
        // The cell at the center fills, and the gap beside it does not.
        let center = SIZE / 2;
        assert!(close(at(&pixels, center, center), [255, 0, 0, 255]), "at {x}, {y}: {:?}", at(&pixels, center, center));
        assert!(
            close(at(&pixels, center + 4, center), [0, 0, 0, 255]),
            "at {x}, {y}: {:?}",
            at(&pixels, center + 4, center)
        );
    }
}

#[test]
fn selected_rows_off_screen_pack_into_kept_row_pages() {
    let Some(gpu) = gpu() else { return };
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([lattice(600, 500)]).expect("a source");
    frame(&gpu, &mut view);
    let (drawn, before) = (view.stats().drawn, gpu.work());
    // A hundred rows near the grid's bottom, far from the view, each in its own page of the order.
    let ids: Vec<latkit::Id> = (0..100_u64).map(|i| latkit::Id::from(600 * (i % 50) + i * 6)).collect();
    view.set_selection([latkit::Rows { data: "grid".into(), table: "Bus".into(), ids }]);
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert_eq!(view.stats().drawn, drawn + 100, "every kept row draws");
    let packed = (gpu.work() - before).packed;
    assert!(packed < 4096, "kept rows pack together, not one order page each: {packed} rows packed");
}

#[test]
fn a_kept_edge_draws_between_its_endpoints() {
    let Some(gpu) = gpu() else { return };
    let budget = gpu.budget();
    // So small a budget that only the coarsest edges draw.
    gpu.set_budget(Budget { bytes: 8 << 20, ..budget });
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(1.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.5, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([lattice(600, 500)]).expect("a source");
    let center = SIZE / 2;
    let green = |p: [u8; 4]| p[1] > 150 && p[0] < 100 && p[2] < 100;
    let before = frame(&gpu, &mut view);
    assert!(!green(at(&before, center, center)), "the edge is not drawn: {:?}", at(&before, center, center));
    // Line 150050 runs from bus 150300 to bus 150301, (300, 250) to (301, 250). Selecting it keeps
    // it and its endpoints.
    view.set_selection([Row::new("grid", "Line", 150_050_u64).into()]);
    let after = frame(&gpu, &mut view);
    gpu.set_budget(budget);
    assert_eq!(errors(&mut view), []);
    assert!(green(at(&after, center, center)), "kept, it draws between its ends: {:?}", at(&after, center, center));
}

#[test]
fn placeholder_lanes_of_a_paged_table_read_missing_past_its_rows() {
    let Some(gpu) = gpu() else { return };
    // Two buses joined twice: their lanes are derived during the frame.
    let pair = Data::new("grid");
    pair.apply(
        Patch::new().set(Table::new("Bus", Ids::count(2)).field("x", vec![0.0, 1.0]).field("y", vec![0.0, 0.0])).set(
            Table::new("Line", Ids::count(2)).reference("from", "Bus", vec![0_u64, 0]).reference(
                "to",
                "Bus",
                vec![1_u64, 1],
            ),
        ),
    )
    .expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(2.0).color(Color::rgb(1.0, 1.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.0, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&pair]).expect("a source");
    frame(&gpu, &mut view);
    // A grid too large to draw whole replaces it. Its lanes take a job, and until the job finishes
    // the pair's lanes are the placeholder, covering none of the grid's rows past the first two.
    view.set_sources([lattice(600, 500)]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert!(view.stats().drawn < view.stats().rows / 4, "the grid is paged");
    let pixel = at(&pixels, SIZE / 2 + 4, SIZE / 2);
    assert!(close(pixel, [0, 255, 0, 255]), "an edge between two buses: {pixel:?}");
}

#[test]
fn a_change_to_one_row_of_a_paged_table_updates_only_its_page() {
    let Some(gpu) = gpu() else { return };
    // 200,000 rows (49 pages) drawn whole in priority order, so each row draws far from its place
    // in the table. Every row lies out of view except one, at the center.
    let (rows, middle) = (200_000_u32, 12_345_u32);
    let n = rows as usize;
    let off = |r: usize| if r == middle as usize { 0.0 } else { 1000.0 };
    let data = Data::new("points");
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
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert_eq!(view.stats().drawn, u64::from(rows), "every row draws, in priority order");
    let before = gpu.work();
    data.apply(Table::new("P", vec![u64::from(middle)]).field("v", vec![1.0])).expect("valid");
    let pixels = frame(&gpu, &mut view);
    let work = gpu.work() - before;
    let center = SIZE / 2;
    assert!(close(at(&pixels, center, center), [255, 255, 255, 255]), "{:?}", at(&pixels, center, center));
    // A page is 4,096 rows; the field takes 8 bytes a row.
    assert!(work.evaluated <= 4096, "only one page evaluates: {}", work.evaluated);
    assert!(work.uploaded <= 8 * 4096, "only one page of the field uploads: {} bytes", work.uploaded);
}

#[test]
fn a_field_of_a_paged_table_that_changes_kind_is_gathered_again() {
    let Some(gpu) = gpu() else { return };
    // Two marks of one paged table. One reads `v` as a number and the other as text, so `v` is read
    // both before and after it changes kind.
    let n = 1000_usize;
    let table = |v: latkit::Values| {
        Table::new("P", Ids::count(n as u32))
            .field("x", vec![0.0; n])
            .field("y", vec![0.0; n])
            .field("p", (0..n).map(|r| r as f64).collect::<Vec<_>>())
            .field("v", v)
    };
    let data = Data::new("points");
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
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert_eq!(view.failures().count(), 1, "the text mark fails while `v` holds numbers");
    data.apply(Patch::new().replace(table(vec!["a"; n].into()))).expect("valid");
    for _ in 0..10 {
        common::step(&gpu, &mut view);
    }
    frame(&gpu, &mut view);
    let failed: Vec<String> = view.failures().map(|e| e.to_string()).collect();
    assert_eq!(failed.len(), 1, "now the number mark fails: {failed:?}");
    assert!(failed[0].starts_with("marks[0]"), "{failed:?}");
}

#[test]
fn paged_edges_draw_with_their_endpoints() {
    let Some(gpu) = gpu() else { return };
    let data = lattice(600, 500);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(1.0).color(Color::rgb(0.0, 0.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Map { center: [300.0, 250.5, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 });
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    assert!(view.stats().drawn < view.stats().rows / 4, "edges and vertices both draw the tiles in view");
    // The center pixel row lies half a unit above a row of vertices, between rows of edges. Four
    // pixels down, on that row, an edge runs between two vertices.
    let center = SIZE / 2;
    assert!(close(at(&pixels, center + 4, center + 4), [0, 255, 0, 255]), "{:?}", at(&pixels, center + 4, center + 4));
    assert!(close(at(&pixels, center + 4, center), [0, 0, 0, 255]), "{:?}", at(&pixels, center + 4, center));
}

#[test]
fn a_tiny_budget_never_fails() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 32 << 20 });
    let n = 200_000_u32;
    let data = Data::new("points");
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
    view.set_sources([&data]).expect("a source");
    view.fit(Fit::All);
    frame(&gpu, &mut view);
    assert!(errors(&mut view).is_empty(), "nothing fails");
    let stats = view.stats();
    assert!(gpu.resident() <= 8 << 20, "{} bytes resident", gpu.resident());
    assert!(stats.drawn > 0 && stats.drawn < u64::from(n), "{} of {n} rows draw", stats.drawn);
    let Camera::Map { center, .. } = *view.camera() else { panic!("a map camera") };
    assert!((center[0] - 249.5).abs() < 5.0 && (center[1] - 199.5).abs() < 5.0, "a fit frames every row: {center:?}");
}

#[test]
fn a_first_look_stays_within_budget_while_pyramids_are_computed() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 4 << 20 });
    gpu.set_host(Threads);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Edges::of("grid", "Line").ends("from", "to"))
        .draw(Vertices::of("grid", "Bus").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_sources([lattice(1000, 500)]).expect("a source");
    view.fit(Fit::All);
    // Until the pyramids arrive, a sample draws, with its edges' endpoints among its vertex rows.
    // Then its replacement finds room beside it.
    let mut settled = false;
    for _ in 0..600 {
        step(&gpu, &mut view);
        if view.waiting() == Waiting::default() && !view.needs_render() {
            settled = true;
            break;
        }
        if !view.needs_render() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    assert!(errors(&mut view).is_empty(), "nothing fails");
    assert!(settled, "the sample's replacement arrives: {:?}", view.waiting());
    assert!(gpu.resident() <= 8 << 20, "{} bytes resident", gpu.resident());
}

/// A grid of 500 by 500 vertices one unit apart, each with `v` = 0, and an edge from each vertex
/// `i` to vertex `far(i, random)`, with `random` drawn from a seeded stream.
fn far_apart(far: impl Fn(u32, u64) -> u64) -> Data {
    let n = 250_000_u32;
    let mut seed = 1_u64;
    let to: Vec<u64> = (0..n)
        .map(|i| {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            far(i, seed >> 33)
        })
        .collect();
    let data = Data::new("grid");
    data.apply(
        Patch::new()
            .set(
                Table::new("Bus", Ids::count(n))
                    .field("x", (0..n).map(|i| f64::from(i % 500)).collect::<Vec<_>>())
                    .field("y", (0..n).map(|i| f64::from(i / 500)).collect::<Vec<_>>())
                    .field("v", vec![0.0; n as usize]),
            )
            .set(
                Table::new("Line", Ids::count(n))
                    .reference("from", "Bus", (0..u64::from(n)).collect::<Vec<_>>())
                    .reference("to", "Bus", to),
            ),
    )
    .expect("valid");
    data
}

#[test]
fn edges_ending_far_apart_make_their_endpoints_kept_rows() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 32 << 20 });
    // Each edge joins a vertex to a far one. Even the fewest edges drawn end in every vertex page,
    // more pages than the budget allows, so their endpoints become kept rows.
    let data = far_apart(|_, random| random % 250_000);
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Edges::of("grid", "Line").ends("from", "to")).draw(
        Vertices::of("grid", "Bus")
            .position("x", "y")
            .color(field("v").colormap(latkit::Colormap::GRAYS).domain(0.0..=1.0)),
    );
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_sources([&data]).expect("a source");
    view.fit(Fit::All);
    let before = gpu.work();
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), [], "the drawing fits the budget");
    assert!(view.stats().drawn > 0, "edges and vertices draw");
    assert!((gpu.work() - before).resolved > 0, "edges resolve their endpoints");
    assert!(gpu.resident() <= 8 << 20, "{} bytes resident", gpu.resident());
    // Every vertex's value changes but none moves. The kept rows stay in place, so no edge resolves
    // its endpoints again.
    let before = gpu.work();
    data.apply(Table::new("Bus", Ids::count(250_000)).field("v", vec![1.0; 250_000])).expect("valid");
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    let work = gpu.work() - before;
    assert!(work.uploaded > 0, "the values upload");
    assert_eq!(work.resolved, 0, "no edge resolves its endpoints again");
}

#[test]
fn edges_ending_far_apart_draw_between_their_ends() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 32 << 20 });
    // Each edge runs along its row to a far vertex in the same row, so every edge is horizontal. An
    // edge whose endpoint resolved to the wrong vertex would slant across the gaps between rows.
    let data = far_apart(|i, random| u64::from(i - i % 500) + random % 500);
    let green = Color::rgb(0.0, 1.0, 0.0);
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .ease(std::time::Duration::ZERO)
        .draw(Edges::of("grid", "Line").ends("from", "to").width(2.0).color(green))
        .draw(Vertices::of("grid", "Bus").position("x", "y").radius(1.0).color(Color::rgb(0.0, 0.0, 1.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    // Rows are eight pixels apart, and the center pixel row lies between two of them.
    let near = Camera::Map { center: [250.0, 250.5, 0.0], zoom: 3.0, pitch: 0.0, bearing: 0.0 };
    view.set_camera(near);
    view.set_sources([&data]).expect("a source");
    let level = |pixels: &[[u8; 4]], when: &str| {
        let center = SIZE / 2;
        for x in 0..SIZE {
            let between = at(pixels, x, center);
            assert!(close(between, [0, 0, 0, 255]), "{when}: nothing crosses between the rows at {x}: {between:?}");
        }
        let along = (0..SIZE).filter(|&x| close(at(pixels, x, center + 4), [0, 255, 0, 255])).count();
        assert!(along > 0, "{when}: edges run along a row");
    };
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    level(&pixels, "first");
    // Zoomed out, the drawn edges end at more kept rows, so the end table grows, and so does the
    // program buffer that holds it. Back at the first camera, every edge still resolves its
    // endpoints.
    view.set_camera(Camera::Map { center: [250.0, 250.5, 0.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 });
    frame(&gpu, &mut view);
    view.set_camera(near);
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    level(&pixels, "after the table grew");
}

#[test]
fn traces_too_large_for_the_budget_thin_in_time() {
    let Some(gpu) = gpu() else { return };
    gpu.set_budget(Budget { bytes: 8 << 20, upload_per_frame: 32 << 20 });
    // Every frame of every row would take 12 MB, over the budget, so the traces draw coarser.
    let (rows, frames) = (20_000_usize, 150_u32);
    let mut patch = Patch::new().set(Table::new("Signal", Ids::count(rows as u32)));
    for t in 0..frames {
        patch = patch.append("Signal", [f64::from(t)], [("v", vec![0.5; rows])]);
    }
    let data = Data::new("signals");
    data.apply(patch).expect("valid");
    let axis = Axis { grid: false, hidden: true, ..Axis::default() };
    let scene = Scene::new(Plot { x: axis.clone(), y: axis })
        .theme(plain_theme())
        .draw(Lines::of("signals", "Signal").trace("v").color(Color::rgb(1.0, 0.0, 0.0)).width(4.0));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(Camera::Plot { x: [0.0, f64::from(frames - 1)], y: Some([0.0, 1.0]) });
    view.set_sources([&data]).expect("a source");
    let pixels = frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    let stats = view.stats();
    assert_eq!(stats.drawn, rows as u64, "every row traces");
    assert_eq!(gpu.uploading(), 0, "nothing waits for room");
    assert!(gpu.resident() <= 8 << 20, "{} bytes resident", gpu.resident());
    for x in [SIZE / 4, SIZE / 2, SIZE * 3 / 4] {
        assert!(close(at(&pixels, x, SIZE / 2), [255, 0, 0, 255]), "at {x}: {:?}", at(&pixels, x, SIZE / 2));
    }
}

#[test]
fn a_rewritten_path_uploads_only_its_group_of_rows() {
    let Some(gpu) = gpu() else { return };
    let rows = 2000_u32;
    let path = |r: u32, lift: f64| -> Vec<[f64; 2]> {
        (0..6).map(|k| [f64::from(k) * 10.0 - 25.0, f64::from(r % 40) - 20.0 + lift]).collect()
    };
    let data = Data::new("roads");
    data.apply(
        Table::new("Road", Ids::count(rows)).field("geometry", (0..rows).map(|r| path(r, 0.0)).collect::<Vec<_>>()),
    )
    .expect("valid");
    let scene =
        Scene::new(plane()).theme(plain_theme()).ease(std::time::Duration::ZERO).draw(Lines::of("roads", "Road"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
    frame(&gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    let before = gpu.work();
    data.apply(Table::new("Road", [700_u64]).field("geometry", vec![path(700, 0.5)])).expect("valid");
    frame(&gpu, &mut view);
    let work = gpu.work() - before;
    // The page's points take 96 KB and its row table 16 KB. The 64-row group holding the changed
    // row takes 3 KB.
    assert!(work.uploaded <= 4 << 10, "only the row's 64-row group uploads: {} bytes", work.uploaded);
}

#[test]
fn a_path_longer_than_a_chunk_draws_whole() {
    let Some(gpu) = gpu() else { return };
    let points = 100_000_u32;
    let path: Vec<[f64; 2]> =
        (0..points).map(|i| [-60.0 + 120.0 * f64::from(i) / f64::from(points - 1), 0.0]).collect();
    let data = Data::new("roads");
    data.apply(Table::new("Road", Ids::count(1)).field("geometry", vec![path])).expect("valid");
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(Lines::of("roads", "Road").width(3.0).color(Color::rgb(1.0, 1.0, 0.0)));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
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
    let data = Data::new("graph");
    data.apply(Table::new("Node", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0])).expect("valid");
    let scene = Scene::new(plane()).theme(plain_theme()).draw(Vertices::of("graph", "Node").position("x", "y"));
    let mut view = View::new(&gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_sources([&data]).expect("a source");
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
    assert!(view.needs_render(), "the answer arriving wakes it");
}
