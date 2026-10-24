// The earth's daylight: how lit a place is by the sun, night falling to the theme's brightness.

import package::lib::types::SPACE_EARTH;
import package::lib::bind::frame;

// How far the sun stands below the horizon, in the cosine of its angle, where night has fallen.
const TWILIGHT: f32 = 0.1;

// How lit the earth is at longitude and latitude `p`, in degrees: 1 by day, down to the night's
// brightness, eased across the terminator; 1 everywhere without daylight.
fn daylight(p: vec2f) -> f32 {
    let sun = frame.sun;
    if frame.space != SPACE_EARTH || dot(sun.xyz, sun.xyz) == 0.0 {
        return 1.0;
    }
    let r = radians(p);
    let n = vec3f(cos(r.y) * cos(r.x), cos(r.y) * sin(r.x), sin(r.y));
    return mix(sun.w, 1.0, smoothstep(-TWILIGHT, TWILIGHT * 0.5, dot(n, sun.xyz)));
}
