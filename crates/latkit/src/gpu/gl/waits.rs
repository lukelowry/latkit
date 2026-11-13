//! Everything the driver waits on, polled by one task: fences in submission order, with the waits
//! that follow each one, and programs still linking. Fences are polled every browser task while
//! any is pending, since WebGL signals them only between tasks. Programs link in hundreds of
//! milliseconds, so they are polled every few.
//!
//! A wait makes a fence only when the GPU was given work since the newest one, and otherwise joins
//! it. Each presented frame is fenced before the page copies the canvas, so a wait after a frame
//! joins that fence. WebKit reports a fence made after a canvas copy, with no work since, as
//! unsignaled for 256 polls after the GPU finished it: about 8 seconds.

use super::device::State;
use super::pipeline::Program;
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    task::{Poll, Waker},
    time::Duration,
};
use web_sys::{WebGl2RenderingContext as Gl, WebGlSync};

/// How often programs still linking are polled.
const LINKING: Duration = Duration::from_millis(4);

/// `COMPLETION_STATUS_KHR` of `KHR_parallel_shader_compile`.
const COMPLETION_STATUS: u32 = 0x91B1;

/// A wait. It gets whether its fence signaled, rather than failed.
type Then = Box<dyn FnOnce(&Rc<State>, bool)>;

struct Fenced {
    /// `None` when no fence was needed, or none could be made.
    fence: Option<WebGlSync>,
    /// Whether the fence failed, or could not be made on a lost context.
    failed: bool,
    /// The waits made before more work was issued.
    then: Vec<Then>,
}

/// What the GPU was given since the newest fence.
#[derive(Default)]
enum Since {
    /// No work: a wait joins the newest fence, or runs on the next poll once every fence settled.
    #[default]
    Nothing,
    /// Work: a wait needs a fence of its own.
    Work,
    /// No work since the fence on the frame presented last, which nothing polls until a wait
    /// takes it.
    Presented(WebGlSync),
}

#[derive(Default)]
pub(super) struct Waits {
    fenced: RefCell<Vec<Fenced>>,
    since: RefCell<Since>,
    linking: RefCell<Vec<Weak<Program>>>,
    polling: Cell<bool>,
    /// The poller while it rests between program polls. A new fence wakes it.
    resting: RefCell<Option<Waker>>,
}

