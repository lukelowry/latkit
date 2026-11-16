//! Jobs: work that scales with the data, handed to the host to run in the background. Jobs lay
//! out graphs (layered or stress), triangulate areas, assign edge lanes, group a large table's rows
//! into tiles, and decode vector tiles and GeoJSON.
//!
//! A job is bytes in and bytes out, so a thread, or a worker with a module of its own, can run it
//! with nothing shared. Only [`Job::run`] reaches the code that does a job's work, so a module
//! that never calls it, as the browser's drawing module does not, carries none of that code.
//! Layout, tile, and GeoJSON jobs return a [`Patch`] of rows by id. Other jobs return their own
//! format: lane words, shape columns, or each table's pyramid (order and tiles).

use std::sync::Arc;

use crate::data::{
    GeometryBuilder, Id, Name, Patch, Reference, Table, UNWIRED, Value, Values, read_values, values_bytes,
};
use crate::derive::pyramid::{Leveling, Places, Placing};
use crate::derive::sight::Domain;
use crate::geo::mvt::Kind as Geometry;
use crate::geo::shapes::{earth_path, triangles};
use crate::geo::tiles::{Decoded, decode};
use crate::layout::{graph::Graph, layered::layered, stress::stress};
use crate::tiles::TileKey;
use crate::wire::{In, Out, codes};
use crate::{Direction, Layered, Layout, Projection};

/// Work latkit hands its [`Host`](super::Host) to run in the background: bytes in, bytes out.
///
/// A host that runs jobs elsewhere sends the job's [`into_bytes`](Job::into_bytes) there, rebuilds
/// it with [`from_bytes`](Job::from_bytes), and returns the result of [`run`](Job::run).
#[derive(Clone, PartialEq, Eq)]
pub struct Job(Vec<u8>);

/// A job's type, stored as its first word.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Layered,
    Stress,
    Shapes,
    Tile,
    GeoJson,
    Lanes,
    Pyramid,
}

codes!(Kind { Layered = 1, Stress = 2, Shapes = 3, Tile = 4, GeoJson = 5, Lanes = 6, Pyramid = 7 });

/// The shapes computed from each row's geometry, for the space they draw in. On the earth they
/// follow its projection, so a scene that changes projection shapes its rows again.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Shaping {
    /// An area's triangles, after its label anchor. On the earth, rings are unwrapped across the
    /// antimeridian, and on the globe triangles are split along the earth grid.
    Triangles(Option<Projection>),
    /// An earth line's path, unwrapped across the antimeridian, and on the globe given extra
    /// points to follow its curve. Cheap enough to compute on the frame with
    /// [`earth_path`], so it never needs a shapes job.
    Path(Projection),
}

impl Shaping {
    fn code(self) -> u32 {
        match self {
            Shaping::Triangles(None) => 0,
            Shaping::Triangles(Some(Projection::Mercator)) => 1,
            Shaping::Triangles(Some(Projection::Globe)) => 2,
            Shaping::Path(Projection::Mercator) => 3,
            Shaping::Path(Projection::Globe) => 4,
        }
    }

    fn from_code(code: u32) -> Option<Shaping> {
        match code {
            0 => Some(Shaping::Triangles(None)),
            1 => Some(Shaping::Triangles(Some(Projection::Mercator))),
            2 => Some(Shaping::Triangles(Some(Projection::Globe))),
            3 => Some(Shaping::Path(Projection::Mercator)),
            4 => Some(Shaping::Path(Projection::Globe)),
            _ => None,
        }
    }

    /// The geometry depth of shapes made from geometry of `depth`.
    pub(crate) fn depth(self, depth: u8) -> u8 {
        match self {
            Shaping::Triangles(_) => 1,
            Shaping::Path(_) => depth,
        }
    }

    /// Whether geometry of `depth` gets this shaping. Triangles apply to parts or polygons, and
    /// paths to anything but points.
    pub(crate) fn takes(self, depth: u8) -> bool {
        match self {
            Shaping::Triangles(_) => matches!(depth, 2 | 3),
            Shaping::Path(_) => depth >= 1,
        }
    }

