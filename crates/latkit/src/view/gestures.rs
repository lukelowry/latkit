//! Gestures: pointer and key input turned into camera moves, hover, clicks, selection, and drags.
//!
//! A press decides what it is once the pointer moves a few pixels: on a row of a draggable mark it
//! drags the row, elsewhere it pans. The row under a press comes from the latest hover probe when it
//! was taken where the press is, otherwise from a probe of its own, a frame or two later; the
//! gesture waits for it and catches up.

use std::time::Duration;

use web_time::Instant;

use super::event::{Cursor, Drag, Event, Fit, Phase};
use super::input::{Button, Input, Key, Modifiers};
use super::probe::{Probed, near};
use super::View;
use crate::expr::compile::Deps;
use crate::{Camera, Row, Scene};

/// CSS pixels a press moves before it drags or pans.
const SLOP: f32 = 4.0;
/// Clicks this close in time and space make a double click.
const DOUBLE: Duration = Duration::from_millis(400);
/// Degrees a pixel of turning drag turns.
const TURN: f64 = 0.3;
/// Pixels an arrow key pans.
const STEP: f64 = 80.0;

pub(crate) enum Gesture {
    Idle,
    /// A pointer pressed; `hit` is `None` while its probe is in flight.
    Press {
        pointer: u32,
        from: [f32; 2],
        to: [f32; 2],
        hit: Option<Option<Probed>>,
        released: bool,
        modifiers: Modifiers,
    },
    Drag {
        pointer: u32,
        probed: Probed,
    },
    Pan {
        pointer: u32,
        last: [f32; 2],
    },
    Turn {
        pointer: u32,
        last: [f32; 2],
    },
    Pinch {
        pointers: [(u32, [f32; 2]); 2],
    },
}

#[derive(Default)]
pub(crate) struct Gestures {
    pub(crate) now: Gesture,
    /// The last click: when, where, and on which row.
    clicked: Option<(Instant, [f32; 2], Option<Row>)>,
}

impl Default for Gesture {
    fn default() -> Gesture {
        Gesture::Idle
    }
}

impl Gestures {
    pub(crate) fn cursor(&self, hovered: Option<&Probed>, scene: &Scene) -> Cursor {
        match &self.now {
            Gesture::Drag { .. } | Gesture::Pan { .. } | Gesture::Turn { .. } | Gesture::Pinch { .. } => {
                Cursor::Grabbing
            }
            _ => match hovered.and_then(|p| scene.marks.get(p.hit.mark)) {
                Some(mark) if mark.style().interaction.drag => Cursor::Grab,
                Some(mark) if mark.style().interaction.select => Cursor::Pointer,
                _ => Cursor::Default,
            },
        }
    }
}

impl View {
    /// Takes one pointer, wheel, or key input. Events it causes queue for [`events`](View::events).
    pub fn input(&mut self, input: &Input) {
        if self.size[0] <= 0.0 {
            return;
        }
        match *input {
            Input::Down { pointer, point, button, modifiers, touch } => self.down(pointer, point, button, modifiers, touch),
            Input::Move { pointer, point, .. } => self.moved(pointer, point),
            Input::Up { pointer, point, .. } => self.up(pointer, Some(point)),
            Input::Cancel { pointer } => self.up(pointer, None),
            Input::Wheel { point, delta, .. } => {
                if self.scene.controls.zoom {
                    let levels = f64::from(-delta[1] / 400.0).clamp(-1.0, 1.0);
                    self.zoom(levels, point);
                }
            }
            Input::Key { key, down: true, modifiers } => self.key(key, modifiers),
            Input::Key { .. } => {}
            Input::Leave => {
                self.pointer = None;
                if matches!(self.gestures.now, Gesture::Idle) {
                    self.probing.wanted = None;
                    self.probing.latest = None;
                    self.hover(None);
                }
            }
        }
        self.wake();
    }

    fn down(&mut self, pointer: u32, point: [f32; 2], button: Button, modifiers: Modifiers, touch: bool) {
        self.probing.touch = touch;
        let controls = self.scene.controls;
        match self.gestures.now {
            Gesture::Press { pointer: first, from, .. } | Gesture::Pan { pointer: first, last: from }
                if first != pointer && controls.zoom =>
            {
                self.gestures.now = Gesture::Pinch { pointers: [(first, from), (pointer, point)] };
                return;
            }
            Gesture::Idle => {}
            _ => return,
        }
        let map = matches!(self.camera, Camera::Map { .. });
        self.gestures.now = match button {
            Button::Secondary if controls.turn && map => Gesture::Turn { pointer, last: point },
            Button::Primary if modifiers.shift && controls.turn && map => Gesture::Turn { pointer, last: point },
            Button::Middle if controls.pan => Gesture::Pan { pointer, last: point },
            Button::Primary => {
                let hit = if self.pickable() {
                    let known = self.probing.at(point);
                    if known.is_none() {
                        self.probing.wanted = Some(point);
                    }
                    known
                } else {
                    Some(None)
                };
                Gesture::Press { pointer, from: point, to: point, hit, released: false, modifiers }
            }
            _ => Gesture::Idle,
        };
    }

