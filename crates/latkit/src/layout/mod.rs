//! CPU graph layouts of points: layered and stress layouts, packing of disconnected parts, and
//! overlap removal. Each is a pure function, so it runs the same on the frame or in a host job.
pub(crate) mod graph;
pub(crate) mod layered;
pub(crate) mod overlap;
pub(crate) mod pack;
pub(crate) mod stress;