    /// Name of the derived field holding the shapes of geometry field `field`.
    pub(crate) fn field_of(self, field: &str) -> Name {
        match self {
            Shaping::Triangles(_) => crate::scene::areas::triangles_of(field),
            Shaping::Path(_) => crate::scene::lines::path_of(field),
        }
    }

    /// Computes the shapes of every row of geometry `values`, in order. A missing row gets an empty
    /// shape, and a path that needs no extra points is copied unchanged.
    pub(crate) fn shapes_of(self, values: &Values) -> Values {
        let depth = values.geometry().map_or(0, crate::data::Geometry::depth);
        let mut shapes = GeometryBuilder::new(self.depth(depth));
        for row in 0..values.len() {
            match values.get(row) {
                Some(value) => {
                    let shaped = self.shape(&value);
                    shapes.push_value(shaped.as_ref().unwrap_or(&value));
                }
                None => shapes.push_empty(),
            }
        }
        Values::of_geometry(shapes.finish())
    }

    /// The shape of `value`, or `None` if it is unchanged (a path that needs no extra points).
    pub(crate) fn shape(self, value: &Value) -> Option<Value> {
        match (self, value) {
            (Shaping::Triangles(earth), Value::Polygons(polygons)) => Some(Value::Path(triangles(polygons, earth))),
            (Shaping::Triangles(earth), Value::Parts(rings)) => {
                Some(Value::Path(triangles(std::slice::from_ref(rings), earth)))
            }
            (Shaping::Triangles(_), _) => Some(Value::Path(Vec::new())),
            (Shaping::Path(projection), value) => earth_path(value, projection),
        }
    }
}

/// A row in a job's result: its table and id.
pub(crate) type Key = (Name, Id);

/// Vertices to lay out: each one's pinned center if any, plus the links between vertices. `keys`
/// names the row that receives each vertex's center. Vertices without a key are laid out but not
/// written. Plane units, y up.
pub(crate) struct Placement<'a> {
    pub(crate) pinned: &'a [Option<[f64; 2]>],
    pub(crate) links: &'a [[u32; 2]],
    pub(crate) keys: &'a [Option<Key>],
}

impl Job {
    /// Rebuilds a job from its bytes.
    pub fn from_bytes(bytes: Vec<u8>) -> Job {
        Job(bytes)
    }

    /// The job as bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }

    /// Runs the job and returns its result: a patch of rows by id, lane words, shape columns, or a
    /// pyramid's order and tiles. Returns no bytes if the job is malformed or fails.
    pub fn run(self) -> Vec<u8> {
        let mut input = In::new(&self.0);
        let Some(kind) = input.u32().and_then(Kind::from_code) else { return Vec::new() };
        let answer = match kind {
            Kind::Lanes => return run_lanes(&mut input).unwrap_or_default(),
            Kind::Pyramid => return run_pyramid(&mut input).unwrap_or_default(),
            Kind::Shapes => return run_shapes(&mut input).unwrap_or_default(),
            Kind::Layered | Kind::Stress => run_layout(kind, &mut input),
            Kind::Tile => run_tile(&mut input),
            Kind::GeoJson => run_geojson(&mut input),
        };
        answer.map(|patch| patch.to_bytes()).unwrap_or_default()
    }

    /// A job laying out `placement` with `layout` (layered or stress). Its result sets each keyed
    /// vertex's center as fields `x` and `y`, y up.
    pub(crate) fn layout(layout: &Layout, placement: &Placement<'_>) -> Job {
        // Room for each vertex's pin and key, which a long table name or text id outgrows, and
        // each link's ends.
        let rest = 32 + 48 * placement.pinned.len() + 8 * placement.links.len();
        let mut out = match *layout {
            Layout::Stress(stress) => {
                let mut out = job(Kind::Stress, rest);
                out.f64(stress.gap);
                out
            }
            Layout::Layered(layered) => {
                let mut out = job(Kind::Layered, rest);
                out.u32(layered.direction.code());
                out.f64(layered.gap);
                out.f64(layered.rank_gap);
                out
            }
            Layout::None => unreachable!("places request a layout only when the scene has one"),
        };
        out.len(placement.pinned.len());
        for v in 0..placement.pinned.len() {
            out.u32(u32::from(placement.pinned[v].is_some()));
            out.pod(&placement.pinned[v].unwrap_or_default());
            out.u32(u32::from(placement.keys[v].is_some()));
            if let Some(key) = &placement.keys[v] {
                write_key(&mut out, key);
            }
        }
        out.len(placement.links.len());
        out.pod(placement.links);
        Job(out.0)
    }

