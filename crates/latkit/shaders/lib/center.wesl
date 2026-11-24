// Where a drawn row lies on screen: the point a screen query locates a row at, and the point its
// label anchors to.

import package::lib::types::{POINTS, STROKES, PATH_TRACE, WordStep};
import package::lib::mark::PRIMITIVE;
import package::lib::project::{to_screen, clip_of};
import package::lib::points::{point, Point};
import package::lib::path::{PATH, path_count};
import package::lib::span::{stroke_span, representative};
import package::lib::triangles::{area_anchor, Corner};
import package::lib::drawn::held_row;

// A row's center on screen in CSS pixels, and whether the row shows there.
struct Center {
    at: vec2f,
    shown: bool,
}

// Point `p`'s center, shown when its row is visible and placed, in front of the eye.
fn point_center(p: Point) -> Center {
    return Center(to_screen(p.clip), p.shown);
}

// Corner `c` on screen, shown when it has a position, in front of the eye and ahead of the globe's
// horizon.
fn corner_center(c: Corner) -> Center {
    let clip = clip_of(c.world);
    return Center(to_screen(clip), c.shown && c.ahead && clip.w > 0.0);
}

// Where drawn row `item` lies on screen: a point's center, the middle of a path's middle segment, a
// trace's last sample, or an area's label anchor (inside its largest polygon).
// The row shows there when it is visible and that point is on screen.
fn row_center(item: u32, params: WordStep) -> Center {
    switch PRIMITIVE {
        case POINTS: {
            return point_center(point(held_row(item), false));
        }
        case STROKES: {
            let count = path_count(item);
            let last = PATH == PATH_TRACE;
            if count == 0u { return Center(vec2f(0.0), false); }
            let span = stroke_span(representative(item, count), params);
            return Center(select(0.5 * (span.ends.xy + span.ends.zw), span.ends.zw, last), span.shown);
        }
        default: {
            return corner_center(area_anchor(held_row(item)));
        }
    }
}
