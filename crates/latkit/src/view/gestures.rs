//! Gestures: how a view interprets pointer and key input.
//!
//! The controls' `gestures` say what each input does: a drag with each button and modifier keys,
//! the wheel, and two fingers that pinch, twist, or slide. A press decides once the pointer moves a
//! few pixels. A box, to select or to zoom, starts whatever lies under the press. A turn or tilt
//! turns a map or plane, and pans where the camera cannot turn. Otherwise, on an edge's end the
//! press connects when any input connects, on a row of a draggable mark it drags the row,
//! and elsewhere it does its input's action. A press that does not move clicks. With Shift,
//! Control, or Meta it toggles its row in the selection. With cycling on, clicking again where
//! nothing moved selects the next row under the point. A secondary press opens a menu when it does
//! not move, as does a touch or pen held still. A middle press only drags, and never clicks. Keys
//! step. Every camera move is about the point under the pointer and goes through the rig, which lets a released drag
//! coast and keeps the camera within its zoom and pan limits.
//!
//! The point under a press comes from the latest probe if it was taken where the press is,
//! otherwise from its own probe a frame or two later. The press waits for it, then catches up.
//! Menus and connections report the rows under their point once a pick resolves, in their place
//! among the intents.
//!
//! A cancelled pointer, or the view losing focus, stops what it was doing without acting: a drag
//! reports `cancel`, and nothing coasts, clicks, selects, connects, or opens a menu. Probes are
//! stamped with the session they were asked in. A cancel, or the pointer leaving, starts a new
//! session, so an answer asked for before it lands unused.
//!
//! Keys can point at rows too. Tab steps to the row nearest the view's middle, and the next Tab
//! or Shift+Tab lets focus leave the view. An arrow steps to the nearest row in its direction.
//! Enter opens the row and Space toggles it in the selection. The row the keys point at stays
//! hovered until the pointer acts.

use super::View;
use super::event::{Awaited, Cursor, End, Event, Fit, Hit, Phase, Trigger};
use super::input::{Button, Device, Input, Key, Modifiers};
use super::marks::Shown;
use super::probe::{Answer, Probed, Step, near};
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::scene::{Action, Control, Gestures as Inputs};
use crate::{Camera, Pending, Row, Rows, Scene, Space, Value};

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
    /// the row keeps its offset from the pointer. `from` is what the row's position fields held
    /// when the drag began, a missing value as `None` (as for a row a layout places), which a
    /// cancel writes back exactly.
    Drag {
        pointer: u32,
        probed: Probed,
        grab: [f32; 2],
        from: Option<[Option<f64>; 2]>,
    },
    Pan {
        pointer: u32,
        anchor: [f64; 3],
        last: [f32; 2],
    },
    /// A drag across a plot that moves the coordinate shown with the pointer.
    Scrub {
        pointer: u32,
    },
    /// A drag turning a map or plane, or with `tilt` only tilting it.
    Turn {
        pointer: u32,
        anchor: [f64; 3],
        last: [f32; 2],
        tilt: bool,
    },
    Pinch {
        pointers: [(u32, [f32; 2]); 2],
    },
    /// A box between the press and the pointer, selecting the rows inside it, or with `zooms`
    /// framing it.
    Box {
        pointer: u32,
        from: [f32; 2],
        to: [f32; 2],
        zooms: bool,
    },
}

impl Gesture {
    /// Whether `pointer` takes part in it.
    fn holds(&self, pointer: u32) -> bool {
        match self {
            Gesture::Idle => false,
            Gesture::Pinch { pointers } => pointers.iter().any(|(p, _)| *p == pointer),
            Gesture::Press { pointer: p, .. }
            | Gesture::Held { pointer: p }
            | Gesture::Connect { pointer: p, .. }
            | Gesture::Drag { pointer: p, .. }
            | Gesture::Pan { pointer: p, .. }
            | Gesture::Scrub { pointer: p }
            | Gesture::Turn { pointer: p, .. }
            | Gesture::Box { pointer: p, .. } => *p == pointer,
        }
    }
}

