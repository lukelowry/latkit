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

#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub(crate) use live::Live;

/// Live playheads, which play along the end of a span as data arrives.
#[cfg(any(test, all(feature = "web", target_arch = "wasm32")))]
mod live {
    /// Weight of each arrival in [`Live`]'s averages.
    const AVERAGED: f64 = 0.2;
    /// How many times the time between arrivals a [`Live`] playhead trails the end of its span, and
    /// the least it trails, in seconds.
    const TRAILED: f64 = 2.5;
    const LEAST_TRAILED: f64 = 0.05;
    /// How many trails behind a [`Live`] playhead falls before it jumps to one trail behind, as
    /// after a hidden page comes back.
    const BEHIND: f64 = 4.0;
    /// Seconds over which a [`Live`] playhead eases to a stop at the end of its span when no more
    /// arrives.
    const EASED: f64 = 0.15;

    /// How a live playhead plays along the end of a span that grows as data arrives. It trails the
    /// end by a little more than the time between arrivals, at the rate the end moves, both averaged
    /// over recent arrivals, so data that arrives in uneven chunks plays at an even pace instead of
    /// in jumps. It speeds up a little when it falls behind and slows when it gains, and eases to a
    /// stop at the end when no more arrives.
    #[derive(Clone, Copy, Debug, Default)]
    pub(crate) struct Live {
        /// The span's end when it last grew, and the time it grew, in seconds.
        end: Option<(f64, f64)>,
        /// Axis units per second the end moves, and seconds between arrivals, averaged.
        rate: f64,
        every: f64,
    }

    impl Live {
        /// Axis units per second the end of the span moves, averaged over recent arrivals.
        pub(crate) fn rate(&self) -> f64 {
            self.rate
        }

        /// Notes that the span ends at `end` at time `now`, in seconds. An end that moved back, as
        /// a new recording's, starts the averages again.
        pub(crate) fn heard(&mut self, end: f64, now: f64) {
            match self.end {
                Some((last, at)) if end > last && now > at => {
                    let (every, rate) = (now - at, (end - last) / (now - at));
                    if self.every == 0.0 {
                        (self.every, self.rate) = (every, rate);
                    } else {
                        self.every += AVERAGED * (every - self.every);
                        self.rate += AVERAGED * (rate - self.rate);
                    }
                    self.end = Some((end, now));
                }
                Some((last, _)) if end >= last => {}
                _ => *self = Live { end: Some((end, now)), ..Live::default() },
            }
        }

        /// Where a playhead at `at` moves `step` seconds later, trailing `end`. It holds until two
        /// arrivals tell the rate, and never passes `end`.
        pub(crate) fn next(&self, at: f64, end: f64, step: f64) -> f64 {
            if self.rate <= 0.0 {
                return at.min(end);
            }
            let trail = self.rate * (TRAILED * self.every).max(LEAST_TRAILED);
            let gap = end - at;
            if gap > BEHIND * trail {
                return end - trail;
            }
            let pace = (1.0 + (gap - trail) / (3.0 * trail)).clamp(0.0, 2.0);
            let speed = (self.rate * pace).min(gap.max(0.0) / EASED);
            let moved = (at + speed * step).min(end);
            // Within rounding of the end, it is there, so it stops.
            if end - moved <= 1e-9 * end.abs().max(1.0) { end } else { moved }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::Live;

        #[test]
        fn a_live_playhead_plays_an_uneven_feed_at_an_even_pace() {
            // Frames at 60 per second. A recording grows at 0.8 axis units a second, arriving every
            // 60 to 140 ms, then stops.
            let (frame, rate) = (1.0 / 60.0, 0.8);
            let (mut live, mut at, mut end, mut next) = (Live::default(), 0.0_f64, 0.0_f64, 0.0_f64);
            let mut steps = Vec::new();
            for f in 0..1200 {
                let now = f64::from(f) * frame;
                if now >= next && now < 15.0 {
                    end = rate * now;
                    next = now + 0.06 + 0.08 * f64::from((f * 7919) % 11) / 10.0;
                }
                live.heard(end, now);
                let moved = live.next(at, end, frame);
                assert!(moved <= end && moved >= at, "it never passes the end nor goes back");
                steps.push(moved - at);
                at = moved;
            }
            // Once the rate is known, every frame moves it, at nearly the same pace: no stops, no
            // jumps.
            let playing = &steps[120..900];
            let (least, most) = playing.iter().fold((f64::MAX, 0.0_f64), |(l, m), &s| (l.min(s), m.max(s)));
            assert!(least > 0.0, "it never stops while data arrives");
            assert!(most / least < 1.6, "its pace stays even: steps from {least} to {most}");
            assert!((live.rate() - rate).abs() < 0.08, "the rate it plays at is the feed's: {}", live.rate());
            // Once the feed stops, it eases to the end.
            assert_eq!(at, end, "it reaches the end");
        }
    }
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

/// The longest a poll of the browser's GPU waits after one that found nothing.
#[cfg(target_arch = "wasm32")]
const LONGEST_BACKOFF: Duration = Duration::from_millis(4);

/// How long a loop polling the browser's GPU polls every task after it starts waiting: a frame of
/// light work finishes within it.
#[cfg(target_arch = "wasm32")]
const PROMPT: Duration = Duration::from_millis(3);

/// How a loop polls what the browser's GPU process answers between tasks: WebGL fences, readbacks,
/// and work done. For [`PROMPT`] after it starts waiting, it polls every task, so it sees a light
/// frame's answer at once. Then each poll waits twice as long as the last, from a millisecond up
/// to [`LONGEST_BACKOFF`], so a long wait, as on a GPU busy with heavy frames, takes a few hundred
/// polls a second where a poll every task would run tens of thousands and keep the page busy.
#[cfg(target_arch = "wasm32")]
#[derive(Default)]
pub(crate) struct Backoff {
    waiting: Option<Instant>,
    sleeps: u32,
}

#[cfg(target_arch = "wasm32")]
impl Backoff {
    /// Waits before the next poll, after one that found nothing.
    pub(crate) async fn missed(&mut self) {
        if self.waiting.get_or_insert_with(Instant::now).elapsed() < PROMPT {
            next_task().await;
            return;
        }
        let sleeps = self.sleeps;
        self.sleeps = self.sleeps.saturating_add(1);
        sleep(Duration::from_millis(1 << sleeps.min(8)).min(LONGEST_BACKOFF)).await;
    }

    /// Notes a poll that found what it waited for: the next wait starts polling every task again.
    pub(crate) fn found(&mut self) {
        (self.waiting, self.sleeps) = (None, 0);
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
