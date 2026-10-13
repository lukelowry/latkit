//! A plot's axes, drawn over its marks: grid lines at round values, tick labels and titles in the
//! theme's font, and the playhead at the shown coordinate. Rebuilt each frame as overlay sprites,
//! O(ticks).

use std::sync::Arc;

use super::View;
use super::camera::Area;
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::host::TextRun;
use crate::{Camera, Color, Plot, Space, Theme};

/// Room the axes take outside a plot's area: top, right, bottom, left, CSS pixels.
pub(crate) fn gutters(plot: &Plot, theme: &Theme) -> [f64; 4] {
    let f = f64::from(theme.font_size);
    let top = if plot.y.label.is_some() && !plot.y.hidden { f * 2.4 } else { f };
    let bottom = if plot.x.hidden { 8.0 } else { f * 2.4 + if plot.x.label.is_some() { f * 1.6 } else { 0.0 } };
    let left = if plot.y.hidden { 8.0 } else { f * 6.0 };
    [top, f * 1.5, bottom, left]
}

/// A round step about `span / count`: 1, 2, 2.5, or 5 times a power of ten.
fn step(span: f64, count: f64) -> f64 {
    let raw = (span / count.max(1.0)).max(f64::MIN_POSITIVE);
    let power = 10_f64.powf(raw.log10().floor());
    [1.0, 2.0, 2.5, 5.0, 10.0].into_iter().map(|m| m * power).find(|&s| s >= raw).unwrap_or(10.0 * power)
}

/// `value` written with as many decimals as `step` needs.
fn label(value: f64, step: f64) -> String {
    let value = if value.abs() < step * 1e-9 { 0.0 } else { value };
    if value != 0.0 && (value.abs() >= 1e6 || value.abs() < 1e-4) {
        return format!("{value:.2e}");
    }
    let magnitude = step.log10().floor();
    let extra = usize::from(((step / 10_f64.powf(magnitude)) - 2.5).abs() < 1e-9);
    let decimals = (-magnitude).max(0.0) as usize + extra;
    format!("{value:.decimals$}")
}

/// Values `step` apart within `range`.
fn ticks(range: [f64; 2], step: f64) -> impl Iterator<Item = f64> {
    let first = (range[0] / step).ceil() as i64;
    let last = (range[1] / step).floor() as i64;
    (first..=last.min(first + 200)).map(move |i| i as f64 * step)
}

fn line(a: [f64; 2], b: [f64; 2], width: f32, color: Color) -> wgsl::Sprite {
    let mut sprite: wgsl::Sprite = bytemuck::Zeroable::zeroed();
    sprite.a = [a[0] as f32, a[1] as f32];
    sprite.b = [b[0] as f32, b[1] as f32];
    sprite.width = width;
    sprite.color = color.to_array();
    sprite.kind = wgsl::SPRITE_LINE;
    sprite
}

/// Where a run of text goes: its anchor, and which of its edges meets the anchor.
#[derive(Clone, Copy)]
enum Align {
    /// Centered across, top at the anchor.
    Below,
    /// Right edge at the anchor, centered up and down.
    Left,
    /// Left edge at the anchor, bottom at the anchor.
    Above,
    /// Right edge at the anchor, top at the anchor.
    BelowLeft,
}

struct Writer<'a> {
    inner: &'a mut Inner,
    queue: &'a wgpu::Queue,
    font: Arc<str>,
    size_px: u32,
    ratio: f64,
    color: Color,
}

