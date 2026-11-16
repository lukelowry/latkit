//! Writes: a row written into an unpaged table uploads its own texel into the page the GPU already
//! holds. However often a column is written, nothing is allocated. A row that reads a field of
//! another table, joined by id or through a reference, follows writes to the row it reads, and only
//! the rows reading a written row evaluate. A view drawing an earlier version keeps it, and rows
//! that come, go, or come back draw as written.

#![cfg(feature = "gpu")]

mod common;

use std::time::Duration;

use common::{SIZE, at, camera, close, errors, frame, gpu, plain_theme, plane};
use latkit::{Color, Colormap, Data, Gpu, Ids, Patch, Scene, Source, Table, Vertices, View, field, when};

const WHITE: [u8; 4] = [255, 255, 255, 255];

/// Rows across two pages, the second partly full.
const ROWS: u32 = 5000;
/// Rows in the second page.
const LAST: u32 = ROWS - 4096;
/// A row in the second page, the only one in view, at the center.
const SHOWN: u32 = 4500;

/// `ROWS` points with a number `v` of 0 and a text `kind` of "off". Every row lies out of view
/// except `SHOWN`.
fn points() -> Data {
    let n = ROWS as usize;
    let data = Data::new("points");
    data.apply(
        Table::new("P", Ids::count(ROWS))
            .field("x", (0..ROWS).map(|row| if row == SHOWN { 0.0 } else { 1000.0 }).collect::<Vec<f64>>())
            .field("y", vec![0.0_f64; n])
            .field("v", vec![0.0_f32; n])
            .field("kind", vec!["off"; n]),
    )
    .expect("valid");
    data
}

/// The points colored by `v`, white at 1.
fn gray() -> Vertices {
    Vertices::of("points", "P")
        .position(field("x"), field("y"))
        .radius(6.0)
        .color(field("v").colormap(Colormap::GRAYS).domain(0.0..=1.0))
}

/// A scene of `marks` that changes without easing.
fn scene(marks: impl IntoIterator<Item = Vertices>) -> Scene {
    let plain = Scene::new(plane()).theme(plain_theme()).ease(Duration::ZERO);
    marks.into_iter().fold(plain, Scene::draw)
}

/// A view of `scene` drawing `sources`, with its first frames drawn.
fn shown<S: Into<Source>>(gpu: &Gpu, scene: Scene, sources: impl IntoIterator<Item = S>) -> View {
    let mut view = View::new(gpu, scene);
    view.set_camera(camera());
    view.set_sources(sources).expect("the sources");
    frame(gpu, &mut view);
    assert_eq!(errors(&mut view), []);
    view
}

/// Writes `v` of row `SHOWN`.
fn write(data: &Data, v: f32) {
    data.apply(Table::new("P", vec![u64::from(SHOWN)]).field("v", vec![v])).expect("valid");
}

/// The pixel `dx` right of the center.
fn pixel(pixels: &[[u8; 4]], dx: u32) -> [u8; 4] {
    at(pixels, SIZE / 2 + dx, SIZE / 2)
}

#[test]
fn a_written_row_uploads_its_texel_into_the_page_it_was_in() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    let mut view = shown(&gpu, scene([gray()]), [&data]);
    let (before, resident) = (gpu.work(), gpu.resident());
    write(&data, 1.0);
    let pixels = frame(&gpu, &mut view);
    let work = gpu.work() - before;
    assert!(close(pixel(&pixels, 0), WHITE), "the row draws as written: {:?}", pixel(&pixels, 0));
    assert_eq!((work.uploaded, work.uploads), (16, 1), "one texel of the page that holds the row");
    assert_eq!(gpu.resident(), resident, "written into the block the page had");
    assert!(work.evaluated <= u64::from(LAST), "only the row's page evaluates: {}", work.evaluated);
}

#[test]
fn a_column_written_every_frame_leaves_the_pool_as_it_was() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    let mut view = shown(&gpu, scene([gray()]), [&data]);
    let (before, resident) = (gpu.work(), gpu.resident());
    let writes = 20;
    for step in 1..=writes {
        // Every row but each seventh changes, so both pages upload whole.
        let v: Vec<f32> = (0..ROWS).map(|row| ((row + step) % 7) as f32 / 7.0).collect();
        data.apply(Table::new("P", Ids::count(ROWS)).field("v", v)).expect("valid");
        frame(&gpu, &mut view);
    }
    let work = gpu.work() - before;
    assert_eq!(work.uploaded, u64::from(writes * ROWS * 4), "each write uploads its rows once");
    assert_eq!(gpu.resident(), resident, "no version before the last stays on the GPU");
    assert_eq!(errors(&mut view), []);
}

