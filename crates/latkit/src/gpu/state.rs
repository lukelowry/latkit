//! Bounded row evaluation. A fragment evaluates one row into integer planes; a second pass
//! packs those planes into the existing arena layout. Callers copy just the changed pages.

use std::sync::Arc;

use super::pipelines::Variant;
use super::raster::Raster;
use super::retired::Retired;
use super::shaders::{PAGE_ROWS, STATE_WORDS, Shader, StateStep, WordStep};
use super::words::{WIDTH, Words, origin, spans};

/// Sixteen pages keep evaluation scratch independent of the number of rows in a scene.
pub(crate) const BATCH: u32 = 16 * PAGE_ROWS;

pub(crate) struct Inputs<'a> {
    pub(crate) pages: &'a Words,
    pub(crate) domains: &'a Words,
    pub(crate) remap: &'a Words,
    pub(crate) blocks: &'a Words,
    pub(crate) view: &'a wgpu::BindGroup,
    pub(crate) mark: &'a wgpu::BindGroup,
    pub(crate) offset: u32,
    pub(crate) reads: super::pipelines::Reads,
}

pub(crate) struct State {
    planes: [Words; 8],
    packed: Words,
    summary: Words,
    maximum: super::reduce::Maximum,
}

impl State {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> State {
        State {
            planes: std::array::from_fn(|_| Words::new(device, retired, "latkit row plane")),
            packed: Words::new(device, retired, "latkit packed rows"),
            summary: Words::new(device, retired, "latkit domain summaries"),
            maximum: super::reduce::Maximum::new(device, retired),
        }
    }

    pub(crate) fn shader(device: &wgpu::Device) -> Shader {
        if device.limits().max_color_attachment_bytes_per_sample >= 64 { Shader::State } else { Shader::StateNarrow }
    }

