// Reading columns: page tables in `program` point at blocks of `pages`. Values stay `u32` bits until
// arithmetic needs them, so a missing value is never an `f32` constant (WGSL cannot represent NaN
// constants).

import package::lib::types::{
    NONE, MISSING, COLUMN_WORDS, COLUMN_FLAGS, COLUMN_ROWS, COLUMN_TABLE, COLUMN_LOW, COLUMN_JOIN, COLUMN_T,
    SAMPLED, STEP, PAGE_BITS, PAGE_MASK,
};
import package::lib::bind::{pages, program, mark};

// Whether `x` is NaN or infinite: missing.
fn missing(x: f32) -> bool {
    return missing_bits(bitcast<u32>(x));
}

fn missing_bits(bits: u32) -> bool {
    return (bits & 0x7f800000u) == 0x7f800000u;
}

fn column_word(column: u32, word: u32) -> u32 {
    return program[mark.columns + column * COLUMN_WORDS + word];
}

fn page_word(block: u32, offset: u32, fallback: u32) -> u32 {
    if block == NONE {
        return fallback;
    }
    return pages[block + offset];
}

// A static column's value as (high, low) bits: the low part carries what f32 drops of an f64.
fn static_value(column: u32, row: u32) -> vec2u {
    let page = row >> PAGE_BITS;
    let local = row & PAGE_MASK;
    let table = column_word(column, COLUMN_TABLE);
    let hi = page_word(program[table + page], local, MISSING);
    let low = column_word(column, COLUMN_LOW);
    if low == NONE {
        return vec2u(hi, 0u);
    }
    return vec2u(hi, page_word(program[low + page], local, 0u));
}

// A sampled column's value at the shown coordinate, as bits. Each row block has a cursor of six
// words: block and word of this frame, block and word of the next frame, and both frames' row counts.
fn sample_value(column: u32, row: u32) -> u32 {
    let cursor = column_word(column, COLUMN_TABLE) + (row >> PAGE_BITS) * 6u;
    let local = row & PAGE_MASK;
    if local >= program[cursor + 4u] {
        return MISSING;
    }
    let a = page_word(program[cursor], program[cursor + 1u] + local, MISSING);
    let flags = column_word(column, COLUMN_FLAGS);
    if (flags & STEP) != 0u || program[cursor + 2u] == NONE || local >= program[cursor + 5u] {
        return a;
    }
    let b = page_word(program[cursor + 2u], program[cursor + 3u] + local, MISSING);
    if missing_bits(a) || missing_bits(b) {
        return a;
    }
    let t = bitcast<f32>(column_word(column, COLUMN_T));
    return bitcast<u32>(mix(bitcast<f32>(a), bitcast<f32>(b), t));
}

// A bits column's word: row indices of a reference, NONE where unwired.
fn bits_value(column: u32, row: u32) -> u32 {
    if row >= column_word(column, COLUMN_ROWS) {
        return NONE;
    }
    let table = column_word(column, COLUMN_TABLE);
    return page_word(program[table + (row >> PAGE_BITS)], row & PAGE_MASK, NONE);
}

// The row a column reads for `row`: through its join when it reads another table.
fn joined_row(column: u32, row: u32) -> u32 {
    let join = column_word(column, COLUMN_JOIN);
    if join == NONE {
        return row;
    }
    return bits_value(join, row);
}

// A column's value for `row` as (high, low) bits.
fn column_value(column: u32, row: u32) -> vec2u {
    let r = joined_row(column, row);
    if r == NONE || r >= column_word(column, COLUMN_ROWS) {
        return vec2u(MISSING, 0u);
    }
    if (column_word(column, COLUMN_FLAGS) & SAMPLED) != 0u {
        return vec2u(sample_value(column, r), 0u);
    }
    return static_value(column, r);
}
