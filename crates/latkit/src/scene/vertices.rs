use super::Port;
use super::mark::{Context, Drawing, GEOMETRY, MarkKind, Style, mark, style_methods};
use super::marker::Marker;
use crate::expr::Unit;
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Expr, Kind, Name, Paint, Result, Size};

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
    /// Each row's x and y. Without a position, the point field that `geometry` names places rows,
    /// and the scene's layout places rows that have neither.
    position: Option<[Expr; 2]>,
    /// The point field that places rows when `position` is not set; the field named `geometry` by
    /// default.
    geometry: Option<Name>,
    /// Height above the ground; on the earth, a fraction of the earth's radius. Default 0. Not
    /// allowed in a diagram, which is flat.
    elevation: Expr = "crate::scene::mark::zero",
    /// Each row's radius, in the space's unit (units in a diagram, CSS pixels elsewhere) unless
    /// given with `px` or `units`; a diagram refuses `px`. The theme's `vertex.radius` unless set.
    radius: Option<Size>,
    /// Each row's width and height, for markers that are not round, in the space's unit unless
    /// given with `px` or `units`; a diagram refuses `px`. In a diagram, a block without a size
    /// fits its label and ports.
    size: Option<[Size; 2]>,
    /// How each row is drawn; an ellipse by default.
    marker: Marker,
    /// A ring around each row's marker in this color; a missing or transparent color draws none.
    ring: Option<Paint>,
    /// Ports on each row, one for each reference field that names a net. An `edges` mark of the net
    /// table, without `ends`, draws the nets. Diagrams only.
    ports: Vec<(Name, Port)> as "[reference: string, port: Port][]",
    /// Makes each row a group containing the rows of `table` whose `reference` field names it. A
    /// group draws as a container around its members, with its label as a title in its header.
    /// Diagrams only.
    contains: Option<(Name, Name)> as "[table: string, reference: string]",
    /// Whether each block or group casts a shadow on the sheet, styled by the theme's
    /// `diagram.shadow`. Default `false`. Diagrams only.
    shadow: bool,
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
            shadow: false,
        }
    }

    /// Adds a port on each row for the net that reference field `reference` names, replacing any
    /// earlier port for that field. An [`Edges`](crate::Edges) mark of the net table, without ends,
    /// draws the nets. Diagrams only.
    #[must_use]
    pub fn port(mut self, reference: impl Into<Name>, port: impl Into<Port>) -> Vertices {
        let reference = reference.into();
        self.ports.retain(|(name, _)| *name != reference);
        self.ports.push((reference, port.into()));
        self
    }

    /// Makes each row a group containing the rows of `table` whose `reference` field names it. A
    /// group draws as a container around its members, with its label as a title in its header.
    /// Diagrams only.
    #[must_use]
    pub fn contains(mut self, table: impl Into<Name>, reference: impl Into<Name>) -> Vertices {
        self.contains = Some((table.into(), reference.into()));
        self
    }

    /// Sets the point field that places rows without a position; `geometry` by default.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Vertices {
        self.geometry = Some(field.into());
        self
    }

    /// The point field that places rows without a position.
    pub(crate) fn point_field(&self) -> &str {
        self.geometry.as_deref().unwrap_or(GEOMETRY)
    }

    /// Sets each row's x and y. Without a position, the point field named by
    /// [`geometry`](Vertices::geometry) places rows, and the scene's layout places rows that have
    /// neither, in a diagram or on a plane or the earth.
    #[must_use]
    pub fn position(mut self, x: impl Into<Expr>, y: impl Into<Expr>) -> Vertices {
        self.position = Some([x.into(), y.into()]);
        self
    }

    /// Sets the height above the ground; on the earth, a fraction of the earth's radius. Not
    /// allowed in a diagram, which is flat.
    #[must_use]
    pub fn elevation(mut self, z: impl Into<Expr>) -> Vertices {
        self.elevation = z.into();
        self
    }

    /// Sets each row's radius, in the space's unit (units in a diagram, CSS pixels elsewhere)
    /// unless given with [`px`](crate::px) or [`units`](crate::units); a diagram refuses `px`.
    #[must_use]
    pub fn radius(mut self, radius: impl Into<Size>) -> Vertices {
        self.radius = Some(radius.into());
        self
    }

    /// Sets each row's width and height, for markers that are not round, in the space's unit
    /// unless given with [`px`](crate::px) or [`units`](crate::units); a diagram refuses `px`. In a
    /// diagram, a block without a size fits its label and ports.
    #[must_use]
    pub fn size(mut self, width: impl Into<Size>, height: impl Into<Size>) -> Vertices {
        self.size = Some([width.into(), height.into()]);
        self
    }

    /// Sets how each row is drawn; an ellipse by default.
    #[must_use]
    pub fn marker(mut self, marker: impl Into<Marker>) -> Vertices {
        self.marker = marker.into();
        self
    }

    /// Draws a ring around each row's marker in this color; a missing or transparent color draws
    /// none.
    #[must_use]
    pub fn ring(mut self, color: impl Into<Paint>) -> Vertices {
        self.ring = Some(color.into());
        self
    }

    /// Sets whether each block or group casts a shadow on the sheet, styled by the theme's
    /// [`shadow`](crate::DiagramTheme::shadow). Diagrams only.
    #[must_use]
    pub fn shadow(mut self, on: bool) -> Vertices {
        self.shadow = on;
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        let group = self.contains.is_some();
        let inputs = self.marker.inputs();
        if inputs.len() > 8 {
            return Err(crate::Error::invalid("a marker reads at most eight inputs").at("marker"));
        }
        let mut flags = if context.diagram() {
            self.sheet(c, group)?;
            wgsl::SIZED
        } else {
            self.placed(c, context)?
        };
        let fallback = if group { wgsl::THEME_GROUP } else { wgsl::THEME_VERTEX };
        let color = Store::Color { word: wgsl::VERTEX_COLOR, fallback };
        match &self.style.color {
            Some(paint) => c.channel("color", &paint.0, color)?,
            None => c.theme("color", fallback, color)?,
        }
        let visible = Store::Flag { word: wgsl::VERTEX_FLAGS, bit: wgsl::VISIBLE };
        c.channel("visible", &self.style.visible, visible)?;
        if let Some(ring) = &self.ring {
            flags |= wgsl::STATUS;
            c.channel("ring", &ring.0, Store::Color { word: wgsl::VERTEX_STATUS, fallback: wgsl::THEME_CLEAR })?;
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
        // The marker's half-size stays within its size's pixel bounds; a `size` bounds the whole
        // width, so its bounds are halved.
        drawing.size_px = match (&self.size, &self.radius) {
            (Some([w, _]), _) => w.px.map(|px| px / 2.0),
            (None, Some(radius)) => radius.px,
            (None, None) => crate::Size::ANY,
        };
        drawing.markers = self.marker.markers(0);
        if group {
            // A group draws as a rectangle regardless of its marker.
            flags |= wgsl::GROUP;
            drawing.markers.marker = wgsl::MARKER_SHAPE;
            drawing.markers.shape = wgsl::SHAPE_RECTANGLE;
        }
        if self.shadow {
            flags |= wgsl::SHADOW;
        }
        drawing.flags = flags;
        drawing.extras = inputs.len() as u32;
        drawing.ports = ports;
        drawing.port_label_size = 0.8 * context.theme.text.size;
        Ok(drawing)
    }

    /// Compiles positions and sizes in a diagram, which its sheet computes in units from the data
    /// alone.
    fn sheet(&self, c: &mut Compiler<'_>, group: bool) -> Result<()> {
        let mut sizes = self
            .radius
            .iter()
            .map(|size| ("radius", size))
            .chain(self.size.iter().flatten().map(|size| ("size", size)));
        if let Some((option, _)) = sizes.find(|(_, size)| size.unit == Some(Unit::Px)) {
            return Err(Error::invalid("a diagram's blocks are sized in units, not px").at(option));
        }
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
        Ok(())
    }

    /// Compiles positions and sizes outside a diagram. Rows stand at their position, or where the
    /// scene's layout places them from the data alone, and take their size, their radius, or the
    /// theme's radius. Returns the flags: `SIZED` when rows have a width and a height.
    fn placed(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<u32> {
        let at = wgsl::VERTEX_POSITION;
        if context.placed() {
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
            units: size.in_units(false),
            fallback: Some(wgsl::THEME_VERTEX_RADIUS),
        };
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
        c.channel("elevation", &self.elevation, Store::Number { word: wgsl::VERTEX_ELEVATION, fallback: None })?;
        Ok(flags)
    }
}

style_methods!(Vertices);
