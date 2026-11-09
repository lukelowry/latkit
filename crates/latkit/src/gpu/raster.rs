//! GPU algorithms expressed as render passes over exact integer words. Every operation reads
//! separate textures from those it writes. Pass parameters live until submission; no operation
//! submits, polls, maps, or waits. Scans retain their small hierarchy between frames.

use super::pipelines::{Pipelines, Variant};
use super::shaders::{GATHER_PAGES, Pages, SCAN_BLOCK, Shader, WordStep};
use super::words::{LAYER_WORDS, Span, Words, origin, spans};
use super::work::Queue;

/// A texture and a word offset. Operation inputs/outputs start at whole texels.
#[derive(Clone, Copy)]
pub(crate) struct At<'a> {
    pub(crate) words: &'a Words,
    pub(crate) at: u32,
}

impl<'a> At<'a> {
    pub(crate) fn new(words: &'a Words, at: u32) -> At<'a> {
        assert!(at.is_multiple_of(4));
        At { words, at }
    }
}

/// A caller's command recording context. Raster operations are ordered with all other frame
/// commands, including texture uploads, sparse updates, copies, drawing, and readbacks.
pub(crate) struct Raster<'a> {
    pub(crate) device: &'a wgpu::Device,
    pub(crate) queue: &'a Queue,
    pub(crate) pipelines: &'a mut Pipelines,
    pub(crate) encoder: &'a mut wgpu::CommandEncoder,
}

/// Shared view/mark uniforms for a raster algorithm that reads scene geometry.
pub(crate) struct Shared<'a> {
    pub(crate) view: &'a wgpu::BindGroup,
    pub(crate) mark: &'a wgpu::BindGroup,
    pub(crate) offset: u32,
}

/// One integer raster dispatch. Resources are sampled inputs; the destination is separate. Every
/// raster shader writes one color target, so ANGLE on D3D11 builds its pixel shader when the
/// program links, not at its first draw.
pub(crate) struct Render<'a> {
    pub(crate) variant: Variant,
    pub(crate) shared: Option<Shared<'a>>,
    pub(crate) bindings: &'a [wgpu::BindGroupEntry<'a>],
    pub(crate) uniform: u32,
    pub(crate) step: WordStep,
    pub(crate) output: &'a Words,
    pub(crate) words: u32,
}

/// A scatter draw, with immutable parameters and an explicitly separate render target.
pub(crate) struct Draw<'a> {
    pub(crate) variant: Variant,
    pub(crate) shared: Option<Shared<'a>>,
    pub(crate) bindings: &'a [wgpu::BindGroupEntry<'a>],
    pub(crate) uniform: u32,
    pub(crate) step: WordStep,
    pub(crate) target: &'a wgpu::TextureView,
    pub(crate) vertices: u32,
    pub(crate) instances: u32,
    pub(crate) clear: bool,
}