#[test]
fn marks_reading_one_field_rewrite_its_page_once() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    let sized = Vertices::of("points", "P")
        .named("sized")
        .position(field("x"), field("y"))
        .radius(field("v") / 0.5 + 2.0)
        .color(Color::rgb(1.0, 0.0, 0.0));
    let mut view = shown(&gpu, scene([sized, gray()]), [&data]);
    let (before, resident) = (gpu.work(), gpu.resident());
    write(&data, 1.0);
    let pixels = frame(&gpu, &mut view);
    let work = gpu.work() - before;
    assert!(close(pixel(&pixels, 0), WHITE), "both marks read the row as written: {:?}", pixel(&pixels, 0));
    assert_eq!((work.uploaded, work.uploads), (16, 1), "the page both marks pin is written once");
    assert_eq!(gpu.resident(), resident);
}

#[test]
fn written_texts_and_positions_rewrite_in_place() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    let red = Color::rgb(1.0, 0.0, 0.0);
    let mark = Vertices::of("points", "P")
        .position(field("x"), field("y"))
        .radius(6.0)
        .color(when(field("kind").is("on")).then(Color::WHITE).otherwise(red));
    let mut view = shown(&gpu, scene([mark]), [&data]);
    let resident = gpu.resident();
    // A text the field has not held before: its code is written into the page of codes. The
    // color it selects is opaque white, whose bits a text's code starts with.
    let before = gpu.work();
    data.apply(Table::new("P", vec![u64::from(SHOWN)]).field("kind", vec!["on"])).expect("valid");
    let pixels = frame(&gpu, &mut view);
    assert!(close(pixel(&pixels, 0), WHITE), "the row reads its new text: {:?}", pixel(&pixels, 0));
    assert_eq!((gpu.work() - before).uploaded, 16, "one texel of codes");
    // A position reads each value and the part `f32` drops, from two pages.
    let before = gpu.work();
    data.apply(Table::new("P", vec![u64::from(SHOWN)]).field("x", vec![20.0])).expect("valid");
    let pixels = frame(&gpu, &mut view);
    assert!(close(pixel(&pixels, 20), WHITE), "the row moved: {:?}", pixel(&pixels, 20));
    assert!(!close(pixel(&pixels, 0), WHITE), "away from where it was");
    assert_eq!((gpu.work() - before).uploaded, 32, "one texel of each page");
    assert_eq!(gpu.resident(), resident);
}

#[test]
fn a_write_through_a_join_evaluates_the_rows_reading_it() {
    let Some(gpu) = gpu() else { return };
    let rows = u64::from(ROWS);
    // The joined table lists the points' ids in their order, or with its first two swapped.
    let aligned: Vec<u64> = (0..rows).collect();
    let swapped: Vec<u64> = [1, 0].into_iter().chain(2..rows).collect();
    let mut loads = Vec::new();
    for ids in [aligned, swapped] {
        let (data, other) = (points(), Data::new("loads"));
        other.apply(Table::new("P", ids).field("load", vec![0.0_f32; ROWS as usize])).expect("valid");
        let color = field("load").from_table("loads", "P").colormap(Colormap::GRAYS).domain(0.0..=1.0);
        let mark = Vertices::of("points", "P").position(field("x"), field("y")).radius(6.0).color(color);
        let scene = Scene::new(plane()).theme(plain_theme()).ease(Duration::from_millis(50)).draw(mark);
        let before = gpu.work();
        let mut view = shown(&gpu, scene, [&data, &other]);
        loads.push((gpu.work() - before).uploaded);
        // The write eases in. Only the page of rows reading the written row freezes, evaluates,
        // and eases: once as the transition begins and once as it ends.
        let before = gpu.work();
        other.apply(Table::new("P", vec![u64::from(SHOWN)]).field("load", vec![1.0_f32])).expect("valid");
        let pixels = frame(&gpu, &mut view);
        let work = gpu.work() - before;
        assert!(close(pixel(&pixels, 0), WHITE), "the row reads the joined row: {:?}", pixel(&pixels, 0));
        assert_eq!(work.uploaded, 16, "one texel of the joined page");
        assert!(work.evaluated <= 2 * u64::from(LAST), "only the page reading it evaluates: {}", work.evaluated);
        assert_eq!(errors(&mut view), []);
    }
    // Tables listing the same ids in the same order join without a table of rows on the GPU.
    assert_eq!(loads[1] - loads[0], rows * 4, "the join's rows upload only where the orders differ");
}

