use super::{Edges, Faces, Lines, Vertices};
use crate::expr::compile::Compiler;
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
        Style { data, table, color: None, visible: true.into(), name: None, interaction: Interaction::default() }
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

/// What a compiled mark draws with, besides its program.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Drawing {
    pub(crate) kind: MarkKind,
    /// State words per row.
    pub(crate) stride: u32,
    pub(crate) flags: u32,
    pub(crate) marker: (u32, u32, f32),
    /// The program column a line traces, or `NONE`.
    pub(crate) trace: u32,
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
        match self {
            Mark::Vertices(m) => m.compile(compiler),
            Mark::Edges(m) => m.compile(compiler, theme),
            Mark::Faces(m) => m.compile(compiler),
            Mark::Lines(m) => m.compile(compiler),
        }
    }
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
        }
    };
}

pub(crate) use style_methods;
