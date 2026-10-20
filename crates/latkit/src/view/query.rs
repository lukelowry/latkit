//! Queries: every row within reach of a point, every row in a box, and where a row lies on screen,
//! answered on the GPU through the geometry the frame drew and read back a frame or two later. Each
//! queried mark lists what it finds by count → scan → write. One query runs at a time; the rest
//! wait their turn.

use std::collections::VecDeque;

use super::View;
use super::event::{Hit, Trigger};
use super::lists::{List, scan};
use super::passes::{dispatch, offset};
use super::resources::EyeSlot;
use crate::gpu::Inner;
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::{Pending, Resolver, Row};

/// A question for the GPU.
pub(crate) enum Ask {
    /// Every row within `radius` CSS pixels of `point`.
    Hits { point: [f32; 2], radius: f32, reply: Resolver<Vec<Hit>> },
    /// Every row in the box between two corners; they become the selection, as `trigger` chose.
    Boxed { corners: [[f32; 2]; 2], trigger: Trigger },
    /// Where a row lies.
    Locate { row: Row, reply: Resolver<Option<[f32; 2]>> },
}

impl Ask {
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

    /// Entries a mark keeps, and words per entry.
    fn entries(&self, instances: u32) -> (u32, u32) {
        match self {
            Ask::Hits { .. } => (instances.min(1024), 6),
            Ask::Boxed { .. } => (instances, 1),
            Ask::Locate { .. } => (0, 0),
        }
    }
}

/// A query this frame runs: what it asks, the marks it asks, their lists, and the words of the
/// lists buffer where those start and end.
struct Running {
    ask: Ask,
    marks: Vec<(usize, List)>,
    words: [u32; 2],
}

/// A query whose answer the GPU is copying back, from word `base` of the lists buffer.
struct Reading {
    ask: Ask,
    marks: Vec<(usize, List)>,
    base: u32,
    readback: Readback,
}

#[derive(Default)]
pub(crate) struct Queries {
    waiting: VecDeque<Ask>,
    running: Option<Running>,
    reading: Option<Reading>,
}

impl Queries {
    /// Whether a query waits to run.
    pub(crate) fn due(&self) -> bool {
        !self.waiting.is_empty() || self.running.is_some()
    }

    /// Where the running query's lists end in the lists buffer, in words.
    pub(crate) fn words(&self) -> u32 {
        self.running.as_ref().map_or(0, |r| r.words[1])
    }
}

impl View {
    /// Every row of a mark that picks within `radius` CSS pixels of `point`, nearest first, as the
    /// next frames draw them.
    pub fn pick(&mut self, point: [f32; 2], radius: f32) -> Pending<Vec<Hit>> {
        let (answer, reply) = Pending::new();
        self.queries.waiting.push_back(Ask::Hits { point, radius: radius.max(0.0), reply });
        self.wake();
        answer
    }