#[test]
fn a_field_of_a_referenced_row_follows_that_row() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    // Two tags, each naming a point. Only the first is in view, right of the center.
    data.apply(Table::new("Tag", Ids::count(2)).field("x", vec![20.0, 1000.0]).field("y", vec![0.0, 0.0]).reference(
        "of",
        "P",
        vec![u64::from(SHOWN), 7],
    ))
    .expect("valid");
    let tags = Vertices::of("points", "Tag")
        .position(field("x"), field("y"))
        .radius(6.0)
        .color(field("v").of("of").colormap(Colormap::GRAYS).domain(0.0..=1.0));
    let mut view = shown(&gpu, scene([tags]), [&data]);
    // Writing the point changes the tag naming it: one texel uploads, and only the tags evaluate.
    let before = gpu.work();
    write(&data, 1.0);
    let pixels = frame(&gpu, &mut view);
    let work = gpu.work() - before;
    assert!(close(pixel(&pixels, 20), WHITE), "the tag reads its point: {:?}", pixel(&pixels, 20));
    assert_eq!(work.uploaded, 16, "one texel of the point's page");
    assert!(work.evaluated <= 2, "only the tags evaluate: {}", work.evaluated);
    // A tag that names another point reads that one.
    data.apply(Table::new("Tag", vec![0_u64]).reference("of", "P", vec![7_u64])).expect("valid");
    let pixels = frame(&gpu, &mut view);
    assert!(!close(pixel(&pixels, 20), WHITE), "the tag reads the point it names now: {:?}", pixel(&pixels, 20));
    assert_eq!(errors(&mut view), []);
}

#[test]
fn a_view_of_an_earlier_version_keeps_drawing_it() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    let earlier = data.snapshot();
    let mut live = shown(&gpu, scene([gray()]), [&data]);
    let mut kept = shown(&gpu, scene([gray()]), [&earlier]);
    // The earlier version's view pins the page, so the written page uploads whole beside it.
    let before = gpu.work();
    write(&data, 1.0);
    assert!(close(pixel(&frame(&gpu, &mut live), 0), WHITE), "the data's view draws the write");
    assert!(!close(pixel(&frame(&gpu, &mut kept), 0), WHITE), "the snapshot's view draws what it was given");
    let uploaded = (gpu.work() - before).uploaded;
    assert_eq!(uploaded, u64::from(LAST * 4), "the page uploads whole, into a block of its own");
    // Once only the data's view reads the page, a write goes into it again.
    drop(kept);
    let before = gpu.work();
    write(&data, 0.5);
    frame(&gpu, &mut live);
    assert_eq!((gpu.work() - before).uploaded, 16);
}

#[test]
fn rows_appended_removed_and_restored_draw_as_written() {
    let Some(gpu) = gpu() else { return };
    let data = points();
    let mut view = shown(&gpu, scene([gray()]), [&data]);
    write(&data, 1.0);
    frame(&gpu, &mut view);
    let written = data.snapshot();
    // A row appended to the last page: the page grows in its block.
    let before = gpu.work();
    let added = Table::new("P", vec![u64::from(ROWS)])
        .field("x", vec![30.0])
        .field("y", vec![0.0])
        .field("v", vec![1.0_f32])
        .field("kind", vec!["off"]);
    data.apply(added).expect("valid");
    let pixels = frame(&gpu, &mut view);
    assert!(close(pixel(&pixels, 30), WHITE), "the appended row draws: {:?}", pixel(&pixels, 30));
    assert!(close(pixel(&pixels, 0), WHITE), "beside the rows before it");
    let uploaded = (gpu.work() - before).uploaded;
    assert!(uploaded <= 5 * 16, "one texel of each page the mark reads: {uploaded} bytes");
    // A row removed moves the rows after it, so their pages upload again, and the old ones go.
    let resident = gpu.resident();
    data.apply(Patch::new().remove("P", [u64::from(SHOWN)])).expect("valid");
    let pixels = frame(&gpu, &mut view);
    assert!(!close(pixel(&pixels, 0), WHITE), "the removed row is gone: {:?}", pixel(&pixels, 0));
    assert!(close(pixel(&pixels, 30), WHITE), "and the row after it stays where it was");
    assert!(gpu.resident() <= resident, "the pages replaced were freed: {} > {resident}", gpu.resident());
    // An earlier version restored draws again, though its pages were written over.
    data.restore(&written).expect("a version of the dataset");
    let pixels = frame(&gpu, &mut view);
    assert!(close(pixel(&pixels, 0), WHITE), "the restored row draws: {:?}", pixel(&pixels, 0));
    assert!(!close(pixel(&pixels, 30), WHITE), "without the row appended since");
    assert_eq!(errors(&mut view), []);
}