    /// A job computing `shaping` for every row of each geometry column in `parts`. Its result holds
    /// each part's shapes, read by [`shapes_answer`].
    pub(crate) fn shapes(shaping: Shaping, parts: &[Values]) -> Job {
        let mut out = job(Kind::Shapes, 0);
        out.u32(shaping.code());
        write_columns(&mut out, parts);
        Job(out.0)
    }

    /// A job decoding tile `key` from `bytes`, optionally gzip-compressed, into rows of `tables`
    /// with their derived shapes. Its result is a patch of those rows.
    pub(crate) fn tile(key: TileKey, tables: &[Decoded], bytes: &[u8]) -> Job {
        let mut out = job(Kind::Tile, 64 + bytes.len());
        out.u32(u32::from(key.z));
        out.u32(key.x);
        out.u32(key.y);
        out.len(tables.len());
        for decoded in tables {
            out.str(&decoded.layer);
            out.u32(decoded.kind.code());
            out.str(&decoded.table);
            out.len(decoded.shapes.len());
            for shaping in &decoded.shapes {
                out.u32(shaping.code());
            }
        }
        out.bytes(bytes);
        Job(out.0)
    }

    /// A job that reads GeoJSON `bytes`, since GeoJSON can be large. Its result is the patch that
    /// builds the dataset's tables, or no bytes if the GeoJSON is invalid.
    pub(crate) fn geojson(bytes: &[u8]) -> Job {
        let mut out = job(Kind::GeoJson, bytes.len());
        out.bytes(bytes);
        Job(out.0)
    }

    /// A job assigning each edge row a lane among the rows joining the same two vertices, from the
    /// target rows of the rows' endpoints `from` and `to`, references of `rows` rows each. Its
    /// result is every row's lane word as a little-endian `u32`, or no bytes when no two rows share
    /// endpoints.
    pub(crate) fn lanes(rows: usize, from: &Reference, to: &Reference) -> Job {
        let mut out = job(Kind::Lanes, 4 + 8 * rows);
        out.len(rows);
        // Exactly `rows` targets of each end, unwired past a shorter reference's end.
        for end in [from, to] {
            let mut left = rows;
            end.each_targets(|targets| {
                let n = targets.len().min(left);
                out.pod(&targets[..n]);
                left -= n;
            });
            out.pod(&vec![UNWIRED; left]);
        }
        Job(out.0)
    }

    /// A job grouping the rows of `leveling`'s tables into tiles, all of one dataset's tables at
    /// once. Its result holds each table's pyramid, read by
    /// [`Pyramid::read`](crate::derive::pyramid::Pyramid::read).
    pub(crate) fn pyramid(leveling: &Leveling) -> Job {
        let size = |table: &Placing| {
            let places = match &table.places {
                Places::None => 0,
                Places::Points(points) => size_of_val(&points[..]),
                Places::Boxes(boxes) => size_of_val(&boxes[..]),
            };
            let ends = table.ends.as_ref().map_or(0, |(_, ends)| 8 + ends.iter().map(|e| 4 * e.len()).sum::<usize>());
            8 + places + size_of_val(&table.priority[..]) + ends
        };
        let mut out = job(Kind::Pyramid, 36 + leveling.tables.iter().map(size).sum::<usize>());
        out.pod(&leveling.domain.words());
        out.len(leveling.tables.len());
        for table in &leveling.tables {
            let places = match &table.places {
                Places::None => 0,
                Places::Points(_) => 1,
                Places::Boxes(_) => 2,
            };
            let flags = u32::from(table.leveled)
                | u32::from(table.answered) << 1
                | places << 2
                | u32::from(!table.priority.is_empty()) << 4
                | u32::from(table.ends.is_some()) << 5;
            out.u32(table.rows);
            out.u32(flags);
            match &table.places {
                Places::None => {}
                Places::Points(points) => out.pod(&points[..]),
                Places::Boxes(boxes) => out.pod(&boxes[..]),
            }
            out.pod(&table.priority[..]);
            if let Some((target, ends)) = &table.ends {
                out.u32(*target);
                out.len(ends.len());
                for end in ends {
                    out.pod(&end[..]);
                }
            }
        }
        Job(out.0)
    }
}

