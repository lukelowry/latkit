use super::mark::{Drawing, MarkKind, Style, style_methods};
use super::marker::Marker;
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Expr, Kind, Name, Result, Size};

/// Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram.
///
/// ```
/// # use latkit::{field, Colormap, Vertices};
/// let buses = Vertices::of("grid", "Bus")
///     .position("lon", "lat")
///     .radius(field("kv") / 50.0)
///     .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05));
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Vertices {
    pub(crate) style: Style,
    pub(crate) position: Option<[Expr; 2]>,
    pub(crate) elevation: Expr,
    pub(crate) radius: Option<Size>,
    pub(crate) size: Option<[Size; 2]>,
    pub(crate) marker: Marker,
}

impl Vertices {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Vertices {
        Vertices {
            style: Style::new(data.into(), table.into()),
            position: None,
            elevation: 0.0.into(),
            radius: None,
            size: None,
            marker: Marker::default(),
        }
    }

    /// Each row's position. Without one, a point field named `point` places rows, else the
    /// scene's layout does.
    #[must_use]
    pub fn position(mut self, x: impl Into<Expr>, y: impl Into<Expr>) -> Vertices {
        self.position = Some([x.into(), y.into()]);
        self
    }

    /// Height above the ground: on the earth, a fraction of its radius.
    #[must_use]
    pub fn elevation(mut self, z: impl Into<Expr>) -> Vertices {
        self.elevation = z.into();
        self
    }

    /// Each row's radius: CSS pixels, or position units with [`units`](crate::units).
    #[must_use]
    pub fn radius(mut self, radius: impl Into<Size>) -> Vertices {
        self.radius = Some(radius.into());
        self
    }

    /// Each row's width and height, for markers that are not round.
    #[must_use]
    pub fn size(mut self, width: impl Into<Size>, height: impl Into<Size>) -> Vertices {
        self.size = Some([width.into(), height.into()]);
        self
    }

    /// How each row is drawn.
    #[must_use]
    pub fn marker(mut self, marker: impl Into<Marker>) -> Vertices {
        self.marker = marker.into();
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>) -> Result<Drawing> {
        let at = wgsl::VERTEX_POSITION;
        match &self.position {
            Some([x, y]) => c.position(x, y, at),
            None if c.kind("point") == Some(Kind::Geometry(0)) => {
                c.position(&Expr::component("point", 0), &Expr::component("point", 1), at)
            }
            None => c.position(&Expr::missing(), &Expr::missing(), at),
        }
        .map_err(|e| e.at("position"))?;
        let color = Store::Color { word: wgsl::VERTEX_COLOR, fallback: wgsl::THEME_VERTEX };
        match &self.style.color {
            Some(expr) => c.channel("color", expr, color)?,
            None => c.theme("color", wgsl::THEME_VERTEX, color)?,
        }
        let visible = Store::Flag { word: wgsl::VERTEX_FLAGS, bit: wgsl::VISIBLE };
        c.channel("visible", &self.style.visible, visible)?;
        c.channel("elevation", &self.elevation, Store::Number { word: wgsl::VERTEX_ELEVATION, fallback: None })?;
        let half =
            |word: u32, size: &Size| Store::Size { word, units: size.units, fallback: Some(wgsl::THEME_VERTEX_RADIUS) };
        let mut flags = 0;
        match (&self.size, &self.radius) {
            (Some([w, h]), _) => {
                flags |= wgsl::SIZED;
                c.channel("width", &(w.expr.clone() * 0.5), half(wgsl::VERTEX_HALF, w))?;
                c.channel("height", &(h.expr.clone() * 0.5), half(wgsl::VERTEX_HALF + 1, h))?;
            }
            (None, Some(radius)) => c.channel("radius", &radius.expr, half(wgsl::VERTEX_HALF, radius))?,
            (None, None) => {
                let store = Store::Size { word: wgsl::VERTEX_HALF, units: false, fallback: None };
                c.theme("radius", wgsl::THEME_VERTEX_RADIUS, store)?;
            }
        }
        Ok(Drawing {
            kind: MarkKind::Vertices,
            stride: wgsl::VERTEX_WORDS,
            flags,
            marker: self.marker.uniform(),
            trace: wgsl::NONE,
        })
    }
}

style_methods!(Vertices);
