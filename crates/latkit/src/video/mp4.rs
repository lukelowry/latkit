//! Fragmented MP4 muxing: one H.264 track written as it streams. `ftyp` and a `moov` with no
//! samples come first, built from the first keyframe's SPS and PPS. Then each run of frames from
//! one keyframe up to the next becomes a fragment: a `moof` with its samples' durations, sizes, and
//! flags, and an `mdat` holding them. Only the current run is kept in memory, so a video of any
//! length streams out using memory for one fragment.
//!
//! A frame lasts until the next one shows, so frames skipped because nothing moved take no space
//! (variable frame rate). Each fragment's decode time is its first frame's own time, so durations
//! never drift from the caller's clock. A sample is its NAL units with 4-byte lengths in place of
//! start codes, with access unit delimiters dropped and SPS and PPS kept in band.

use super::Unit;

/// The one track's id.
const TRACK: u32 = 1;
/// The NAL unit type of a sequence parameter set.
const SPS: u8 = 7;
/// The NAL unit type of a picture parameter set.
const PPS: u8 = 8;
/// The NAL unit type of an access unit delimiter.
const AUD: u8 = 9;
/// Sample flags of a keyframe: it depends on no other.
const KEY: u32 = 0x0200_0000;
/// Sample flags of a frame between keyframes: it depends on others and is not a sync sample.
const DELTA: u32 = 0x0101_0000;
/// The identity transform, in 16.16 and 2.30 fixed point.
const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// A fragmented MP4 muxer for one H.264 track: takes access units and returns the bytes to write.
pub(crate) struct Muxer {
    size: [u32; 2],
    timescale: u32,
    /// Whether `ftyp` and `moov` were written.
    headed: bool,
    /// How many fragments were written.
    sequence: u32,
    /// The frames of the current fragment, starting with its keyframe.
    run: Vec<Sample>,
    /// Their NAL units, length-prefixed: the fragment's `mdat` payload.
    data: Vec<u8>,
    /// The time of the last frame taken.
    last: Option<u64>,
}

/// A frame of the current fragment.
struct Sample {
    /// Presentation time in ticks.
    time: u64,
    /// Its size in bytes in the `mdat` payload.
    size: u32,
}

impl Muxer {
    /// A muxer for one H.264 track of `size` pixels, with frame times in ticks of `timescale` per
    /// second.
    pub(crate) fn new(size: [u32; 2], timescale: u32) -> Muxer {
        Muxer { size, timescale, headed: false, sequence: 0, run: Vec::new(), data: Vec::new(), last: None }
    }

