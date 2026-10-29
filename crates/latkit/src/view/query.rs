//! Queries: every row within a radius of a point, every row in a box, and where a row lies on
//! screen.
//!
//! Each mark's probe program answers on the GPU, through the geometry the frame drew. The result is
//! read back a frame or two later and decoded against that frame. A query's results for each mark
//! follow the probe's words in the probe buffer: a hit count and capacity followed by the hits, or
//! a bit per row. Hits arrive in any order and are sorted before they are returned. A mark that
//! found more hits than it kept is queried again with space for all of them. One query runs at a
//! time. The rest wait in order, and a query nobody awaits any more is skipped.

use std::collections::VecDeque;

use rustc_hash::FxHashSet;

use super::View;
use super::event::{Hit, Trigger};
use super::probe::Drew;
use crate::derive::Working;
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::{Pending, Resolver, Row};

/// Hits kept per mark on the first try. Hits past these are counted but not kept, and the query
/// runs again with space for them.
const HITS: u32 = 1024;

/// A query for the GPU.
pub(crate) enum Ask {
    /// Every row within `radius` CSS pixels of `point`, keeping up to `room` hits of each mark.
    Hits { point: [f32; 2], radius: f32, room: u32, reply: Resolver<Vec<Hit>> },
    /// Every row in the box between two corners. The rows become the selection, with `trigger` as
    /// its cause.
    Boxed { corners: [[f32; 2]; 2], trigger: Trigger },
    /// Where a row lies on screen.
    Locate { row: Row, reply: Resolver<Option<[f32; 2]>> },
}

impl Ask {
    /// Whether nobody awaits its answer any more. A box query selects rows, so it always runs.
    fn cancelled(&self) -> bool {
        match self {
            Ask::Hits { reply, .. } => reply.is_cancelled(),
            Ask::Locate { reply, .. } => reply.is_cancelled(),
            Ask::Boxed { .. } => false,
        }
    }

    /// The frame uniform's query words for it.
    fn words(&self, marks: &[usize], view: &View) -> [f32; 4] {
        match self {
            Ask::Hits { point, radius, .. } => [point[0], point[1], *radius, 0.0],
            Ask::Boxed { corners: [a, b], .. } => [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])],
            Ask::Locate { row, .. } => {
                let index = marks.first().and_then(|&i| view.row_index(i, row)).unwrap_or(u32::MAX);
                [f32::from_bits(index), 0.0, 0.0, 0.0]
            }
        }
    }

    /// The probe program's step answering it.
    fn step(&self) -> u32 {
        match self {
            Ask::Hits { .. } => wgsl::STEP_HITS,
            Ask::Boxed { .. } => wgsl::STEP_BOXED,
            Ask::Locate { .. } => wgsl::STEP_LOCATE,
        }
    }

    /// How many hits or rows it keeps of a mark with `instances` instances and `rows` rows, and the
    /// words that takes.
    fn room(&self, instances: u32, rows: u32) -> (u32, u32) {
        match self {
            Ask::Hits { room, .. } => {
                let kept = instances.min(*room);
                (kept, 2 + kept * wgsl::HIT_WORDS)
            }
            Ask::Boxed { .. } => (rows, rows.div_ceil(32)),
            Ask::Locate { .. } => (0, 0),
        }
    }
}

/// Where a query's results for mark `mark` lie: from probe-buffer word `at`, with space for `room`
/// hits or rows.
#[derive(Clone, Copy)]
struct Found {
    mark: usize,
    at: u32,
    room: u32,
}

/// The query this frame runs: the query, where each mark's results go, and the words they take
/// after the probe's.
struct Running {
    ask: Ask,
    found: Vec<Found>,
    words: u32,
}

/// What reading a query's answer needs: the query, where each mark's results are, and what its
/// frame drew.
struct Reading {
    ask: Ask,
    found: Vec<Found>,
    drew: Drew,
}

#[derive(Default)]
pub(crate) struct Queries {
    waiting: VecDeque<Ask>,
    running: Option<Running>,
    /// The query whose answer the GPU is copying back.
    reading: Working<Reading, Readback>,
}

impl Queries {
    /// Whether a query is running, or waiting to run with someone still awaiting it.
    pub(crate) fn due(&self) -> bool {
        self.running.is_some() || self.waiting.iter().any(|ask| !ask.cancelled())
    }
}

impl View {
    /// Every row of a pickable mark within `radius` CSS pixels of `point`, nearest first, as the
    /// next frames draw them.
    pub fn pick(&mut self, point: [f32; 2], radius: f32) -> Pending<Vec<Hit>> {
        let (answer, reply) = Pending::new();
        self.queries.waiting.push_back(Ask::Hits { point, radius: radius.max(0.0), room: HITS, reply });
        self.wake();
        answer
    }

