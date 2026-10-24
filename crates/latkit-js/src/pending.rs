//! What the page waits for: a promise of what latkit works out, which the page may stop waiting for.
//! Cancelling drops the work's future, so what it waited on and nothing else wants is skipped: a
//! view's query drops out of its queue, a host's job that has not begun never runs.

use futures_util::future::{AbortHandle, Abortable};
use wasm_bindgen::prelude::*;

use crate::Error;

/// A promise of what latkit works out, and how to stop waiting for it.
#[wasm_bindgen]
pub struct Task {
    promise: js_sys::Promise,
    abort: AbortHandle,
}

#[wasm_bindgen]
impl Task {
    /// What it works out: rejected with a `cancelled` error once cancelled.
    #[wasm_bindgen(getter)]
    pub fn promise(&self) -> js_sys::Promise {
        self.promise.clone()
    }

    /// Stops the work, dropping what it waits on.
    pub fn cancel(&self) {
        self.abort.abort();
    }
}

/// The task of `future`, its error thrown as latkit's.
pub(crate) fn task<T: Into<JsValue>>(future: impl Future<Output = latkit::Result<T>> + 'static) -> Task {
    let (abort, registration) = AbortHandle::new_pair();
    let promise = wasm_bindgen_futures::future_to_promise(async move {
        let result = Abortable::new(future, registration).await.unwrap_or(Err(latkit::Error::Cancelled));
        result.map(Into::into).map_err(|e| JsValue::from(Error::from(e)))
    });
    Task { promise, abort }
}
