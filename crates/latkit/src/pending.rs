//! The one future latkit hands out: what a view will answer once the GPU has, and what a host's job
//! or fetch will bring.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};

use crate::{Error, Result};

/// A value still to come: a future its [`Resolver`] resolves, from a view's frames, a host's worker,
/// or the network. A view's answers resolve to an error when the device is lost, and stay pending
/// while no frames are drawn. Destroying their owner cancels them. Await it, or [`take`](Pending::take)
/// it from a frame loop.
#[must_use = "a pending value does nothing unless awaited or taken"]
pub struct Pending<T>(Arc<Mutex<Slot<T>>>);

enum Slot<T> {
    Waiting { waker: Option<Waker>, errors: Option<Arc<Mutex<Vec<Error>>>> },
    Ready(Result<T>),
    Taken,
}

/// What resolves a [`Pending`]: a host keeps it until its job or fetch is done. Dropping it without
/// resolving cancels the answer and wakes its waiter.
pub struct Resolver<T>(Arc<Mutex<Slot<T>>>);

impl<T> Pending<T> {
    /// A pending value, and what resolves it.
    pub fn new() -> (Pending<T>, Resolver<T>) {
        let slot = Arc::new(Mutex::new(Slot::Waiting { waker: None, errors: None }));
        (Pending(slot.clone()), Resolver(slot))
    }

    /// A value already here.
    pub fn ready(result: Result<T>) -> Pending<T> {
        Pending(Arc::new(Mutex::new(Slot::Ready(result))))
    }

    /// Wakes `waker` once the value is resolved: at once when it already is.
    #[cfg(feature = "gpu")]
    pub(crate) fn notify(&self, waker: &Waker) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match &mut *slot {
            Slot::Waiting { waker: waiting, .. } => *waiting = Some(waker.clone()),
            Slot::Ready(_) => {
                drop(slot);
                waker.wake_by_ref();
            }
            Slot::Taken => {}
        }
    }

    /// Reports a host job's failure even if its derivation keeps an earlier result. Called once
    /// before handing the pending value to a derivation; superseded/dropped consumers report nothing.
    #[cfg(any(feature = "gpu", test))]
    pub(crate) fn report_errors(&self, errors: &Arc<Mutex<Vec<Error>>>) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match &mut *slot {
            Slot::Waiting { errors: sink, .. } => *sink = Some(errors.clone()),
            Slot::Ready(Err(error)) => errors.lock().unwrap_or_else(PoisonError::into_inner).push(error.clone()),
            _ => {}
        }
    }

    /// The value once resolved, taking it; `None` while it waits, and after it was taken.
    pub fn take(&self) -> Option<Result<T>> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match std::mem::replace(&mut *slot, Slot::Taken) {
            Slot::Ready(value) => Some(value),
            waiting @ Slot::Waiting { .. } => {
                *slot = waiting;
                None
            }
            Slot::Taken => None,
        }
    }
}

impl<T> Resolver<T> {
    /// Whether the consumer dropped its pending value, so unstarted work can be skipped.
    pub fn is_cancelled(&self) -> bool {
        Arc::strong_count(&self.0) == 1
    }

    /// Resolves the pending value with `result`, waking whatever awaits it.
    pub fn resolve(self, result: Result<T>) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Slot::Waiting { errors: Some(errors), .. } = &*slot
            && !self.is_cancelled()
            && let Err(error) = &result
        {
            errors.lock().unwrap_or_else(PoisonError::into_inner).push(error.clone());
        }
        let previous = std::mem::replace(&mut *slot, Slot::Ready(result));
        drop(slot);
        if let Slot::Waiting { waker, .. } = previous
            && let Some(waker) = waker
        {
            waker.wake();
        }
    }
}

impl<T> Drop for Resolver<T> {
    fn drop(&mut self) {
        let waker = {
            let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            let Slot::Waiting { waker, errors } = &mut *slot else { return };
            if !self.is_cancelled()
                && let Some(errors) = errors
            {
                errors.lock().unwrap_or_else(PoisonError::into_inner).push(Error::Cancelled);
            }
            let waker = waker.take();
            *slot = Slot::Ready(Err(Error::Cancelled));
            waker
        };
        if let Some(waker) = waker {
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
            Slot::Waiting { errors, .. } => {
                *slot = Slot::Waiting { waker: Some(context.waker().clone()), errors };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::task::Wake;

    struct Notified(AtomicBool);

    impl Wake for Notified {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    #[test]
    fn dropping_the_resolver_cancels_and_wakes_the_waiter() {
        let (mut pending, resolver) = Pending::<u32>::new();
        let notified = Arc::new(Notified(AtomicBool::new(false)));
        let waker = Waker::from(notified.clone());
        assert!(Pin::new(&mut pending).poll(&mut Context::from_waker(&waker)).is_pending());
        drop(resolver);
        assert!(notified.0.load(Ordering::Relaxed));
        assert_eq!(pending.take(), Some(Err(Error::Cancelled)));
    }

    #[test]
    fn resolving_preserves_the_answer_when_the_resolver_drops() {
        let (pending, resolver) = Pending::new();
        resolver.resolve(Ok(42));
        assert_eq!(pending.take(), Some(Ok(42)));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn job_failures_report_before_the_answer_is_consumed() {
        let errors = Arc::new(Mutex::new(Vec::new()));
        let (pending, resolver) = Pending::<()>::new();
        pending.report_errors(&errors);
        resolver.resolve(Err(Error::DeviceLost));
        assert_eq!(pending.take(), Some(Err(Error::DeviceLost)));
        assert_eq!(*errors.lock().unwrap(), vec![Error::DeviceLost]);
        let ready = Pending::<()>::ready(Err(Error::Timeout));
        ready.report_errors(&errors);
        assert_eq!(*errors.lock().unwrap(), vec![Error::DeviceLost, Error::Timeout]);
    }

    #[test]
    fn abandoned_jobs_do_not_report_failures() {
        let errors = Arc::new(Mutex::new(Vec::new()));
        let (pending, resolver) = Pending::<()>::new();
        pending.report_errors(&errors);
        assert!(!resolver.is_cancelled());
        drop(pending);
        assert!(resolver.is_cancelled());
        resolver.resolve(Err(Error::DeviceLost));
        assert_eq!(*errors.lock().unwrap(), Vec::<Error>::new());
    }
}
