use super::Port;
use super::mark::{Drawing, GEOMETRY, MarkKind, Style, style_methods};
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
    pub(crate) status: Option<Expr>,
    pub(crate) ports: Vec<(Name, Port)>,
    pub(crate) members: Option<(Name, Name)>,
    pub(crate) collapsed: Option<Expr>,
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
            status: None,
            ports: Vec::new(),
            members: None,
            collapsed: None,
        }
    }

    /// A port on each row: where the net its reference field `reference` names meets it. An `Edges`
    /// mark of the net table, without ends, draws the nets.
    #[must_use]
    pub fn port(mut self, reference: impl Into<Name>, port: impl Into<Port>) -> Vertices {
        let reference = reference.into();
        self.ports.retain(|(name, _)| *name != reference);
        self.ports.push((reference, port.into()));
        self
    }

    /// Makes each row a group: it holds the rows of `table` whose reference field `reference` names
    /// it, and is drawn around them.
    #[must_use]
    pub fn contains(mut self, table: impl Into<Name>, reference: impl Into<Name>) -> Vertices {
        self.members = Some((table.into(), reference.into()));
        self
    }

    /// Whether each group hides its members inside it; edges to them end at the group. Folding
    /// eases: members move into the group, shrinking and fading.
    #[must_use]
    pub fn collapsed(mut self, collapsed: impl Into<Expr>) -> Vertices {
        self.collapsed = Some(collapsed.into());
        self
    }

    /// Each row's position. Without one, a point field named `geometry` places rows, else the
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

    /// A ring around each row's marker in this color; a missing or transparent color draws none.
    #[must_use]
    pub fn status(mut self, color: impl Into<Expr>) -> Vertices {
        self.status = Some(color.into());
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>) -> Result<Drawing> {
        let at = wgsl::VERTEX_POSITION;
        match &self.position {
            Some([x, y]) => c.position(x, y, at),
            None if c.kind(GEOMETRY) == Some(Kind::Geometry(0)) => {
                c.position(&Expr::component(GEOMETRY, 0), &Expr::component(GEOMETRY, 1), at)
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
        let inputs = self.marker.inputs();
        if inputs.len() > 8 {
            return Err(crate::Error::invalid("a marker reads at most eight inputs").at("marker"));
        }
        // A group's own size is what it shows collapsed, in extra words after the marker's inputs;
        // the groups pass sizes it, in position units, around its members.
        let group = self.members.is_some();
        let own = if group { wgsl::VERTEX_WORDS + inputs.len() as u32 } else { wgsl::VERTEX_HALF };
        let half =
            |word: u32, size: &Size| Store::Size { word, units: size.units, fallback: Some(wgsl::THEME_VERTEX_RADIUS) };
        let mut flags = if group { wgsl::SIZED } else { 0 };
        match (&self.size, &self.radius) {
            (Some([w, h]), _) => {
                flags |= wgsl::SIZED;
                c.channel("width", &(w.expr.clone() * 0.5), half(own, w))?;
                c.channel("height", &(h.expr.clone() * 0.5), half(own + 1, h))?;
            }
            (None, Some(radius)) => {
                c.channel("radius", &radius.expr, half(own, radius))?;
                if group {
                    c.channel("height", &radius.expr, half(own + 1, radius))?;
                }
            }
            (None, None) => {
                for word in if group { own..own + 2 } else { own..own + 1 } {
                    let store = Store::Size { word, units: false, fallback: None };
                    c.theme(if word == own { "radius" } else { "height" }, wgsl::THEME_VERTEX_RADIUS, store)?;
                }
            }
        }
        if group {
            c.in_units(wgsl::VERTEX_HALF..wgsl::VERTEX_HALF + 2);
        }
        if let Some(status) = &self.status {
            flags |= wgsl::STATUS;
            c.channel("status", status, Store::Color { word: wgsl::VERTEX_STATUS, fallback: wgsl::THEME_CLEAR })?;
        }
        for (i, input) in inputs.iter().enumerate() {
            let store = Store::Number { word: wgsl::VERTEX_WORDS + i as u32, fallback: None };
            c.channel(&format!("input{i}"), input, store).map_err(|e| e.at(i).at("marker"))?;
        }
        if let Some(collapsed) = &self.collapsed {
            if self.members.is_none() {
                return Err(crate::Error::invalid("only groups collapse: name what each row contains").at("collapsed"));
            }
            // How far each group folded, which eases like any number.
            let fold = crate::when(collapsed.clone()).then(1.0).otherwise(0.0);
            c.channel("collapsed", &fold, Store::Number { word: wgsl::VERTEX_FOLD, fallback: None })?;
        }
        for (reference, _) in &self.ports {
            if c.kind(reference) != Some(Kind::Reference) {
                return Err(crate::Error::invalid("not a reference field").at(reference).at("port"));
            }
        }
        let mut drawing = Drawing::new(MarkKind::Vertices, wgsl::VERTEX_WORDS);
        drawing.flags = flags;
        drawing.markers = self.marker.markers(0);
        drawing.extras = inputs.len() as u32 + if group { 2 } else { 0 };
        drawing.ports.clone_from(&self.ports);
        drawing.members.clone_from(&self.members);
        Ok(drawing)
    }
}

style_methods!(Vertices);
