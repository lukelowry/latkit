//! A shade colors each pixel of a mark before it blends, on vertices, edges, and areas alike, and
//! on a custom marker's pixels too. It reads the mark's color, where the pixel is, its row's inputs,
//! the time, and the pointer. A shade that reads the time draws every frame, and one that reads the
//! pointer draws as it moves. A shade that does not compile is its mark's failure, and the mark
//! draws nothing.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, errors, frame, gpu, plain_theme, plane, step};
use latkit::{
    Areas, Color, Data, Device, Edges, Event, Ids, Input, Marker, Modifiers, Patch, Scene, Shade, Table, Vertices,
    View, field,
};

const C: u32 = SIZE / 2;
const RED: Color = Color::rgb(1.0, 0.0, 0.0);

/// Swaps the red and green of the mark's color.
const SWAP: &str = "fn shade(f: ShadeFragment) -> vec4f { return vec4f(f.color.g, f.color.r, f.color.b, f.color.a); }";

fn green(pixel: [u8; 4]) -> bool {
    pixel[1] > 200 && pixel[0] < 60 && pixel[2] < 60
}

fn red(pixel: [u8; 4]) -> bool {
    pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60
}

/// Two vertices on the horizontal axis and an edge between them, with a square area below.
fn data() -> Data {
    let data = Data::new("d");
    let square = vec![vec![[-40.0, -60.0], [40.0, -60.0], [40.0, -30.0], [-40.0, -30.0], [-40.0, -60.0]]];
    data.apply(
        Patch::new()
            .set(Table::new("Node", Ids::count(2)).field("x", vec![-50.0, 50.0]).field("y", vec![0.0, 0.0]))
            .set(Table::new("Link", Ids::count(1)).reference("from", "Node", vec![0_u64]).reference(
                "to",
                "Node",
                vec![1_u64],
            ))
            .set(Table::new("Zone", Ids::count(1)).field("geometry", vec![square])),
    )
    .expect("valid");
    data
}

fn view(gpu: &latkit::Gpu, scene: Scene, data: &Data) -> View {
    let mut view = View::new(gpu, scene.theme(plain_theme()));
    view.set_camera(camera());
    view.set_sources([data]).expect("a source");
    view
}

fn moved(point: [f32; 2]) -> Input {
    Input::Move { pointer: 1, point, modifiers: Modifiers::default(), device: Device::Mouse }
}

#[test]
fn a_shade_colors_vertices_edges_and_areas() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let swap = || Shade::new(SWAP);
    let scene = Scene::new(plane())
        .draw(Areas::of("d", "Zone").color(RED).shade(swap()))
        .draw(Edges::of("d", "Link").ends("from", "to").width(6.0).color(RED).shade(swap()))
        .draw(Vertices::of("d", "Node").position(field("x"), field("y")).radius(8.0).color(RED).shade(swap()));
    let mut view = view(&gpu, scene, &data);
    let pixels = frame(&gpu, &mut view);
    assert!(green(at(&pixels, C - 50, C)), "a vertex: {:?}", at(&pixels, C - 50, C));
    assert!(green(at(&pixels, C, C)), "an edge: {:?}", at(&pixels, C, C));
    assert!(green(at(&pixels, C, C + 45)), "an area: {:?}", at(&pixels, C, C + 45));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_shade_reads_its_inputs_and_where_its_pixel_is() {
    let Some(gpu) = gpu() else { return };
    let data = Data::new("d");
    data.apply(Table::new("V", Ids::count(1)).field("x", vec![0.0]).field("y", vec![0.0]).field("v", vec![0.5]))
        .expect("valid");
    // Red left of the view's middle, green from the input, and blue in the vertex's top half.
    let shade = Shade::new(
        "fn shade(f: ShadeFragment) -> vec4f {
            return vec4f(select(0.0, 1.0, f.px.x < 64.0), f.input[0], select(0.0, 1.0, f.local.y > 0.0), 1.0);
        }",
    )
    .input(field("v"));
    let scene =
        Scene::new(plane()).draw(Vertices::of("d", "V").position(field("x"), field("y")).radius(30.0).shade(shade));
    let mut view = view(&gpu, scene, &data);
    let pixels = frame(&gpu, &mut view);
    let [top_left, bottom_right] = [at(&pixels, C - 10, C - 10), at(&pixels, C + 10, C + 10)];
    assert!(top_left[0] > 250 && top_left[2] > 250, "left of the middle, in the top half: {top_left:?}");
    assert!(bottom_right[0] < 5 && bottom_right[2] < 5, "right, in the bottom half: {bottom_right:?}");
    for pixel in [top_left, bottom_right] {
        assert!(pixel[1].abs_diff(128) <= 3, "green is the input: {pixel:?}");
    }
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_shade_on_a_custom_marker_colors_the_marker_s_pixels() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let square = "fn marker(f: MarkerFragment) -> MarkerColor {
        let d = max(abs(f.p.x), abs(f.p.y)) - f.half.x;
        return MarkerColor(vec4f(0.0, 1.0, 0.0, clamp(0.5 - d / fwidth(d), 0.0, 1.0)), d);
    }";
    let marker = Marker::Wgsl { source: square.into(), inputs: vec![] };
    let vertices = Vertices::of("d", "Node").position(field("x"), field("y")).radius(10.0).marker(marker);
    let mut view = view(&gpu, Scene::new(plane()).draw(vertices.shade(Shade::new(SWAP))), &data);
    let pixels = frame(&gpu, &mut view);
    // The square's corner lies outside a circle of its radius.
    assert!(red(at(&pixels, C - 50 + 8, C + 8)), "the marker's green, swapped: {:?}", at(&pixels, C - 42, C + 8));
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn a_shade_reading_the_time_draws_every_frame() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let pulse = Shade::new("fn shade(f: ShadeFragment) -> vec4f { return vec4f(fract(f.elapsed), 0.0, 0.0, 1.0); }");
    let vertices = Vertices::of("d", "Node").position(field("x"), field("y")).radius(10.0);
    let mut view = view(&gpu, Scene::new(plane()).draw(vertices.clone().shade(pulse)), &data);
    let before = step(&gpu, &mut view);
    let mut after = before.clone();
    for _ in 0..8 {
        after = step(&gpu, &mut view);
    }
    assert!(view.needs_render(), "it keeps drawing");
    let [a, b] = [at(&before, C - 50, C)[0], at(&after, C - 50, C)[0]];
    assert_ne!(a, b, "in the time's color");

    let mut still = view_of(&gpu, vertices.shade(Shade::new(SWAP)), &data);
    frame(&gpu, &mut still);
    assert!(!still.needs_render(), "a shade that reads no time settles");
}

