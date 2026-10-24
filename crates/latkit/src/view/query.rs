//! Queries: every row within reach of a point, every row in a box, and where a row lies on screen,
//! answered on the GPU by each mark's probe program through the geometry the frame drew, and read back
//! a frame or two later, then decoded against what that frame drew. What a query finds of each mark
//! follows the probe's words: the hits it keeps, after how many it found and how many it keeps, or a
//! bit per row. Hits land in any order; they are told in one, and a mark that found more than it kept
//! asks again with room for them all. One query runs at a time; the rest wait their turn, and one
//! nobody waits for any more is passed over.

use std::collections::VecDeque;

use rustc_hash::FxHashSet;

use super::View;
use super::event::{Hit, Trigger};
use super::probe::Drew;
use super::resources::step;
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::{Pending, Resolver, Row};

/// Hits a mark keeps at first: past them, a query counts hits but keeps none, and asks again.
const HITS: u32 = 1024;

/// A question for the GPU.
pub(crate) enum Ask {
    /// Every row within `radius` CSS pixels of `point`, keeping up to `room` hits of each mark.
    Hits { point: [f32; 2], radius: f32, room: u32, reply: Resolver<Vec<Hit>> },
    /// Every row in the box between two corners; they become the selection, as `trigger` chose.
    Boxed { corners: [[f32; 2]; 2], trigger: Trigger },
    /// Where a row lies.
    Locate { row: Row, reply: Resolver<Option<[f32; 2]>> },
}

impl Ask {
    /// Whether nobody waits for its answer any more: a box selects, so it always runs.
    fn cancelled(&self) -> bool {
        match self {
            Ask::Hits { reply, .. } => reply.is_cancelled(),
            Ask::Locate { reply, .. } => reply.is_cancelled(),
            Ask::Boxed { .. } => false,
        }
    }

    /// The frame's query words for it.
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

    /// What it keeps of a mark of `instances` instances and `rows` rows, hits or rows, and the words
    /// that takes.
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

/// What a query finds of mark `mark`: from word `at` of the probe's, `room` hits or rows.
#[derive(Clone, Copy)]
struct Found {
    mark: usize,
    at: u32,
    room: u32,
}

/// A query this frame runs: what it asks, what it finds of each mark it asks, and the words that
/// takes past the probe's.
struct Running {
    ask: Ask,
    found: Vec<Found>,
    words: u32,
}

/// A query whose answer the GPU is copying back, and what its frame drew.
struct Reading {
    ask: Ask,
    found: Vec<Found>,
    readback: Readback,
    drew: Drew,
}

#[derive(Default)]
pub(crate) struct Queries {
    waiting: VecDeque<Ask>,
    running: Option<Running>,
    reading: Option<Reading>,
}

impl Queries {
    /// Whether a query waits to run that someone still waits for.
    pub(crate) fn due(&self) -> bool {
        self.running.is_some() || self.waiting.iter().any(|ask| !ask.cancelled())
    }
}

impl View {
    /// Every row of a mark that picks within `radius` CSS pixels of `point`, nearest first, as the
    /// next frames draw them.
    pub fn pick(&mut self, point: [f32; 2], radius: f32) -> Pending<Vec<Hit>> {
        let (answer, reply) = Pending::new();
        self.queries.waiting.push_back(Ask::Hits { point, radius: radius.max(0.0), room: HITS, reply });
        self.wake();
        answer
    }

    /// Where `row` lies on screen, CSS pixels from the top left, as the next frames draw it; `None`
    /// when no mark draws it in view. A diagram's vertices answer at once from its sheet.
    pub fn screen_of(&mut self, row: &Row) -> Pending<Option<[f32; 2]>> {
        let diagram = matches!(self.scene.space, crate::Space::Diagram(_));
        if let Some(b) = self.derived.sheet.bounds(row).filter(|_| diagram) {
            let view = self.projected();
            let center = [b[0].midpoint(b[2]), b[1].midpoint(b[3]), 0.0];
            return Pending::ready(Ok(view.screen(view.world(center)).map(|s| [s[0] as f32, s[1] as f32])));
        }
        let (answer, reply) = Pending::new();
        self.queries.waiting.push_back(Ask::Locate { row: row.clone(), reply });
        self.wake();
        answer
    }

    /// Selects every row in the box between two screen points, as `trigger` chose.
    pub(super) fn select_box(&mut self, corners: [[f32; 2]; 2], trigger: Trigger) {
        self.queries.waiting.push_back(Ask::Boxed { corners, trigger });
        self.wake();
    }

    /// Where mark `i` draws `row` among the rows it draws, if it does.
    pub(super) fn row_index(&self, i: usize, row: &Row) -> Option<u32> {
        let shown = self.marks.get(i)?;
        let style = shown.mark.style();
        if style.data != row.data || style.table != row.table {
            return None;
        }
        let index = self.snapshot(&style.data)?.table(&style.table)?.row(row.id.as_ref())?;
        shown.item_of(shown.held_row(index as u32)?).filter(|&item| item < shown.rows)
    }

