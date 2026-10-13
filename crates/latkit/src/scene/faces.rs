use super::mark::{Drawing, MarkKind, Style, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Name, Result};

/// Rows drawn as triangles between the vertices three reference fields name: meshes, surfaces, and
/// fields interpolated across a network. Faces are lit from the camera, so a flat mesh seen from
/// above shows its exact colors.
///
/// ```
/// # use latkit::Faces;
/// let surface = Faces::of("mesh", "Face").corners("a", "b", "c");
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Faces {
    pub(crate) style: Style,
    pub(crate) corners: Option<[Name; 3]>,
    pub(crate) shadow: bool,
}

impl Faces {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Faces {
        Faces { style: Style::new(data.into(), table.into()), corners: None, shadow: false }
    }

    /// The reference fields naming each row's three vertices. Without a color, a face blends the
    /// colors of its corners.
    #[must_use]
    pub fn corners(mut self, a: impl Into<Name>, b: impl Into<Name>, c: impl Into<Name>) -> Faces {
        self.corners = Some([a.into(), b.into(), c.into()]);
        self
    }

    /// Whether each face casts a shadow onto the ground and onto other faces, away from the theme's
    /// light.
    #[must_use]
    pub fn shadow(mut self, on: bool) -> Faces {
        self.shadow = on;
        self
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>) -> Result<Drawing> {
        let Some(corners) = &self.corners else {
            return Err(Error::invalid("name the reference fields of each row's three corners").at("corners"));
        };
        for (corner, word) in corners.iter().zip([wgsl::FACE_A, wgsl::FACE_B, wgsl::FACE_C]) {
            c.end(corner, word).map_err(|e| e.at("corners"))?;
        }
        let mut flags = 0;
        match &self.style.color {
            Some(expr) => {
                c.channel("color", expr, Store::Color { word: wgsl::FACE_COLOR, fallback: wgsl::THEME_VERTEX })?;
            }
            None => flags |= wgsl::ENDS_COLOR,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::FACE_FLAGS, bit: wgsl::VISIBLE })?;
        let mut drawing = Drawing::new(MarkKind::Faces, wgsl::FACE_WORDS);
        drawing.flags = flags | if self.shadow { wgsl::CASTS } else { 0 };
        Ok(drawing)
    }
}

style_methods!(Faces);
