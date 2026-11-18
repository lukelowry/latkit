//! Retries. A fetch that failed is an attempt, not a state: what it fetched, a piece, a base, or a
//! source's index or directory, is fetched again on its own. That happens a second after the first
//! failure, then twice as long after each one, at most a minute, so a source that comes back is
//! found without the page asking, and one that stays down costs little. A refresh fetches it again
//! at once. A fetch the application cancelled is no failure: what it fetched is fetched again when
//! next wanted, and nothing is reported.

use std::task::Waker;
use std::time::Duration;

use web_time::Instant;

/// The wait after the first failure. It doubles after each further failure, up to [`LONGEST`].
const FIRST: Duration = Duration::from_secs(1);
const LONGEST: Duration = Duration::from_secs(60);

/// When a fetch that failed runs again.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Retry {
    at: Instant,
    failures: u32,
}

impl Retry {
    /// The retry after a failure that follows `last`, the retry of the failure before it if any.
    /// `waker` wakes once it is due, so the views drawing what failed update and fetch it again.
    pub(crate) fn after(last: Option<Retry>, waker: &Waker) -> Retry {
        let failures = last.map_or(1, |last| last.failures.saturating_add(1));
        let wait = FIRST.saturating_mul(1 << (failures - 1).min(6)).min(LONGEST);
        crate::time::wake_after(wait, waker.clone());
        Retry { at: Instant::now() + wait, failures }
    }

    /// Whether it is time to fetch again.
    pub(crate) fn due(self) -> bool {
        Instant::now() >= self.at
    }
}
