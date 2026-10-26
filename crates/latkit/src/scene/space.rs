use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets};

/// The coordinate space of a scene's positions: a name, or
/// `{ plane | diagram | earth | plot: options }`.
///
/// The space sets the unit of lengths that do not name their own: units in a diagram, where a unit
/// is a CSS pixel at zoom 0, and CSS pixels elsewhere. Only a diagram has ports, groups, nets, and
/// orthogonal routes.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Space>)]
pub enum Space {
    /// Longitude and latitude in degrees, on a flat map or a globe.
    Earth(Earth),
    /// Plane units, with elevation; the camera can turn and tilt.
    Plane(Plane),
    /// The data's axis horizontally and values vertically.
    Plot(Plot),
    /// A flat sheet for diagrams: x right and y down, every length in units.
    Diagram(Diagram),
}

impl Presets for Space {
    const NAMES: &'static [&'static str] = &["plane", "diagram", "earth", "plot"];

    fn preset(name: &str) -> Option<Space> {
        Some(match name {
            "plane" => Space::Plane(Plane::default()),
            "diagram" => Space::Diagram(Diagram::default()),
            "earth" => Space::Earth(Earth::default()),
            "plot" => Space::Plot(Plot::default()),
            _ => return None,
        })
    }

    fn options<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Space, D::Error> {
        Space::deserialize(deserializer)
    }
}

impl<'de> Deserialize<'de> for Space {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Space, D::Error> {
        preset_or(deserializer)
    }
}

impl Default for Space {
    fn default() -> Space {
        Space::Plane(Plane::default())
    }
}

impl From<Diagram> for Space {
    fn from(diagram: Diagram) -> Space {
        Space::Diagram(diagram)
    }
}

impl From<Earth> for Space {
    fn from(earth: Earth) -> Space {
        Space::Earth(earth)
    }
}

impl From<Plane> for Space {
    fn from(plane: Plane) -> Space {
        Space::Plane(plane)
    }
}

impl From<Plot> for Space {
    fn from(plot: Plot) -> Space {
        Space::Plot(plot)
    }
}

/// The earth: positions are longitude and latitude in degrees. The ground takes the theme's `earth`
/// colors.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Earth {
    /// A flat web mercator map (`mercator`, the default) or a globe (`globe`).
    pub projection: Projection,
    /// Whether lines of longitude and latitude cross the ground, in the theme's `grid` color.
    /// Default `true`.
    pub graticule: bool,
    /// Lights the earth by the sun's position this many seconds after the Unix epoch, plus the
    /// view's axis coordinate when it has one. The night side darkens the ground and everything on
    /// it, down to the theme's `earth.night` brightness. Unset, the earth is lit evenly.
    pub daylight: Option<f64>,
    /// Whether air glows around the globe, in the theme's `earth.atmosphere` color, brighter on the
    /// day side. Default `false`.
    pub atmosphere: bool,
}

/// How the earth is projected.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Projection {
    /// Web mercator.
    #[default]
    Mercator,
    /// A sphere.
    Globe,
}

impl Earth {
    /// Sets the projection: a flat map or a globe.
    #[must_use]
    pub fn projection(mut self, projection: Projection) -> Earth {
        self.projection = projection;
        self
    }

    /// Lights the earth by the sun's position `seconds` after the Unix epoch, plus the view's axis
    /// coordinate.
    #[must_use]
    pub fn daylight(mut self, seconds: f64) -> Earth {
        self.daylight = Some(seconds);
        self
    }

    /// Sets whether air glows around the globe.
    #[must_use]
    pub fn atmosphere(mut self, on: bool) -> Earth {
        self.atmosphere = on;
        self
    }
}

/// The unit direction toward the sun `seconds` after the Unix epoch, in earth-fixed coordinates: x
/// toward 0° longitude on the equator, y toward 90° east, z toward the north pole. Uses the
/// low-precision formulas of the Astronomical Almanac, accurate to about a hundredth of a degree.
pub(crate) fn sun(seconds: f64) -> [f64; 3] {
    // Days since noon UTC, January 1, 2000.
    let n = seconds / 86_400.0 - 10_957.5;
    let mean = (280.460 + 0.985_647_4 * n).rem_euclid(360.0);
    let anomaly = (357.528 + 0.985_600_3 * n).rem_euclid(360.0).to_radians();
    let ecliptic = (mean + 1.915 * anomaly.sin() + 0.020 * (2.0 * anomaly).sin()).to_radians();
    let tilt = (23.439 - 0.000_000_4 * n).to_radians();
    let ascension = (tilt.cos() * ecliptic.sin()).atan2(ecliptic.cos());
    let declination = (tilt.sin() * ecliptic.sin()).asin();
    let sidereal = (280.460_618_37 + 360.985_647_366_29 * n).rem_euclid(360.0).to_radians();
    let longitude = ascension - sidereal;
    [declination.cos() * longitude.cos(), declination.cos() * longitude.sin(), declination.sin()]
}

