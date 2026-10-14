use super::Route;
use super::mark::{Context, Drawing, MarkKind, Stroke, StrokeWords, Style, stroke_methods, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result};

/// Rows drawn as strokes between the vertices two reference fields name: branches, links, wires. In a
/// diagram, a row without ends is a net: it joins every vertex port whose reference field names it.
///
/// ```
/// # use latkit::{field, Edges};
/// let branches = Edges::of("grid", "Branch").ends("from", "to").width(field("rating") / 100.0).flow(field("p"));
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Edges {
    pub(crate) style: Style,
    pub(crate) stroke: Stroke,
    pub(crate) ends: Option<(Name, Name)>,
    pub(crate) bends: Option<Name>,
    pub(crate) route: Option<Route>,
    pub(crate) arrows: bool,
}

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
        }
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
        if let Some((from, to)) = &self.ends {
            c.end(from, wgsl::EDGE_FROM).map_err(|e| e.at("ends"))?;
            c.end(to, wgsl::EDGE_TO).map_err(|e| e.at("ends"))?;
        } else if self.bends.is_some() {
            return Err(Error::invalid("bends run between ends; name them").at("bends"));
        }
        if let Some(bends) = &self.bends
            && !matches!(c.kind(bends), Some(Kind::Geometry(1)))
        {
            return Err(Error::invalid("not a path field").at(bends).at("bends"));
        }
        let mut flags = if self.arrows { wgsl::ARROWS } else { 0 };
        let color = Store::Color { word: wgsl::EDGE_COLOR, fallback: wgsl::THEME_EDGE };
        match (&self.style.color, context.theme.edge) {
            (Some(expr), _) => c.channel("color", expr, color)?,
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
        drawing.flags = flags;
        if context.diagram() {
            // Every wire runs along the path its sheet worked out.
            drawing.path = wgsl::PATH_GEOMETRY;
            drawing.geometry = c.derived_path("route");
        } else {
            drawing.geometry = self.bends.as_ref().map_or(wgsl::NONE, |bends| c.path(bends));
            drawing.lane = c.derived_number("lane");
        }
        Ok(drawing)
    }
}

style_methods!(Edges);
stroke_methods!(Edges);
