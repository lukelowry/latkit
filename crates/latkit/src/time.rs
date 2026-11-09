//! Bounded waits. Views' work wakes the task waiting on it, and a timer also wakes the task at its
//! deadline, so no wait outlasts its deadline. Native builds run every timer on one thread. In a
//! browser, the global scope's `setTimeout` runs them.

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

/// Waits until `after` has passed.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn sleep(after: Duration) {
    let mut armed = false;
    std::future::poll_fn(|context| {
        if armed {
            return Poll::Ready(());
        }
        armed = true;
        wake_after(after, context.waker().clone());
        Poll::Pending
    })
    .await;
}

/// Wakes a task waiting on views when their work arrives or their readbacks map. A wake sets a flag
/// that the next wait clears.
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
        // Store the waker before reading the flag, so a wake in between is never lost.
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

    /// The channel to the single timer thread, which wakes each waker at its due time.
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

#[cfg(target_arch = "wasm32")]
mod platform {
    use std::task::Waker;
    use std::time::Duration;

    use wasm_bindgen::JsCast;
    use wasm_bindgen::closure::Closure;

    /// Wakes `waker` with the global scope's `setTimeout`, which works in a page or a worker.
    pub(super) fn wake_after(after: Duration, waker: Waker) {
        let wake = Closure::once_into_js(move || waker.wake());
        let global = js_sys::global();
        let set = js_sys::Reflect::get(&global, &"setTimeout".into())
            .ok()
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok());
        // setTimeout truncates fractional milliseconds. Rounding down can wake a Wait
        // before its deadline, leaving an armed future with no timer to wake it again.
        let ms = (after.as_secs_f64() * 1000.0).ceil();
        if let Some(set) = set {
            let _ = set.call2(&global, &wake, &ms.into());
        }
    }
}

/// Yields to a browser task, allowing WebGL fences to advance without the nested-timer
/// four-millisecond clamp. One shared message channel serves every outstanding GPU wait.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn next_task() {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use wasm_bindgen::{JsCast, closure::Closure};
    #[derive(Default)]
    struct Waiting {
        generation: Cell<u64>,
        wakers: RefCell<Vec<Waker>>,
    }
    struct Tasks {
        channel: web_sys::MessageChannel,
        waiting: Rc<Waiting>,
        _receive: Closure<dyn FnMut(web_sys::MessageEvent)>,
    }
    impl Tasks {
        fn new() -> Self {
            let channel = web_sys::MessageChannel::new().expect("browser message channels");
            let waiting = Rc::<Waiting>::default();
            let arrivals = waiting.clone();
            let receive = Closure::new(move |_: web_sys::MessageEvent| {
                arrivals.generation.set(arrivals.generation.get().wrapping_add(1));
                let mut ready = std::mem::take(&mut *arrivals.wakers.borrow_mut());
                for waker in ready.drain(..) {
                    waker.wake();
                }
                // Wake outside the borrow, then retain capacity when no reentrant executor
                // has queued another wait. Steady polling allocates no per-turn resolvers.
                let mut pending = arrivals.wakers.borrow_mut();
                if pending.is_empty() && pending.capacity() < ready.capacity() {
                    *pending = ready;
                }
            });
            channel.port1().set_onmessage(Some(receive.as_ref().unchecked_ref()));
            Self { channel, waiting, _receive: receive }
        }
    }
    thread_local! { static TASKS: Tasks = Tasks::new(); }
    let generation = TASKS.with(|tasks| tasks.waiting.generation.get());
    std::future::poll_fn(|cx| {
        TASKS.with(|tasks| {
            if tasks.waiting.generation.get() != generation {
                return Poll::Ready(());
            }
            let mut pending = tasks.waiting.wakers.borrow_mut();
            if !pending.iter().any(|waker| waker.will_wake(cx.waker())) {
                let first = pending.is_empty();
                pending.push(cx.waker().clone());
                if first {
                    tasks.channel.port2().post_message(&wasm_bindgen::JsValue::NULL).expect("live task channel");
                }
            }
            Poll::Pending
        })
    })
    .await;
}
