// Where a drawn row lies on screen: the point a screen query locates a row at, and the point its
// label anchors to.

import package::lib::types::{POINTS, STROKES, PATH_TRACE, PATH_GEOMETRY};
import package::lib::mark::PRIMITIVE;
import package::lib::project::{to_screen, clip_of};
import package::lib::points::{point, Point};
import package::lib::path::{PATH, path_segment, segment_screen, stroke_style, path_count};
import package::lib::triangles::{triangle_corner, area_anchor, Corner};
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

// Where drawn row `item` lies on screen: a point's center; the middle of a path's middle segment,
// or a trace's last sample; an area's label anchor, inside its largest polygon; or a face's
// centroid. The row shows there when it is visible and that point is on screen.
fn row_center(item: u32) -> Center {
    switch PRIMITIVE {
        case POINTS: {
            return point_center(point(held_row(item)));
        }
        case STROKES: {
            let count = path_count(item);
            let last = PATH == PATH_TRACE;
            let s = path_segment(item, select(count / 2u, max(count, 1u) - 1u, last), 0.0);
            let on = segment_screen(s);
            let shown = count > 0u && on.shown && stroke_style(s.row).shown;
            return Center(select(0.5 * (on.a + on.b), on.b, last), shown);
        }
        default: {
            if PATH == PATH_GEOMETRY {
                return corner_center(area_anchor(held_row(item)));
            }
            var center = Center(vec2f(0.0), true);
            for (var k = 0u; k < 3u; k++) {
                let c = corner_center(triangle_corner(item, k));
                center.at += c.at / 3.0;
                center.shown = center.shown && c.shown;
            }
            return center;
        }
    }
}
