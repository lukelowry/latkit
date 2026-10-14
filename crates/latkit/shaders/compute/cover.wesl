// The cover pass: each small instance of a covered mark claims the cell under its middle, through the
// same geometry the draws use, so the last one drawn there keeps it: a point at its center, an edge
// at its middle. It counts the claims made in crowded cells and the cells made crowded, which give
// how many instances it covers: whether the mark crowds enough to keep covering.

import package::lib::bind::mark;
import package::lib::project::to_screen;
import package::lib::points::{point, reach};
import package::lib::path::{segment, segment_screen, stroke_style, stroke_instances, stroke_reach};
import package::lib::cover::{cover, claim, UNCLAIMED, CROWDING, LATE};

// This workgroup's claims in crowded cells, and cells it made crowded.
var<workgroup> late_here: atomic<u32>;
var<workgroup> crowded_here: atomic<u32>;

// Adds the workgroup's claims, each thread's having done what `claimed` says, to the mark's counts.
fn tally(local: u32, claimed: u32) {
    if local == 0u {
        atomicStore(&late_here, 0u);
        atomicStore(&crowded_here, 0u);
    }
    workgroupBarrier();
    if claimed == LATE {
        atomicAdd(&late_here, 1u);
    }
    if claimed == CROWDING {
        atomicAdd(&crowded_here, 1u);
    }
    workgroupBarrier();
    let late = atomicLoad(&late_here);
    let crowded = atomicLoad(&crowded_here);
    if local == 0u && late + crowded > 0u {
        atomicAdd(&cover[mark.cover - 2u], late);
        atomicAdd(&cover[mark.cover - 1u], crowded);
    }
}

// Threads take instances last first.
@compute @workgroup_size(256)
fn points(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) local: u32) {
    let n = mark.rows + mark.exits;
    var claimed = UNCLAIMED;
    if id.x < n {
        let instance = n - 1u - id.x;
        let p = point(instance);
        if p.shown {
            let r = reach(p, false);
            claimed = claim(instance, to_screen(p.clip), max(r.x, r.y));
        }
    }
    tally(local, claimed);
}

@compute @workgroup_size(256)
fn strokes(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) local: u32) {
    let n = stroke_instances();
    var claimed = UNCLAIMED;
    if id.x < n {
        let instance = n - 1u - id.x;
        let s = segment(instance);
        let style = stroke_style(s.row);
        let on = segment_screen(s);
        if style.shown && on.shown {
            claimed = claim(instance, 0.5 * (on.a + on.b), stroke_reach(on, style));
        }
    }
    tally(local, claimed);
}
