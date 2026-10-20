//! Columnar data drawn as vertices, edges, lines, and areas on the GPU.
//!
//! A [`Data`] is a named collection of [`Table`]s, changed in place by [`Patch`]es; a clone is an
//! O(1) snapshot. A [`Scene`] describes what to draw and how it answers input: marks that name tables
//! of data, in a space, with a theme and controls. A [`View`] draws a scene into any wgpu frame, is
//! given the data by name, and turns platform [`Input`] into [`Event`]s.
//!
//! Every input is plain data that deserializes: [`from_json`] reads one from JSON text, an error
//! naming the path to what it could not read, and [`schema`] gives its JSON Schema.

// Without `gpu`, some of the data's internals have no reader.
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
mod data;
#[cfg(feature = "gpu")]
mod derive;
mod error;
#[cfg(feature = "gpu")]
mod expr;
// Without `gpu`, only GeoJSON and tiles' decoding have readers.
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
mod geo;
#[cfg(feature = "gpu")]
mod gpu;
#[cfg(feature = "gpu")]
pub mod host;
mod image;
mod json;
#[cfg(feature = "gpu")]
mod layout;
#[cfg(feature = "gpu")]
mod panels;
#[cfg(feature = "gpu")]
mod pending;
#[cfg(feature = "gpu")]
mod scene;
mod schema;
#[cfg(feature = "gpu")]
mod sheet;
#[cfg(feature = "gpu")]
mod shot;
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
mod tiles;
#[cfg(feature = "gpu")]
mod time;
mod url;
#[cfg(feature = "gpu")]
mod video;
#[cfg(feature = "gpu")]
mod view;
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub mod web;

pub use data::{
    Data, Description, Envelope, FieldDescription, Id, Ids, Kind, Name, Patch, Row, Rows, Table, TableDescription,
    Value, Values,
};
pub use error::{Error, Path, Result, Step};
pub use image::{Image, ImageFormat};
pub use json::from_json;
pub use schema::schema;
#[cfg(feature = "gpu")]
pub use schema::schemas;
#[cfg(feature = "gpu")]
pub use {
    data::{Order, Patches, Query},
    expr::{
        Color, Colormap, ColormapKind, Expr, Mapped, Size, Stop, Then, When, elapsed, field, hovered, pointer,
        selected, units, when, zoom,
    },
    gpu::{Budget, Gpu, work::Work},
    panels::Panels,
    pending::{Pending, Resolver},
    scene::{
        Areas, Axis, Controls, Diagram, Direction, Earth, Edges, Faces, Flow, Format, Grid, Interpolation, Label,
        Layered, Layout, Lines, Mark, Marker, Motion, Plane, Plot, Port, Projection, Route, Scene, Shadow, Shape, Side,
        Space, Stress, Theme, Vertices, Zoom,
    },
    shot::Shot,
    tiles::Tiles,
    video::{Encoding, Mp4, Pixels, Sink, Video},
    view::{
        Button, Camera, Cursor, Device, End, Event, Fit, Frame, Hit, Input, Key, Modifiers, Phase, Sample, Stats,
        Trigger, View, Waiting,
    },
};
