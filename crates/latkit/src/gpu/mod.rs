//! The GPU: one device shared by every view, with the page arena, pipelines, colormaps, and text
//! dictionaries all views draw from.

pub(crate) mod arena;
pub(crate) mod atlas;
pub(crate) mod colormaps;
pub(crate) mod dictionary;
pub(crate) mod grown;
pub(crate) mod icons;
mod layers;
pub(crate) mod packed;
pub(crate) mod pipelines;
pub(crate) mod readback;
pub(crate) mod shaders;
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

/// The texture format of canvases and shots, shared so both use one set of pipelines. Every WebGPU
/// canvas supports it.
pub(crate) const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

/// The GPU device that views draw with. Cheap to clone; views of one `Gpu` share uploaded data.
#[derive(Clone)]
pub struct Gpu(pub(crate) Arc<Shared>);

/// Receives events from an application-owned wgpu device without taking over its callbacks.
#[derive(Clone)]
pub struct DeviceEvents {
    lost: Arc<AtomicBool>,
    errors: Arc<Mutex<Vec<Error>>>,
}

impl DeviceEvents {
    /// Reports device loss to every view sharing this GPU.
    pub fn lost(&self) {
        self.lost.store(true, Ordering::Release);
    }

    /// Reports an uncaptured device error to latkit's views.
    pub fn error(&self, error: &wgpu::Error) {
        self.errors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Error::Unsupported(format!("GPU error: {error}").into()));
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
    pub(crate) lost: Arc<AtomicBool>,
    /// Errors the device reported outside any error scope, for views to report.
    pub(crate) errors: Arc<Mutex<Vec<Error>>>,
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
    /// What the current frame, shared by views drawn together, may still upload and compute.
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
    /// released, and grows the pool to cover its shortfall.
    pub(crate) fn begin_frame(&mut self, view: u64, device: &wgpu::Device, queue: &Queue) {
        if self.frame.drawn.is_empty() || self.frame.drawn.contains(&view) {
            self.frame =
                Allowance { drawn: Vec::new(), upload: self.budget.upload_per_frame, work: crate::derive::FRAME_WORK };
            self.arena.begin_frame(device, queue);
        }
        self.frame.drawn.push(view);
    }
}

/// Fraction of the budget that a GPU's views together plan their drawing within. The rest holds the
/// pages a new data version uploads while the old one is still drawn, and cached pages.
const PLANNED: f64 = 0.5;

/// Each view's share of the planned part of the budget, granted max-min fair, so views together
/// never plan past it however many there are. Pages several views draw are resident once, so they
/// count once, split between those views.
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
    /// per-row state. A view draws a table too large for its share as a paged table, drawing only
    /// the pages the camera needs, so it always fits. Pages no view draws stay cached in the
    /// remaining room, least recently drawn evicted first. Defaults to half the device's largest
    /// storage buffer. The page pool grows as data needs it and never shrinks, so set the budget
    /// before drawing data.
    pub bytes: u64,
    /// Most bytes uploaded per frame; larger data streams in over several frames. Defaults to
    /// 32 MiB.
    pub upload_per_frame: u64,
}

impl Budget {
    /// The default budget: half the largest storage buffer `device` binds, and 32 MiB uploaded per
    /// frame.
    fn of(device: &wgpu::Device) -> Budget {
        let limits = device.limits();
        let largest = limits.max_storage_buffer_binding_size.min(limits.max_buffer_size);
        Budget { bytes: largest / 2, upload_per_frame: 32 << 20 }
    }
}

