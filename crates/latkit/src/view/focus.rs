//! Selection, hover, and the rows a fit measures, as focus words: one per row of every mark, written
//! only where they change.

use std::collections::HashMap;

use super::View;
use crate::Row;
use crate::expr::compile::Deps;
use crate::gpu::shaders as wgsl;

/// Changed words past which the whole buffer is written at once.
const WHOLE: usize = 512;

#[derive(Default)]
pub(crate) struct Focus {
    pub(crate) selection: Vec<Row>,
    pub(crate) hovered: Option<Row>,
    /// Rows a fit measures.
    pub(crate) fitting: Vec<Row>,
    /// Words written, by index into the focus buffer.
    written: HashMap<u32, u32>,
    pub(crate) dirty: bool,
}

impl View {
    /// Writes the focus words that changed; after `fresh`, a new buffer, every word. Channels reading
    /// selection or hover evaluate again.
    pub(super) fn write_focus(&mut self, queue: &wgpu::Queue, buffer: &wgpu::Buffer, capacity: u64, fresh: bool) {
        if fresh {
            self.focus.written.clear();
            self.focus.dirty = true;
        }
        if !std::mem::take(&mut self.focus.dirty) {
            return;
        }
        let mut words: HashMap<u32, u32> = HashMap::new();
        let mut mark = |rows: &[Row], bit: u32, picked: bool| {
            for row in rows {
                let Some(table) = self.data(&row.data).and_then(|d| d.table(&row.table)) else { continue };
                let Some(index) = table.row(row.id.as_ref()) else { continue };
                for shown in &self.marks {
                    let style = shown.mark.style();
                    if (picked && !style.interaction.pick) || style.data != row.data || style.table != row.table {
                        continue;
                    }
                    if (index as u32) < shown.rows {
                        *words.entry(shown.region.focus + index as u32).or_default() |= bit;
                    }
                }
            }
        };
        mark(&self.focus.selection, wgsl::SELECTED, true);
        mark(self.focus.hovered.as_slice(), wgsl::HOVERED, true);
        mark(&self.focus.fitting, wgsl::FIT, false);
        let changed = self.focus.written.keys().filter(|w| !words.contains_key(w)).count()
            + words.iter().filter(|(w, b)| self.focus.written.get(w) != Some(b)).count();
        if changed > WHOLE {
            let mut all = vec![0_u32; capacity as usize];
            for (&w, &b) in &words {
                if let Some(word) = all.get_mut(w as usize) {
                    *word = b;
                }
            }
            queue.write_buffer(buffer, 0, bytemuck::cast_slice(&all));
        } else if changed > 0 {
            let cleared = self.focus.written.keys().filter(|w| !words.contains_key(w)).map(|&w| (w, 0));
            let set = words.iter().filter(|(w, b)| self.focus.written.get(w) != Some(b)).map(|(&w, &b)| (w, b));
            for (w, b) in cleared.chain(set).filter(|&(w, _)| u64::from(w) < capacity).collect::<Vec<_>>() {
                queue.write_buffer(buffer, u64::from(w) * 4, &b.to_le_bytes());
            }
        }
        self.focus.written = words;
        if changed > 0 {
            for shown in &mut self.marks {
                shown.dirty |= shown.channels_reading(Deps::FOCUS);
            }
        }
    }
}
