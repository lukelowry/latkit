use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;

use super::form::{preset_schema, presets};
use super::mark::Markers;
use crate::gpu::shaders as wgsl;
use crate::{Color, Expr, Image};

/// How a vertex is drawn: a shape's name, `"block"`, or
/// `{ shape | block | gauge | pie | icon | wgsl: options }`. An ellipse by default.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = preset_schema::<Marker>)]
pub enum Marker {
    /// A filled shape.
    Shape(Shape),
    /// A rectangle with rounded corners that holds its label inside, as a diagram's blocks do.
    Block {
        /// Corner radius in the space's unit (units in a diagram, CSS pixels elsewhere); the
        /// theme's `diagram.corner` unless set.
        #[serde(default)]
        corner: Option<f32>,
    },
    /// A shape's outline, filled to `fill` from 0 to 1: around a circle, or upward in other shapes.
    Gauge {
        /// How full each row's gauge is, from 0 to 1.
        fill: Expr,
        /// The outline's shape; an ellipse by default.
        #[serde(default)]
        shape: Shape,
    },
    /// A circle divided into slices sized in proportion to their values.
    Pie {
        /// Each slice's value.
        slices: Vec<Expr>,
        /// Each slice's color.
        colors: Vec<Color>,
        /// The hole in the middle, as a fraction of the radius; 0 by default.
        #[serde(default)]
        hole: f32,
    },
    /// One of `images`, fitted to the marker's box; `index` picks the image for each row.
    Icon {
        /// The images.
        images: Vec<Image>,
        /// Each row's image index, from 0.
        index: Expr,
    },
    /// A custom marker in WGSL. `source` defines `fn marker(f: MarkerFragment) -> MarkerColor`,
    /// which can read up to eight `inputs` as `f.input[i]`. It compiles once, when the view first
    /// draws it.
    Wgsl {
        /// The WGSL source of the `marker` function.
        source: Arc<str>,
        /// Each row's inputs, at most eight.
        #[serde(default)]
        inputs: Vec<Expr>,
    },
}

/// A marker's outline.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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

presets!(Marker {
    "ellipse" => Marker::Shape(Shape::Ellipse),
    "rectangle" => Marker::Shape(Shape::Rectangle),
    "rounded" => Marker::Shape(Shape::Rounded),
    "diamond" => Marker::Shape(Shape::Diamond),
    "block" => Marker::block(),
});

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
    /// A block with the theme's corner radius.
    pub fn block() -> Marker {
        Marker::Block { corner: None }
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

    /// How the mark's markers draw, with their inputs starting at extra word `input`.
    pub(crate) fn markers(&self, input: u32) -> Markers {
        let inputs = self.inputs().len() as u32;
        let base = Markers { inputs, input, ..Markers::default() };
        match self {
            Marker::Shape(shape) => Markers { marker: wgsl::MARKER_SHAPE, shape: shape.code(), ..base },
            // A negative corner means the theme's corner radius.
            Marker::Block { corner } => Markers {
                marker: wgsl::MARKER_BLOCK,
                shape: wgsl::SHAPE_ROUNDED,
                corner: corner.unwrap_or(-1.0),
                ..base
            },
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
