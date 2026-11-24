use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;

use super::form::{Presets, preset_schema, presets};
use super::mark::Markers;
use crate::gpu::shaders as wgsl;
use crate::{Color, Expr, Image, Length, Size};

/// How a vertex is drawn: a shape's name, `"block"`, `"none"`, or
/// `{ shape | block | gauge | pie | icon | symbol | wgsl: options }`. Defaults to an ellipse.
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = preset_schema::<Marker>)]
pub enum Marker {
    /// A filled shape.
    Shape(Shape),
    /// Nothing. The row keeps its place, its label, and the edges that end on it, and unless the
    /// mark sets `pick`, the pointer does not reach it.
    None,
    /// A rectangle with rounded corners that holds its label inside where the text fits.
    Block {
        /// Corner radius in CSS pixels. Defaults to the theme's `vertex.corner`.
        #[serde(default)]
        corner: Option<f32>,
    },
    /// A shape's outline, filled to `fill` (0 to 1). A circle fills around its edge, and other
    /// shapes fill upward.
    Gauge {
        /// How full each row's gauge is, from 0 to 1.
        fill: Expr,
        /// The outline's shape. Defaults to an ellipse.
        #[serde(default)]
        shape: Shape,
    },
    /// A circle divided into slices sized in proportion to their values.
    Pie {
        /// Each slice's value.
        slices: Vec<Expr>,
        /// Each slice's color.
        colors: Vec<Color>,
        /// The hole in the middle, as a fraction of the radius. Defaults to 0.
        #[serde(default)]
        hole: f32,
    },
    /// One of `images`, fitted to the marker's box. `index` picks the image for each row.
    Icon {
        /// The images.
        images: Vec<Image>,
        /// Each row's image index, from 0.
        index: Expr,
    },
    /// A drawing in SVG path data, in the row's color, fitted to the square of the marker's
    /// smaller side. `index` picks each row's path. Coordinates run from -1 to 1 across that
    /// square, x right and y down, as SVG has them. With `stroke` the path is stroked at that
    /// width, and without it the path is filled, by the even-odd rule. Each path is set once as a
    /// distance field, so its outline stays sharp as the marker grows, and glows, rings, and picks
    /// follow it.
    Symbol {
        /// The paths, as SVG path data.
        paths: Vec<Arc<str>>,
        /// Each row's path index, from 0. Defaults to 0.
        #[serde(default = "crate::scene::mark::zero")]
        index: Expr,
        /// The stroke's width: a number in CSS pixels, or `{ units }` in position units. Without
        /// it, the path is filled.
        #[serde(default)]
        stroke: Option<Length>,
    },
    /// A custom marker in WGSL. `source` defines `fn marker(f: MarkerFragment) -> MarkerColor`. It
    /// reads the pixel's offset from the vertex in CSS pixels, y up, as `f.p`, half the marker's
    /// size as `f.half`, the row's color as `f.color`, and up to eight `inputs` as `f.input[i]`. It
    /// returns the pixel's straight color and its signed distance in CSS pixels from the outline,
    /// negative inside, which glows and status rings follow. The color's alpha is the pixel's
    /// coverage: latkit blends it as given and smooths no edge, so fade the outline over a pixel, as
    /// `color.a * saturate(0.5 - distance / fwidth(distance))` does. The source may declare its own
    /// functions, types, and constants. Of latkit's shader code, it sees only `MarkerFragment` and
    /// `MarkerColor`. It compiles once, when a view first draws it.
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
    "none" => Marker::None,
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

    /// A symbol of `paths`, SVG path data in a box from -1 to 1, filled. `index` picks each
    /// row's path.
    pub fn symbol<P: Into<Arc<str>>>(paths: impl IntoIterator<Item = P>, index: impl Into<Expr>) -> Marker {
        Marker::Symbol { paths: paths.into_iter().map(Into::into).collect(), index: index.into(), stroke: None }
    }

    /// A symbol stroked at `width` instead of filled. Other markers are unchanged.
    #[must_use]
    pub fn stroke(self, width: impl Into<Length>) -> Marker {
        match self {
            Marker::Symbol { paths, index, .. } => Marker::Symbol { paths, index, stroke: Some(width.into()) },
            other => other,
        }
    }

