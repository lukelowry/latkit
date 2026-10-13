//! Columnar data drawn as vertices, edges, lines, and areas on the GPU.
//!
//! A [`Data`] is a named, immutable collection of [`Table`]s, changed only by [`Patch`]es. A
//! [`Scene`] describes what to draw: marks that name tables of data, in a space, with a theme. A
//! [`View`] draws a scene into any wgpu frame and is given the data by name.

// Without `gpu`, some of the data's internals have no reader.
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
mod data;
mod error;
#[cfg(feature = "gpu")]
mod expr;
#[cfg(feature = "gpu")]
mod gpu;
#[cfg(feature = "gpu")]
mod scene;
#[cfg(feature = "gpu")]
mod view;
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub mod web;

pub use data::{Data, Id, Ids, Kind, Name, Patch, Row, Table, Value, Values};
pub use error::{Error, Path, Result, Step};
#[cfg(feature = "gpu")]
pub use {
    expr::{
        Color, Colormap, ColormapKind, Expr, Mapped, Size, Then, When, elapsed, field, hovered, pointer, selected,
        units, when,
    },
    gpu::{Budget, Gpu},
    scene::{
        Axis, Direction, Earth, Edges, Grid, Layered, Layout, Mark, Marker, Plane, Plot, Projection, Scene, Shape,
        Space, Stress, Theme, Vertices,
    },
    view::{Camera, Event, Target, View},
};