    /// Where `row` lies on screen, or its port whose reference field is `port`, in CSS pixels from
    /// the top left, as the next frames draw it. `None` when no mark draws it in view, or it has no
    /// such port. A diagram's vertices and ports resolve at once from its sheet. Only a diagram has
    /// ports.
    pub fn screen_of(&mut self, row: &Row, port: Option<&str>) -> Pending<Option<[f32; 2]>> {
        let diagram = matches!(self.scene.space, crate::Space::Diagram(_));
        if let Some(b) = self.derived.sheet.bounds(row).filter(|_| diagram) {
            let view = self.projected();
            let center = [b[0].midpoint(b[2]), b[1].midpoint(b[3])];
            let at = match port {
                None => Some(center),
                Some(port) => self
                    .port_offset(row, port, [(b[2] - b[0]) / 2.0, (b[3] - b[1]) / 2.0])
                    .map(|o| [center[0] + o[0], center[1] + o[1]]),
            };
            let screen = at.and_then(|[x, y]| view.screen(view.world([x, y, 0.0])));
            return Pending::ready(Ok(screen.map(|s| [s[0] as f32, s[1] as f32])));
        }
        if port.is_some() {
            return Pending::ready(Ok(None));
        }
        let (answer, reply) = Pending::new();
        self.queries.waiting.push_back(Ask::Locate { row: row.clone(), reply });
        self.wake();
        answer
    }

    /// Where port `port` of diagram vertex `row`, whose box is `half` units each way from its middle,
    /// sits from that middle, in units with y down. `None` if no vertex mark of its table has the
    /// port.
    fn port_offset(&self, row: &Row, port: &str, half: [f64; 2]) -> Option<[f64; 2]> {
        let (i, k) = self.marks.iter().enumerate().find_map(|(i, shown)| match &shown.mark {
            crate::Mark::Vertices(v) if v.style.data == row.data && v.style.table == row.table => {
                Some((i, v.ports.iter().position(|(reference, _)| reference.as_str() == port)?))
            }
            _ => None,
        })?;
        // A port code holds its side, then its index among the ports on that side and their count.
        let code = *self.port_codes(i).get(k)?;
        let along = f64::from(((code >> 2) & 255) + 1) / f64::from(((code >> 10) & 255) + 1) * 2.0 - 1.0;
        Some(match code & 3 {
            wgsl::SIDE_LEFT => [-half[0], along * half[1]],
            wgsl::SIDE_RIGHT => [half[0], along * half[1]],
            wgsl::SIDE_TOP => [along * half[0], -half[1]],
            _ => [along * half[0], half[1]],
        })
    }

    /// Selects every row in the box between two screen points, with `trigger` as the cause.
    pub(super) fn select_box(&mut self, corners: [[f32; 2]; 2], trigger: Trigger) {
        self.queries.waiting.push_back(Ask::Boxed { corners, trigger });
        self.wake();
    }

    /// The position of `row` among the rows mark `i` draws, if it draws it.
    pub(super) fn row_index(&self, i: usize, row: &Row) -> Option<u32> {
        let shown = self.marks.get(i)?;
        let style = shown.mark.style();
        if style.data != row.data || style.table != row.table {
            return None;
        }
        let index = self.snapshot(&style.data)?.table(&style.table)?.row(row.id.as_ref())?;
        shown.item_of(shown.held_row(index as u32)?).filter(|&item| item < shown.rows)
    }

    /// Starts the next query this frame if none is in progress, skipping those nobody awaits.
    /// Reserves space for its results after the probe's words, and returns its query words and
    /// whether it reads depth.
    pub(super) fn next_query(&mut self) -> Option<([f32; 4], bool)> {
        if self.queries.running.is_some() || self.queries.reading.busy() {
            return None;
        }
        let ask = std::iter::from_fn(|| self.queries.waiting.pop_front()).find(|ask| !ask.cancelled())?;
        let marks: Vec<usize> = match &ask {
            Ask::Locate { row, .. } => (0..self.marks.len())
                .filter(|&i| self.marks[i].drawable() && self.row_index(i, row).is_some())
                .take(1)
                .collect(),
            _ => (0..self.marks.len()).filter(|&i| self.marks[i].probed()).collect(),
        };
        if marks.is_empty()
            && let Ask::Locate { reply, .. } = ask
        {
            // No mark draws the row: nothing to ask the GPU.
            reply.resolve(Ok(None));
            return self.next_query();
        }
        let words = ask.words(&marks, self);
        let mut at = wgsl::PROBE_WORDS;
        let mut found = Vec::with_capacity(marks.len());
        for i in marks {
            let (room, taken) = ask.room(self.marks[i].live_instances(), self.marks[i].live());
            self.marks[i].query = at;
            found.push(Found { mark: i, at, room });
            at += taken;
        }
        let device = &self.gpu.0.device;
        self.resources.as_mut().expect("created").fit_probe(device, at);
        let depth = matches!(ask, Ask::Hits { .. });
        self.queries.running = Some(Running { ask, found, words: at - wgsl::PROBE_WORDS });
        Some((words, depth))
    }

