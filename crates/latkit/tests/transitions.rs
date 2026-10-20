//! Changes ease: a moved vertex starts where it was, a removed one fades where it stood, and edges
//! follow their vertices; another dataset of the same name replaces rows rather than moving them;
//! sampled fields and new frames never ease.

#![cfg(feature = "gpu")]

mod common;

use std::time::Duration;

use common::{SIZE, at, camera, close, errors, frame, gpu, plain_theme, plane, step};
use latkit::{Color, Data, Edges, Ids, Patch, Scene, Table, Theme, Vertices, View};

const WHITE: [u8; 4] = [255, 255, 255, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

fn scene() -> Scene {
    Scene::new(plane())
        .theme(Theme { edge: Some(Color::rgb(0.0, 1.0, 0.0)), ..plain_theme() })
        .ease(Duration::from_secs(2))
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(6.0).color(Color::WHITE))
}

fn graph() -> Data {
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(Table::new("Node", vec![1_u64, 2]).field("x", vec![-30.0, 30.0]).field("y", vec![0.0, 0.0]))
            .set(Table::new("Link", Ids::count(1)).reference("from", "Node", vec![1_u64]).reference(
                "to",
                "Node",
                vec![2_u64],
            )),
    )
    .expect("valid");
    data
}

#[test]
fn moved_vertices_start_where_they_were_and_their_edges_follow() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, scene()).expect("valid scene");
    view.set_camera(camera());
    let mut data = graph();
    view.set_data(data.clone());
    let c = SIZE / 2;
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c), WHITE), "{:?}", at(&pixels, c - 30, c));
    data.apply(Table::new("Node", vec![1_u64]).field("y", vec![40.0])).expect("valid");
    view.set_data(data);
    let pixels = step(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c), WHITE), "the moved vertex starts where it was");
    assert!(close(at(&pixels, c - 30, c - 40), BLACK), "and has not jumped");
    assert!(view.needs_render(), "the transition runs");
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c - 40), WHITE), "it ends where its data says");
    assert!(close(at(&pixels, c - 30, c), BLACK));
    let middle = at(&pixels, c, c - 20);
    assert!(middle[1] > 200 && middle[0] < 60, "the edge joins the moved vertex: {middle:?}");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn removed_rows_fade_where_they_stood_and_new_rows_grow() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, scene()).expect("valid scene");
    view.set_camera(camera());
    let mut data = graph();
    view.set_data(data.clone());
    let c = SIZE / 2;
    frame(&gpu, &mut view);
    data.apply(
        Patch::new()
            .remove("Link", vec![0_u64])
            .remove("Node", vec![1_u64])
            .set(Table::new("Node", vec![3_u64]).field("x", vec![0.0]).field("y", vec![-40.0])),
    )
    .expect("valid");
    view.set_data(data);
    let pixels = step(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c), WHITE), "the removed vertex still shows: {:?}", at(&pixels, c - 30, c));
    assert!(close(at(&pixels, c + 30, c), WHITE), "the kept one stays");
    assert!(at(&pixels, c, c + 40)[0] < 60, "the new vertex starts from nothing: {:?}", at(&pixels, c, c + 40));
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c), BLACK), "the removed vertex is gone");
    assert!(close(at(&pixels, c + 30, c), WHITE));
    assert!(close(at(&pixels, c, c + 40), WHITE), "the new one has grown in");
    assert!(close(at(&pixels, c, c), BLACK), "the removed edge is gone");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn another_dataset_of_the_same_name_replaces_rows_rather_than_moving_them() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, scene()).expect("valid scene");
    view.set_camera(camera());
    view.set_data(graph());
    let c = SIZE / 2;
    frame(&gpu, &mut view);
    // The same ids in a dataset of its own: its rows are not the drawn ones moved.
    let mut other = graph();
    other.apply(Table::new("Node", vec![1_u64]).field("y", vec![40.0])).expect("valid");
    view.set_data(other);
    let pixels = step(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c), WHITE), "the replaced vertex fades where it stood");
    assert!(at(&pixels, c - 30, c - 40)[0] < 60, "its replacement grows from nothing");
    let pixels = frame(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c - 40), WHITE), "{:?}", at(&pixels, c - 30, c - 40));
    assert!(close(at(&pixels, c - 30, c), BLACK));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn sampled_fields_and_zero_ease_change_at_once() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, scene().ease(Duration::ZERO)).expect("valid scene");
    view.set_camera(camera());
    let mut data = graph();
    view.set_data(data.clone());
    let c = SIZE / 2;
    frame(&gpu, &mut view);
    data.apply(Table::new("Node", vec![1_u64]).field("y", vec![40.0])).expect("valid");
    view.set_data(data);
    let pixels = step(&gpu, &mut view);
    assert!(close(at(&pixels, c - 30, c - 40), WHITE), "without ease the vertex moves at once");
}
