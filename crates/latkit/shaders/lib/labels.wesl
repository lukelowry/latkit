// Run tables and the screen grid shared by label preparation and drawing.
import package::lib::bind::mark;
import package::lib::words::word_quad;
import package::lib::label::Cells;

@group(2) @binding(13) var labels: texture_2d_array<u32>;
@group(2) @binding(14) var cells: texture_2d<u32>;

fn run(code: u32) -> vec2u {
    return word_quad(labels, mark.runs + 4u * code).xy;
}

// Two full-width integers preserve draw priority without limiting mark or row counts.
fn claim_key(row: u32) -> vec2u {
    return vec2u(mark.index + 1u, row + 1u);
}

fn keeps(c: Cells, key: vec2u) -> bool {
    for (var y = c.first.y; y <= c.last.y; y++) {
        for (var x = c.first.x; x <= c.last.x; x++) {
            if any(textureLoad(cells, vec2i(x, y), 0).xy != key) { return false; }
        }
    }
    return true;
}
