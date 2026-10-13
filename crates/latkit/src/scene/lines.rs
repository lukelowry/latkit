use super::Interpolation;
use super::mark::{Drawing, MarkKind, Style, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Expr, Name, Result, Size};

/// Rows drawn as lines. On a plot, each row traces a sampled field across the data's axis: the
/// history a monitor shows.
///
/// ```
/// # use latkit::Lines;
/// let height = Lines::of("body", "Body").samples("height").width(2.0);
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Lines {
    pub(crate) style: Style,
    pub(crate) samples: Option<Name>,
    pub(crate) width: Option<Size>,
    pub(crate) dash: Expr,
    pub(crate) interpolation: Interpolation,
}

impl Lines {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Lines {
        Lines {
            style: Style::new(data.into(), table.into()),
            samples: None,
            width: None,
            dash: false.into(),
            interpolation: Interpolation::Linear,
        }
    }

    /// The sampled field each row traces over the axis. Unless named, the mark takes its name.
    #[must_use]
    pub fn samples(mut self, field: impl Into<Name>) -> Lines {
        self.samples = Some(field.into());
        self
    }

    /// Each row's width: CSS pixels, or position units with [`units`](crate::units).
    #[must_use]
    pub fn width(mut self, width: impl Into<Size>) -> Lines {
        self.width = Some(width.into());
        self
    }

    /// Whether each row is dashed.
    #[must_use]
    pub fn dash(mut self, dash: impl Into<Expr>) -> Lines {
        self.dash = dash.into();
        self
    }

    /// How each row runs between its samples.
    #[must_use]
    pub fn interpolation(mut self, interpolation: Interpolation) -> Lines {
        self.interpolation = interpolation;
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>) -> Result<Drawing> {
        let Some(field) = &self.samples else {
            return Err(Error::invalid("name the sampled field each row traces").at("samples"));
        };
        let trace = c.trace(field).map_err(|e| e.at("samples"))?;
        let color = Store::Color { word: wgsl::LINE_COLOR, fallback: wgsl::THEME_LINE };
        match &self.style.color {
            Some(expr) => c.channel("color", expr, color)?,
            None => c.theme("color", wgsl::THEME_LINE, color)?,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::LINE_FLAGS, bit: wgsl::VISIBLE })?;
        c.channel("dash", &self.dash, Store::Flag { word: wgsl::LINE_FLAGS, bit: wgsl::DASH })?;
        let width = |units| Store::Size { word: wgsl::LINE_WIDTH, units, fallback: Some(wgsl::THEME_LINE_WIDTH) };
        match &self.width {
            Some(size) => c.channel("width", &size.expr, width(size.units))?,
            None => c.theme("width", wgsl::THEME_LINE_WIDTH, width(false))?,
        }
        let mut drawing = Drawing::new(MarkKind::Lines, wgsl::LINE_WORDS);
        drawing.trace = trace;
        drawing.flags = match self.interpolation {
            Interpolation::Linear => 0,
            Interpolation::StepBefore => wgsl::STEP_BEFORE,
            Interpolation::StepAfter => wgsl::STEP_AFTER,
        };
        Ok(drawing)
    }
}

style_methods!(Lines);
