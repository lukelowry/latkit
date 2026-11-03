//! Waking a view. Work the view waits on (a GPU readback, a host job, a host fetch) arrives between
//! frames and wakes the view's signal. The signal marks a frame due and wakes whatever draws the
//! view's frames: the shot it is lent to, or else its home, such as the page. Until something
//! arrives or changes, the view draws nothing. The signal belongs to the view, not to its device,
//! so it stays the same when the view moves to a new device, and so does a lend in progress.

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
    /// Whether the shot keeps the view's data unchanged from when it was lent, as a picture does.
    holding: AtomicBool,
    /// The waker of whatever draws the view's frames, as `View::set_waker` set it.
    home: Mutex<Option<Waker>>,
    /// The waker of the shot the view is lent to, woken instead of `home` until it is given back.
    lender: Mutex<Option<Waker>>,
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

    /// Sets the waker of whatever draws the view's frames. A shot the view is lent to stays woken
    /// instead until it gives the view back.
    pub(crate) fn set_waker(&self, waker: Waker) {
        *self.home.lock().unwrap_or_else(PoisonError::into_inner) = Some(waker);
    }

    /// Lends the view to a shot. `waker` wakes the shot instead of the view's home, which stops
    /// drawing it until it is given back. With `holding`, the view's data stays unchanged
    /// meanwhile.
    pub(crate) fn lend(&self, waker: Waker, elapsed: Option<f64>, transparent: bool, holding: bool) {
        *self.elapsed.lock().unwrap_or_else(PoisonError::into_inner) = elapsed;
        self.transparent.store(transparent, Ordering::Release);
        self.holding.store(holding, Ordering::Release);
        *self.lender.lock().unwrap_or_else(PoisonError::into_inner) = Some(waker);
    }

    /// Returns the view to its home, as it is now, and requests a frame there.
    pub(crate) fn give_back(&self) {
        *self.lender.lock().unwrap_or_else(PoisonError::into_inner) = None;
        *self.elapsed.lock().unwrap_or_else(PoisonError::into_inner) = None;
        self.transparent.store(false, Ordering::Release);
        self.holding.store(false, Ordering::Release);
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
        self.lender.lock().unwrap_or_else(PoisonError::into_inner).is_some()
    }

    /// Whether the shot drawing the view keeps its data unchanged from when it was lent.
    pub(crate) fn holding(&self) -> bool {
        self.holding.load(Ordering::Acquire)
    }

    /// Requests a frame from whatever draws the view: the shot it is lent to, or else its home.
    pub(crate) fn ask(&self) {
        if let Some(lender) = self.lender.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            lender.wake_by_ref();
            return;
        }
        if let Some(home) = self.home.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            home.wake_by_ref();
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    /// A waker that counts its wakes.
    #[derive(Default)]
    struct Count(AtomicUsize);

    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn a_view_moved_while_lent_wakes_its_shot_then_its_new_home() {
        let signal = Arc::new(Signal::default());
        let (old, new, shot) = (Arc::new(Count::default()), Arc::new(Count::default()), Arc::new(Count::default()));
        let woken = |count: &Arc<Count>| count.0.load(Ordering::Relaxed);
        signal.set_waker(Waker::from(old.clone()));
        signal.lend(Waker::from(shot.clone()), None, false, true);
        // The view moves to a new device, whose page becomes its home, while the shot draws it.
        signal.set_waker(Waker::from(new.clone()));
        signal.ask();
        assert_eq!((woken(&old), woken(&new), woken(&shot)), (0, 0, 1), "the shot is woken");
        signal.give_back();
        assert!(!signal.lent());
        assert_eq!((woken(&old), woken(&new)), (0, 1), "and once done, the new home draws the view");
    }
}
