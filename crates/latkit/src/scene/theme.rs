use crate::Color;

/// Colors and sizes marks take where their options read nothing, and the look of focus and motion.
#[derive(Clone, PartialEq, Debug)]
pub struct Theme {
    /// Behind everything.
    pub background: Color,
    /// The earth's ground.
    pub surface: Color,
    /// A plane's grid.
    pub grid: Color,
    /// Vertex color.
    pub vertex: Color,
    /// Vertex radius, CSS pixels.
    pub vertex_radius: f32,
    /// Edge color; `None` blends the colors of each edge's two vertices.
    pub edge: Option<Color>,
    /// Edge width, CSS pixels.
    pub edge_width: f32,
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
    /// How much a hovered vertex grows.
    pub hover_scale: f32,
    /// Length of a dash, CSS pixels.
    pub dash: f32,
    /// Comets flowing along edges.
    pub flow: Color,
    /// CSS pixels between flowing comets.
    pub flow_spacing: f32,
    /// Whether vertices cast shadows.
    pub shadows: bool,
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
            missing: Color::hex("#6b7480").expect("hex"),
            hover: Color::hex("#ffffff").expect("hex").alpha(0.6),
            selected: Some(Color::hex("#ffb000").expect("hex").alpha(0.9)),
            glow: 6.0,
            dim: 0.35,
            hover_scale: 1.25,
            dash: 8.0,
            flow: Color::hex("#ffffff").expect("hex").alpha(0.8),
            flow_spacing: 40.0,
            shadows: false,
        }
    }

    /// Dark marks on a light ground.
    pub fn light() -> Theme {
        Theme {
            background: Color::hex("#f7f8fa").expect("hex"),
            surface: Color::hex("#e8ecf0").expect("hex"),
            grid: Color::hex("#000000").expect("hex").alpha(0.08),
            vertex: Color::hex("#1f6feb").expect("hex"),
            missing: Color::hex("#9aa3ad").expect("hex"),
            hover: Color::hex("#000000").expect("hex").alpha(0.35),
            selected: Some(Color::hex("#e36209").expect("hex").alpha(0.9)),
            flow: Color::hex("#ffffff").expect("hex").alpha(0.9),
            shadows: true,
            ..Theme::dark()
        }
    }
}

impl Default for Theme {
    fn default() -> Theme {
        Theme::dark()
    }
}