    fn moved(&mut self, pointer: u32, point: [f32; 2]) {
        self.pointer = Some(point);
        for shown in &mut self.marks {
            shown.dirty |= shown.channels_reading(Deps::POINTER);
        }
        match &mut self.gestures.now {
            Gesture::Idle => {
                if self.scene.controls.hover && self.pickable() {
                    self.probing.wanted = Some(point);
                }
            }
            Gesture::Press { pointer: p, to, .. } if *p == pointer => {
                *to = point;
                self.pressed();
            }
            Gesture::Drag { pointer: p, .. } if *p == pointer => self.drag(Phase::Move, point),
            Gesture::Pan { pointer: p, last } if *p == pointer => {
                let from = std::mem::replace(last, point);
                self.pan(from, point);
            }
            Gesture::Turn { pointer: p, last } if *p == pointer => {
                let from = std::mem::replace(last, point);
                let turned = self.camera.turned([
                    f64::from(point[0] - from[0]) * TURN,
                    -f64::from(point[1] - from[1]) * TURN,
                ]);
                self.flight = None;
                self.move_camera(turned);
            }
            Gesture::Pinch { pointers } => {
                let Some(i) = pointers.iter().position(|(p, _)| *p == pointer) else { return };
                let before = *pointers;
                pointers[i].1 = point;
                let after = *pointers;
                let middle = |p: [(u32, [f32; 2]); 2]| [(p[0].1[0] + p[1].1[0]) / 2.0, (p[0].1[1] + p[1].1[1]) / 2.0];
                let spread = |p: [(u32, [f32; 2]); 2]| (p[0].1[0] - p[1].1[0]).hypot(p[0].1[1] - p[1].1[1]).max(1.0);
                self.pan(middle(before), middle(after));
                self.zoom(f64::from(spread(after) / spread(before)).log2(), middle(after));
            }
            _ => {}
        }
    }