impl Default for Earth {
    /// A web mercator map with a graticule, lit evenly, without atmosphere.
    fn default() -> Earth {
        Earth { projection: Projection::Mercator, graticule: true, daylight: None, atmosphere: false }
    }
}

/// A plane: positions are in plane units.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Plane {
    /// The grid drawn under the marks; lines 10 units apart by default.
    pub grid: Grid,
}

impl Default for Plane {
    fn default() -> Plane {
        Plane { grid: Grid::Lines { pitch: 10.0 } }
    }
}

/// A flat sheet for diagrams, seen from straight above; the camera pans and zooms but does not
/// turn. Positions are in units with y down. Lengths are in units too, a unit being a CSS pixel at
/// zoom 0: sizes, padding, ports, strokes, text, and the theme's lengths. Sizes given with `px`,
/// the text halo, the focus glow, and the pick radius stay in CSS pixels. Zooming scales the whole
/// picture. Only a diagram has ports, groups, nets, and orthogonal routes, and the scene's layout
/// places its blocks.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagram {
    /// The grid drawn under the marks; dots 20 units apart by default.
    pub grid: Grid,
}

impl Default for Diagram {
    fn default() -> Diagram {
        Diagram { grid: Grid::Dots { pitch: 20.0, snap: false } }
    }
}

/// A plane's or a diagram's grid: `"off"`, `{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Grid {
    /// No grid.
    Off,
    /// Lines `pitch` units apart, thinned by factors of ten as the view zooms out.
    Lines {
        /// Units between lines.
        pitch: f64,
    },
    /// Dots `pitch` units apart; with `snap`, a diagram's drags snap to them.
    Dots {
        /// Units between dots.
        pitch: f64,
        /// Whether drag positions snap to the dots, in a diagram. Default `false`.
        #[serde(default)]
        snap: bool,
    },
}

/// A plot: x is the data's axis, y the values.
#[derive(Clone, PartialEq, Debug, Default, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Plot {
    /// The horizontal axis.
    pub x: Axis,
    /// The vertical axis.
    pub y: Axis,
}

/// A plot axis.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Axis {
    /// The axis title.
    pub label: Option<String>,
    /// Whether grid lines cross the plot at the ticks. Default `true`.
    pub grid: bool,
    /// Whether the axis is hidden. Default `false`.
    pub hidden: bool,
    /// Tick positions, each a value or `[value, label]`; a tick without a label shows its value.
    /// Unset, ticks fall at round values.
    #[serde(deserialize_with = "ticks")]
    #[schemars(with = "Option<Vec<Tick>>")]
    pub ticks: Ticks,
    /// How tick values are formatted; `auto` by default.
    pub format: Format,
    /// Decimal places of fixed values, or of the significand in scientific and engineering formats,
    /// at most 15. Unset, as many as the tick step needs.
    #[schemars(range(max = 15))]
    pub precision: Option<u8>,
}

/// A tick in JSON: a value, or `[value, label]`.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
enum Tick {
    At(f64),
    Labeled(f64, Option<String>),
}

/// An axis's ticks: each a value and an optional label, which replaces the value as the tick's
/// text.
type Ticks = Option<Vec<(f64, Option<String>)>>;

fn ticks<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Ticks, D::Error> {
    let ticks = Option::<Vec<Tick>>::deserialize(deserializer)?;
    Ok(ticks.map(|ticks| {
        ticks
            .into_iter()
            .map(|tick| match tick {
                Tick::At(v) => (v, None),
                Tick::Labeled(v, label) => (v, label),
            })
            .collect()
    }))
}

impl Default for Axis {
    fn default() -> Axis {
        Axis { label: None, grid: true, hidden: false, ticks: None, format: Format::Auto, precision: None }
    }
}

/// How an axis formats its tick values.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// Fixed decimals, scientific past a million or below a ten-thousandth.
    #[default]
    Auto,
    /// Fixed decimals: `1500.0`.
    Fixed,
    /// A significand and a power of ten: `1.5e3`.
    Scientific,
    /// A significand and a power of ten that is a multiple of three: `1.5e3`, `150e-6`.
    Engineering,
}

#[cfg(test)]
mod tests {
    use super::sun;

    #[test]
    fn sun_position_matches_the_almanac() {
        // Noon UTC at the 2026 June solstice: the sun is over the Tropic of Cancer, near the prime
        // meridian.
        let [x, y, z] = sun(1_782_043_200.0);
        let (declination, longitude) = (z.asin().to_degrees(), y.atan2(x).to_degrees());
        assert!((declination - 23.44).abs() < 0.05, "{declination}");
        assert!(longitude.abs() < 1.0, "{longitude}");
        // Six hours later, it is a quarter turn west.
        let [x, y, _] = sun(1_782_043_200.0 + 6.0 * 3600.0);
        assert!((y.atan2(x).to_degrees() + 90.0).abs() < 1.5);
    }
}
