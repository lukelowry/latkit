//! Jobs waiting for a worker, in the order asked. A job goes to a worker only as one frees, so one
//! whose answer nothing waits for any more, as a pyramid superseded by newer data, is dropped before
//! it costs a worker anything.

use std::collections::VecDeque;

use super::Job;
use crate::Resolver;

#[derive(Default)]
pub(crate) struct Queue {
    waiting: VecDeque<(Job, Resolver<Vec<u8>>)>,
    running: usize,
}

impl Queue {
    /// Queues `job`, whose answer `resolver` gives.
    pub(crate) fn push(&mut self, job: Job, resolver: Resolver<Vec<u8>>) {
        self.waiting.push_back((job, resolver));
    }

    /// The next job for a worker while fewer than `workers` run, dropping those nothing waits for.
    pub(crate) fn next(&mut self, workers: usize) -> Option<(Job, Resolver<Vec<u8>>)> {
        while let Some((job, resolver)) = self.waiting.pop_front() {
            if resolver.is_cancelled() {
                continue;
            }
            if self.running >= workers {
                self.waiting.push_front((job, resolver));
                return None;
            }
            self.running += 1;
            return Some((job, resolver));
        }
        None
    }

    /// A worker finished its job.
    pub(crate) fn done(&mut self) {
        self.running = self.running.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Pending;

    #[test]
    fn a_job_dropped_before_a_worker_frees_never_reaches_one() {
        let mut queue = Queue::default();
        let (kept, first) = Pending::<Vec<u8>>::new();
        let (dropped, second) = Pending::<Vec<u8>>::new();
        let (later, third) = Pending::<Vec<u8>>::new();
        queue.push(Job::from_bytes(vec![1]), first);
        queue.push(Job::from_bytes(vec![2]), second);
        queue.push(Job::from_bytes(vec![3]), third);
        let (job, _) = queue.next(1).expect("a worker is free");
        assert_eq!(job.into_bytes(), [1]);
        assert!(queue.next(1).is_none(), "the one worker is busy");
        drop(dropped);
        queue.done();
        let (job, _) = queue.next(1).expect("the worker freed");
        assert_eq!(job.into_bytes(), [3], "the job nothing waits for never reached it");
        drop((kept, later));
    }
}
