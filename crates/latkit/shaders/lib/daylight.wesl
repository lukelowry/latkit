// The earth's daylight: how brightly the sun lights a place, down to the theme's night brightness.

import package::lib::types::SPACE_EARTH;
import package::lib::bind::frame;

// Night has fully fallen once the cosine of the sun's zenith angle drops to `-TWILIGHT`.
const TWILIGHT: f32 = 0.1;

// The daylight factor at longitude and latitude `p`, in degrees: 1 by day, easing across the
// terminator down to the night brightness. 1 everywhere when daylight is off or outside the earth.
fn daylight(p: vec2f) -> f32 {
    let sun = frame.sun;
    if frame.space != SPACE_EARTH || dot(sun.xyz, sun.xyz) == 0.0 {
        return 1.0;
    }
    let r = radians(p);
    let n = vec3f(cos(r.y) * cos(r.x), cos(r.y) * sin(r.x), sin(r.y));
    return mix(sun.w, 1.0, smoothstep(-TWILIGHT, TWILIGHT * 0.5, dot(n, sun.xyz)));
}
