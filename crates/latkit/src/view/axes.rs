//! A plot's axes: grid lines at round values under its marks, and over them tick labels and titles
//! in the theme's font and the playhead at the shown coordinate. Rebuilt each frame as overlay
//! sprites, in O(ticks). [`gutters`] measures the space they take, which the guides lay out.

use std::sync::Arc;

use super::View;
use super::camera::Area;
use crate::gpu::Inner;
use crate::gpu::atlas::Glyphs;
use crate::gpu::shaders as wgsl;
use crate::host::TextRun;
use crate::{Axis, Camera, Color, Format, Plot, Space, Theme};

/// A tick's length, and the gap between a tick and its label, in ems of the theme's text size.
pub(super) const TICK: f64 = 0.35;
pub(super) const GAP: f64 = 0.3;

/// The space a plot's axes take around the plot area, from their measured text.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(crate) struct Gutters {
    /// CSS pixels outside the area: top, right, bottom, left.
    pub(crate) room: [f64; 4],
    /// Whether tick labels or a title sit on each side.
    pub(crate) text: [bool; 4],
    /// The height of a tick label in CSS pixels.
    pub(crate) tick: f64,
}

/// The space `plot`'s axes take, for text `em` CSS pixels high that `measure` sizes. Below the
/// area: a tick, its labels, and the x title. Left: a tick and the widest y label. Above: half a y
/// label, since the top tick's label reaches past the area, and the y title over it. Right: half
/// the widest x label. A hidden axis takes nothing.
pub(crate) fn gutters(plot: &Plot, em: f64, mut measure: impl FnMut(&str) -> [f64; 2]) -> Gutters {
    let (x, y) = (!plot.x.hidden, !plot.y.hidden);
    let tick = measure("0")[1];
    let x_widest = if x { widest(&plot.x, &mut measure) } else { 0.0 };
    let y_widest = if y { widest(&plot.y, &mut measure) } else { 0.0 };
    let (mark, gap) = (TICK * em, GAP * em);
    let mut title = |axis: &Axis| axis.label.as_deref().map_or(0.0, |title| gap + measure(title)[1]);
    let room = [
        if y { tick / 2.0 + title(&plot.y) } else { 0.0 },
        if x { x_widest / 2.0 } else { 0.0 },
        if x { mark + gap + tick + title(&plot.x) } else { 0.0 },
        if y { mark + gap + y_widest } else { 0.0 },
    ];
    Gutters { room, text: [y, x, x, y], tick }
}

/// The width of the widest label `axis` writes.
fn widest(axis: &Axis, measure: &mut impl FnMut(&str) -> [f64; 2]) -> f64 {
    written(axis).iter().map(|text| measure(text)[0]).fold(0.0, f64::max)
}

/// Labels as wide as the widest that `axis` writes: its given ticks' labels, or else a sample value
/// with a sign, two digits, and three decimals, in its format. The greatest value carries the unit.
fn written(axis: &Axis) -> Vec<String> {
    let unit = axis.unit.as_deref().unwrap_or_default();
    let Some(given) = &axis.ticks else { return vec![format!("{}{unit}", label(-88.888, 0.001, axis))] };
    let mut values: Vec<f64> = given.iter().map(|&(v, _)| v).collect();
    values.sort_unstable_by(f64::total_cmp);
    let step = values.windows(2).map(|w| w[1] - w[0]).filter(|&d| d > 0.0).fold(f64::INFINITY, f64::min);
    let step = if step.is_finite() { step } else { 1.0 };
    let mut texts: Vec<(f64, String)> =
        given.iter().map(|(v, text)| (*v, text.clone().unwrap_or_else(|| label(*v, step, axis)))).collect();
    with_unit(&mut texts, axis);
    texts.into_iter().map(|(_, text)| text).collect()
}

/// Writes `axis`'s unit after the text of the tick with the greatest value.
fn with_unit(ticks: &mut [(f64, String)], axis: &Axis) {
    if let (Some(unit), Some((_, last))) = (&axis.unit, ticks.iter_mut().max_by(|a, b| a.0.total_cmp(&b.0))) {
        last.push_str(unit);
    }
}

/// A round step about `span / count`: 1, 2, 2.5, or 5 times a power of ten.
pub(super) fn step(span: f64, count: f64) -> f64 {
    let raw = (span / count.max(1.0)).max(f64::MIN_POSITIVE);
    let power = 10_f64.powf(raw.log10().floor());
    [1.0, 2.0, 2.5, 5.0, 10.0].into_iter().map(|m| m * power).find(|&s| s >= raw).unwrap_or(10.0 * power)
}

/// Decimals a value needs to tell ticks `step` apart.
fn decimals(step: f64) -> usize {
    let magnitude = step.log10().floor();
    let extra = usize::from(((step / 10_f64.powf(magnitude)) - 2.5).abs() < 1e-9);
    (-magnitude).max(0.0) as usize + extra
}

