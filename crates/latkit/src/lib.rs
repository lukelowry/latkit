//! Columnar data drawn as vertices, edges, lines, and areas on the GPU.
//!
//! A [`Data`] is a named, immutable collection of [`Table`]s, changed only by [`Patch`]es. A
//! [`Scene`] describes what to draw and how it answers input: marks that name tables of data, in a
//! space, with a theme and controls. A [`View`] draws a scene into any wgpu frame, is given the data
//! by name, and turns platform [`Input`] into [`Event`]s.

// Without `gpu`, some of the data's internals have no reader.
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
mod data;
mod error;
#[cfg(feature = "gpu")]
mod expr;
#[cfg(feature = "gpu")]
mod gpu;
#[cfg(feature = "gpu")]
pub mod host;
#[cfg(feature = "gpu")]
mod layout;
#[cfg(feature = "gpu")]
mod pending;
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
        units, when, zoom,
    },
    gpu::{Budget, Gpu},
    pending::{Pending, Resolver},
    scene::{
        Axis, Controls, Direction, Earth, Edges, Faces, Format, Grid, Image, Interpolation, Label, Layered, Layout,
        Lines, Mark, Marker, Plane, Plot, Port, Projection, Route, Scene, Shadow, Shape, Side, Space, Stress, Theme,
        Vertices,
    },
    view::{
        Button, Camera, Cursor, Drag, End, Event, Fit, Hit, Input, Key, Modifiers, Phase, Sample, Stats, Target, View,
    },
};
