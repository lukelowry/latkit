//! Gestures: how a view interprets pointer and key input.
//!
//! A press decides what it does once the pointer moves a few pixels. With Shift it selects a box
//! when box selection is on, otherwise it turns a map or plane. On a port, a vertex with Alt held,
//! or an edge, it draws a connection when connecting is on. On a row of a draggable mark it drags
//! the row. Elsewhere it pans. A press that does not move clicks. With Shift, Control, or Meta it
//! toggles its row in the selection. With cycling on, clicking again where nothing moved selects
//! the next row under the point. A secondary press turns once it moves and opens a menu when it
//! does not, as does a touch or pen held still. The wheel and pinches zoom, as the controls allow,
//! and keys step. A diagram never turns, and its drags snap to its grid when the grid snaps. Every
//! camera move is about the point under the pointer and goes through the rig, which lets a released
//! drag coast and keeps the camera within its zoom and pan limits.
//!
//! The point under a press comes from the latest probe if it was taken where the press is,
//! otherwise from its own probe a frame or two later. The press waits for it, then catches up.
//! Menus and connections report the rows under their point once a pick resolves, in their place
//! among the intents.
//!
//! Keys can point at rows too. Tab steps through the rows nearest the view's middle, and past the
//! last one lets focus leave the view. An arrow steps to the nearest row in its direction. Enter
//! opens the row and Space toggles it in the selection. The row the keys point at stays hovered
//! until the pointer acts.

use super::View;
use super::event::{Awaited, Cursor, End, Event, Fit, Hit, Phase, Trigger};
use super::input::{Button, Device, Input, Key, Modifiers};
use super::marks::Shown;
use super::probe::{Answer, Probed, near};
use crate::scene::mark::MarkKind;
use crate::{Camera, Grid, Pending, Row, Rows, Scene, Space, Zoom};

/// CSS pixels a press moves before it drags or pans.
const SLOP: f32 = 4.0;
/// Clicks this close in seconds, and in CSS pixels, make a double click.
const DOUBLE: f64 = 0.4;
const DOUBLE_REACH: f32 = 6.0;
/// A drag released this many seconds after its last move does not coast.
const HELD: f64 = 0.06;
/// Degrees turned per CSS pixel of turning drag.
const TURN: f64 = 0.3;
/// How far one key step moves: CSS pixels of pan, degrees of turn, and zoom levels.
const STEP: f64 = 100.0;
const STEP_TURN: f64 = 15.0;
const STEP_ZOOM: f64 = 0.5;

#[derive(Default)]
pub(crate) enum Gesture {
    #[default]
    Idle,
    /// A pointer pressed at `from`, now at `trigger`. `answer` is `None` while its probe is in
    /// flight. `earlier` is a previous press released here before its own answer arrived. It clicks
    /// first, using this press's answer.
    Press {
        pointer: u32,
        button: Button,
        from: [f32; 2],
        trigger: Trigger,
        answer: Option<Answer>,
        released: bool,
        earlier: Option<(Button, Trigger)>,
        /// When it began, on the view's clock.
        since: f64,
    },
    /// A touch or pen held still long enough to open a menu. Its release does nothing more.
    Held {
        pointer: u32,
    },
    /// A connection drawn from `from` toward the pointer at `to`. `anchor` is where it starts on
    /// screen, once known. `locating` finds it when the press did not give it.
    Connect {
        pointer: u32,
        from: End,
        edge: Option<Row>,
        anchor: Option<[f32; 2]>,
        locating: Option<Pending<Option<[f32; 2]>>>,
        to: [f32; 2],
    },
    /// A row dragged by `pointer`. `grab` is the hit point minus the press point, in CSS pixels, so
    /// the row keeps its offset from the pointer.
    Drag {
        pointer: u32,
        probed: Probed,
        grab: [f32; 2],
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
    /// A Shift drag with box selection on, selecting the rows in the box between the press and the
    /// pointer.
    Box {
        pointer: u32,
        from: [f32; 2],
        to: [f32; 2],
    },
}

#[derive(Default)]
pub(crate) struct Gestures {
    pub(crate) now: Gesture,
    /// The rows the keys step through.
    pub(crate) keys: Stepping,
    /// The time of the input being handled, on the clock of whatever feeds the view its input.
    time: f64,
    /// The last click: when, where, on which row, and where the camera was.
    clicked: Option<(f64, [f32; 2], Option<Row>, Camera)>,
    /// How fast the current pan or turn moves, per second, and when it last moved.
    velocity: [f64; 2],
    moved: Option<f64>,
}

/// The rows the keys step through. Holds the hits of a pick around the view's middle, nearest
/// first, as drawn in the frame it was taken in. Also holds the index stepped to, which keeps the
/// hover until the pointer acts, and keys pressed while the pick was pending.
#[derive(Default)]
pub(crate) struct Stepping {
    /// The rows last picked. `None` until the keys first step.
    rows: Option<Vec<Hit>>,
    picking: Option<Pending<Vec<Hit>>>,
    /// Whether the rows match where the current frame draws them.
    fresh: bool,
    pub(crate) at: Option<usize>,
    queued: Vec<(Key, Modifiers)>,
}

impl Stepping {
    /// Marks the rows stale after the frame changed, so they are picked again before an arrow
    /// steps.
    pub(crate) fn stale(&mut self) {
        self.fresh = false;
    }

