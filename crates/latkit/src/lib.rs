#![doc = include_str!("../README.md")]
//!
//! ## Rust API
//!
//! - Store rows in a [`Data`], apply a [`Patch`], and run a [`Query`] on a [`Snapshot`].
//! - Parse JSON with [`from_json`] or inspect a type's JSON Schema with [`schema`].
#![cfg_attr(
    feature = "gpu",
    doc = "- Draw a [`Scene`] with a [`View`], then export an [`Image`] or [`Video`] with a [`Shot`]."
)]
// Without `gpu`, the parts of data, expressions, and sorts that only drawing uses are dead code.
// Builds with `gpu` lint every feature, so they still catch code nothing uses.
#![cfg_attr(not(feature = "gpu"), allow(dead_code))]

// A browser build draws only through the page: the `web` feature hands latkit its canvas, shaders,
// and timers.
#[cfg(all(feature = "gpu", target_arch = "wasm32", not(feature = "web")))]
compile_error!("in a browser, latkit draws with the `web` feature; use `default-features = false` for data alone");

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
mod room;
#[cfg(feature = "gpu")]
mod scene;
mod schema;
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
mod wire;

#[cfg(feature = "gpu")]
pub use data::Source;
pub use data::{
    Data, DecodeLimits, Description, Envelope, EnvelopeRequest, FieldDescription, Id, Ids, Kind, Name, Patch, Row,
    Rows, Snapshot, Table, TableDescription, TileWriter, Value, Values,
};
pub use data::{Order, Patches, Query, QueryResult, Reading};
pub use error::{Error, Path, Result, Step};
pub use expr::{
    Category, Color, Colormap, ColormapKind, Expr, Format, Length, Mapped, Size, Stop, Then, When, elapsed, field,
    hovered, meters, pointer, related, selected, units, when, zoom,
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
        Action, AreaTheme, Areas, Axis, Controls, Converge, Direction, Earth, EarthTheme, EdgeTheme, Edges, FlowTheme,
        FocusTheme, Gestures, Grid, GridTheme, Interpolation, Label, Layered, Layout, Legend, LineTheme, Lines, Mark,
        Marker, Meet, Motion, Parallel, Place, Plane, Plot, PlotTheme, Projection, Reach, Route, Scene, Shade, Shape,
        Space, Stress, StrokeMarker, TextTheme, Theme, Title, Trace, VertexTheme, Vertical, Vertices,
    },
    shot::{Capture, Shot},
    tiles::{LayerDescription, Tiles, TilesDescription},
    video::{Encoding, Mp4, Pixels, Sink, Video},
    view::{
        Arrange, Button, Camera, Cursor, Device, End, Event, Fit, Frame, Hit, Input, Key, Modifiers, Phase, Sample,
        Stats, Trigger, View, Waiting,
    },
};
