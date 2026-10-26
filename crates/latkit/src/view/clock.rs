//! A view's clock: seconds of motion, advanced by the time between frames.
//!
//! Every ease, flight, fade, coast, orbit, and `elapsed()` reads this clock, never wall time, so
//! whatever draws the frames sets the timeline: an animation frame's timestamp, a video frame's
//! time, or a test's step. A shot may fix the time that `elapsed()` expressions and drawing effects
//! read while this clock keeps advancing finite transitions.

/// The longest step between two frames, in seconds. A driver that slept or switched timelines
/// never makes motion jump or run backward.
const STEP: f64 = 0.25;

#[derive(Default)]
pub(crate) struct Clock {
    /// Seconds of motion since the first frame.
    now: f64,
    /// The time the last frame gave, on its driver's timeline.
    last: Option<f64>,
    /// The seconds the last frame moved the clock by.
    step: f64,
}

impl Clock {
    /// Advances to a frame's `time`, returning the step in seconds. A non-finite `time` moves
    /// nothing.
    pub(crate) fn tick(&mut self, time: f64) -> f64 {
        let dt = match self.last {
            Some(last) if time.is_finite() => (time - last).clamp(0.0, STEP),
            _ => 0.0,
        };
        if time.is_finite() {
            self.last = Some(time);
        }
        self.now += dt;
        self.step = dt;
        dt
    }

    /// Whether the last frame moved the clock. Anything reading the clock changes only then.
    pub(crate) fn moved(&self) -> bool {
        self.step > 0.0
    }

    /// Seconds of motion since the first frame.
    pub(crate) fn now(&self) -> f64 {
        self.now
    }

    /// Progress of an ease of `seconds` begun at `start`, from 0 to 1 with smoothstep easing.
    /// Flights and transitions share it.
    pub(crate) fn eased(&self, start: f64, seconds: f64) -> f64 {
        let t = ((self.now - start) / seconds.max(1e-3)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    /// Whether an ease of `seconds` begun at `start` is done.
    pub(crate) fn done(&self, start: f64, seconds: f64) -> bool {
        self.now >= start + seconds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_follow_the_driver_and_never_jump_or_run_backward() {
        let mut clock = Clock::default();
        assert_eq!(clock.tick(100.0), 0.0, "the first frame starts the clock");
        assert!((clock.tick(100.5) - STEP).abs() < 1e-12, "a long gap moves it at most one step");
        assert_eq!(clock.tick(3.0), 0.0, "an earlier time never moves it backward");
        assert!((clock.tick(3.1) - 0.1).abs() < 1e-12);
        assert!((clock.now() - (STEP + 0.1)).abs() < 1e-12);
    }

    #[test]
    fn eases_are_smooth_and_end_on_time() {
        let mut clock = Clock::default();
        clock.tick(0.0);
        let start = clock.now();
        clock.tick(0.1);
        assert!((clock.eased(start, 0.2) - 0.5).abs() < 1e-12);
        assert!(!clock.done(start, 0.2));
        clock.tick(0.2);
        assert_eq!(clock.eased(start, 0.2), 1.0);
        assert!(clock.done(start, 0.2));
    }
}
