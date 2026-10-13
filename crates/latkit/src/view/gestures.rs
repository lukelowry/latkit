//! Gestures: what the pointer and keys mean. A press decides once the pointer moves a few pixels: on
//! a port, an Alt-held vertex, or an edge it draws a connection when connecting is on; on a row of a
//! draggable mark it drags the row; elsewhere it pans. A secondary press turns once it moves and asks
//! for a menu when it does not. Shift drags turn or select in a box, the wheel and pinches zoom, and
//! keys step. Every camera move is about the point under the pointer and goes through the rig, which
//! carries a released drag on and keeps the camera within reach.
//!
//! The point under a press comes from the latest probe when it was taken where the press is,
//! otherwise from a probe of its own a frame or two later; the press waits for it and catches up.
//! Menus and connections tell what lies under their point once a pick answers.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use web_time::Instant;

use super::View;
use super::event::{Cursor, Drag, End, Event, Fit, Hit, Phase};
use super::input::{Button, Input, Key, Modifiers};
use super::probe::{Answer, Probed, near};
use super::query::Pending;
use crate::expr::compile::Deps;
use crate::scene::mark::MarkKind;
use crate::{Camera, Row, Scene};

/// CSS pixels a press moves before it drags or pans.
const SLOP: f32 = 4.0;
/// Clicks this close in time make a double click.
const DOUBLE: Duration = Duration::from_millis(400);
/// A drag released this long after its last move does not coast.
const HELD: Duration = Duration::from_millis(60);
/// Degrees a pixel of turning drag turns.
const TURN: f64 = 0.3;
/// What a step of the keys moves: CSS pixels, degrees, levels.
const STEP: f64 = 100.0;
const STEP_TURN: f64 = 15.0;
const STEP_ZOOM: f64 = 0.5;

#[derive(Default)]
pub(crate) enum Gesture {
    #[default]
    Idle,
    /// A pointer pressed; `answer` is `None` while its probe is in flight.
    Press {
        pointer: u32,
        button: Button,
        from: [f32; 2],
        to: [f32; 2],
        answer: Option<Answer>,
        released: bool,
        modifiers: Modifiers,
    },
    /// A connection drawn from `from` toward the pointer at `to`; `anchor` is where it starts on
    /// screen, once known.
    Connect {
        pointer: u32,
        from: End,
        edge: Option<Row>,
        anchor: Option<[f32; 2]>,
        locating: Option<Pending<Option<[f32; 2]>>>,
        to: [f32; 2],
    },
    Drag {
        pointer: u32,
        probed: Probed,
    },
    Pan {
        pointer: u32,
        anchor: [f64; 3],
        last: [f32; 2],
    },
    Turn {
        pointer: u32,
        anchor: [f64; 3],
        last: [f32; 2],
    },
    Pinch {
        pointers: [(u32, [f32; 2]); 2],
    },
    /// Shift dragging the background: the rows in the box between the press and the pointer.
    Box {
        pointer: u32,
        from: [f32; 2],
        to: [f32; 2],
    },
}

/// What a pick's answer is for.
enum Awaited {
    Menu { point: [f32; 2], keyboard: bool, modifiers: Modifiers },
    Connect { from: End, edge: Option<Row>, point: [f32; 2] },
}

#[derive(Default)]
pub(crate) struct Gestures {
    pub(crate) now: Gesture,
    /// Picks whose answers events wait for.
    awaiting: Vec<(Pending<Vec<Hit>>, Awaited)>,
    /// The last click: when, where, and on which row.
    clicked: Option<(Instant, [f32; 2], Option<Row>)>,
    /// How fast the pan or turn under way moves, per second, and when it last moved.
    velocity: [f64; 2],
    moved: Option<Instant>,
}

impl Gestures {
    pub(crate) fn cursor(&self, hovered: Option<&Probed>, scene: &Scene) -> Cursor {
        match &self.now {
            Gesture::Drag { .. } | Gesture::Pan { .. } | Gesture::Turn { .. } | Gesture::Pinch { .. } => {
                Cursor::Grabbing
            }
            Gesture::Box { .. } | Gesture::Connect { .. } => Cursor::Crosshair,
            _ => match hovered.and_then(|p| scene.marks.get(p.hit.mark)) {
                Some(mark) if mark.style().interaction.drag => Cursor::Grab,
                Some(mark) if mark.style().interaction.select => Cursor::Pointer,
                _ => Cursor::Default,
            },
        }
    }