impl Raster<'_> {
    pub(crate) fn draw(&mut self, draw: Draw<'_>) {
        let shader = draw.variant.shader();
        let layout = self.pipelines.pass_layout(self.device, shader);
        let pipeline = self.pipelines.render(self.device, draw.variant);
        let uniform = self.queue.uniform(self.device, bytemuck::bytes_of(&draw.step));
        let mut entries: Vec<_> = draw
            .bindings
            .iter()
            .filter(|b| shader.source().pass.iter().any(|p| p.slot == b.binding))
            .cloned()
            .collect();
        if shader.source().pass.iter().any(|p| p.slot == draw.uniform) {
            entries.push(wgpu::BindGroupEntry { binding: draw.uniform, resource: uniform.as_entire_binding() });
        }
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(shader.source().label),
            layout: &layout,
            entries: &entries,
        });
        let mut pass = self.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(shader.source().label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: draw.target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: if draw.clear { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) } else { wgpu::LoadOp::Load },
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        if let Some(shared) = draw.shared {
            pass.set_bind_group(0, shared.view, &[]);
            pass.set_bind_group(1, shared.mark, &[shared.offset]);
        } else {
            pass.set_bind_group(0, &self.pipelines.empty, &[]);
            pass.set_bind_group(1, &self.pipelines.empty, &[]);
        }
        pass.set_bind_group(2, &group, &[]);
        pass.draw(0..draw.vertices, 0..draw.instances);
    }
    pub(crate) fn render(&mut self, render: Render<'_>) {
        let Render { variant, shared, bindings, uniform: slot, mut step, output, words } = render;
        if words == 0 {
            return;
        }
        let shader = variant.shader();
        let layout = self.pipelines.pass_layout(self.device, shader);
        let pipeline = self.pipelines.render(self.device, variant);
        step.size = [output.texture().width(), output.texture().height()];
        for part in spans(step.destination, words) {
            let at = origin(part.at);
            step.layer = at.z;
            let uniform = self.queue.uniform(self.device, bytemuck::bytes_of(&step));
            let mut entries: Vec<_> =
                bindings.iter().filter(|b| shader.source().pass.iter().any(|p| p.slot == b.binding)).cloned().collect();
            if shader.source().pass.iter().any(|p| p.slot == slot) {
                entries.push(wgpu::BindGroupEntry { binding: slot, resource: uniform.as_entire_binding() });
            }
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(shader.source().label),
                layout: &layout,
                entries: &entries,
            });
            let view = output.attachment(at.z);
            let mut pass = self.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(shader.source().label),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            if let Some(shared) = &shared {
                pass.set_bind_group(0, shared.view, &[]);
                pass.set_bind_group(1, shared.mark, &[shared.offset]);
            } else {
                pass.set_bind_group(0, &self.pipelines.empty, &[]);
                pass.set_bind_group(1, &self.pipelines.empty, &[]);
            }
            pass.set_bind_group(2, &group, &[]);
            let size = part.size();
            pass.set_scissor_rect(at.x, at.y, size.width, size.height);
            pass.draw(0..3, 0..1);
        }
    }
    pub(crate) fn run(
        &mut self,
        (shader, entry): (Shader, &'static str),
        input: &Words,
        other: &Words,
        output: &Words,
        mut step: WordStep,
        words: u32,
    ) {
        assert_ne!(input.texture(), output.texture(), "raster input and output must not alias");
        assert_ne!(other.texture(), output.texture(), "raster input and output must not alias");
        assert!(step.source.is_multiple_of(4) && step.destination.is_multiple_of(4));
        assert!(u64::from(step.destination) + u64::from(words) <= output.capacity());
        if words == 0 {
            return;
        }
        let scatter = shader == Shader::OrderScatter;
        step.size = [output.texture().width(), output.texture().height()];
        let layout = self.pipelines.pass_layout(self.device, shader);
        let pipeline = self.pipelines.render(self.device, Variant::raster(shader, entry));
        // Scatter positions name exact texels. Draw once per touched layer, not again for each
        // partial boundary row. Fullscreen passes instead scissor the exact allocation range.
        let parts: Vec<_> = if scatter {
            (step.destination / LAYER_WORDS..=(step.destination + words - 1) / LAYER_WORDS)
                .map(|layer| Span { at: layer * LAYER_WORDS, offset: 0, words: step.size[0] * step.size[1] * 4 })
                .collect()
        } else {
            spans(step.destination, words).collect()
        };
        for part in parts {
            let at = origin(part.at);
            step.layer = at.z;
            let uniform = self.queue.uniform(self.device, bytemuck::bytes_of(&step));
            let entries: Vec<_> = shader
                .source()
                .pass
                .iter()
                .map(|binding| wgpu::BindGroupEntry {
                    binding: binding.slot,
                    resource: match binding.slot {
                        0 => input.binding(),
                        1 => other.binding(),
                        2 => uniform.as_entire_binding(),
                        _ => unreachable!("a word operation binding"),
                    },
                })
                .collect();
            let bindings = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("latkit word raster"),
                layout: &layout,
                entries: &entries,
            });
            let attachment = output.attachment(at.z);
            let size = part.size();
            let mut pass = self.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(entry),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &attachment,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &self.pipelines.empty, &[]);
            pass.set_bind_group(1, &self.pipelines.empty, &[]);
            pass.set_bind_group(2, &bindings, &[]);
            pass.set_scissor_rect(at.x, at.y, size.width, size.height);
            if scatter {
                pass.draw(0..1, 0..step.count);
            } else {
                pass.draw(0..3, 0..1);
            }
        }
    }

    /// Clears or fills an aligned range without touching any other allocation in its layer.
    /// `unused` is a different store, for the shader's unused sampled bindings.
    pub(crate) fn fill(&mut self, unused: &Words, output: At<'_>, words: u32, value: u32) {
        assert!(words.is_multiple_of(4));
        self.run(
            (Shader::Words, "fill"),
            unused,
            unused,
            output.words,
            WordStep { source: 0, other: 0, destination: output.at, count: words, layer: 0, value, size: [0; 2] },
            words,
        );
    }

    /// Copies each `[from, to, words]` page of `input` into `output`, all multiples of four words,
    /// with one pass per layer of `output` and [`GATHER_PAGES`] pages. A texture copy reads a
    /// framebuffer once per row span, and ANGLE on D3D11 runs each read as a separate blit.
    pub(crate) fn gather(&mut self, input: &Words, output: &Words, pages: &[[u32; 3]]) {
        assert_ne!(input.texture(), output.texture(), "raster input and output must not alias");
        // A page crossing a layer boundary splits there, so each pass writes one layer.
        let mut parts: Vec<[u32; 4]> = Vec::with_capacity(pages.len());
        for &[from, to, words] in pages {
            assert!(from.is_multiple_of(4) && to.is_multiple_of(4) && words.is_multiple_of(4));
            assert!(u64::from(from) + u64::from(words) <= input.capacity());
            assert!(u64::from(to) + u64::from(words) <= output.capacity());
            let mut done = 0;
            while done < words {
                let at = to + done;
                let count = (words - done).min(LAYER_WORDS - at % LAYER_WORDS);
                parts.push([from + done, at, count, 0]);
                done += count;
            }
        }
        if parts.is_empty() {
            return;
        }
        parts.sort_unstable_by_key(|part| part[1]);
        let shader = Shader::WordsGather;
        let layout = self.pipelines.pass_layout(self.device, shader);
        let pipeline = self.pipelines.render(self.device, Variant::raster(shader, "gather"));
        let size = [output.texture().width(), output.texture().height()];
        for layer in parts.chunk_by(|a, b| a[1] / LAYER_WORDS == b[1] / LAYER_WORDS) {
            let index = layer[0][1] / LAYER_WORDS;
            let step = WordStep { source: 0, other: 0, destination: 0, count: 0, layer: index, value: 0, size };
            let params = self.queue.uniform(self.device, bytemuck::bytes_of(&step));
            let attachment = output.attachment(index);
            for group in layer.chunks(GATHER_PAGES as usize) {
                let mut table = Pages { at: [[0; 4]; GATHER_PAGES as usize] };
                table.at[..group.len()].copy_from_slice(group);
                let table = self.queue.uniform(self.device, bytemuck::bytes_of(&table));
                let entries: Vec<_> = shader
                    .source()
                    .pass
                    .iter()
                    .map(|binding| wgpu::BindGroupEntry {
                        binding: binding.slot,
                        resource: match binding.slot {
                            0 | 1 => input.binding(),
                            2 => params.as_entire_binding(),
                            3 => table.as_entire_binding(),
                            _ => unreachable!("a gather binding"),
                        },
                    })
                    .collect();
                let bindings = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("latkit gather"),
                    layout: &layout,
                    entries: &entries,
                });
                let mut pass = self.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("gather"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &attachment,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &self.pipelines.empty, &[]);
                pass.set_bind_group(1, &self.pipelines.empty, &[]);
                pass.set_bind_group(2, &bindings, &[]);
                pass.draw(0..6, 0..group.len() as u32);
            }
        }
    }
}

