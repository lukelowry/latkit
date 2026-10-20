use super::Port;
use super::mark::{Context, Drawing, GEOMETRY, MarkKind, Style, mark, style_methods};
use super::marker::Marker;
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Expr, Kind, Name, Result, Size};

mark!(
/// Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram.
///
/// ```
/// # use latkit::{field, Colormap, Vertices};
/// let buses = Vertices::of("grid", "Bus")
///     .position("lon", "lat")
///     .radius(field("kv") / 50.0)
///     .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05));
/// ```
Vertices {
    /// Each row's x and y. Without them, the point field `geometry` names places rows; rows without
    /// either the scene's layout places.
    position: Option<[Expr; 2]>,
    /// The point field placing each row where `position` is not given; `geometry` unless set.
    geometry: Option<Name>,
    /// Height above the ground: on the earth, a fraction of its radius. Not in a diagram, which is
    /// flat.
    elevation: Expr = "crate::scene::mark::zero",
    /// CSS pixels, or position units with `units`; units in a diagram.
    radius: Option<Size>,
    /// Width and height, for markers that are not round: CSS pixels, or position units with `units`;
    /// units in a diagram, where a block without a size fits its label and ports.
    size: Option<[Size; 2]>,
    /// How each row is drawn.
    marker: Marker,
    /// A ring around each row's marker in this color; a missing or transparent color draws none.
    ring: Option<Expr>,
    /// A port on each row for each reference field naming a net, which an `edges` mark of the net
    /// table without ends draws. Diagrams only.
    ports: Vec<(Name, Port)> as "[reference: string, port: Port][]",
    /// Makes each row a group: it holds the rows of `table` whose reference field names it, and is
    /// drawn as a container around them, its label a title in its header. Diagrams only.
    contains: Option<(Name, Name)> as "[table: string, reference: string]",
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
            ports: Vec::new(),
            contains: None,
        }
    }

    /// A port on each row: where the net its reference field `reference` names meets it. An `Edges`
    /// mark of the net table, without ends, draws the nets. Diagrams only.
    #[must_use]
    pub fn port(mut self, reference: impl Into<Name>, port: impl Into<Port>) -> Vertices {
        let reference = reference.into();
        self.ports.retain(|(name, _)| *name != reference);
        self.ports.push((reference, port.into()));
        self
    }

    /// Makes each row a group: it holds the rows of `table` whose reference field `reference` names
    /// it, and draws as a container around them, its label a title in its header. Diagrams only.
    #[must_use]
    pub fn contains(mut self, table: impl Into<Name>, reference: impl Into<Name>) -> Vertices {
        self.contains = Some((table.into(), reference.into()));
        self
    }

    /// The point field placing each row where no position is given; `geometry` unless set.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Vertices {
        self.geometry = Some(field.into());
        self
    }

    /// The point field placing rows without a position.
    pub(crate) fn point_field(&self) -> &str {
        self.geometry.as_deref().unwrap_or(GEOMETRY)
    }

    /// Each row's position. Without one, a point field named `geometry` places rows; rows without
    /// either the scene's layout places, in a diagram or on a plane or the earth.
    #[must_use]
    pub fn position(mut self, x: impl Into<Expr>, y: impl Into<Expr>) -> Vertices {
        self.position = Some([x.into(), y.into()]);
        self
    }

    /// Height above the ground: on the earth, a fraction of its radius. Not in a diagram, which is
    /// flat.
    #[must_use]
    pub fn elevation(mut self, z: impl Into<Expr>) -> Vertices {
        self.elevation = z.into();
        self
    }

    /// Each row's radius: CSS pixels, or position units with [`units`](crate::units); units in a
    /// diagram.
    #[must_use]
    pub fn radius(mut self, radius: impl Into<Size>) -> Vertices {
        self.radius = Some(radius.into());
        self
    }

    /// Each row's width and height, for markers that are not round: CSS pixels, or position units
    /// with [`units`](crate::units); units in a diagram, where a block without a size fits its label
    /// and ports.
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

    /// A ring around each row's marker in this color; a missing or transparent color draws none.
    #[must_use]
    pub fn ring(mut self, color: impl Into<Expr>) -> Vertices {
        self.ring = Some(color.into());
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        let group = self.contains.is_some();
        let inputs = self.marker.inputs();
        if inputs.len() > 8 {
            return Err(crate::Error::invalid("a marker reads at most eight inputs").at("marker"));
        }
        let mut flags = 0;
        if context.diagram() {
            // The sheet says where each row stands and how large it is, from the data alone.
            c.check_structure("position", self.position.iter().flatten())?;
            c.check_structure("size", self.size.iter().flatten().map(|s| &s.expr))?;
            c.check_structure("radius", self.radius.iter().map(|s| &s.expr))?;
            c.derived_position(wgsl::VERTEX_POSITION).map_err(|e| e.at("position"))?;
            for (k, field) in ["half_x", "half_y"].into_iter().enumerate() {
                let store = Store::Size { word: wgsl::VERTEX_HALF + k as u32, units: true, fallback: None };
                c.derived(["width", "height"][k], field, store)?;
            }
            if group {
                c.derived("depth", "depth", Store::Number { word: wgsl::VERTEX_DEPTH, fallback: None })?;
            }
            flags |= wgsl::SIZED;
        } else {
            let at = wgsl::VERTEX_POSITION;
            if context.placed() {
                // The view places rows without a position by the scene's layout, from the data alone.
                c.check_structure("position", self.position.iter().flatten())?;
                c.derived_position(at)
            } else {
                match &self.position {
                    Some([x, y]) => c.position(x, y, at),
                    None if c.kind(self.point_field()) == Some(Kind::Point) => {
                        let field = self.point_field();
                        c.position(&Expr::component(field, 0), &Expr::component(field, 1), at)
                    }
                    None => c.position(&Expr::missing(), &Expr::missing(), at),
                }
            }
            .map_err(|e| e.at("position"))?;
            let half = |word: u32, size: &Size| Store::Size {
                word,
                units: size.units,
                fallback: Some(wgsl::THEME_VERTEX_RADIUS),
            };
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
            c.channel("elevation", &self.elevation, Store::Number { word: wgsl::VERTEX_ELEVATION, fallback: None })?;
        }
        let fallback = if group { wgsl::THEME_SURFACE } else { wgsl::THEME_VERTEX };
        let color = Store::Color { word: wgsl::VERTEX_COLOR, fallback };
        match &self.style.color {
            Some(expr) => c.channel("color", expr, color)?,
            None => c.theme("color", fallback, color)?,
        }
        let visible = Store::Flag { word: wgsl::VERTEX_FLAGS, bit: wgsl::VISIBLE };
        c.channel("visible", &self.style.visible, visible)?;
        if let Some(ring) = &self.ring {
            flags |= wgsl::STATUS;
            c.channel("ring", ring, Store::Color { word: wgsl::VERTEX_STATUS, fallback: wgsl::THEME_CLEAR })?;
        }
        for (i, input) in inputs.iter().enumerate() {
            let store = Store::Number { word: wgsl::VERTEX_WORDS + i as u32, fallback: None };
            c.channel(&format!("input{i}"), input, store).map_err(|e| e.at(i).at("marker"))?;
        }
        let mut ports = Vec::with_capacity(self.ports.len());
        for (reference, port) in &self.ports {
            let column = c.bits(reference).map_err(|e| e.at(reference).at("port"))?;
            ports.push((reference.clone(), port.clone(), column));
        }
        let mut drawing = Drawing::new(MarkKind::Vertices, wgsl::VERTEX_WORDS);
        // A marker's half keeps within its size's pixels, halved where the size is the whole width.
        drawing.size_px = match (&self.size, &self.radius) {
            (Some([w, _]), _) => w.px.map(|px| px / 2.0),
            (None, Some(radius)) => radius.px,
            (None, None) => crate::Size::ANY,
        };
        drawing.markers = self.marker.markers(0);
        if group {
            // A container is a box whatever its marker.
            flags |= wgsl::GROUP;
            drawing.markers.marker = wgsl::MARKER_SHAPE;
            drawing.markers.shape = wgsl::SHAPE_RECTANGLE;
        }
        drawing.flags = flags;
        drawing.extras = inputs.len() as u32;
        drawing.ports = ports;
        drawing.port_label_size = 0.8 * context.theme.font_size;
        Ok(drawing)
    }
}

style_methods!(Vertices);
