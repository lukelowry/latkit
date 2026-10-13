//! Groups: a vertex mark whose rows contain rows stands each around its members, and a collapsed
//! group hides its members and stands in for them where edges end.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, errors, frame, gpu, plain_theme, plane};
use latkit::{Color, Data, Edges, Patch, Scene, Shape, Table, Vertices, View, field};

const C: u32 = SIZE / 2;

fn lit(pixel: [u8; 4]) -> bool {
    pixel[0].max(pixel[1]).max(pixel[2]) > 60
}

/// Two nodes in area 1 and one outside it, linked in a chain.
fn graph(collapsed: bool) -> Data {
    let mut data = Data::new("graph");
    data.apply(
        Patch::new()
            .set(Table::new("Area", vec![1_u64]).field("collapsed", vec![collapsed]))
            .set(
                Table::new("Node", vec![1_u64, 2, 3])
                    .field("x", vec![-30.0, 0.0, 30.0])
                    .field("y", vec![0.0, 0.0, -40.0])
                    .reference("area", "Area", vec![Some(1_u64), Some(1), None]),
            )
            .set(Table::new("Link", 2).reference("from", "Node", vec![1_u64, 2]).reference(
                "to",
                "Node",
                vec![2_u64, 3],
            )),
    )
    .expect("valid");
    data
}

fn view(gpu: &latkit::Gpu, collapsed: bool) -> View {
    let scene = Scene::new(plane())
        .theme(plain_theme())
        .draw(
            Vertices::of("graph", "Area")
                .contains("Node", "area")
                .collapsed(field("collapsed"))
                .marker(Shape::Rectangle)
                .radius(6.0)
                .color(Color::rgb(0.0, 0.0, 1.0)),
        )
        .draw(Edges::of("graph", "Link").ends("from", "to").width(2.0).color(Color::rgb(0.0, 1.0, 0.0)))
        .draw(Vertices::of("graph", "Node").position("x", "y").radius(4.0).color(Color::rgb(1.0, 0.0, 0.0)));
    let mut view = View::new(gpu, scene).expect("valid scene");
    view.set_camera(camera());
    view.set_data(graph(collapsed));
    view
}

#[test]
fn groups_stand_around_their_members() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, false);
    let pixels = frame(&gpu, &mut view);
    // Members span x −34…4 and y −4…4; the theme pads them by 12 pixels.
    let blue = |x: u32, y: u32| at(&pixels, x, y)[2] > 120 && at(&pixels, x, y)[0] < 60;
    assert!(blue(C - 44, C) && blue(C + 14, C) && blue(C - 15, C - 14), "around the members");
    assert!(!blue(C - 48, C) && !blue(C + 18, C) && !blue(C - 15, C - 18), "and no further");
    assert!(lit(at(&pixels, C - 30, C)), "members show");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn collapsed_groups_stand_in_for_their_members() {
    let Some(gpu) = gpu() else { return };
    let mut view = view(&gpu, true);
    let pixels = frame(&gpu, &mut view);
    let red = |x: u32, y: u32| at(&pixels, x, y)[0] > 120;
    assert!(!red(C - 30, C) && !red(C, C), "members hide");
    assert!(red(C + 30, C + 40), "the rest show");
    // The group stands at its members' middle at its own size.
    let blue = |x: u32, y: u32| at(&pixels, x, y)[2] > 120 && at(&pixels, x, y)[0] < 60;
    assert!(blue(C - 15, C - 4) && !blue(C - 23, C - 4), "the group at its own size");
    // The link inside the group has nowhere to run; the one leaving it starts at the group.
    let green = |x: u32, y: u32| at(&pixels, x, y)[1] > 120 && at(&pixels, x, y)[0] < 60;
    assert!(!green(C - 26, C), "no link inside");
    assert!(green(C + 7, C + 20), "from the group: {:?}", at(&pixels, C + 7, C + 20));
    assert_eq!(errors(&mut view), Vec::new());
}
