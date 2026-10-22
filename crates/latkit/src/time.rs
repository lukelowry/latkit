//! Bounded waits: work the views wait on wakes whatever awaits it, and a timer wakes it anyway once a
//! wait has gone on long enough, so no wait outlasts its deadline. Natively one thread keeps every
//! timer; in a browser the page's own timers do.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use web_time::Instant;

/// Wakes `waker` once `after` has passed.
pub(crate) fn wake_after(after: Duration, waker: Waker) {
    platform::wake_after(after, waker);
}

/// What wakes a task waiting on views: their work landing, their readbacks mapping. Waking it marks
/// it woken until a wait takes that.
#[derive(Default)]
pub(crate) struct Notify {
    woken: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl Notify {
    /// Waits until woken, or until `longest` has passed, whichever is first.
    pub(crate) fn wait(self: &Arc<Self>, longest: Duration) -> Wait {
        Wait { notify: self.clone(), until: Instant::now() + longest, armed: false }
    }
}

impl Wake for Notify {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.woken.store(true, Ordering::Release);
        if let Some(waker) = self.waker.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            waker.wake_by_ref();
        }
    }
}

/// A wait on a [`Notify`], bounded in time.
pub(crate) struct Wait {
    notify: Arc<Notify>,
    until: Instant,
    armed: bool,
}

impl Future for Wait {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        // The waker goes in before the flag is read, so a wake between the two is never lost.
        *self.notify.waker.lock().unwrap_or_else(PoisonError::into_inner) = Some(context.waker().clone());
        if self.notify.woken.swap(false, Ordering::AcqRel) {
            return Poll::Ready(());
        }
        let now = Instant::now();
        if now >= self.until {
            return Poll::Ready(());
        }
        if !self.armed {
            self.armed = true;
            wake_after(self.until - now, context.waker().clone());
        }
        Poll::Pending
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod platform {
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
    use std::sync::{Mutex, OnceLock, PoisonError};
    use std::task::Waker;
    use std::time::{Duration, Instant};

    /// The one timer thread: it wakes each waker given it at its time.
    fn timers() -> &'static Mutex<Sender<(Instant, Waker)>> {
        static TIMERS: OnceLock<Mutex<Sender<(Instant, Waker)>>> = OnceLock::new();
        TIMERS.get_or_init(|| {
            let (sender, receiver) = channel();
            std::thread::Builder::new().name("latkit timers".into()).spawn(move || run(&receiver)).expect("a thread");
            Mutex::new(sender)
        })
    }

    fn run(receiver: &Receiver<(Instant, Waker)>) {
        let mut due: Vec<(Instant, Waker)> = Vec::new();
        loop {
            let now = Instant::now();
            due.retain(|(at, waker)| {
                let waiting = *at > now;
                if !waiting {
                    waker.wake_by_ref();
                }
                waiting
            });
            let next = due.iter().map(|(at, _)| *at).min();
            let received = match next {
                Some(at) => receiver.recv_timeout(at.saturating_duration_since(now)),
                None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match received {
                Ok(timer) => due.push(timer),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    pub(super) fn wake_after(after: Duration, waker: Waker) {
        let at = Instant::now() + after;
        let sender = timers().lock().unwrap_or_else(PoisonError::into_inner);
        if sender.send((at, waker.clone())).is_err() {
            waker.wake();
        }
    }
}

#[cfg(all(target_arch = "wasm32", feature = "web"))]
mod platform {
    use std::task::Waker;
    use std::time::Duration;

    use wasm_bindgen::JsCast;
    use wasm_bindgen::closure::Closure;

    /// Wakes `waker` from the global scope's `setTimeout`, in a page or a worker alike.
    pub(super) fn wake_after(after: Duration, waker: Waker) {
        let wake = Closure::once_into_js(move || waker.wake());
        let global = js_sys::global();
        let set = js_sys::Reflect::get(&global, &"setTimeout".into())
            .ok()
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok());
        let ms = after.as_secs_f64() * 1000.0;
        if let Some(set) = set {
            let _ = set.call2(&global, &wake, &ms.into());
        }
    }
}

#[cfg(all(target_arch = "wasm32", not(feature = "web")))]
mod platform {
    use std::task::Waker;
    use std::time::Duration;

    /// Without the browser's timers a wait is woken at once, and is polled again.
    pub(super) fn wake_after(_: Duration, waker: Waker) {
        waker.wake();
    }
}
