use std::sync::Arc;

use crate::Color;

/// Colors and sizes marks take where their options read nothing, and the look of focus and motion.
/// Lengths are CSS pixels; in a diagram they are units, except `glow` and `halo`.
#[derive(Clone, PartialEq, Debug)]
pub struct Theme {
    /// Behind everything.
    pub background: Color,
    /// The earth's ground, and a group's container.
    pub surface: Color,
    /// A plane's or a diagram's grid.
    pub grid: Color,
    /// Vertex color.
    pub vertex: Color,
    /// Vertex radius.
    pub vertex_radius: f32,
    /// Edge color; `None` blends the colors of each edge's two vertices, and in a diagram takes the
    /// text color.
    pub edge: Option<Color>,
    /// Edge width.
    pub edge_width: f32,
    /// Line color.
    pub line: Color,
    /// Line width.
    pub line_width: f32,
    /// Area color.
    pub area: Color,
    /// How much a face turned away from the camera darkens, 0 to 1.
    pub shading: f32,
    /// Text: labels, axis ticks, and titles.
    pub text: Color,
    /// The CSS font family text is set in.
    pub font: Arc<str>,
    /// Text size.
    pub font_size: f32,
    /// The line a plot draws at the shown coordinate.
    pub playhead: Color,
    /// What a missing color reads as.
    pub missing: Color,
    /// The glow around hovered rows.
    pub hover: Color,
    /// The glow around selected rows; `None` glows in each row's own color.
    pub selected: Option<Color>,
    /// How far focus glows reach, CSS pixels.
    pub glow: f32,
    /// The opacity of rows outside a selection.
    pub dim: f32,
    /// How much a hovered vertex sized in CSS pixels grows.
    pub hover_scale: f32,
    /// Length of a dash.
    pub dash: f32,
    /// How comets flowing along edges and lines look.
    pub flow: Flow,
    /// In a diagram, distance between the lanes of edges joining the same two vertices, and between
    /// parallel orthogonal wires, which keep twice it apart.
    pub edge_spacing: f32,
    /// Elsewhere, how far edges joining the same two vertices bow apart: each lane by this fraction
    /// of the edge's length at its middle. A bow is part of the drawing, so zooming never moves it.
    pub lane_bow: f32,
    /// How far an arrowhead reaches past its edge's width.
    pub arrow: f32,
    /// CSS pixels of background around label text.
    pub halo: f32,
    /// Distance between a group's members and its outline.
    pub group_padding: f32,
    /// How marks that cast shadows cast them.
    pub shadow: Shadow,
    /// The air glowing around the globe, where the earth has an atmosphere.
    pub atmosphere: Color,
    /// How bright the earth's night side stays where it is lit by daylight, 0 to 1.
    pub night: f32,
}

/// How comets flowing along edges and lines look: each a round head, brightest at its middle, trailing
/// a tail that thins and fades.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Flow {
    /// A comet's color; its alpha is how strongly a comet covers its stroke.
    pub color: Color,
    /// Distance between comets.
    pub spacing: f32,
    /// How far a comet's tail trails its head.
    pub length: f32,
    /// How wide a comet's head is, CSS pixels, or units in a diagram; never narrower than its stroke.
    pub width: f32,
    /// Whether comets are part of the drawing: their spacing, length, and each row's flow in position
    /// units, degrees on the earth, so they zoom with the view and stay where they are on their lines.
    /// Otherwise they keep their size and speed on screen, and slide along their lines as it zooms.
    pub units: bool,
}

/// How marks that cast shadows cast them onto the ground and onto faces.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Shadow {
    /// What a shadow darkens toward; its alpha is how dark a shadow at contact gets.
    pub color: Color,
    /// The direction toward the light, fixed in the world: shadows fall away from it.
    pub light: [f32; 3],
    /// How much a shadow spreads per unit of a caster's height: the light's size.
    pub softness: f32,
    /// CSS pixels flat marks cast from, as if raised.
    pub lift: f32,
}

impl Theme {
    /// Light marks on a dark ground.
    pub fn dark() -> Theme {
        Theme {
            background: Color::hex("#0f141a").expect("hex"),
            surface: Color::hex("#18212b").expect("hex"),
            grid: Color::hex("#ffffff").expect("hex").alpha(0.07),
            vertex: Color::hex("#7cc4ff").expect("hex"),
            vertex_radius: 4.0,
            edge: None,
            edge_width: 1.5,
            line: Color::hex("#7cc4ff").expect("hex"),
            line_width: 1.5,
            area: Color::hex("#2b3d50").expect("hex"),
            shading: 0.6,
            text: Color::hex("#a8b2c2").expect("hex"),
            font: "ui-monospace, Menlo, Consolas, monospace".into(),
            font_size: 11.0,
            playhead: Color::hex("#ffe5d4").expect("hex").alpha(0.8),
            missing: Color::hex("#6b7480").expect("hex"),
            hover: Color::hex("#ffffff").expect("hex").alpha(0.6),
            selected: Some(Color::hex("#ffb000").expect("hex").alpha(0.9)),
            glow: 6.0,
            dim: 0.35,
            hover_scale: 1.25,
            dash: 8.0,
            flow: Flow {
                color: Color::hex("#ffffff").expect("hex").alpha(0.85),
                spacing: 64.0,
                length: 24.0,
                width: 4.0,
                units: false,
            },
            edge_spacing: 4.0,
            lane_bow: 0.12,
            arrow: 7.0,
            halo: 2.0,
            group_padding: 16.0,
            shadow: Shadow { color: Color::BLACK.alpha(0.45), light: [-0.35, 0.45, 1.0], softness: 0.15, lift: 3.0 },
            atmosphere: Color::hex("#5aa9ff").expect("hex").alpha(0.55),
            night: 0.3,
        }
    }

    /// Dark marks on a light ground.
    pub fn light() -> Theme {
        Theme {
            background: Color::hex("#f7f8fa").expect("hex"),
            surface: Color::hex("#e8ecf0").expect("hex"),
            grid: Color::hex("#000000").expect("hex").alpha(0.08),
            vertex: Color::hex("#1f6feb").expect("hex"),
            line: Color::hex("#1f6feb").expect("hex"),
            area: Color::hex("#c5d2df").expect("hex"),
            text: Color::hex("#4a5361").expect("hex"),
            playhead: Color::hex("#e36209").expect("hex").alpha(0.8),
            missing: Color::hex("#9aa3ad").expect("hex"),
            hover: Color::hex("#000000").expect("hex").alpha(0.35),
            selected: Some(Color::hex("#e36209").expect("hex").alpha(0.9)),
            flow: Flow { color: Color::hex("#ffffff").expect("hex").alpha(0.9), ..Theme::dark().flow },
            shadow: Shadow { color: Color::BLACK.alpha(0.22), ..Theme::dark().shadow },
            atmosphere: Color::hex("#6cb4ff").expect("hex").alpha(0.45),
            night: 0.55,
            ..Theme::dark()
        }
    }
}

impl Default for Theme {
    fn default() -> Theme {
        Theme::dark()
    }
}
