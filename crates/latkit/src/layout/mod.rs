//! CPU graph layouts: layered and stress layouts of nested graphs, packing of disconnected parts,
//! overlap removal, orthogonal wire routing for diagrams, and an R-tree of boxes. Each is a pure
//! function, so it runs the same on the frame or in a host job.
pub(crate) mod boxes;
pub(crate) mod layered;
pub(crate) mod levels;
pub(crate) mod overlap;
pub(crate) mod pack;
pub(crate) mod rect;
pub(crate) mod route;
pub(crate) mod stress;
