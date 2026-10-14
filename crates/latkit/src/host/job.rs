//! Jobs: work too large for the frame (laying out in ranks or by stress, routing wires, cutting areas
//! into triangles), handed to the host to do off the frame. A job is bytes in and bytes out, so a
//! thread, or a worker holding its own copy of latkit, can do it with nothing shared. Its answer is a
//! [`Patch`]: the rows it worked out, by id, with their places, the paths their wires run along, or
//! their shapes.

use crate::data::{Field, GeometryBuilder, Id, Name, Op, Patch, Table, Value, Values, Version};
use crate::geo::mvt::Kind as Geometry;
use crate::geo::shapes::{earth_parts, triangles};
use crate::geo::tiles::{Decoded, TileKey, decode};
use crate::layout::layered::layered;
use crate::layout::levels::Graph;
use crate::layout::route::{Net, Terminal, route};
use crate::layout::stress::stress;
use crate::{Direction, Layered, Layout, Side};

/// Work latkit hands its [`Host`](super::Host) to do off the frame: bytes in, bytes out.
///
/// A host that does jobs elsewhere sends [`into_bytes`](Job::into_bytes) there, and answers with
/// what [`run`](Job::run) makes of [`from_bytes`](Job::from_bytes) of them.
#[derive(Clone, PartialEq, Eq)]
pub struct Job(Vec<u8>);

/// What a job does, its first word.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Layered = 1,
    Stress = 2,
    Routes = 3,
    Shapes = 4,
    Tile = 5,
    GeoJson = 6,
    Lanes = 7,
}

/// What a shapes job works out of each row's geometry.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Shaping {
    /// An area's triangles, the point its label hangs from first; on the earth, unwrapped and split
    /// along its grid.
    Triangles { earth: bool },
    /// An earth line's path: unwrapped, and bent with the globe; cheap enough that no job makes it.
    Path,
}

impl Shaping {
    fn code(self) -> u32 {
        match self {
            Shaping::Triangles { earth: false } => 0,
            Shaping::Triangles { earth: true } => 1,
            Shaping::Path => 2,
        }
    }

    fn from_code(code: u32) -> Option<Shaping> {
        match code {
            0 => Some(Shaping::Triangles { earth: false }),
            1 => Some(Shaping::Triangles { earth: true }),
            2 => Some(Shaping::Path),
            _ => None,
        }
    }

    /// The depth of the shapes made from geometry of `depth`.
    pub(crate) fn depth(self, depth: u8) -> u8 {
        match self {
            Shaping::Triangles { .. } => 1,
            Shaping::Path => depth,
        }
    }

    /// The shape of `value`, or `None` where it stays as it is: a path that needs no bending.
    pub(crate) fn shape(self, value: &Value) -> Option<Value> {
        match (self, value) {
            (Shaping::Triangles { earth }, Value::Polygons(polygons)) => Some(Value::Path(triangles(polygons, earth))),
            (Shaping::Triangles { earth }, Value::Parts(rings)) => {
                Some(Value::Path(triangles(std::slice::from_ref(rings), earth)))
            }
            (Shaping::Triangles { .. }, _) => Some(Value::Path(Vec::new())),
            (Shaping::Path, Value::Path(path)) => {
                earth_parts(std::slice::from_ref(path)).and_then(|mut parts| parts.pop()).map(Value::Path)
            }
            (Shaping::Path, Value::Parts(parts)) => earth_parts(parts).map(Value::Parts),
            (Shaping::Path, Value::Polygons(polygons)) => {
                let shaped: Vec<Option<Vec<Vec<[f64; 2]>>>> = polygons.iter().map(|rings| earth_parts(rings)).collect();
                shaped.iter().any(Option::is_some).then(|| {
                    Value::Polygons(
                        shaped
                            .into_iter()
                            .zip(polygons)
                            .map(|(shaped, rings)| shaped.unwrap_or_else(|| rings.clone()))
                            .collect(),
                    )
                })
            }
            (Shaping::Path, _) => None,
        }
    }
}