    /// The row the keys point at.
    fn row(&self) -> Option<&Hit> {
        self.rows.as_ref().zip(self.at).and_then(|(rows, i)| rows.get(i))
    }
}

impl Gestures {
    pub(crate) fn cursor(&self, hovered: Option<&Probed>, scene: &Scene) -> Cursor {
        match &self.now {
            Gesture::Drag { .. } | Gesture::Pan { .. } | Gesture::Turn { .. } | Gesture::Pinch { .. } => {
                Cursor::Grabbing
            }
            Gesture::Box { .. } | Gesture::Connect { .. } => Cursor::Crosshair,
            _ => match hovered.and_then(|p| scene.marks.get(p.hit.index)) {
                Some(mark) if mark.style().interaction.drag => Cursor::Grab,
                Some(mark) if mark.style().interaction.select => Cursor::Pointer,
                _ => Cursor::Default,
            },
        }
    }

    /// Blends a move of `delta` into the velocity, smoothed over about 50 ms of input time.
    fn track(&mut self, delta: [f64; 2]) {
        let dt = self.moved.map_or(0.0, |at| self.time - at);
        self.moved = Some(self.time);
        if dt > 0.0 {
            let k = (dt / 0.05).min(1.0);
            self.velocity = [0, 1].map(|i| self.velocity[i] + (delta[i] / dt - self.velocity[i]) * k);
        }
    }

    /// The velocity a release coasts with: zero if the pointer never moved, or stopped for over
    /// `HELD` before the release.
    fn release(&mut self) -> [f64; 2] {
        let held = self.moved.is_none_or(|at| self.time - at > HELD);
        let velocity = std::mem::take(&mut self.velocity);
        self.moved = None;
        if held { [0.0; 2] } else { velocity }
    }
}

impl View {
    /// Handles one pointer, wheel, or key input at `time`, in seconds on the same clock as frame
    /// times. Events it causes queue for [`events`](View::events). Double clicks and flings measure
    /// the time between inputs. Returns whether the view used the input, so the platform can skip
    /// its default handling: scrolling the page, its context menu, or moving focus.
    pub fn input(&mut self, input: &Input, time: f64) -> bool {
        if self.size[0] <= 0.0 {
            return false;
        }
        if time.is_finite() {
            self.gestures.time = time;
        }
        let device = self.pointing().device;
        let used = match *input {
            Input::Down { pointer, point, button, modifiers, device } => {
                self.follow_pointer(Trigger { point, modifiers, device });
                self.down(pointer, button)
            }
            Input::Move { pointer, point, modifiers, device } => {
                self.follow_pointer(Trigger { point, modifiers, device });
                self.moved(pointer, point);
                true
            }
            Input::Up { pointer, point, modifiers } => {
                self.follow_pointer(Trigger { point, modifiers, device });
                self.up(pointer, Some(point))
            }
            Input::Cancel { pointer } => self.up(pointer, None),
            Input::Wheel { point, delta, modifiers } => self.wheel(point, delta, modifiers),
            Input::Key { key, down: true, modifiers } => self.key(key, modifiers),
            Input::Key { .. } => false,
            Input::Leave => {
                self.left();
                false
            }
        };
        self.wake();
        used
    }

