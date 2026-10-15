//! The one future latkit hands out: what a view will answer once the GPU has, and what a host's job
//! or fetch will bring.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};

use crate::Result;

/// A value still to come: a future its [`Resolver`] resolves, from a view's frames, a host's worker,
/// or the network. A view's answers resolve to an error when the device is lost, and stay pending
/// while no frames are drawn. Await it, or [`take`](Pending::take) it from a frame loop.
#[must_use = "a pending value does nothing unless awaited or taken"]
pub struct Pending<T>(Arc<Mutex<Slot<T>>>);

enum Slot<T> {
    Waiting(Option<Waker>),
    Ready(Result<T>),
    Taken,
}

/// What resolves a [`Pending`]: a host keeps it until its job or fetch is done.
pub struct Resolver<T>(Arc<Mutex<Slot<T>>>);

impl<T> Pending<T> {
    /// A pending value, and what resolves it.
    pub fn new() -> (Pending<T>, Resolver<T>) {
        let slot = Arc::new(Mutex::new(Slot::Waiting(None)));
        (Pending(slot.clone()), Resolver(slot))
    }

    /// A value already here.
    pub fn ready(result: Result<T>) -> Pending<T> {
        Pending(Arc::new(Mutex::new(Slot::Ready(result))))
    }

    /// Wakes `waker` once the value is resolved: at once when it already is.
    pub(crate) fn notify(&self, waker: &Waker) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match &mut *slot {
            Slot::Waiting(waiting) => *waiting = Some(waker.clone()),
            Slot::Ready(_) => waker.wake_by_ref(),
            Slot::Taken => {}
        }
    }

    /// The value once resolved, taking it; `None` while it waits, and after it was taken.
    pub fn take(&self) -> Option<Result<T>> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match std::mem::replace(&mut *slot, Slot::Taken) {
            Slot::Ready(value) => Some(value),
            waiting @ Slot::Waiting(_) => {
                *slot = waiting;
                None
            }
            Slot::Taken => None,
        }
    }
}

impl<T> Resolver<T> {
    /// Resolves the pending value with `result`, waking whatever awaits it.
    pub fn resolve(self, result: Result<T>) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Slot::Waiting(waker) = std::mem::replace(&mut *slot, Slot::Ready(result))
            && let Some(waker) = waker
        {
            waker.wake();
        }
    }
}

impl<T> Future for Pending<T> {
    type Output = Result<T>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Result<T>> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match std::mem::replace(&mut *slot, Slot::Taken) {
            Slot::Ready(value) => Poll::Ready(value),
            Slot::Waiting(_) => {
                *slot = Slot::Waiting(Some(context.waker().clone()));
                Poll::Pending
            }
            Slot::Taken => panic!("a pending value polled after it resolved"),
        }
    }
}

impl<T> std::fmt::Debug for Pending<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pending")
    }
}

impl<T> std::fmt::Debug for Resolver<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Resolver")
    }
}