/// A row a job answers for: its table and id.
pub(crate) type Key = (Name, Id);

/// Vertices to place: each one's size, its center when it has one, its group and how far a group's
/// box reaches past its members (left, bottom, right, top), links between them, and the key of
/// each vertex the answer places; vertices without a key are only placed around. Plane units, y up.
pub(crate) struct Placement<'a> {
    pub(crate) sizes: &'a [[f64; 2]],
    pub(crate) pinned: &'a [Option<[f64; 2]>],
    pub(crate) groups: &'a [Option<u32>],
    pub(crate) pads: &'a [[f64; 4]],
    pub(crate) links: &'a [[u32; 2]],
    pub(crate) keys: &'a [Option<Key>],
}

/// Wires to route: around `obstacles` and among `groups`, each net's terminals with the key of the row
/// it draws, runs beside `fixed` wires already routed, tracks `spacing` apart. Plane units, y up.
pub(crate) struct Wiring<'a> {
    pub(crate) obstacles: &'a [[f64; 4]],
    pub(crate) groups: &'a [[f64; 4]],
    pub(crate) nets: &'a [Net],
    pub(crate) keys: &'a [Key],
    pub(crate) fixed: &'a [Vec<[f64; 2]>],
    pub(crate) spacing: f64,
}

impl Job {
    /// A job from its bytes.
    pub fn from_bytes(bytes: Vec<u8>) -> Job {
        Job(bytes)
    }

    /// The job as bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }

    /// Does the job, answering with a patch's bytes. Bytes that are no job answer nothing.
    pub fn run(self) -> Vec<u8> {
        let mut input = Reader::new(&self.0);
        let answer = match input.u32() {
            Some(k) if k == Kind::Layered as u32 || k == Kind::Stress as u32 => run_layout(k, &mut input),
            Some(k) if k == Kind::Routes as u32 => run_routes(&mut input),
            Some(k) if k == Kind::Shapes as u32 => run_shapes(&mut input),
            Some(k) if k == Kind::Tile as u32 => run_tile(&mut input),
            Some(k) if k == Kind::GeoJson as u32 => run_geojson(&mut input),
            Some(k) if k == Kind::Lanes as u32 => run_lanes(&mut input),
            _ => None,
        };
        answer.map(|patch| patch.to_bytes()).unwrap_or_default()
    }

    /// Placing `placement` by `layout`, which is layered or stress; it answers each keyed vertex's
    /// center as fields `x` and `y`, y up.
    pub(crate) fn layout(layout: &Layout, placement: &Placement<'_>) -> Job {
        let mut out = match *layout {
            Layout::Stress(stress) => {
                let mut out = Writer::new(Kind::Stress);
                out.f64(stress.gap);
                out
            }
            Layout::Layered(layered) => {
                let mut out = Writer::new(Kind::Layered);
                out.u32(match layered.flow {
                    Direction::Right => 0,
                    Direction::Left => 1,
                    Direction::Down => 2,
                    Direction::Up => 3,
                });
                out.f64(layered.gap);
                out.f64(layered.rank_gap);
                out
            }
            Layout::None => unreachable!("a sheet asks for a layout only when its scene has one"),
        };
        out.u32(placement.sizes.len() as u32);
        for v in 0..placement.sizes.len() {
            out.f64s(&placement.sizes[v]);
            out.u32(u32::from(placement.pinned[v].is_some()));
            out.f64s(&placement.pinned[v].unwrap_or_default());
            out.u32(placement.groups[v].unwrap_or(u32::MAX));
            out.f64s(&placement.pads[v]);
            out.u32(u32::from(placement.keys[v].is_some()));
            if let Some(key) = &placement.keys[v] {
                out.key(key);
            }
        }
        out.u32(placement.links.len() as u32);
        for link in placement.links {
            out.u32(link[0]);
            out.u32(link[1]);
        }
        Job(out.0)
    }

