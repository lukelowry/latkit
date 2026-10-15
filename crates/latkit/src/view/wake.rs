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
