//! The future latkit returns for every deferred result: a view's answer once the GPU produces
//! it, or the result of a host's job or fetch.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};

use crate::{Error, Result};

/// A future value, resolved by its [`Resolver`] from a view's frames, a host's worker, or the
/// network. Await it, or poll it with [`take`](Pending::take) from a frame loop.
///
/// A view's answers resolve to an error when the device is lost, and stay pending while no frames
/// are drawn. Dropping their owner cancels them.
#[must_use = "a pending value does nothing unless awaited or taken"]
pub struct Pending<T>(Arc<Mutex<Slot<T>>>);

enum Slot<T> {
    Waiting { waker: Option<Waker>, errors: Option<Arc<Mutex<Vec<Error>>>> },
    Ready(Result<T>),
    Taken,
}

/// The write side of a [`Pending`]. A host keeps it until its job or fetch finishes. Dropping it
/// without resolving resolves the value to [`Error::Cancelled`] and wakes its waiter.
pub struct Resolver<T>(Arc<Mutex<Slot<T>>>);

impl<T> Pending<T> {
    /// Creates a pending value and its resolver.
    pub fn new() -> (Pending<T>, Resolver<T>) {
        let slot = Arc::new(Mutex::new(Slot::Waiting { waker: None, errors: None }));
        (Pending(slot.clone()), Resolver(slot))
    }

    /// A pending value that is already resolved.
    pub fn ready(result: Result<T>) -> Pending<T> {
        Pending(Arc::new(Mutex::new(Slot::Ready(result))))
    }

    /// Wakes `waker` when the value resolves, or immediately if it already has.
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

    /// Pushes this host job's failure to `errors`, even if the derivation consuming it keeps an
    /// earlier result. Call once, before handing the pending value to the derivation. Nothing is
    /// reported after the pending value is dropped, such as when a newer job supersedes it.
    #[cfg(any(feature = "gpu", test))]
    pub(crate) fn report_errors(&self, errors: &Arc<Mutex<Vec<Error>>>) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match &mut *slot {
            Slot::Waiting { errors: sink, .. } => *sink = Some(errors.clone()),
            Slot::Ready(Err(error)) => errors.lock().unwrap_or_else(PoisonError::into_inner).push(error.clone()),
            _ => {}
        }
    }

    /// Takes the value once resolved. Returns `None` while it is pending and after it was taken.
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
    /// Whether the consumer dropped its pending value. Work not yet started can then be skipped.
    pub fn is_cancelled(&self) -> bool {
        Arc::strong_count(&self.0) == 1
    }

    /// Resolves the pending value with `result` and wakes its waiter.
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

/// The wakers of everything watching one thing, keyed by watcher id. Each watcher keeps only its
/// latest waker. Waking wakes every watcher.
#[derive(Default)]
pub(crate) struct Watchers(Mutex<Vec<(u64, Waker)>>);

impl Watchers {
    /// Registers `waker` for watcher `id`, replacing its previous one.
    #[cfg(feature = "gpu")]
    pub(crate) fn watch(&self, id: u64, waker: &Waker) {
        let mut watchers = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match watchers.iter_mut().find(|(watcher, _)| *watcher == id) {
            Some((_, kept)) => kept.clone_from(waker),
            None => watchers.push((id, waker.clone())),
        }
    }

    /// Removes watcher `id`'s waker. Returns how many watchers are left.
    #[cfg(feature = "gpu")]
    pub(crate) fn unwatch(&self, id: u64) -> usize {
        let mut watchers = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        watchers.retain(|(watcher, _)| *watcher != id);
        watchers.len()
    }

    /// Wakes every watcher.
    pub(crate) fn wake_all(&self) {
        let wakers: Vec<Waker> =
            self.0.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, waker)| waker.clone()).collect();
        for waker in wakers {
            waker.wake();
        }
    }
}

/// A waker that wakes every watcher.
#[cfg(feature = "gpu")]
impl std::task::Wake for Watchers {
    fn wake(self: Arc<Self>) {
        self.wake_all();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.wake_all();
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