    /// Working out `shaping` for every row of `rows`, whose field `geometry` holds each row's
    /// geometry; it answers each row's shape as field `shape`.
    pub(crate) fn shapes(shaping: Shaping, rows: Table) -> Job {
        let mut out = Writer::new(Kind::Shapes);
        out.u32(shaping.code());
        out.0.extend(Patch::new().set(rows).to_bytes());
        Job(out.0)
    }

    /// Decoding tile `key` from `bytes`, gzip-compressed or not, into the rows of `tables`; it answers
    /// those rows.
    pub(crate) fn tile(key: TileKey, tables: &[Decoded], bytes: &[u8]) -> Job {
        let mut out = Writer::new(Kind::Tile);
        out.u32(u32::from(key.z));
        out.u32(key.x);
        out.u32(key.y);
        out.u32(tables.len() as u32);
        for decoded in tables {
            out.text(&decoded.layer);
            out.u32(match decoded.kind {
                Geometry::Points => 0,
                Geometry::Lines => 1,
                Geometry::Polygons => 2,
            });
            out.text(&decoded.table);
        }
        out.0.extend_from_slice(bytes);
        Job(out.0)
    }

    /// Reading GeoJSON `bytes` as dataset `name`, as [`geo::geojson`](crate::geo::geojson) does; it
    /// answers the patch that builds the dataset, or nothing when the bytes are no GeoJSON.
    pub fn geojson(name: &str, bytes: &[u8]) -> Job {
        let mut out = Writer::new(Kind::GeoJson);
        out.text(name);
        out.0.extend_from_slice(bytes);
        Job(out.0)
    }

    /// Finding every edge row's lane among the rows joining the same two vertices, from each row's two
    /// ends; it answers a table of every row's lane as field `lane`, without rows when none share.
    pub(crate) fn lanes(from: &[u32], to: &[u32]) -> Job {
        let mut out = Writer::new(Kind::Lanes);
        out.u32(from.len() as u32);
        out.words(from);
        out.words(to);
        Job(out.0)
    }

    /// Routing `wiring`; it answers each keyed row's wire as field `route`, its polylines.
    pub(crate) fn routes(wiring: &Wiring<'_>) -> Job {
        let mut out = Writer::new(Kind::Routes);
        out.f64(wiring.spacing);
        for boxes in [wiring.obstacles, wiring.groups] {
            out.u32(boxes.len() as u32);
            for b in boxes {
                out.f64s(b);
            }
        }
        out.u32(wiring.fixed.len() as u32);
        for line in wiring.fixed {
            out.u32(line.len() as u32);
            for point in line {
                out.f64s(point);
            }
        }
        out.u32(wiring.nets.len() as u32);
        for (net, key) in wiring.nets.iter().zip(wiring.keys) {
            out.key(key);
            out.u32(net.terminals.len() as u32);
            for terminal in &net.terminals {
                out.f64s(&terminal.at);
                out.u32(terminal.side.map_or(u32::MAX, Side::code));
                out.u32(terminal.owner.unwrap_or(u32::MAX));
            }
        }
        Job(out.0)
    }
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Job").field(&self.0.len()).finish()
    }
}

/// A patch writing `values` for `keys`, one table at a time in the order the keys name them.
fn keyed<T>(keys: &[Key], values: Vec<T>, write: impl Fn(Table, Vec<T>) -> Table) -> Patch {
    let mut tables: Vec<(Name, Vec<Id>, Vec<T>)> = Vec::new();
    for ((table, id), value) in keys.iter().zip(values) {
        match tables.iter_mut().find(|(name, ..)| name == table) {
            Some((_, ids, values)) => {
                ids.push(id.clone());
                values.push(value);
            }
            None => tables.push((table.clone(), vec![id.clone()], vec![value])),
        }
    }
    tables.into_iter().fold(Patch::new(), |patch, (name, ids, values)| patch.set(write(Table::new(name, ids), values)))
}