/// A job's bytes so far: its kind, with room for the `rest` bytes after it. A large job's input
/// is written once into room made for all of it, never copied as it grows.
fn job(kind: Kind, rest: usize) -> Out {
    let mut out = Out(Vec::with_capacity(4 + rest));
    out.u32(kind.code());
    out
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Job").field(&self.0.len()).finish()
    }
}

/// Builds a patch writing `values` for `keys`, grouped by table in order of first appearance.
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

fn run_layout(kind: Kind, input: &mut In<'_>) -> Option<Patch> {
    let options = if kind == Kind::Stress {
        Layout::Stress(crate::Stress { gap: input.f64()? })
    } else {
        let direction = Direction::from_code(input.u32()?)?;
        Layout::Layered(Layered { direction, gap: input.f64()?, rank_gap: input.f64()? })
    };
    let count = input.u32()? as usize;
    let (mut pinned, mut keys) = (Vec::new(), Vec::new());
    for _ in 0..count {
        let pin = input.u32()? != 0;
        let at = [input.f64()?, input.f64()?];
        pinned.push(pin.then_some(at));
        let keyed = input.u32()? != 0;
        keys.push(if keyed { Some(read_key(input)?) } else { None });
    }
    let links = input.u32()?;
    let links = (0..links).map(|_| Some([input.u32()?, input.u32()?])).collect::<Option<Vec<_>>>()?;
    if links.iter().flatten().any(|&v| v as usize >= count) {
        return None;
    }
    let graph = Graph { pinned: &pinned, links: &links };
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

/// Reads a shapes job's result: a column per part in the job. `None` if `bytes` are malformed.
pub(crate) fn shapes_answer(bytes: &[u8]) -> Option<Vec<Values>> {
    read_columns(&mut In::new(bytes))
}

fn run_shapes(input: &mut In<'_>) -> Option<Vec<u8>> {
    let shaping = Shaping::from_code(input.u32()?)?;
    let parts = read_columns(input)?;
    let mut out = Out::default();
    write_columns(&mut out, &parts.iter().map(|part| shaping.shapes_of(part)).collect::<Vec<_>>());
    Some(out.0)
}

fn run_tile(input: &mut In<'_>) -> Option<Patch> {
    let key = TileKey { z: u8::try_from(input.u32()?).ok()?, x: input.u32()?, y: input.u32()? };
    let count = input.u32()?;
    let tables = (0..count)
        .map(|_| {
            let layer = input.str()?.to_owned();
            let kind = Geometry::from_code(input.u32()?)?;
            let table = input.str()?.into();
            let shapes = (0..input.u32()?).map(|_| Shaping::from_code(input.u32()?)).collect::<Option<Vec<_>>>()?;
            Some(Decoded { layer, kind, table, shapes })
        })
        .collect::<Option<Vec<_>>>()?;
    decode(input.rest(), key, &tables)
}

fn run_geojson(input: &mut In<'_>) -> Option<Patch> {
    crate::geo::geojson_patch(input.rest()).ok()
}

fn run_pyramid(input: &mut In<'_>) -> Option<Vec<u8>> {
    let domain = Domain::from_words(input.pod::<f64>(4)?.try_into().ok()?);
    let count = input.u32()?;
    let mut tables = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let rows = input.u32()?;
        let flags = input.u32()?;
        let n = rows as usize;
        let has = |bit: u32| flags & 1 << bit != 0;
        let places = match flags >> 2 & 3 {
            1 => Places::Points(input.pod::<[f32; 2]>(n)?.into()),
            2 => Places::Boxes(input.pod::<[f32; 4]>(n)?.into()),
            _ => Places::None,
        };
        let priority = if has(4) { input.pod::<f32>(n)?.into() } else { Arc::from([]) };
        let ends = if has(5) {
            let target = input.u32()?;
            let count = input.u32()?;
            Some((target, (0..count).map(|_| input.pod::<u32>(n)).collect::<Option<Vec<_>>>()?))
        } else {
            None
        };
        tables.push(Placing { rows, leveled: has(0), answered: has(1), places, priority, ends });
    }
    Some(crate::derive::pyramid::encode(&crate::derive::pyramid::answer(&Leveling { domain, tables })))
}

