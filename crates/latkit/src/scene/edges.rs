use super::Route;
use super::mark::{Context, Drawing, MarkKind, Stroke, StrokeWords, Style, mark, stroke_methods, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result};

mark!(
/// Rows drawn as strokes between two vertices named by reference fields: branches, links, wires.
/// In a diagram, a row without ends is a net. It joins every vertex port whose reference field
/// names it.
///
/// ```
/// # use latkit::{field, Edges};
/// let branches = Edges::of("grid", "Branch").ends("from", "to").width(field("rating") / 100.0).flow(field("p"));
/// ```
Edges("edges") + stroke {
    /// The reference fields naming each row's two vertices.
    ends: Option<(Name, Name)> as "[from: string, to: string]",
    /// A path field whose points each row passes through between its ends.
    bends: Option<Name>,
    /// How each row runs between its ends. Defaults to geodesic on the earth and straight
    /// elsewhere. `orthogonal` routes around blocks with rounded bends, in diagrams only.
    route: Option<Route>,
    /// Whether each row has an arrowhead at its second end. A net has one at each input it
    /// reaches. Defaults to `false`.
    arrows: bool,
    /// Draws each row as a pole from its own vertex down to the ground, on a plane or the earth.
    /// Poles take no `ends`, `bends`, or `joins`. Defaults to `false`.
    poles: bool,
    /// Draws each row as a net on a plane or the earth. The net joins the vertex rows of `table`
    /// whose `reference` field names it, as a star from their center to each member.
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

    /// Draws each row as a net on a plane or the earth. The net joins the vertex rows of `table`
    /// whose field `reference` names it, as a star from their center to each member. In a diagram,
    /// nets join vertex ports.
    #[must_use]
    pub fn joins(mut self, table: impl Into<Name>, reference: impl Into<Name>) -> Edges {
        self.joins = Some((table.into(), reference.into()));
        self
    }

    /// Draws each row as a pole on a plane or the earth: a stroke from the row's own vertex down to
    /// the ground. The vertex is where the vertex mark of the same table places it. Dashes, comets,
    /// picking, and labels work as on any edge.
    #[must_use]
    pub fn poles(mut self) -> Edges {
        self.poles = true;
        self
    }

    /// Sets a path field whose points each row passes through between its ends.
    #[must_use]
    pub fn bends(mut self, field: impl Into<Name>) -> Edges {
        self.bends = Some(field.into());
        self
    }

    /// Sets how each row runs between its ends. Defaults to geodesic on the earth and straight
    /// elsewhere.
    #[must_use]
    pub fn route(mut self, route: Route) -> Edges {
        self.route = Some(route);
        self
    }

    /// Sets whether each row has an arrowhead at its second end. A net has one at each input it
    /// reaches.
    #[must_use]
    pub fn arrows(mut self, on: bool) -> Edges {
        self.arrows = on;
        self
    }

    /// Sets the reference fields naming each row's two vertices.
    #[must_use]
    pub fn ends(mut self, from: impl Into<Name>, to: impl Into<Name>) -> Edges {
        self.ends = Some((from.into(), to.into()));
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        if self.joins.is_some() {
            if self.ends.is_some() || self.bends.is_some() || self.poles {
                return Err(Error::invalid("a net cannot have ends, bends, or poles").at("joins"));
            }
        } else if self.poles {
            if self.ends.is_some() || self.bends.is_some() {
                return Err(
                    Error::invalid("a pole stands on its own row's vertex and cannot have ends or bends").at("poles")
                );
            }
            // Both ends are the row's own vertex, so the vertex lights up with its pole.
            c.own_end(&self.style.table);
            c.own_end(&self.style.table);
        } else if let Some((from, to)) = &self.ends {
            c.end(from).map_err(|e| e.at("ends"))?;
            c.end(to).map_err(|e| e.at("ends"))?;
        } else if self.bends.is_some() {
            return Err(Error::invalid("bends need ends").at("bends"));
        }
        if let Some(bends) = &self.bends
            && !matches!(c.kind(bends), Some(Kind::Path))
        {
            return Err(Error::invalid("not a path field").at(bends).at("bends"));
        }
        let mut flags = if self.arrows { wgsl::ARROWS } else { 0 };
        // Without a theme edge color, a row with ends outside a diagram whose color is missing
        // blends the colors of its ends.
        let blends = context.theme.edge.color.is_none() && !context.diagram() && self.ends.is_some();
        if blends {
            flags |= wgsl::ENDS_COLOR;
        }
        let fallback = if blends { wgsl::NONE } else { wgsl::THEME_EDGE };
        let color = Store::Color { word: wgsl::EDGE_COLOR, fallback };
        match (&self.style.color, context.theme.edge.color) {
            (Some(expr), _) => c.channel("color", expr, color)?,
            (None, Some(_)) => c.theme("color", wgsl::THEME_EDGE, color)?,
            (None, None) if blends => c.channel("color", &crate::Expr::missing(), color)?,
            // A diagram's wires, and edges without ends to blend (nets and poles), take the text
            // color.
            (None, None) => {
                c.theme(
                    "color",
                    wgsl::THEME_TEXT,
                    Store::Color { word: wgsl::EDGE_COLOR, fallback: wgsl::THEME_TEXT },
                )?;
            }
        }
        c.channel(
            "visible",
            &self.style.visible,
            Store::Flag { word: wgsl::EDGE_FLAGS, bit: wgsl::VISIBLE, unset: true },
        )?;
        let words = StrokeWords {
            width: wgsl::EDGE_WIDTH,
            flow: wgsl::EDGE_FLOW,
            flags: wgsl::EDGE_FLAGS,
            theme_width: wgsl::THEME_EDGE_WIDTH,
        };
        self.stroke.compile(c, &words, context.diagram())?;
        let mut drawing = Drawing::new(MarkKind::Edges);
        drawing.size_px = self.stroke.px();
        drawing.flags = flags;
        if self.joins.is_some() || context.diagram() {
            // A net's star and every wire in a diagram follow the route the view computes.
            drawing.geometry = c.derived_path("route");
        } else if !self.poles {
            drawing.geometry = self.bends.as_ref().map_or(wgsl::NONE, |bends| c.path(bends));
            drawing.lane = c.derived_bits("lane");
        }
        Ok(drawing)
    }
}

style_methods!(Edges);
stroke_methods!(Edges);
