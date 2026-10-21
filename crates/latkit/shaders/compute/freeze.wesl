// Freezing: what each row of a mark showed when its transition began, gathered into the frozen
// buffer at the row's new place. The remap words list where each new row was (NONE for a row that
// entered), then the rows that left, which fade out past `mark.rows`. Slot words of a mark whose
// ends point at vertices follow them to their new slots.

import package::lib::types::{NONE, ENTERING, item};
import package::lib::bind::{mark, state};

@group(2) @binding(1) var<storage, read_write> frozen: array<u32>;
// At `mark.remap`: the old kind and extra offsets, a mask of slot words, where the slot table
// starts or NONE, then a source row per new row and exit.
@group(2) @binding(12) var<storage, read> remap: array<u32>;

@compute @workgroup_size(256)
fn gather(@builtin(global_invocation_id) id: vec3u) {
    let i = item(id);
    if i >= mark.rows + mark.exits {
        return;
    }
    let old_state = remap[mark.remap];
    let old_extra = remap[mark.remap + 1u];
    let slots = remap[mark.remap + 2u];
    let table = remap[mark.remap + 3u];
    let source = remap[mark.remap + 4u + i];
    let flags = mark.stride - 1u;
    for (var w = 0u; w < mark.stride; w++) {
        var word = 0u;
        if source == NONE {
            word = select(0u, ENTERING, w == flags);
        } else {
            word = state[old_state + source * mark.stride + w];
            if ((slots >> w) & 1u) != 0u && word != NONE && table != NONE {
                word = remap[table + word];
            }
        }
        frozen[mark.frozen + i * mark.stride + w] = word;
    }
    for (var w = 0u; w < mark.extras; w++) {
        var word = 0u;
        if source != NONE {
            word = state[old_extra + source * mark.extras + w];
        }
        frozen[mark.frozen_extra + i * mark.extras + w] = word;
    }
}
