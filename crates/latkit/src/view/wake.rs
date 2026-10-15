//! Sleeping while waiting: work a view waits on (a readback the GPU copies, a job a host does, bytes
//! a host fetches) lands between frames and wakes the view's signal, which marks a frame due and
//! wakes whatever draws its frames. Until something lands or changes, the view draws nothing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Wake, Waker};

/// What wakes a view: work landing, or the view itself changing.
#[derive(Default)]
pub(crate) struct Signal {
    landed: AtomicBool,
    /// Whether a shot draws the view, so nothing else does.
    lent: AtomicBool,
    /// Whatever draws the view's frames, as `View::set_waker` gave it.
    waker: Mutex<Option<Waker>>,
}

impl Signal {
    /// Whether work landed since the frame began.
    pub(crate) fn landed(&self) -> bool {
        self.landed.load(Ordering::Acquire)
    }

    /// Takes what landed: the frame beginning settles it.
    pub(crate) fn clear(&self) {
        self.landed.store(false, Ordering::Release);
    }

    pub(crate) fn set_waker(&self, waker: Waker) {
        *self.waker.lock().unwrap_or_else(PoisonError::into_inner) = Some(waker);
    }

    /// Lends the view to a shot: `waker` wakes the shot in place of whatever drew the view, which
    /// draws it no more until it is given back; returns the waker it had.
    pub(crate) fn lend(&self, waker: Waker) -> Option<Waker> {
        self.lent.store(true, Ordering::Release);
        self.waker.lock().unwrap_or_else(PoisonError::into_inner).replace(waker)
    }

    /// Gives the view back to whatever drew it, `waker` waking it again, and asks it for a frame.
    pub(crate) fn give_back(&self, waker: Option<Waker>) {
        *self.waker.lock().unwrap_or_else(PoisonError::into_inner) = waker;
        self.lent.store(false, Ordering::Release);
        self.ask();
    }

    /// Whether a shot draws the view.
    pub(crate) fn lent(&self) -> bool {
        self.lent.load(Ordering::Acquire)
    }

    /// Asks whatever draws the view for a frame.
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