impl Gpu {
    /// Creates a device on the best adapter: WebGPU in browsers, Vulkan, Metal, or DX12 natively.
    /// Errors if no adapter or device is available.
    pub async fn new() -> Result<Gpu> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY | wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })
            .await
            .map_err(|e| Error::Unsupported(format!("no GPU adapter: {e}").into()))?;
        let supported = adapter.limits();
        let limits = wgpu::Limits {
            max_storage_buffer_binding_size: supported.max_storage_buffer_binding_size,
            max_buffer_size: supported.max_buffer_size,
            max_storage_buffers_per_shader_stage: supported.max_storage_buffers_per_shader_stage,
            ..wgpu::Limits::default()
        };
        // Timestamp queries, where the adapter supports them, measure each frame's GPU time.
        let features = adapter.features() & wgpu::Features::TIMESTAMP_QUERY;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("latkit"),
                required_features: features,
                required_limits: limits,
                ..Default::default()
            })
            .await
            .map_err(|e| Error::Unsupported(format!("no GPU device: {e}").into()))?;
        Ok(Gpu::create(Some(instance), Some(adapter), device, queue))
    }

    /// Queues, once, the pipelines nearly every scene uses to draw into the page's canvases, so
    /// views opened later find them compiled. In a browser this happens as the first view opens,
    /// and they compile after that view's draw pipelines finish. A GPU no view uses compiles
    /// nothing.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn warm(&self) {
        let pixel_ratio = web_sys::window().map_or(1.0, |w| w.device_pixel_ratio() as f32);
        let samples = self.samples_for(pixel_ratio);
        let waker = crate::web::waker(self);
        self.0.lock().pipelines.warm(&self.0.device, &waker, || crate::view::common(FORMAT, samples));
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
    /// WebGPU's default limits.
    pub fn from_wgpu(device: wgpu::Device, queue: wgpu::Queue) -> Result<Gpu> {
        if !wgpu::Limits::default().check_limits(&device.limits()) {
            return Err(Error::Unsupported("the device does not meet WebGPU's default limits".into()));
        }
        Ok(Gpu::create(None, None, device, queue))
    }

    /// A lightweight sink for the application's existing device callbacks; it does not own the GPU.
    pub fn device_events(&self) -> DeviceEvents {
        DeviceEvents { lost: self.0.lost.clone(), errors: self.0.errors.clone() }
    }

    fn create(
        instance: Option<wgpu::Instance>,
        adapter: Option<wgpu::Adapter>,
        device: wgpu::Device,
        queue: wgpu::Queue,
    ) -> Gpu {
        let lost = Arc::new(AtomicBool::new(false));
        let errors: Arc<Mutex<Vec<Error>>> = Arc::default();
        if instance.is_some() {
            let events = DeviceEvents { lost: lost.clone(), errors: errors.clone() };
            let loss = events.clone();
            device.set_device_lost_callback(move |_, _| loss.lost());
            device.on_uncaptured_error(Arc::new(move |error| events.error(&error)));
        }
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
            allow(clippy::arc_with_non_send_sync, reason = "WebGPU objects stay on the page's single thread")
        )]
        let shared = Arc::new_cyclic(|gpu| {
            let inner = Inner {
                arena: Arena::new(&device, budget.bytes),
                pieces: arena::Pieces::default(),
                pipelines: Pipelines::new(&device, counters.clone(), gpu.clone()),
                colormaps: Colormaps::colormaps(&device),
                dictionaries: Dictionaries::default(),
                packed: Packed::new(counters.clone()),
                tiles: crate::tiles::Cache::default(),
                atlas: Atlas::new(&device, counters.clone()),
                icons: Icons::icons(&device),
                readbacks: Readbacks::counted(counters.clone()),
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
                lost,
                errors,
                samples: std::sync::OnceLock::new(),
                inner: Mutex::new(inner),
            }
        });
        // In a page, set the multisample count now from the screen, which every view and canvas of
        // the GPU draws for.
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        if let Some(window) = web_sys::window() {
            let _ = shared.samples.set(samples_at(window.device_pixel_ratio() as f32));
        }
        Gpu(shared)
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

    /// How much GPU memory latkit uses.
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
    /// Texts the last host set are set again by this one.
    pub fn set_host(&self, host: impl Host) {
        let mut inner = self.0.lock();
        inner.host = Some(Arc::new(host));
        inner.atlas.rehost();
    }

    /// Whether the device was lost. Drawing then does nothing, and a new `Gpu` is needed.
    pub fn lost(&self) -> bool {
        self.0.lost.load(Ordering::Acquire)
    }
}

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The lock, or `None` if it is held now.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn try_lock(&self) -> Option<MutexGuard<'_, Inner>> {
        match self.inner.try_lock() {
            Ok(inner) => Some(inner),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }
}

impl std::fmt::Debug for Gpu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gpu").field("budget", &self.budget()).field("lost", &self.lost()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::{Ask, Ledger};

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