struct Level {
    totals: Words,
    prefix: Words,
}

/// Scratch for an exclusive scan, under 1/31 of the input size including the scanned totals.
/// A scan emits count + 1 words: each input's start, then the total. It uses linear GPU work,
/// without atomics, workgroup memory, storage buffers, or readback of intermediate totals.
#[derive(Default)]
pub(crate) struct Scan {
    levels: Vec<Level>,
}

impl Scan {
    pub(crate) fn record(&mut self, raster: &mut Raster<'_>, input: At<'_>, output: At<'_>, count: u32) {
        self.reserve(raster, count);
        scan(raster, &self.levels, input, output, count);
    }

    /// Makes room for scans of up to `count` inputs, so smaller scans never make their scratch
    /// again.
    pub(crate) fn reserve(&mut self, raster: &mut Raster<'_>, count: u32) {
        let mut count_at = count;
        let mut level = 0;
        while count_at > SCAN_BLOCK {
            count_at = count_at.div_ceil(SCAN_BLOCK);
            if self.levels.len() == level {
                self.levels.push(Level {
                    totals: Words::new(raster.device, raster.queue.retired(), "latkit scan totals"),
                    prefix: Words::new(raster.device, raster.queue.retired(), "latkit scan prefix"),
                });
            }
            self.levels[level].totals.ensure(raster.device, u64::from(count_at.next_multiple_of(4)));
            self.levels[level].prefix.ensure(raster.device, u64::from((count_at + 1).next_multiple_of(4)));
            level += 1;
        }
    }
}