    /// Records the pointer at `trigger`: channels reading the pointer evaluate again, and the
    /// pointer takes the hover back from the keys.
    fn follow_pointer(&mut self, trigger: Trigger) {
        self.pointer = Some(trigger);
        self.gestures.keys.at = None;
        for shown in &mut self.marks {
            shown.dirty_rows(shown.channels_reading(crate::expr::compile::Deps::POINTER), None);
        }
    }

    /// Where the pointer last acted, the modifier keys held, and its device. The default once it
    /// leaves.
    fn pointing(&self) -> Trigger {
        self.pointer.unwrap_or_default()
    }

    /// Handles the pointer leaving. If no gesture is in progress, its probes are dropped, and the
    /// hover clears unless the keys point at a row.
    fn left(&mut self) {
        let trigger = self.pointing();
        self.pointer = None;
        if matches!(self.gestures.now, Gesture::Idle) {
            self.probing.wanted = None;
            self.probing.latest = None;
            if self.gestures.keys.at.is_none() {
                self.hover(None, trigger);
            }
        }
    }

    fn down(&mut self, pointer: u32, button: Button) -> bool {
        let trigger = self.pointing();
        let point = trigger.point;
        let controls = self.scene.controls;
        let earlier = match self.gestures.now {
            Gesture::Press { pointer: first, trigger: Trigger { point: at, .. }, .. }
            | Gesture::Pan { pointer: first, last: at, .. }
                if first != pointer && controls.zoom != Zoom::Off =>
            {
                self.rig.hold();
                self.gestures.now = Gesture::Pinch { pointers: [(first, at), (pointer, point)] };
                return true;
            }
            Gesture::Press { button, trigger: before, answer: None, released: true, .. } => {
                near(before.point, point, DOUBLE_REACH).then_some((button, before))
            }
            Gesture::Idle => None,
            _ => return true,
        };
        self.rig.hold();
        self.gestures.now = if button == Button::Middle && controls.pan {
            let anchor = self.anchor(point, self.probing.at(point).as_ref());
            Gesture::Pan { pointer, anchor, last: point }
        } else if matches!(button, Button::Primary | Button::Secondary) {
            let answer = self.probing.at(point);
            if answer.is_none() {
                self.probing.wanted = Some(point);
            }
            let since = self.clock.now();
            Gesture::Press { pointer, button, from: point, trigger, answer, released: false, earlier, since }
        } else {
            Gesture::Idle
        };
        !matches!(self.gestures.now, Gesture::Idle)
    }

    fn moved(&mut self, pointer: u32, point: [f32; 2]) {
        let pointing = self.pointing();
        match &mut self.gestures.now {
            Gesture::Idle => self.probing.wanted = Some(point),
            Gesture::Press { pointer: p, trigger, .. } if *p == pointer => {
                *trigger = pointing;
                self.pressed();
            }
            Gesture::Drag { pointer: p, .. } if *p == pointer => self.drag(Phase::Move, pointing),
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
                self.move_camera(camera);
            }
            Gesture::Turn { pointer: p, anchor, last } if *p == pointer => {
                let (anchor, from) = (*anchor, std::mem::replace(last, point));
                let degrees = [f64::from(point[0] - from[0]) * TURN, -f64::from(point[1] - from[1]) * TURN];
                self.gestures.track(degrees);
                let camera = self.camera.turned(&self.projected(), anchor, degrees);
                self.move_camera(camera);
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
                let levels = f64::from(spread(after) / spread(before)).log2();
                let camera = camera.zoomed(&view, anchor, levels, &self.reach());
                self.move_camera(camera);
            }
            _ => {}
        }
    }

