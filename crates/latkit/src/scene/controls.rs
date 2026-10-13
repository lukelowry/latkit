/// How a view answers the pointer and keyboard. Each mark says whether its rows pick, select, and
/// drag; these say what the view itself does.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Controls {
    /// Dragging the background moves the camera.
    pub pan: bool,
    /// The wheel and pinching zoom.
    pub zoom: bool,
    /// Dragging with the secondary button, or with Shift, turns and tilts a map or plane.
    pub turn: bool,
    /// Arrows pan, `+` and `-` zoom, Home fits, and Escape clears the selection.
    pub keyboard: bool,
    /// Rows under the pointer glow.
    pub hover: bool,
    /// CSS pixels around the pointer that picks reach; touch reaches 8 more.
    pub pick_radius: f32,
    /// Dragging the background with Shift selects the rows in a box, instead of turning.
    pub select_box: bool,
    /// Dragging from a port, from a vertex with Alt, or an edge off its end draws a connection,
    /// told as [`Event::Connect`](crate::Event).
    pub connect: bool,
    /// Delete and Backspace tell [`Event::Delete`](crate::Event) with the selection.
    pub delete: bool,
}

impl Default for Controls {
    fn default() -> Controls {
        Controls {
            pan: true,
            zoom: true,
            turn: true,
            keyboard: true,
            hover: true,
            pick_radius: 6.0,
            select_box: false,
            connect: false,
            delete: false,
        }
    }
}
