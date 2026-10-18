//! A scene's title and legends, written over its marks: the title and subtitle at the top left, and
//! the legends stacked up from the bottom right, each a bar of its mark's colormap across the domain,
//! ticked, under its title, or a cell of color for each category. Rebuilt each frame as overlay
//! sprites, O(legends).

use std::sync::Arc;

use super::View;
use super::axes::{Align, Writer, label, line, step, ticks};
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Queue;
use crate::{Axis, Color, ColormapKind, Theme};

/// CSS pixels between the view's edge and what is written there.
const MARGIN: f64 = 16.0;
/// A legend's bar: width and height, CSS pixels.
const BAR: [f64; 2] = [220.0, 8.0];
/// Cells a continuous bar is drawn in.
const CELLS: usize = 64;
/// The most categories a legend shows a cell for.
const CATEGORIES: usize = 24;

impl View {
    /// The sprites of the scene's title, subtitle, and legends.
    pub(super) fn annotations(&self, inner: &mut Inner, queue: &Queue) -> Vec<wgsl::Sprite> {
        let scene = &self.scene;
        if scene.title.is_none() && scene.subtitle.is_none() && scene.legends.is_empty() {
            return Vec::new();
        }
        let theme = &scene.theme;
        let [w, h] = self.size;
        let [top, right, bottom, left] = self.insets.map(f64::from);
        let area = [left + MARGIN, top + MARGIN, w - right - MARGIN, h - bottom - MARGIN];
        let ratio = f64::from(self.pixel_ratio);
        let font = f64::from(theme.font_size);
        let writer = |inner: &mut Inner, scale: f64, color: Color, f: &mut dyn FnMut(&mut Writer<'_>)| {
            let size_px = (font * scale * ratio).round().max(1.0) as u32;
            f(&mut Writer { inner, queue, font: theme.font.clone(), size_px, ratio, color });
        };
        let mut sprites = Vec::new();
        let mut y = area[1];
        for (text, scale, color) in [(&scene.title, 1.75, theme.text), (&scene.subtitle, 1.1, theme.text.alpha(0.7))] {
            let Some(text) = text else { continue };
            writer(inner, scale, color, &mut |w| sprites.extend(w.text(text, [area[0], y], Align::BelowRight)));
            y += font * scale * 1.35;
        }
        let mut base = area[3];
        for (mark, title) in &scene.legends {
            let colors = scene.marks.get(*mark).and_then(|m| m.style().color.as_ref()).and_then(|c| c.colormap_of());
            let Some((colormap, Some(domain))) = colors else { continue };
            let texels = *colormap.texels();
            let height = legend(
                &mut sprites,
                theme,
                [area[2], base],
                (colormap.kind(), texels),
                domain,
                |s, color, f| {
                    writer(inner, s, color, f);
                },
                title,
            );
            base -= height + MARGIN * 0.75;
        }
        sprites
    }
}

/// Draws a legend whose bar ends at `corner`'s x, its tick labels' bottom at its y: `colors` across
/// `domain` under `title`. How tall it is.
fn legend(
    sprites: &mut Vec<wgsl::Sprite>,
    theme: &Theme,
    corner: [f64; 2],
    (kind, texels): (ColormapKind, [[u8; 4]; 256]),
    domain: [f64; 2],
    mut write: impl FnMut(f64, Color, &mut dyn FnMut(&mut Writer<'_>)),
    title: &Arc<str>,
) -> f64 {
    let font = f64::from(theme.font_size);
    let tick_scale = 0.9;
    let tick_height = font * tick_scale * 1.4;
    let bar_bottom = corner[1] - tick_height - 4.0;
    let [left, top] = [corner[0] - BAR[0], bar_bottom - BAR[1]];
    let color = |t: usize| Color::from_bytes(texels[t.min(255)]);
    let text = theme.text.alpha(0.85);
    let across = |v: f64| left + (v - domain[0]) / (domain[1] - domain[0]).max(f64::MIN_POSITIVE) * BAR[0];
    let mut labels: Vec<(String, f64)> = Vec::new();
    if kind == ColormapKind::Categorical {
        let first = domain[0].min(domain[1]).ceil() as i64;
        let last = domain[0].max(domain[1]).floor() as i64;
        let count = (last - first + 1).clamp(1, CATEGORIES as i64) as usize;
        let cell = BAR[0] / count as f64;
        for i in 0..count {
            let category = first + i as i64;
            let x = left + cell * i as f64;
            sprites.push(fill(
                [x + 1.0, top],
                [x + cell - 1.0, bar_bottom],
                color(category.unsigned_abs() as usize % 256),
            ));
            labels.push((category.to_string(), x + cell / 2.0));
        }
    } else {
        for i in 0..CELLS {
            let x = |i: usize| left + BAR[0] * i as f64 / CELLS as f64;
            let t = ((i as f64 + 0.5) / CELLS as f64 * 255.0).round() as usize;
            sprites.push(fill([x(i), top], [x(i + 1), bar_bottom], color(t)));
        }
        let [lo, hi] = [domain[0].min(domain[1]), domain[0].max(domain[1])];
        let step = step(hi - lo, (BAR[0] / (font * 6.0)).max(1.0));
        let axis = Axis::default();
        for v in ticks([lo, hi], step) {
            let at = across(v);
            sprites.push(line([at, bar_bottom], [at, bar_bottom + 3.0], 1.0, text.alpha(0.5)));
            labels.push((label(v, step, &axis), at));
        }
    }
    write(tick_scale, text, &mut |w| {
        for (label, at) in &labels {
            sprites.extend(w.text(label, [*at, bar_bottom + 4.0], Align::Below));
        }
    });
    let mut height = corner[1] - top;
    if !title.is_empty() {
        write(1.0, theme.text, &mut |w| sprites.extend(w.text(title, [left, top - 5.0], Align::Above)));
        height += font * 1.4 + 5.0;
    }
    height
}

/// A rectangle filled with `color`, corner `a` to corner `b`, CSS pixels.
fn fill(a: [f64; 2], b: [f64; 2], color: Color) -> wgsl::Sprite {
    let mut sprite = line(a, b, 0.0, color);
    sprite.kind = wgsl::SPRITE_FILL;
    sprite
}
