use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets};
use crate::Color;

/// The coordinate space a scene's positions are in: a name, or `{ plane | diagram | earth | plot:
/// options }`. A diagram is a flat sheet seen from straight above: y runs down, and every length is a
/// unit, a CSS pixel at zoom 0, except glow, halo, and pick radius. Only a diagram has ports, groups,
/// nets, orthogonal routes, and layouts.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Space>)]
pub enum Space {
    /// Longitude and latitude in degrees, on a map or a globe.
    Earth(Earth),
    /// Plane units with elevation: graphs and scenes the camera turns and tilts around.
    Plane(Plane),
    /// The data's axis across, values up.
    Plot(Plot),
    /// A sheet for diagrams: x right and y down in units, every length a unit.
    Diagram(Diagram),
}

impl Presets for Space {
    const NAMES: &'static [&'static str] = &["plane", "diagram", "mercator", "globe", "plot"];

    fn preset(name: &str) -> Option<Space> {
        Some(match name {
            "plane" => Space::Plane(Plane::default()),
            "diagram" => Space::Diagram(Diagram::default()),
            "mercator" => Space::Earth(Earth::mercator()),
            "globe" => Space::Earth(Earth::globe()),
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

/// The earth: positions are longitude and latitude in degrees.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Earth {
    /// A flat map or a globe.
    pub projection: Projection,
    /// The ground's color; the theme's surface unless set.
    pub surface: Option<Color>,
    /// Whether lines of longitude and latitude cross the ground, in the theme's grid color.
    pub graticule: bool,
    /// Lit by the sun as it stands this many seconds after the Unix epoch, plus the view's axis
    /// coordinate when it shows one: night falls on the ground and what stands on it, down to the
    /// theme's night. Lit evenly unless set.
    pub daylight: Option<f64>,
    /// Whether air glows around the globe, in the theme's atmosphere color, brighter where it is day.
    pub atmosphere: bool,
}

/// How the earth is drawn.
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
    /// A web mercator map.
    pub fn mercator() -> Earth {
        Earth { projection: Projection::Mercator, surface: None, graticule: true, daylight: None, atmosphere: false }
    }

    /// A globe.
    pub fn globe() -> Earth {
        Earth { projection: Projection::Globe, ..Earth::mercator() }
    }

    /// Lit by the sun as it stands `seconds` after the Unix epoch, plus the view's axis coordinate.
    #[must_use]
    pub fn daylight(mut self, seconds: f64) -> Earth {
        self.daylight = Some(seconds);
        self
    }

    /// Whether air glows around the globe.
    #[must_use]
    pub fn atmosphere(mut self, on: bool) -> Earth {
        self.atmosphere = on;
        self
    }
}

/// The direction toward the sun `seconds` after the Unix epoch, in the earth's frame: x toward 0°
/// longitude on the equator, y toward 90° east, z toward the north pole. The sun's place by the
/// low-precision formulas of the Astronomical Almanac, to a hundredth of a degree.
pub(crate) fn sun(seconds: f64) -> [f64; 3] {
    // Days since noon, January 1, 2000.
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
    fn default() -> Earth {
        Earth::mercator()
    }
}

/// A plane: positions are plane units.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Plane {
    /// The grid under the marks.
    pub grid: Grid,
}

impl Default for Plane {
    fn default() -> Plane {
        Plane { grid: Grid::Lines { pitch: 10.0 } }
    }
}

/// A sheet for diagrams, flat and seen from straight above: the camera pans and zooms. Positions are
/// units with y down, and every length is a unit, a CSS pixel at zoom 0 (sizes, padding, ports,
/// strokes, text, and the theme's), except glow, halo, and pick radius. Zooming scales one fixed
/// picture. Only a diagram has ports, groups, nets, and orthogonal routes; it lays out blocks.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagram {
    /// The grid under the marks.
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
    /// Lines `pitch` units apart, thinned by tens as the view zooms out.
    Lines {
        /// Units between lines.
        pitch: f64,
    },
    /// Dots `pitch` units apart; drags snap to them when `snap`.
    Dots {
        /// Units between dots.
        pitch: f64,
        /// Whether moved vertices snap to the dots.
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
    /// Whether grid lines cross the plot at the ticks.
    pub grid: bool,
    /// Whether the axis is hidden.
    pub hidden: bool,
    /// Ticks at these values, each a value or `[value, label]`, their values written unless labeled;
    /// round values unless set.
    #[serde(deserialize_with = "ticks")]
    #[schemars(with = "Option<Vec<Tick>>")]
    pub ticks: Ticks,
    /// How tick values are written.
    pub format: Format,
    /// Decimals of fixed values, or of the significand of scientific and engineering ones; as many
    /// as the ticks' step needs unless set.
    #[schemars(range(max = 15))]
    pub precision: Option<u8>,
}

/// A tick as written: a value, or `[value, label]`.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
enum Tick {
    At(f64),
    Labeled(f64, Option<String>),
}

/// An axis's ticks: each a value, and the label written there unless its value is.
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

/// How an axis writes its tick values.
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
    fn the_sun_stands_where_the_almanac_puts_it() {
        // Noon UTC at the June solstice of 2026: over the tropic of Cancer, near the prime meridian.
        let [x, y, z] = sun(1_782_043_200.0);
        let (declination, longitude) = (z.asin().to_degrees(), y.atan2(x).to_degrees());
        assert!((declination - 23.44).abs() < 0.05, "{declination}");
        assert!(longitude.abs() < 1.0, "{longitude}");
        // Six hours on, it stands a quarter turn west.
        let [x, y, _] = sun(1_782_043_200.0 + 6.0 * 3600.0);
        assert!((y.atan2(x).to_degrees() + 90.0).abs() < 1.5);
    }
}
