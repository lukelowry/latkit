//! Web Mercator: the projection of the earth's map camera, and of the square its tiles divide.

use std::f64::consts::{FRAC_PI_4, PI, TAU};

/// The latitude Web Mercator reaches, north and south, in degrees: where its square ends.
pub(crate) const MAX_LATITUDE: f64 = 85.051_128_779_806_59;

/// The projected y of `latitude` in degrees, clamped to [`MAX_LATITUDE`]: radians north of the
/// equator.
pub(crate) fn y(latitude: f64) -> f64 {
    let lat = latitude.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
    (FRAC_PI_4 + lat / 2.0).tan().ln()
}

/// The latitude in degrees at projected y `y`, the inverse of [`y`].
pub(crate) fn latitude(y: f64) -> f64 {
    y.sinh().atan().to_degrees()
}

/// How far down the square `latitude` lies, from 0 at its north edge to 1 at its south.
pub(crate) fn down(latitude: f64) -> f64 {
    0.5 - y(latitude) / TAU
}

/// The latitude `t` of the way down the square, the inverse of [`down`].
pub(crate) fn latitude_down(t: f64) -> f64 {
    latitude(PI * (1.0 - 2.0 * t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latitudes_survive_the_round_trip_and_the_square_ends_at_the_limit() {
        for lat in [-80.0, -37.5, 0.0, 12.25, 85.0] {
            assert!((latitude(y(lat)) - lat).abs() < 1e-9, "{lat}");
            assert!((latitude_down(down(lat)) - lat).abs() < 1e-9, "{lat}");
        }
        assert!(down(MAX_LATITUDE).abs() < 1e-12 && (down(-MAX_LATITUDE) - 1.0).abs() < 1e-12);
    }
}