/// `value` written as `axis` says, with as many decimals as `step` needs unless it sets them.
pub(super) fn label(value: f64, step: f64, axis: &Axis) -> String {
    let value = if value.abs() < step * 1e-9 { 0.0 } else { value };
    let precision = axis.precision.map(usize::from);
    let significand = precision.unwrap_or(2);
    match axis.format {
        Format::Auto if value != 0.0 && (value.abs() >= 1e6 || value.abs() < 1e-4) => format!("{value:.significand$e}"),
        Format::Auto | Format::Fixed => {
            let decimals = precision.unwrap_or_else(|| decimals(step));
            format!("{value:.decimals$}")
        }
        Format::Scientific => format!("{value:.significand$e}"),
        Format::Engineering => {
            if value == 0.0 {
                return format!("{value:.significand$}");
            }
            let power = (value.abs().log10() / 3.0).floor() as i32 * 3;
            let mantissa = value / 10_f64.powi(power);
            if power == 0 { format!("{mantissa:.significand$}") } else { format!("{mantissa:.significand$}e{power}") }
        }
    }
}

/// The ticks of `axis` across `range`: the ones it gives, otherwise round values `step` apart. The
/// greatest carries the axis's unit.
pub(super) fn axis_ticks(axis: &Axis, range: [f64; 2], step: f64) -> Vec<(f64, String)> {
    let mut ticks: Vec<(f64, String)> = match &axis.ticks {
        Some(given) => given
            .iter()
            .filter(|(v, _)| (range[0]..=range[1]).contains(v))
            .map(|(v, text)| (*v, text.clone().unwrap_or_else(|| label(*v, step, axis))))
            .collect(),
        None => ticks(range, step).map(|v| (v, label(v, step, axis))).collect(),
    };
    with_unit(&mut ticks, axis);
    ticks
}

/// Values `step` apart within `range`, at most 201.
pub(super) fn ticks(range: [f64; 2], step: f64) -> impl Iterator<Item = f64> {
    let first = (range[0] / step).ceil();
    let last = (range[1] / step).floor().min(first + 200.0);
    let count = if first.is_finite() && last >= first { (last - first) as u32 + 1 } else { 0 };
    (0..count).map(move |i| (first + f64::from(i)) * step)
}

pub(super) fn line(a: [f64; 2], b: [f64; 2], width: f32, color: Color) -> wgsl::Sprite {
    let mut sprite: wgsl::Sprite = bytemuck::Zeroable::zeroed();
    sprite.a = [a[0] as f32, a[1] as f32];
    sprite.b = [b[0] as f32, b[1] as f32];
    sprite.width = width;
    sprite.color = color.to_array();
    sprite.kind = wgsl::SPRITE_LINE;
    sprite
}

/// Sets overlay text through the atlas, in one font, size, and color.
pub(super) struct Writer<'a> {
    inner: &'a mut Inner,
    font: Arc<str>,
    size_px: u32,
    ratio: f64,
    color: Color,
}

