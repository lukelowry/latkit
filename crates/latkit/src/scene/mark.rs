use super::{Edges, Faces, Label, Lines, Vertices};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Expr, Name, Result};

/// One drawn table of a scene.
#[derive(Clone, PartialEq, Debug)]
#[non_exhaustive]
pub enum Mark {
    /// Rows drawn as markers.
    Vertices(Vertices),
    /// Rows drawn as strokes between two vertices.
    Edges(Edges),
    /// Rows drawn as triangles between three vertices.
    Faces(Faces),
    /// Rows drawn as lines through their samples.
    Lines(Lines),
}

impl From<Vertices> for Mark {
    fn from(mark: Vertices) -> Mark {
        Mark::Vertices(mark)
    }
}

impl From<Edges> for Mark {
    fn from(mark: Edges) -> Mark {
        Mark::Edges(mark)
    }
}

impl From<Faces> for Mark {
    fn from(mark: Faces) -> Mark {
        Mark::Faces(mark)
    }
}

impl From<Lines> for Mark {
    fn from(mark: Lines) -> Mark {
        Mark::Lines(mark)
    }
}

/// Options every mark has.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Style {
    pub(crate) data: Name,
    pub(crate) table: Name,
    pub(crate) color: Option<Expr>,
    pub(crate) visible: Expr,
    pub(crate) name: Option<Name>,
    pub(crate) interaction: Interaction,
    pub(crate) label: Option<Label>,
}

/// How a mark's rows answer the pointer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Interaction {
    pub(crate) pick: bool,
    pub(crate) select: bool,
    pub(crate) drag: bool,
}

impl Default for Interaction {
    fn default() -> Interaction {
        Interaction { pick: true, select: true, drag: false }
    }
}

impl Style {
    pub(crate) fn new(data: Name, table: Name) -> Style {
        Style {
            data,
            table,
            color: None,
            visible: true.into(),
            name: None,
            interaction: Interaction::default(),
            label: None,
        }
    }
}

/// What a scene's marks are drawn as.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum MarkKind {
    Vertices,
    Edges,
    Faces,
    Lines,
}

/// Identifies a mark across scenes: a new scene's mark with the same key eases from the old one.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Key {
    pub(crate) kind: MarkKind,
    pub(crate) data: Name,
    pub(crate) table: Name,
    pub(crate) name: Option<Name>,
}

/// The four shaders every mark draws with.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Primitive {
    Points,
    Strokes,
    Triangles,
}

impl Primitive {
    pub(crate) fn code(self) -> u32 {
        match self {
            Primitive::Points => wgsl::POINTS,
            Primitive::Strokes => wgsl::STROKES,
            Primitive::Triangles => wgsl::TRIANGLES,
        }
    }
}

/// How a mark's markers draw: built in or custom, their shape, and the inputs they read.
#[derive(Clone, PartialEq, Debug, Default)]
pub(crate) struct Markers {
    pub(crate) marker: u32,
    pub(crate) shape: u32,
    pub(crate) corner: f32,
    pub(crate) hole: f32,
    /// Inputs, and the row word of the first.
    pub(crate) inputs: u32,
    pub(crate) input: u32,
    /// A pie's slice colors, packed; an icon marker's layers, filled in when packed.
    pub(crate) palette: Vec<u32>,
    /// An icon marker's images.
    pub(crate) icons: Vec<crate::Image>,
    /// A custom marker's WGSL.
    pub(crate) custom: Option<std::sync::Arc<str>>,
}

/// How a compiled mark's labels draw: the extra word their words start at, the program column of
/// their text, their size in CSS pixels, and where their lines wrap.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Labeling {
    pub(crate) extra: u32,
    pub(crate) column: u32,
    pub(crate) size: f32,
    pub(crate) max_width: Option<f32>,
}

/// What a compiled mark draws with, besides its program.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Drawing {
    pub(crate) kind: MarkKind,
    /// The primitive the mark draws its rows with.
    pub(crate) primitive: Primitive,
    /// Where a stroke's segments run between: one of the `PATH_*` codes.
    pub(crate) source: u32,
    /// Kind words per row, and extra words per row after them.
    pub(crate) stride: u32,
    pub(crate) extras: u32,
    pub(crate) flags: u32,
    pub(crate) markers: Markers,
    /// The program column a line traces, or `NONE`.
    pub(crate) trace: u32,
    pub(crate) label: Option<Labeling>,
    /// A vertex mark's ports, by the reference field that names their nets.
    pub(crate) ports: Vec<(Name, super::Port)>,
    /// A vertex mark's members: rows of a table whose reference field names the row they are in.
    pub(crate) members: Option<(Name, Name)>,
    /// An edge mark's bends: a path field of points between its ends.
    pub(crate) bends: Option<Name>,
    /// How an edge mark's rows run; `None` takes the space's way.
    pub(crate) route: Option<super::Route>,
}

