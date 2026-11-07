//! Hierarchical component-wise maxima over integer records. Callers encode minima using the
//! complement of ordered float bits, so the same exact operation handles ranges and priorities.
use super::{
    raster::{At, Raster},
    retired::Retired,
    shaders::SCAN_BLOCK,
    words::Words,
};

pub(crate) struct Maximum {
    a: Words,
    b: Words,
}

impl Maximum {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Self {
        Self {
            a: Words::new(device, retired, "latkit reduction a"),
            b: Words::new(device, retired, "latkit reduction b"),
        }
    }

    pub(crate) fn record(&mut self, raster: &mut Raster<'_>, input: At<'_>, output: At<'_>, records: u32) {
        self.reduce(raster, input, output, records, "maximum");
    }

    pub(crate) fn greatest(&mut self, raster: &mut Raster<'_>, input: At<'_>, output: At<'_>, records: u32) {
        self.reduce(raster, input, output, records, "greatest");
    }

    fn reduce(
        &mut self,
        raster: &mut Raster<'_>,
        input: At<'_>,
        output: At<'_>,
        mut records: u32,
        entry: &'static str,
    ) {
        if records > SCAN_BLOCK {
            self.a.ensure(raster.device, u64::from(records.div_ceil(SCAN_BLOCK)) * 4);
            self.b.ensure(raster.device, u64::from(records.div_ceil(SCAN_BLOCK * SCAN_BLOCK)) * 4);
        }
        let mut current = input;
        let mut a = true;
        while records > SCAN_BLOCK {
            let next = At::new(if a { &self.a } else { &self.b }, 0);
            reduce(raster, current, next, records, entry);
            records = records.div_ceil(SCAN_BLOCK);
            current = next;
            a = !a;
        }
        reduce(raster, current, output, records, entry);
    }
}

fn reduce(raster: &mut Raster<'_>, input: At<'_>, output: At<'_>, records: u32, entry: &'static str) {
    raster.run(
        (super::shaders::Shader::Words, entry),
        input.words,
        input.words,
        output.words,
        super::shaders::WordStep {
            source: input.at,
            other: 0,
            destination: output.at,
            count: records * 4,
            layer: 0,
            value: 0,
            size: [0; 2],
        },
        records.div_ceil(SCAN_BLOCK) * 4,
    );
}