    /// Records the running query's step over every mark it covers, and the copy of its results.
    pub(super) fn run_query(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let Some(Running { ask, found, words }) = self.queries.running.take() else { return };
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let probe = self.resources.as_ref().expect("created before queries").probe().clone();
        let start = u64::from(wgsl::PROBE_WORDS) * 4;
        // Results start empty: for hits, a zero count and each mark's capacity; for a box, no rows.
        match &ask {
            Ask::Hits { .. } => {
                for f in &found {
                    queue.write_buffer(&probe, u64::from(f.at) * 4, bytemuck::cast_slice(&[0, f.room]));
                }
            }
            Ask::Boxed { .. } if words > 0 => encoder.clear_buffer(&probe, start, Some(u64::from(words) * 4)),
            Ask::Boxed { .. } | Ask::Locate { .. } => {}
        }
        let marks: Vec<usize> = found.iter().map(|f| f.mark).collect();
        self.probe_pass(encoder, inner, "latkit query", &[(ask.step(), &marks)]);
        let (at, bytes) = match &ask {
            Ask::Locate { .. } => (u64::from(wgsl::PROBE_LOCATE_X) * 4, 16),
            _ => (start, u64::from(words.max(1)) * 4),
        };
        let readback = Readback::new(&inner.readbacks, device, encoder, &probe, at, bytes, &self.waker);
        let drew = self.drew();
        self.queries.reading.start(0, readback, Reading { ask, found, drew });
    }

    /// Answers a query whose readback has arrived.
    pub(super) fn settle_query(&mut self) {
        let Some((_, Reading { ask, found, drew }, bytes)) = self.queries.reading.landed() else { return };
        let words = match bytes {
            Ok(bytes) => crate::wire::words(&bytes),
            Err(error) => {
                match ask {
                    Ask::Hits { reply, .. } => reply.resolve(Err(error)),
                    Ask::Locate { reply, .. } => reply.resolve(Err(error)),
                    Ask::Boxed { .. } => {}
                }
                return;
            }
        };
        match ask {
            Ask::Hits { point, radius, room, reply } => {
                // If a mark found more hits than it kept, run again with space for all of them.
                let most = found.iter().map(|f| words_at(&words, f.at, 1).first().copied().unwrap_or(0)).max();
                match most.filter(|&most| most > room) {
                    Some(room) => self.queries.waiting.push_front(Ask::Hits { point, radius, room, reply }),
                    None => reply.resolve(Ok(hits(&found, &words, &drew))),
                }
            }
            Ask::Boxed { trigger, .. } => {
                let mut rows = Vec::new();
                let mut seen = FxHashSet::default();
                for f in found.iter().filter(|f| drew.selects(f.mark)) {
                    for (k, &bits) in words_at(&words, f.at, f.room.div_ceil(32)).iter().enumerate() {
                        let mut bits = bits;
                        while bits != 0 {
                            let index = k as u32 * 32 + bits.trailing_zeros();
                            bits &= bits - 1;
                            if let Some((row, _)) = drew.row(f.mark, index)
                                && seen.insert(row.clone())
                            {
                                rows.push(row);
                            }
                        }
                    }
                }
                self.reselect(rows, Some(trigger));
            }
            Ask::Locate { reply, .. } => {
                let shown = words.get(2).is_some_and(|&w| w != 0);
                let point = shown.then(|| [f32::from_bits(words[0]), f32::from_bits(words[1])]);
                reply.resolve(Ok(point));
            }
        }
        self.wake();
    }
}

/// The hits in `words` for `found`, decoded against `drew`, the frame they came from.
fn hits(found: &[Found], words: &[u32], drew: &Drew) -> Vec<Hit> {
    // Nearest first. Among equals, the mark drawn last comes first, and a port before its marker.
    // Then by row and position, so the order never depends on which hit arrived first. Each row
    // appears once, at its nearest hit.
    let mut kept: Vec<(usize, &[u32; wgsl::HIT_WORDS as usize])> = found
        .iter()
        .flat_map(|f| {
            let count = words_at(words, f.at, 1).first().map_or(0, |&n| n.min(f.room));
            let entries = words_at(words, f.at + 2, count * wgsl::HIT_WORDS);
            entries.as_chunks().0.iter().map(move |entry| (f.mark, entry))
        })
        .collect();
    // Sort by the minor keys first: each sort is stable, so the last one keeps their order in ties.
    let key = |high: u32, low: u32| u128::from(crate::order::pair(high, low));
    crate::order::by_wide_key(&mut kept, |&(_, entry)| key(entry[3], entry[4]) << 32 | u128::from(entry[5]));
    crate::order::by_wide_key(&mut kept, |&(i, entry)| key(entry[1], !(i as u32)) << 64 | key(!entry[2], entry[0]));
    let mut seen = FxHashSet::default();
    let mut hits = Vec::new();
    for (i, entry) in kept {
        if !seen.insert((i, entry[0])) {
            continue;
        }
        let point = [f32::from_bits(entry[3]), f32::from_bits(entry[4])];
        hits.extend(drew.hit(i, entry[0], point, f32::from_bits(entry[5]), entry[1], entry[2]));
    }
    hits
}

/// `len` words from probe-buffer word `at`, in a query answer read back from past the probe's
/// words.
fn words_at(words: &[u32], at: u32, len: u32) -> &[u32] {
    let start = (at - wgsl::PROBE_WORDS) as usize;
    words.get(start..start + len as usize).unwrap_or(&[])
}
