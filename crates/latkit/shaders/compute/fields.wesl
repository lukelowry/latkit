// Distance fields of text: the coverage a host set for a run, turned into each texel's signed distance
// to the text's edge, inside positive, as a byte of `0.5 + distance / (2 TEXT_SPREAD)`, over the run
// widened by `TEXT_SPREAD` texels on every side. Partial coverage places the edge within its texel, so
// antialiasing becomes subtexel distance.
//
// A texel's squared distance to the text is the least, over the field's texels, of each one's own (none
// inside the text, a partial texel's subtexel distance squared, far outside it) plus the squared
// distance to it; likewise to what lies outside the text. The least splits into one down each column,
// then one along each row, and only texels within the spread bring a texel within it, so each looks
// that far and no farther: exact wherever the field is not clamped. After the columns, one of a
// texel's two distances is its own, none, so one signed word holds both: to the outside above zero, to
// the text below.

import package::lib::types::{
    TEXT_SPREAD, FIELD_COVERAGE, FIELD_WIDTH, FIELD_HEIGHT, FIELD_COLUMNS, FIELD_AT, FIELD_ROW, FIELD_WORDS,
};

// The runs, `FIELD_WORDS` each, then their coverage, four bytes a word, their columns' least
// distances, and their fields, four texels a word.
@group(2) @binding(0) var<storage, read_write> fields: array<u32>;

// Texels the field reaches past the text, and the column minima a word of four texels reads.
const SPREAD: i32 = i32(TEXT_SPREAD);
const NEAR: i32 = 4 + 2 * SPREAD;
// Farther than any texel within the spread.
const FAR: f32 = 1e20;

struct Run {
    coverage: u32,
    // The coverage's width and height.
    size: vec2u,
    columns: u32,
    at: u32,
    // Words between the starts of the field's rows.
    row: u32,
}

fn run(i: u32) -> Run {
    let w = i * FIELD_WORDS;
    return Run(
        fields[w + FIELD_COVERAGE],
        vec2u(fields[w + FIELD_WIDTH], fields[w + FIELD_HEIGHT]),
        fields[w + FIELD_COLUMNS],
        fields[w + FIELD_AT],
        fields[w + FIELD_ROW],
    );
}

// Texels across and down its field: its coverage's, and the spread on every side.
fn field_size(r: Run) -> vec2u {
    return r.size + vec2u(2u * u32(SPREAD));
}

// Field texel `p`'s own squared distances to the text and to what lies outside it.
fn own(r: Run, p: vec2i) -> vec2f {
    let q = p - vec2i(SPREAD);
    if any(q < vec2i(0)) || any(q >= vec2i(r.size)) {
        return vec2f(FAR, 0.0);
    }
    let i = u32(q.y) * r.size.x + u32(q.x);
    let byte = (fields[r.coverage + i / 4u] >> (8u * (i % 4u))) & 255u;
    if byte == 255u {
        return vec2f(0.0, FAR);
    }
    if byte == 0u {
        return vec2f(FAR, 0.0);
    }
    // The edge lies where coverage is half.
    let d = 0.5 - f32(byte) / 255.0;
    return select(vec2f(0.0, d * d), vec2f(d * d, 0.0), d > 0.0);
}

// Down each column: the least of each texel's own within the spread above and below.
@compute @workgroup_size(16, 16)
fn columns(@builtin(global_invocation_id) id: vec3u) {
    let r = run(id.z);
    let size = field_size(r);
    if any(id.xy >= size) {
        return;
    }
    var least = vec2f(FAR);
    for (var dy = -SPREAD; dy <= SPREAD; dy++) {
        let y = i32(id.y) + dy;
        if y >= 0 && y < i32(size.y) {
            least = min(least, own(r, vec2i(i32(id.x), y)) + f32(dy * dy));
        }
    }
    fields[r.columns + id.y * size.x + id.x] = bitcast<u32>(least.y - least.x);
}

// Along each row, four texels a word: the least of the columns' within the spread to either side,
// then each texel's byte.
@compute @workgroup_size(16, 16)
fn rows(@builtin(global_invocation_id) id: vec3u) {
    let r = run(id.z);
    let size = field_size(r);
    if id.x * 4u >= size.x || id.y >= size.y {
        return;
    }
    // Past the field's edge lies nothing.
    var near: array<vec2f, NEAR>;
    let first = i32(id.x * 4u) - SPREAD;
    for (var k = 0; k < NEAR; k++) {
        let x = first + k;
        var d = vec2f(FAR);
        if x >= 0 && x < i32(size.x) {
            let s = bitcast<f32>(fields[r.columns + id.y * size.x + u32(x)]);
            d = vec2f(max(-s, 0.0), max(s, 0.0));
        }
        near[k] = d;
    }
    var word = 0u;
    for (var t = 0; t < 4; t++) {
        var least = vec2f(FAR);
        for (var k = 0; k <= 2 * SPREAD; k++) {
            let dx = f32(k - SPREAD);
            least = min(least, near[t + k] + dx * dx);
        }
        let d = sqrt(least.y) - sqrt(least.x);
        let byte = u32(floor(clamp(0.5 + d / (2.0 * TEXT_SPREAD), 0.0, 1.0) * 255.0 + 0.5));
        word |= byte << (8u * u32(t));
    }
    fields[r.at + id.y * r.row + id.x] = word;
}