    /// The expressions each row's marker reads, in input order.
    pub(crate) fn inputs(&self) -> Vec<&Expr> {
        match self {
            Marker::Shape(_) | Marker::Block { .. } | Marker::None => Vec::new(),
            Marker::Gauge { fill, .. } => vec![fill],
            Marker::Pie { slices, .. } => slices.iter().collect(),
            Marker::Icon { index, .. } | Marker::Symbol { index, .. } => vec![index],
            Marker::Wgsl { inputs, .. } => inputs.iter().collect(),
        }
    }

    /// How the mark's markers draw, with their inputs starting at extra word `input`.
    pub(crate) fn markers(&self, input: u32) -> Markers {
        let inputs = self.inputs().len() as u32;
        let base = Markers { inputs, input, marker: self.code(), ..Markers::default() };
        match self {
            Marker::Shape(shape) | Marker::Gauge { shape, .. } => Markers { shape: shape.code(), ..base },
            // A negative corner means the theme's corner radius.
            Marker::Block { corner } => Markers { shape: wgsl::SHAPE_ROUNDED, corner: corner.unwrap_or(-1.0), ..base },
            Marker::Pie { colors, hole, .. } => {
                Markers { hole: *hole, palette: colors.iter().map(|c| c.packed()).collect(), ..base }
            }
            Marker::Icon { images, .. } => Markers { icons: images.clone(), ..base },
            Marker::Symbol { paths, stroke, .. } => Markers { symbols: paths.clone(), stroke: *stroke, ..base },
            Marker::Wgsl { .. } | Marker::None => base,
        }
    }

    /// A custom marker's WGSL, the `marker` hook its shader calls.
    pub(crate) fn hook(&self) -> Option<&std::sync::Arc<str>> {
        match self {
            Marker::Wgsl { source, .. } => Some(source),
            _ => None,
        }
    }