    fn up(&mut self, pointer: u32, point: Option<[f32; 2]>) {
        match &mut self.gestures.now {
            Gesture::Press { pointer: p, released, to, .. } if *p == pointer => {
                if let Some(point) = point {
                    *to = point;
                }
                *released = point.is_some();
                if point.is_none() {
                    self.gestures.now = Gesture::Idle;
                    return;
                }
                self.pressed();
            }
            Gesture::Drag { pointer: p, .. } if *p == pointer => {
                let at = point.or(self.pointer).unwrap_or_default();
                self.drag(Phase::End, at);
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Pan { pointer: p, .. } | Gesture::Turn { pointer: p, .. } if *p == pointer => {
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Pinch { pointers } if pointers.iter().any(|(p, _)| *p == pointer) => {
                self.gestures.now = Gesture::Idle;
            }
            _ => {}
        }
    }

    /// A probe landed: a press waiting for it resolves, otherwise it is what is hovered.
    pub(super) fn landed(&mut self, point: [f32; 2], probed: Option<Probed>) {
        if let Gesture::Press { from, hit: hit @ None, .. } = &mut self.gestures.now
            && near(*from, point, 0.5)
        {
            *hit = Some(probed.clone());
            self.probing.latest = Some((point, probed));
            self.pressed();
            return;
        }
        self.probing.latest = Some((point, probed.clone()));
        if self.scene.controls.hover {
            self.hover(probed);
        }
    }

    fn hover(&mut self, probed: Option<Probed>) {
        let row = probed.as_ref().map(|p| p.hit.row.clone());
        if row != self.focus.hovered {
            self.focus.hovered = row;
            self.focus.dirty = true;
            self.events.push(Event::Hover(probed.map(|p| p.hit)));
            self.wake();
        }
    }

    /// Decides a press once its row is known: a release clicks, a move drags or pans.
    fn pressed(&mut self) {
        let Gesture::Press { pointer, from, to, hit: Some(hit), released, modifiers } = &self.gestures.now else {
            return;
        };
        let (pointer, from, to, hit, released, modifiers) = (*pointer, *from, *to, hit.clone(), *released, *modifiers);
        if released {
            self.gestures.now = Gesture::Idle;
            self.click(hit, to, modifiers);
            return;
        }
        if near(from, to, SLOP) {
            return;
        }
        match hit {
            Some(probed) if self.scene.marks.get(probed.hit.mark).is_some_and(|m| m.style().interaction.drag) => {
                self.gestures.now = Gesture::Drag { pointer, probed };
                self.drag(Phase::Start, to);
            }
            _ if self.scene.controls.pan => {
                self.gestures.now = Gesture::Pan { pointer, last: to };
                self.pan(from, to);
            }
            _ => self.gestures.now = Gesture::Idle,
        }
    }

    fn click(&mut self, hit: Option<Probed>, point: [f32; 2], modifiers: Modifiers) {
        let now = Instant::now();
        let row = hit.as_ref().map(|p| p.hit.row.clone());
        let double = self
            .gestures
            .clicked
            .take()
            .is_some_and(|(at, p, r)| now.duration_since(at) < DOUBLE && near(p, point, 6.0) && r == row);
        if !double {
            self.gestures.clicked = Some((now, point, row));
        }
        let toggle = modifiers.shift || modifiers.control || modifiers.meta;
        match hit {
            Some(probed) => {
                self.events.push(Event::Click(probed.hit.clone()));
                if double {
                    self.events.push(Event::Open(probed.hit.clone()));
                }
                if self.scene.marks.get(probed.hit.mark).is_some_and(|m| m.style().interaction.select) {
                    let row = probed.hit.row;
                    let mut selection = if toggle { self.focus.selection.clone() } else { Vec::new() };
                    match selection.iter().position(|r| *r == row) {
                        Some(i) if toggle => {
                            selection.remove(i);
                        }
                        Some(_) => {}
                        None => selection.push(row),
                    }
                    self.reselect(selection);
                }
            }
            None if double => self.fit(Fit::All),
            None if !toggle => self.reselect(Vec::new()),
            None => {}
        }
    }

    fn reselect(&mut self, selection: Vec<Row>) {
        if selection != self.focus.selection {
            self.focus.selection = selection.clone();
            self.focus.dirty = true;
            self.events.push(Event::Select(selection));
        }
    }

    fn drag(&mut self, phase: Phase, point: [f32; 2]) {
        let Gesture::Drag { probed, .. } = &self.gestures.now else { return };
        let view = self.projected();
        let at = [f64::from(point[0]), f64::from(point[1])];
        let position = view.position(view.unproject(at, f64::from(probed.depth)));
        self.events.push(Event::Drag(Drag { phase, hit: probed.hit.clone(), point, position }));
    }

    fn pan(&mut self, from: [f32; 2], to: [f32; 2]) {
        if !self.scene.controls.pan {
            return;
        }
        let view = self.projected();
        let camera = self.camera.panned(&view, from.map(f64::from), to.map(f64::from));
        self.flight = None;
        self.move_camera(camera);
    }

    fn zoom(&mut self, levels: f64, at: [f32; 2]) {
        if levels == 0.0 || !levels.is_finite() {
            return;
        }
        let camera = self.camera.zoomed(&self.scene.space, self.size, self.area(), levels, at.map(f64::from));
        self.flight = None;
        self.move_camera(camera);
    }

    fn key(&mut self, key: Key, modifiers: Modifiers) {
        if !self.scene.controls.keyboard {
            return;
        }
        let area = self.area();
        let middle = [area[0].midpoint(area[2]) as f32, area[1].midpoint(area[3]) as f32];
        let arrow = match key {
            Key::Left => Some([1.0, 0.0]),
            Key::Right => Some([-1.0, 0.0]),
            Key::Up => Some([0.0, 1.0]),
            Key::Down => Some([0.0, -1.0]),
            _ => None,
        };
        match (key, arrow) {
            (_, Some([dx, dy])) if modifiers.shift && self.scene.controls.turn => {
                let camera = self.camera.turned([-dx * 15.0, dy * 10.0]);
                self.move_camera(camera);
            }
            (_, Some([dx, dy])) => {
                let to = [middle[0] + (dx * STEP) as f32, middle[1] + (dy * STEP) as f32];
                self.pan(middle, to);
            }
            (Key::Plus, _) if self.scene.controls.zoom => self.zoom(0.5, middle),
            (Key::Minus, _) if self.scene.controls.zoom => self.zoom(-0.5, middle),
            (Key::Home, _) => self.fit(Fit::All),
            (Key::Escape, _) => self.reselect(Vec::new()),
            _ => {}
        }
    }
}