/// The input a drag with `button` is.
fn source(button: Button) -> Control {
    match button {
        Button::Primary => Control::Primary,
        Button::Secondary => Control::Secondary,
        Button::Middle => Control::Middle,
    }
}

/// Whether two fingers do anything with `modifiers` held.
fn two_fingers(inputs: &Inputs, modifiers: Modifiers) -> bool {
    [Control::Pinch, Control::Twist, Control::Slide].into_iter().any(|s| inputs.get(s, modifiers) != Action::None)
}

#[derive(Default)]
pub(crate) struct Gestures {
    pub(crate) now: Gesture,
    /// Counts cancels and the pointer leaving. A probe answers only the session it was asked in,
    /// so an answer asked for before one of these lands unused.
    pub(crate) session: u64,
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

/// The keys' stepping: the row they point at, which keeps the hover until the pointer acts, the
/// step being found, and keys pressed while it is.
#[derive(Default)]
pub(crate) struct Stepping {
    pub(crate) at: Option<Hit>,
    finding: Option<Finding>,
    queued: Vec<(Key, Modifiers)>,
}

/// A step the GPU is finding: the key that asked for it, and the modifiers held.
struct Finding {
    key: Key,
    modifiers: Modifiers,
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
        if !self.sized() {
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
                self.up(pointer, point)
            }
            Input::Cancel { pointer } => self.cancel(Some(pointer)),
            Input::Blur => {
                // Losing focus stops everything: every pointer and the keys are cancelled, then the
                // pointer leaves, so what was asked for before lands unused and the hover clears
                // until the pointer moves again.
                self.cancel(None);
                self.left();
                false
            }
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