    fn up(&mut self, pointer: u32, point: Option<[f32; 2]>) -> bool {
        let pointing = self.pointing();
        match &mut self.gestures.now {
            Gesture::Press { pointer: p, released, trigger, .. } if *p == pointer => {
                if point.is_none() {
                    self.gestures.now = Gesture::Idle;
                    return true;
                }
                *trigger = pointing;
                *released = true;
                self.pressed();
            }
            Gesture::Drag { pointer: p, .. } if *p == pointer => {
                self.drag(Phase::End, pointing);
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Pan { pointer: p, anchor, .. } if *p == pointer => {
                let anchor = *anchor;
                let velocity = self.gestures.release();
                if self.moves() {
                    self.rig.fling(anchor, velocity, [0.0; 2]);
                }
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Turn { pointer: p, anchor, .. } if *p == pointer => {
                let anchor = *anchor;
                let velocity = self.gestures.release();
                if self.moves() {
                    self.rig.fling(anchor, [0.0; 2], velocity);
                }
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Held { pointer: p } if *p == pointer => self.gestures.now = Gesture::Idle,
            Gesture::Pinch { pointers } if pointers.iter().any(|(p, _)| *p == pointer) => {
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Box { pointer: p, from, to } if *p == pointer => {
                let corners = [*from, point.unwrap_or(*to)];
                self.gestures.now = Gesture::Idle;
                if point.is_some() {
                    self.select_box(corners, pointing);
                }
            }
            Gesture::Connect { pointer: p, .. } if *p == pointer => {
                let Gesture::Connect { from, edge, .. } = std::mem::take(&mut self.gestures.now) else { return true };
                if let Some(point) = point {
                    let hits = self.pick(point, self.scene.controls.pick_radius);
                    self.events.tell_after(hits, Awaited::Connect { from, edge, trigger: pointing });
                }
            }
            _ => return false,
        }
        true
    }

    /// Handles a probe's answer at `point`. A press waiting for it decides what to do. Otherwise
    /// the answer sets the hover, unless the keys point at a row.
    pub(super) fn landed(&mut self, point: [f32; 2], answer: Answer) {
        if let Gesture::Press { from, answer: waiting @ None, .. } = &mut self.gestures.now
            && near(*from, point, 0.5)
        {
            *waiting = Some(answer.clone());
            self.probing.latest = Some((point, answer));
            self.pressed();
            return;
        }
        let hit = answer.hit.as_ref().map(|probed| probed.hit.clone());
        self.probing.latest = Some((point, answer));
        if self.gestures.keys.at.is_none() {
            self.hover(hit, Trigger { point, ..self.pointing() });
        }
    }

    /// Hovers `hit`, reporting a change when the row differs.
    fn hover(&mut self, hit: Option<Hit>, trigger: Trigger) {
        if hit.as_ref().map(|h| &h.row) != self.focus.hovered.as_ref().map(|h| &h.row) {
            self.focus.dirty = true;
            self.events.tell(Event::Hovered { hit: hit.clone(), trigger });
            self.wake();
        }
        self.focus.hovered = hit;
    }

    /// Decides what a press does. A Shift drag with box selection on starts a box, regardless of
    /// what lies under it. Otherwise, once the probe's answer is known, a release clicks or opens a
    /// menu, and a move connects, drags, pans, or turns.
    fn pressed(&mut self) {
        let Gesture::Press { pointer, button, from, trigger, answer, released, earlier, .. } = &mut self.gestures.now
        else {
            return;
        };
        let boxing = *button == Button::Primary
            && trigger.modifiers.shift
            && self.scene.controls.select_box
            && !near(*from, trigger.point, SLOP);
        if boxing {
            let (pointer, corners, trigger, released) = (*pointer, [*from, trigger.point], *trigger, *released);
            if released {
                self.gestures.now = Gesture::Idle;
                self.select_box(corners, trigger);
            } else {
                self.gestures.now = Gesture::Box { pointer, from: corners[0], to: corners[1] };
            }
            return;
        }
        let Some(answer) = answer.clone() else { return };
        let (pointer, button, from, trigger, released, earlier) =
            (*pointer, *button, *from, *trigger, *released, earlier.take());
        if let Some((button, trigger)) = earlier {
            self.tap(button, answer.hit.clone(), trigger);
        }
        if released {
            self.gestures.now = Gesture::Idle;
            self.tap(button, answer.hit, trigger);
            return;
        }
        let to = trigger.point;
        if near(from, to, SLOP) {
            return;
        }
        // The secondary button turns a map or plane once it moves, and so does Shift.
        let turns = self.turns() && matches!(self.camera, Camera::Map { .. });
        if button == Button::Secondary || (trigger.modifiers.shift && turns) {
            self.gestures.now = Gesture::Idle;
            if turns {
                let anchor = self.anchor(from, Some(&answer));
                self.gestures.now = Gesture::Turn { pointer, anchor, last: from };
                self.moved(pointer, to);
            }
            return;
        }
        if self.scene.controls.connect
            && let Some((from, edge, anchor)) =
                answer.hit.as_ref().and_then(|probed| self.connect_from(probed, trigger.modifiers))
        {
            let locating = anchor.is_none().then(|| self.screen_of(&from.row));
            self.gestures.now = Gesture::Connect { pointer, from, edge, anchor, locating, to };
            return;
        }
        let drags =
            |probed: &Probed| self.scene.marks.get(probed.hit.index).is_some_and(|m| m.style().interaction.drag);
        match answer.hit {
            Some(probed) if drags(&probed) => {
                let grab = [probed.hit.point[0] - from[0], probed.hit.point[1] - from[1]];
                self.gestures.now = Gesture::Drag { pointer, probed, grab };
                self.drag(Phase::Start, trigger);
            }
            _ if self.scene.controls.pan => {
                let anchor = self.anchor(from, Some(&answer));
                let delta = [f64::from(to[0] - from[0]), f64::from(to[1] - from[1])];
                self.gestures.now = Gesture::Pan { pointer, anchor, last: to };
                let camera = self.camera.panned(&self.projected(), anchor, delta);
                self.move_camera(camera);
            }
            _ => self.gestures.now = Gesture::Idle,
        }
    }

    /// A press released where it began: a click, or a menu for the secondary button.
    fn tap(&mut self, button: Button, hit: Option<Probed>, trigger: Trigger) {
        if button == Button::Secondary {
            self.menu(trigger);
        } else {
            self.click(hit, trigger);
        }
    }

    fn click(&mut self, hit: Option<Probed>, trigger: Trigger) {
        let now = self.gestures.time;
        let row = hit.as_ref().map(|p| p.hit.row.clone());
        let last = self.gestures.clicked.take();
        let again = last
            .as_ref()
            .is_some_and(|(_, p, _, camera)| near(*p, trigger.point, DOUBLE_REACH) && *camera == self.camera);
        let double = again && last.as_ref().is_some_and(|(at, _, r, _)| now - at < DOUBLE && *r == row);
        if !double {
            self.gestures.clicked = Some((now, trigger.point, row, self.camera));
        }
        let toggle = trigger.modifiers.toggles();
        match hit {
            Some(Probed { hit, .. }) => {
                self.events.tell(Event::Click { hit: hit.clone(), trigger });
                if double {
                    self.events.tell(Event::Open { hit: hit.clone(), trigger });
                }
                if again && !double && !toggle && self.scene.controls.cycle {
                    // Select the next row under the point once a pick lists them, nearest first.
                    let hits = self.pick(trigger.point, self.scene.controls.pick_radius);
                    let after = self.focus.selection.last().cloned();
                    self.events.tell_after(hits, Awaited::Cycle { after, trigger });
                } else if self.selects(hit.index) {
                    self.select_row(hit.row, toggle, trigger);
                }
            }
            None if double => self.fit(Fit::All),
            None if !toggle => self.reselect(Vec::new(), Some(trigger)),
            None => {}
        }
    }

    /// Selects `row` alone, or with `toggle` toggles it in the selection.
    fn select_row(&mut self, row: Row, toggle: bool, trigger: Trigger) {
        let mut selection = if toggle { self.focus.selection.clone() } else { Vec::new() };
        match selection.iter().position(|r| *r == row) {
            Some(i) if toggle => {
                selection.remove(i);
            }
            Some(_) => {}
            None => selection.push(row),
        }
        self.reselect(selection, Some(trigger));
    }

    /// Sets the selection, reporting a change if it differs. `trigger` is `None` when the data,
    /// not the user, changed it.
    pub(super) fn reselect(&mut self, selection: Vec<Row>, trigger: Option<Trigger>) {
        if selection != self.focus.selection {
            self.focus.selection.clone_from(&selection);
            self.focus.dirty = true;
            self.events.tell(Event::Selection { rows: Rows::group(selection), trigger });
        }
    }

    /// Reports where the dragged row goes with the pointer at `trigger`: the hit point moved with
    /// the pointer since the press, at the depth where the drag started, snapped to a diagram's
    /// grid dots when the grid snaps.
    fn drag(&mut self, phase: Phase, trigger: Trigger) {
        let Gesture::Drag { probed, grab, .. } = &self.gestures.now else { return };
        let view = self.projected();
        let at = [trigger.point[0] + grab[0], trigger.point[1] + grab[1]];
        let mut position = view.position(view.unproject(at.map(f64::from), f64::from(probed.depth)));
        if let Space::Diagram(diagram) = &self.scene.space
            && let Grid::Dots { pitch, snap: true } = diagram.grid
            && pitch > 0.0
        {
            for v in &mut position[..2] {
                *v = (*v / pitch).round() * pitch;
            }
        }
        self.events.tell(Event::Drag { phase, hit: probed.hit.clone(), position, trigger });
    }

    /// Whether a row is being dragged. Rows it moves then update without easing.
    pub(super) fn dragging(&self) -> bool {
        matches!(self.gestures.now, Gesture::Drag { .. })
    }

    /// Whether gestures and keys turn the camera: never in a diagram.
    fn turns(&self) -> bool {
        self.scene.controls.turn && !matches!(self.scene.space, Space::Diagram(_))
    }

    /// Whether clicking a row of mark `mark` selects it.
    fn selects(&self, mark: usize) -> bool {
        self.scene.marks.get(mark).is_some_and(|m| m.style().interaction.select)
    }

    /// Where a connection starts from what a press hit: at a port, at a vertex with Alt held, or,
    /// for an edge with ends, at the end that stays (the end pressed nearer detaches). Also returns
    /// the edge, and the start's screen point when known.
    fn connect_from(&self, probed: &Probed, modifiers: Modifiers) -> Option<(End, Option<Row>, Option<[f32; 2]>)> {
        let hit = &probed.hit;
        let shown = self.marks.get(hit.index)?;
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

    /// Picks what lies under the trigger's point, for a menu reported in order once the pick
    /// resolves.
    fn menu(&mut self, trigger: Trigger) {
        let hits = self.pick(trigger.point, self.scene.controls.pick_radius);
        self.events.tell_after(hits, Awaited::Menu(trigger));
    }

    /// Turns intents whose picks resolved into events, in order. Also takes the keys' rows once
    /// picked, anchors a connection being drawn at its start once located, and opens a menu for a
    /// long press.
    pub(super) fn settle_gestures(&mut self) {
        if let Gesture::Connect { anchor, locating: Some(locating), .. } = &mut self.gestures.now
            && let Some(found) = locating.take()
        {
            *anchor = found.ok().flatten();
            if let Gesture::Connect { locating, .. } = &mut self.gestures.now {
                *locating = None;
            }
        }
        let mut events = std::mem::take(&mut self.events);
        events.settle(|hits, awaited| self.finish(hits, awaited));
        self.events = events;
        self.settle_keys();
        self.held_long();
    }

    /// The event `awaited` produces from its pick's hits, if any: an intent, or the selection
    /// change of a cycling click.
    fn finish(&mut self, hits: Vec<Hit>, awaited: Awaited) -> Option<Event> {
        Some(match awaited {
            Awaited::Menu(trigger) => Event::Menu { hits, trigger },
            Awaited::Connect { from, edge, trigger } => {
                let vertex = |hit: &&Hit| {
                    self.marks.get(hit.index).is_some_and(|m| m.kind() == MarkKind::Vertices) && hit.row != from.row
                };
                let to = hits.iter().find(vertex).map(|hit| End { row: hit.row.clone(), port: hit.port.clone() });
                Event::Connect { from, to, edge, trigger }
            }
            Awaited::Cycle { after, trigger } => {
                let mut rows: Vec<Row> = Vec::new();
                for hit in hits.into_iter().filter(|hit| self.selects(hit.index)) {
                    if !rows.contains(&hit.row) {
                        rows.push(hit.row);
                    }
                }
                let next = after.and_then(|row| rows.iter().position(|r| *r == row)).map_or(0, |i| i + 1);
                let selection = vec![rows.get(next % rows.len().max(1))?.clone()];
                if selection == self.focus.selection {
                    return None;
                }
                self.focus.selection.clone_from(&selection);
                self.focus.dirty = true;
                Event::Selection { rows: Rows::group(selection), trigger: Some(trigger) }
            }
        })
    }

    /// Opens a menu where a touch or pen has been held still for the controls' `press` duration.
    fn held_long(&mut self) {
        let press = self.scene.controls.press.as_secs_f64();
        let Gesture::Press { pointer, from, trigger, released: false, since, .. } = self.gestures.now else { return };
        let still = near(from, trigger.point, SLOP) && matches!(trigger.device, Device::Touch | Device::Pen);
        if still && press > 0.0 && self.clock.now() - since >= press {
            self.gestures.now = Gesture::Held { pointer };
            self.menu(trigger);
        }
    }

    /// Whether a touch or pen is pressed while long presses open menus, so frames keep running to
    /// detect a long press.
    pub(super) fn holding(&self) -> bool {
        matches!(self.gestures.now, Gesture::Press { released: false, trigger, .. }
            if matches!(trigger.device, Device::Touch | Device::Pen))
            && !self.scene.controls.press.is_zero()
    }

    /// Zooms about the point under the wheel, as the controls allow. Otherwise leaves the wheel to
    /// the page.
    fn wheel(&mut self, point: [f32; 2], delta: [f32; 2], modifiers: Modifiers) -> bool {
        let zooms = match self.scene.controls.zoom {
            Zoom::Wheel => true,
            Zoom::Modifier => modifiers.control || modifiers.meta,
            Zoom::Off => false,
        };
        if !zooms {
            return false;
        }
        let anchor = self.anchor(point, self.probing.at(point).as_ref());
        let levels = f64::from(-delta[1] / 400.0).clamp(-1.0, 1.0);
        self.rig.owe(anchor, [0.0; 2], [0.0; 2], levels);
        true
    }

    fn key(&mut self, key: Key, modifiers: Modifiers) -> bool {
        let controls = self.scene.controls;
        let stepped = self.gestures.keys.row().cloned();
        let point =
            stepped.as_ref().map(|hit| hit.point).or(self.pointer.map(|p| p.point)).unwrap_or_else(|| self.middle());
        let trigger = Trigger { point, modifiers, device: Device::Keyboard };
        if controls.keyboard {
            match (key, &stepped) {
                (Key::Tab, _) => return self.step(key, modifiers),
                (Key::Left | Key::Right | Key::Up | Key::Down, Some(_)) => {
                    if self.step(key, modifiers) {
                        return true;
                    }
                }
                (Key::Enter, Some(hit)) => {
                    self.events.tell(Event::Open { hit: hit.clone(), trigger });
                    return true;
                }
                (Key::Space, Some(hit)) if self.selects(hit.index) => {
                    self.select_row(hit.row.clone(), true, trigger);
                    return true;
                }
                (Key::Escape, Some(_)) => {
                    self.gestures.keys.at = None;
                    self.hover(None, trigger);
                    return true;
                }
                _ => {}
            }
        }
        match key {
            Key::Delete | Key::Backspace if controls.delete && !self.focus.selection.is_empty() => {
                self.events.tell(Event::Delete { rows: Rows::group(self.focus.selection.iter().cloned()), trigger });
                return true;
            }
            Key::Menu => {
                self.menu(trigger);
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
            (_, Some([dx, dy])) if modifiers.shift && self.turns() => {
                self.rig.owe(anchor, [0.0; 2], [-dx * STEP_TURN, dy * STEP_TURN], 0.0);
            }
            (_, Some([dx, dy])) if controls.pan => self.rig.owe(anchor, [dx * STEP, dy * STEP], [0.0; 2], 0.0),
            (Key::Plus, _) if controls.zoom != Zoom::Off => self.rig.owe(anchor, [0.0; 2], [0.0; 2], STEP_ZOOM),
            (Key::Minus, _) if controls.zoom != Zoom::Off => self.rig.owe(anchor, [0.0; 2], [0.0; 2], -STEP_ZOOM),
            (Key::Home, _) => self.fit(Fit::All),
            (Key::Escape, _) => self.reselect(Vec::new(), Some(trigger)),
            _ => return false,
        }
        true
    }

    /// Steps the row the keys point at: Tab to the next row nearest the view's middle, Shift+Tab
    /// back, an arrow to the nearest row in its direction. Tab uses the rows as last picked and
    /// waits only for the first pick. An arrow waits for rows picked where the current frame draws
    /// them. Past either end, Tab is not used, so focus leaves the view. Returns whether the key
    /// was used.
    fn step(&mut self, key: Key, modifiers: Modifiers) -> bool {
        let tab = key == Key::Tab;
        if !self.gestures.keys.fresh && self.gestures.keys.picking.is_none() {
            if !self.marks.iter().any(Shown::probed) {
                return false;
            }
            let [w, h] = self.size.map(|v| v as f32);
            let picking = self.pick(self.middle(), w.hypot(h) / 2.0);
            self.gestures.keys.picking = Some(picking);
        }
        let keys = &self.gestures.keys;
        if keys.rows.is_none() || (!tab && !keys.fresh) {
            self.gestures.keys.queued.push((key, modifiers));
            return true;
        }
        let rows = keys.rows.as_deref().unwrap_or_default();
        let next = match (key, keys.at) {
            (Key::Tab, None) => (!rows.is_empty()).then_some(0),
            (Key::Tab, Some(i)) if modifiers.shift => i.checked_sub(1),
            (Key::Tab, Some(i)) => Some(i + 1).filter(|&j| j < rows.len()),
            (arrow, Some(i)) => toward(rows, i, arrow),
            (_, None) => None,
        };
        let Some(next) = next else {
            if tab && self.gestures.keys.at.take().is_some() {
                self.hover(None, Trigger { point: self.middle(), modifiers, device: Device::Keyboard });
            }
            return false;
        };
        let hit = rows[next].clone();
        self.gestures.keys.at = Some(next);
        self.hover(Some(hit.clone()), Trigger { point: hit.point, modifiers, device: Device::Keyboard });
        true
    }

    /// Takes the keys' rows once their pick resolves, and steps the keys that waited for them.
    fn settle_keys(&mut self) {
        let keys = &mut self.gestures.keys;
        let Some(rows) = keys.picking.as_ref().and_then(Pending::take) else { return };
        let held = keys.row().map(|hit| hit.row.clone());
        let rows = rows.unwrap_or_default();
        // The row stepped to keeps its position among the newly picked rows.
        keys.at = held.as_ref().and_then(|row| rows.iter().position(|hit| hit.row == *row));
        keys.rows = Some(rows);
        keys.picking = None;
        keys.fresh = true;
        let queued = std::mem::take(&mut keys.queued);
        if held.is_some() && self.gestures.keys.at.is_none() {
            self.hover(None, Trigger { point: self.middle(), device: Device::Keyboard, ..Trigger::default() });
        }
        for (key, modifiers) in queued {
            self.step(key, modifiers);
        }
    }

    /// The middle of the view, CSS pixels from the top left.
    fn middle(&self) -> [f32; 2] {
        let [w, h] = self.size.map(|v| v as f32);
        [w / 2.0, h / 2.0]
    }
}

/// The row of `rows` nearest row `i` within 45° of the arrow's direction from it.
fn toward(rows: &[Hit], i: usize, arrow: Key) -> Option<usize> {
    let way = match arrow {
        Key::Left => [-1.0, 0.0],
        Key::Right => [1.0, 0.0],
        Key::Up => [0.0, -1.0],
        Key::Down => [0.0, 1.0],
        _ => return None,
    };
    let from = rows.get(i)?.point;
    let offset = |hit: &Hit| [hit.point[0] - from[0], hit.point[1] - from[1]];
    let distance = |hit: &Hit| {
        let [dx, dy] = offset(hit);
        dx.hypot(dy)
    };
    rows.iter()
        .enumerate()
        .filter(|&(j, hit)| {
            let [dx, dy] = offset(hit);
            j != i && dx * way[0] + dy * way[1] > distance(hit) * std::f32::consts::FRAC_1_SQRT_2
        })
        .min_by(|(_, a), (_, b)| distance(a).total_cmp(&distance(b)))
        .map(|(j, _)| j)
}
