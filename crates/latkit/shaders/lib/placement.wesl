import package::lib::types::{NONE, PLACE_ANCHORS, PLACE_LIT};
import package::lib::bind::mark;
import package::lib::path::{Segment, path_count, path_segment, numbered_segment, lit_segment};
import package::lib::lists::list_total;

// Resolve an atlas instance in paint, focus, or query order.
fn placement(instance: u32, mode: u32) -> Segment {
    var absent: Segment;
    absent.item = NONE;
    var s: Segment;
    if mode == PLACE_ANCHORS {
        let count = path_count(instance);
        if count == 0u { return absent; }
        s = path_segment(instance, count / 2u, 0.0);
    } else if mode == PLACE_LIT {
        s = lit_segment(instance);
        if s.item >= mark.rows || s.index >= path_count(s.item) { return absent; }
    } else {
        if mark.per_row == NONE && instance >= list_total(mark.list) { return absent; }
        s = numbered_segment(instance);
    }
    return s;
}
