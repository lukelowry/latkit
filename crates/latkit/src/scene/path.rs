//! SVG path data, read into the outlines a symbol marker draws.

use std::f32::consts::{FRAC_PI_2, TAU};

/// The segments a curve, or a quarter turn of an arc, is flattened into.
const STEPS: usize = 12;

/// The outlines `data` draws, each a run of points joined by straight segments: every command of
/// SVG path data, absolute or relative, with curves and arcs flattened. A closed outline ends on
/// its first point. Errors name what could not be read.
pub(crate) fn outlines(data: &str) -> Result<Vec<Vec<[f32; 2]>>, String> {
    let mut reader = Reader { rest: data };
    let mut outlines: Vec<Vec<[f32; 2]>> = Vec::new();
    let (mut at, mut start) = ([0.0_f32; 2], [0.0_f32; 2]);
    // The last control point, which a smooth curve reflects, and whether an outline is open.
    let (mut control, mut open) = (None::<[f32; 2]>, false);
    while let Some(letter) = reader.command()? {
        let relative = letter.is_ascii_lowercase();
        let mut command = letter.to_ascii_uppercase();
        loop {
            let origin = if relative { at } else { [0.0; 2] };
            let point = |reader: &mut Reader<'_>| -> Result<[f32; 2], String> {
                Ok([origin[0] + reader.number()?, origin[1] + reader.number()?])
            };
            // What the command draws from `at`, and the control point a smooth curve after it reflects.
            let mut reflected = None;
            let drawn: Vec<[f32; 2]> = match command {
                'M' => {
                    at = point(&mut reader)?;
                    start = at;
                    outlines.push(vec![at]);
                    open = true;
                    // More pairs after a move are lines.
                    command = 'L';
                    Vec::new()
                }
                'Z' => {
                    if let Some(outline) = outlines.last_mut().filter(|_| open) {
                        outline.push(start);
                    }
                    at = start;
                    open = false;
                    Vec::new()
                }
                'L' => vec![point(&mut reader)?],
                'H' => vec![[origin[0] + reader.number()?, at[1]]],
                'V' => vec![[at[0], origin[1] + reader.number()?]],
                'C' | 'S' => {
                    let first = if command == 'C' { point(&mut reader)? } else { reflect(control, at) };
                    let (second, end) = (point(&mut reader)?, point(&mut reader)?);
                    reflected = Some(second);
                    cubic(at, first, second, end)
                }
                'Q' | 'T' => {
                    let bend = if command == 'Q' { point(&mut reader)? } else { reflect(control, at) };
                    let end = point(&mut reader)?;
                    reflected = Some(bend);
                    // A quadratic curve is the cubic whose control points lie two thirds toward its bend.
                    let toward =
                        |p: [f32; 2]| [p[0] + (bend[0] - p[0]) * 2.0 / 3.0, p[1] + (bend[1] - p[1]) * 2.0 / 3.0];
                    cubic(at, toward(at), toward(end), end)
                }
                'A' => {
                    let radii = [reader.number()?, reader.number()?];
                    let turn = reader.number()?.to_radians();
                    let (large, sweep) = (reader.flag()?, reader.flag()?);
                    arc(at, radii, turn, large, sweep, point(&mut reader)?)
                }
                other => return Err(format!("{other:?} is not a path command")),
            };
            if let Some(&end) = drawn.last() {
                // Drawing after an outline closed starts another at its first point.
                if !open {
                    outlines.push(vec![at]);
                    open = true;
                }
                outlines.last_mut().expect("opened above").extend(drawn);
                at = end;
            }
            control = reflected;
            if command == 'Z' || !reader.more() {
                break;
            }
        }
    }
    outlines.retain(|outline| outline.len() > 1);
    if outlines.is_empty() {
        return Err("the path draws nothing".into());
    }
    Ok(outlines)
}

/// The control point a smooth curve from `at` starts with: the last one, reflected through `at`.
fn reflect(control: Option<[f32; 2]>, at: [f32; 2]) -> [f32; 2] {
    control.map_or(at, |c| [2.0 * at[0] - c[0], 2.0 * at[1] - c[1]])
}

/// The points after `a` of the cubic curve from `a` to `d` with control points `b` and `c`.
fn cubic(a: [f32; 2], b: [f32; 2], c: [f32; 2], d: [f32; 2]) -> Vec<[f32; 2]> {
    (1..=STEPS)
        .map(|i| {
            let t = i as f32 / STEPS as f32;
            let s = 1.0 - t;
            let weights = [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t];
            [0, 1].map(|k| weights[0] * a[k] + weights[1] * b[k] + weights[2] * c[k] + weights[3] * d[k])
        })
        .collect()
}

