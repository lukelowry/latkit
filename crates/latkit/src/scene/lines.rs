use super::Interpolation;
use super::mark::{
    Context, Drawing, GEOMETRY, MarkKind, Stroke, StrokeWords, Style, mark, stroke_methods, style_methods,
};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result, Space};

mark!(
/// Rows drawn as lines: along a path field (roads, rivers, borders) or a polygon field's rings,
/// outlining its areas; on a plot, through a sampled field's history across the data's axis, what a
/// monitor shows. On the earth paths bend with the globe and stay whole across the antimeridian.
///
/// ```
/// # use latkit::Lines;
/// let roads = Lines::of("city", "roads").width(2.0);
/// let height = Lines::of("body", "Body").trace("height");
/// ```
Lines + stroke {
    /// The path or polygon field each row runs along; `geometry` unless set. Not on a plot.
    geometry: Option<Name>,
    /// The sampled field each row traces across the data's axis, on a plot alone. A field not recorded
    /// yet draws nothing until its first frame.
    trace: Option<Name>,
    /// How each row runs between its samples, on a plot.
    interpolation: Interpolation,
});

impl Lines {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Lines {
        Lines {
            style: Style::new(data.into(), table.into()),
            stroke: Stroke::default(),
            geometry: None,
            trace: None,
            interpolation: Interpolation::Linear,
        }
    }

    /// The path or polygon field each row runs along; the field `geometry` unless set. Not on a plot.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Lines {
        self.geometry = Some(field.into());
        self
    }

    /// The sampled field each row traces across the data's axis, on a plot. Unless named, the mark
    /// takes the field's name.
    #[must_use]
    pub fn trace(mut self, field: impl Into<Name>) -> Lines {
        self.trace = Some(field.into());
        self
    }

    /// How each row runs between its samples, on a plot.
    #[must_use]
    pub fn interpolation(mut self, interpolation: Interpolation) -> Lines {
        self.interpolation = interpolation;
        self
    }

    /// The field each row draws from: the sampled field it traces, else its path field.
    pub(crate) fn traced(&self) -> Name {
        self.trace.clone().or_else(|| self.geometry.clone()).unwrap_or_else(|| GEOMETRY.into())
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        let mut drawing = Drawing::new(MarkKind::Lines, wgsl::LINE_WORDS);
        drawing.size_px = self.stroke.px();
        if matches!(context.space, Space::Plot(_)) {
            if self.geometry.is_some() {
                return Err(Error::invalid("a plot traces sampled fields; name one with trace").at("geometry"));
            }
            let Some(field) = &self.trace else {
                return Err(Error::invalid("name the sampled field each row traces").at("trace"));
            };
            drawing.trace = match c.kind(field) {
                // Streamed data appends its first frame later; the mark compiles again then.
                None => wgsl::NONE,
                _ => c.trace(field).map_err(|e| e.at("trace"))?,
            };
            drawing.flags = match self.interpolation {
                Interpolation::Linear => 0,
                Interpolation::StepBefore => wgsl::STEP_BEFORE,
                Interpolation::StepAfter => wgsl::STEP_AFTER,
            };
        } else {
            if self.trace.is_some() {
                return Err(Error::invalid("only a plot traces a sampled field; name a path with geometry").at("trace"));
            }
            let field = self.geometry.clone().unwrap_or_else(|| GEOMETRY.into());
            match c.kind(&field) {
                Some(Kind::Path | Kind::Parts | Kind::Polygons) => {}
                Some(_) => return Err(Error::invalid("not a path or polygon field").at(&field).at("geometry")),
                None if self.geometry.is_some() => {
                    return Err(Error::invalid("no such field").at(&field).at("geometry"));
                }
                None => return Err(Error::invalid("name the path field each row runs along").at("geometry")),
            }
            drawing.path = wgsl::PATH_GEOMETRY;
            // On the earth a line runs along its path as it bends with the globe.
            drawing.geometry = if matches!(context.space, Space::Earth(_)) {
                c.derived_path(&path_of(&field))
            } else {
                c.path(&field)
            };
        }
        let color = Store::Color { word: wgsl::LINE_COLOR, fallback: wgsl::THEME_LINE };
        match &self.style.color {
            Some(paint) => c.channel("color", &paint.0, color)?,
            None => c.theme("color", wgsl::THEME_LINE, color)?,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::LINE_FLAGS, bit: wgsl::VISIBLE })?;
        let words = StrokeWords {
            width: wgsl::LINE_WIDTH,
            flow: wgsl::LINE_FLOW,
            flags: wgsl::LINE_FLAGS,
            theme_width: wgsl::THEME_LINE_WIDTH,
        };
        self.stroke.compile(c, &words, context.diagram())?;
        Ok(drawing)
    }
}

/// The derived field holding path field `field` as an earth line draws it: unwrapped across the
/// antimeridian, with a point every few degrees along longer segments.
pub(crate) fn path_of(field: &str) -> Name {
    format!("{field}.path").into()
}

style_methods!(Lines);
stroke_methods!(Lines);