    /// Takes one access unit and returns the bytes to write next, in order: `ftyp` and `moov`
    /// before the first keyframe's fragment, and a fragment (`moof` + `mdat`) whenever a keyframe
    /// closes the run of frames before it. A frame lasts until the next frame's time, so frames
    /// skipped because nothing moved take no space (variable frame rate). Units before the first
    /// keyframe are dropped. Errors with a reason when the first keyframe lacks an SPS and PPS, or
    /// its SPS is too short.
    ///
    /// A unit whose time is not after the last one's is shown one tick after it. A unit holding
    /// only access unit delimiters is dropped, and the previous frame lasts longer.
    pub(crate) fn push(&mut self, unit: &Unit) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        if self.run.is_empty() && !unit.key {
            return Ok(out);
        }
        if !self.headed {
            let first = |kind| nals(&unit.annex_b).find(|nal| nal[0] & 0x1f == kind);
            let (Some(sps), Some(pps)) = (first(SPS), first(PPS)) else {
                return Err("the first keyframe holds no SPS and PPS".into());
            };
            if sps.len() < 4 {
                return Err(format!("the first keyframe's SPS is {} bytes, too short to name a profile", sps.len()));
            }
            self.header(sps, pps, &mut out);
            self.headed = true;
        }
        if !nals(&unit.annex_b).any(|nal| nal[0] & 0x1f != AUD) {
            return Ok(out);
        }
        let time = self.last.map_or(unit.time, |last| unit.time.max(last + 1));
        if unit.key && !self.run.is_empty() {
            self.fragment(time, &mut out);
        }
        let start = self.data.len();
        for nal in nals(&unit.annex_b).filter(|nal| nal[0] & 0x1f != AUD) {
            self.data.extend((nal.len() as u32).to_be_bytes());
            self.data.extend_from_slice(nal);
        }
        self.run.push(Sample { time, size: (self.data.len() - start) as u32 });
        self.last = Some(time);
        Ok(out)
    }

    /// Ends the video at `end` ticks; the last frame lasts until then, at least one tick. Returns
    /// the last fragment's bytes, or nothing if no frame is pending.
    pub(crate) fn finish(&mut self, end: u64) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(last) = self.run.last().map(|sample| sample.time) {
            self.fragment(end.max(last + 1), &mut out);
        }
        out
    }

    /// Writes `ftyp` and the `moov` describing the track, built from the first keyframe's `sps` and
    /// `pps`.
    fn header(&self, sps: &[u8], pps: &[u8], out: &mut Vec<u8>) {
        boxed(out, *b"ftyp", |o| {
            o.extend_from_slice(b"isom");
            o.extend(0x200_u32.to_be_bytes());
            o.extend_from_slice(b"isomiso6avc1mp41");
        });
        boxed(out, *b"moov", |o| {
            full(o, *b"mvhd", 0, 0, |o| {
                o.extend([0; 8]); // creation and modification times
                o.extend(self.timescale.to_be_bytes());
                o.extend([0; 4]); // duration: set by the fragments
                o.extend(0x0001_0000_u32.to_be_bytes()); // rate
                o.extend(0x0100_u16.to_be_bytes()); // volume
                o.extend([0; 10]);
                matrix(o);
                o.extend([0; 24]);
                o.extend((TRACK + 1).to_be_bytes());
            });
            boxed(o, *b"trak", |o| {
                self.tkhd(o);
                boxed(o, *b"mdia", |o| {
                    full(o, *b"mdhd", 0, 0, |o| {
                        o.extend([0; 8]);
                        o.extend(self.timescale.to_be_bytes());
                        o.extend([0; 4]);
                        o.extend(0x55c4_u16.to_be_bytes()); // `und`, three 5-bit letters
                        o.extend([0; 2]);
                    });
                    full(o, *b"hdlr", 0, 0, |o| {
                        o.extend([0; 4]);
                        o.extend_from_slice(b"vide");
                        o.extend([0; 12]);
                        o.extend_from_slice(b"latkit\0");
                    });
                    boxed(o, *b"minf", |o| {
                        full(o, *b"vmhd", 0, 1, |o| o.extend([0; 8]));
                        boxed(o, *b"dinf", |o| {
                            full(o, *b"dref", 0, 0, |o| {
                                o.extend(1_u32.to_be_bytes());
                                full(o, *b"url ", 0, 1, |_| {});
                            });
                        });
                        boxed(o, *b"stbl", |o| {
                            full(o, *b"stsd", 0, 0, |o| {
                                o.extend(1_u32.to_be_bytes());
                                self.avc1(sps, pps, o);
                            });
                            for (kind, zeros) in [(*b"stts", 4), (*b"stsc", 4), (*b"stsz", 8), (*b"stco", 4)] {
                                full(o, kind, 0, 0, |o| o.resize(o.len() + zeros, 0));
                            }
                        });
                    });
                });
            });
            boxed(o, *b"mvex", |o| {
                full(o, *b"trex", 0, 0, |o| {
                    o.extend(TRACK.to_be_bytes());
                    o.extend(1_u32.to_be_bytes()); // sample description
                    o.extend([0; 12]);
                });
            });
        });
    }

    /// Writes the track header: its id and its size.
    fn tkhd(&self, o: &mut Vec<u8>) {
        let [w, h] = self.size;
        full(o, *b"tkhd", 0, 3, |o| {
            o.extend([0; 8]);
            o.extend(TRACK.to_be_bytes());
            o.extend([0; 24]); // duration, layer, group, and volume, all zero
            matrix(o);
            o.extend((w << 16).to_be_bytes());
            o.extend((h << 16).to_be_bytes());
        });
    }

    /// Writes the `avc1` sample entry: the picture size, the decoder configuration from `sps` and
    /// `pps`, and the colors, BT.709 limited range.
    fn avc1(&self, sps: &[u8], pps: &[u8], o: &mut Vec<u8>) {
        let [w, h] = self.size;
        boxed(o, *b"avc1", |o| {
            o.extend([0; 6]);
            o.extend(1_u16.to_be_bytes()); // data reference
            o.extend([0; 16]);
            o.extend((w as u16).to_be_bytes());
            o.extend((h as u16).to_be_bytes());
            o.extend(0x0048_0000_u32.to_be_bytes()); // 72 dpi across
            o.extend(0x0048_0000_u32.to_be_bytes()); // and down
            o.extend([0; 4]);
            o.extend(1_u16.to_be_bytes()); // frames per sample
            o.extend([0; 32]); // compressor name
            o.extend(0x18_u16.to_be_bytes()); // depth
            o.extend((-1_i16).to_be_bytes());
            boxed(o, *b"avcC", |o| {
                // Version, profile, compatibility, level, 4-byte lengths, one SPS.
                o.extend([1, sps[1], sps[2], sps[3], 0xff, 0xe1]);
                o.extend((sps.len() as u16).to_be_bytes());
                o.extend_from_slice(sps);
                o.push(1);
                o.extend((pps.len() as u16).to_be_bytes());
                o.extend_from_slice(pps);
                if matches!(sps[1], 100 | 110 | 122 | 144) {
                    o.extend([0xfd, 0xf8, 0xf8, 0]); // 4:2:0, 8-bit, no SPS extensions
                }
            });
            boxed(o, *b"colr", |o| {
                o.extend_from_slice(b"nclx");
                o.extend([0, 1, 0, 1, 0, 1, 0]); // BT.709 primaries/transfer/matrix, limited range
            });
        });
    }

    /// Writes a fragment of the current run, the last frame lasting until `end`, and clears the
    /// run.
    fn fragment(&mut self, end: u64, out: &mut Vec<u8>) {
        self.sequence += 1;
        out.reserve(100 + 12 * self.run.len() + self.data.len());
        let start = out.len();
        let mut offset = 0;
        boxed(out, *b"moof", |o| {
            full(o, *b"mfhd", 0, 0, |o| o.extend(self.sequence.to_be_bytes()));
            boxed(o, *b"traf", |o| {
                full(o, *b"tfhd", 0, 0x02_0000, |o| o.extend(TRACK.to_be_bytes()));
                full(o, *b"tfdt", 1, 0, |o| o.extend(self.run[0].time.to_be_bytes()));
                full(o, *b"trun", 0, 0x0701, |o| {
                    o.extend((self.run.len() as u32).to_be_bytes());
                    offset = o.len();
                    o.extend([0; 4]);
                    let nexts = self.run.iter().skip(1).map(|sample| sample.time).chain([end]);
                    for (i, (sample, next)) in self.run.iter().zip(nexts).enumerate() {
                        let flags = if i == 0 { KEY } else { DELTA };
                        o.extend(u32::try_from(next - sample.time).unwrap_or(u32::MAX).to_be_bytes());
                        o.extend(sample.size.to_be_bytes());
                        o.extend(flags.to_be_bytes());
                    }
                });
            });
        });
        let data_offset = (out.len() - start + 8) as u32;
        out[offset..offset + 4].copy_from_slice(&data_offset.to_be_bytes());
        boxed(out, *b"mdat", |o| o.extend_from_slice(&self.data));
        self.run.clear();
        self.data.clear();
    }
}

