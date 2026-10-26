//! Panels: the region of a shared target each view draws in. A canvas with several views and a
//! picture or video composed from them use the same layout.

use crate::{Error, Result};

/// The region of a shared target each view draws in, one panel per view, in order. A panel is
/// `[x, y, width, height]` as fractions of the target, from its top left. Later panels draw over
/// earlier ones. With no panels, one view fills the target.
///
/// ```
/// use latkit::Panels;
/// let map_over_plot = Panels::from([[0.0, 0.0, 1.0, 0.8], [0.0, 0.8, 1.0, 0.2]]);
/// assert_eq!(map_over_plot.len(), 2);
/// assert_eq!(Panels::default().len(), 1);
/// ```
#[derive(Clone, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct Panels(Vec<[f32; 4]>);

impl Panels {
    /// Number of views the panels lay out. One when no panels are given.
    pub fn len(&self) -> usize {
        self.0.len().max(1)
    }

    /// Whether no panels were given, so one view fills the target.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Each view's pixel rectangle in a target of `size`, with edges rounded to multiples of
    /// `align`. Fails if a panel covers no pixels.
    pub(crate) fn rects(&self, size: [u32; 2], align: [u32; 2]) -> Result<Vec<Rect>> {
        let whole = [[0.0, 0.0, 1.0, 1.0]];
        let parts = if self.0.is_empty() { &whole[..] } else { &self.0[..] };
        let edge = |f: f32, length: u32, align: u32| {
            let units = (f64::from(f.clamp(0.0, 1.0)) * f64::from(length) / f64::from(align)).round() as u32;
            (units * align).min(length)
        };
        parts
            .iter()
            .map(|p| {
                let x = [edge(p[0], size[0], align[0]), edge(p[0] + p[2], size[0], align[0])];
                let y = [edge(p[1], size[1], align[1]), edge(p[1] + p[3], size[1], align[1])];
                if x[1] <= x[0] || y[1] <= y[0] {
                    return Err(Error::invalid(format!("panel {p:?} covers no pixels")).at("panels"));
                }
                Ok(Rect { origin: [x[0], y[0]], size: [x[1] - x[0], y[1] - y[0]] })
            })
            .collect()
    }
}

impl From<Vec<[f32; 4]>> for Panels {
    fn from(parts: Vec<[f32; 4]>) -> Panels {
        Panels(parts)
    }
}

impl<const N: usize> From<[[f32; 4]; N]> for Panels {
    fn from(parts: [[f32; 4]; N]) -> Panels {
        Panels(parts.to_vec())
    }
}

/// A view's panel in target pixels: its top left corner and its size.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Rect {
    pub(crate) origin: [u32; 2],
    pub(crate) size: [u32; 2],
}

impl Rect {
    /// Whether the two share a pixel.
    pub(crate) fn overlaps(self, other: Rect) -> bool {
        (0..2).all(|i| {
            self.origin[i] < other.origin[i] + other.size[i] && other.origin[i] < self.origin[i] + self.size[i]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_edges_round_to_multiples_of_the_alignment() {
        let panels = Panels::from([[0.0, 0.0, 1.0, 0.7], [0.0, 0.7, 1.0, 0.3]]);
        let rects = panels.rects([1920, 1080], [4, 2]).expect("valid");
        assert_eq!(rects, [Rect { origin: [0, 0], size: [1920, 756] }, Rect { origin: [0, 756], size: [1920, 324] }]);
        assert!(!rects[0].overlaps(rects[1]));
        assert_eq!(
            Panels::default().rects([10, 10], [1, 1]).expect("valid"),
            [Rect { origin: [0, 0], size: [10, 10] }]
        );
        assert!(Panels::from([[0.5, 0.5, 0.0, 0.5]]).rects([10, 10], [1, 1]).is_err());
    }
}
