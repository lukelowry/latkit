//! Stable unsigned-key radix order on integer render targets. Histograms cover fixed-size blocks;
//! scanned counts give each block a disjoint destination, so scatter needs neither atomics nor a
//! depth tie-breaker. Scratch is reused, and the last digit finishes in the caller's destination.
//!
//! A sort runs a pass at a time, so a large one can spread over frames: each digit takes
//! [`PASSES`] passes over its records, and the scratch holds the sort between them.

use super::raster::{At, Raster, Scan};
use super::retired::Retired;
use super::shaders::{RADIX_BITS, RADIX_BLOCK, Shader, WordStep};
use super::words::Words;

/// Passes each digit takes: block histograms, counts by digit, their scan, ranks, and the scatter.
pub(crate) const PASSES: u32 = 5;

pub(crate) struct Order {
    work: Words,
    counts: Words,
    offsets: Words,
    ranks: Words,
    scan: Scan,
}

/// A sort under way: how many records, by how many bits, and how many passes it has run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Sorting {
    count: u32,
    bits: u32,
    done: u32,
}

impl Sorting {
    /// Passes the sort takes in all.
    fn passes(self) -> u32 {
        self.bits.div_ceil(RADIX_BITS) * PASSES
    }

    /// Passes it has left.
    pub(crate) fn left(self) -> u32 {
        self.passes() - self.done
    }
}

impl Order {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Order {
        Order {
            work: Words::new(device, retired, "latkit radix records"),
            counts: Words::new(device, retired, "latkit radix counts"),
            offsets: Words::new(device, retired, "latkit radix offsets"),
            ranks: Words::new(device, retired, "latkit radix ranks"),
            scan: Scan::default(),
        }
    }

    /// Sorts `count` four-word records by the low `bits` bits of their first word, preserving
    /// input order for equal keys. Input and output may name the same range: the first digit
    /// always writes private scratch. Scratch has room for `room` records, at least `count`, so a
    /// count that varies between sorts below it never makes it again.
    pub(crate) fn record(
        &mut self,
        raster: &mut Raster<'_>,
        sides: (At<'_>, At<'_>),
        count: u32,
        room: u32,
        bits: u32,
    ) {
        let mut sorting = self.begin(raster, count, room, bits);
        self.advance(raster, sides, &mut sorting, u32::MAX);
    }

    /// Starts a sort as [`record`](Order::record) does, making its scratch, to run with
    /// [`advance`](Order::advance).
    pub(crate) fn begin(&mut self, raster: &mut Raster<'_>, count: u32, room: u32, bits: u32) -> Sorting {
        let histograms = |n: u32| n.div_ceil(RADIX_BLOCK) * (1 << RADIX_BITS);
        let room = room.max(count);
        self.work.ensure(raster.device, u64::from(room) * 4);
        self.counts.ensure(raster.device, u64::from(histograms(room)));
        self.offsets.ensure(raster.device, u64::from((histograms(room) + 1).next_multiple_of(4)));
        self.ranks.ensure(raster.device, u64::from(room.next_multiple_of(4)));
        self.scan.reserve(raster, histograms(room));
        Sorting { count, bits: if count == 0 { 0 } else { bits }, done: 0 }
    }

    /// Runs at most `passes` more of `sorting`'s passes, at least one, over the records of `input`,
    /// ordering them into `output`. The records must stay as they were since the sort began.
    /// Returns whether the order has landed in `output`.
    pub(crate) fn advance(
        &mut self,
        raster: &mut Raster<'_>,
        (input, output): (At<'_>, At<'_>),
        sorting: &mut Sorting,
        passes: u32,
    ) -> bool {
        let count = sorting.count;
        let (histograms, ranked) = (count.div_ceil(RADIX_BLOCK) * (1 << RADIX_BITS), count.next_multiple_of(4));
        for _ in 0..passes.max(1) {
            if sorting.left() == 0 {
                break;
            }
            let digit = sorting.done / PASSES;
            // Digits alternate between scratch and the output, from the input.
            let source = match digit {
                0 => input,
                d if !d.is_multiple_of(2) => At::new(&self.work, 0),
                _ => output,
            };
            let destination = if digit.is_multiple_of(2) { At::new(&self.work, 0) } else { output };
            let step = WordStep { source: source.at, value: digit * RADIX_BITS, ..WordStep::of(count) };
            match sorting.done % PASSES {
                // Each block's counts, block by block into `offsets` as scratch, then digit by digit
                // into `counts` for the scan.
                0 => raster.run(
                    (Shader::Order, "histogram"),
                    source.words,
                    source.words,
                    &self.offsets,
                    step,
                    histograms,
                ),
                1 => {
                    let blocks = WordStep { source: 0, ..step };
                    raster.run(
                        (Shader::Order, "by_digit"),
                        &self.offsets,
                        &self.offsets,
                        &self.counts,
                        blocks,
                        histograms,
                    );
                }
                2 => self.scan.record(raster, At::new(&self.counts, 0), At::new(&self.offsets, 0), histograms),
                3 => raster.run((Shader::Order, "rank"), source.words, &self.offsets, &self.ranks, step, ranked),
                _ => raster.run(
                    (Shader::OrderScatter, "scatter"),
                    source.words,
                    &self.ranks,
                    destination.words,
                    WordStep { destination: destination.at, ..step },
                    count * 4,
                ),
            }
            sorting.done += 1;
            // An odd number of digits ends in scratch.
            if sorting.left() == 0 && (sorting.passes() / PASSES) % 2 == 1 {
                self.work.copy_to(raster.encoder, 0, output.words, output.at, count * 4);
            }
        }
        sorting.left() == 0
    }
}
