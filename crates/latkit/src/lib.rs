//! Columnar data drawn on the GPU as vertices, edges, lines, and areas.
//!
//! A [`Data`] is a named collection of [`Table`]s, changed in place by [`Patch`]es. A [`Snapshot`]
//! is one immutable version of a `Data`, taken in O(1). A [`Scene`] describes what to draw and how
//! it responds to input: marks that reference tables of datasets, a space, a theme, and controls. A
//! [`View`] draws a scene into any wgpu frame from its [`Source`]s, one per dataset name, and turns
//! platform [`Input`] into [`Event`]s.
//!
//! Every input is plain data that deserializes. [`from_json`] reads one from JSON text and reports
//! errors with the path to the part it could not read. [`schema`] returns its JSON Schema.

// Without `gpu`, the parts of data, expressions, and sorts that only drawing uses are dead code.
// Builds with `gpu` lint every feature, so they still catch code nothing uses.
#![cfg_attr(not(feature = "gpu"), allow(dead_code))]

mod data;
#[cfg(feature = "gpu")]
mod derive;
mod error;
mod expr;
mod geo;
#[cfg(feature = "gpu")]
mod gpu;
#[cfg(feature = "gpu")]
pub mod host;
mod image;
mod json;
#[cfg(feature = "gpu")]
mod layout;
mod order;
#[cfg(feature = "gpu")]
mod panels;
mod pending;
pub mod resource;
#[cfg(feature = "gpu")]
mod scene;
mod schema;
#[cfg(feature = "gpu")]
mod sheet;
#[cfg(feature = "gpu")]
mod shot;
#[cfg(feature = "gpu")]
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

#[cfg(feature = "gpu")]
pub use data::Source;
pub use data::{
    Data, DecodeLimits, Description, Envelope, EnvelopeRequest, FieldDescription, Id, Ids, Kind, Name, Patch, Row,
    Rows, Snapshot, Table, TableDescription, Value, Values,
};
pub use data::{Order, Patches, Query, QueryResult, Reading};
pub use error::{Error, Path, Result, Step};
pub use expr::{
    Color, Colormap, ColormapKind, Expr, Mapped, Paint, Size, Stop, Then, When, elapsed, field, hovered, pointer, px,
    selected, units, when, zoom,
};
pub use image::{Image, ImageFormat};
pub use json::from_json;
pub use pending::{Pending, Resolver};
pub use schema::schema;
#[cfg(feature = "gpu")]
pub use schema::schemas;
#[cfg(feature = "gpu")]
pub use {
    gpu::{Budget, DeviceEvents, Gpu, work::Work},
    panels::Panels,
    scene::{
        AreaTheme, Areas, Axis, Controls, Diagram, DiagramTheme, Direction, Earth, EarthTheme, EdgeTheme, Edges, Faces,
        FlowTheme, FocusTheme, Format, Grid, Interpolation, Label, Layered, Layout, Length, LineTheme, Lines, Mark,
        Marker, Motion, Plane, Plot, PlotTheme, Port, Projection, Route, Scene, ShadowTheme, Shape, Side, Space,
        Stress, TextTheme, Theme, VertexTheme, Vertices, Zoom,
    },
    shot::{Capture, Shot},
    tiles::Tiles,
    video::{Encoding, Mp4, Pixels, Sink, Video},
    view::{
        Button, Camera, Cursor, Device, End, Event, Fit, Frame, Hit, Input, Key, Modifiers, Phase, Sample, Stats,
        Trigger, View, Waiting,
    },
};
