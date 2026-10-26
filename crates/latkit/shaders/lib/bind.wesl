// Bindings every pipeline shares: group 0 per view and frame, group 1 per mark, group 2 per pass.

import package::lib::types::{Frame, Eye, Mark};

@group(0) @binding(0) var<uniform> frame: Frame;
// Every mark's compiled program: column descriptors, page tables, code, constants, ends.
@group(0) @binding(1) var<storage, read> program: array<u32>;
@group(0) @binding(2) var colormaps: texture_2d_array<f32>;
@group(0) @binding(3) var ramp: sampler;
// The camera the pass draws through.
@group(0) @binding(4) var<uniform> eye: Eye;
// The drawn rows each mark's focus draw lights, starting at the mark's `focused`.
@group(0) @binding(5) var<storage, read> focused: array<u32>;

@group(1) @binding(0) var<uniform> mark: Mark;

// The theme's word in slot `slot`, one of the `THEME_*` slots.
fn theme_word(slot: u32) -> u32 {
    return frame.theme[slot / 4u][slot % 4u];
}

// All pages, in blocks allocated by the arena. Data pages hold column values as f32 or u32 words.
// Each mark's pages hold its per-row words, which compute passes write and render passes read. A
// pass that sums into them binds them as atomics.
@if(atomic)
@group(2) @binding(0) var<storage, read_write> pages: array<atomic<u32>>;
@elif(writes)
@group(2) @binding(0) var<storage, read_write> pages: array<u32>;
@else
@group(2) @binding(0) var<storage, read> pages: array<u32>;

// Word `at` of the pages.
@if(atomic)
fn word(at: u32) -> u32 {
    return atomicLoad(&pages[at]);
}
@else
fn word(at: u32) -> u32 {
    return pages[at];
}