    /// Evaluates a batch using `entry`, returning packed row words. This only records commands;
    /// values stay on the GPU and the caller owns submission and sparse destination copies.
    pub(crate) fn record<'s>(
        &'s mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        entry: &'static str,
        kernel: Option<&Arc<str>>,
        mut step: StateStep,
        width: u32,
    ) -> &'s Words {
        assert!(step.rows > 0 && step.rows <= BATCH && width <= STATE_WORDS);
        let shader = Self::shader(raster.device);
        let reads = if matches!(entry, "evaluate" | "reduce") { input.reads } else { super::pipelines::Reads::ALL };
        let variant = Variant::state(shader, entry, reads);
        let pipeline = if let Some(kernel) = kernel {
            raster.pipelines.kernel(raster.device, kernel, variant)
        } else {
            raster.pipelines.render(raster.device, variant)
        };
        let attachments = shader.source().targets;
        let used = (width as usize).div_ceil(attachments * 4) * attachments;
        for plane in &mut self.planes[..used] {
            plane.ensure(raster.device, u64::from(step.rows) * 4);
        }
        let layout = raster.pipelines.pass_layout(raster.device, shader);
        let base = step.word;
        for first in (0..used).step_by(attachments) {
            step.word = base + first as u32 * 4;
            let uniform = raster.queue.uniform(raster.device, bytemuck::bytes_of(&step));
            let entries: Vec<_> = shader
                .source()
                .pass
                .iter()
                .map(|binding| wgpu::BindGroupEntry {
                    binding: binding.slot,
                    resource: match binding.slot {
                        0 => input.pages.binding(),
                        4 => input.domains.binding(),
                        12 => input.remap.binding(),
                        16 => input.blocks.binding(),
                        17 => uniform.as_entire_binding(),
                        _ => unreachable!("row evaluator binding"),
                    },
                })
                .collect();
            let group = raster.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("latkit state inputs"),
                layout: &layout,
                entries: &entries,
            });
            let views: Vec<_> =
                self.planes[first..first + attachments].iter().map(|plane| plane.attachment(0)).collect();
            let targets: Vec<_> = views.iter().map(|view| Some(target(view))).collect();
            let mut pass = raster.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(entry),
                color_attachments: &targets,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, input.view, &[]);
            pass.set_bind_group(1, input.mark, &[input.offset]);
            pass.set_bind_group(2, &group, &[]);
            pass.set_scissor_rect(0, 0, step.rows.min(WIDTH), step.rows.div_ceil(WIDTH));
            pass.draw(0..3, 0..1);
        }
        // A four-word row already occupies one complete texel in the first plane.
        // Areas and domain reductions can consume it directly, without a packing pass.
        if width == 4 {
            return &self.planes[0];
        }
        self.pack(raster, step.rows, width);
        &self.packed
    }

    /// Fits a mark's domains over its live rows without reading an intermediate result on the
    /// CPU. Each batch contributes one exact range record; a final reduction combines batches.
    pub(crate) fn domains(
        &mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        kernel: &Arc<str>,
        rows: u32,
        domains: u32,
        destination: u32,
    ) {
        use super::raster::At;
        let batches = rows.div_ceil(BATCH);
        if batches == 0 {
            return;
        }
        self.summary.ensure(raster.device, u64::from(batches) * 4);
        for domain in (0..domains).step_by(2) {
            for batch in 0..batches {
                let first = batch * BATCH;
                self.record(
                    raster,
                    input,
                    "reduce",
                    Some(kernel),
                    StateStep { first, rows: (rows - first).min(BATCH), block: super::shaders::NONE, word: domain * 2 },
                    4,
                );
                self.maximum.record(
                    raster,
                    At::new(&self.planes[0], 0),
                    At::new(&self.summary, batch * 4),
                    (rows - first).min(BATCH),
                );
            }
            self.maximum.record(
                raster,
                At::new(&self.summary, 0),
                At::new(input.domains, destination + domain * 2),
                batches,
            );
        }
    }

    fn pack(&mut self, raster: &mut Raster<'_>, rows: u32, width: u32) {
        let count = rows * width;
        self.packed.ensure(raster.device, u64::from(count.next_multiple_of(4)));
        let layout = raster.pipelines.pass_layout(raster.device, Shader::Pack);
        let pipeline = raster.pipelines.render(raster.device, Variant::raster(Shader::Pack, "pack"));
        for part in spans(0, count.next_multiple_of(4)) {
            let at = origin(part.at);
            let step = WordStep { source: 0, other: 0, destination: 0, count, layer: at.z, value: width, size: [0; 2] };
            let uniform = raster.queue.uniform(raster.device, bytemuck::bytes_of(&step));
            let mut entries: Vec<_> = self
                .planes
                .iter()
                .enumerate()
                .map(|(i, plane)| wgpu::BindGroupEntry { binding: i as u32, resource: plane.binding() })
                .collect();
            entries.push(wgpu::BindGroupEntry { binding: 8, resource: uniform.as_entire_binding() });
            let group = raster.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("latkit row packing"),
                layout: &layout,
                entries: &entries,
            });
            let view = self.packed.attachment(at.z);
            let mut pass = raster.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("latkit row packing"),
                color_attachments: &[Some(target(&view))],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &raster.pipelines.empty, &[]);
            pass.set_bind_group(1, &raster.pipelines.empty, &[]);
            pass.set_bind_group(2, &group, &[]);
            let size = part.size();
            pass.set_scissor_rect(at.x, at.y, size.width, size.height);
            pass.draw(0..3, 0..1);
        }
    }
}

fn target(view: &wgpu::TextureView) -> wgpu::RenderPassColorAttachment<'_> {
    wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
    }
}

#[cfg(test)]
mod tests {
    use super::super::{kernel, readback::Readback, shaders as w};
    use super::*;
    use crate::expr::compile::{Channel, Program, Reads};
    use bytemuck::Zeroable as _;

    #[test]
    fn generated_channels_preserve_bits_sparse_rows_and_wide_extras() {
        evaluated_rows(21);
    }

    #[test]
    fn compact_rows_preserve_bits_and_relocated_sparse_pages_without_packing() {
        evaluated_rows(4);
    }

