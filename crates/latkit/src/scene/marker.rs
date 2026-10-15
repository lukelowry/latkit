use std::sync::Arc;

use super::mark::Markers;
use crate::gpu::shaders as wgsl;
use crate::{Color, Expr, Image};

/// How a vertex is drawn.
#[derive(Clone, PartialEq, Debug)]
pub enum Marker {
    /// A filled shape.
    Shape(Shape),
    /// A block: a rectangle with rounded corners of `corner` CSS pixels, sized for diagrams.
    Block {
        /// Corner radius, CSS pixels.
        corner: f32,
    },
    /// A shape's outline, filled to `fill` from 0 to 1: around a circle, up other shapes.
    Gauge {
        /// How full each row's gauge is.
        fill: Expr,
        /// The outline.
        shape: Shape,
    },
    /// A circle cut into slices, each as large as its value.
    Pie {
        /// Each slice's value.
        slices: Vec<Expr>,
        /// Each slice's color.
        colors: Vec<Color>,
        /// The hole in the middle, as a fraction of the radius.
        hole: f32,
    },
    /// One of `images`, fitted in the marker's box; `index` picks which for each row.
    Icon {
        /// The images.
        images: Vec<Image>,
        /// Each row's image, from 0.
        index: Expr,
    },
    /// A marker in WGSL: `source` defines `fn marker(f: MarkerFragment) -> MarkerColor`, reading up to
    /// eight `inputs` as `f.input[i]`. It compiles once, when the view first draws it.
    Wgsl {
        /// The function's source.
        source: Arc<str>,
        /// Each row's inputs.
        inputs: Vec<Expr>,
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

    /// The expressions each row's marker reads, in input order.
    pub(crate) fn inputs(&self) -> Vec<&Expr> {
        match self {
            Marker::Shape(_) | Marker::Block { .. } => Vec::new(),
            Marker::Gauge { fill, .. } => vec![fill],
            Marker::Pie { slices, .. } => slices.iter().collect(),
            Marker::Icon { index, .. } => vec![index],
            Marker::Wgsl { inputs, .. } => inputs.iter().collect(),
        }
    }

    /// How the mark's markers draw; inputs start at extra word `input`.
    pub(crate) fn markers(&self, input: u32) -> Markers {
        let inputs = self.inputs().len() as u32;
        let base = Markers { inputs, input, ..Markers::default() };
        match self {
            Marker::Shape(shape) => Markers { marker: wgsl::MARKER_SHAPE, shape: shape.code(), ..base },
            Marker::Block { corner } => {
                Markers { marker: wgsl::MARKER_BLOCK, shape: wgsl::SHAPE_ROUNDED, corner: *corner, ..base }
            }
            Marker::Gauge { shape, .. } => Markers { marker: wgsl::MARKER_GAUGE, shape: shape.code(), ..base },
            Marker::Pie { colors, hole, .. } => Markers {
                marker: wgsl::MARKER_PIE,
                hole: *hole,
                palette: colors.iter().map(|c| c.packed()).collect(),
                ..base
            },
            Marker::Icon { images, .. } => Markers { marker: wgsl::MARKER_ICON, icons: images.clone(), ..base },
            Marker::Wgsl { source, .. } => {
                Markers { marker: wgsl::MARKER_CUSTOM, custom: Some(source.clone()), ..base }
            }
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
