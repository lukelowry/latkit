use super::mark::{Context, Drawing, GEOMETRY, MarkKind, Style, mark, style_methods};
use super::marker::Marker;
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Expr, Kind, Name, Result, Size};

mark!(
/// Rows drawn as markers: points of a map, nodes of a graph.
///
/// ```
/// # use latkit::{field, Colormap, Vertices};
/// let buses = Vertices::of("grid", "Bus")
///     .position(field("lon"), field("lat"))
///     .radius(field("kv") / 50.0)
///     .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05));
/// ```
Vertices("vertices") {
    /// Each row's x and y. Rows without a position are placed by the point field `geometry` names.
    /// The scene's layout places rows that have neither.
    position: Option<[Expr; 2]>,
    /// The point field that places rows when `position` is not set. Defaults to the field named
    /// `geometry`.
    geometry: Option<Name>,
    /// Height above the ground. On the earth, in degrees of arc like every length there (one is about
    /// 111 km). Defaults to 0.
    elevation: Expr = "crate::scene::mark::zero",
    /// Each row's radius in CSS pixels, unless given in `units`. Defaults to the theme's
    /// `vertex.radius`.
    radius: Option<Size>,
    /// Each row's width and height, for markers that are not round. In CSS pixels, unless given in
    /// `units`.
    size: Option<[Size; 2]>,
    /// How each row is drawn. Defaults to an ellipse.
    marker: Marker,
    /// A ring around each row's marker in this color. A missing or transparent color draws no ring.
    ring: Option<Expr>,
});

impl Vertices {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Vertices {
        Vertices {
            style: Style::new(data.into(), table.into()),
            position: None,
            geometry: None,
            elevation: 0.0.into(),
            radius: None,
            size: None,
            marker: Marker::default(),
            ring: None,
        }
    }