impl Waits {
    /// Runs `then` once the GPU finishes the commands issued so far.
    pub(super) fn fence(state: &Rc<State>, then: impl FnOnce(&Rc<State>, bool) + 'static) {
        let then: Then = Box::new(then);
        {
            let mut fenced = state.waits.fenced.borrow_mut();
            match state.waits.since.replace(Since::Nothing) {
                Since::Work => {
                    let fence = state.gl.fence_sync(Gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
                    state.gl.flush();
                    // A lost context makes no fence. The wait runs on the next poll, told it failed.
                    fenced.push(Fenced { failed: fence.is_none(), fence, then: vec![then] });
                }
                Since::Presented(fence) => fenced.push(Fenced { fence: Some(fence), failed: false, then: vec![then] }),
                Since::Nothing => match fenced.last_mut() {
                    Some(newest) => newest.then.push(then),
                    None => fenced.push(Fenced { fence: None, failed: false, then: vec![then] }),
                },
            }
        }
        Self::poll(state);
    }

    /// Notes work given to the GPU: the next wait needs a fence of its own.
    pub(super) fn issued(state: &State) {
        if let Since::Presented(fence) = state.waits.since.replace(Since::Work) {
            state.gl.delete_sync(Some(&fence));
        }
    }

    /// Fences the frame just blitted to the shared canvas, before the page copies it.
    pub(super) fn presented(state: &State) {
        let fence = state.gl.fence_sync(Gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
        state.gl.flush();
        if let Since::Presented(stale) = state.waits.since.replace(fence.map_or(Since::Work, Since::Presented)) {
            state.gl.delete_sync(Some(&stale));
        }
    }

    /// Polls `program` until it links, then wakes its waiters.
    pub(super) fn link(state: &Rc<State>, program: &Rc<Program>) {
        state.waits.linking.borrow_mut().push(Rc::downgrade(program));
        Self::poll(state);
    }

    /// Starts the poller unless it runs, and wakes it if it rests.
    fn poll(state: &Rc<State>) {
        if state.waits.polling.replace(true) {
            if let Some(waker) = state.waits.resting.borrow_mut().take() {
                waker.wake();
            }
            return;
        }
        let weak = Rc::downgrade(state);
        wasm_bindgen_futures::spawn_local(async move {
            let mut linked: Option<web_time::Instant> = None;
            loop {
                let Some(state) = weak.upgrade() else { return };
                // Fences and links end on a lost context. The loss is reported first, so what ended
                // with it is not mistaken for a failure of its own.
                super::noticed_loss(&state);
                state.waits.settle_fences(&state);
                if linked.is_none_or(|at| at.elapsed() >= LINKING) {
                    linked = Some(web_time::Instant::now());
                    state.waits.settle_links(&state);
                }
                // Finished links add fences, so both are read after both settle.
                let fenced = !state.waits.fenced.borrow().is_empty();
                let linking = !state.waits.linking.borrow().is_empty();
                if !fenced && !linking {
                    state.waits.polling.set(false);
                    return;
                }
                if fenced {
                    drop(state);
                    super::turn().await;
                } else {
                    rest(&state).await;
                }
            }
        });
    }

    /// Runs the waits of settled fences. The GPU finishes commands in order, so once a fence
    /// signals, every fence before it has too: polling runs from the newest fence back to the first
    /// that settled. A fence a browser reports late holds back only until a newer one signals. A
    /// fence fails only on a lost context, where every wait fails.
    fn settle_fences(&self, state: &Rc<State>) {
        let (done, failed) = {
            let mut fenced = self.fenced.borrow_mut();
            let (mut settled, mut failed) = (0, false);
            for (at, entry) in fenced.iter_mut().enumerate().rev() {
                if let Some(fence) = &entry.fence {
                    // Without the flush flag, Firefox does not promise a polled fence ever signals.
                    let status = state.gl.client_wait_sync_with_u32(fence, Gl::SYNC_FLUSH_COMMANDS_BIT, 0);
                    if status == Gl::TIMEOUT_EXPIRED {
                        continue;
                    }
                    entry.failed = !matches!(status, Gl::ALREADY_SIGNALED | Gl::CONDITION_SATISFIED);
                }
                (settled, failed) = (at + 1, entry.failed);
                break;
            }
            // Fences made by the waits below follow the ones still pending.
            (fenced.drain(..settled).collect::<Vec<_>>(), failed)
        };
        // A wait that needed no fence has none to fail: it learns of a lost context here.
        let failed = failed || (!done.is_empty() && state.gl.is_context_lost());
        for entry in done {
            if let Some(fence) = &entry.fence {
                state.gl.delete_sync(Some(fence));
            }
            let signaled = !(failed || entry.failed);
            for then in entry.then {
                then(state, signaled);
            }
        }
    }

    /// Finishes the programs that linked and wakes their waiters. Finishing looks up a program's
    /// uniforms, which the browser's GPU process answers at once: every program writes one color
    /// target, so no frame makes that process build a shader on its own thread meanwhile.
    fn settle_links(&self, state: &Rc<State>) {
        let linking = std::mem::take(&mut *self.linking.borrow_mut());
        let mut pending = Vec::with_capacity(linking.len());
        for weak in linking {
            let Some(program) = weak.upgrade() else { continue };
            // Completion reads true once linking ends, and on a lost context.
            let done = !state.parallel
                || state.gl.get_program_parameter(&program.raw, COMPLETION_STATUS).as_bool() != Some(false);
            if done {
                let _ = program.finish();
                program.wake();
            } else {
                pending.push(weak);
            }
        }
        self.linking.borrow_mut().append(&mut pending);
    }
}

/// Rests until programs are due a poll, or a new fence arrives to wake it.
async fn rest(state: &Rc<State>) {
    let mut armed = false;
    std::future::poll_fn(|context| {
        if armed {
            return Poll::Ready(());
        }
        armed = true;
        *state.waits.resting.borrow_mut() = Some(context.waker().clone());
        crate::time::wake_after(LINKING, context.waker().clone());
        Poll::Pending
    })
    .await;
    state.waits.resting.borrow_mut().take();
}