impl<'a> Writer<'a> {
    /// A writer of `theme`'s text at `scale` times its size and `ratio` pixels per CSS pixel.
    pub(super) fn new(inner: &'a mut Inner, theme: &Theme, scale: f64, ratio: f64, color: Color) -> Writer<'a> {
        let size_px = (f64::from(theme.text.size) * scale * ratio).round().max(1.0) as u32;
        Writer { inner, font: theme.text.font.clone(), size_px, ratio, color }
    }

    /// Where the atlas holds `text`, set on first use. `None` while it cannot be set.
    fn glyphs(&mut self, text: &str) -> Option<Glyphs> {
        let run = TextRun { text: text.into(), font: self.font.clone(), size_px: self.size_px, max_width: None };
        let host = self.inner.host.clone();
        self.inner.atlas.text(host.as_deref(), &run)
    }

    /// The width and height of `text`'s line box in CSS pixels. `None` while it cannot be set.
    pub(super) fn size(&mut self, text: &str) -> Option<[f64; 2]> {
        let [l, t, r, b] = self.glyphs(text)?.line.map(f64::from);
        Some([(r - l) / self.ratio, (b - t) / self.ratio])
    }

    /// `text` as a sprite with the point `origin` of its line box at `at` (CSS pixels), snapped to
    /// device pixels. `origin` is a fraction of the line box's width and height: `[0.0, 0.0]` puts
    /// its top left at `at`, and `[0.5, 1.0]` the middle of its bottom. `None` while it cannot be
    /// set.
    pub(super) fn text(&mut self, text: &str, at: [f64; 2], origin: [f64; 2]) -> Option<wgsl::Sprite> {
        let glyphs = self.glyphs(text)?;
        let ratio = self.ratio;
        let [l, t, r, b] = glyphs.rect.map(f64::from);
        let line = glyphs.line.map(|v| f64::from(v) / ratio);
        let snap = |v: f64| (v * ratio).round() / ratio;
        let x = snap(at[0] - origin[0] * (line[2] - line[0])) - line[0];
        let y = snap(at[1] - origin[1] * (line[3] - line[1])) - line[1];
        let mut sprite: wgsl::Sprite = bytemuck::Zeroable::zeroed();
        sprite.a = [x as f32, y as f32];
        sprite.b = [(x + (r - l) / ratio) as f32, (y + (b - t) / ratio) as f32];
        sprite.uv = [l as f32, t as f32, r as f32, b as f32];
        sprite.color = self.color.to_array();
        sprite.kind = wgsl::SPRITE_TEXT;
        Some(sprite)
    }
}

impl View {
    /// This frame's overlay sprites, and how many of them come first and draw under the marks: a
    /// plot's grid lines. The rest draw over the marks: a plot's axes, the guides, and a box being
    /// selected or a connection being drawn.
    pub(super) fn overlay(&self, inner: &mut Inner) -> (Vec<wgsl::Sprite>, u32) {
        let evictions = inner.atlas.evictions;
        let (mut sprites, under) = self.written(inner);
        // If the atlas evicted texts while setting this frame's text, set it again on the new
        // packing.
        if inner.atlas.evictions != evictions {
            sprites = self.written(inner).0;
        }
        let theme = &self.scene.theme;
        let color = theme.focus.selected.unwrap_or(theme.focus.hover);
        let at = |p: [f32; 2]| [f64::from(p[0]), f64::from(p[1])];
        match self.gestures.now {
            super::gestures::Gesture::Box { from, to, .. } => {
                let mut sprite = line(at(from), at(to), 1.0, color);
                sprite.kind = wgsl::SPRITE_BOX;
                sprites.push(sprite);
            }
            super::gestures::Gesture::Connect { anchor: Some(from), to, .. } => {
                sprites.push(line(at(from), at(to), 2.0, color));
            }
            _ => {}
        }
        (sprites, under)
    }

    /// The overlay's text sprites and the lines that go with them: a plot's axes and the guides.
    /// The plot's grid lines come first, and their count.
    fn written(&self, inner: &mut Inner) -> (Vec<wgsl::Sprite>, u32) {
        let (mut sprites, under) = self.axes_sprites(inner);
        sprites.extend(self.guide_sprites(inner));
        (sprites, under)
    }

    fn axes_sprites(&self, inner: &mut Inner) -> (Vec<wgsl::Sprite>, u32) {
        let Space::Plot(plot) = &self.scene.space else { return (Vec::new(), 0) };
        let Camera::Plot { x, y: Some(y) } = self.drawn_camera() else { return (Vec::new(), 0) };
        self.axes(inner, plot, self.area(), x, y)
    }

