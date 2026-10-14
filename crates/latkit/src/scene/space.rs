use crate::Color;

/// The coordinate space a scene's positions are in.
#[derive(Clone, PartialEq, Debug)]
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
#[derive(Clone, PartialEq, Debug)]
pub struct Earth {
    /// A flat map or a globe; changing it between scenes morphs one into the other.
    pub projection: Projection,
    /// The ground's color; `None` takes the theme's.
    pub surface: Option<Color>,
    /// Whether lines of longitude and latitude cross the ground, in the theme's grid color.
    pub graticule: bool,
}

/// How the earth is drawn.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
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
        Earth { projection: Projection::Mercator, surface: None, graticule: true }
    }

    /// A globe.
    pub fn globe() -> Earth {
        Earth { projection: Projection::Globe, surface: None, graticule: true }
    }
}

impl Default for Earth {
    fn default() -> Earth {
        Earth::mercator()
    }
}

/// A plane: positions are plane units.
#[derive(Clone, PartialEq, Debug)]
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
/// picture. Only a diagram has ports, groups, nets, orthogonal routes, and layouts.
#[derive(Clone, PartialEq, Debug)]
pub struct Diagram {
    /// The grid under the marks.
    pub grid: Grid,
}

impl Default for Diagram {
    fn default() -> Diagram {
        Diagram { grid: Grid::Dots { pitch: 20.0, snap: false } }
    }
}

/// A plane's or a diagram's grid.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Grid {
    /// No grid.
    Off,
    /// Lines `pitch` units apart, thinned by tens as the view zooms out.
    Lines {
        /// Units between lines.
        pitch: f64,
    },
    /// Dots `pitch` units apart; editing snaps to them when `snap`.
    Dots {
        /// Units between dots.
        pitch: f64,
        /// Whether moved vertices snap to the dots.
        snap: bool,
    },
}

/// A plot: x is the data's axis, y the values.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Plot {
    /// The horizontal axis.
    pub x: Axis,
    /// The vertical axis.
    pub y: Axis,
}

/// A plot axis.
#[derive(Clone, PartialEq, Debug)]
pub struct Axis {
    /// The axis title.
    pub label: Option<String>,
    /// Whether grid lines cross the plot at the ticks.
    pub grid: bool,
    /// Whether the axis is hidden.
    pub hidden: bool,
    /// Ticks at these values, with these labels or their values written; `None` steps by round values.
    pub ticks: Option<Vec<(f64, Option<String>)>>,
    /// How tick values are written.
    pub format: Format,
    /// Decimals of fixed values, or of the significand of scientific and engineering ones; `None`
    /// takes as many as the ticks' step needs.
    pub precision: Option<u8>,
}

impl Default for Axis {
    fn default() -> Axis {
        Axis { label: None, grid: true, hidden: false, ticks: None, format: Format::Auto, precision: None }
    }
}

/// How an axis writes its tick values.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
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