fn scan(raster: &mut Raster<'_>, levels: &[Level], input: At<'_>, output: At<'_>, count: u32) {
    let mut step =
        WordStep { source: input.at, other: 0, destination: output.at, count, layer: 0, value: 0, size: [0; 2] };
    let other = if count > SCAN_BLOCK {
        let (level, rest) = levels.split_first().expect("a scan hierarchy");
        let blocks = count.div_ceil(SCAN_BLOCK);
        raster.run(
            (Shader::Words, "scan_totals"),
            input.words,
            input.words,
            &level.totals,
            WordStep { destination: 0, ..step },
            blocks.next_multiple_of(4),
        );
        scan(raster, rest, At::new(&level.totals, 0), At::new(&level.prefix, 0), blocks);
        step.value = 1;
        &level.prefix
    } else {
        input.words
    };
    raster.run((Shader::Words, "scan"), input.words, other, output.words, step, (count + 1).next_multiple_of(4));
}

/// An exclusive sum of lengths within each contiguous row. The hierarchy carries the last row
/// and only its trailing sum; no global prefix is subtracted, preserving short local distances.
#[derive(Default)]
pub(crate) struct Lengths {
    levels: Vec<Level>,
}

impl Lengths {
    pub(crate) fn record(&mut self, raster: &mut Raster<'_>, input: At<'_>, output: At<'_>, count: u32) {
        let mut n = count;
        let mut level = 0;
        while n > SCAN_BLOCK {
            n = n.div_ceil(SCAN_BLOCK);
            if self.levels.len() == level {
                self.levels.push(Level {
                    totals: Words::new(raster.device, raster.queue.retired(), "latkit length totals"),
                    prefix: Words::new(raster.device, raster.queue.retired(), "latkit length prefixes"),
                });
            }
            self.levels[level].totals.ensure(raster.device, u64::from(n) * 4);
            self.levels[level].prefix.ensure(raster.device, u64::from(n) * 4);
            level += 1;
        }
        lengths(raster, &self.levels, input, output, count, false);
    }
}