    /// Sets the point field that places rows without a position. Defaults to `geometry`.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Vertices {
        self.geometry = Some(field.into());
        self
    }

    /// The point field that places rows without a position.
    pub(crate) fn point_field(&self) -> &str {
        self.geometry.as_deref().unwrap_or(GEOMETRY)
    }

    /// Sets each row's x and y. Rows without a position are placed by the point field named by
    /// [`geometry`](Vertices::geometry). The scene's layout places rows that have neither, on a
    /// plane or the earth.
    #[must_use]
    pub fn position(mut self, x: impl Into<Expr>, y: impl Into<Expr>) -> Vertices {
        self.position = Some([x.into(), y.into()]);
        self
    }

    /// Sets the height above the ground. On the earth, in degrees of arc like every length there.
    #[must_use]
    pub fn elevation(mut self, z: impl Into<Expr>) -> Vertices {
        self.elevation = z.into();
        self
    }

    /// Sets each row's radius in CSS pixels, unless given in [`units`](crate::units).
    #[must_use]
    pub fn radius(mut self, radius: impl Into<Size>) -> Vertices {
        self.radius = Some(radius.into());
        self
    }

    /// Sets each row's width and height, for markers that are not round. In CSS pixels, unless
    /// given in [`units`](crate::units).
    #[must_use]
    pub fn size(mut self, width: impl Into<Size>, height: impl Into<Size>) -> Vertices {
        self.size = Some([width.into(), height.into()]);
        self
    }

    /// Sets how each row is drawn. Defaults to an ellipse.
    #[must_use]
    pub fn marker(mut self, marker: impl Into<Marker>) -> Vertices {
        self.marker = marker.into();
        self
    }

    /// Draws a ring around each row's marker in this color. A missing or transparent color draws
    /// no ring.
    #[must_use]
    pub fn ring(mut self, color: impl Into<Expr>) -> Vertices {
        self.ring = Some(color.into());
        self
    }

    /// Whether its rows may stand above the ground: its elevation is not zero.
    pub(crate) fn raised(&self) -> bool {
        self.elevation != crate::scene::mark::zero()
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        let inputs = self.marker.inputs();
        if inputs.len() > 8 {
            return Err(crate::Error::invalid("a marker reads at most eight inputs").at("marker"));
        }
        let mut flags = self.place(c, context)?;
        let color = Store::Color { word: wgsl::VERTEX_COLOR, fallback: wgsl::THEME_VERTEX };
        match &self.style.color {
            Some(expr) => c.channel("color", expr, color)?,
            None => c.theme("color", wgsl::THEME_VERTEX, color)?,
        }
        let visible = Store::Flag { word: wgsl::VERTEX_FLAGS, bit: wgsl::VISIBLE, unset: true };
        c.channel("visible", &self.style.visible, visible)?;
        if let Some(ring) = &self.ring {
            flags |= wgsl::STATUS;
            c.channel("ring", ring, Store::Color { word: wgsl::VERTEX_STATUS, fallback: wgsl::THEME_CLEAR })?;
        }
        for (i, input) in inputs.iter().enumerate() {
            let store = Store::Number { word: wgsl::VERTEX_WORDS + i as u32, fallback: None };
            c.within("marker", |c| c.within(i, |c| c.channel(&format!("input{i}"), input, store)))?;
        }
        let mut drawing = Drawing::new(MarkKind::Vertices);
        // The marker's half-size stays within its size's pixel bounds. A `size` bounds the full
        // width, so its bounds are halved.
        drawing.size_px = match (&self.size, &self.radius) {
            (Some([w, _]), _) => w.px.map(|px| px / 2.0),
            (None, Some(radius)) => radius.px,
            (None, None) => crate::Size::ANY,
        };
        drawing.markers = self.marker.markers(0);
        drawing.flags = flags;
        drawing.extras = inputs.len() as u32;
        Ok(drawing)
    }

    /// Compiles positions and sizes. Rows sit at their position. With a layout, a row whose data
    /// gives no position sits where the layout placed it, and the position reads only data, since
    /// the layout pins rows by it. Their size is their `size`, their radius, or the theme's radius.
    /// Returns the flags: `SIZED` when rows have a width and a height.
    fn place(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<u32> {
        let (at, laid) = (wgsl::VERTEX_POSITION, context.placed());
        if laid {
            for expr in self.position.iter().flatten() {
                c.check_data("position", expr)?;
            }
        }
        match &self.position {
            Some([x, y]) => c.position(x, y, at, laid),
            None if c.kind(self.point_field()) == Some(Kind::Point) => {
                let field = self.point_field();
                c.position(&Expr::component(field, 0), &Expr::component(field, 1), at, laid)
            }
            None => c.position(&Expr::missing(), &Expr::missing(), at, laid),
        }
        .map_err(|e| e.at("position"))?;
        let half =
            |word: u32, size: &Size| Store::Size { word, units: size.units, fallback: Some(wgsl::THEME_VERTEX_RADIUS) };
        let mut flags = 0;
        match (&self.size, &self.radius) {
            (Some([w, h]), _) => {
                flags |= wgsl::SIZED;
                c.within("size", |c| {
                    c.channel("width", &(w.expr.clone() * 0.5), half(wgsl::VERTEX_HALF, w))?;
                    c.channel("height", &(h.expr.clone() * 0.5), half(wgsl::VERTEX_HALF + 1, h))
                })?;
            }
            (None, Some(radius)) => c.channel("radius", &radius.expr, half(wgsl::VERTEX_HALF, radius))?,
            (None, None) => {
                let store = Store::Size { word: wgsl::VERTEX_HALF, units: false, fallback: None };
                c.theme("radius", wgsl::THEME_VERTEX_RADIUS, store)?;
            }
        }
        c.channel("elevation", &self.elevation, Store::Number { word: wgsl::VERTEX_ELEVATION, fallback: None })?;
        Ok(flags)
    }
}

style_methods!(Vertices);
