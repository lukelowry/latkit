// Bindings every pipeline shares: group 0 per view and frame, group 1 per mark, group 2 per pass.

import package::lib::types::{Frame, Eye, Mark};

@group(0) @binding(0) var<uniform> frame: Frame;
// Data pages: column values as f32 or u32 words, in blocks the arena hands out.
@group(0) @binding(1) var<storage, read> pages: array<u32>;
// Compiled marks: column descriptors, page tables, code, constants, ends.
@group(0) @binding(2) var<storage, read> program: array<u32>;
// Selection and hover bits, one word per row.
@group(0) @binding(3) var<storage, read> focus: array<u32>;
@group(0) @binding(4) var colormaps: texture_2d_array<f32>;
@group(0) @binding(5) var ramp: sampler;
// What the pass draws through, at a dynamic offset.
@group(0) @binding(6) var<uniform> eye: Eye;

@group(1) @binding(0) var<uniform> mark: Mark;

// Evaluated rows of every mark: compute passes write them, render passes read them.
@if(writes)
@group(2) @binding(0) var<storage, read_write> state: array<u32>;
@else
@group(2) @binding(0) var<storage, read> state: array<u32>;