    /// The plot's grid lines, then its axes and playhead, and the number of grid lines.
    fn axes(&self, inner: &mut Inner, plot: &Plot, area: Area, x: [f64; 2], y: [f64; 2]) -> (Vec<wgsl::Sprite>, u32) {
        let [left, top, right, bottom] = area;
        let across = |v: f64| left + (v - x[0]) / (x[1] - x[0]) * (right - left);
        let up = |v: f64| bottom - (v - y[0]) / (y[1] - y[0]) * (bottom - top);
        let theme = &self.scene.theme;
        let gutters = self.guides.axes;
        let font = f64::from(theme.text.size);
        let (mark, gap) = (TICK * font, GAP * font);
        let mut writer = Writer::new(inner, theme, 1.0, f64::from(self.pixel_ratio), theme.text.color);
        let axis = theme.text.color.alpha(0.35);
        let (mut grid, mut sprites) = (Vec::new(), Vec::new());
        if !plot.x.hidden {
            let step = step(x[1] - x[0], (right - left) / (font * 8.0));
            for (v, text) in axis_ticks(&plot.x, x, step) {
                let at = across(v);
                if plot.x.grid {
                    grid.push(line([at, top], [at, bottom], 1.0, theme.grid));
                }
                sprites.push(line([at, bottom], [at, bottom + mark], 1.0, axis));
                sprites.extend(writer.text(&text, [at, bottom + mark + gap], [0.5, 0.0]));
            }
            sprites.push(line([left, bottom], [right, bottom], 1.0, axis));
            if let Some(title) = &plot.x.label {
                let below = bottom + mark + gap + gutters.tick + gap;
                sprites.extend(writer.text(title, [right, below], [1.0, 0.0]));
            }
        }
        if !plot.y.hidden {
            let step = step(y[1] - y[0], (bottom - top) / (font * 3.5));
            for (v, text) in axis_ticks(&plot.y, y, step) {
                let at = up(v);
                if plot.y.grid {
                    grid.push(line([left, at], [right, at], 1.0, theme.grid));
                }
                sprites.push(line([left - mark, at], [left, at], 1.0, axis));
                sprites.extend(writer.text(&text, [left - mark - gap, at], [1.0, 0.5]));
            }
            sprites.push(line([left, top], [left, bottom], 1.0, axis));
            if let Some(title) = &plot.y.label {
                // Over the top tick's label, aligned with the left edge of the labels.
                let over = top - gutters.tick / 2.0 - gap;
                sprites.extend(writer.text(title, [left - gutters.room[3], over], [0.0, 1.0]));
            }
        }
        if self.at.is_finite() && (x[0]..=x[1]).contains(&self.at) {
            let at = across(self.at);
            sprites.push(line([at, top], [at, bottom], 1.5, theme.plot.playhead));
        }
        let under = grid.len() as u32;
        grid.extend(sprites);
        (grid, under)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_round_and_labels_fit_them() {
        assert!((step(12.0, 6.0) - 2.0).abs() < 1e-12);
        assert!((step(1.0, 4.0) - 0.25).abs() < 1e-12);
        let auto = Axis::default();
        assert_eq!(label(0.25, 0.25, &auto), "0.25");
        assert_eq!(label(4.0, 2.0, &auto), "4");
        assert_eq!(label(-1e-17, 0.5, &auto), "0.0");
        let with = |format, precision| Axis { format, precision, ..Axis::default() };
        assert_eq!(label(1500.0, 500.0, &with(Format::Scientific, Some(1))), "1.5e3");
        assert_eq!(label(0.00015, 0.00005, &with(Format::Engineering, Some(0))), "150e-6");
        assert_eq!(label(2.0, 1.0, &with(Format::Fixed, Some(2))), "2.00");
        let given = Axis { ticks: Some(vec![(0.0, Some("off".into())), (1.0, None), (5.0, None)]), ..Axis::default() };
        assert_eq!(axis_ticks(&given, [0.0, 2.0], 1.0), [(0.0, "off".to_owned()), (1.0, "1".to_owned())]);
        assert_eq!(ticks([0.1, 1.0], 0.25).count(), 4);
    }

    #[test]
    fn the_greatest_tick_carries_the_unit() {
        let seconds = Axis { unit: Some(" s".into()), ..Axis::default() };
        let written = axis_ticks(&seconds, [0.0, 10.0], 5.0);
        assert_eq!(written, [(0.0, "0".to_owned()), (5.0, "5".to_owned()), (10.0, "10 s".to_owned())]);
        let given = Axis { ticks: Some(vec![(2.0, None), (1.0, None)]), ..seconds };
        assert_eq!(axis_ticks(&given, [0.0, 2.0], 1.0), [(2.0, "2 s".to_owned()), (1.0, "1".to_owned())]);
    }

    #[test]
    fn gutters_fit_the_axis_labels_and_titles() {
        // Text 7 pixels per character and 20 pixels high, at 10-pixel ems.
        let measure = |text: &str| [7.0 * text.chars().count() as f64, 20.0];
        let em = 10.0;
        let (mark, gap) = (TICK * em, GAP * em);
        let titled = |label: &str| Axis { label: Some(label.into()), ..Axis::default() };
        let plot = Plot { x: titled("Time"), y: titled("Load") };
        let gutters = gutters(&plot, em, measure);
        // Above: half the top tick's label, then the y title over it. Below: a tick, its labels,
        // and the x title.
        assert_eq!(gutters.room[0], 10.0 + gap + 20.0);
        assert_eq!(gutters.room[2], mark + gap + 20.0 + gap + 20.0);
        // Left: a tick and "-88.888". Right: half that label.
        let widest = 7.0 * 7.0;
        assert_eq!(gutters.room[3], mark + gap + widest);
        assert_eq!(gutters.room[1], widest / 2.0);
        // Given ticks are measured as written, and a unit follows the greatest.
        let given = Axis {
            ticks: Some(vec![(0.0, Some("idle".into())), (1.0, Some("busy".into()))]),
            unit: Some(" kW".into()),
            ..Axis::default()
        };
        let gutters = super::gutters(&Plot { x: Axis::default(), y: given }, em, measure);
        assert_eq!(gutters.room[3], mark + gap + 7.0 * 7.0);
        assert_eq!(gutters.room[0], 10.0, "without a title, the top gutter is half a label high");
        let hidden = Axis { hidden: true, ..Axis::default() };
        let bare = super::gutters(&Plot { x: hidden.clone(), y: hidden }, em, measure);
        assert_eq!((bare.room, bare.text), ([0.0; 4], [false; 4]));
    }
}
