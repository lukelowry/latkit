//! The GPU device that every view shares, and the page arena, pipelines, colormaps, and text
//! dictionaries the views draw from.

pub(crate) mod arena;
pub(crate) mod atlas;
pub(crate) mod bounds;
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub(crate) mod browser;
pub(crate) mod colormaps;
pub(crate) mod dictionary;
#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod gl;
#[cfg(all(feature = "wgsl", target_arch = "wasm32"))]
mod glsl;
pub(crate) mod grown;
pub(crate) mod icons;
pub(crate) mod kernel;
mod layers;
pub(crate) mod listing;
pub(crate) mod order;
pub(crate) mod packed;
pub(crate) mod pipelines;
pub(crate) mod probing;
#[cfg(any(not(target_arch = "wasm32"), feature = "wgsl"))]
mod prune;
pub(crate) mod raster;
pub(crate) mod readback;
pub(crate) mod reduce;
pub(crate) mod retired;
pub(crate) mod shaders;
mod specialize;
pub(crate) mod state;
#[cfg(target_arch = "wasm32")]
pub(crate) mod store;
pub(crate) mod texts;
pub(crate) mod texture;
pub(crate) mod words;
pub(crate) mod work;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use arena::Arena;
use atlas::Atlas;
use colormaps::Colormaps;
use dictionary::Dictionaries;
use icons::Icons;
use packed::Packed;
use pipelines::Pipelines;
use readback::Readbacks;
use work::{Counters, Queue, Work};

use crate::host::Host;
use crate::{Error, Result};

/// The byte format shared by canvases, retained view textures, and shots.
pub(crate) const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// The GPU device that views draw with. Cheap to clone. Views of one `Gpu` share uploaded data.
#[derive(Clone)]
pub struct Gpu(pub(crate) Arc<Shared>);

/// Receives events from an application-owned wgpu device without taking over its callbacks.
#[derive(Clone)]
pub struct DeviceEvents {
    lost: Arc<AtomicBool>,
    raised: Arc<Mutex<Raised>>,
}

impl DeviceEvents {
    /// Reports device loss to every view sharing this GPU.
    pub fn lost(&self) {
        self.lost.store(true, Ordering::Release);
    }

    /// Reports an uncaptured device error to every view sharing this GPU.
    pub fn error(&self, error: &wgpu::Error) {
        self.raise(Error::Unsupported(format!("GPU error: {error}").into()));
    }

    fn raise(&self, error: Error) {
        self.raised.lock().unwrap_or_else(PoisonError::into_inner).push(error);
    }
}

/// Errors the device raised outside any error scope, numbered, so every view reports each one once,
/// whichever view draws first.
#[derive(Default)]
pub(crate) struct Raised {
    errors: std::collections::VecDeque<Error>,
    /// The number of the oldest error held.
    first: u64,
}

impl Raised {
    /// The most errors held. Older ones are dropped, since views report them every frame.
    const HELD: usize = 32;

    fn push(&mut self, error: Error) {
        // A broken resource fails every frame the same way, so a repeat of the last error is held
        // once.
        if self.errors.back() == Some(&error) {
            return;
        }
        if self.errors.len() == Raised::HELD {
            self.errors.pop_front();
            self.first += 1;
        }
        self.errors.push_back(error);
    }

    /// The number the next error raised gets.
    pub(crate) fn next(&self) -> u64 {
        self.first + self.errors.len() as u64
    }

    /// The errors numbered `seen` and later.
    pub(crate) fn since(&self, seen: u64) -> impl Iterator<Item = &Error> {
        self.errors.iter().skip(seen.saturating_sub(self.first) as usize)
    }
}

pub(crate) struct Shared {
    /// The instance and adapter `Gpu::new` created the device from, for creating surfaces.
    pub(crate) instance: Option<wgpu::Instance>,
    pub(crate) adapter: Option<wgpu::Adapter>,
    pub(crate) device: wgpu::Device,
    /// The queue, which counts what is written through it.
    pub(crate) queue: Queue,
    /// Work counters. Views count the rows they evaluate and the jobs they start here, and
    /// [`Gpu::work`] reads them.
    pub(crate) counters: Arc<Counters>,
    pub(crate) sampler: wgpu::Sampler,
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) browser: Mutex<Option<browser::Browser>>,
    pub(crate) lost: Arc<AtomicBool>,
    /// Errors the device raised outside any error scope, for every view to report.
    pub(crate) raised: Arc<Mutex<Raised>>,
    /// Multisample count of every frame drawn with this GPU. It is set once from the screen's pixel
    /// ratio, so a later change (browser zoom, a window moved to another screen) never rebuilds a
    /// scene's pipelines.
    samples: std::sync::OnceLock<u32>,
    inner: Mutex<Inner>,
}

