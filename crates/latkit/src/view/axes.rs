//! A plot's axes, drawn over its marks: grid lines at round values, tick labels and titles in the
//! theme's font, and the playhead at the shown coordinate. Rebuilt each frame as overlay sprites,
//! in O(ticks). The space they take around the plot area is measured with the host's text metrics.

use std::sync::Arc;

use super::View;
use super::camera::Area;
use crate::derive::stamp_of;
use crate::gpu::Inner;
use crate::gpu::shaders::{self as wgsl, TEXT_SPREAD};
use crate::host::{Host, TextRun};
use crate::{Axis, Camera, Color, Format, Plot, Space};

/// A tick's length, and the gap between it and its label, in CSS pixels.
const TICK: f64 = 4.0;
const GAP: f64 = 3.0;
/// Space kept on the sides of a hidden axis, in CSS pixels.
const HIDDEN: f64 = 8.0;

/// The space a plot's axes take around the plot area, from their measured text.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(crate) struct Gutters {
    /// Space outside the area in CSS pixels: top, right, bottom, left.
    pub(crate) room: [f64; 4],
    /// The height of a tick label in CSS pixels.
    tick: f64,
}

/// The space `plot`'s axes take. `measure` gives the CSS pixel size of a run of the theme's text,
/// including the distance field around it. Below the area: a tick, its labels, and the x title.
/// Left: a tick and the widest y label. Above: the y title, at least half a label's height. Right:
/// half the widest x label. A hidden axis leaves `HIDDEN` on its two sides instead.
pub(crate) fn gutters(plot: &Plot, measure: impl Fn(&str) -> [f64; 2]) -> Gutters {
    let tick = measure("0")[1];
    let widest = |axis: &Axis| written(axis).iter().map(|text| measure(text)[0]).fold(0.0, f64::max);
    let title = |axis: &Axis| axis.label.as_deref().map_or(0.0, |title| measure(title)[1]);
    let (x, y) = (!plot.x.hidden, !plot.y.hidden);
    let top = if y { title(&plot.y).max(tick / 2.0) } else { HIDDEN };
    let right = if x { widest(&plot.x) / 2.0 } else { HIDDEN };
    let bottom = if x { TICK + GAP + tick + title(&plot.x) } else { HIDDEN };
    let left = if y { TICK + GAP + widest(&plot.y) } else { HIDDEN };
    Gutters { room: [top, right, bottom, left], tick }
}

/// Labels as wide as the widest that `axis` writes: its given ticks' labels, or else a sample value
/// with a sign, two digits, and three decimals, in its format.
fn written(axis: &Axis) -> Vec<String> {
    let Some(given) = &axis.ticks else { return vec![label(-88.888, 0.001, axis)] };
    let mut values: Vec<f64> = given.iter().map(|&(v, _)| v).collect();
    values.sort_unstable_by(f64::total_cmp);
    let step = values.windows(2).map(|w| w[1] - w[0]).filter(|&d| d > 0.0).fold(f64::INFINITY, f64::min);
    let step = if step.is_finite() { step } else { 1.0 };
    given.iter().map(|(v, text)| text.clone().unwrap_or_else(|| label(*v, step, axis))).collect()
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

/// The ticks of `axis` across `range`: the ones it gives, otherwise round values `step` apart.
fn axis_ticks(axis: &Axis, range: [f64; 2], step: f64) -> Vec<(f64, String)> {
    match &axis.ticks {
        Some(given) => given
            .iter()
            .filter(|(v, _)| (range[0]..=range[1]).contains(v))
            .map(|(v, text)| (*v, text.clone().unwrap_or_else(|| label(*v, step, axis))))
            .collect(),
        None => ticks(range, step).map(|v| (v, label(v, step, axis))).collect(),
    }
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

/// Which edges of a run of text meet its anchor.
#[derive(Clone, Copy)]
pub(super) enum Align {
    /// Centered horizontally, top at the anchor.
    Below,
    /// Right edge at the anchor, centered vertically.
    Left,
    /// Left edge at the anchor, centered vertically.
    Right,
    /// Left edge at the anchor, bottom at the anchor.
    Above,
    /// Right edge at the anchor, top at the anchor.
    BelowLeft,
    /// Left edge at the anchor, top at the anchor.
    BelowRight,
}

/// Sets overlay text through the atlas, in one font, size, and color.
pub(super) struct Writer<'a> {
    pub(super) inner: &'a mut Inner,
    pub(super) font: Arc<str>,
    pub(super) size_px: u32,
    pub(super) ratio: f64,
    pub(super) color: Color,
}

impl Writer<'_> {
    /// `text` as a sprite aligned by `align` at `anchor` (CSS pixels), snapped to device pixels.
    /// `None` while the text cannot be set yet.
    pub(super) fn text(&mut self, text: &str, anchor: [f64; 2], align: Align) -> Option<wgsl::Sprite> {
        let run = TextRun { text: text.into(), font: self.font.clone(), size_px: self.size_px, max_width: None };
        let host = self.inner.host.clone();
        let glyphs = self.inner.atlas.text(host.as_deref(), &run)?;
        let [l, t, r, b] = glyphs.rect.map(f64::from);
        let (w, h) = ((r - l) / self.ratio, (b - t) / self.ratio);
        let [x, y] = match align {
            Align::Below => [anchor[0] - w / 2.0, anchor[1]],
            Align::Left => [anchor[0] - w, anchor[1] - h / 2.0],
            Align::Right => [anchor[0], anchor[1] - h / 2.0],
            Align::Above => [anchor[0], anchor[1] - h],
            Align::BelowLeft => [anchor[0] - w, anchor[1]],
            Align::BelowRight => anchor,
        };
        let snap = |v: f64| (v * self.ratio).round() / self.ratio;
        let (x, y) = (snap(x), snap(y));
        let mut sprite: wgsl::Sprite = bytemuck::Zeroable::zeroed();
        sprite.a = [x as f32, y as f32];
        sprite.b = [(x + w) as f32, (y + h) as f32];
        sprite.uv = [l as f32, t as f32, r as f32, b as f32];
        sprite.color = self.color.to_array();
        sprite.kind = wgsl::SPRITE_TEXT;
        Some(sprite)
    }
}

