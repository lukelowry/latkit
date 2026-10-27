//! Camera motion. A gesture moves the camera at once, about the point under the pointer. The wheel,
//! the keys, and a released drag add pending motion about such a point, which the following frames
//! apply with exponential decay, so a fling coasts and a wheel notch glides by the same rule. A
//! flight eases over a set time, and an orbit turns steadily. All of it runs on the view's clock.
//!
//! The camera keeps within its reach: where the space lets it go in the room the camera frames,
//! narrowed by fits. Every move places it through the reach: gestures, pending motion, flights,
//! orbits, fits, and the setter. The reach changes with the view's size and insets, its space, and
//! fits, so each frame places the camera again before it moves.

use super::camera::{Bounds, Camera, Reach};
use super::{Event, View};

/// Time constants, in seconds, for applying pending motion: a fling's pan and turn coast longer
/// than a zoom glides.
const COAST: f64 = 0.3;
const GLIDE: f64 = 0.1;

#[derive(Default)]
pub(crate) struct Rig {
    /// The point pending motion moves about.
    anchor: [f64; 3],
    /// Pending motion: CSS pixels of pan, degrees of bearing and pitch, and levels of zoom.
    pan: [f64; 2],
    turn: [f64; 2],
    zoom: f64,
    flight: Option<Flight>,
    /// Degrees of bearing per second.
    pub(crate) orbit: f64,
    /// The box fits have framed, which narrows the reach.
    pub(crate) bounds: Option<Bounds>,
}

/// A flight from one camera to another, started at `start` on the view's clock.
struct Flight {
    from: Camera,
    to: Camera,
    start: f64,
    seconds: f64,
}

impl Rig {
    /// Whether the camera is easing to a rest: a flight or pending motion. An orbit never settles.
    pub(crate) fn easing(&self) -> bool {
        self.flight.is_some() || self.owed()
    }

    fn owed(&self) -> bool {
        self.pan != [0.0; 2] || self.turn != [0.0; 2] || self.zoom != 0.0
    }

    /// Drops pending motion and any flight, as when a gesture takes the camera.
    pub(crate) fn hold(&mut self) {
        self.pan = [0.0; 2];
        self.turn = [0.0; 2];
        self.zoom = 0.0;
        self.flight = None;
    }

    /// Adds `pan`, `turn`, and `zoom` to the pending motion, now about `anchor`, and cancels any
    /// flight.
    pub(crate) fn owe(&mut self, anchor: [f64; 3], pan: [f64; 2], turn: [f64; 2], zoom: f64) {
        self.flight = None;
        self.anchor = anchor;
        self.pan = [self.pan[0] + pan[0], self.pan[1] + pan[1]];
        self.turn = [self.turn[0] + turn[0], self.turn[1] + turn[1]];
        self.zoom += zoom;
    }

    /// Adds the motion a drag released with velocities `pan` and `turn` coasts: each velocity times
    /// the coasting time constant.
    pub(crate) fn fling(&mut self, anchor: [f64; 3], pan: [f64; 2], turn: [f64; 2]) {
        self.owe(anchor, pan.map(|v| v * COAST), turn.map(|v| v * COAST), 0.0);
    }

    /// Flies from `from` to `to` over `seconds`, beginning at `start` on the view's clock.
    pub(crate) fn fly(&mut self, from: Camera, to: Camera, start: f64, seconds: f64) {
        self.hold();
        self.flight = Some(Flight { from, to, start, seconds });
    }
}

impl View {
    /// Where the camera may go: the space's bounds in the room the camera frames, narrowed by the
    /// box fits have framed. Until a frame gives the view its size, only fits narrow it.
    pub(super) fn reach(&self) -> Reach {
        let area = self.area();
        let sized = self.size[0] > 0.0 && self.size[1] > 0.0;
        let room = sized.then(|| [area[2] - area[0], area[3] - area[1]]);
        Reach::new(&self.scene.space, room, self.rig.bounds)
    }

    /// Places the camera within its reach, which may have changed since the last frame; applies the
    /// share of pending motion due for the `dt` seconds the clock moved; advances a flight; and
    /// orbits.
    pub(super) fn advance(&mut self, dt: f64) {
        self.move_camera(self.camera);
        if let Some(flight) = &self.rig.flight {
            let eased = self.clock.eased(flight.start, flight.seconds);
            let camera = flight.from.ease(&flight.to, eased, &self.scene.space);
            if self.clock.done(flight.start, flight.seconds) {
                self.rig.flight = None;
            }
            self.move_camera(camera);
        }
        if dt <= 0.0 {
            return;
        }
        if self.rig.owed() {
            // When motion is disabled, pending motion applies at once.
            let moves = self.moves();
            let coast = if moves { 1.0 - (-dt / COAST).exp() } else { 1.0 };
            let glide = if moves { 1.0 - (-dt / GLIDE).exp() } else { 1.0 };
            let (pan, turn, zoom) =
                (self.rig.pan.map(|v| v * coast), self.rig.turn.map(|v| v * coast), self.rig.zoom * glide);
            let anchor = self.rig.anchor;
            let view = self.projected();
            let mut camera = self.camera.panned(&view, anchor, pan);
            camera = camera.turned(&self.projected_with(&camera), anchor, turn);
            camera = camera.zoomed(&self.projected_with(&camera), anchor, zoom, &self.reach());
            let settle = |v: f64, least: f64| if v.abs() < least { 0.0 } else { v };
            self.rig.pan = [settle(self.rig.pan[0] - pan[0], 0.05), settle(self.rig.pan[1] - pan[1], 0.05)];
            self.rig.turn = [settle(self.rig.turn[0] - turn[0], 0.01), settle(self.rig.turn[1] - turn[1], 0.01)];
            self.rig.zoom = settle(self.rig.zoom - zoom, 1e-4);
            self.move_camera(camera);
        }
        if self.rig.orbit != 0.0 && matches!(self.camera, Camera::Map { .. }) && self.moves() {
            let Camera::Map { center, .. } = self.camera else { return };
            let view = self.projected();
            let camera = self.camera.turned(&view, center, [self.rig.orbit * dt, 0.0]);
            self.move_camera(camera);
        }
    }

    /// Moves the camera for a gesture, a fit, or an animation, or into a reach that changed, and
    /// emits a `Camera` event if it moved.
    pub(super) fn move_camera(&mut self, camera: Camera) {
        if self.place_camera(camera) {
            self.events.tell(Event::Camera(self.camera));
        }
    }

    /// Moves the camera to `camera` kept within reach, and dirties the channels that read the
    /// camera or the pointer. Returns whether it moved.
    pub(super) fn place_camera(&mut self, camera: Camera) -> bool {
        let camera = camera.within(&self.reach());
        if camera == self.camera {
            return false;
        }
        self.camera = camera;
        self.fitting.plot_due = true;
        self.gestures.keys.stale();
        for shown in &mut self.marks {
            let channels =
                shown.channels_reading(crate::expr::compile::Deps::CAMERA | crate::expr::compile::Deps::POINTER);
            shown.dirty_rows(channels, None);
        }
        self.wake();
        true
    }
}