/// Multisample count at `pixel_ratio`: 1 at 1.75 and above, else 4. Shader-drawn marks antialias
/// themselves and only triangle edges need multisampling, so dense screens skip it.
fn samples_at(pixel_ratio: f32) -> u32 {
    if pixel_ratio >= 1.75 { 1 } else { 4 }
}

pub(crate) struct Inner {
    pub(crate) arena: Arena,
    pub(crate) state: state::State,
    pub(crate) listing: listing::Listing,
    pub(crate) bounds: bounds::Bounds,
    pub(crate) texts: texts::Texts,
    pub(crate) probing: probing::Probing,
    /// Piece keys of recently drawn geometry pages.
    pub(crate) pieces: arena::Pieces,
    pub(crate) pipelines: Pipelines,
    pub(crate) colormaps: Colormaps,
    pub(crate) dictionaries: Dictionaries,
    /// Pages of paged tables, packed in draw order and shared by every view drawing them.
    pub(crate) packed: Packed,
    /// Fetched and decoded tiles of each tile source, shared by every view drawing it.
    pub(crate) tiles: crate::tiles::Cache,
    pub(crate) atlas: Atlas,
    pub(crate) icons: Icons,
    pub(crate) readbacks: Readbacks,
    pub(crate) host: Option<Arc<dyn Host>>,
    pub(crate) budget: Budget,
    /// Each view's share of the budget, which it plans within.
    pub(crate) ledger: Ledger,
    /// What the current frame may still upload and compute. Views drawn together share it.
    pub(crate) frame: Allowance,
}

/// What one frame may still do across a GPU's views: bytes to upload, and microseconds of work done
/// on the frame rather than in jobs. A frame ends when a view that drew in it draws again. So views
/// drawn together (a page's canvases, a shot's panels) share one allowance, and a view drawn alone
/// gets a new one each time, even when it redraws the same instant.
#[derive(Default)]
pub(crate) struct Allowance {
    drawn: Vec<u64>,
    pub(crate) upload: u64,
    pub(crate) work: u32,
}

impl Inner {
    /// Begins view `view`'s part of a frame. If no view has drawn yet, or `view` already drew in
    /// the current frame, starts a new one: resets the allowance, frees the blocks the last frame
    /// released, and grows the pool to cover its shortfall. A budget the device could not give the
    /// pool is lowered to what it gave. Views drawn into one encoder can start a new frame before
    /// it is submitted, so retired memory is never destroyed here.
    pub(crate) fn begin_frame(&mut self, view: u64, device: &wgpu::Device, queue: &Queue) {
        if self.frame.drawn.is_empty() || self.frame.drawn.contains(&view) {
            self.frame =
                Allowance { drawn: Vec::new(), upload: self.budget.upload_per_frame, work: crate::derive::FRAME_WORK };
            self.arena.begin_frame(device, queue);
            if let Some(granted) = self.arena.refused() {
                self.budget.bytes = self.budget.bytes.min(granted);
            }
        }
        self.frame.drawn.push(view);
    }
}

/// Fraction of the budget that all of a GPU's views plan their drawing within. The rest holds
/// cached pages, and the pages of a new data version that upload while the old version still draws.
const PLANNED: f64 = 0.5;

/// Each view's share of the planned part of the budget. Shares are max-min fair, so all views
/// together never plan past it, however many there are. A page that several views draw is resident
/// once, so it counts once, split between those views.
#[derive(Default)]
pub(crate) struct Ledger {
    /// Each view's request for drawing everything, by view.
    asks: rustc_hash::FxHashMap<u64, Ask>,
}

/// A view's memory request for drawing everything: its own bytes, plus the pieces it shares with
/// any view drawing the same data.
#[derive(Clone, Default, PartialEq, Debug)]
pub(crate) struct Ask {
    /// Bytes no other view holds: its marks' state, focus, traces, and derived columns.
    pub(crate) own: f64,
    /// Each shared piece, keyed by content, with its bytes.
    pub(crate) shared: Vec<(u64, f64)>,
}

