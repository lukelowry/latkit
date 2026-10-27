//! Waking a view. Work the view waits on (a GPU readback, a host job, a host fetch) arrives between
//! frames and wakes the view's signal. The signal marks a frame due and wakes whatever draws the
//! view's frames. Until something arrives or changes, the view draws nothing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Wake, Waker};

/// Wakes a view when work arrives or the view itself changes.
#[derive(Default)]
pub(crate) struct Signal {
    landed: AtomicBool,
    /// The effect time a shot fixes, if any.
    elapsed: Mutex<Option<f64>>,
    /// Whether the shot draws a transparent background.
    transparent: AtomicBool,
    /// Whether a shot draws the view, so nothing else does.
    lent: AtomicBool,
    /// Whether the shot keeps the view's data unchanged from when it was lent, as a picture does.
    holding: AtomicBool,
    /// The waker of whatever draws the view's frames, as `View::set_waker` set it.
    waker: Mutex<Option<Waker>>,
}

impl Signal {
    /// Whether work arrived since the frame began.
    pub(crate) fn landed(&self) -> bool {
        self.landed.load(Ordering::Acquire)
    }

    /// Clears and returns the arrival flag at the start of a frame. Work that arrives afterwards,
    /// including work this frame starts that the host finishes at once, wakes the next frame.
    pub(crate) fn take(&self) -> bool {
        self.landed.swap(false, Ordering::AcqRel)
    }

    /// Restores the arrival flag `landed` for the next frame, as a frame that is not ready to draw
    /// does.
    pub(crate) fn leave(&self, landed: bool) {
        if landed {
            self.landed.store(true, Ordering::Release);
        }
    }

    pub(crate) fn set_waker(&self, waker: Waker) {
        *self.waker.lock().unwrap_or_else(PoisonError::into_inner) = Some(waker);
    }

    /// Lends the view to a shot. `waker` wakes the shot instead of whatever drew the view, which
    /// stops drawing it until it is given back. With `holding`, the view's data stays unchanged
    /// meanwhile. Returns the previous waker.
    pub(crate) fn lend(&self, waker: Waker, elapsed: Option<f64>, transparent: bool, holding: bool) -> Option<Waker> {
        *self.elapsed.lock().unwrap_or_else(PoisonError::into_inner) = elapsed;
        self.transparent.store(transparent, Ordering::Release);
        self.holding.store(holding, Ordering::Release);
        self.lent.store(true, Ordering::Release);
        self.waker.lock().unwrap_or_else(PoisonError::into_inner).replace(waker)
    }

    /// Returns the view to whatever drew it, restoring `waker`, and requests a frame.
    pub(crate) fn give_back(&self, waker: Option<Waker>) {
        *self.waker.lock().unwrap_or_else(PoisonError::into_inner) = waker;
        *self.elapsed.lock().unwrap_or_else(PoisonError::into_inner) = None;
        self.transparent.store(false, Ordering::Release);
        self.holding.store(false, Ordering::Release);
        self.lent.store(false, Ordering::Release);
        self.landed.store(true, Ordering::Release);
        self.ask();
    }

    pub(crate) fn elapsed(&self) -> Option<f64> {
        *self.elapsed.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn transparent(&self) -> bool {
        self.transparent.load(Ordering::Acquire)
    }

    /// Whether a shot draws the view.
    pub(crate) fn lent(&self) -> bool {
        self.lent.load(Ordering::Acquire)
    }

    /// Whether the shot drawing the view keeps its data unchanged from when it was lent.
    pub(crate) fn holding(&self) -> bool {
        self.holding.load(Ordering::Acquire)
    }

    /// Requests a frame from whatever draws the view.
    pub(crate) fn ask(&self) {
        if let Some(waker) = self.waker.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            waker.wake_by_ref();
        }
    }
}

impl Wake for Signal {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.landed.store(true, Ordering::Release);
        self.ask();
    }
}
