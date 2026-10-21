//! Layouts on the CPU: layered drawing and stress over nested graphs, packing of parts, overlap
//! removal, and a diagram's orthogonal routes. Each is pure, so it runs as well in a host's job.
pub(crate) mod layered;
pub(crate) mod levels;
pub(crate) mod overlap;
pub(crate) mod pack;
pub(crate) mod rect;
pub(crate) mod route;
pub(crate) mod stress;