    /// Where `row` lies on screen, CSS pixels from the top left, as the next frames draw it; `None`
    /// when no mark draws it in view. A diagram's vertices answer at once from its sheet.
    pub fn locate(&mut self, row: &Row) -> Pending<Option<[f32; 2]>> {
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

    /// The index of `row` in mark `i`'s table.
    pub(super) fn row_index(&self, i: usize, row: &Row) -> Option<u32> {
        let style = self.marks.get(i)?.mark.style();
        if style.data != row.data || style.table != row.table {
            return None;
        }
        let index = self.drawn(&style.data)?.table(&style.table)?.row(row.id.as_ref())?;
        (index < self.marks[i].rows as usize).then_some(index as u32)
    }

    /// The row at `index` of mark `i`'s table.
    pub(super) fn row_at(&self, i: usize, index: u32) -> Option<Row> {
        let style = self.marks.get(i)?.mark.style();
        let id = self.drawn(&style.data)?.table(&style.table)?.ids.id(index as usize)?;
        Some(Row { data: style.data.clone(), table: style.table.clone(), id })
    }

    /// Takes the next query for this frame when none runs, lays out its lists, and returns its
    /// query words and whether it reads depth.
    pub(super) fn next_query(&mut self) -> Option<([f32; 4], bool)> {
        if self.queries.running.is_some() || self.queries.reading.is_some() {
            return None;
        }
        let ask = self.queries.waiting.pop_front()?;
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
        // The query's lists follow the marks' segment lists.
        let base = self.segment_words;
        let mut front = base;
        let sizes: Vec<(usize, u32, u32, u32)> = marks
            .iter()
            .map(|&i| {
                let items = self.marks[i].live_instances();
                let (kept, stride) = ask.entries(items);
                (i, items, kept, stride)
            })
            .collect();
        let front_total: u32 = sizes.iter().map(|&(_, _, kept, stride)| List::front_words(kept, stride)).sum();
        let mut back = base + front_total;
        let mut lists = Vec::new();
        for (i, items, kept, stride) in sizes {
            let list = List::at(front, back, items, kept, stride);
            front += List::front_words(kept, stride);
            back += List::back_words(items);
            self.marks[i].query = list.header;
            lists.push((i, list));
        }
        let depth = !matches!(ask, Ask::Boxed { .. });
        self.queries.running = Some(Running { ask, marks: lists, words: [base, back] });
        Some((words, depth))
    }

    /// Records the running query's passes and the copy of its answer.
    pub(super) fn run_query(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let Some(running) = self.queries.running.take() else { return };
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let resources = self.resources.as_mut().expect("created before queries");
        for (_, list) in &running.marks {
            queue.write_buffer(
                resources.lists(),
                u64::from(list.header) * 4,
                bytemuck::cast_slice(&list.header_words(0)),
            );
        }
        let shader = crate::gpu::pipelines::probe(resources.samples());
        let groups = resources.groups(&gpu.0, inner);
        let probe_group = resources.pass(device, inner, shader);
        let lists_group = resources.pass(device, inner, Shader::ListsQuery);
        let (count, write) = match &running.ask {
            Ask::Hits { .. } => ("count_hits", "write_hits"),
            Ask::Boxed { .. } => ("count_boxed", "write_boxed"),
            Ask::Locate { .. } => ("locate", ""),
        };
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit query"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            for (i, list) in &running.marks {
                let probing =
                    |entry| Variant::probe(shader, entry, self.marks[*i].primitive()).path(self.marks[*i].path());
                pass.set_bind_group(1, &groups.mark, &[offset(*i)]);
                pass.set_bind_group(2, &probe_group, &[]);
                pass.set_pipeline(&inner.pipelines.compute_pipeline(device, probing(count)));
                if write.is_empty() {
                    pass.dispatch_workgroups(1, 1, 1);
                    continue;
                }
                dispatch(&mut pass, list.items);
                pass.set_bind_group(2, &lists_group, &[]);
                scan(&mut pass, &mut inner.pipelines, device, list.items, true);
                pass.set_bind_group(2, &probe_group, &[]);
                pass.set_pipeline(&inner.pipelines.compute_pipeline(device, probing(write)));
                dispatch(&mut pass, list.items);
            }
        }
        let resources = self.resources.as_ref().expect("created");
        let readback = if let Ask::Locate { .. } = &running.ask {
            let at = u64::from(wgsl::PROBE_LOCATE_X) * 4;
            Readback::new(&inner.readbacks, device, encoder, resources.probe(), at, 16, &self.waker)
        } else {
            let front: u32 = running.marks.iter().map(|(_, l)| List::front_words(l.kept, l.stride)).sum();
            let base = u64::from(running.words[0]) * 4;
            Readback::new(
                &inner.readbacks,
                device,
                encoder,
                resources.lists(),
                base,
                u64::from(front.max(1)) * 4,
                &self.waker,
            )
        };
        let base = running.words[0];
        self.queries.reading = Some(Reading { ask: running.ask, marks: running.marks, base, readback });
    }

    /// Answers a query whose readback landed.
    pub(super) fn settle_query(&mut self) {
        let Some(reading) = &self.queries.reading else { return };
        let Some(bytes) = reading.readback.take() else { return };
        let Reading { ask, marks, base, .. } = self.queries.reading.take().expect("reading");
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
            Ask::Hits { reply, .. } => reply.resolve(Ok(self.hits(&marks, &words, base))),
            Ask::Boxed { trigger, .. } => {
                let mut rows = Vec::new();
                for &(i, list) in &marks {
                    if !self.marks[i].mark.style().interaction.select {
                        continue;
                    }
                    for index in entries(&words, list, base) {
                        if let Some(row) = self.row_at(i, index[0])
                            && !rows.contains(&row)
                        {
                            rows.push(row);
                        }
                    }
                }
                self.reselect(rows, Some(trigger));
            }
            Ask::Locate { reply, .. } => {
                let found = words.get(2).is_some_and(|&w| w != 0);
                let point = found.then(|| [f32::from_bits(words[0]), f32::from_bits(words[1])]);
                reply.resolve(Ok(point));
            }
        }
        self.wake();
    }

    fn hits(&self, marks: &[(usize, List)], words: &[u32], base: u32) -> Vec<Hit> {
        let view = self.projected();
        // Nearest first, the mark drawn last first among equals, and a port before its marker; each
        // row answers once, where it is nearest.
        let mut found: Vec<(usize, &[u32])> =
            marks.iter().flat_map(|&(i, list)| entries(words, list, base).map(move |entry| (i, entry))).collect();
        found.sort_by_key(|&(i, entry)| (entry[1], std::cmp::Reverse(i), std::cmp::Reverse(entry[2])));
        let mut seen = rustc_hash::FxHashSet::default();
        let mut hits = Vec::new();
        for (i, entry) in found {
            if !seen.insert((i, entry[0])) {
                continue;
            }
            let Some(row) = self.row_at(i, entry[0]) else { continue };
            let point = [f32::from_bits(entry[3]), f32::from_bits(entry[4])];
            let depth = f64::from(f32::from_bits(entry[5]));
            hits.push(Hit {
                row,
                mark: self.marks[i].mark.style().name.clone(),
                index: i,
                point,
                position: view.position(view.unproject(point.map(f64::from), depth)),
                distance: entry[1] as f32 / 64.0,
                port: self.port(i, entry[2]),
                sample: self.sample(i, entry[0], entry[2]),
            });
        }
        hits
    }
}

/// The entries of `list` in the answer's words, read from word `base`, each `stride` words.
fn entries(words: &[u32], list: List, base: u32) -> impl Iterator<Item = &[u32]> {
    let header = (list.header - base) as usize;
    let total = words.get(header + wgsl::LIST_DRAW as usize + 1).copied().unwrap_or(0).min(list.kept) as usize;
    let start = (list.entries - base) as usize;
    let stride = list.stride.max(1) as usize;
    words.get(start..start + total * stride).unwrap_or(&[]).chunks_exact(stride)
}
