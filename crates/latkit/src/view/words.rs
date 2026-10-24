//! What a mark keeps per row, in pages of the arena: for each page of held rows, a block of each kind
//! of words it keeps, holding as many rows as the page has. A row's state is its kind words then its extra words; beside it are its focus
//! word, its label's candidate, the normals faces sum at a vertex, and while the mark eases, its state
//! as it showed when the transition began and as it settles. A page keeps its blocks while the mark
//! holds rows there, so rows keep their words as the camera moves and nothing moves as a mark holds
//! more rows; every kind is counted in the GPU's budget with the data.

use std::sync::Arc;

use crate::gpu::arena::Arena;
use crate::gpu::work::Queue;

/// A kind of words a mark keeps per row.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kept {
    State,
    Focus,
    Candidates,
    Normals,
    Frozen,
    Settled,
}

const KINDS: [Kept; 6] = [Kept::State, Kept::Focus, Kept::Candidates, Kept::Normals, Kept::Frozen, Kept::Settled];

/// One kind's pages: the words each row takes, and each page's block in the arena and the words it
/// holds.
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

/// A mark's pages of every kind.
#[derive(Default)]
pub(crate) struct Words {
    pages: [Pages; KINDS.len()],
    /// The state's pages before this frame changed them, while the frame is done with what they held.
    before: Option<Pages>,
}

impl Words {
    pub(crate) fn pages(&self, kept: Kept) -> &Pages {
        &self.pages[kept as usize]
    }

    /// The state's pages as the frame began: what a transition starting freezes rows from.
    pub(crate) fn state_before(&self) -> &Pages {
        self.before.as_ref().unwrap_or(&self.pages[Kept::State as usize])
    }

    /// Forgets the state's pages as the frame began, once the frame is recorded.
    pub(crate) fn settle(&mut self) {
        self.before = None;
    }

    /// Fits `kept`'s pages to hold `rows[p]` rows on page `p`, of `width` words each, or none at
    /// `width` 0: a page whose block cannot hold its rows takes a new block, cleared, as every page does
    /// where a row's words changed width; blocks it no longer has are let go. The pages given new
    /// blocks, whose words start over; `None` where the arena has no room for them now, and nothing
    /// changed.
    pub(crate) fn fit(
        &mut self,
        kept: Kept,
        rows: &[u32],
        width: u32,
        (device, queue): (&wgpu::Device, &Queue),
        arena: &mut Arena,
    ) -> Option<Vec<u32>> {
        let rows = if width == 0 { &[][..] } else { rows };
        let have = &self.pages[kept as usize];
        let holds = |p: usize| have.width == width && have.words.get(p).is_some_and(|&w| w >= rows[p] * width);
        if have.blocks.len() == rows.len() && (0..rows.len()).all(holds) {
            return Some(Vec::new());
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
            let Some(block) = arena.block(device, queue, words) else {
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
        Some(new)
    }

    /// Lets go of every page, as a mark does when it goes.
    pub(crate) fn release(&mut self, arena: &mut Arena) {
        for kept in KINDS {
            let pages = std::mem::take(&mut self.pages[kept as usize]);
            for (&block, &words) in pages.blocks.iter().zip(&pages.words) {
                arena.free(block, words);
            }
        }
        self.before = None;
    }

    /// The page tables the program holds: each kind it keeps, and its blocks.
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
