//! Everything the driver waits on, polled by one task: fences in submission order, with the work
//! that follows each one, and programs still linking. Fences are polled every browser task while
//! any is pending, since WebGL signals them only between tasks. Programs link in hundreds of
//! milliseconds, so they are polled every few.

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

/// Work that follows a fence. It gets whether the fence signaled, rather than failed.
type Then = Box<dyn FnOnce(&Rc<State>, bool)>;

struct Fenced {
    fence: Option<WebGlSync>,
    /// Whether the fence failed, or could not be made on a lost context.
    failed: bool,
    then: Then,
}

#[derive(Default)]
pub(super) struct Waits {
    fenced: RefCell<Vec<Fenced>>,
    linking: RefCell<Vec<Weak<Program>>>,
    polling: Cell<bool>,
    /// The poller while it rests between program polls. A new fence wakes it.
    resting: RefCell<Option<Waker>>,
}

impl Waits {
    /// Runs `then` once the GPU finishes the commands issued so far.
    pub(super) fn fence(state: &Rc<State>, then: impl FnOnce(&Rc<State>, bool) + 'static) {
        let fence = state.gl.fence_sync(Gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
        state.gl.flush();
        // A lost context makes no fence. The work runs on the next poll, told the fence failed.
        let failed = fence.is_none();
        state.waits.fenced.borrow_mut().push(Fenced { fence, failed, then: Box::new(then) });
        Self::poll(state);
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

    /// Runs the work of signaled fences. Fences signal in order, so polling stops at the first that
    /// has not.
    fn settle_fences(&self, state: &Rc<State>) {
        let fenced = std::mem::take(&mut *self.fenced.borrow_mut());
        let (mut pending, mut done) = (Vec::new(), Vec::new());
        for mut entry in fenced {
            if pending.is_empty()
                && let Some(fence) = entry.fence.take()
            {
                let status = state.gl.client_wait_sync_with_u32(&fence, 0, 0);
                if status == Gl::TIMEOUT_EXPIRED {
                    entry.fence = Some(fence);
                } else {
                    entry.failed = !matches!(status, Gl::ALREADY_SIGNALED | Gl::CONDITION_SATISFIED);
                    state.gl.delete_sync(Some(&fence));
                }
            }
            if entry.fence.is_some() { pending.push(entry) } else { done.push(entry) }
        }
        // Fences made by the work below follow the ones still pending.
        *self.fenced.borrow_mut() = pending;
        for entry in done {
            (entry.then)(state, !entry.failed);
        }
    }

    /// Finishes the programs that linked and wakes their waiters. Finishing looks up a program's
    /// uniforms, which waits for the browser's GPU process, and that process is busy for up to
    /// seconds while a frame first draws with new pipelines. So the lookup follows a fence: before any
    /// frame it runs at once, and after one it waits for the GPU to finish it.
    fn settle_links(&self, state: &Rc<State>) {
        let linking = std::mem::take(&mut *self.linking.borrow_mut());
        let mut pending = Vec::with_capacity(linking.len());
        for weak in linking {
            let Some(program) = weak.upgrade() else { continue };
            // Completion reads true once linking ends, and on a lost context.
            let done = !state.parallel
                || state.gl.get_program_parameter(&program.raw, COMPLETION_STATUS).as_bool() != Some(false);
            if done {
                Self::fence(state, move |_, _| {
                    let _ = program.finish();
                    program.wake();
                });
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