impl Writer<'_> {
    fn text(&mut self, text: &str, anchor: [f64; 2], align: Align) -> Option<wgsl::Sprite> {
        let run = TextRun { text: text.into(), font: self.font.clone(), size_px: self.size_px };
        let host = self.inner.host.clone();
        let glyphs = self.inner.atlas.text(self.queue, host.as_deref(), &run)?;
        let [l, t, r, b] = glyphs.rect.map(f64::from);
        let (w, h) = ((r - l) / self.ratio, (b - t) / self.ratio);
        let [x, y] = match align {
            Align::Below => [anchor[0] - w / 2.0, anchor[1]],
            Align::Left => [anchor[0] - w, anchor[1] - h / 2.0],
            Align::Above => [anchor[0], anchor[1] - h],
            Align::BelowLeft => [anchor[0] - w, anchor[1]],
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
    /// The sprites drawn over the marks this frame.
    pub(super) fn overlay(&self, inner: &mut Inner, queue: &wgpu::Queue) -> Vec<wgsl::Sprite> {
        let Space::Plot(plot) = &self.scene.space else { return Vec::new() };
        let Camera::Plot { x, y: Some(y) } = self.drawn_camera() else { return Vec::new() };
        let theme = &self.scene.theme;
        let area = self.area();
        let generation = inner.atlas.generation;
        let sprites = self.axes(inner, queue, plot, theme, area, x, y);
        // The atlas started over while setting this frame's text: set it again on the new packing.
        if inner.atlas.generation == generation { sprites } else { self.axes(inner, queue, plot, theme, area, x, y) }
    }

    #[allow(clippy::too_many_arguments, reason = "one frame's axes")]
    fn axes(
        &self,
        inner: &mut Inner,
        queue: &wgpu::Queue,
        plot: &Plot,
        theme: &Theme,
        area: Area,
        x: [f64; 2],
        y: [f64; 2],
    ) -> Vec<wgsl::Sprite> {
        let [left, top, right, bottom] = area;
        let across = |v: f64| left + (v - x[0]) / (x[1] - x[0]) * (right - left);
        let up = |v: f64| bottom - (v - y[0]) / (y[1] - y[0]) * (bottom - top);
        let font = f64::from(theme.font_size);
        let ratio = f64::from(self.pixel_ratio);
        let mut writer = Writer {
            inner,
            queue,
            font: theme.font.clone(),
            size_px: (font * ratio).round().max(1.0) as u32,
            ratio,
            color: theme.text,
        };
        let axis = theme.text.alpha(0.35);
        let mut sprites = Vec::new();
        if !plot.x.hidden {
            let step = step(x[1] - x[0], (right - left) / (font * 8.0));
            for v in ticks(x, step) {
                let at = across(v);
                if plot.x.grid {
                    sprites.push(line([at, top], [at, bottom], 1.0, theme.grid));
                }
                sprites.push(line([at, bottom], [at, bottom + 4.0], 1.0, axis));
                sprites.extend(writer.text(&label(v, step), [at, bottom + 6.0], Align::Below));
            }
            sprites.push(line([left, bottom], [right, bottom], 1.0, axis));
            if let Some(title) = &plot.x.label {
                sprites.extend(writer.text(title, [right, bottom + font * 2.2], Align::BelowLeft));
            }
        }
        if !plot.y.hidden {
            let step = step(y[1] - y[0], (bottom - top) / (font * 3.5));
            for v in ticks(y, step) {
                let at = up(v);
                if plot.y.grid {
                    sprites.push(line([left, at], [right, at], 1.0, theme.grid));
                }
                sprites.push(line([left - 4.0, at], [left, at], 1.0, axis));
                sprites.extend(writer.text(&label(v, step), [left - 7.0, at], Align::Left));
            }
            sprites.push(line([left, top], [left, bottom], 1.0, axis));
            if let Some(title) = &plot.y.label {
                sprites.extend(writer.text(title, [left - font * 4.0, top - font * 0.8], Align::Above));
            }
        }
        if self.at.is_finite() && (x[0]..=x[1]).contains(&self.at) {
            let at = across(self.at);
            sprites.push(line([at, top], [at, bottom], 1.5, theme.playhead));
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
        assert_eq!(label(0.25, 0.25), "0.25");
        assert_eq!(label(4.0, 2.0), "4");
        assert_eq!(label(-1e-17, 0.5), "0.0");
        assert_eq!(ticks([0.1, 1.0], 0.25).count(), 4);
    }
}