    /// Handles the pointer leaving. If no gesture is in progress, its probes are dropped, including
    /// one being read back, and the hover clears unless the keys point at a row.
    fn left(&mut self) {
        let trigger = self.pointing();
        self.pointer = None;
        if matches!(self.gestures.now, Gesture::Idle) {
            self.gestures.session += 1;
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
        let inputs = self.scene.controls.gestures;
        let earlier = match self.gestures.now {
            Gesture::Press { pointer: first, trigger: Trigger { point: at, .. }, .. }
            | Gesture::Pan { pointer: first, last: at, .. }
                if first != pointer && two_fingers(&inputs, trigger.modifiers) =>
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
        // Every button presses alike, and `pressed` decides what its input does.
        let answer = self.probing.at(point);
        if answer.is_none() {
            self.probing.wanted = Some(point);
        }
        let since = self.clock.now();
        self.gestures.now =
            Gesture::Press { pointer, button, from: point, trigger, answer, released: false, earlier, since };
        true
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
            Gesture::Scrub { pointer: p } if *p == pointer => self.seek(point),
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
            Gesture::Turn { pointer: p, anchor, last, tilt } if *p == pointer => {
                let (anchor, from, tilt) = (*anchor, std::mem::replace(last, point), *tilt);
                let across = if tilt { 0.0 } else { f64::from(point[0] - from[0]) * TURN };
                let degrees = [across, -f64::from(point[1] - from[1]) * TURN];
                self.gestures.track(degrees);
                let camera = self.camera.turned(&self.projected(), anchor, degrees);
                self.move_camera(camera);
            }
            Gesture::Pinch { pointers } => {
                let Some(i) = pointers.iter().position(|(p, _)| *p == pointer) else { return };
                let before = *pointers;
                pointers[i].1 = point;
                let after = *pointers;
                self.pinched(before, after);
            }
            _ => {}
        }
    }

    /// Moves the camera as two fingers moved from `before` to `after`, as the gestures say: sliding
    /// together pans or tilts, twisting turns, and pinching zooms, each about the point under where
    /// the fingers were.
    fn pinched(&mut self, before: [(u32, [f32; 2]); 2], after: [(u32, [f32; 2]); 2]) {
        let middle =
            |p: [(u32, [f32; 2]); 2]| [f32::midpoint(p[0].1[0], p[1].1[0]), f32::midpoint(p[0].1[1], p[1].1[1])];
        let spread = |p: [(u32, [f32; 2]); 2]| (p[0].1[0] - p[1].1[0]).hypot(p[0].1[1] - p[1].1[1]).max(1.0);
        let angle = |p: [(u32, [f32; 2]); 2]| f64::from(p[1].1[1] - p[0].1[1]).atan2(f64::from(p[1].1[0] - p[0].1[0]));
        let (from, to) = (middle(before), middle(after));
        let anchor = self.anchor(from, None);
        let delta = [f64::from(to[0] - from[0]), f64::from(to[1] - from[1])];
        let (inputs, modifiers) = (self.scene.controls.gestures, self.pointing().modifiers);
        let mut camera = self.camera;
        match inputs.get(Control::Slide, modifiers) {
            Action::Pan => camera = camera.panned(&self.projected(), anchor, delta),
            Action::Tilt if self.turns() => camera = camera.turned(&self.projected(), anchor, [0.0, -delta[1] * TURN]),
            _ => {}
        }
        if inputs.get(Control::Twist, modifiers) == Action::Turn && self.turns() {
            // Fingers turning clockwise turn the ground with them, so the bearing turns the other way.
            let twist = ((angle(after) - angle(before)).to_degrees() + 540.0).rem_euclid(360.0) - 180.0;
            camera = camera.turned(&self.projected_with(&camera), anchor, [-twist, 0.0]);
        }
        if inputs.get(Control::Pinch, modifiers) == Action::Zoom {
            let levels = f64::from(spread(after) / spread(before)).log2();
            camera = camera.zoomed(&self.projected_with(&camera), anchor, levels, &self.reach());
        }
        self.move_camera(camera);
    }

    fn up(&mut self, pointer: u32, point: [f32; 2]) -> bool {
        let pointing = self.pointing();
        match &mut self.gestures.now {
            Gesture::Press { pointer: p, released, trigger, .. } if *p == pointer => {
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
            Gesture::Held { pointer: p } | Gesture::Scrub { pointer: p } if *p == pointer => {
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Pinch { pointers } if pointers.iter().any(|(p, _)| *p == pointer) => {
                self.gestures.now = Gesture::Idle;
            }
            Gesture::Box { pointer: p, from, zooms, .. } if *p == pointer => {
                let (corners, zooms) = ([*from, point], *zooms);
                self.gestures.now = Gesture::Idle;
                if !near(corners[0], corners[1], SLOP) {
                    self.boxed(corners, zooms, pointing);
                }
            }
            Gesture::Connect { pointer: p, .. } if *p == pointer => {
                let Gesture::Connect { from, edge, .. } = std::mem::take(&mut self.gestures.now) else { return true };
                let hits = self.pick(point, self.scene.controls.pick_radius);
                self.events.tell_after(hits, Awaited::Connect { from, edge, trigger: pointing });
            }
            _ => return false,
        }
        true
    }

    /// Stops what `pointer` is doing, or with `None` what every pointer and the keys are doing,
    /// without acting on it: a drag reports [`Phase::Cancel`] with the row back where it started,
    /// and nothing coasts, clicks, selects, connects, or opens a menu. A new session starts, so
    /// probes asked for before land unused. Returns whether it stopped anything.
    fn cancel(&mut self, pointer: Option<u32>) -> bool {
        let pointers =
            pointer.is_none_or(|p| self.gestures.now.holds(p)) && !matches!(self.gestures.now, Gesture::Idle);
        let keys = &self.gestures.keys;
        let keys = pointer.is_none() && (keys.at.is_some() || keys.finding.is_some() || !keys.queued.is_empty());
        if !pointers && !keys {
            return false;
        }
        if pointers {
            if matches!(self.gestures.now, Gesture::Drag { .. }) {
                self.drag(Phase::Cancel, self.pointing());
            }
            self.gestures.now = Gesture::Idle;
            self.gestures.release();
        }
        if keys {
            let pointed = self.gestures.keys.at.is_some();
            // A step not yet probed is dropped, and the answer of one in flight goes unused.
            self.gestures.keys = Stepping::default();
            self.probing.step = None;
            if pointed {
                self.hover(None, Trigger { point: self.middle(), device: Device::Keyboard, ..Trigger::default() });
            }
        }
        self.gestures.session += 1;
        self.probing.wanted = None;
        true
    }

    /// Acts on a box dragged between screen points `corners`: selects the rows inside it, or with
    /// `zooms` frames it.
    fn boxed(&mut self, corners: [[f32; 2]; 2], zooms: bool, trigger: Trigger) {
        if !zooms {
            self.select_box(corners, trigger);
            return;
        }
        // The box frames the positions under its four corners.
        let [a, b] = corners;
        let under = [a, [a[0], b[1]], b, [b[0], a[1]]].map(|p| self.anchor(p, None));
        let min = std::array::from_fn(|k| under.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min));
        let max = std::array::from_fn(|k| under.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max));
        self.fit(Fit::Bounds { min, max });
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

    /// Hovers `hit`, reporting a change when the row or the traced sample differs. A
    /// row the application hovered stays until the pointer or keys hover a row, or leave one.
    fn hover(&mut self, hit: Option<Hit>, trigger: Trigger) {
        let spot = hit.as_ref().map(|h| (h.row.clone(), h.sample.map(|s| s.frame)));
        if spot == self.focus.spot {
            return;
        }
        self.focus.spot = spot;
        let row = hit.as_ref().map(|h| h.row.clone());
        if row != self.focus.hovered {
            self.focus.hovered = row;
            self.focus.hovering = true;
            self.wake();
        }
        self.events.tell(Event::Hovered { hit, trigger });
    }

    /// Decides what a press does, by what its input does. A box starts regardless of what lies
    /// under the press. Otherwise, once the probe's answer is known, a release clicks or opens a
    /// menu, and a move turns, connects, drags the row, or does its input's action.
    fn pressed(&mut self) {
        let Gesture::Press { pointer, button, from, trigger, answer, released, earlier, .. } = &mut self.gestures.now
        else {
            return;
        };
        let action = self.scene.controls.gestures.get(source(*button), trigger.modifiers);
        if matches!(action, Action::Box | Action::ZoomBox) && !near(*from, trigger.point, SLOP) {
            let (pointer, corners, trigger, released) = (*pointer, [*from, trigger.point], *trigger, *released);
            let zooms = action == Action::ZoomBox;
            if released {
                self.gestures.now = Gesture::Idle;
                self.boxed(corners, zooms, trigger);
            } else {
                self.gestures.now = Gesture::Box { pointer, from: corners[0], to: corners[1], zooms };
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
        if matches!(action, Action::Turn | Action::Tilt) && self.turns() {
            let anchor = self.anchor(from, Some(&answer));
            self.gestures.now = Gesture::Turn { pointer, anchor, last: from, tilt: action == Action::Tilt };
            self.moved(pointer, to);
            return;
        }
        if self.connects()
            && let Some((from, edge, anchor)) =
                answer.hit.as_ref().and_then(|probed| self.connect_from(probed, action == Action::Connect))
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
                let held = self.held(&probed.hit);
                self.gestures.now = Gesture::Drag { pointer, probed, grab, from: held };
                self.drag(Phase::Start, trigger);
            }
            _ if action == Action::Scrub && self.plots() => {
                self.gestures.now = Gesture::Scrub { pointer };
                self.seek(to);
            }
            // Every other action pans here: a turn where the camera cannot turn, a scrub off a
            // plot, and a connection from nothing that connects.
            _ if action != Action::None => {
                let anchor = self.anchor(from, Some(&answer));
                let delta = [f64::from(to[0] - from[0]), f64::from(to[1] - from[1])];
                self.gestures.now = Gesture::Pan { pointer, anchor, last: to };
                let camera = self.camera.panned(&self.projected(), anchor, delta);
                self.move_camera(camera);
            }
            _ => self.gestures.now = Gesture::Idle,
        }
    }

    /// A press released where it began: a click, a menu for the secondary button, and nothing for
    /// the middle button, which only drags. On a plot where the click's input scrubs, it also
    /// seeks.
    fn tap(&mut self, button: Button, hit: Option<Probed>, trigger: Trigger) {
        match button {
            Button::Secondary => self.menu(trigger),
            Button::Middle => {}
            Button::Primary => {
                if self.plots()
                    && self.scene.controls.gestures.get(Control::Primary, trigger.modifiers) == Action::Scrub
                {
                    self.seek(trigger.point);
                }
                self.click(hit, trigger);
            }
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

    /// Reports where the dragged row goes. With the pointer at `trigger`, the hit point moves with
    /// it from the press, at the depth where the drag started. A cancel writes back what the row's position fields held, missing
    /// values included, however the camera has moved since. It reports the row where those
    /// fields placed it, or where it was drawn when they held nothing.
    fn drag(&mut self, phase: Phase, trigger: Trigger) {
        let Gesture::Drag { probed, grab, from, .. } = &self.gestures.now else { return };
        let (position, place) = match (phase, *from) {
            (Phase::Cancel, Some(held)) => match held {
                [Some(x), Some(y)] => ([x, y, probed.hit.position[2]], Some(held)),
                _ => (probed.hit.position, Some(held)),
            },
            (Phase::Cancel, None) => (probed.hit.position, None),
            _ => {
                let view = self.projected();
                let at = [trigger.point[0] + grab[0], trigger.point[1] + grab[1]];
                let position = view.position(view.unproject(at.map(f64::from), f64::from(probed.depth)));
                (position, Some([Some(position[0]), Some(position[1])]))
            }
        };
        let row = probed.hit.row.clone();
        let patch = place.and_then(|place| super::arranged(&self.scene, vec![(row, place)]).into_iter().next());
        self.events.tell(Event::Drag { phase, hit: probed.hit.clone(), position, patch, trigger });
    }

    /// What `hit`'s row's position fields hold in the table its frame drew: its mark's x and y
    /// fields, or its point, each missing value as `None`. `None` when its mark places it by an
    /// expression, or the table no longer holds the row.
    fn held(&self, hit: &Hit) -> Option<[Option<f64>; 2]> {
        let crate::Mark::Vertices(mark) = self.scene.marks.get(hit.index)? else { return None };
        let table = &self.marks.get(hit.index)?.holding.as_ref()?.table;
        table.row(hit.row.id.as_ref())?;
        let value = |field: &str| table.get(hit.row.id.clone(), field);
        let number = |field: &str| match value(field) {
            Some(Value::Number(v)) => Some(v),
            _ => None,
        };
        Some(match &mark.position {
            None => match value(mark.point_field()) {
                Some(Value::Point([x, y])) => [Some(x), Some(y)],
                _ => [None, None],
            },
            Some([x, y]) => [number(x.field_name()?), number(y.field_name()?)],
        })
    }

    /// Shows the axis coordinate under `point` on a plot, reporting it when it changes.
    fn seek(&mut self, point: [f32; 2]) {
        if let Some([at, ..]) = self.position(point)
            && at != self.at
        {
            self.set_at(at);
            self.events.tell(Event::At(at));
        }
    }

    /// The touch input the view takes from the page, as CSS `touch-action` names it: `none` when a
    /// finger dragging does something here (an input, a draggable mark, or a connection),
    /// `pan-x pan-y` when only two fingers do, so one finger scrolls the page, and otherwise
    /// `manipulation`, so the page pans and zooms.
    #[cfg_attr(not(target_arch = "wasm32"), expect(dead_code, reason = "only a page hands touch input to the view"))]
    pub(crate) fn touch_action(&self) -> &'static str {
        let inputs = &self.scene.controls.gestures;
        let still = Modifiers::default();
        let drags = self.scene.marks.iter().any(|m| m.style().interaction.drag);
        if inputs.get(Control::Primary, still) != Action::None || drags || self.connects() {
            "none"
        } else if two_fingers(inputs, still) {
            "pan-x pan-y"
        } else {
            "manipulation"
        }
    }

    /// Whether the view shows a plot, where scrubbing moves the coordinate shown.
    fn plots(&self) -> bool {
        matches!(self.scene.space, Space::Plot(_))
    }

    /// Whether any input connects, so a press on an edge's end connects too.
    fn connects(&self) -> bool {
        self.scene.controls.gestures.any(Action::Connect)
    }

    /// Whether a row is being dragged. Rows it moves then update without easing.
    pub(super) fn dragging(&self) -> bool {
        matches!(self.gestures.now, Gesture::Drag { .. })
    }

    /// Whether the camera can turn: a map camera.
    fn turns(&self) -> bool {
        matches!(self.camera, Camera::Map { .. })
    }

    /// Whether clicking a row of mark `mark` selects it.
    fn selects(&self, mark: usize) -> bool {
        self.scene.marks.get(mark).is_some_and(|m| m.style().interaction.select)
    }

    /// Where a connection starts from what a press hit: at a vertex when the press's input
    /// `connects`, or, for an edge with ends, at the end that stays (the end pressed nearer
    /// detaches). Also returns the edge, and the start's screen point when known.
    fn connect_from(&self, probed: &Probed, connects: bool) -> Option<(End, Option<Row>, Option<[f32; 2]>)> {
        let hit = &probed.hit;
        let shown = self.marks.get(hit.index)?;
        match shown.kind() {
            MarkKind::Vertices if connects => Some((End { row: hit.row.clone() }, None, Some(hit.point))),
            MarkKind::Edges => {
                let crate::Mark::Edges(edges) = &shown.mark else { return None };
                let (first, second) = edges.ends.as_ref()?;
                let stays = if probed.end == 0 { second } else { first };
                let row = self.referenced(&hit.row, stays)?;
                Some((End { row }, Some(hit.row.clone()), None))
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
                let to = hits.iter().find(vertex).map(|hit| End { row: hit.row.clone() });
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

    /// Zooms, pans, turns, or tilts about the point under the wheel, as the wheel's input says.
    /// Otherwise leaves the wheel to the page. The wheel scrolls the view as it would a page, so it
    /// pans and turns the opposite way to a drag.
    fn wheel(&mut self, point: [f32; 2], delta: [f32; 2], modifiers: Modifiers) -> bool {
        let [dx, dy] = delta.map(f64::from);
        let (pan, turn, zoom) = match self.scene.controls.gestures.get(Control::Wheel, modifiers) {
            Action::Zoom => ([0.0; 2], [0.0; 2], (-dy / 400.0).clamp(-1.0, 1.0)),
            Action::Turn if self.turns() => ([0.0; 2], [-dx * TURN, dy * TURN], 0.0),
            Action::Tilt if self.turns() => ([0.0; 2], [0.0, dy * TURN], 0.0),
            Action::Pan | Action::Turn | Action::Tilt => ([-dx, -dy], [0.0; 2], 0.0),
            _ => return false,
        };
        let anchor = self.anchor(point, self.probing.at(point).as_ref());
        self.rig.owe(anchor, pan, turn, zoom);
        true
    }

    fn key(&mut self, key: Key, modifiers: Modifiers) -> bool {
        let controls = self.scene.controls;
        let stepped = self.gestures.keys.at.clone();
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
        controls.keyboard && self.camera_by_key(key, trigger)
    }

    /// Moves the camera as `key` does, in the ways some input does: an arrow pans, or with Shift
    /// turns, plus and minus zoom, and Home frames everything. Escape clears the selection. Returns
    /// whether the key was used.
    fn camera_by_key(&mut self, key: Key, trigger: Trigger) -> bool {
        let (controls, modifiers) = (self.scene.controls, trigger.modifiers);
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
        // The keys move the camera only in the ways some input does.
        let inputs = controls.gestures;
        let turns = self.turns() && (inputs.any(Action::Turn) || inputs.any(Action::Tilt));
        match (key, arrow) {
            (_, Some([dx, dy])) if modifiers.shift && turns => {
                self.rig.owe(anchor, [0.0; 2], [-dx * STEP_TURN, dy * STEP_TURN], 0.0);
            }
            (_, Some([dx, dy])) if inputs.any(Action::Pan) => {
                self.rig.owe(anchor, [dx * STEP, dy * STEP], [0.0; 2], 0.0);
            }
            (Key::Plus, _) if inputs.any(Action::Zoom) => self.rig.owe(anchor, [0.0; 2], [0.0; 2], STEP_ZOOM),
            (Key::Minus, _) if inputs.any(Action::Zoom) => self.rig.owe(anchor, [0.0; 2], [0.0; 2], -STEP_ZOOM),
            (Key::Home, _) => self.fit(Fit::All),
            (Key::Escape, _) => self.reselect(Vec::new(), Some(trigger)),
            _ => return false,
        }
        true
    }

    /// Steps the row the keys point at: Tab to the row nearest the view's middle, an arrow to the
    /// nearest row within 45° of its direction from where the row they point at lies now. The GPU
    /// finds the row over the next frames, reading back only that row however many are in view.
    /// Keys pressed meanwhile wait, then step from it. The view is one stop in the page's tab
    /// order: Tab steps to a row once, and the next Tab or any Shift+Tab is not used, so focus
    /// leaves the view. Returns whether the key was used.
    fn step(&mut self, key: Key, modifiers: Modifiers) -> bool {
        let keys = &self.gestures.keys;
        let tab = key == Key::Tab;
        let entering = keys.finding.as_ref().is_some_and(|f| f.key == Key::Tab);
        if tab && (modifiers.shift || entering || keys.at.is_some()) {
            if self.gestures.keys.at.take().is_some() {
                self.hover(None, Trigger { point: self.middle(), modifiers, device: Device::Keyboard });
            }
            return false;
        }
        if keys.finding.is_some() {
            self.gestures.keys.queued.push((key, modifiers));
            return true;
        }
        let way = match key {
            Key::Tab => None,
            Key::Left => Some([-1.0, 0.0]),
            Key::Right => Some([1.0, 0.0]),
            Key::Up => Some([0.0, -1.0]),
            Key::Down => Some([0.0, 1.0]),
            _ => return false,
        };
        if !self.marks.iter().any(Shown::probed) || (way.is_some() && keys.at.is_none()) {
            return false;
        }
        // An arrow starts where the row the keys point at lies now, which its position gives, and
        // passes over it. Tab starts from the middle of the view.
        let step = match &self.gestures.keys.at {
            Some(hit) => {
                let view = self.projected();
                let now = view.screen(view.world(hit.position)).map_or(hit.point, |s| [s[0] as f32, s[1] as f32]);
                let held = self.held_of(hit.index, &hit.row);
                let skip = held.map_or([wgsl::NONE; 2], |held| [hit.index as u32, held]);
                Step { start: now, way: way.unwrap_or_default(), skip }
            }
            None => Step { start: self.middle(), way: [0.0; 2], skip: [wgsl::NONE; 2] },
        };
        self.probing.step = Some(step);
        self.gestures.keys.finding = Some(Finding { key, modifiers });
        self.wake();
        true
    }

    /// Hovers `hit`, the row a keys' step found, then steps the keys pressed meanwhile. An arrow
    /// that finds no row that way moves the camera instead, as it does with no row pointed at.
    pub(super) fn stepped(&mut self, hit: Option<Hit>) {
        let Some(Finding { key, modifiers }) = self.gestures.keys.finding.take() else { return };
        match hit {
            Some(hit) => {
                self.gestures.keys.at = Some(hit.clone());
                self.hover(Some(hit.clone()), Trigger { point: hit.point, modifiers, device: Device::Keyboard });
            }
            None if key != Key::Tab => {
                let point = self.gestures.keys.at.as_ref().map_or_else(|| self.middle(), |hit| hit.point);
                self.camera_by_key(key, Trigger { point, modifiers, device: Device::Keyboard });
            }
            None => {}
        }
        for (key, modifiers) in std::mem::take(&mut self.gestures.keys.queued) {
            self.step(key, modifiers);
        }
    }

    /// The middle of the part of the view the camera frames, CSS pixels from the top left.
    fn middle(&self) -> [f32; 2] {
        let [left, top, right, bottom] = self.area();
        [left.midpoint(right) as f32, top.midpoint(bottom) as f32]
    }
}
