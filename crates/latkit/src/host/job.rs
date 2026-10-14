//! Jobs: work that grows faster than the graph it reads (laying out in ranks, pushing boxes apart,
//! routing wires), handed to the host to do off the frame. A job is bytes in and bytes out, so a thread, or a worker holding
//! its own copy of latkit, can do it with nothing shared.

use crate::layout::layered::{Ranked, layered};
use crate::layout::overlap::separate;
use crate::layout::route::{Net, Terminal, route};
use crate::{Direction, Layered, Side};

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
    Routes = 2,
    Overlaps = 3,
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

    /// Does the job: lays out ranks, pushes boxes apart, or routes wires. Bytes that are no job
    /// answer nothing.
    pub fn run(self) -> Vec<u8> {
        let mut input = Reader::new(&self.0);
        let answer = match input.u32() {
            Some(k) if k == Kind::Layered as u32 => run_layered(&mut input),
            Some(k) if k == Kind::Routes as u32 => run_routes(&mut input),
            Some(k) if k == Kind::Overlaps as u32 => run_overlaps(&mut input),
            _ => None,
        };
        answer.unwrap_or_default()
    }

    /// Laying `graph` out in ranks by `options`; it answers each vertex's center.
    pub(crate) fn layered(graph: &Ranked<'_>, options: &Layered) -> Job {
        let mut out = Writer::new(Kind::Layered);
        let flow = match options.flow {
            Direction::Right => 0,
            Direction::Left => 1,
            Direction::Down => 2,
            Direction::Up => 3,
        };
        out.u32(flow);
        out.f64(options.gap);
        out.f64(options.rank_gap);
        out.u32(graph.sizes.len() as u32);
        for (size, (pin, group)) in graph.sizes.iter().zip(graph.pinned.iter().zip(graph.groups)) {
            out.f64s(size);
            out.u32(u32::from(pin.is_some()));
            out.f64s(&pin.unwrap_or_default());
            out.u32(group.unwrap_or(u32::MAX));
        }
        out.u32(graph.edges.len() as u32);
        for edge in graph.edges {
            out.u32(edge[0]);
            out.u32(edge[1]);
        }
        Job(out.0)
    }

    /// Pushing `boxes` (center, then half width and height) apart until none come within
    /// `clearance`, the `pinned` ones held; it answers each box's center.
    pub(crate) fn overlaps(boxes: &[[f64; 4]], pinned: &[bool], clearance: f64) -> Job {
        let mut out = Writer::new(Kind::Overlaps);
        out.f64(clearance);
        out.u32(boxes.len() as u32);
        for (b, &pin) in boxes.iter().zip(pinned) {
            out.f64s(b);
            out.u32(u32::from(pin));
        }
        Job(out.0)
    }

    /// Routing `nets` around `obstacles`, parallel runs `spacing` apart; it answers each net's
    /// polylines.
    pub(crate) fn routes(obstacles: &[[f64; 4]], nets: &[Net], spacing: f64) -> Job {
        let mut out = Writer::new(Kind::Routes);
        out.f64(spacing);
        out.u32(obstacles.len() as u32);
        for obstacle in obstacles {
            out.f64s(obstacle);
        }
        out.u32(nets.len() as u32);
        for net in nets {
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

/// A layered or overlaps job's answer: each vertex's center.
pub(crate) fn centers(answer: &[u8]) -> Option<Vec<[f64; 2]>> {
    let mut input = Reader::new(answer);
    let count = input.u32()?;
    (0..count).map(|_| Some([input.f64()?, input.f64()?])).collect()
}

/// A routes job's answer: each net's polylines.
pub(crate) fn polylines(answer: &[u8]) -> Option<Vec<Vec<Vec<[f64; 2]>>>> {
    let mut input = Reader::new(answer);
    let nets = input.u32()?;
    (0..nets)
        .map(|_| {
            let lines = input.u32()?;
            (0..lines)
                .map(|_| {
                    let points = input.u32()?;
                    (0..points).map(|_| Some([input.f64()?, input.f64()?])).collect()
                })
                .collect()
        })
        .collect()
}

fn run_layered(input: &mut Reader<'_>) -> Option<Vec<u8>> {
    let flow = match input.u32()? {
        0 => Direction::Right,
        1 => Direction::Left,
        2 => Direction::Down,
        _ => Direction::Up,
    };
    let options = Layered { flow, gap: input.f64()?, rank_gap: input.f64()? };
    let count = input.u32()? as usize;
    let (mut sizes, mut pinned, mut groups) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..count {
        sizes.push([input.f64()?, input.f64()?]);
        let pin = input.u32()? != 0;
        let at = [input.f64()?, input.f64()?];
        pinned.push(pin.then_some(at));
        groups.push(Some(input.u32()?).filter(|&g| (g as usize) < count));
    }
    let links = input.u32()?;
    let edges = (0..links).map(|_| Some([input.u32()?, input.u32()?])).collect::<Option<Vec<_>>>()?;
    if edges.iter().flatten().any(|&v| v as usize >= count) {
        return None;
    }
    let centers = layered(&Ranked { sizes: &sizes, edges: &edges, pinned: &pinned, groups: &groups }, &options);
    Some(centers_bytes(&centers))
}

fn run_overlaps(input: &mut Reader<'_>) -> Option<Vec<u8>> {
    let clearance = input.f64()?;
    let count = input.u32()?;
    let (mut boxes, mut pinned) = (Vec::new(), Vec::new());
    for _ in 0..count {
        boxes.push([input.f64()?, input.f64()?, input.f64()?, input.f64()?]);
        pinned.push(input.u32()? != 0);
    }
    Some(centers_bytes(&separate(&boxes, &pinned, clearance)))
}

/// Centers as a layered or overlaps job answers them.
fn centers_bytes(centers: &[[f64; 2]]) -> Vec<u8> {
    let mut out = Writer(Vec::with_capacity(4 + 16 * centers.len()));
    out.u32(centers.len() as u32);
    for center in centers {
        out.f64s(center);
    }
    out.0
}

fn run_routes(input: &mut Reader<'_>) -> Option<Vec<u8>> {
    let spacing = input.f64()?;
    let count = input.u32()?;
    let obstacles = (0..count)
        .map(|_| Some([input.f64()?, input.f64()?, input.f64()?, input.f64()?]))
        .collect::<Option<Vec<_>>>()?;
    let count = input.u32()?;
    let mut nets = Vec::new();
    for _ in 0..count {
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
    let routes = route(&obstacles, &nets, spacing);
    let mut out = Writer(Vec::new());
    out.u32(routes.len() as u32);
    for lines in &routes {
        out.u32(lines.len() as u32);
        for line in lines {
            out.u32(line.len() as u32);
            for point in line {
                out.f64s(point);
            }
        }
    }
    Some(out.0)
}

/// Little-endian words and floats, written.
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

    fn f64s(&mut self, vs: &[f64]) {
        for &v in vs {
            self.f64(v);
        }
    }
}

/// Little-endian words and floats, read; `None` past the end.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes }
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layered_jobs_answer_as_the_layout_does() {
        let sizes = [[10.0, 10.0]; 3];
        let edges = [[0, 1], [1, 2]];
        let pinned = [None, Some([5.0, 5.0]), None];
        let groups = [None; 3];
        let graph = Ranked { sizes: &sizes, edges: &edges, pinned: &pinned, groups: &groups };
        let options = Layered::default();
        let answer = Job::from_bytes(Job::layered(&graph, &options).into_bytes()).run();
        assert_eq!(centers(&answer), Some(layered(&graph, &options)));
    }

    #[test]
    fn route_jobs_answer_as_the_router_does() {
        let obstacles = [[0.0, 0.0, 10.0, 10.0], [40.0, 0.0, 50.0, 10.0]];
        let terminal = |x: f64, side, owner| Terminal { at: [x, 5.0], side: Some(side), owner: Some(owner) };
        let nets = [Net { terminals: vec![terminal(10.0, Side::Right, 0), terminal(40.0, Side::Left, 1)] }];
        let answer = Job::routes(&obstacles, &nets, 2.0).run();
        assert_eq!(polylines(&answer), Some(route(&obstacles, &nets, 2.0)));
    }

    #[test]
    fn overlap_jobs_answer_as_separating_does() {
        let boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 1.0, 10.0, 10.0], [40.0, 0.0, 3.0, 3.0]];
        let pinned = [false, true, false];
        let answer = Job::overlaps(&boxes, &pinned, 2.0).run();
        assert_eq!(centers(&answer), Some(separate(&boxes, &pinned, 2.0)));
    }

    #[test]
    fn bytes_that_are_no_job_answer_nothing() {
        assert_eq!(Job::from_bytes(vec![1, 0, 0, 0, 9]).run(), Vec::<u8>::new());
        assert_eq!(Job::from_bytes(Vec::new()).run(), Vec::<u8>::new());
    }
}