impl View {
    /// The sprites drawn over the marks this frame: a plot's axes, the title and legends, and a box
    /// being selected or a connection being drawn.
    pub(super) fn overlay(&self, inner: &mut Inner) -> Vec<wgsl::Sprite> {
        let evictions = inner.atlas.evictions;
        let mut sprites = self.written(inner);
        // If the atlas evicted texts while setting this frame's text, set it again on the new
        // packing.
        if inner.atlas.evictions != evictions {
            sprites = self.written(inner);
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
        sprites
    }

    /// The overlay's text sprites and the lines that go with them: a plot's axes, the title, and
    /// the legends.
    fn written(&self, inner: &mut Inner) -> Vec<wgsl::Sprite> {
        let mut sprites = self.axes_sprites(inner);
        sprites.extend(self.annotations(inner));
        sprites
    }

    fn axes_sprites(&self, inner: &mut Inner) -> Vec<wgsl::Sprite> {
        let Space::Plot(plot) = &self.scene.space else { return Vec::new() };
        let Camera::Plot { x, y: Some(y) } = self.drawn_camera() else { return Vec::new() };
        self.axes(inner, plot, self.area(), x, y)
    }

    /// Measures the space the plot's axes take, with the host's metrics for the theme's text at the
    /// view's pixel ratio, once per scene and ratio. The plot area is what they leave.
    pub(super) fn measure_gutters(&mut self) {
        let Space::Plot(plot) = &self.scene.space else { return };
        let stamp = stamp_of((self.scene_version, self.pixel_ratio.to_bits()));
        if stamp == self.gutters.0 {
            return;
        }
        let host: Option<Arc<dyn Host>> = self.gpu.0.lock().host.clone();
        let host = host.as_deref();
        let theme = &self.scene.theme;
        let ratio = f64::from(self.pixel_ratio);
        let size = (f64::from(theme.text.size) * ratio).round().max(1.0);
        let field = 2.0 * f64::from(TEXT_SPREAD);
        let measure = |text: &str| {
            let run =
                TextRun { text: text.into(), font: theme.text.font.clone(), size_px: size as u32, max_width: None };
            // Without a host, estimate 0.6 em per character and a 1.25 em line.
            let guess = [0.6 * size * text.chars().count() as f64, 1.25 * size];
            let [w, h] = host.and_then(|host| host.measure(&run).ok()).map_or(guess, |s| s.map(f64::from));
            [(w + field) / ratio, (h + field) / ratio]
        };
        let measured = gutters(plot, measure);
        if measured != self.gutters.1 {
            self.fitting.plot_due = true;
        }
        self.gutters = (stamp, measured);
    }

    fn axes(&self, inner: &mut Inner, plot: &Plot, area: Area, x: [f64; 2], y: [f64; 2]) -> Vec<wgsl::Sprite> {
        let [left, top, right, bottom] = area;
        let across = |v: f64| left + (v - x[0]) / (x[1] - x[0]) * (right - left);
        let up = |v: f64| bottom - (v - y[0]) / (y[1] - y[0]) * (bottom - top);
        let theme = &self.scene.theme;
        let gutters = self.gutters.1;
        let font = f64::from(theme.text.size);
        let ratio = f64::from(self.pixel_ratio);
        let mut writer = Writer {
            inner,
            font: theme.text.font.clone(),
            size_px: (font * ratio).round().max(1.0) as u32,
            ratio,
            color: theme.text.color,
        };
        let axis = theme.text.color.alpha(0.35);
        let mut sprites = Vec::new();
        if !plot.x.hidden {
            let step = step(x[1] - x[0], (right - left) / (font * 8.0));
            for (v, text) in axis_ticks(&plot.x, x, step) {
                let at = across(v);
                if plot.x.grid {
                    sprites.push(line([at, top], [at, bottom], 1.0, theme.grid));
                }
                sprites.push(line([at, bottom], [at, bottom + TICK], 1.0, axis));
                sprites.extend(writer.text(&text, [at, bottom + TICK + GAP], Align::Below));
            }
            sprites.push(line([left, bottom], [right, bottom], 1.0, axis));
            if let Some(title) = &plot.x.label {
                let below = bottom + TICK + GAP + gutters.tick;
                sprites.extend(writer.text(title, [right, below], Align::BelowLeft));
            }
        }
        if !plot.y.hidden {
            let step = step(y[1] - y[0], (bottom - top) / (font * 3.5));
            for (v, text) in axis_ticks(&plot.y, y, step) {
                let at = up(v);
                if plot.y.grid {
                    sprites.push(line([left, at], [right, at], 1.0, theme.grid));
                }
                sprites.push(line([left - TICK, at], [left, at], 1.0, axis));
                sprites.extend(writer.text(&text, [left - TICK - GAP, at], Align::Left));
            }
            sprites.push(line([left, top], [left, bottom], 1.0, axis));
            if let Some(title) = &plot.y.label {
                // Above the area, aligned with the left edge of the space its labels take.
                sprites.extend(writer.text(title, [left - gutters.room[3], top], Align::Above));
            }
        }
        if self.at.is_finite() && (x[0]..=x[1]).contains(&self.at) {
            let at = across(self.at);
            sprites.push(line([at, top], [at, bottom], 1.5, theme.plot.playhead));
        }
        sprites
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
    fn gutters_fit_the_axis_labels_and_titles() {
        // Host text metrics: 7 pixels per character and a 20-pixel line, plus 16 for the field.
        let measure = |text: &str| [7.0 * text.chars().count() as f64 + 16.0, 36.0];
        let titled = |label: &str| Axis { label: Some(label.into()), ..Axis::default() };
        let plot = Plot { x: titled("Time"), y: titled("Load") };
        let room = gutters(&plot, measure).room;
        // Above: the y title. Below: a tick, its labels, and the x title.
        assert_eq!(room[0], 36.0);
        assert_eq!(room[2], TICK + GAP + 36.0 + 36.0);
        // Left: a tick and "-88.888". Right: half that label.
        let widest = 7.0 * 7.0 + 16.0;
        assert_eq!(room[3], TICK + GAP + widest);
        assert_eq!(room[1], widest / 2.0);
        // Given ticks are measured as written.
        let given =
            Axis { ticks: Some(vec![(0.0, Some("idle".into())), (1.0, Some("overloaded".into()))]), ..Axis::default() };
        let room = gutters(&Plot { x: Axis::default(), y: given }, measure).room;
        assert_eq!(room[3], TICK + GAP + 7.0 * 10.0 + 16.0);
        assert_eq!(room[0], 18.0, "without a title, the top gutter is half a label high");
        let hidden = Axis { hidden: true, ..Axis::default() };
        assert_eq!(gutters(&Plot { x: hidden.clone(), y: hidden }, measure).room, [HIDDEN; 4]);
    }
}
