//! Shadows fall onto the ground away from the light: under raised faces and vertices, sharp near
//! what casts them, and only from marks that cast.

#![cfg(feature = "gpu")]

mod common;

use common::{SIZE, at, camera, errors, frame, gpu, plane};
use latkit::{Color, Data, Faces, Ids, Patch, Scene, Shadow, Table, Theme, Vertices, View};

const GROUND: f32 = 0.5;

fn theme() -> Theme {
    Theme {
        background: Color::rgb(GROUND, GROUND, GROUND),
        shadow: Shadow { color: Color::BLACK.alpha(0.5), light: [-1.0, 0.0, 1.0], softness: 0.0, lift: 0.0 },
        ..Theme::dark()
    }
}

/// A square face 20 units across, raised 20 units, and a vertex raised as high.
fn data() -> Data {
    let mut data = Data::new("mesh");
    data.apply(
        Patch::new()
            .set(
                Table::new("Corner", Ids::count(4))
                    .field("x", vec![-10.0, 10.0, 10.0, -10.0])
                    .field("y", vec![-10.0, -10.0, 10.0, 10.0])
                    .field("z", vec![20.0; 4]),
            )
            .set(
                Table::new("Face", Ids::count(2))
                    .reference("a", "Corner", vec![0_u64, 0])
                    .reference("b", "Corner", vec![1_u64, 2])
                    .reference("c", "Corner", vec![2_u64, 3]),
            )
            .set(
                Table::new("Ball", Ids::count(1))
                    .field("x", vec![-30.0])
                    .field("y", vec![-40.0])
                    .field("z", vec![20.0]),
            ),
    )
    .expect("valid");
    data
}

fn scene(cast: bool) -> Scene {
    Scene::new(plane())
        .theme(theme())
        .draw(Faces::of("mesh", "Face").corners("a", "b", "c").color(Color::WHITE).shadow(cast))
        .draw(Vertices::of("mesh", "Corner").position("x", "y").elevation("z").radius(0.0).pick(false))
        .draw(
            Vertices::of("mesh", "Ball").position("x", "y").elevation("z").radius(8.0).color(Color::WHITE).shadow(cast),
        )
}

fn ground() -> u8 {
    (GROUND * 255.0).round() as u8
}

#[test]
fn raised_marks_shadow_the_ground_away_from_the_light() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, scene(true)).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data());
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    // The light leans toward -x, so a caster 20 units up shadows the ground 20 units toward +x.
    let under_face = at(&pixels, c + 20, c);
    assert!(under_face[0] < ground() - 40, "the face's shadow darkens the ground: {under_face:?}");
    let beside = at(&pixels, c - 20, c);
    assert!(beside[0].abs_diff(ground()) <= 3, "the lit side stays: {beside:?}");
    let under_ball = at(&pixels, c - 10, c + 40);
    assert!(under_ball[0] < ground() - 30, "the vertex's shadow: {under_ball:?}");
    assert_eq!(errors(&mut view), Vec::new());
}

#[test]
fn marks_that_do_not_cast_leave_the_ground_lit() {
    let Some(gpu) = gpu() else { return };
    let mut view = View::new(&gpu, scene(false)).expect("valid scene");
    view.set_camera(camera());
    view.set_data(data());
    let pixels = frame(&gpu, &mut view);
    let c = SIZE / 2;
    assert!(at(&pixels, c + 20, c)[0].abs_diff(ground()) <= 3, "{:?}", at(&pixels, c + 20, c));
}