impl Ledger {
    /// Records view `view`'s request `ask` and returns its grant from the planned part of `budget`,
    /// scaled to `whole` (the view's own count of its bytes). Each view asks for its own bytes plus
    /// an even split of each piece it shares. Grants are max-min fair: smaller asks are granted in
    /// full first, and once an ask exceeds an even split of what is left, each remaining view gets
    /// that split.
    pub(crate) fn grant(&mut self, view: u64, whole: f64, ask: Ask, budget: u64) -> f64 {
        self.asks.insert(view, ask);
        let mut sharing: rustc_hash::FxHashMap<u64, f64> = rustc_hash::FxHashMap::default();
        for ask in self.asks.values() {
            for (piece, _) in &ask.shared {
                *sharing.entry(*piece).or_default() += 1.0;
            }
        }
        let split = |ask: &Ask| ask.own + ask.shared.iter().map(|(piece, bytes)| bytes / sharing[piece]).sum::<f64>();
        let mine = split(&self.asks[&view]);
        let mut asks: Vec<f64> = self.asks.values().map(split).collect();
        crate::order::numbers(&mut asks);
        let mut left = budget as f64 * PLANNED;
        for (i, &each) in asks.iter().enumerate() {
            let even = left / (asks.len() - i) as f64;
            if each > even {
                return if mine > even { whole * even / mine } else { whole };
            }
            left -= each;
        }
        whole
    }

    /// Forgets view `view`, which no longer draws.
    pub(crate) fn leave(&mut self, view: u64) {
        self.asks.remove(&view);
    }
}

/// How much GPU memory latkit uses.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    /// GPU memory in bytes for the data all views of the `Gpu` draw: its pages and each view's
    /// per-row state. A table too large for a view's share draws as a paged table, with only the
    /// pages the camera needs, so it always fits. Pages no view draws stay cached in the rest of
    /// the budget, and the least recently drawn are evicted first. Defaults to half the device's
    /// addressable word-texture capacity, at most 1 GiB. The page pool grows as data needs it and never
    /// shrinks, so set the budget before drawing data. A device without the memory to grow the pool
    /// further lowers the budget to the pool's size.
    pub bytes: u64,
    /// The most bytes uploaded per frame. Larger data streams in over several frames. Defaults to
    /// 32 MiB.
    pub upload_per_frame: u64,
}

/// The most bytes the default budget holds. How far a binding can address says nothing about free
/// memory, and the limits a device reports do not tell which allocations succeed. An application
/// that knows its device sets more.
const DEFAULT_BYTES: u64 = 1 << 30;

impl Budget {
    /// The default budget: half the word-texture capacity `device` addresses, at most
    /// `DEFAULT_BYTES`, and 32 MiB uploaded per frame.
    fn of(device: &wgpu::Device) -> Budget {
        let limits = device.limits();
        let largest = u64::from(words::LAYER_WORDS) * u64::from(limits.max_texture_array_layers) * 4;
        Budget { bytes: (largest / 2).min(DEFAULT_BYTES), upload_per_frame: 32 << 20 }
    }
}

