//! Text dictionaries. Each text field's distinct texts get codes in the order they are first seen.
//! Codes are never reassigned, so a page's codes never change and upload once. A page is coded
//! once. A page written over a coded page reuses that page's codes and codes only the rows written.

use std::collections::HashMap;
use std::sync::Arc;

use rustc_hash::FxBuildHasher;

use crate::Name;
use crate::data::{Column, Keyed, Page, PageId, Values};
use crate::gpu::shaders::MISSING;

/// Most pages a dictionary keeps codes for. Past this, it forgets all of them.
const PAGES: usize = 256;

#[derive(Default)]
pub(crate) struct Dictionaries {
    fields: Keyed<(Name, Name, Name), Dictionary>,
}

#[derive(Default)]
pub(crate) struct Dictionary {
    codes: HashMap<Arc<str>, u32, FxBuildHasher>,
    /// Each code's text.
    texts: Vec<Arc<str>>,
    /// Codes of coded pages, by page.
    pages: HashMap<PageId, Arc<[u32]>, FxBuildHasher>,
}

impl Dictionaries {
    /// The dictionary of field `field` of `table` in dataset `data`.
    pub(crate) fn field(&mut self, data: &Name, table: &Name, field: &Name) -> &mut Dictionary {
        self.fields.entry((data.clone(), table.clone(), field.clone())).or_default()
    }
}

impl Dictionary {
    /// The codes of `page` as `f32` words, `MISSING` where missing, adding its new texts. A page
    /// coded before needs no work. A page written over a coded page codes only the rows written.
    pub(crate) fn codes(&mut self, page: &Page) -> Arc<[u32]> {
        if let Some(codes) = self.pages.get(&page.id) {
            return codes.clone();
        }
        let len = page.values.len();
        // Find the nearest page this one was written over that still has codes, and the rows
        // written since.
        let mut reused = None;
        let mut at = page.written.as_deref();
        while let Some(written) = at {
            if let Some(codes) = self.pages.get(&written.from).filter(|codes| codes.len() == len) {
                reused = page.rows_since(written.from).map(|rows| (written.from, codes.clone(), rows));
                break;
            }
            at = written.before.as_deref();
        }
        let codes: Arc<[u32]> = match reused {
            Some((from, before, rows)) => {
                // The old page is rarely written over again, so drop its codes.
                self.pages.remove(&from);
                let mut codes = before.to_vec();
                for row in rows {
                    codes[row as usize] = self.code(&page.values, row as usize);
                }
                codes.into()
            }
            None => (0..len).map(|i| self.code(&page.values, i)).collect(),
        };
        if self.pages.len() >= PAGES {
            self.pages.clear();
        }
        self.pages.insert(page.id, codes.clone());
        codes
    }

    /// The codes of `column`'s rows `rows`, in that order, adding new texts. This fills a packed
    /// page of a paged table. Each row costs one lookup, however its pages were coded.
    pub(crate) fn rows(&mut self, column: &Column, rows: &[u32]) -> Vec<u32> {
        rows.iter().map(|&r| column.at(r as usize).map_or(MISSING, |(values, i)| self.code(values, i))).collect()
    }

    /// The code of value `i` of `values` as an `f32` word, adding its text if new.
    fn code(&mut self, values: &Values, i: usize) -> u32 {
        let Some(text) = values.text().filter(|_| values.is_valid(i)) else { return MISSING };
        let t = text.get(i);
        let code = if let Some(&code) = self.codes.get(t) {
            code
        } else {
            let code = self.codes.len() as u32;
            let text: Arc<str> = t.into();
            self.codes.insert(text.clone(), code);
            self.texts.push(text);
            code
        };
        (code as f32).to_bits()
    }

    /// Number of codes assigned so far.
    pub(crate) fn len(&self) -> usize {
        self.texts.len()
    }

    /// The text of `code`.
    pub(crate) fn text(&self, code: u32) -> Option<&Arc<str>> {
        self.texts.get(code as usize)
    }

    /// The code of `text` as an `f32` word. Returns NaN, which matches no text, if `text` was never
    /// seen.
    pub(crate) fn code_of(&self, text: &str) -> u32 {
        self.codes.get(text).map_or(f32::NAN.to_bits(), |&code| (code as f32).to_bits())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Column;

    #[test]
    fn rewriting_a_coded_page_codes_only_the_written_rows() {
        let column = Column::new(&Values::from(vec!["a", "b", "c"]));
        let mut dictionary = Dictionary::default();
        let first = dictionary.codes(&column.pages()[0]);
        let written = column.write(3, &[(1, 0)], &Column::new(&Values::from(vec!["d"]))).expect("texts");
        let second = dictionary.codes(&written.pages()[0]);
        let text = |word: u32| dictionary.text(f32::from_bits(word) as u32).map(ToString::to_string);
        assert_eq!((second[0], second[2]), (first[0], first[2]), "rows not written keep their codes");
        assert_eq!(text(second[1]).as_deref(), Some("d"));
        assert_eq!(dictionary.len(), 4);
        assert!(Arc::ptr_eq(&dictionary.codes(&written.pages()[0]), &second), "a page is coded once");
    }
}
