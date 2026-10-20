//! PMTiles archives, version 3: a header, directories of tile entries along the Hilbert curve, and
//! the tiles, each found by range requests.

use crate::tiles::TileKey;

/// Bytes a header takes.
pub(crate) const HEADER: usize = 127;
const MAGIC: &[u8] = b"PMTiles";
/// How deep directories nest at most.
pub(crate) const DEPTH: usize = 4;

/// What an archive's header says.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Header {
    pub(crate) root: (u64, u64),
    pub(crate) metadata: (u64, u64),
    pub(crate) leaves: u64,
    pub(crate) data: u64,
    /// Whether directories, and tiles, are gzip-compressed.
    pub(crate) gzip_directories: bool,
    pub(crate) gzip_tiles: bool,
    pub(crate) vector: bool,
    pub(crate) min_zoom: u8,
    pub(crate) max_zoom: u8,
    /// West, south, east, north.
    pub(crate) bounds: [f64; 4],
}

/// Whether `bytes` begin a PMTiles archive.
pub(crate) fn is_archive(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

/// The header at the start of `bytes`: a version 3 archive's, with compression read or none.
pub(crate) fn header(bytes: &[u8]) -> Result<Header, String> {
    if !is_archive(bytes) || bytes.len() < HEADER {
        return Err("these bytes are not a PMTiles archive".into());
    }
    if bytes[7] != 3 {
        return Err(format!("PMTiles version {} is not read; version 3 is", bytes[7]));
    }
    let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().expect("eight bytes"));
    let degrees = |at: usize| f64::from(i32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"))) / 1e7;
    let compression = |code: u8, what: &str| match code {
        0 | 1 => Ok(false),
        2 => Ok(true),
        other => Err(format!("the archive's {what} use compression {other}; only gzip is read")),
    };
    Ok(Header {
        root: (u64_at(8), u64_at(16)),
        metadata: (u64_at(24), u64_at(32)),
        leaves: u64_at(40),
        data: u64_at(56),
        gzip_directories: compression(bytes[97], "directories")?,
        gzip_tiles: compression(bytes[98], "tiles")?,
        vector: bytes[99] == 1 || bytes[99] == 0,
        min_zoom: bytes[100],
        max_zoom: bytes[101],
        bounds: [degrees(102), degrees(106), degrees(110), degrees(114)],
    })
}

/// A directory's entries, sorted by tile id: each one's id, run length (0 for a leaf directory),
/// offset, and length.
#[derive(Clone, Default, Debug)]
pub(crate) struct Directory {
    ids: Vec<u64>,
    runs: Vec<u32>,
    offsets: Vec<u64>,
    lengths: Vec<u32>,
}

/// Where a directory sends a tile.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Entry {
    /// The tile's bytes: offset from the data section, and length.
    Tile(u64, u64),
    /// A leaf directory: offset from the leaf section, and length.
    Leaf(u64, u64),
}

impl Directory {
    /// The directory in `bytes`, decompressed.
    pub(crate) fn decode(bytes: &[u8]) -> Option<Directory> {
        let mut at = 0;
        let mut next = || -> Option<u64> {
            let mut value = 0_u64;
            for shift in (0..64).step_by(7) {
                let byte = *bytes.get(at)?;
                at += 1;
                value |= u64::from(byte & 0x7f) << shift;
                if byte < 0x80 {
                    return Some(value);
                }
            }
            None
        };
        let count = usize::try_from(next()?).ok()?;
        if count > bytes.len() {
            return None;
        }
        let mut id = 0;
        let ids: Vec<u64> = (0..count)
            .map(|_| {
                next().map(|d| {
                    id += d;
                    id
                })
            })
            .collect::<Option<_>>()?;
        let runs: Vec<u32> = (0..count).map(|_| next().map(|v| v as u32)).collect::<Option<_>>()?;
        let lengths: Vec<u32> = (0..count).map(|_| next().map(|v| v as u32)).collect::<Option<_>>()?;
        let mut offsets: Vec<u64> = Vec::with_capacity(count);
        for i in 0..count {
            let value = next()?;
            let offset = match (value, i) {
                (0, 0) => return None,
                (0, _) => offsets[i - 1] + u64::from(lengths[i - 1]),
                (v, _) => v - 1,
            };
            offsets.push(offset);
        }
        Some(Directory { ids, runs, offsets, lengths })
    }

    /// Where the entry holding tile id `id` sends it, if any does.
    pub(crate) fn find(&self, id: u64) -> Option<Entry> {
        let i = match self.ids.binary_search(&id) {
            Ok(i) => i,
            Err(0) => return None,
            Err(i) => i - 1,
        };
        let (offset, length) = (self.offsets[i], u64::from(self.lengths[i]));
        match self.runs[i] {
            0 => Some(Entry::Leaf(offset, length)),
            run if id - self.ids[i] < u64::from(run) => Some(Entry::Tile(offset, length)),
            _ => None,
        }
    }
}

/// Tile `key`'s id along the Hilbert curve, counting every tile of the zooms before it.
pub(crate) fn tile_id(key: TileKey) -> u64 {
    let z = u32::from(key.z);
    let before: u64 = (0..z).map(|k| 1_u64 << (2 * k)).sum();
    let n = 1_u64 << z;
    let (mut x, mut y) = (u64::from(key.x), u64::from(key.y));
    let mut index = 0;
    let mut s = n / 2;
    while s > 0 {
        let rx = u64::from(x & s != 0);
        let ry = u64::from(y & s != 0);
        index += s * s * ((3 * rx) ^ ry);
        if ry == 0 {
            if rx == 1 {
                x = n - 1 - x;
                y = n - 1 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        s /= 2;
    }
    before + index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_ids_follow_the_hilbert_curve() {
        assert_eq!(tile_id(TileKey { z: 0, x: 0, y: 0 }), 0);
        // Zoom 1 goes around its four tiles from the top left, down, then right.
        let ids: Vec<u64> = [(0, 0), (0, 1), (1, 1), (1, 0)].map(|(x, y)| tile_id(TileKey { z: 1, x, y })).to_vec();
        assert_eq!(ids, vec![1, 2, 3, 4]);
        assert_eq!(tile_id(TileKey { z: 2, x: 0, y: 0 }), 5);
    }

    #[test]
    fn directories_find_tiles_and_leaves() {
        // Entries: ids 0 (a run of 2 tiles), 5 (a leaf); offsets written as offset + 1, then 0 for
        // "right after the one before".
        let bytes = [2, 0, 5, 2, 0, 10, 20, 1, 0];
        let directory = Directory::decode(&bytes).expect("a directory");
        assert_eq!(directory.find(0), Some(Entry::Tile(0, 10)));
        assert_eq!(directory.find(1), Some(Entry::Tile(0, 10)), "inside the run");
        assert_eq!(directory.find(2), None, "past the run");
        assert_eq!(directory.find(7), Some(Entry::Leaf(10, 20)));
    }
}
