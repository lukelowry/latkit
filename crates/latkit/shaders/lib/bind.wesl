// Bindings every pipeline shares: group 0 per view and frame, group 1 per mark, group 2 per pass.

import package::lib::types::{Frame, Eye, Mark};
import package::lib::words::{word_read, lane_word};

@group(0) @binding(0) var<uniform> frame: Frame;
// Every mark's compiled program: column descriptors, page tables, code, constants, ends.
@group(0) @binding(1) var program_words: texture_2d_array<u32>;
@group(0) @binding(2) var colormaps: texture_2d_array<f32>;
@group(0) @binding(3) var ramp: sampler;
// The camera the pass draws through.
@group(0) @binding(4) var<uniform> eye: Eye;
// The drawn rows each mark's focus draw lights, starting at the mark's `focused`.
@group(0) @binding(5) var focused_words: texture_2d_array<u32>;

@group(1) @binding(0) var<uniform> mark: Mark;

fn program(at: u32) -> u32 {
    return word_read(program_words, at);
}

fn focused(at: u32) -> u32 {
    return word_read(focused_words, at);
}

// The theme's word in slot `slot`, one of the `THEME_*` slots.
fn theme_word(slot: u32) -> u32 {
    return lane_word(frame.theme[slot / 4u], slot % 4u);
}

// All pages, in blocks allocated by the arena. Data pages hold column values as f32 or u32 words.
// Each mark's pages hold its evaluated row words. Raster passes prepare changes in separate
// textures, then copy those changes here before any draw reads them.
@group(2) @binding(0) var pages: texture_2d_array<u32>;

// Word `at` of the pages.
fn word(at: u32) -> u32 { return word_read(pages, at); }