fn run_layout(kind: u32, input: &mut Reader<'_>) -> Option<Patch> {
    let options = if kind == Kind::Stress as u32 {
        Layout::Stress(crate::Stress { gap: input.f64()? })
    } else {
        let flow = match input.u32()? {
            0 => Direction::Right,
            1 => Direction::Left,
            2 => Direction::Down,
            _ => Direction::Up,
        };
        Layout::Layered(Layered { flow, gap: input.f64()?, rank_gap: input.f64()? })
    };
    let count = input.u32()? as usize;
    let (mut sizes, mut pinned, mut groups, mut pads, mut keys) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for _ in 0..count {
        sizes.push([input.f64()?, input.f64()?]);
        let pin = input.u32()? != 0;
        let at = [input.f64()?, input.f64()?];
        pinned.push(pin.then_some(at));
        groups.push(Some(input.u32()?).filter(|&g| (g as usize) < count));
        pads.push([input.f64()?, input.f64()?, input.f64()?, input.f64()?]);
        let keyed = input.u32()? != 0;
        keys.push(if keyed { Some(input.key()?) } else { None });
    }
    let links = input.u32()?;
    let links = (0..links).map(|_| Some([input.u32()?, input.u32()?])).collect::<Option<Vec<_>>>()?;
    if links.iter().flatten().any(|&v| v as usize >= count) {
        return None;
    }
    let graph = Graph { sizes: &sizes, links: &links, pinned: &pinned, groups: &groups, pads: &pads };
    let centers = match options {
        Layout::Stress(s) => stress(&graph, s.gap),
        Layout::Layered(l) => layered(&graph, &l),
        Layout::None => return None,
    };
    let placed: Vec<(Key, [f64; 2])> =
        keys.into_iter().zip(centers).filter_map(|(key, center)| Some((key?, center))).collect();
    let (keys, centers): (Vec<Key>, Vec<[f64; 2]>) = placed.into_iter().unzip();
    Some(keyed(&keys, centers, |table, centers| {
        let (x, y): (Vec<f64>, Vec<f64>) = centers.into_iter().map(|c| (c[0], c[1])).unzip();
        table.field("x", x).field("y", y)
    }))
}

fn run_routes(input: &mut Reader<'_>) -> Option<Patch> {
    let spacing = input.f64()?;
    let mut boxes = || {
        let count = input.u32()?;
        (0..count).map(|_| Some([input.f64()?, input.f64()?, input.f64()?, input.f64()?])).collect::<Option<Vec<_>>>()
    };
    let (obstacles, groups) = (boxes()?, boxes()?);
    let count = input.u32()?;
    let fixed = (0..count)
        .map(|_| {
            let points = input.u32()?;
            (0..points).map(|_| Some([input.f64()?, input.f64()?])).collect::<Option<Vec<_>>>()
        })
        .collect::<Option<Vec<_>>>()?;
    let count = input.u32()?;
    let (mut nets, mut keys) = (Vec::new(), Vec::new());
    for _ in 0..count {
        keys.push(input.key()?);
        let terminals = input.u32()?;
        let terminals = (0..terminals)
            .map(|_| {
                let at = [input.f64()?, input.f64()?];
                let side = Side::from_code(input.u32()?);
                let owner = Some(input.u32()?).filter(|&o| (o as usize) < obstacles.len());
                Some(Terminal { at, side, owner })
            })
            .collect::<Option<Vec<_>>>()?;
        nets.push(Net { terminals });
    }
    let routes = route(&obstacles, &groups, &nets, &fixed, spacing);
    Some(keyed(&keys, routes, |table, routes| table.field("route", routes)))
}

