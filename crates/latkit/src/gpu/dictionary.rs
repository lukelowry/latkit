//! Text on the GPU: each text field's distinct texts get codes in the order they are first seen.
//! Codes only ever grow, so a page's codes never change and upload once.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rustc_hash::FxBuildHasher;

use crate::Name;
use crate::data::{Page, PageId};
use crate::gpu::shaders::MISSING;

#[derive(Default)]
pub(crate) struct Dictionaries {
    fields: HashMap<(Name, Name, Name), Dictionary, FxBuildHasher>,
}

#[derive(Default)]
pub(crate) struct Dictionary {
    codes: HashMap<Arc<str>, u32, FxBuildHasher>,
    scanned: HashSet<PageId, FxBuildHasher>,
}

impl Dictionaries {
    /// The dictionary of field `field` of `table` in dataset `data`.
    pub(crate) fn field(&mut self, data: &Name, table: &Name, field: &Name) -> &mut Dictionary {
        self.fields.entry((data.clone(), table.clone(), field.clone())).or_default()
    }
}

impl Dictionary {
    /// Adds the texts of `page` and returns its codes as `f32` words, `MISSING` where missing.
    pub(crate) fn codes(&mut self, page: &Page) -> Vec<u32> {
        self.scanned.insert(page.id);
        let values = &page.values;
        let Some(text) = values.text() else { return vec![MISSING; values.len()] };
        (0..values.len())
            .map(|i| {
                if !values.is_valid(i) {
                    return MISSING;
                }
                let t = text.get(i);
                let code = if let Some(&code) = self.codes.get(t) {
                    code
                } else {
                    let code = self.codes.len() as u32;
                    self.codes.insert(t.into(), code);
                    code
                };
                (code as f32).to_bits()
            })
            .collect()
    }

    /// Adds the texts of `page` when it was not seen before.
    pub(crate) fn scan(&mut self, page: &Page) {
        if !self.scanned.contains(&page.id) {
            self.codes(page);
        }
    }

    /// The code of `text` as an `f32` word; one no text has when it was never seen.
    pub(crate) fn code(&self, text: &str) -> u32 {
        self.codes.get(text).map_or(f32::NAN.to_bits(), |&code| (code as f32).to_bits())
    }
}
