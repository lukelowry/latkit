use super::Shape;

/// A vertex's port: where a net its reference field names meets it, on one side of its marker.
#[derive(Clone, PartialEq, Debug)]
pub struct Port {
    /// The side it sits on.
    pub side: Side,
    /// Its place among the ports on that side, from the top or the left; in declaration order unless set.
    pub order: Option<u32>,
    /// Its name drawn beside it.
    pub label: Option<String>,
    /// Its marker.
    pub shape: Shape,
}

/// A side of a marker.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Side {
    /// The left side.
    Left,
    /// The right side.
    Right,
    /// The top.
    Top,
    /// The bottom.
    Bottom,
}

impl Port {
    /// A round port on `side`.
    pub fn new(side: Side) -> Port {
        Port { side, order: None, label: None, shape: Shape::Ellipse }
    }
}

impl From<Side> for Port {
    fn from(side: Side) -> Port {
        Port::new(side)
    }
}

impl Side {
    pub(crate) fn code(self) -> u32 {
        match self {
            Side::Left => 0,
            Side::Right => 1,
            Side::Top => 2,
            Side::Bottom => 3,
        }
    }
}
