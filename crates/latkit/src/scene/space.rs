use crate::Color;

/// The coordinate space a scene's positions are in.
#[derive(Clone, PartialEq, Debug)]
pub enum Space {
    /// Longitude and latitude in degrees, on a map or a globe.
    Earth(Earth),
    /// Plane units, for diagrams and graphs.
    Plane(Plane),
    /// The data's axis across, values up.
    Plot(Plot),
}

impl Default for Space {
    fn default() -> Space {
        Space::Plane(Plane::default())
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
        Earth { projection: Projection::Mercator, surface: None }
    }

    /// A globe.
    pub fn globe() -> Earth {
        Earth { projection: Projection::Globe, surface: None }
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

/// A plane's grid.
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
}

impl Default for Axis {
    fn default() -> Axis {
        Axis { label: None, grid: true, hidden: false }
    }
}
