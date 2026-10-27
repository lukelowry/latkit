//! Cancellable promises of latkit results. Cancelling drops the work's future, so pending work that
//! nothing else needs is skipped: a view's query leaves its queue, and a host job that has not
//! started never runs.

use futures_util::future::{AbortHandle, Abortable};
use wasm_bindgen::prelude::*;

use crate::Error;

/// A promise of a latkit result, and a way to cancel it.
#[wasm_bindgen]
pub struct Task {
    promise: js_sys::Promise,
    abort: AbortHandle,
}

#[wasm_bindgen]
impl Task {
    /// The result. Rejects with a `cancelled` error once cancelled.
    #[wasm_bindgen(getter)]
    pub fn promise(&self) -> js_sys::Promise {
        self.promise.clone()
    }

    /// Cancels the work, dropping what it waits on.
    pub fn cancel(&self) {
        self.abort.abort();
    }
}

/// Wraps `future` in a task whose promise rejects with its errors as latkit errors.
pub(crate) fn task<T: Into<JsValue>>(future: impl Future<Output = latkit::Result<T>> + 'static) -> Task {
    let (abort, registration) = AbortHandle::new_pair();
    let promise = wasm_bindgen_futures::future_to_promise(async move {
        let result = Abortable::new(future, registration).await.unwrap_or(Err(latkit::Error::Cancelled));
        result.map(Into::into).map_err(|e| JsValue::from(Error::from(e)))
    });
    Task { promise, abort }
}