    #[expect(clippy::too_many_lines, reason = "one complete sparse evaluation and relocation cycle")]
    fn evaluated_rows(width: u32) {
        let Some(mut fixture) = super::super::raster::tests::fixture() else { return };
        let (device, queue) = (&fixture.device, &fixture.queue);
        let rows = 8193u32;
        let state_words = (rows * width).next_multiple_of(4);
        let mut values: Vec<u32> = (0..state_words).map(|i| 0xac00_0000 | i).collect();
        values.extend((0..rows).map(|i| (i as f32).to_bits()));
        values.resize(values.len().next_multiple_of(4), 0);
        let mut pages = Words::new(device, queue.retired(), "test row arena");
        pages.ensure(device, values.len() as u64);
        pages.write(queue, 0, &values);
        let mut program = Program::default();
        for word in 0..width {
            let start = program.code.len() as u32;
            program.code.push([if word == 0 { w::OP_FIELD } else { w::OP_CONST }, word, 0, 0]);
            program.code.push([w::OP_STORE_CODE, word, 0, 0]);
            program.ranges.push([start, program.code.len() as u32]);
            program.channels.push(Channel {
                name: format!("word{word}").into(),
                reads: Reads::default(),
                eases: false,
            });
        }
        let kernel = kernel::source(&program, width);
        let mut words = vec![0u32; 40];
        for page in 0..3 {
            words[page] = page as u32 * w::PAGE_ROWS * width;
            words[4 + page] = state_words + page as u32 * w::PAGE_ROWS;
        }
        words[8..14].copy_from_slice(&[0, rows, 4, w::NONE, w::NONE, 0]);
        let constants: Vec<u32> =
            (0..width).map(|i| 0xff00_0017u32.wrapping_add(i.wrapping_mul(0x0031_4159))).collect();
        words[16..16 + width as usize].copy_from_slice(&constants);
        let mut code = Words::new(device, queue.retired(), "test row program");
        code.ensure(device, words.len() as u64);
        code.write(queue, 0, &words);
        let blocks = Words::new(device, queue.retired(), "test row blocks");
        blocks.write(queue, 0, &[1 | w::FRESH, 0, 2, 0]);
        let mark = w::Mark {
            kind: w::MARK_LINES,
            rows,
            held: rows,
            stride: width.min(5),
            extras: width.saturating_sub(5),
            state: 0,
            columns: 8,
            constants: 16,
            frozen: w::NONE,
            settled: w::NONE,
            mask: 0x0015_5555,
            channels: width,
            ..w::Mark::zeroed()
        };
        let mark_buffer = queue.uniform(device, bytemuck::bytes_of(&mark));
        let frame = queue.uniform(device, bytemuck::bytes_of(&w::Frame::zeroed()));
        let eye = queue.uniform(device, bytemuck::bytes_of(&w::Eye::zeroed()));
        let colors = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test colormap"),
            size: wgpu::Extent3d { width: 2, height: 1, depth_or_array_layers: 2 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let colors = colors.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
        let view = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &fixture.pipelines.view_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: frame.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: code.binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&colors) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) },
                wgpu::BindGroupEntry { binding: 4, resource: eye.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: code.binding() },
            ],
        });
        let marks = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &fixture.pipelines.mark_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: mark_buffer.as_entire_binding() }],
        });
        let input = Inputs {
            pages: &pages,
            domains: &code,
            remap: &code,
            blocks: &blocks,
            view: &view,
            mark: &marks,
            offset: 0,
            reads: super::super::pipelines::Reads::NONE,
        };
        let mut state = State::new(device, queue.retired());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let mut raster = Raster { device, queue, pipelines: &mut fixture.pipelines, encoder: &mut encoder };
        let output = state.record(
            &mut raster,
            &input,
            "evaluate",
            Some(&kernel),
            StateStep { first: 0, rows, block: 0, word: 0 },
            width,
        );
        let read = Readback::words(
            &fixture.readbacks,
            device,
            raster.encoder,
            output,
            0,
            rows * width,
            std::task::Waker::noop(),
        );
        queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(20)) })
            .unwrap();
        let bytes = read.take().expect("row readback ready").unwrap();
        let actual: &[u32] = bytemuck::cast_slice(&bytes);
        for i in 0..rows {
            let row = if i < w::PAGE_ROWS {
                i + w::PAGE_ROWS
            } else if i < 2 * w::PAGE_ROWS {
                i - w::PAGE_ROWS
            } else {
                i
            };
            for word in 0..width {
                let expected = if mark.mask & (1 << word) != 0 {
                    if word == 0 { (row as f32).to_bits() } else { constants[word as usize] }
                } else if i < w::PAGE_ROWS {
                    0
                } else {
                    values[(row * width + word) as usize]
                };
                assert_eq!(actual[(i * width + word) as usize], expected, "row {row}, word {word}");
            }
        }
    }
}
