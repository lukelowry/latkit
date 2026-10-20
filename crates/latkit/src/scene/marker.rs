use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets};
use super::mark::Markers;
use crate::gpu::shaders as wgsl;
use crate::{Color, Expr, Image};

/// How a vertex is drawn: a shape's name, `"block"`, or `{ shape | block | gauge | pie | icon | wgsl:
/// options }`.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Marker>)]
pub enum Marker {
    /// A filled shape.
    Shape(Shape),
    /// A block: a rectangle with rounded corners of `corner` CSS pixels, sized for diagrams.
    Block {
        /// Corner radius, CSS pixels; 4 unless set.
        #[serde(default = "corner")]
        corner: f32,
    },
    /// A shape's outline, filled to `fill` from 0 to 1: around a circle, up other shapes.
    Gauge {
        /// How full each row's gauge is.
        fill: Expr,
        /// The outline.
        #[serde(default)]
        shape: Shape,
    },
    /// A circle cut into slices, each as large as its value.
    Pie {
        /// Each slice's value.
        slices: Vec<Expr>,
        /// Each slice's color.
        colors: Vec<Color>,
        /// The hole in the middle, as a fraction of the radius.
        #[serde(default)]
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

impl Presets for Marker {
    const NAMES: &'static [&'static str] = &["ellipse", "rectangle", "rounded", "diamond", "block"];

    fn preset(name: &str) -> Option<Marker> {
        Some(match name {
            "ellipse" => Marker::Shape(Shape::Ellipse),
            "rectangle" => Marker::Shape(Shape::Rectangle),
            "rounded" => Marker::Shape(Shape::Rounded),
            "diamond" => Marker::Shape(Shape::Diamond),
            "block" => Marker::block(),
            _ => return None,
        })
    }
}

impl<'de> Deserialize<'de> for Marker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Marker, D::Error> {
        preset_or(deserializer, Marker::deserialize)
    }
}

/// A block's corner radius unless set.
fn corner() -> f32 {
    4.0
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
    /// A block with 4 pixel corners.
    pub fn block() -> Marker {
        Marker::Block { corner: corner() }
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
