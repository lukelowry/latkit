//! Stable unsigned-key radix order on integer render targets. Histograms cover fixed-size blocks;
//! scanned counts give each block a disjoint destination, so scatter needs neither atomics nor a
//! depth tie-breaker. Scratch is reused, and the eight digits finish in the caller's destination.

use super::raster::{At, Raster, Scan};
use super::retired::Retired;
use super::shaders::{RADIX_BITS, RADIX_BLOCK, Shader, WordStep};
use super::words::Words;

pub(crate) struct Order {
    work: Words,
    counts: Words,
    offsets: Words,
    scan: Scan,
}

impl Order {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Order {
        Order {
            work: Words::new(device, retired, "latkit radix records"),
            counts: Words::new(device, retired, "latkit radix counts"),
            offsets: Words::new(device, retired, "latkit radix offsets"),
            scan: Scan::default(),
        }
    }

    /// Sorts count four-word records by their first word, preserving input order for equal keys.
    /// Input and output may name the same range: the first digit always writes private scratch.
    pub(crate) fn record(&mut self, raster: &mut Raster<'_>, input: At<'_>, output: At<'_>, count: u32) {
        if count == 0 {
            return;
        }
        let histograms = count.div_ceil(RADIX_BLOCK) * (1 << RADIX_BITS);
        self.work.ensure(raster.device, u64::from(count) * 4);
        self.counts.ensure(raster.device, u64::from(histograms));
        self.offsets.ensure(raster.device, u64::from((histograms + 1).next_multiple_of(4)));
        let mut source = input;
        for digit in 0..32 / RADIX_BITS {
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
            raster.run((Shader::Order, "histogram"), source.words, source.words, &self.counts, step, histograms);
            self.scan.record(raster, At::new(&self.counts, 0), At::new(&self.offsets, 0), histograms);
            raster.run(
                (Shader::OrderScatter, "scatter"),
                source.words,
                &self.offsets,
                destination.words,
                WordStep { destination: destination.at, ..step },
                count * 4,
            );
            source = destination;
        }
    }
}