fn run_shapes(input: &mut Reader<'_>) -> Option<Patch> {
    let shaping = Shaping::from_code(input.u32()?)?;
    let Op::Set(rows) = Patch::from_bytes(input.rest()).ok()?.ops.into_iter().next()? else { return None };
    let Some(Field::Values(column, _)) = rows.field_named("geometry") else { return None };
    let crate::Kind::Geometry(depth) = column.kind() else { return None };
    let mut shapes = GeometryBuilder::new(shaping.depth(depth));
    for row in 0..rows.len() {
        match column.get(row) {
            Some(value) => {
                let shaped = shaping.shape(&value);
                shapes.push_value(shaped.as_ref().unwrap_or(&value));
            }
            None => shapes.push_empty(),
        }
    }
    let shapes = Values::of_geometry(shapes.finish());
    let mut answer = rows.clone();
    answer.fields.clear();
    answer.insert("shape".into(), Field::Values(crate::data::Column::new(&shapes), Version::next()));
    Some(Patch::new().set(answer))
}

fn run_tile(input: &mut Reader<'_>) -> Option<Patch> {
    let key = TileKey { z: u8::try_from(input.u32()?).ok()?, x: input.u32()?, y: input.u32()? };
    let count = input.u32()?;
    let tables = (0..count)
        .map(|_| {
            let layer = input.text()?;
            let kind = match input.u32()? {
                0 => Geometry::Points,
                1 => Geometry::Lines,
                _ => Geometry::Polygons,
            };
            Some(Decoded { layer, kind, table: input.text()?.into() })
        })
        .collect::<Option<Vec<_>>>()?;
    decode(input.rest(), key, &tables)
}

fn run_geojson(input: &mut Reader<'_>) -> Option<Patch> {
    let name = input.text()?;
    crate::geo::geojson(name, input.rest()).ok().map(|data| data.to_patch())
}

fn run_lanes(input: &mut Reader<'_>) -> Option<Patch> {
    let rows = input.u32()? as usize;
    let (from, to) = (input.words(rows)?, input.words(rows)?);
    Some(crate::derive::lanes_answer(&from, &to))
}

/// Little-endian words, floats, and keys, written.
struct Writer(Vec<u8>);

impl Writer {
    fn new(kind: Kind) -> Writer {
        let mut out = Writer(Vec::new());
        out.u32(kind as u32);
        out
    }

    fn u32(&mut self, v: u32) {
        self.0.extend(v.to_le_bytes());
    }

    fn f64(&mut self, v: f64) {
        self.0.extend(v.to_le_bytes());
    }

    /// Words, copied whole where the machine is little-endian too.
    fn words(&mut self, words: &[u32]) {
        if cfg!(target_endian = "little") {
            self.0.extend_from_slice(bytemuck::cast_slice(words));
        } else {
            self.0.extend(words.iter().flat_map(|w| w.to_le_bytes()));
        }
    }

    fn f64s(&mut self, vs: &[f64]) {
        for &v in vs {
            self.f64(v);
        }
    }

    fn text(&mut self, text: &str) {
        self.u32(text.len() as u32);
        self.0.extend(text.as_bytes());
    }

    /// A key: 1 then a numbered id, or 2 then a texted one; the table's name after.
    fn key(&mut self, (table, id): &Key) {
        match id {
            Id::Number(n) => {
                self.u32(1);
                self.0.extend(n.to_le_bytes());
            }
            Id::Text(t) => {
                self.u32(2);
                self.text(t);
            }
        }
        self.text(table);
    }
}

