// Probes: the nearest visible row to a point. `nearest` keeps the least key, the distance in
// sixty-fourths of a pixel and then the mark drawn last; `topmost` keeps the last row of that mark at
// that key; `describe` writes where the hit lies. Rows behind what the frame drew are not reached.
// `under` writes the nearest depth drawn around the point, which gestures turn and zoom about.

import package::lib::types::{
    NONE, VISIBLE, PINNED, PLACED, SIZED, VERTEX_HALF, EDGE_WIDTH, MARK_VERTICES, MARK_EDGES, MARK_FACES,
    PROBE_KEY, PROBE_ROW, PROBE_DEPTH, PROBE_X, PROBE_Y, PROBE_UNDER,
};
import package::lib::bind::{frame, mark};
import package::lib::state::{row_at, vertex_at, vertex_slot, edge_at, face_at, Vertex};
import package::lib::project::{project, to_screen, facing};
import package::lib::mark::px;

@group(2) @binding(5) var<storage, read_write> probe: array<atomic<u32>>;
@group(2) @binding(6) var depth: texture_depth_multisampled_2d;

struct Reach {
    distance: f32,
    depth: f32,
    point: vec2f,
}

fn unreached() -> Reach {
    return Reach(1e30, 0.0, vec2f(0.0));
}

fn placed(v: Vertex, clip: vec4f) -> bool {
    return (v.flags & (PINNED | PLACED)) != 0u && facing(v.hi, v.lo) && clip.w > 0.0;
}

fn clip_of(v: Vertex) -> vec4f {
    return project(v.hi, v.lo, v.elevation);
}

// A clip position on screen, with its depth as z.
fn screen(clip: vec4f) -> vec3f {
    return vec3f(to_screen(clip), clip.z / clip.w);
}

// The nearest point of segment `a`–`b` to `p`, depth interpolated.
fn nearest_on(p: vec2f, a: vec3f, b: vec3f) -> vec3f {
    let ab = b.xy - a.xy;
    let t = clamp(dot(p - a.xy, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
    return mix(a, b, t);
}

fn reach(row: u32) -> Reach {
    let p = frame.probe;
    switch mark.kind {
        case MARK_VERTICES: {
            let v = vertex_at(row_at(row));
            let clip = clip_of(v);
            if (v.flags & VISIBLE) == 0u || !placed(v, clip) {
                return unreached();
            }
            var half = px(v.half.x, VERTEX_HALF);
            if (mark.flags & SIZED) != 0u {
                half = max(half, px(v.half.y, VERTEX_HALF + 1u));
            }
            let s = screen(clip);
            return Reach(max(length(p - s.xy) - half, 0.0), s.z, s.xy);
        }
        case MARK_EDGES: {
            let e = edge_at(row_at(row));
            if e.a == NONE || e.b == NONE || (e.flags & VISIBLE) == 0u {
                return unreached();
            }
            let va = vertex_slot(e.a);
            let vb = vertex_slot(e.b);
            let ca = clip_of(va);
            let cb = clip_of(vb);
            if !placed(va, ca) || !placed(vb, cb) {
                return unreached();
            }
            let q = nearest_on(p, screen(ca), screen(cb));
            return Reach(max(length(p - q.xy) - 0.5 * px(e.width, EDGE_WIDTH), 0.0), q.z, q.xy);
        }
        case MARK_FACES: {
            let f = face_at(row_at(row));
            if any(f.corners == vec3u(NONE)) || (f.flags & VISIBLE) == 0u {
                return unreached();
            }
            let va = vertex_slot(f.corners.x);
            let vb = vertex_slot(f.corners.y);
            let vc = vertex_slot(f.corners.z);
            let ca = clip_of(va);
            let cb = clip_of(vb);
            let cc = clip_of(vc);
            if !placed(va, ca) || !placed(vb, cb) || !placed(vc, cc) {
                return unreached();
            }
            let a = screen(ca);
            let b = screen(cb);
            let c = screen(cc);
            let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if abs(area) > 1e-9 {
                let wb = ((p.x - a.x) * (c.y - a.y) - (p.y - a.y) * (c.x - a.x)) / area;
                let wc = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / area;
                if wb >= 0.0 && wc >= 0.0 && wb + wc <= 1.0 {
                    return Reach(0.0, a.z + (b.z - a.z) * wb + (c.z - a.z) * wc, p);
                }
            }
            var q = nearest_on(p, a, b);
            let q2 = nearest_on(p, b, c);
            let q3 = nearest_on(p, c, a);
            q = select(q, q2, length(p - q2.xy) < length(p - q.xy));
            q = select(q, q3, length(p - q3.xy) < length(p - q.xy));
            return Reach(length(p - q.xy), q.z, q.xy);
        }
        default: {
            return unreached();
        }
    }
}

// Whether the frame drew nothing in front of `r`. Depth is reversed: nearer is greater.
fn shown(r: Reach) -> bool {
    let size = vec2f(textureDimensions(depth));
    let texel = vec2i(clamp(r.point * frame.pixel_ratio, vec2f(0.0), size - 1.0));
    return textureLoad(depth, texel, 0) <= r.depth * 1.01 + 1e-7;
}

fn key(row: u32) -> u32 {
    let r = reach(row);
    if !(r.distance <= frame.probe_radius) || !shown(r) {
        return NONE;
    }
    return (min(u32(r.distance * 64.0), 0xffffffu) << 8u) | (255u - min(mark.index, 255u));
}

@compute @workgroup_size(256)
fn nearest(@builtin(global_invocation_id) id: vec3u) {
    if id.x < mark.rows {
        let k = key(id.x);
        if k != NONE {
            atomicMin(&probe[PROBE_KEY], k);
        }
    }
}

@compute @workgroup_size(256)
fn topmost(@builtin(global_invocation_id) id: vec3u) {
    if id.x < mark.rows && key(id.x) == atomicLoad(&probe[PROBE_KEY]) {
        atomicMax(&probe[PROBE_ROW], id.x + 1u);
    }
}

@compute @workgroup_size(1)
fn describe() {
    let k = atomicLoad(&probe[PROBE_KEY]);
    let row = atomicLoad(&probe[PROBE_ROW]);
    if k == NONE || row == 0u || 255u - (k & 255u) != min(mark.index, 255u) {
        return;
    }
    let r = reach(row - 1u);
    atomicStore(&probe[PROBE_DEPTH], bitcast<u32>(r.depth));
    atomicStore(&probe[PROBE_X], bitcast<u32>(r.point.x));
    atomicStore(&probe[PROBE_Y], bitcast<u32>(r.point.y));
}

@compute @workgroup_size(1)
fn under() {
    let size = vec2i(textureDimensions(depth));
    let at = vec2i(frame.probe * frame.pixel_ratio);
    var nearest = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            nearest = max(nearest, textureLoad(depth, clamp(at + vec2i(dx, dy), vec2i(0), size - 1), 0));
        }
    }
    atomicStore(&probe[PROBE_UNDER], bitcast<u32>(nearest));
}
