// Text distance fields. For each run, converts the coverage the host rasterized into each texel's
// signed distance to the text's edge (positive inside), stored as the byte
// `0.5 + distance / (2 TEXT_SPREAD)`. The field covers the run plus `TEXT_SPREAD` texels on each
// side. Partial coverage places the edge within its texel, so antialiased edges keep subtexel
// precision.
//
// A texel's squared distance to the text is the minimum, over the field's texels, of each texel's
// own squared distance plus the squared distance to that texel. A texel's own squared distance is 0
// inside the text, its subtexel distance squared where coverage is partial, and effectively
// infinite outside. The distance to the outside works the same way. The minimum splits into a pass
// down each column, then a pass along each row. Only texels within the spread can bring a texel
// within the spread, so each pass looks only that far, which is exact wherever the field is not
// clamped. After the column pass, one of a texel's two distances is always 0, so one signed word
// holds both: the distance to the outside above zero, and to the text below.

import package::lib::types::{
    TEXT_SPREAD, FIELD_COVERAGE, FIELD_WIDTH, FIELD_HEIGHT, FIELD_COLUMNS, FIELD_AT, FIELD_ROW, FIELD_WORDS,
};

// The runs, `FIELD_WORDS` words each, then their coverage (four bytes per word), their column
// minima, and their fields (four texels per word).
@group(2) @binding(0) var<storage, read_write> fields: array<u32>;

// `SPREAD`: texels the field reaches past the text. `NEAR`: column minima read per 4-texel word.
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
    // Words from the start of one field row to the next.
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

// The field's width and height in texels: the coverage plus the spread on every side.
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

// Column pass: for each texel, the least over the texels within the spread above and below it of
// their own squared distance plus the squared vertical distance.
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

// Row pass, four texels per word: for each texel, the least over the column minima within the
// spread to either side of each plus the squared horizontal distance, then the texel's byte.
@compute @workgroup_size(16, 16)
fn rows(@builtin(global_invocation_id) id: vec3u) {
    let r = run(id.z);
    let size = field_size(r);
    if id.x * 4u >= size.x || id.y >= size.y {
        return;
    }
    // Nothing lies past the field's edge.
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