    /// Follows the velocity of a move of `delta` per second-scaled step.
    fn track(&mut self, delta: [f64; 2]) {
        let now = Instant::now();
        let dt = self.moved.map_or(0.0, |at| now.duration_since(at).as_secs_f64());
        self.moved = Some(now);
        if dt > 0.0 {
            let k = (dt / 0.05).min(1.0);
            self.velocity = [0, 1].map(|i| self.velocity[i] + (delta[i] / dt - self.velocity[i]) * k);
        }
    }

    /// The velocity a release coasts with: none when the pointer stopped before letting go.
    fn release(&mut self) -> [f64; 2] {
        let held = self.moved.is_none_or(|at| at.elapsed() > HELD);
        let velocity = std::mem::take(&mut self.velocity);
        self.moved = None;
        if held { [0.0; 2] } else { velocity }
    }
}

impl View {
    /// Takes one pointer, wheel, or key input; events it causes queue for [`events`](View::events).
    /// Returns whether the view used it, so a platform stops its default handling: scrolling the
    /// page, its context menu.
    pub fn input(&mut self, input: &Input) -> bool {
        if self.size[0] <= 0.0 {
            return false;
        }
        let used = match *input {
            Input::Down { pointer, point, button, modifiers, touch } => {
                self.down(pointer, point, button, modifiers, touch)
            }
            Input::Move { pointer, point, .. } => {
                self.moved(pointer, point);
                true
            }
            Input::Up { pointer, point, .. } => self.up(pointer, Some(point)),
            Input::Cancel { pointer } => self.up(pointer, None),
            Input::Wheel { point, delta, .. } => self.wheel(point, delta),
            Input::Key { key, down: true, modifiers } => self.key(key, modifiers),
            Input::Key { .. } => false,
            Input::Leave => {
                self.pointer = None;
                if matches!(self.gestures.now, Gesture::Idle) {
                    self.probing.wanted = None;
                    self.probing.latest = None;
                    self.hover(None);
                }
                false
            }
        };
        self.wake();
        used
    }

    fn down(&mut self, pointer: u32, point: [f32; 2], button: Button, modifiers: Modifiers, touch: bool) -> bool {
        self.probing.touch = touch;
        let controls = self.scene.controls;
        match self.gestures.now {
            Gesture::Press { pointer: first, to: at, .. } | Gesture::Pan { pointer: first, last: at, .. }
                if first != pointer && controls.zoom =>
            {
                self.rig.hold();
                self.gestures.now = Gesture::Pinch { pointers: [(first, at), (pointer, point)] };
                return true;
            }
            Gesture::Idle => {}
            _ => return true,
        }
        self.rig.hold();
        let map = matches!(self.camera, Camera::Map { .. });
        let boxing = button == Button::Primary && modifiers.shift && controls.select_box;
        let turning = button == Button::Primary && modifiers.shift && !boxing;
        self.gestures.now = if boxing {
            Gesture::Box { pointer, from: point, to: point }
        } else if turning && controls.turn && map {
            let anchor = self.anchor(point, self.probing.at(point).as_ref());
            Gesture::Turn { pointer, anchor, last: point }
        } else if button == Button::Middle && controls.pan {
            let anchor = self.anchor(point, self.probing.at(point).as_ref());
            Gesture::Pan { pointer, anchor, last: point }
        } else if matches!(button, Button::Primary | Button::Secondary) {
            let answer = self.probing.at(point);
            if answer.is_none() {
                self.probing.wanted = Some(point);
            }
            Gesture::Press { pointer, button, from: point, to: point, answer, released: false, modifiers }
        } else {
            Gesture::Idle
        };
        !matches!(self.gestures.now, Gesture::Idle)
    }

