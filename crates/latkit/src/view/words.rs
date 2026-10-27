//! A mark's per-row words, in pages of the arena. For each page of held rows, the mark has one
//! arena block per kind of words, sized for the page's rows. A row's state is its kind words, then
//! its extra words. Alongside the state are the row's focus word, the normals faces sum at a
//! vertex, and while the mark eases, its frozen state (as shown when the transition began) and its
//! settled state. A page keeps its blocks while the mark holds rows there, so rows keep their words
//! as the camera moves, and adding held rows moves none. Every kind counts toward the GPU budget
//! along with the data.

use std::sync::Arc;

use crate::gpu::arena::Arena;
use crate::gpu::work::Queue;

/// A kind of words a mark keeps per row.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kept {
    State,
    Focus,
    Normals,
    Frozen,
    Settled,
}

const KINDS: [Kept; 5] = [Kept::State, Kept::Focus, Kept::Normals, Kept::Frozen, Kept::Settled];

impl Kept {
    /// Whether a new block of this kind is cleared on allocation, because something reads it before
    /// anything writes it. State and frozen words need no clearing, since evaluation and freezing
    /// write them first, and normals are cleared before each sum.
    fn cleared(self) -> bool {
        matches!(self, Kept::Focus | Kept::Settled)
    }
}

/// One kind's pages: the words per row, and each page's arena block and its size in words.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Pages {
    pub(crate) width: u32,
    pub(crate) blocks: Arc<[u32]>,
    words: Vec<u32>,
}

impl Default for Pages {
    fn default() -> Pages {
        Pages { width: 0, blocks: Arc::new([]), words: Vec::new() }
    }
}

/// What fitting one kind's pages changed: the pages given new blocks, whose words start over, and
/// whether its page table changed at all.
pub(crate) struct Fitted {
    pub(crate) new: Vec<u32>,
    pub(crate) changed: bool,
}

/// A mark's pages of every kind.
#[derive(Default)]
pub(crate) struct Words {
    pages: [Pages; KINDS.len()],
    /// The state pages from before this frame changed them, kept until the frame is recorded: a
    /// transition starting this frame freezes rows from them.
    before: Option<Pages>,
}

impl Words {
    pub(crate) fn pages(&self, kept: Kept) -> &Pages {
        &self.pages[kept as usize]
    }

    /// The state pages as the frame began, which a starting transition freezes rows from.
    pub(crate) fn state_before(&self) -> &Pages {
        self.before.as_ref().unwrap_or(&self.pages[Kept::State as usize])
    }

    /// Drops the frame-start state pages once the frame is recorded.
    pub(crate) fn settle(&mut self) {
        self.before = None;
    }

    /// Fits `kept`'s pages to hold `rows[p]` rows on page `p`, at `width` words per row. A `width`
    /// of 0 frees them all. A page whose block is too small gets a new block, as does every page
    /// when the width changes. Unused blocks are freed. Returns what changed, or `None` (with
    /// nothing changed) when the arena has no space now.
    pub(crate) fn fit(
        &mut self,
        kept: Kept,
        rows: &[u32],
        width: u32,
        (device, queue): (&wgpu::Device, &Queue),
        arena: &mut Arena,
    ) -> Option<Fitted> {
        let rows = if width == 0 { &[][..] } else { rows };
        let have = &self.pages[kept as usize];
        let holds = |p: usize| have.width == width && have.words.get(p).is_some_and(|&w| w >= rows[p] * width);
        if have.blocks.len() == rows.len() && (0..rows.len()).all(holds) {
            return Some(Fitted { new: Vec::new(), changed: false });
        }
        let mut next = Pages { width, blocks: Arc::new([]), words: Vec::with_capacity(rows.len()) };
        let mut blocks = Vec::with_capacity(rows.len());
        let mut new = Vec::new();
        for (p, &n) in rows.iter().enumerate() {
            if holds(p) {
                blocks.push(have.blocks[p]);
                next.words.push(have.words[p]);
                continue;
            }
            let words = (n * width).max(1);
            let Some(block) = arena.block(device, queue, words, kept.cleared()) else {
                for &p in &new {
                    arena.free(blocks[p as usize], next.words[p as usize]);
                }
                return None;
            };
            blocks.push(block);
            next.words.push(crate::gpu::arena::rounded(words));
            new.push(p as u32);
        }
        next.blocks = blocks.into();
        let have = std::mem::replace(&mut self.pages[kept as usize], next);
        let next = &self.pages[kept as usize];
        for (p, (&block, &words)) in have.blocks.iter().zip(&have.words).enumerate() {
            if next.blocks.get(p) != Some(&block) {
                arena.free(block, words);
            }
        }
        if kept == Kept::State && self.before.is_none() {
            self.before = Some(have);
        }
        Some(Fitted { new, changed: true })
    }

    /// Frees every page, as when the mark is removed.
    pub(crate) fn release(&mut self, arena: &mut Arena) {
        for kept in KINDS {
            let pages = std::mem::take(&mut self.pages[kept as usize]);
            for (&block, &words) in pages.blocks.iter().zip(&pages.words) {
                arena.free(block, words);
            }
        }
        self.before = None;
    }

    /// The page tables the program buffer holds: each kind the mark keeps, with its blocks.
    pub(crate) fn tables(&self) -> impl Iterator<Item = (Kept, &[u32])> {
        KINDS
            .into_iter()
            .filter(|&kept| self.pages[kept as usize].width > 0)
            .map(|kept| (kept, &self.pages[kept as usize].blocks[..]))
    }

    /// Words the page tables take in the program.
    pub(crate) fn len(&self) -> usize {
        self.tables().map(|(_, blocks)| blocks.len()).sum()
    }

    /// Bytes its pages take in the arena.
    pub(crate) fn bytes(&self) -> u64 {
        self.pages.iter().flat_map(|p| &p.words).map(|&w| u64::from(w) * 4).sum()
    }
}
