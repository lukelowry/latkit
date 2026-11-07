// Identical codes write identical flags, so overlapping requests need no atomic operations.
import package::lib::types::{WordStep, NONE, WORD_WIDTH, WORD_HEIGHT, NUMBER_CODES, CHAR_UNIT, NUMBER_UNIT};
import package::lib::bind::mark;
import package::lib::words::word_quad;
import package::lib::label::Cells;
import package::lib::labels::{run, keeps, claim_key};

@group(2) @binding(18) var metadata: texture_2d_array<u32>;
@group(2) @binding(19) var<uniform> params: WordStep;

struct Request {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) flag: u32,
}

@vertex
fn vertex(@builtin(instance_index) row: u32) -> Request {
    var out: Request;
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    var code: u32;
    if mark.number != NONE {
        // A numeric label shares this bounded alphabet across every row. Keep it resident once
        // per mark, rather than expanding millions of rows into character requests.
        code = row;
        if code >= NUMBER_CODES || (code == CHAR_UNIT && (mark.number & NUMBER_UNIT) == 0u) { return out; }
        out.flag = select(1u, 2u, all(run(code) == vec2u(0u)));
    } else {
        let m = word_quad(metadata, mark.label_metadata + row * 4u);
        code = m.z;
        if (m.w & 6u) == 0u { return out; }
        let c = Cells(vec2i(i32(m.x & 65535u), i32(m.x >> 16u)), vec2i(i32(m.y & 65535u), i32(m.y >> 16u)), 0);
        if (m.w & 1u) != 0u && !keeps(c, claim_key(row)) { return out; }
        out.flag = select(1u, 2u, (m.w & 2u) != 0u);
    }
    if code >= params.count || code / (WORD_WIDTH * WORD_HEIGHT) != params.layer { return out; }
    let p = vec2f(f32(code % WORD_WIDTH), f32(code / WORD_WIDTH % WORD_HEIGHT)) + 0.5;
    out.position = vec4f(p / vec2f(params.size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    return out;
}

@fragment
fn request(v: Request) -> @location(0) vec4u { return vec4u(v.flag, 0u, 0u, 0u); }