    fn moved(&mut self, pointer: u32, point: [f32; 2]) {
        self.pointer = Some(point);
        for shown in &mut self.marks {
            shown.dirty |= shown.channels_reading(Deps::POINTER);
        }
        match &mut self.gestures.now {
            Gesture::Idle => self.probing.wanted = Some(point),
            Gesture::Press { pointer: p, to, .. } if *p == pointer => {
                *to = point;
                self.pressed();
            }
            Gesture::Drag { pointer: p, .. } if *p == pointer => self.drag(Phase::Move, point),
            Gesture::Box { pointer: p, to, .. } if *p == pointer => *to = point,
            Gesture::Connect { pointer: p, to, .. } if *p == pointer => {
                *to = point;
                self.probing.wanted = Some(point);
            }
            Gesture::Pan { pointer: p, anchor, last } if *p == pointer => {
                let (anchor, from) = (*anchor, std::mem::replace(last, point));
                let delta = [f64::from(point[0] - from[0]), f64::from(point[1] - from[1])];
                self.gestures.track(delta);
                let camera = self.camera.panned(&self.projected(), anchor, delta);
                self.steer(camera);
            }
            Gesture::Turn { pointer: p, anchor, last } if *p == pointer => {
                let (anchor, from) = (*anchor, std::mem::replace(last, point));
                let degrees = [f64::from(point[0] - from[0]) * TURN, -f64::from(point[1] - from[1]) * TURN];
                self.gestures.track(degrees);
                let camera = self.camera.turned(&self.projected(), anchor, degrees);
                self.steer(camera);
            }
            Gesture::Pinch { pointers } => {
                let Some(i) = pointers.iter().position(|(p, _)| *p == pointer) else { return };
                let before = *pointers;
                pointers[i].1 = point;
                let after = *pointers;
                let middle = |p: [(u32, [f32; 2]); 2]| {
                    [f32::midpoint(p[0].1[0], p[1].1[0]), f32::midpoint(p[0].1[1], p[1].1[1])]
                };
                let spread = |p: [(u32, [f32; 2]); 2]| (p[0].1[0] - p[1].1[0]).hypot(p[0].1[1] - p[1].1[1]).max(1.0);
                let (from, to) = (middle(before), middle(after));
                let anchor = self.anchor(from, None);
                let delta = [f64::from(to[0] - from[0]), f64::from(to[1] - from[1])];
                let camera = self.camera.panned(&self.projected(), anchor, delta);
                let view = self.projected_with(&camera);
                let camera = camera.zoomed(&view, anchor, f64::from(spread(after) / spread(before)).log2());
                self.steer(camera);
            }
            _ => {}
        }
    }

