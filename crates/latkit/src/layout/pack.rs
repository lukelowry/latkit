/// Packs boxes (each `[width, height]`) in the given order into rows `gap` apart, so the result's
/// width over height approaches `aspect`. Returns each box's top-left corner, with y up (top is the
/// greater y); the first box's top left is at the origin.
pub(crate) fn pack(boxes: &[[f64; 2]], gap: f64, aspect: f64) -> Vec<[f64; 2]> {
    rows(boxes, gap, span(boxes, gap, aspect))
}

/// The row width at which rows of `boxes` approach width over height `aspect`: the width of a
/// rectangle of that aspect whose area is the boxes' total area, gaps included.
pub(super) fn span(boxes: &[[f64; 2]], gap: f64, aspect: f64) -> f64 {
    let area: f64 = boxes.iter().map(|[width, height]| (width + gap) * (height + gap)).sum();
    (area * aspect).sqrt()
}

/// Each box's top-left corner, in rows `gap` apart going down from the origin. A row breaks before
/// a box that would extend it past `span`, so only a box wider than `span` makes a row wider.
pub(super) fn rows(boxes: &[[f64; 2]], gap: f64, span: f64) -> Vec<[f64; 2]> {
    let (mut x, mut top, mut tallest) = (0.0, 0.0, 0.0_f64);
    boxes
        .iter()
        .enumerate()
        .map(|(i, &[width, height])| {
            if i > 0 && x + width > span {
                x = 0.0;
                top -= tallest + gap;
                tallest = 0.0;
            }
            let corner = [x, top];
            x += width + gap;
            tallest = tallest.max(height);
            corner
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Boxes of uneven sizes, the same on every run.
    fn uneven(count: usize) -> Vec<[f64; 2]> {
        let mut seed = 0x2545_f491_u32;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            f64::from(seed % 1000) / 10.0 + 1.0
        };
        (0..count).map(|_| [next(), next()]).collect()
    }

    #[test]
    fn boxes_do_not_overlap_and_keep_their_gap() {
        let (boxes, gap) = (uneven(200), 4.0);
        let corners = pack(&boxes, gap, 16.0 / 9.0);
        assert_eq!(corners[0], [0.0, 0.0], "the first box's top left is the origin");
        for (i, (a, &[aw, ah])) in corners.iter().zip(&boxes).enumerate() {
            for (b, &[bw, bh]) in corners.iter().zip(&boxes).skip(i + 1) {
                let apart_x = a[0] + aw + gap <= b[0] || b[0] + bw + gap <= a[0];
                let apart_y = a[1] - ah - gap >= b[1] || b[1] - bh - gap >= a[1];
                assert!(apart_x || apart_y, "{a:?} {:?} and {b:?} {:?}", [aw, ah], [bw, bh]);
            }
        }
    }

    #[test]
    fn rows_approach_the_aspect() {
        let squares = vec![[1.0, 1.0]; 100];
        let corners = pack(&squares, 0.0, 16.0 / 9.0);
        let width = corners.iter().map(|c| c[0] + 1.0).fold(0.0, f64::max);
        let height = -corners.iter().map(|c| c[1] - 1.0).fold(0.0, f64::min);
        let aspect = width / height;
        assert!((1.4..=2.2).contains(&aspect), "{width} by {height}");
        assert!(corners.iter().all(|c| c[1] <= 0.0), "rows go down from the origin");
    }

    #[test]
    fn a_wide_box_takes_a_row_alone() {
        let corners = pack(&[[1.0, 1.0], [50.0, 2.0], [1.0, 1.0]], 1.0, 1.0);
        assert_eq!(corners, vec![[0.0, 0.0], [0.0, -2.0], [0.0, -5.0]]);
    }
}