fn lengths(raster: &mut Raster<'_>, levels: &[Level], input: At<'_>, output: At<'_>, count: u32, inclusive: bool) {
    let mut step = WordStep {
        source: input.at,
        other: 0,
        destination: output.at,
        count,
        layer: 0,
        value: u32::from(inclusive) * 2,
        size: [0; 2],
    };
    let other = if count > SCAN_BLOCK {
        let (level, rest) = levels.split_first().expect("length scan hierarchy");
        let blocks = count.div_ceil(SCAN_BLOCK);
        raster.run(
            (Shader::Lengths, "totals"),
            input.words,
            input.words,
            &level.totals,
            WordStep { destination: 0, ..step },
            blocks * 4,
        );
        lengths(raster, rest, At::new(&level.totals, 0), At::new(&level.prefix, 0), blocks, true);
        step.value |= 1;
        &level.prefix
    } else {
        input.words
    };
    raster.run((Shader::Lengths, "scan"), input.words, other, output.words, step, count * 4);
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::gpu::readback::Readback;

    pub(crate) struct Fixture {
        pub(crate) device: wgpu::Device,
        pub(crate) queue: Queue,
        pub(crate) pipelines: Pipelines,
        pub(crate) readbacks: crate::gpu::readback::Readbacks,
    }

    pub(crate) fn fixture() -> Option<Fixture> {
        let result = pollster::block_on(async {
            let backend =
                if std::env::var_os("LATKIT_TEST_GL").is_some() { wgpu::Backends::GL } else { wgpu::Backends::PRIMARY };
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: backend,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapter =
                instance.request_adapter(&wgpu::RequestAdapterOptions::default()).await.map_err(|e| e.to_string())?;
            eprintln!("raster tests: {:?}", adapter.get_info());
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("latkit WebGL2 limits test"),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
                    ..Default::default()
                })
                .await
                .map_err(|e| e.to_string())?;
            device.on_uncaptured_error(std::sync::Arc::new(|error| panic!("{error}")));
            let counters = std::sync::Arc::default();
            let queue = Queue::new(queue, std::sync::Arc::clone(&counters));
            let pipelines = Pipelines::new(&device, std::sync::Arc::clone(&counters), std::sync::Weak::new());
            let readbacks = crate::gpu::readback::Readbacks::counted(counters, queue.retired());
            Ok::<_, String>(Fixture { device, queue, pipelines, readbacks })
        });
        match result {
            Ok(fixture) => Some(fixture),
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => None,
        }
    }

    #[test]
    fn segmented_lengths_reset_at_rows_and_keep_short_local_distances() {
        let Some(mut fixture) = fixture() else { return };
        let (device, queue) = (&fixture.device, &fixture.queue);
        let mut input = Words::new(device, queue.retired(), "test lengths input");
        let mut output = Words::new(device, queue.retired(), "test lengths output");
        let mut scan = Lengths::default();
        for count in [1u32, 63, 64, 65, 4097, 100_003] {
            input.ensure(device, u64::from(count) * 4);
            output.ensure(device, u64::from(count) * 4);
            let mut values = Vec::new();
            let mut expected = Vec::new();
            let (mut row, mut sum) = (0u32, 0.0f32);
            for i in 0..count {
                let current = if i < 4097 { 0 } else { 1 + (i - 4097) / 233 };
                if row != current {
                    row = current;
                    sum = 0.0;
                }
                let length = (i % 7) as f32 + 0.25;
                values.extend([row, length.to_bits(), 0, 0]);
                expected.extend([row, sum.to_bits(), 0, 0]);
                sum += length;
            }
            input.write(queue, 0, &values);
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let mut raster = Raster { device, queue, pipelines: &mut fixture.pipelines, encoder: &mut encoder };
            scan.record(&mut raster, At::new(&input, 0), At::new(&output, 0), count);
            let read = Readback::words(
                &fixture.readbacks,
                device,
                &mut encoder,
                &output,
                0,
                count * 4,
                std::task::Waker::noop(),
            );
            queue.submit([encoder.finish()]);
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(10)),
                })
                .unwrap();
            let bytes = read.take().expect("length readback").unwrap();
            assert_eq!(bytemuck::cast_slice::<u8, u32>(&bytes), expected, "{count} lengths");
        }
    }

    #[test]
    fn raster_scan_preserves_integer_bits_and_sparse_neighbors() {
        let Some(mut fixture) = fixture() else { return };
        let (device, queue) = (&fixture.device, &fixture.queue);
        let mut input = Words::new(device, queue.retired(), "scan input test");
        let mut output = Words::new(device, queue.retired(), "scan output test");
        let mut scratch = Scan::default();
        for n in [0_u32, 1, 3, 4, 63, 64, 65, 1023, 1024, 4096, 8193, 1_000_003] {
            let room = (n + 1).next_multiple_of(4) + 8;
            input.ensure(device, u64::from(room));
            output.ensure(device, u64::from(room));
            let mut data = vec![0_u32; room as usize];
            let mut expected = vec![0xfedc_ba98_u32; room as usize];
            let mut sum = 0_u32;
            for i in 0..n {
                let word = i.wrapping_mul(0x9e37_79b9) ^ 0x8000_0017;
                data[(i + 4) as usize] = word;
                expected[(i + 4) as usize] = sum;
                sum = sum.wrapping_add(word);
            }
            expected[(n + 4) as usize..(room - 4) as usize].fill(sum);
            input.write(queue, 0, &data);
            let mut copy_check = None;
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let mut raster = Raster { device, queue, pipelines: &mut fixture.pipelines, encoder: &mut encoder };
            raster.fill(&input, At::new(&output, 0), room, 0xfedc_ba98);
            if n == 1 {
                raster.run(
                    (Shader::Words, "copy"),
                    &input,
                    &input,
                    &output,
                    WordStep { source: 0, other: 0, destination: 0, count: room, layer: 0, value: 0, size: [0; 2] },
                    room,
                );
                let copied = Readback::words(
                    &fixture.readbacks,
                    device,
                    raster.encoder,
                    &output,
                    0,
                    room,
                    std::task::Waker::noop(),
                );
                raster.fill(&input, At::new(&output, 0), room, 0xfedc_ba98);
                // Keep the mapping alive through submission and check it with this iteration.
                copy_check = Some(copied);
            }
            scratch.record(&mut raster, At::new(&input, 4), At::new(&output, 4), n);
            let read =
                Readback::words(&fixture.readbacks, device, &mut encoder, &output, 0, room, std::task::Waker::noop());
            // An unaligned read starts and ends within texels, and crosses a row in the large cases.
            let middle = Readback::words(
                &fixture.readbacks,
                device,
                &mut encoder,
                &output,
                3,
                room - 6,
                std::task::Waker::noop(),
            );
            let uploaded =
                Readback::words(&fixture.readbacks, device, &mut encoder, &input, 0, room, std::task::Waker::noop());
            queue.submit([encoder.finish()]);
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(10)),
                })
                .unwrap();
            let bytes = uploaded.take().expect("mapped input").unwrap();
            assert_eq!(bytemuck::cast_slice::<u8, u32>(&bytes), data, "input upload for {n} words");
            if let Some(copied) = copy_check {
                let bytes = copied.take().expect("mapped copy").unwrap();
                assert_eq!(bytemuck::cast_slice::<u8, u32>(&bytes), data, "raster copy");
            }
            let bytes = read.take().expect("mapped").unwrap();
            assert_eq!(bytemuck::cast_slice::<u8, u32>(&bytes), expected, "scan of {n} words");
            let bytes = middle.take().expect("mapped").unwrap();
            assert_eq!(bytemuck::cast_slice::<u8, u32>(&bytes), &expected[3..room as usize - 3]);
        }
    }

    #[test]
    fn gather_copies_pages_across_rows_and_layers_and_keeps_neighbors() {
        let Some(mut fixture) = fixture() else { return };
        let (device, queue) = (&fixture.device, &fixture.queue);
        let mut input = Words::new(device, queue.retired(), "gather input test");
        let mut output = Words::new(device, queue.retired(), "gather output test");
        let row = crate::gpu::words::ROW_WORDS;
        let size = LAYER_WORDS + 6 * row;
        input.ensure(device, u64::from(size));
        output.ensure(device, u64::from(size));
        let data: Vec<u32> = (0..size).map(|i| i.wrapping_mul(0x9e37_79b9) ^ 0x5a5a_0003).collect();
        input.write(queue, 0, &data);
        // Pages within a row, across a row, over whole rows up to just before a layer's end, across
        // two layers, and more than one pass takes. The words between pages keep the fill.
        let mut pages = vec![
            [8, 4, 12],
            [row + 4, 2 * row - 8, 24],
            [0, LAYER_WORDS - 2 * row - 20, 2 * row],
            [4 * row, LAYER_WORDS - 16, 48],
        ];
        for i in 0..GATHER_PAGES + 3 {
            pages.push([5 * row + i * 64, 3 * row + i * 96, 64]);
        }
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let mut raster = Raster { device, queue, pipelines: &mut fixture.pipelines, encoder: &mut encoder };
        raster.fill(&input, At::new(&output, 0), size, 0xfedc_ba98);
        raster.gather(&input, &output, &pages);
        let read =
            Readback::words(&fixture.readbacks, device, &mut encoder, &output, 0, size, std::task::Waker::noop());
        queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) })
            .unwrap();
        let mut expected = vec![0xfedc_ba98_u32; size as usize];
        for &[from, to, words] in &pages {
            expected[to as usize..(to + words) as usize].copy_from_slice(&data[from as usize..(from + words) as usize]);
        }
        let bytes = read.take().expect("mapped gather").unwrap();
        assert_eq!(bytemuck::cast_slice::<u8, u32>(&bytes), expected);
    }

    #[test]
    fn raster_radix_is_stable_across_blocks_and_texture_layers() {
        let Some(mut fixture) = fixture() else { return };
        let (device, queue) = (&fixture.device, &fixture.queue);
        let mut input = Words::new(device, queue.retired(), "radix input test");
        let mut output = Words::new(device, queue.retired(), "radix output test");
        let mut order = crate::gpu::order::Order::new(device, queue.retired());
        let sizes = [1_u32, 15, 16, 17, 63, 64, 65, 1_003, 65_539, 600_003];
        // Whole keys, and keys sorted by their low 20 bits only, which then tie more often.
        for (n, bits) in sizes.into_iter().map(|n| (n, 32)).chain([(17, 20), (65_539, 20)]) {
            let room = n * 4 + 8;
            input.ensure(device, u64::from(room));
            output.ensure(device, u64::from(room));
            let mut records: Vec<[u32; 4]> = (0..n)
                .map(|i| {
                    let key = match i % 7 {
                        0 => 0,
                        1 => u32::MAX,
                        2 => 17,
                        _ => i.wrapping_mul(0x9e37_79b9),
                    };
                    [key, i, i ^ 0xff80_0001, !i]
                })
                .collect();
            input.write(queue, 4, bytemuck::cast_slice(&records));
            let mask = u32::MAX >> (32 - bits);
            records.sort_by_key(|record| record[0] & mask);
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let mut raster = Raster { device, queue, pipelines: &mut fixture.pipelines, encoder: &mut encoder };
            raster.fill(&input, At::new(&output, 0), room, 0xfedc_ba98);
            order.record(&mut raster, (At::new(&input, 4), At::new(&output, 4)), n, n, bits);
            let read =
                Readback::words(&fixture.readbacks, device, &mut encoder, &output, 0, room, std::task::Waker::noop());
            queue.submit([encoder.finish()]);
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(10)),
                })
                .unwrap();
            let bytes = read.take().expect("mapped").unwrap();
            let actual: &[[u32; 4]] = bytemuck::cast_slice(&bytes);
            assert_eq!(actual[0], [0xfedc_ba98; 4]);
            assert_eq!(actual[n as usize + 1], [0xfedc_ba98; 4]);
            if let Some(i) = actual[1..=n as usize].iter().zip(&records).position(|(a, b)| a != b) {
                panic!("sort of {n} by {bits} bits, record {i}: {:?} != {:?}", actual[i + 1], records[i]);
            }
        }
    }
}
