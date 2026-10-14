use super::Interpolation;
use super::mark::{Drawing, GEOMETRY, MarkKind, Stroke, StrokeWords, Style, stroke_methods, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Name, Result};

/// Rows drawn as lines through the field each traces. On a plot, a sampled field traces its history
/// across the data's axis: what a monitor shows.
///
/// ```
/// # use latkit::Lines;
/// let height = Lines::of("body", "Body").trace("height").width(2.0);
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Lines {
    pub(crate) style: Style,
    pub(crate) stroke: Stroke,
    pub(crate) trace: Option<Name>,
    pub(crate) interpolation: Interpolation,
}

impl Lines {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Lines {
        Lines {
            style: Style::new(data.into(), table.into()),
            stroke: Stroke::default(),
            trace: None,
            interpolation: Interpolation::Linear,
        }
    }

    /// The field each row traces: a sampled field across the plot's axis. Unless set, the field
    /// `geometry`; unless named, the mark takes the field's name. A field not recorded yet draws
    /// nothing until its first frame.
    #[must_use]
    pub fn trace(mut self, field: impl Into<Name>) -> Lines {
        self.trace = Some(field.into());
        self
    }

    /// How each row runs between its samples.
    #[must_use]
    pub fn interpolation(mut self, interpolation: Interpolation) -> Lines {
        self.interpolation = interpolation;
        self
    }

    /// The field each row traces.
    pub(crate) fn traced(&self) -> Name {
        self.trace.clone().unwrap_or_else(|| GEOMETRY.into())
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>) -> Result<Drawing> {
        let field = self.traced();
        let trace = match (c.kind(&field), &self.trace) {
            (None, None) => return Err(Error::invalid("name the field each row traces").at("trace")),
            // Streamed data appends its first frame later; the mark compiles again then.
            (None, Some(_)) => wgsl::NONE,
            _ => c.trace(&field).map_err(|e| e.at("trace"))?,
        };
        let color = Store::Color { word: wgsl::LINE_COLOR, fallback: wgsl::THEME_LINE };
        match &self.style.color {
            Some(expr) => c.channel("color", expr, color)?,
            None => c.theme("color", wgsl::THEME_LINE, color)?,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::LINE_FLAGS, bit: wgsl::VISIBLE })?;
        let words = StrokeWords {
            width: wgsl::LINE_WIDTH,
            flow: wgsl::LINE_FLOW,
            flags: wgsl::LINE_FLAGS,
            theme_width: wgsl::THEME_LINE_WIDTH,
        };
        self.stroke.compile(c, &words)?;
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
stroke_methods!(Lines);