/// Little-endian words, floats, and keys, read; `None` past the end.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes }
    }

    /// Every byte not read yet.
    fn rest(&mut self) -> &'a [u8] {
        std::mem::take(&mut self.bytes)
    }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.bytes.split_first_chunk::<N>()?;
        self.bytes = rest;
        Some(*head)
    }

    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }

    fn f64(&mut self) -> Option<f64> {
        self.take().map(f64::from_le_bytes)
    }

    /// `n` words.
    fn words(&mut self, n: usize) -> Option<Vec<u32>> {
        let (head, rest) = self.bytes.split_at_checked(n.checked_mul(4)?)?;
        self.bytes = rest;
        Some(head.as_chunks::<4>().0.iter().map(|&w| u32::from_le_bytes(w)).collect())
    }

    fn text(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        let (head, rest) = self.bytes.split_at_checked(len)?;
        self.bytes = rest;
        String::from_utf8(head.to_vec()).ok()
    }

    /// A key as [`Writer::key`] wrote it.
    fn key(&mut self) -> Option<Key> {
        let id = match self.u32()? {
            1 => Id::Number(u64::from_le_bytes(self.take()?)),
            2 => Id::from(self.text()?),
            _ => return None,
        };
        Some((self.text()?.into(), id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Value;

    fn key(table: &str, id: u64) -> Key {
        (table.into(), Id::Number(id))
    }

    /// Field `field` of `table`'s row `id` in the answer.
    fn answered(answer: &[u8], table: &str, id: u64, field: &str) -> Option<Value> {
        let mut data = crate::Data::new("d");
        data.apply(Patch::from_bytes(answer).ok()?).ok()?;
        data.get(&crate::Row::new("d", table, id), field)
    }

    #[test]
    fn layout_jobs_answer_the_rows_they_place() {
        let sizes = [[10.0, 10.0]; 3];
        let pinned = [None, Some([5.0, 5.0]), None];
        let keys = [Some(key("V", 7)), None, Some(key("V", 9))];
        let placement = Placement {
            sizes: &sizes,
            pinned: &pinned,
            groups: &[None; 3],
            pads: &[[0.0; 4]; 3],
            links: &[[0, 1], [1, 2]],
            keys: &keys,
        };
        let answer = Job::from_bytes(Job::layout(&Layout::Layered(Layered::default()), &placement).into_bytes()).run();
        let ranked = layered(
            &Graph {
                sizes: &sizes,
                links: &[[0, 1], [1, 2]],
                pinned: &pinned,
                groups: &[None; 3],
                pads: &[[0.0; 4]; 3],
            },
            &Layered::default(),
        );
        assert_eq!(answered(&answer, "V", 9, "x"), Some(Value::Number(ranked[2][0])));
        assert_eq!(answered(&answer, "V", 7, "y"), Some(Value::Number(ranked[0][1])));
        let stress = Job::layout(&Layout::Stress(crate::Stress::default()), &placement).run();
        assert!(matches!(answered(&stress, "V", 7, "x"), Some(Value::Number(_))), "stress answers alike");
    }

    #[test]
    fn route_jobs_answer_routed_wires() {
        let obstacles = [[0.0, 0.0, 10.0, 10.0], [40.0, 0.0, 50.0, 10.0]];
        let terminal = |x: f64, side, owner| Terminal { at: [x, 5.0], side: Some(side), owner: Some(owner) };
        let nets = [Net { terminals: vec![terminal(10.0, Side::Right, 0), terminal(40.0, Side::Left, 1)] }];
        let wiring = Wiring {
            obstacles: &obstacles,
            groups: &[],
            nets: &nets,
            keys: &[key("Wire", 3)],
            fixed: &[],
            spacing: 2.0,
        };
        let answer = Job::routes(&wiring).run();
        let want = route(&obstacles, &[], &nets, &[], 2.0).swap_remove(0);
        assert_eq!(answered(&answer, "Wire", 3, "route"), Some(Value::Parts(want)));
    }

    #[test]
    fn bytes_that_are_no_job_answer_nothing() {
        assert_eq!(Job::from_bytes(vec![1, 0, 0, 0, 9]).run(), Vec::<u8>::new());
        assert_eq!(Job::from_bytes(Vec::new()).run(), Vec::<u8>::new());
    }
}
