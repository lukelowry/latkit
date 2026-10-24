use super::Route;
use super::mark::{Context, Drawing, MarkKind, Stroke, StrokeWords, Style, mark, stroke_methods, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result};

mark!(
/// Rows drawn as strokes between the vertices two reference fields name: branches, links, wires. In a
/// diagram, a row without ends is a net: it joins every vertex port whose reference field names it.
///
/// ```
/// # use latkit::{field, Edges};
/// let branches = Edges::of("grid", "Branch").ends("from", "to").width(field("rating") / 100.0).flow(field("p"));
/// ```
Edges + stroke {
    /// The reference fields naming each row's two vertices.
    ends: Option<(Name, Name)> as "[from: string, to: string]",
    /// A path field of points each row runs through between its ends.
    bends: Option<Name>,
    /// How each row runs between its ends; on the earth geodesic, elsewhere straight, unless set.
    /// Orthogonal routes run around blocks, bends rounded; diagrams only.
    route: Option<Route>,
    /// Whether each row ends in an arrowhead at its second end; a net's at each input it reaches.
    arrows: bool,
    /// Draws each row as a pole from its own vertex down to the ground beneath it, on a plane or the
    /// earth; it has no ends.
    poles: bool,
    /// Draws each row as a net on a plane or the earth: it joins the vertex rows of `table` whose
    /// reference field names it, as a star from their middle to each.
    joins: Option<(Name, Name)> as "[table: string, reference: string]",
});

impl Edges {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Edges {
        Edges {
            style: Style::new(data.into(), table.into()),
            stroke: Stroke::default(),
            ends: None,
            bends: None,
            route: None,
            arrows: false,
            poles: false,
            joins: None,
        }
    }

    /// Draws each row as a net on a plane or the earth: it joins the vertex rows of `table` whose
    /// reference field `reference` names it, as a star from their middle to each. In a diagram nets
    /// join vertex ports instead.
    #[must_use]
    pub fn joins(mut self, table: impl Into<Name>, reference: impl Into<Name>) -> Edges {
        self.joins = Some((table.into(), reference.into()));
        self
    }

    /// Draws each row as a pole: a stroke from the row's own vertex, as the vertex mark drawing the
    /// table places it, down to the ground beneath it, on a plane or the earth. Dashes, comets, picks,
    /// and labels run along it as along any edge.
    #[must_use]
    pub fn poles(mut self) -> Edges {
        self.poles = true;
        self
    }

    /// A path field of points each row runs through between its ends.
    #[must_use]
    pub fn bends(mut self, field: impl Into<Name>) -> Edges {
        self.bends = Some(field.into());
        self
    }

    /// How each row runs between its ends; on the earth geodesic, elsewhere straight, unless set.
    #[must_use]
    pub fn route(mut self, route: Route) -> Edges {
        self.route = Some(route);
        self
    }

    /// Whether each row ends in an arrowhead at its second end; a net's at each input it reaches.
    #[must_use]
    pub fn arrows(mut self, on: bool) -> Edges {
        self.arrows = on;
        self
    }

    /// The reference fields naming each row's two vertices.
    #[must_use]
    pub fn ends(mut self, from: impl Into<Name>, to: impl Into<Name>) -> Edges {
        self.ends = Some((from.into(), to.into()));
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        if self.joins.is_some() {
            if self.ends.is_some() || self.bends.is_some() || self.poles {
                return Err(Error::invalid("a net joins its members: it has no ends, bends, or poles").at("joins"));
            }
        } else if self.poles {
            if self.ends.is_some() || self.bends.is_some() {
                return Err(
                    Error::invalid("a pole stands on its own row's vertex: it has no ends or bends").at("poles")
                );
            }
            // Both ends are the row's own vertex, which lights as its pole does.
            c.own_end(&self.style.table);
            c.own_end(&self.style.table);
        } else if let Some((from, to)) = &self.ends {
            c.end(from).map_err(|e| e.at("ends"))?;
            c.end(to).map_err(|e| e.at("ends"))?;
        } else if self.bends.is_some() {
            return Err(Error::invalid("bends run between ends; name them").at("bends"));
        }
        if let Some(bends) = &self.bends
            && !matches!(c.kind(bends), Some(Kind::Path))
        {
            return Err(Error::invalid("not a path field").at(bends).at("bends"));
        }
        let mut flags = if self.arrows { wgsl::ARROWS } else { 0 };
        let color = Store::Color { word: wgsl::EDGE_COLOR, fallback: wgsl::THEME_EDGE };
        match (&self.style.color, context.theme.edge.color) {
            (Some(paint), _) => c.channel("color", &paint.0, color)?,
            (None, Some(_)) => c.theme("color", wgsl::THEME_EDGE, color)?,
            // A diagram's wires, and nets without ends to blend, take the text color.
            (None, None) if context.diagram() || self.ends.is_none() => {
                c.theme(
                    "color",
                    wgsl::THEME_TEXT,
                    Store::Color { word: wgsl::EDGE_COLOR, fallback: wgsl::THEME_TEXT },
                )?;
            }
            (None, None) => flags |= wgsl::ENDS_COLOR,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::EDGE_FLAGS, bit: wgsl::VISIBLE })?;
        let words = StrokeWords {
            width: wgsl::EDGE_WIDTH,
            flow: wgsl::EDGE_FLOW,
            flags: wgsl::EDGE_FLAGS,
            theme_width: wgsl::THEME_EDGE_WIDTH,
        };
        self.stroke.compile(c, &words, context.diagram())?;
        let mut drawing = Drawing::new(MarkKind::Edges, wgsl::EDGE_WORDS);
        drawing.size_px = self.stroke.px();
        drawing.flags = flags;
        if self.poles {
            drawing.path = wgsl::PATH_POLES;
        } else if self.joins.is_some() {
            // Each net's star runs along the path the view works out from its members.
            drawing.path = wgsl::PATH_GEOMETRY;
            drawing.geometry = c.derived_path("route");
        } else if context.diagram() {
            // Every wire runs along the path its sheet worked out.
            drawing.path = wgsl::PATH_GEOMETRY;
            drawing.geometry = c.derived_path("route");
        } else {
            drawing.geometry = self.bends.as_ref().map_or(wgsl::NONE, |bends| c.path(bends));
            drawing.lane = c.derived_bits("lane");
        }
        Ok(drawing)
    }
}

style_methods!(Edges);
stroke_methods!(Edges);
