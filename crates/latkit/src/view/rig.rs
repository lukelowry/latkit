//! How the camera moves. A gesture moves it at once, about the point under the pointer. The wheel,
//! the keys, and a released drag leave motion owed about such a point, which the next frames pay out
//! exponentially, so a fling coasts and a wheel notch glides by the same rule. A flight eases over a
//! set time, an orbit turns steadily, and what a fit framed bounds how far the rest can take it. All
//! of it moves by the view's clock.

use super::camera::{Bounds, Camera};
use super::{Event, View};

/// Seconds over which owed motion pays out: a fling's pan and turn coast longer than a zoom glides.
const COAST: f64 = 0.3;
const GLIDE: f64 = 0.1;

#[derive(Default)]
pub(crate) struct Rig {
    /// The point owed motion moves about.
    anchor: [f64; 3],
    /// Motion owed: CSS pixels of pan, degrees of bearing and pitch, levels of zoom.
    pan: [f64; 2],
    turn: [f64; 2],
    zoom: f64,
    flight: Option<Flight>,
    /// Degrees of bearing per second.
    pub(crate) orbit: f64,
    /// What the last fit framed.
    pub(crate) bounds: Option<Bounds>,
}

/// A flight from one camera to another, begun at a time on the view's clock.
struct Flight {
    from: Camera,
    to: Camera,
    start: f64,
    seconds: f64,
}

impl Rig {
    /// Whether the camera will move without input.
    pub(crate) fn moving(&self) -> bool {
        self.flight.is_some() || self.orbit != 0.0 || self.owed()
    }

    /// Whether the camera eases toward where it goes: a flight, or motion owed. An orbit never settles.
    pub(crate) fn easing(&self) -> bool {
        self.flight.is_some() || self.owed()
    }

    fn owed(&self) -> bool {
        self.pan != [0.0; 2] || self.turn != [0.0; 2] || self.zoom != 0.0
    }

    /// Drops motion owed and any flight: a gesture takes the camera.
    pub(crate) fn hold(&mut self) {
        self.pan = [0.0; 2];
        self.turn = [0.0; 2];
        self.zoom = 0.0;
        self.flight = None;
    }

    /// Owes `pan`, `turn`, and `zoom` more about `anchor`.
    pub(crate) fn owe(&mut self, anchor: [f64; 3], pan: [f64; 2], turn: [f64; 2], zoom: f64) {
        self.flight = None;
        self.anchor = anchor;
        self.pan = [self.pan[0] + pan[0], self.pan[1] + pan[1]];
        self.turn = [self.turn[0] + turn[0], self.turn[1] + turn[1]];
        self.zoom += zoom;
    }

    /// Owes what a drag released at `velocity` coasts: its velocity over the coasting time.
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
    /// Moves the camera by a gesture or the rig, kept within reach of what was fitted.
    pub(super) fn steer(&mut self, camera: Camera) {
        let camera = match &self.rig.bounds {
            Some(bounds) => camera.within(bounds),
            None => camera,
        };
        self.move_camera(camera);
    }

    /// Pays out the share of motion owed for the `dt` seconds the clock moved, advances a flight,
    /// and orbits.
    pub(super) fn advance(&mut self, dt: f64) {
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
            let coast = 1.0 - (-dt / COAST).exp();
            let glide = 1.0 - (-dt / GLIDE).exp();
            let (pan, turn, zoom) =
                (self.rig.pan.map(|v| v * coast), self.rig.turn.map(|v| v * coast), self.rig.zoom * glide);
            let anchor = self.rig.anchor;
            let view = self.projected();
            let mut camera = self.camera.panned(&view, anchor, pan);
            camera = camera.turned(&self.projected_with(&camera), anchor, turn);
            camera = camera.zoomed(&self.projected_with(&camera), anchor, zoom);
            let settle = |v: f64, least: f64| if v.abs() < least { 0.0 } else { v };
            self.rig.pan = [settle(self.rig.pan[0] - pan[0], 0.05), settle(self.rig.pan[1] - pan[1], 0.05)];
            self.rig.turn = [settle(self.rig.turn[0] - turn[0], 0.01), settle(self.rig.turn[1] - turn[1], 0.01)];
            self.rig.zoom = settle(self.rig.zoom - zoom, 1e-4);
            self.steer(camera);
        }
        if self.rig.orbit != 0.0 && matches!(self.camera, Camera::Map { .. }) {
            let Camera::Map { center, .. } = self.camera else { return };
            let view = self.projected();
            let camera = self.camera.turned(&view, center, [self.rig.orbit * dt, 0.0]);
            self.move_camera(camera);
        }
    }

    /// Moves the camera by a gesture, a fit, or a motion over frames, telling the application.
    pub(super) fn move_camera(&mut self, camera: Camera) {
        if self.place_camera(camera) {
            self.events.tell(Event::Camera(camera));
        }
    }

    /// Moves the camera, evaluating again what reads it; whether it moved.
    pub(super) fn place_camera(&mut self, camera: Camera) -> bool {
        if camera == self.camera {
            return false;
        }
        self.camera = camera;
        self.fitting.plot_due = true;
        self.gestures.keys.stale();
        for shown in &mut self.marks {
            shown.dirty |=
                shown.channels_reading(crate::expr::compile::Deps::CAMERA | crate::expr::compile::Deps::POINTER);
        }
        self.wake();
        true
    }
}