impl Drawing {
    pub(crate) fn new(kind: MarkKind, stride: u32) -> Drawing {
        let (primitive, source) = match kind {
            MarkKind::Vertices => (Primitive::Points, wgsl::NONE),
            MarkKind::Edges => (Primitive::Strokes, wgsl::PATH_ENDS),
            MarkKind::Faces => (Primitive::Triangles, wgsl::NONE),
            MarkKind::Lines => (Primitive::Strokes, wgsl::PATH_TRACE),
        };
        Drawing {
            kind,
            primitive,
            source,
            stride,
            extras: 0,
            flags: 0,
            markers: Markers::default(),
            trace: wgsl::NONE,
            label: None,
            ports: Vec::new(),
            members: None,
            bends: None,
            route: None,
        }
    }
}

impl Mark {
    pub(crate) fn style(&self) -> &Style {
        match self {
            Mark::Vertices(m) => &m.style,
            Mark::Edges(m) => &m.style,
            Mark::Faces(m) => &m.style,
            Mark::Lines(m) => &m.style,
        }
    }

    fn style_mut(&mut self) -> &mut Style {
        match self {
            Mark::Vertices(m) => &mut m.style,
            Mark::Edges(m) => &mut m.style,
            Mark::Faces(m) => &mut m.style,
            Mark::Lines(m) => &mut m.style,
        }
    }

    pub(crate) fn kind(&self) -> MarkKind {
        match self {
            Mark::Vertices(_) => MarkKind::Vertices,
            Mark::Edges(_) => MarkKind::Edges,
            Mark::Faces(_) => MarkKind::Faces,
            Mark::Lines(_) => MarkKind::Lines,
        }
    }

    /// Lines that trace a field are keyed by that field unless named.
    pub(crate) fn key(&self) -> Key {
        let style = self.style();
        let name = match self {
            Mark::Lines(lines) => style.name.clone().or_else(|| lines.samples.clone()),
            _ => style.name.clone(),
        };
        Key { kind: self.kind(), data: style.data.clone(), table: style.table.clone(), name }
    }

    /// Whether `other` draws the same, whatever either's interaction.
    pub(crate) fn draws_like(&self, other: &Mark) -> bool {
        let mut a = self.clone();
        a.style_mut().interaction = other.style().interaction;
        a == *other
    }

    pub(crate) fn compile(&self, compiler: &mut Compiler<'_>, theme: &super::Theme) -> Result<Drawing> {
        let mut drawing = match self {
            Mark::Vertices(m) => m.compile(compiler),
            Mark::Edges(m) => m.compile(compiler, theme),
            Mark::Faces(m) => m.compile(compiler),
            Mark::Lines(m) => m.compile(compiler),
        }?;
        if let Some(label) = &self.style().label {
            compile_label(label, compiler, theme, &mut drawing).map_err(|e| e.at("label"))?;
        }
        Ok(drawing)
    }
}

/// Compiles `label`'s text, priority, and color into extra words after the mark's own.
fn compile_label(label: &Label, c: &mut Compiler<'_>, theme: &super::Theme, drawing: &mut Drawing) -> Result<()> {
    let extra = drawing.extras;
    let word = |k: u32| drawing.stride + extra + k;
    let column = c.text("text", &label.text, word(wgsl::LABEL_CODE))?;
    let priority: Expr = label.priority.clone().scale(0.0..=255.0).into();
    c.channel("priority", &priority, Store::Number { word: word(wgsl::LABEL_PRIORITY), fallback: None })?;
    let color = Store::Color { word: word(wgsl::LABEL_COLOR), fallback: wgsl::THEME_TEXT };
    match &label.color {
        Some(expr) => c.channel("color", expr, color)?,
        None => c.theme("color", wgsl::THEME_TEXT, color)?,
    }
    drawing.extras += wgsl::LABEL_WORDS;
    drawing.flags |= wgsl::LABELED;
    drawing.label =
        Some(Labeling { extra, column, size: label.size.unwrap_or(theme.font_size), max_width: label.max_width });
    Ok(())
}

/// The options every mark has, as inherent methods.
macro_rules! style_methods {
    ($mark:ty) => {
        impl $mark {
            /// Each row's color.
            #[must_use]
            pub fn color(mut self, color: impl Into<$crate::Expr>) -> Self {
                self.style.color = Some(color.into());
                self
            }

            /// Whether each row is drawn and picked.
            #[must_use]
            pub fn visible(mut self, visible: impl Into<$crate::Expr>) -> Self {
                self.style.visible = visible.into();
                self
            }

            /// Names the mark, so two marks of one table can be told apart across scenes.
            #[must_use]
            pub fn named(mut self, name: impl Into<$crate::Name>) -> Self {
                self.style.name = Some(name.into());
                self
            }

            /// Whether rows are hovered, clicked, and probed; on by default.
            #[must_use]
            pub fn pick(mut self, on: bool) -> Self {
                self.style.interaction.pick = on;
                self
            }

            /// Whether a click selects a row; on by default.
            #[must_use]
            pub fn select(mut self, on: bool) -> Self {
                self.style.interaction.select = on;
                self
            }

            /// Whether pressing a row drags it instead of panning; off by default.
            #[must_use]
            pub fn drag(mut self, on: bool) -> Self {
                self.style.interaction.drag = on;
                self
            }

            /// Labels each row.
            #[must_use]
            pub fn label(mut self, label: $crate::Label) -> Self {
                self.style.label = Some(label);
                self
            }
        }
    };
}

pub(crate) use style_methods;