/// The points after `from` of the elliptical arc to `to`, as SVG gives one: its radii, the turn of
/// its axes in radians, and which of the four arcs between the points it is.
fn arc(from: [f32; 2], radii: [f32; 2], turn: f32, large: bool, sweep: bool, to: [f32; 2]) -> Vec<[f32; 2]> {
    let [mut rx, mut ry] = radii.map(f32::abs);
    if rx == 0.0 || ry == 0.0 || from == to {
        return vec![to];
    }
    let (sin, cos) = turn.sin_cos();
    let half = [(from[0] - to[0]) / 2.0, (from[1] - to[1]) / 2.0];
    let (x, y) = (cos * half[0] + sin * half[1], -sin * half[0] + cos * half[1]);
    // Radii too small to reach both points grow until they do.
    let over = (x * x) / (rx * rx) + (y * y) / (ry * ry);
    if over > 1.0 {
        (rx, ry) = (rx * over.sqrt(), ry * over.sqrt());
    }
    let span = rx * rx * y * y + ry * ry * x * x;
    let scale = ((rx * rx * ry * ry - span) / span).max(0.0).sqrt() * if large == sweep { -1.0 } else { 1.0 };
    let (cx, cy) = (scale * rx * y / ry, -scale * ry * x / rx);
    let middle = [f32::midpoint(from[0], to[0]), f32::midpoint(from[1], to[1])];
    let center = [cos * cx - sin * cy + middle[0], sin * cx + cos * cy + middle[1]];
    let angle = |x: f32, y: f32| y.atan2(x);
    let first = angle((x - cx) / rx, (y - cy) / ry);
    let mut around = (angle((-x - cx) / rx, (-y - cy) / ry) - first).rem_euclid(TAU);
    if !sweep {
        around -= TAU;
    }
    let steps = ((around.abs() / FRAC_PI_2) * STEPS as f32).ceil().max(1.0) as usize;
    (1..=steps)
        .map(|i| {
            let (s, c) = (first + around * i as f32 / steps as f32).sin_cos();
            [cos * rx * c - sin * ry * s + center[0], sin * rx * c + cos * ry * s + center[1]]
        })
        .collect()
}

/// Reads path data: command letters, numbers that may run together, and an arc's flags.
struct Reader<'a> {
    rest: &'a str,
}

impl Reader<'_> {
    fn skip(&mut self) {
        self.rest = self.rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
    }

    /// The next command's letter, or `None` at the end.
    fn command(&mut self) -> Result<Option<char>, String> {
        self.skip();
        let Some(letter) = self.rest.chars().next() else { return Ok(None) };
        if !letter.is_ascii_alphabetic() {
            return Err(format!("expected a path command at {:?}", self.shown()));
        }
        self.rest = &self.rest[1..];
        Ok(Some(letter))
    }

    /// Whether a number comes next, which repeats the command before it.
    fn more(&mut self) -> bool {
        self.skip();
        self.rest.starts_with(|c: char| c.is_ascii_digit() || matches!(c, '.' | '-' | '+'))
    }

    /// The next number. A sign or a second point ends the number before it, as in `1-2` and `.5.5`.
    fn number(&mut self) -> Result<f32, String> {
        self.skip();
        let bytes = self.rest.as_bytes();
        let mut end = usize::from(matches!(bytes.first(), Some(b'-' | b'+')));
        let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
        end += digits(end);
        if bytes.get(end) == Some(&b'.') {
            end += 1 + digits(end + 1);
        }
        if matches!(bytes.get(end), Some(b'e' | b'E')) {
            let sign = usize::from(matches!(bytes.get(end + 1), Some(b'-' | b'+')));
            let exponent = digits(end + 1 + sign);
            if exponent > 0 {
                end += 1 + sign + exponent;
            }
        }
        let number = self.rest[..end].parse::<f32>().map_err(|_| format!("expected a number at {:?}", self.shown()))?;
        self.rest = &self.rest[end..];
        Ok(number)
    }

    /// An arc's flag: one `0` or `1`, which may touch the number after it.
    fn flag(&mut self) -> Result<bool, String> {
        self.skip();
        let flag = match self.rest.as_bytes().first() {
            Some(b'0') => false,
            Some(b'1') => true,
            _ => return Err(format!("expected 0 or 1 at {:?}", self.shown())),
        };
        self.rest = &self.rest[1..];
        Ok(flag)
    }

    /// The start of what is left, for an error.
    fn shown(&self) -> String {
        self.rest.chars().take(12).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_data_reads_into_outlines() {
        // A circle of two half arcs, with numbers run together, then a closed triangle.
        let drawn = outlines("M-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M0-.5L.5.5H-.5Z").expect("reads");
        assert_eq!(drawn.len(), 2);
        let (circle, triangle) = (&drawn[0], &drawn[1]);
        assert!(circle.iter().all(|p| (p[0].hypot(p[1]) - 1.0).abs() < 1e-3), "every point lies on the circle");
        assert!(circle.iter().any(|p| p[1] > 0.99) && circle.iter().any(|p| p[1] < -0.99), "all the way round");
        assert_eq!(triangle.as_slice(), [[0.0, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.0, -0.5]], "closed on its start");
        let wave = &outlines("M0 0q1 2 2 0t2 0").expect("reads")[0];
        let lowest = wave.iter().map(|p| p[1]).fold(0.0, f32::min);
        assert!((lowest + 1.0).abs() < 1e-2, "a smooth curve reflects the bend before it: {lowest}");
        assert!(outlines("M0 0").is_err() && outlines("M0 0X1").is_err() && outlines("L").is_err());
    }
}