    /// Takes the next query for this frame when none runs, passing over those nobody waits for, makes
    /// room for what it finds past the probe's words, and returns its query words and whether it
    /// reads depth.
    pub(super) fn next_query(&mut self) -> Option<([f32; 4], bool)> {
        if self.queries.running.is_some() || self.queries.reading.is_some() {
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

    /// Records the running query's step over every mark it asks, and the copy of what it found.
    pub(super) fn run_query(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let Some(Running { ask, found, words }) = self.queries.running.take() else { return };
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let resources = self.resources.as_mut().expect("created before queries");
        let probe = resources.probe().clone();
        let start = u64::from(wgsl::PROBE_WORDS) * 4;
        // What it finds starts out empty: no hits, with room for those each mark keeps; no rows.
        match &ask {
            Ask::Hits { .. } => {
                for f in &found {
                    queue.write_buffer(&probe, u64::from(f.at) * 4, bytemuck::cast_slice(&[0, f.room]));
                }
            }
            Ask::Boxed { .. } if words > 0 => encoder.clear_buffer(&probe, start, Some(u64::from(words) * 4)),
            Ask::Boxed { .. } | Ask::Locate { .. } => {}
        }
        let shader = crate::gpu::pipelines::probe(resources.samples());
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, shader);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit query"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[]);
            pass.set_bind_group(2, &group, &[step(ask.step())]);
            for f in &found {
                self.probe_step(&mut pass, inner, shader, &groups.mark, f.mark, ask.step());
            }
        }
        let (at, bytes) = match &ask {
            Ask::Locate { .. } => (u64::from(wgsl::PROBE_LOCATE_X) * 4, 16),
            _ => (start, u64::from(words.max(1)) * 4),
        };
        let readback = Readback::new(&inner.readbacks, device, encoder, &probe, at, bytes, &self.waker);
        self.queries.reading = Some(Reading { ask, found, readback, drew: self.drew() });
    }

    /// Answers a query whose readback landed.
    pub(super) fn settle_query(&mut self) {
        let Some(reading) = &self.queries.reading else { return };
        let Some(bytes) = reading.readback.take() else { return };
        let Reading { ask, found, drew, .. } = self.queries.reading.take().expect("reading");
        let words: Vec<u32> = match bytes {
            Ok(bytes) => bytemuck::cast_slice(&bytes).to_vec(),
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
                // A mark that found more than it kept asks again, with room for every hit it found.
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

/// The hits `words` hold of `found`, as `drew`, what their frame drew, names them.
fn hits(found: &[Found], words: &[u32], drew: &Drew) -> Vec<Hit> {
    // Nearest first, the mark drawn last first among equals, and a port before its marker; then
    // by row and where it lies, so the order never depends on which hit landed first. Each row
    // answers once, where it is nearest.
    let mut kept: Vec<(usize, &[u32; wgsl::HIT_WORDS as usize])> = found
        .iter()
        .flat_map(|f| {
            let count = words_at(words, f.at, 1).first().map_or(0, |&n| n.min(f.room));
            let entries = words_at(words, f.at + 2, count * wgsl::HIT_WORDS);
            entries.as_chunks().0.iter().map(move |entry| (f.mark, entry))
        })
        .collect();
    // The last keys first, as each sort keeps the order of ties.
    let key = |high: u32, low: u32| u128::from(crate::order::pair(high, low));
    crate::order::by_wide_key(&mut kept, |&(_, entry)| key(entry[3], entry[4]) << 32 | u128::from(entry[5]));
    crate::order::by_wide_key(&mut kept, |&(i, entry)| key(entry[1], !(i as u32)) << 64 | key(!entry[2], entry[0]));
    let mut seen = FxHashSet::default();
    let mut hits = Vec::new();
    for (i, entry) in kept {
        if !seen.insert((i, entry[0])) {
            continue;
        }
        let Some((row, at)) = drew.row(i, entry[0]) else { continue };
        let point = [f32::from_bits(entry[3]), f32::from_bits(entry[4])];
        let depth = f64::from(f32::from_bits(entry[5]));
        hits.push(Hit {
            row,
            mark: drew.name(i),
            index: i,
            point,
            position: drew.position(point, depth),
            distance: entry[1] as f32 / 64.0,
            port: drew.port(i, entry[2]),
            sample: drew.sample(i, at, entry[2]),
        });
    }
    hits
}

/// `len` words from word `at` of the probe's, in a query's answer read from past the probe's words.
fn words_at(words: &[u32], at: u32, len: u32) -> &[u32] {
    let start = (at - wgsl::PROBE_WORDS) as usize;
    words.get(start..start + len as usize).unwrap_or(&[])
}