fn run_lanes(input: &mut In<'_>) -> Option<Vec<u8>> {
    let rows = input.u32()? as usize;
    let (from, to) = (input.pod::<u32>(rows)?, input.pod::<u32>(rows)?);
    let words = crate::derive::lane_words(&from, &to)?;
    let mut out = Out::default();
    out.pod(&words);
    Some(out.0)
}

/// Writes columns, each as its byte length followed by its values' bytes.
fn write_columns(out: &mut Out, columns: &[Values]) {
    out.len(columns.len());
    for values in columns {
        let bytes = values_bytes(values);
        out.len(bytes.len());
        out.bytes(&bytes);
    }
}

/// Reads columns written by [`write_columns`].
fn read_columns(input: &mut In<'_>) -> Option<Vec<Values>> {
    let count = input.u32()?;
    (0..count)
        .map(|_| {
            let len = input.u32()? as usize;
            read_values(input.bytes(len)?).ok()
        })
        .collect()
}

/// Writes a key: 1 and a numeric id, or 2 and a text id, then the table name.
fn write_key(out: &mut Out, (table, id): &Key) {
    match id {
        Id::Number(n) => {
            out.u32(1);
            out.u64(*n);
        }
        Id::Text(text) => {
            out.u32(2);
            out.str(text);
        }
    }
    out.str(table);
}

/// Reads a key written by [`write_key`].
fn read_key(input: &mut In<'_>) -> Option<Key> {
    let id = match input.u32()? {
        1 => Id::Number(input.u64()?),
        2 => Id::from(input.str()?),
        _ => return None,
    };
    Some((input.str()?.into(), id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Value;

    fn key(table: &str, id: u64) -> Key {
        (table.into(), Id::Number(id))
    }

    /// Field `field` of row `id` of `table` in a job's result.
    fn answered(answer: &[u8], table: &str, id: u64, field: &str) -> Option<Value> {
        let data = crate::Snapshot::new("d").applied(Patch::from_bytes(answer).ok()?).ok()?;
        data.get(table, id, field, None)
    }

    #[test]
    fn layout_jobs_return_the_rows_they_place() {
        let pinned = [None, Some([5.0, 5.0]), None];
        let keys = [Some(key("V", 7)), None, Some(key("V", 9))];
        let links = [[0, 1], [1, 2]];
        let placement = Placement { pinned: &pinned, links: &links, keys: &keys };
        let answer = Job::from_bytes(Job::layout(&Layout::Layered(Layered::default()), &placement).into_bytes()).run();
        let ranked = layered(&Graph { pinned: &pinned, links: &links }, &Layered::default());
        assert_eq!(answered(&answer, "V", 9, "x"), Some(Value::Number(ranked[2][0])));
        assert_eq!(answered(&answer, "V", 7, "y"), Some(Value::Number(ranked[0][1])));
        let stress = Job::layout(&Layout::Stress(crate::Stress::default()), &placement).run();
        assert!(matches!(answered(&stress, "V", 7, "x"), Some(Value::Number(_))), "stress layouts return rows too");
    }

    #[test]
    fn bytes_that_are_not_a_job_return_nothing() {
        assert_eq!(Job::from_bytes(vec![1, 0, 0, 0, 9]).run(), Vec::<u8>::new());
        assert_eq!(Job::from_bytes(Vec::new()).run(), Vec::<u8>::new());
    }
}