impl Gpu {
    /// Creates a WebGL2 device in browsers, or the best supported native raster device.
    /// Errors if no adapter or device is available.
    pub async fn new() -> Result<Gpu> {
        #[cfg(target_arch = "wasm32")]
        if !store::loaded() {
            return Err(Error::Unsupported(
                "latkit's shaders are not loaded: the page hands them over with Browser::set_shaders".into(),
            ));
        }
        #[cfg(not(all(feature = "web", target_arch = "wasm32")))]
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: if cfg!(target_arch = "wasm32") { wgpu::Backends::GL } else { wgpu::Backends::PRIMARY },
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        let (instance, mut browser) = browser::Browser::new()?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })
            .await
            .map_err(|e| Error::Unsupported(format!("no GPU adapter: {e}").into()))?;
        let supported = adapter.limits();
        let limits = wgpu::Limits {
            max_buffer_size: supported.max_buffer_size,
            max_color_attachment_bytes_per_sample: supported.max_color_attachment_bytes_per_sample.min(64),
            max_texture_dimension_2d: supported.max_texture_dimension_2d,
            max_texture_array_layers: supported.max_texture_array_layers,
            ..wgpu::Limits::downlevel_webgl2_defaults()
        };
        // Timestamp queries, where the adapter supports them, measure each frame's GPU time.
        let features =
            adapter.features() & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("latkit"),
                required_features: features,
                required_limits: limits,
                ..Default::default()
            })
            .await
            .map_err(|e| Error::Unsupported(format!("no GPU device: {e}").into()))?;
        let gpu = Gpu::create(Some(instance), Some(adapter), device, queue);
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        {
            browser.watch(&gpu);
            *gpu.0.browser.lock().unwrap_or_else(PoisonError::into_inner) = Some(browser);
        }
        Ok(gpu)
    }

    /// The multisample count of its frames, once set.
    pub(crate) fn samples(&self) -> Option<u32> {
        self.0.samples.get().copied()
    }

    /// The multisample count of its frames. If no screen set it when the GPU was created, the first
    /// frame's `pixel_ratio` sets it, and it stays fixed from then on.
    pub(crate) fn samples_for(&self, pixel_ratio: f32) -> u32 {
        *self.0.samples.get_or_init(|| samples_at(pixel_ratio))
    }

    /// Draws with an application-owned device and queue without replacing their callbacks.
    /// Forward device loss and uncaptured errors through [`Gpu::device_events`]. Clone this
    /// `Gpu` to share its caches and budget between views. Errors if the device does not meet
    /// the WebGL2 resource limits used by the shared raster algorithms. In a browser, latkit's
    /// shaders are GLSL translated ahead of time, so the device must be the WebGL2 device of a
    /// `Gpu` from [`Gpu::new`].
    pub fn from_wgpu(device: wgpu::Device, queue: wgpu::Queue) -> Result<Gpu> {
        if !wgpu::Limits::downlevel_webgl2_defaults().check_limits(&device.limits()) {
            return Err(Error::Unsupported("the device does not meet WebGL2 rendering limits".into()));
        }
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        if !gl::owns(&device) {
            return Err(Error::Unsupported("in a browser, latkit draws only on the WebGL2 device of Gpu::new".into()));
        }
        Ok(Gpu::create(None, None, device, queue))
    }

    /// A handle that the application's own device callbacks report to. It does not own the GPU.
    pub fn device_events(&self) -> DeviceEvents {
        DeviceEvents { lost: self.0.lost.clone(), raised: self.0.raised.clone() }
    }

    /// Raises `error` for every view of this GPU to report once. In a page it wakes the views, so
    /// they report it even when nothing else would draw a frame.
    pub(crate) fn raise(&self, error: Error) {
        self.device_events().raise(error);
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        crate::web::waker(self).wake();
    }

    /// Gives up the device once the page pool moved into a buffer the device then refused for lack
    /// of memory, so the pool holds nothing. The budget is lowered to the pool's size before, and
    /// the device counts as lost, so views move to a new device within the lowered budget. That is
    /// not an error, since the views go on drawing: only a move that fails is. A device latkit
    /// created is destroyed, which frees its memory at once.
    pub(crate) fn give_up_if_refused(&self) {
        {
            let mut inner = self.0.lock();
            let Some(granted) = inner.arena.broken() else { return };
            inner.budget.bytes = inner.budget.bytes.min(granted);
        }
        self.device_events().lost();
        if self.0.instance.is_some() {
            self.0.device.destroy();
        }
    }

    fn create(
        instance: Option<wgpu::Instance>,
        adapter: Option<wgpu::Adapter>,
        device: wgpu::Device,
        queue: wgpu::Queue,
    ) -> Gpu {
        let lost = Arc::new(AtomicBool::new(false));
        let raised: Arc<Mutex<Raised>> = Arc::default();
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("latkit ramp"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let budget = Budget::of(&device);
        let counters = Arc::new(Counters::default());
        let queue = Queue::new(queue, counters.clone());
        #[cfg_attr(
            target_arch = "wasm32",
            allow(clippy::arc_with_non_send_sync, reason = "browser GPU objects stay on the page's single thread")
        )]
        let shared = Arc::new_cyclic(|gpu| {
            let inner = Inner {
                arena: Arena::new(&device, queue.retired(), budget.bytes),
                state: state::State::new(&device, queue.retired()),
                listing: listing::Listing::new(&device, queue.retired()),
                bounds: bounds::Bounds::new(&device, queue.retired()),
                texts: texts::Texts::new(&device, queue.retired()),
                probing: probing::Probing::new(&device, queue.retired()),
                pieces: arena::Pieces::default(),
                pipelines: Pipelines::new(&device, counters.clone(), gpu.clone()),
                colormaps: Colormaps::colormaps(&device),
                dictionaries: Dictionaries::default(),
                packed: Packed::new(counters.clone()),
                tiles: crate::tiles::Cache::default(),
                atlas: Atlas::new(&device, counters.clone(), queue.retired()),
                icons: Icons::icons(&device),
                readbacks: Readbacks::counted(counters.clone(), queue.retired()),
                host: None,
                budget,
                ledger: Ledger::default(),
                frame: Allowance::default(),
            };
            Shared {
                instance,
                adapter,
                device,
                queue,
                counters,
                sampler,
                #[cfg(all(feature = "web", target_arch = "wasm32"))]
                browser: Mutex::new(None),
                lost,
                raised,
                samples: std::sync::OnceLock::new(),
                inner: Mutex::new(inner),
            }
        });
        // In a page, set the multisample count now from the screen's pixel ratio. Every view and
        // canvas of the GPU draws for that screen.
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        if let Some(window) = web_sys::window() {
            let _ = shared.samples.set(samples_at(window.device_pixel_ratio() as f32));
        }
        let gpu = Gpu(shared);
        if gpu.0.instance.is_some() {
            let events = gpu.device_events();
            let loss = events.clone();
            // In a page, a lost device or an error wakes the views, so they report it even when
            // nothing else would draw a frame.
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            let (wake, wake_on_error) = (crate::web::waker(&gpu), crate::web::waker(&gpu));
            gpu.0.device.set_device_lost_callback(move |_, _| {
                loss.lost();
                #[cfg(all(feature = "web", target_arch = "wasm32"))]
                wake.wake_by_ref();
            });
            gpu.0.device.on_uncaptured_error(Arc::new(move |error| {
                events.error(&error);
                #[cfg(all(feature = "web", target_arch = "wasm32"))]
                wake_on_error.wake_by_ref();
            }));
        }
        gpu
    }

    /// Exact counts of the work this GPU has done since it was created. The counts repeat for the
    /// same budget, device limits, and frames drawn, so tests and benchmarks can compare them with
    /// a baseline. Subtract two snapshots to get the work between them.
    pub fn work(&self) -> Work {
        self.0.counters.work()
    }

    /// The device.
    pub fn device(&self) -> &wgpu::Device {
        &self.0.device
    }

    /// The queue.
    pub fn queue(&self) -> &wgpu::Queue {
        &self.0.queue
    }

    /// The instance a `Gpu` from [`Gpu::new`] was created with, for creating surfaces it can draw
    /// to.
    pub fn instance(&self) -> Option<&wgpu::Instance> {
        self.0.instance.as_ref()
    }

    /// The adapter a `Gpu` from [`Gpu::new`] was created on, for a surface's capabilities.
    pub fn adapter(&self) -> Option<&wgpu::Adapter> {
        self.0.adapter.as_ref()
    }

    /// Sets how much GPU memory latkit uses. Bytes beyond what the device can bind are not used.
    pub fn set_budget(&self, budget: Budget) {
        let mut inner = self.0.lock();
        inner.arena.set_limit(&self.0.device, budget.bytes);
        inner.budget = budget;
    }

    /// How much GPU memory latkit uses: the budget set, or the default, lowered to what the device
    /// gave if it had no memory for more.
    pub fn budget(&self) -> Budget {
        self.0.lock().budget
    }

    /// Bytes resident on the GPU for all its views: data pages and each view's per-row state.
    pub fn resident(&self) -> u64 {
        self.0.lock().arena.resident()
    }

    /// Bytes waiting to upload, across all its views.
    pub fn uploading(&self) -> u64 {
        self.0.lock().arena.pending()
    }

    /// Gives views the platform's services: text, background jobs, fetching, and video encoding.
    /// Text the previous host rasterized is rasterized again by this one.
    pub fn set_host(&self, host: impl Host) {
        let mut inner = self.0.lock();
        inner.host = Some(Arc::new(host));
        inner.atlas.rehost();
    }

    /// Whether the device was lost. Drawing then does nothing until the views
    /// [move](crate::View::move_to) to a new `Gpu`. latkit
    /// also gives up a device whose page pool lost its pages for lack of memory, after lowering the
    /// [`budget`](Gpu::budget) to what the device gave, so a new `Gpu` with that budget stays
    /// within it.
    pub fn lost(&self) -> bool {
        self.0.lost.load(Ordering::Acquire)
    }
}