    pub(crate) fn code(&self) -> u32 {
        match self {
            Marker::Shape(_) => wgsl::MARKER_SHAPE,
            Marker::None => wgsl::MARKER_NONE,
            Marker::Symbol { .. } => wgsl::MARKER_SYMBOL,
            Marker::Block { .. } => wgsl::MARKER_BLOCK,
            Marker::Gauge { .. } => wgsl::MARKER_GAUGE,
            Marker::Pie { .. } => wgsl::MARKER_PIE,
            Marker::Icon { .. } => wgsl::MARKER_ICON,
            Marker::Wgsl { .. } => wgsl::MARKER_CUSTOM,
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

/// A marker on a stroke: at a place along each row's path, turned so that its up is the way the
/// path runs there. It lies wholly on the path, so at the start its near edge sits on the start,
/// and at the end its far edge on the end. The stroke stops at its box and goes on after it, as it
/// stops at the markers of its end vertices. A stroke takes at most four, each a shape, an icon,
/// or a symbol.
///
/// JSON takes a shape's name alone, for one at the path's end, or options with a `marker`.
///
/// ```
/// # use latkit::{Edges, Shape, StrokeMarker};
/// let breakers = Edges::of("grid", "Line").ends("from", "to").markers([
///     StrokeMarker::new(Shape::Rectangle).at(0.0).offset(14.0),
///     StrokeMarker::new(Shape::Rectangle).offset(-14.0),
/// ]);
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct StrokeMarker {
    pub(crate) marker: Marker,
    pub(crate) at: Expr,
    pub(crate) offset: Length,
    pub(crate) size: Option<Size>,
    pub(crate) color: Option<Expr>,
    pub(crate) visible: Expr,
}

impl StrokeMarker {
    /// `marker` at the path's end, as large as a vertex's marker, in the stroke's color.
    pub fn new(marker: impl Into<Marker>) -> StrokeMarker {
        StrokeMarker {
            marker: marker.into(),
            at: 1.0.into(),
            offset: Length::Px(0.0),
            size: None,
            color: None,
            visible: true.into(),
        }
    }

    /// Sets how far along each row's path it sits, from 0 at the path's start to 1 at its end. On
    /// a path of one segment that is a fraction of the stroke as drawn, and on a longer one, of
    /// the path between its first and last points. At 0 or 1 it sits on the path's first or last
    /// segment, which must have a length to carry it.
    #[must_use]
    pub fn at(mut self, fraction: impl Into<Expr>) -> StrokeMarker {
        self.at = fraction.into();
        self
    }

    /// Sets how far it moves along the path from its place, toward the path's end.
    #[must_use]
    pub fn offset(mut self, offset: impl Into<Length>) -> StrokeMarker {
        self.offset = offset.into();
        self
    }

    /// Sets its width and height in CSS pixels, unless given in [`units`](crate::units). Defaults
    /// to twice the theme's `vertex.radius`, the size of a vertex's marker.
    #[must_use]
    pub fn size(mut self, size: impl Into<Size>) -> StrokeMarker {
        self.size = Some(size.into());
        self
    }

    /// Sets each row's color. Without one, a marker takes its stroke's color there.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> StrokeMarker {
        self.color = Some(color.into());
        self
    }

    /// Sets which rows show it.
    #[must_use]
    pub fn visible(mut self, visible: impl Into<Expr>) -> StrokeMarker {
        self.visible = visible.into();
        self
    }

    /// Whether it sits at the start of every row's path (`Some(false)`) or at the end
    /// (`Some(true)`), where it reads only its own segment. `None` for any other place, which a
    /// path of several segments measures.
    pub(crate) fn end(&self) -> Option<bool> {
        match &*self.at.0 {
            crate::expr::Node::Number(fraction) if *fraction <= 0.0 => Some(false),
            crate::expr::Node::Number(fraction) if *fraction >= 1.0 => Some(true),
            _ => None,
        }
    }

    /// Every expression in its options.
    pub(crate) fn exprs(&self) -> impl Iterator<Item = &Expr> {
        self.size
            .iter()
            .map(|size| &size.expr)
            .chain([&self.at, &self.visible])
            .chain(&self.color)
            .chain(self.marker.inputs())
    }
}

impl<M: Into<Marker>> From<M> for StrokeMarker {
    fn from(marker: M) -> StrokeMarker {
        StrokeMarker::new(marker)
    }
}

// A stroke marker's options as JSON writes them.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct StrokeMarkerForm {
    /// How it is drawn: a shape, an icon, or a symbol.
    marker: Marker,
    /// How far along each row's path it sits, from 0 at the path's start to 1 at its end. On a
    /// path of one segment that is a fraction of the stroke as drawn, and on a longer one, of the
    /// path between its first and last points. At 0 or 1 it sits on the path's first or last
    /// segment, which must have a length to carry it. Defaults to 1.
    #[serde(default = "at_end")]
    at: Expr,
    /// How far it moves along the path from there, toward the path's end: a number in CSS pixels,
    /// or `{ units }` in position units. Defaults to 0.
    #[serde(default = "nowhere")]
    offset: Length,
    /// Its width and height in CSS pixels, unless given in `units`. Defaults to twice the theme's
    /// `vertex.radius`, the size of a vertex's marker.
    #[serde(default)]
    size: Option<Size>,
    /// Each row's color. Defaults to the stroke's color there.
    #[serde(default)]
    color: Option<Expr>,
    /// Which rows show it. Defaults to all.
    #[serde(default = "crate::scene::mark::yes")]
    visible: Expr,
}

fn nowhere() -> Length {
    Length::Px(0.0)
}

fn at_end() -> Expr {
    1.0.into()
}

impl Presets for StrokeMarker {
    const NAMES: &'static [&'static str] = &["ellipse", "rectangle", "rounded", "diamond"];

    fn preset(name: &str) -> Option<StrokeMarker> {
        Self::NAMES.contains(&name).then(|| Marker::preset(name)).flatten().map(StrokeMarker::new)
    }

    fn options<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<StrokeMarker, D::Error> {
        let form = StrokeMarkerForm::deserialize(deserializer)?;
        Ok(StrokeMarker {
            marker: form.marker,
            at: form.at,
            offset: form.offset,
            size: form.size,
            color: form.color,
            visible: form.visible,
        })
    }
}

impl<'de> Deserialize<'de> for StrokeMarker {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<StrokeMarker, D::Error> {
        super::form::preset_or(deserializer)
    }
}

impl JsonSchema for StrokeMarker {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "StrokeMarker".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut schema = generator.subschema_for::<StrokeMarkerForm>();
        preset_schema::<StrokeMarker>(&mut schema);
        let about = "A marker on a stroke: at a place along each row's path, turned so that its up is the way the \
            path runs there. It lies wholly on the path, so at the start its near edge sits on the start, and at the \
            end its far edge on the end. The stroke stops at its box and goes on after it, as it stops at the \
            markers of its end vertices. A shape's name alone sits at the path's end. A stroke takes at most four, \
            each a shape, an icon, or a symbol.";
        schema.insert("description".into(), about.into());
        schema
    }
}
