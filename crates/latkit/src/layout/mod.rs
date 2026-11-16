//! CPU graph layouts of points: layered and stress layouts, packing of disconnected parts, and
//! overlap removal. Each is a pure function, which a host job runs.
pub(crate) mod graph;
pub(crate) mod layered;
pub(crate) mod overlap;
pub(crate) mod pack;
pub(crate) mod stress;