    fn up(&mut self, pointer: u32, point: Option<[f32; 2]>) -> bool {
        match &mut self.gestures.now {
            Gesture::Press { pointer: p, released, to, .. } if *p == pointer => {
                let Some(point) = point else {
                    self.gestures.now = Gesture::Idle;
                    return true;
                };
                *to = point;
                *released = true;
                self.pressed();
            }
            Gesture::Drag { pointer: p, .. } if *p == pointer => {
                let at = point.or(self.pointer).unwrap_or_default();
                self.drag(Phase::End, at);
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Pan { pointer: p, anchor, .. } if *p == pointer => {
                let anchor = *anchor;
                let velocity = self.gestures.release();
                self.rig.fling(anchor, velocity, [0.0; 2]);
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Turn { pointer: p, anchor, .. } if *p == pointer => {
                let anchor = *anchor;
                let velocity = self.gestures.release();
                self.rig.fling(anchor, [0.0; 2], velocity);
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Pinch { pointers } if pointers.iter().any(|(p, _)| *p == pointer) => {
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Box { pointer: p, from, to } if *p == pointer => {
                let corners = [*from, point.unwrap_or(*to)];
                self.gestures.now = Gesture::Idle;
                if point.is_some() {
                    self.select_box(corners);
                }
            }
            Gesture::Connect { pointer: p, .. } if *p == pointer => {
                let Gesture::Connect { from, edge, .. } = std::mem::take(&mut self.gestures.now) else { return true };
                if let Some(point) = point {
                    let hits = self.pick(point, self.scene.controls.pick_radius);
                    self.gestures.awaiting.push((hits, Awaited::Connect { from, edge, point }));
                }
            }
            _ => return false,
        }
        true
    }

    /// A probe landed: a press waiting for it decides, otherwise it is what is hovered.
    pub(super) fn landed(&mut self, point: [f32; 2], answer: Answer) {
        if let Gesture::Press { from, answer: waiting @ None, .. } = &mut self.gestures.now
            && near(*from, point, 0.5)
        {
            *waiting = Some(answer.clone());
            self.probing.latest = Some((point, answer));
            self.pressed();
            return;
        }
        let hit = answer.hit.clone();
        self.probing.latest = Some((point, answer));
        if self.scene.controls.hover {
            self.hover(hit);
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

    /// Decides a press once what lies under it is known: a release clicks or asks for a menu, a move
    /// connects, drags, pans, or turns.
    fn pressed(&mut self) {
        let Gesture::Press { pointer, button, from, to, answer: Some(answer), released, modifiers } =
            &self.gestures.now
        else {
            return;
        };
        let (pointer, button, from, to, answer, released, modifiers) =
            (*pointer, *button, *from, *to, answer.clone(), *released, *modifiers);
        if released {
            self.gestures.now = Gesture::Idle;
            if button == Button::Secondary {
                self.menu(to, false, modifiers);
            } else {
                self.click(answer.hit, to, modifiers);
            }
            return;
        }
        if near(from, to, SLOP) {
            return;
        }
        if button == Button::Secondary {
            self.gestures.now = Gesture::Idle;
            if self.scene.controls.turn && matches!(self.camera, Camera::Map { .. }) {
                let anchor = self.anchor(from, Some(&answer));
                self.gestures.now = Gesture::Turn { pointer, anchor, last: from };
                self.moved(pointer, to);
            }
            return;
        }
        if self.scene.controls.connect
            && let Some((from, edge, anchor)) =
                answer.hit.as_ref().and_then(|probed| self.connect_from(probed, modifiers))
        {
            let locating = anchor.is_none().then(|| self.locate(&from.row));
            self.gestures.now = Gesture::Connect { pointer, from, edge, anchor, locating, to };
            return;
        }
        let drags = |probed: &Probed| self.scene.marks.get(probed.hit.mark).is_some_and(|m| m.style().interaction.drag);
        match answer.hit {
            Some(probed) if drags(&probed) => {
                self.gestures.now = Gesture::Drag { pointer, probed };
                self.drag(Phase::Start, to);
            }
            _ if self.scene.controls.pan => {
                let anchor = self.anchor(from, Some(&answer));
                let delta = [f64::from(to[0] - from[0]), f64::from(to[1] - from[1])];
                self.gestures.now = Gesture::Pan { pointer, anchor, last: to };
                let camera = self.camera.panned(&self.projected(), anchor, delta);
                self.steer(camera);
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

    pub(super) fn reselect(&mut self, selection: Vec<Row>) {
        if selection != self.focus.selection {
            self.focus.selection.clone_from(&selection);
            self.focus.dirty = true;
            self.events.push(Event::Select(selection));
        }
    }

    fn drag(&mut self, phase: Phase, point: [f32; 2]) {
        let Gesture::Drag { probed, .. } = &self.gestures.now else { return };
        let view = self.projected();
        let position = view.position(view.unproject(point.map(f64::from), f64::from(probed.depth)));
        self.events.push(Event::Drag(Drag { phase, hit: probed.hit.clone(), point, position }));
    }

    /// Where a connection starts from what a press hit: a port, or a vertex with Alt, starts one
    /// there; an edge with ends lets go of the end it was pressed nearer, from the one that stays.
    fn connect_from(&self, probed: &Probed, modifiers: Modifiers) -> Option<(End, Option<Row>, Option<[f32; 2]>)> {
        let hit = &probed.hit;
        let shown = self.marks.get(hit.mark)?;
        match shown.kind() {
            MarkKind::Vertices if hit.port.is_some() || modifiers.alt => {
                Some((End { row: hit.row.clone(), port: hit.port.clone() }, None, Some(hit.point)))
            }
            MarkKind::Edges => {
                let crate::Mark::Edges(edges) = &shown.mark else { return None };
                let (first, second) = edges.ends.as_ref()?;
                let stays = if probed.end == 0 { second } else { first };
                let row = self.referenced(&hit.row, stays)?;
                Some((End { row, port: None }, Some(hit.row.clone()), None))
            }
            _ => None,
        }
    }

    /// Asks what lies under `point` for a menu.
    fn menu(&mut self, point: [f32; 2], keyboard: bool, modifiers: Modifiers) {
        let hits = self.pick(point, self.scene.controls.pick_radius);
        self.gestures.awaiting.push((hits, Awaited::Menu { point, keyboard, modifiers }));
    }

    /// Tells the menus and connections whose picks answered, and starts a connection being drawn
    /// where the row it stays at lies.
    pub(super) fn settle_awaiting(&mut self) {
        let mut context = Context::from_waker(Waker::noop());
        if let Gesture::Connect { anchor, locating: Some(locating), .. } = &mut self.gestures.now
            && let Poll::Ready(found) = Pin::new(locating).poll(&mut context)
        {
            *anchor = found.ok().flatten();
            if let Gesture::Connect { locating, .. } = &mut self.gestures.now {
                *locating = None;
            }
        }
        let mut i = 0;
        while i < self.gestures.awaiting.len() {
            let Poll::Ready(hits) = Pin::new(&mut self.gestures.awaiting[i].0).poll(&mut context) else {
                i += 1;
                continue;
            };
            let (_, awaited) = self.gestures.awaiting.remove(i);
            let hits = hits.unwrap_or_default();
            self.events.push(match awaited {
                Awaited::Menu { point, keyboard, modifiers } => Event::Menu { point, hits, keyboard, modifiers },
                Awaited::Connect { from, edge, point } => {
                    let vertex = |h: &&Hit| {
                        self.marks.get(h.mark).is_some_and(|m| m.kind() == MarkKind::Vertices) && h.row != from.row
                    };
                    let to = hits.iter().find(vertex).map(|h| End { row: h.row.clone(), port: h.port.clone() });
                    Event::Connect { from, to, edge, point }
                }
            });
        }
    }

    pub(crate) fn awaiting(&self) -> bool {
        !self.gestures.awaiting.is_empty() || matches!(self.gestures.now, Gesture::Connect { locating: Some(_), .. })
    }

    fn wheel(&mut self, point: [f32; 2], delta: [f32; 2]) -> bool {
        if !self.scene.controls.zoom {
            return false;
        }
        let anchor = self.anchor(point, self.probing.at(point).as_ref());
        let levels = f64::from(-delta[1] / 400.0).clamp(-1.0, 1.0);
        self.rig.owe(anchor, [0.0; 2], [0.0; 2], levels);
        true
    }

    fn key(&mut self, key: Key, modifiers: Modifiers) -> bool {
        let controls = self.scene.controls;
        match key {
            Key::Delete | Key::Backspace if controls.delete && !self.focus.selection.is_empty() => {
                self.events.push(Event::Delete(self.focus.selection.clone()));
                return true;
            }
            Key::Menu => {
                let [w, h] = self.size.map(|v| v as f32);
                let point = self.pointer.unwrap_or([w / 2.0, h / 2.0]);
                self.menu(point, true, modifiers);
                return true;
            }
            _ => {}
        }
        if !controls.keyboard {
            return false;
        }
        let anchor = match self.camera {
            Camera::Map { center, .. } => center,
            Camera::Plot { .. } => {
                let area = self.area();
                self.anchor([area[0].midpoint(area[2]) as f32, area[1].midpoint(area[3]) as f32], None)
            }
        };
        let arrow = match key {
            Key::Left => Some([1.0, 0.0]),
            Key::Right => Some([-1.0, 0.0]),
            Key::Up => Some([0.0, 1.0]),
            Key::Down => Some([0.0, -1.0]),
            _ => None,
        };
        match (key, arrow) {
            (_, Some([dx, dy])) if modifiers.shift && controls.turn => {
                self.rig.owe(anchor, [0.0; 2], [-dx * STEP_TURN, dy * STEP_TURN], 0.0);
            }
            (_, Some([dx, dy])) if controls.pan => self.rig.owe(anchor, [dx * STEP, dy * STEP], [0.0; 2], 0.0),
            (Key::Plus, _) if controls.zoom => self.rig.owe(anchor, [0.0; 2], [0.0; 2], STEP_ZOOM),
            (Key::Minus, _) if controls.zoom => self.rig.owe(anchor, [0.0; 2], [0.0; 2], -STEP_ZOOM),
            (Key::Home, _) => self.fit(Fit::All),
            (Key::Escape, _) => self.reselect(Vec::new()),
            _ => return false,
        }
        true
    }
}
