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
    elapsed: Mutex<Option<f64>>,
    transparent: AtomicBool,
    /// Whether a shot draws the view, so nothing else does.
    lent: AtomicBool,
    /// Whether the shot draws the view's data as it was when lent, as a picture does.
    holding: AtomicBool,
    /// Whatever draws the view's frames, as `View::set_waker` gave it.
    waker: Mutex<Option<Waker>>,
}

impl Signal {
    /// Whether work landed since the frame began.
    pub(crate) fn landed(&self) -> bool {
        self.landed.load(Ordering::Acquire)
    }

    /// Takes what landed as a frame begins, before it takes anything: whether anything did. What
    /// lands from then on, as work the frame starts and the host answers at once, wakes the next.
    pub(crate) fn take(&self) -> bool {
        self.landed.swap(false, Ordering::AcqRel)
    }

    /// Leaves what landed, `landed`, to the next frame: as a frame not ready to draw does, taking
    /// none of it.
    pub(crate) fn leave(&self, landed: bool) {
        if landed {
            self.landed.store(true, Ordering::Release);
        }
    }

    pub(crate) fn set_waker(&self, waker: Waker) {
        *self.waker.lock().unwrap_or_else(PoisonError::into_inner) = Some(waker);
    }

    /// Lends the view to a shot: `waker` wakes the shot in place of whatever drew the view, which
    /// draws it no more until it is given back, `holding` its data as it is; returns the waker it had.
    pub(crate) fn lend(&self, waker: Waker, elapsed: Option<f64>, transparent: bool, holding: bool) -> Option<Waker> {
        *self.elapsed.lock().unwrap_or_else(PoisonError::into_inner) = elapsed;
        self.transparent.store(transparent, Ordering::Release);
        self.holding.store(holding, Ordering::Release);
        self.lent.store(true, Ordering::Release);
        self.waker.lock().unwrap_or_else(PoisonError::into_inner).replace(waker)
    }

    /// Gives the view back to whatever drew it, `waker` waking it again, and asks it for a frame.
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

    /// Whether the shot drawing the view draws its data as it was when lent.
    pub(crate) fn holding(&self) -> bool {
        self.holding.load(Ordering::Acquire)
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