/// Writes a box of type `kind` with the body `body` writes, filling in its size afterwards.
fn boxed(out: &mut Vec<u8>, kind: [u8; 4], body: impl FnOnce(&mut Vec<u8>)) {
    let start = out.len();
    out.extend([0; 4]);
    out.extend(kind);
    body(out);
    let size = (out.len() - start) as u32;
    out[start..start + 4].copy_from_slice(&size.to_be_bytes());
}

/// Writes a full box: a box whose body starts with its `version` and 24 bits of `flags`.
fn full(out: &mut Vec<u8>, kind: [u8; 4], version: u8, flags: u32, body: impl FnOnce(&mut Vec<u8>)) {
    boxed(out, kind, |o| {
        o.extend(((u32::from(version) << 24) | flags).to_be_bytes());
        body(o);
    });
}

/// Writes the identity transform.
fn matrix(out: &mut Vec<u8>) {
    for value in MATRIX {
        out.extend(value.to_be_bytes());
    }
}

/// The NAL units of Annex B `bytes`: the bytes between start codes, minus trailing zero bytes,
/// which belong to a following 4-byte start code (a NAL unit never ends in a zero byte).
pub(crate) fn nals(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut rest = start_code(bytes).map_or(&[][..], |at| &bytes[at + 3..]);
    std::iter::from_fn(move || {
        while !rest.is_empty() {
            let (nal, next) = match start_code(rest) {
                Some(at) => (&rest[..at], &rest[at + 3..]),
                None => (rest, &[][..]),
            };
            rest = next;
            let len = nal.iter().rposition(|&byte| byte != 0).map_or(0, |last| last + 1);
            if len > 0 {
                return Some(&nal[..len]);
            }
        }
        None
    })
}

