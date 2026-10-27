// Reading columns. Page tables in `program` point at blocks of `pages`, each page holding
// `PAGE_ROWS` rows. A column's pages are its data's pages, or for a paged table the mark's resident
// pages, one per slot. Values stay `u32` bits until arithmetic needs them, because WGSL cannot
// express a missing value as an `f32` constant (NaN).

import package::lib::types::{
    NONE, MISSING, COLUMN_WORDS, COLUMN_FLAGS, COLUMN_ROWS, COLUMN_TABLE, COLUMN_LOW, COLUMN_JOIN, COLUMN_T,
    SAMPLED, STEP, PAGE_BITS, PAGE_MASK, POINT_BITS, POINT_MASK, PATH_PAGE_WORDS,
};
import package::lib::bind::{program, mark, word};

// Whether a pipeline's marks read fields of other tables through a join, and fields sampled over
// the axis. Both are set when the pipeline is created, so a scene that uses neither compiles
// neither.
override JOINED: bool = true;
override TIMED: bool = true;

// Whether `x` is missing: NaN or infinite.
fn missing(x: f32) -> bool {
    return missing_bits(bitcast<u32>(x));
}

fn missing_bits(bits: u32) -> bool {
    return (bits & 0x7f800000u) == 0x7f800000u;
}

fn column_word(column: u32, word: u32) -> u32 {
    return program[mark.columns + column * COLUMN_WORDS + word];
}

// Binary search over `count` items of `stride` words at `at` in `program`. Returns where the last
// item whose word `key` is at most `value` starts, or the first item when none is.
fn last_at_most(at: u32, count: u32, stride: u32, key: u32, value: u32) -> u32 {
    var lo = 0u;
    var hi = count;
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if program[at + mid * stride + key] <= value {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return at + lo * stride;
}

fn page_word(block: u32, offset: u32, fallback: u32) -> u32 {
    if block == NONE {
        return fallback;
    }
    return word(block + offset);
}

// The page row `row` lies in, and where in it.
fn page_of(row: u32) -> vec2u {
    return vec2u(row >> PAGE_BITS, row & PAGE_MASK);
}

// A static column's value as (high, low) bits. The low part holds what f32 loses of an f64.
fn static_value(column: u32, row: u32) -> vec2u {
    let at = page_of(row);
    let page = at.x;
    let local = at.y;
    let table = column_word(column, COLUMN_TABLE);
    let hi = page_word(program[table + page], local, MISSING);
    let low = column_word(column, COLUMN_LOW);
    if low == NONE {
        return vec2u(hi, 0u);
    }
    return vec2u(hi, page_word(program[low + page], local, 0u));
}

// A sampled column's value at the shown coordinate, as bits. Each page of rows has a six-word
// cursor: the block and word of the frame at the shown coordinate, the same for the next frame, and
// both frames' row counts.
fn sample_value(column: u32, row: u32) -> u32 {
    let at = page_of(row);
    let cursor = column_word(column, COLUMN_TABLE) + at.x * 6u;
    let local = at.y;
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

// A bits column's word, such as a reference's row index. NONE where unwired.
fn bits_value(column: u32, row: u32) -> u32 {
    if row >= column_word(column, COLUMN_ROWS) {
        return NONE;
    }
    let table = column_word(column, COLUMN_TABLE);
    let at = page_of(row);
    return page_word(program[table + at.x], at.y, NONE);
}

// The row a column reads for `row`: through its join when it reads another table.
fn joined_row(column: u32, row: u32) -> u32 {
    let join = column_word(column, COLUMN_JOIN);
    if !JOINED || join == NONE {
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
    if TIMED && (column_word(column, COLUMN_FLAGS) & SAMPLED) != 0u {
        return vec2u(sample_value(column, r), 0u);
    }
    return static_value(column, r);
}

// One row's points in a geometry column: where its first piece is listed in `program`, its first
// point in that piece, and its point count. A missing point separates parts.
struct Points {
    blocks: u32,
    first: u32,
    count: u32,
}

// Row `row`'s points in geometry column `column`, from its page's row table. A piece holds up to
// `1 << POINT_BITS` points as x and y bits. A row larger than a piece continues into the pieces
// after its first.
fn points_of(column: u32, row: u32) -> Points {
    if column == NONE || row >= column_word(column, COLUMN_ROWS) {
        return Points(0u, 0u, 0u);
    }
    let table = column_word(column, COLUMN_TABLE);
    let at = page_of(row);
    let page = table + PATH_PAGE_WORDS * at.x;
    let rows = program[page];
    if rows == NONE || at.y >= program[page + 3u] {
        return Points(0u, 0u, 0u);
    }
    let entry = word(rows + 2u * at.y);
    let listed = table + program[page + 1u] + (entry >> POINT_BITS);
    return Points(listed, entry & POINT_MASK, word(rows + 2u * at.y + 1u));
}

// Point `k` of a row's points, as x and y bits.
fn point_bits(points: Points, k: u32) -> vec2u {
    let i = points.first + k;
    let at = program[points.blocks + (i >> POINT_BITS)] + 2u * (i & POINT_MASK);
    return vec2u(word(at), word(at + 1u));
}
