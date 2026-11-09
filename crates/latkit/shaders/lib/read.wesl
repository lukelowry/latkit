// Reading columns. Page tables in `program` point at blocks of `pages`, each page holding
// `PAGE_ROWS` rows. A column's pages are its data's pages, or for a paged table the mark's resident
// pages, one per slot. Values stay `u32` bits until arithmetic needs them, because WGSL cannot
// express a missing value as an `f32` constant (NaN).
//
// Reads take every texel they might need and select the answer, with no early return and no
// short-circuit test around a texture read. Branches around texture reads make the D3D compiler
// behind WebGL take several times longer on every shader that reads fields. A read past a table
// reads some texel, which the select discards.

import package::lib::types::{
    NONE, MISSING, COLUMN_WORDS, SAMPLED, STEP, PAGE_BITS, PAGE_MASK, POINT_BITS, POINT_MASK, PATH_PAGE_WORDS,
};
import package::lib::bind::{program, program_words, pages, mark, word};
import package::lib::words::word_quad;

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

// A column's descriptor, in the order of the `COLUMN_` words.
struct Column {
    flags: u32,
    rows: u32,
    table: u32,
    low: u32,
    join: u32,
    t: f32,
}

fn column_of(column: u32) -> Column {
    let at = mark.columns + column * COLUMN_WORDS;
    let a = word_quad(program_words, at);
    let b = word_quad(program_words, at + 4u);
    return Column(a.x, a.y, a.z, a.w, b.x, bitcast<f32>(b.y));
}

// Binary search over `count` items of `stride` words at `at` in `program`. Returns where the last
// item whose word `key` is at most `value` starts, or the first item when none is.
fn last_at_most(at: u32, count: u32, stride: u32, key: u32, value: u32) -> u32 {
    var lo = 0u;
    var hi = count;
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if program(at + mid * stride + key) <= value {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return at + lo * stride;
}

fn page_word(block: u32, offset: u32, fallback: u32) -> u32 {
    return select(word(block + offset), fallback, block == NONE);
}

// The page row `row` lies in, and where in it.
fn page_of(row: u32) -> vec2u {
    return vec2u(row >> PAGE_BITS, row & PAGE_MASK);
}

// A static column's value as (high, low) bits. The low part holds what f32 loses of an f64.
fn static_value(c: Column, row: u32) -> vec2u {
    let at = page_of(row);
    let hi = page_word(program(c.table + at.x), at.y, MISSING);
    let lo = page_word(program(c.low + at.x), at.y, 0u);
    return vec2u(hi, select(lo, 0u, c.low == NONE));
}

// A sampled column's value at the shown coordinate, as bits. Each page of rows has a six-word
// cursor: the block and word of the frame at the shown coordinate, the same for the next frame, and
// both frames' row counts.
fn sample_value(c: Column, row: u32) -> u32 {
    let at = page_of(row);
    let cursor = c.table + at.x * 6u;
    let local = at.y;
    let next = program(cursor + 2u);
    let a = page_word(program(cursor), program(cursor + 1u) + local, MISSING);
    let b = page_word(next, program(cursor + 3u) + local, MISSING);
    let alone = ((c.flags & STEP) != 0u) | (next == NONE) | (local >= program(cursor + 5u)) | missing_bits(a)
        | missing_bits(b);
    let mixed = bitcast<u32>(mix(bitcast<f32>(a), bitcast<f32>(b), c.t));
    return select(select(mixed, a, alone), MISSING, local >= program(cursor + 4u));
}

// A bits column's word, such as a reference's row index. NONE where unwired.
fn bits_value(column: u32, row: u32) -> u32 {
    return column_bits(column_of(column), row);
}

fn column_bits(c: Column, row: u32) -> u32 {
    let at = page_of(row);
    let value = page_word(program(c.table + at.x), at.y, NONE);
    return select(value, NONE, row >= c.rows);
}

// A column's value for `row` as (high, low) bits, through its join when it reads another table.
fn column_value(column: u32, row: u32) -> vec2u {
    let c = column_of(column);
    var r = row;
    if JOINED {
        r = select(bits_value(c.join, row), row, c.join == NONE);
    }
    var value = static_value(c, r);
    if TIMED {
        value = select(value, vec2u(sample_value(c, r), 0u), (c.flags & SAMPLED) != 0u);
    }
    return select(value, vec2u(MISSING, 0u), (r == NONE) | (r >= c.rows));
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
    let c = column_of(column);
    let at = page_of(row);
    let page = c.table + PATH_PAGE_WORDS * at.x;
    let descriptor = word_quad(program_words, page);
    let rows = descriptor.x;
    let pair = word_quad(pages, rows + 2u * at.y);
    let entry = select(pair.xy, pair.zw, (at.y & 1u) != 0u);
    let listed = c.table + descriptor.y + (entry.x >> POINT_BITS);
    let none = (column == NONE) | (row >= c.rows) | (rows == NONE) | (at.y >= descriptor.w);
    return Points(select(listed, 0u, none), select(entry.x & POINT_MASK, 0u, none), select(entry.y, 0u, none));
}

// Address of point `k`. A geometry list can retain it until its pinned pages change.
fn point_address(points: Points, k: u32) -> u32 {
    let i = points.first + k;
    return program(points.blocks + (i >> POINT_BITS)) + 2u * (i & POINT_MASK);
}

fn point_at(at: u32) -> vec2u {
    let pair = word_quad(pages, at);
    return select(pair.xy, pair.zw, (at & 2u) != 0u);
}

// Point `k` of a row's points, as x and y bits.
fn point_bits(points: Points, k: u32) -> vec2u {
    return point_at(point_address(points, k));
}