/// Where the first 3-byte start code in `bytes` begins.
fn start_code(bytes: &[u8]) -> Option<usize> {
    bytes.windows(3).position(|w| w == [0, 0, 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUD_NAL: &[u8] = &[0x09, 0xf0];
    const SPS_NAL: &[u8] = &[0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78];
    const PPS_NAL: &[u8] = &[0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
    const IDR: &[u8] = &[0x65, 0x88, 0x84, 0x00, 0x21];
    const SLICE: &[u8] = &[0x41, 0x9a, 0x00, 0x03, 0x01, 0x7f];

    /// NAL units in Annex B form, with start codes alternating between 4 and 3 bytes.
    fn annex_b(nals: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, nal) in nals.iter().enumerate() {
            out.extend_from_slice(if i % 2 == 0 { &[0, 0, 0, 1] } else { &[0, 0, 1] });
            out.extend_from_slice(nal);
        }
        out
    }

    /// A keyframe at `time` with an access unit delimiter, SPS, and PPS.
    fn key(time: u64) -> Unit {
        Unit { time, key: true, annex_b: annex_b(&[AUD_NAL, SPS_NAL, PPS_NAL, IDR]) }
    }

    /// A frame between keyframes at `time`, with an access unit delimiter.
    fn delta(time: u64) -> Unit {
        Unit { time, key: false, annex_b: annex_b(&[AUD_NAL, SLICE]) }
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    /// The boxes in `bytes`, each as its type and body.
    fn boxes(mut bytes: &[u8]) -> Vec<([u8; 4], &[u8])> {
        let mut out = Vec::new();
        while !bytes.is_empty() {
            let size = u32_at(bytes, 0) as usize;
            out.push((bytes[4..8].try_into().unwrap(), &bytes[8..size]));
            bytes = &bytes[size..];
        }
        out
    }

    /// The body of the box of type `kind` in `bytes`, after skipping its first `skip` bytes.
    fn child(bytes: &[u8], skip: usize, kind: [u8; 4]) -> &[u8] {
        let found = boxes(&bytes[skip..]).into_iter().find(|(k, _)| *k == kind);
        found.unwrap_or_else(|| panic!("no {}", String::from_utf8_lossy(&kind))).1
    }

    fn kinds(bytes: &[u8]) -> Vec<String> {
        boxes(bytes).iter().map(|(kind, _)| String::from_utf8_lossy(kind).into_owned()).collect()
    }

    /// A parsed fragment.
    struct Fragment {
        sequence: u32,
        time: u64,
        /// Each sample's duration, size, and flags.
        samples: Vec<[u32; 3]>,
        offset: u32,
        moof: usize,
        data: Vec<u8>,
    }

    /// The fragments of a whole file.
    fn fragments(file: &[u8]) -> Vec<Fragment> {
        let all = boxes(file);
        let mut out = Vec::new();
        for pair in all.windows(2) {
            let [(kind, moof), (next, mdat)] = pair else { unreachable!() };
            if kind != b"moof" {
                continue;
            }
            assert_eq!(next, b"mdat");
            let traf = child(moof, 0, *b"traf");
            let tfhd = child(traf, 0, *b"tfhd");
            assert_eq!((u32_at(tfhd, 0), u32_at(tfhd, 4)), (0x02_0000, TRACK));
            let tfdt = child(traf, 0, *b"tfdt");
            assert_eq!(tfdt[0], 1, "tfdt version");
            let trun = child(traf, 0, *b"trun");
            assert_eq!(u32_at(trun, 0), 0x0701);
            let count = u32_at(trun, 4) as usize;
            assert_eq!(trun.len(), 12 + 12 * count);
            out.push(Fragment {
                sequence: u32_at(child(moof, 0, *b"mfhd"), 4),
                time: u64::from_be_bytes(tfdt[4..12].try_into().unwrap()),
                samples: (0..count).map(|i| [0, 4, 8].map(|k| u32_at(trun, 12 + 12 * i + k))).collect(),
                offset: u32_at(trun, 8),
                moof: moof.len() + 8,
                data: mdat.to_vec(),
            });
        }
        out
    }

    /// The NAL units of a length-prefixed sample.
    fn prefixed(mut sample: &[u8]) -> Vec<&[u8]> {
        let mut out = Vec::new();
        while !sample.is_empty() {
            let len = u32_at(sample, 0) as usize;
            out.push(&sample[4..4 + len]);
            sample = &sample[4 + len..];
        }
        out
    }

    #[test]
    fn the_header_comes_with_the_first_keyframe_and_fragments_with_later_ones() {
        let mut mp4 = Muxer::new([640, 360], 90_000);
        let mut file = Vec::new();
        let head = mp4.push(&key(0)).unwrap();
        assert_eq!(kinds(&head), ["ftyp", "moov"]);
        file.extend(head);
        for time in [3000, 6000] {
            assert_eq!(mp4.push(&delta(time)).unwrap(), b"");
        }
        let fragment = mp4.push(&key(9000)).unwrap();
        assert_eq!(kinds(&fragment), ["moof", "mdat"]);
        file.extend(fragment);
        assert_eq!(mp4.push(&delta(12_000)).unwrap(), b"");
        let last = mp4.finish(15_000);
        assert_eq!(kinds(&last), ["moof", "mdat"]);
        file.extend(last);
        assert_eq!(kinds(&file), ["ftyp", "moov", "moof", "mdat", "moof", "mdat"]);
        assert_eq!(mp4.finish(18_000), b"", "nothing left");

        let ftyp = boxes(&file)[0].1;
        assert_eq!(ftyp, b"isom\0\0\x02\0isomiso6avc1mp41");
        let moov = boxes(&file)[1].1;
        assert_eq!(kinds(moov), ["mvhd", "trak", "mvex"]);
        assert_eq!(u32_at(child(moov, 0, *b"mvhd"), 12), 90_000);
        let trak = child(moov, 0, *b"trak");
        let tkhd = child(trak, 0, *b"tkhd");
        assert_eq!((u32_at(tkhd, 0), u32_at(tkhd, 12)), (3, TRACK));
        assert_eq!((u32_at(tkhd, 76), u32_at(tkhd, 80)), (640 << 16, 360 << 16));
        let mdia = child(trak, 0, *b"mdia");
        assert_eq!(u32_at(child(mdia, 0, *b"mdhd"), 12), 90_000);
        assert_eq!(&child(mdia, 0, *b"hdlr")[8..12], b"vide");
        let stbl = child(child(mdia, 0, *b"minf"), 0, *b"stbl");
        assert_eq!(kinds(stbl), ["stsd", "stts", "stsc", "stsz", "stco"]);
        let trex = child(child(moov, 0, *b"mvex"), 0, *b"trex");
        assert_eq!((u32_at(trex, 4), u32_at(trex, 8)), (TRACK, 1));
        let sequences: Vec<u32> = fragments(&file).iter().map(|f| f.sequence).collect();
        assert_eq!(sequences, [1, 2]);
    }

    #[test]
    fn the_sample_entry_holds_the_parameter_sets_and_bt709() {
        let mut mp4 = Muxer::new([1920, 1080], 90_000);
        let head = mp4.push(&key(0)).unwrap();
        let moov = boxes(&head)[1].1;
        let stbl = [b"trak", b"mdia", b"minf", b"stbl"].into_iter().fold(moov, |body, kind| child(body, 0, *kind));
        let avc1 = child(child(stbl, 0, *b"stsd"), 8, *b"avc1");
        assert_eq!(&avc1[24..28], [0x07, 0x80, 0x04, 0x38], "width and height");
        let avcc = child(avc1, 78, *b"avcC");
        let mut want = vec![1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, SPS_NAL.len() as u8];
        want.extend_from_slice(SPS_NAL);
        want.extend([1, 0, PPS_NAL.len() as u8]);
        want.extend_from_slice(PPS_NAL);
        want.extend([0xfd, 0xf8, 0xf8, 0]);
        assert_eq!(avcc, want);
        assert_eq!(child(avc1, 78, *b"colr"), b"nclx\0\x01\0\x01\0\x01\0");
    }

    #[test]
    fn samples_are_timed_sized_and_placed_by_the_fragment() {
        let mut mp4 = Muxer::new([640, 360], 90_000);
        let mut file = Vec::new();
        let units = [key(0), delta(1500), delta(3000), key(9000), delta(10_500)];
        for unit in &units {
            file.extend(mp4.push(unit).unwrap());
        }
        file.extend(mp4.finish(12_000));
        let fragments = fragments(&file);
        let durations: Vec<Vec<u32>> = fragments.iter().map(|f| f.samples.iter().map(|s| s[0]).collect()).collect();
        assert_eq!(durations, [vec![1500, 1500, 6000], vec![1500, 1500]]);
        assert_eq!(fragments.iter().map(|f| f.time).collect::<Vec<_>>(), [0, 9000]);
        for fragment in &fragments {
            assert_eq!(fragment.offset as usize, fragment.moof + 8, "data offset is mdat's payload");
            let mut data = &fragment.data[..];
            for (i, &[_, size, flags]) in fragment.samples.iter().enumerate() {
                let (sample, rest) = data.split_at(size as usize);
                data = rest;
                let nals = prefixed(sample);
                if i == 0 {
                    assert_eq!(flags, KEY);
                    assert_eq!(nals, [SPS_NAL, PPS_NAL, IDR]);
                } else {
                    assert_eq!(flags, DELTA);
                    assert_eq!(nals, [SLICE]);
                }
            }
            assert!(data.is_empty(), "sizes cover mdat");
        }
    }

    #[test]
    fn late_units_move_a_tick_past_the_last_and_empty_units_are_dropped() {
        let mut mp4 = Muxer::new([64, 64], 1000);
        let mut file = mp4.push(&key(100)).unwrap();
        for unit in [delta(100), delta(50), Unit { time: 300, key: false, annex_b: annex_b(&[AUD_NAL]) }, delta(400)] {
            file.extend(mp4.push(&unit).unwrap());
        }
        file.extend(mp4.finish(0));
        let fragment = &fragments(&file)[0];
        assert_eq!(fragment.time, 100);
        assert_eq!(fragment.samples.iter().map(|s| s[0]).collect::<Vec<_>>(), [1, 1, 298, 1]);
    }

    #[test]
    fn frames_before_the_first_keyframe_are_dropped() {
        let mut mp4 = Muxer::new([64, 64], 1000);
        assert_eq!(mp4.push(&delta(0)).unwrap(), b"");
        assert_eq!(mp4.push(&delta(10)).unwrap(), b"");
        let mut file = mp4.push(&key(20)).unwrap();
        assert_eq!(kinds(&file), ["ftyp", "moov"]);
        file.extend(mp4.finish(30));
        let fragments = fragments(&file);
        assert_eq!(fragments.len(), 1);
        assert_eq!((fragments[0].time, &fragments[0].samples[..]), (20, &[[10, 31, KEY]][..]));
    }

    #[test]
    fn a_first_keyframe_without_parameter_sets_fails() {
        let mut mp4 = Muxer::new([64, 64], 1000);
        let bare = Unit { time: 0, key: true, annex_b: annex_b(&[AUD_NAL, IDR]) };
        assert!(mp4.push(&bare).is_err());
        let no_pps = Unit { time: 0, key: true, annex_b: annex_b(&[SPS_NAL, IDR]) };
        assert!(mp4.push(&no_pps).is_err());
        assert_eq!(mp4.finish(10), b"");
        assert_eq!(kinds(&mp4.push(&key(0)).unwrap()), ["ftyp", "moov"]);
    }

    #[test]
    fn durations_sum_to_the_callers_clock_over_an_hour() {
        let frames = 107_893_u64;
        let fps = 30_000.0 / 1001.0;
        let times: Vec<u64> = (0..frames).map(|i| (i as f64 * 90_000.0 / fps).round() as u64).collect();
        let mut mp4 = Muxer::new([16, 16], 90_000);
        let mut file = Vec::new();
        let tiny = |time, key| Unit {
            time,
            key,
            annex_b: if key { annex_b(&[SPS_NAL, PPS_NAL, IDR]) } else { vec![0, 0, 1, 0x41] },
        };
        for (i, &time) in times.iter().enumerate() {
            file.extend(mp4.push(&tiny(time, i % 60 == 0)).unwrap());
        }
        let last = *times.last().unwrap();
        let end = last + 3003;
        file.extend(mp4.finish(end));
        let mut clock = times[0];
        let mut samples = 0;
        for fragment in fragments(&file) {
            assert_eq!(fragment.time, clock, "no drift between fragments");
            clock += fragment.samples.iter().map(|s| u64::from(s[0])).sum::<u64>();
            samples += fragment.samples.len();
        }
        assert_eq!(samples as u64, frames);
        assert_eq!(clock - times[0], last - times[0] + (end - last));
    }
}
