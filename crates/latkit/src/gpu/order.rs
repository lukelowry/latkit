//! Stable unsigned-key radix order on integer render targets. Histograms cover fixed-size blocks;
//! scanned counts give each block a disjoint destination, so scatter needs neither atomics nor a
//! depth tie-breaker. Scratch is reused, and the last digit finishes in the caller's destination.

use super::raster::{At, Raster, Scan};
use super::retired::Retired;
use super::shaders::{RADIX_BITS, RADIX_BLOCK, Shader, WordStep};
use super::words::Words;

pub(crate) struct Order {
    work: Words,
    counts: Words,
    offsets: Words,
    ranks: Words,
    scan: Scan,
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
        (input, output): (At<'_>, At<'_>),
        count: u32,
        room: u32,
        bits: u32,
    ) {
        if count == 0 {
            return;
        }
        let histograms = |n: u32| n.div_ceil(RADIX_BLOCK) * (1 << RADIX_BITS);
        let room = room.max(count);
        self.work.ensure(raster.device, u64::from(room) * 4);
        self.counts.ensure(raster.device, u64::from(histograms(room)));
        self.offsets.ensure(raster.device, u64::from((histograms(room) + 1).next_multiple_of(4)));
        self.ranks.ensure(raster.device, u64::from(room.next_multiple_of(4)));
        self.scan.reserve(raster, histograms(room));
        let (histograms, ranked) = (histograms(count), count.next_multiple_of(4));
        let digits = bits.div_ceil(RADIX_BITS);
        let mut source = input;
        for digit in 0..digits {
            let destination = if digit % 2 == 0 { At::new(&self.work, 0) } else { output };
            let step = WordStep {
                source: source.at,
                other: 0,
                destination: 0,
                count,
                layer: 0,
                value: digit * RADIX_BITS,
                size: [0; 2],
            };
            // Each block's counts, block by block into `offsets` as scratch, then digit by digit
            // into `counts` for the scan.
            raster.run((Shader::Order, "histogram"), source.words, source.words, &self.offsets, step, histograms);
            let blocks = WordStep { source: 0, ..step };
            raster.run((Shader::Order, "by_digit"), &self.offsets, &self.offsets, &self.counts, blocks, histograms);
            self.scan.record(raster, At::new(&self.counts, 0), At::new(&self.offsets, 0), histograms);
            raster.run((Shader::Order, "rank"), source.words, &self.offsets, &self.ranks, step, ranked);
            raster.run(
                (Shader::OrderScatter, "scatter"),
                source.words,
                &self.ranks,
                destination.words,
                WordStep { destination: destination.at, ..step },
                count * 4,
            );
            source = destination;
        }
        // An odd number of digits ends in scratch.
        if digits % 2 == 1 {
            self.work.copy_to(raster.encoder, 0, output.words, output.at, count * 4);
        }
    }
}
