//! A first-in, first-out queue of jobs waiting for a worker. A job reaches a worker only when one
//! is free, so a job whose result is no longer awaited, such as a pyramid superseded by newer data,
//! is dropped before it uses a worker.

use std::collections::VecDeque;

use super::Job;
use crate::Resolver;

#[derive(Default)]
pub(crate) struct Queue {
    waiting: VecDeque<(Job, Resolver<Vec<u8>>)>,
    running: usize,
}

impl Queue {
    /// Queues `job`; `resolver` receives its result.
    pub(crate) fn push(&mut self, job: Job, resolver: Resolver<Vec<u8>>) {
        self.waiting.push_back((job, resolver));
    }

    /// The next job for a worker, if fewer than `workers` jobs are running. Drops cancelled jobs.
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

    /// Records that a worker finished its job.
    pub(crate) fn done(&mut self) {
        self.running = self.running.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Pending;

    #[test]
    fn a_job_cancelled_while_queued_never_reaches_a_worker() {
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
        let (job, _) = queue.next(1).expect("the worker is free again");
        assert_eq!(job.into_bytes(), [3], "the cancelled job was skipped");
        drop((kept, later));
    }
}