fn view_of(gpu: &latkit::Gpu, vertices: Vertices, data: &Data) -> View {
    view(gpu, Scene::new(plane()).draw(vertices), data)
}

#[test]
fn a_shade_reading_the_pointer_draws_as_it_moves() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let spot = Shade::new(
        "fn shade(f: ShadeFragment) -> vec4f {
            let near = distance(f.px, f.pointer.xy) < 6.0 && f.pointer.z > 0.0;
            return select(f.color, vec4f(1.0, 0.0, 0.0, 1.0), near);
        }",
    );
    let vertices = Vertices::of("d", "Node").position(field("x"), field("y")).radius(20.0).color(Color::WHITE);
    let mut view = view_of(&gpu, vertices.shade(spot), &data);
    let left = (C - 50, C);
    frame(&gpu, &mut view);
    view.input(&moved([left.0 as f32 + 8.0, left.1 as f32]), common::now());
    assert!(view.needs_render(), "the pointer moved");
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, left.0 + 8, left.1)), "lit under the pointer: {:?}", at(&pixels, left.0 + 8, left.1));
    view.input(&moved([left.0 as f32 - 8.0, left.1 as f32]), common::now());
    let pixels = frame(&gpu, &mut view);
    assert!(red(at(&pixels, left.0 - 8, left.1)), "the light follows: {:?}", at(&pixels, left.0 - 8, left.1));
    assert!(at(&pixels, left.0 + 8, left.1)[1] > 200, "and leaves: {:?}", at(&pixels, left.0 + 8, left.1));
}

#[test]
fn a_shade_that_does_not_compile_is_its_mark_s_failure() {
    let Some(gpu) = gpu() else { return };
    let data = data();
    let broken = Shade::new("fn shade(f: ShadeFragment) -> vec4f { oops }");
    let vertices = Vertices::of("d", "Node").position(field("x"), field("y")).radius(10.0).color(Color::WHITE);
    let mut view = view_of(&gpu, vertices.shade(broken), &data);
    let pixels = frame(&gpu, &mut view);
    frame(&gpu, &mut view);
    let failures: Vec<String> = view.failures().map(|f| f.to_string()).collect();
    let listed = failures.iter().any(|f| f.starts_with("marks[0].shade: the shade does not compile"));
    assert!(listed, "the broken shade is listed: {failures:?}");
    let events: Vec<Event> = view.events().collect();
    assert!(!events.iter().any(|e| matches!(e, Event::Error(_))), "and stops nothing else drawing: {events:?}");
    assert!(at(&pixels, C - 50, C)[0] < 30, "the mark draws nothing: {:?}", at(&pixels, C - 50, C));

    // A shade reading a latkit function it can't see fails the same way.
    let internal = Shade::new("fn shade(f: ShadeFragment) -> vec4f { return f.color * coverage(1.0); }");
    let vertices = Vertices::of("d", "Node").position(field("x"), field("y")).radius(10.0);
    let mut view = view_of(&gpu, vertices.shade(internal), &data);
    frame(&gpu, &mut view);
    frame(&gpu, &mut view);
    assert!(view.failures().any(|f| f.to_string().contains("the shade does not compile")));
}
