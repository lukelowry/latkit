use super::Route;
use super::Theme;
use super::mark::{Drawing, MarkKind, Style, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Expr, Kind, Name, Result, Size};

/// Rows drawn as strokes between the vertices two reference fields name: branches, links, wires.
/// Without ends, each row is a net: it joins every vertex port whose reference field names it.
///
/// ```
/// # use latkit::{field, Edges};
/// let branches = Edges::of("grid", "Branch").ends("from", "to").width(field("rating") / 100.0).flow(field("p"));
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Edges {
    pub(crate) style: Style,
    pub(crate) ends: Option<(Name, Name)>,
    pub(crate) width: Option<Size>,
    pub(crate) dash: Expr,
    pub(crate) flow: Expr,
    pub(crate) shadow: bool,
    pub(crate) bends: Option<Name>,
    pub(crate) route: Option<Route>,
    pub(crate) arrows: bool,
}

impl Edges {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Edges {
        Edges {
            style: Style::new(data.into(), table.into()),
            ends: None,
            width: None,
            dash: false.into(),
            flow: 0.0.into(),
            shadow: false,
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

    /// Whether each row ends in an arrowhead at its second end.
    #[must_use]
    pub fn arrows(mut self, on: bool) -> Edges {
        self.arrows = on;
        self
    }

    /// Whether each row casts a shadow onto the ground, away from the theme's light.
    #[must_use]
    pub fn shadow(mut self, on: bool) -> Edges {
        self.shadow = on;
        self
    }

    /// The reference fields naming each row's two vertices.
    #[must_use]
    pub fn ends(mut self, from: impl Into<Name>, to: impl Into<Name>) -> Edges {
        self.ends = Some((from.into(), to.into()));
        self
    }

    /// Each row's width: CSS pixels, or position units with [`units`](crate::units).
    #[must_use]
    pub fn width(mut self, width: impl Into<Size>) -> Edges {
        self.width = Some(width.into());
        self
    }

    /// Whether each row is dashed.
    #[must_use]
    pub fn dash(mut self, dash: impl Into<Expr>) -> Edges {
        self.dash = dash.into();
        self
    }

    /// Comets flowing along each row, CSS pixels per second; negative flows from the second end.
    #[must_use]
    pub fn flow(mut self, px_per_second: impl Into<Expr>) -> Edges {
        self.flow = px_per_second.into();
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, theme: &Theme) -> Result<Drawing> {
        if let Some((from, to)) = &self.ends {
            c.end(from, wgsl::EDGE_FROM).map_err(|e| e.at("ends"))?;
            c.end(to, wgsl::EDGE_TO).map_err(|e| e.at("ends"))?;
        } else if self.bends.is_some() {
            return Err(Error::invalid("bends run between ends; name them").at("bends"));
        }
        if let Some(bends) = &self.bends
            && !matches!(c.kind(bends), Some(Kind::Geometry(1 | 2)))
        {
            return Err(Error::invalid("not a path field").at(bends).at("bends"));
        }
        let mut flags = if self.arrows { wgsl::ARROWS } else { 0 };
        let color = Store::Color { word: wgsl::EDGE_COLOR, fallback: wgsl::THEME_EDGE };
        match (&self.style.color, theme.edge) {
            (Some(expr), _) => c.channel("color", expr, color)?,
            (None, Some(_)) => c.theme("color", wgsl::THEME_EDGE, color)?,
            (None, None) => flags |= wgsl::ENDS_COLOR,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::EDGE_FLAGS, bit: wgsl::VISIBLE })?;
        c.channel("dash", &self.dash, Store::Flag { word: wgsl::EDGE_FLAGS, bit: wgsl::DASH })?;
        c.channel("flow", &self.flow, Store::Number { word: wgsl::EDGE_FLOW, fallback: None })?;
        let width = |units| Store::Size { word: wgsl::EDGE_WIDTH, units, fallback: Some(wgsl::THEME_EDGE_WIDTH) };
        match &self.width {
            Some(size) => c.channel("width", &size.expr, width(size.units))?,
            None => c.theme("width", wgsl::THEME_EDGE_WIDTH, width(false))?,
        }
        let mut drawing = Drawing::new(MarkKind::Edges, wgsl::EDGE_WORDS);
        drawing.flags = flags | if self.shadow { wgsl::CASTS } else { 0 };
        if self.ends.is_none() {
            drawing.source = wgsl::PATH_NET;
        }
        drawing.bends.clone_from(&self.bends);
        drawing.route = self.route;
        Ok(drawing)
    }
}

style_methods!(Edges);