/// In a page, nothing records once the last view and shot of a `Gpu` are gone, so the pool and the
/// memory retired go at once, instead of whenever JavaScript collects them. Natively, dropping them
/// frees them once the GPU is done with them.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
impl Drop for Shared {
    fn drop(&mut self) {
        self.queue.retired().destroy();
        self.lock().arena.words().texture().destroy();
    }
}

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl std::fmt::Debug for Gpu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gpu").field("budget", &self.budget()).field("lost", &self.lost()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::{Ask, Error, Ledger, Raised};

    #[test]
    fn a_device_out_of_memory_is_given_up_without_an_error() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let granted = 48 << 20;
        gpu.0.lock().arena.refuse(granted);
        gpu.give_up_if_refused();
        assert!(gpu.lost(), "the device is given up, so its views move to a new one");
        assert_eq!(gpu.budget().bytes, granted, "within the memory it gave");
        let raised = gpu.0.raised.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(raised.since(0).count(), 0, "and that is no error");
        drop(raised);
        gpu.give_up_if_refused();
        assert_eq!(gpu.budget().bytes, granted, "once");
    }

    #[test]
    fn raised_errors_are_numbered_for_each_view_and_repeats_held_once() {
        let mut raised = Raised::default();
        let seen = raised.next();
        raised.push(Error::invalid("a"));
        raised.push(Error::invalid("a"));
        raised.push(Error::invalid("b"));
        let told: Vec<String> = raised.since(seen).map(ToString::to_string).collect();
        assert_eq!(told, ["input: a", "input: b"], "a repeat of the last error is held once");
        assert_eq!(raised.since(raised.next()).count(), 0, "a view that saw them all sees none again");
        for i in 0..40 {
            raised.push(Error::invalid(format!("{i}")));
        }
        assert_eq!(raised.since(seen).count(), Raised::HELD, "only the latest are held");
        assert_eq!(raised.since(seen).last().map(ToString::to_string).as_deref(), Some("input: 39"));
    }

    fn own(bytes: f64) -> Ask {
        Ask { own: bytes, shared: Vec::new() }
    }

    #[test]
    fn views_share_the_planned_budget_max_min_fair() {
        let mut ledger = Ledger::default();
        let grant = |ledger: &mut Ledger, view, bytes| ledger.grant(view, bytes, own(bytes), 1000);
        assert_eq!(grant(&mut ledger, 1, 100.0), 100.0, "a view asking for under half the budget gets all it asks");
        assert_eq!(grant(&mut ledger, 2, 900.0), 400.0, "the next gets the rest");
        assert_eq!(grant(&mut ledger, 3, 900.0), 200.0, "two large views split the rest of the budget");
        ledger.leave(2);
        assert_eq!(grant(&mut ledger, 3, 900.0), 400.0, "a view that leaves returns its share");
    }

    #[test]
    fn pages_shared_by_views_count_once() {
        let mut ledger = Ledger::default();
        // Eight views of one dataset, each reading 300 shared bytes and holding 20 of its own.
        let ask = Ask { own: 20.0, shared: vec![(7, 300.0)] };
        let shares: Vec<f64> = (0..8).map(|view| ledger.grant(view, 320.0, ask.clone(), 1000)).collect();
        assert_eq!(shares[7], 320.0, "300 + 8 × 20 fits the 500 planned, so every view gets its full ask");
        // Two views of different data, too large together, each get the same fraction of their ask.
        let mut ledger = Ledger::default();
        ledger.grant(1, 400.0, Ask { own: 0.0, shared: vec![(1, 400.0)] }, 1000);
        assert_eq!(ledger.grant(2, 400.0, Ask { own: 0.0, shared: vec![(2, 400.0)] }, 1000), 250.0);
    }
}
