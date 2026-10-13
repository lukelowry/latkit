use crate::gpu::shaders as wgsl;

/// How a vertex is drawn.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Marker {
    /// A filled shape.
    Shape(Shape),
    /// A block: a rectangle with rounded corners of `corner` CSS pixels, sized for diagrams.
    Block {
        /// Corner radius, CSS pixels.
        corner: f32,
    },
}

/// A marker's outline.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Shape {
    /// An ellipse: a circle when its width and height are equal.
    #[default]
    Ellipse,
    /// A rectangle.
    Rectangle,
    /// A rectangle with rounded corners.
    Rounded,
    /// A diamond.
    Diamond,
}

impl Default for Marker {
    fn default() -> Marker {
        Marker::Shape(Shape::Ellipse)
    }
}

impl From<Shape> for Marker {
    fn from(shape: Shape) -> Marker {
        Marker::Shape(shape)
    }
}

impl Marker {
    /// A circle.
    pub fn disc() -> Marker {
        Marker::Shape(Shape::Ellipse)
    }

    /// A block with 4 pixel corners.
    pub fn block() -> Marker {
        Marker::Block { corner: 4.0 }
    }

    /// `(marker, shape, corner)` words of the mark uniform.
    pub(crate) fn uniform(self) -> (u32, u32, f32) {
        match self {
            Marker::Shape(shape) => (wgsl::MARKER_SHAPE, shape.code(), 0.0),
            Marker::Block { corner } => (wgsl::MARKER_BLOCK, wgsl::SHAPE_ROUNDED, corner),
        }
    }
}

impl Shape {
    fn code(self) -> u32 {
        match self {
            Shape::Ellipse => wgsl::SHAPE_ELLIPSE,
            Shape::Rectangle => wgsl::SHAPE_RECTANGLE,
            Shape::Rounded => wgsl::SHAPE_ROUNDED,
            Shape::Diamond => wgsl::SHAPE_DIAMOND,
        }
    }
}
