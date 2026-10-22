//! The GPU: one device shared by every view, with the page arena, pipelines, colormaps, and text
//! dictionaries every view draws from.

pub(crate) mod arena;
pub(crate) mod atlas;
pub(crate) mod colormaps;
pub(crate) mod dictionary;
pub(crate) mod icons;
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
use pipelines::Pipelines;
use readback::Readbacks;
use work::{Counters, Queue, Work};

use crate::host::Host;
use crate::{Error, Result};

/// The format views draw canvases and shots in, so both share one set of pipelines: every WebGPU
/// canvas takes it.
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
            .push(Error::Unsupported(format!("the GPU refused: {error}").into()));
    }
}

pub(crate) struct Shared {
    /// The instance and adapter `Gpu::new` created the device from, for surfaces.
    pub(crate) instance: Option<wgpu::Instance>,
    pub(crate) adapter: Option<wgpu::Adapter>,
    pub(crate) device: wgpu::Device,
    /// The queue, counting what is written through it.
    pub(crate) queue: Queue,
    /// What the GPU did, counted: views count the rows they evaluate and the jobs they hand out
    /// through it, and [`Gpu::work`] reads it.
    pub(crate) counters: Arc<Counters>,
    pub(crate) sampler: wgpu::Sampler,
    pub(crate) lost: Arc<AtomicBool>,
    /// Errors the device reported outside any scope, for views to tell.
    pub(crate) errors: Arc<Mutex<Vec<Error>>>,
    inner: Mutex<Inner>,
}

pub(crate) struct Inner {
    pub(crate) arena: Arena,
    pub(crate) pipelines: Pipelines,
    pub(crate) colormaps: Colormaps,
    pub(crate) dictionaries: Dictionaries,
    pub(crate) atlas: Atlas,
    pub(crate) icons: Icons,
    pub(crate) readbacks: Readbacks,
    pub(crate) host: Option<Arc<dyn Host>>,
    pub(crate) budget: Budget,
    /// What each view plans within: its share of the budget.
    pub(crate) ledger: Ledger,
}

/// The share of the budget the views of a GPU plan what they draw within, between them; the rest holds
/// pages a new version uploads while the one it replaces is still drawn, and pages cached.
const PLANNED: f64 = 0.5;

/// What each view of a GPU plans what it draws within: shares of one part of the budget, granted
/// max-min fair, so views together never plan past it however many there are. Pages several views
/// draw are on the GPU once, so they count once, split between those views.
#[derive(Default)]
pub(crate) struct Ledger {
    /// What each view would draw whole, by view.
    asks: rustc_hash::FxHashMap<u64, Ask>,
}

/// What a view would draw whole: bytes of its own, and the pages it reads that any view drawing the
/// same data shares.
#[derive(Clone, Default, PartialEq, Debug)]
pub(crate) struct Ask {
    /// Bytes no other view holds: its marks' state, focus, labels, traces, and derived columns.
    pub(crate) own: f64,
    /// Each piece any view drawing it shares, by what it holds, and its bytes.
    pub(crate) shared: Vec<(u64, f64)>,
}

impl Ledger {
    /// Records what view `view` would draw whole, `whole` bytes as it counts them, and grants it its
    /// share of what `budget` plans, as a part of `whole`. Each view asks its own bytes and a split of
    /// each piece it shares between the views drawing it; each gets all it asks while an even split
    /// of what is left covers it, else that split, views asking less having what they ask first.
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
    /// Bytes the data every view of the `Gpu` draws may take on the GPU: its pages, and each view's
    /// rows. A view draws a table too large for its share through the tiles the camera asks for, so
    /// what it draws always fits; pages no view draws stay cached in the room left, the least
    /// recently drawn going first. By default half the device's largest storage buffer. The pool of
    /// pages grows as data needs it, and never shrinks: set the budget before data draws.
    pub bytes: u64,
    /// Bytes uploaded per frame at most; larger data streams in over frames.
    pub upload_per_frame: u64,
}

impl Budget {
    /// Half the largest storage buffer `device` binds, and 32 MiB uploaded per frame.
    fn of(device: &wgpu::Device) -> Budget {
        let limits = device.limits();
        let largest = limits.max_storage_buffer_binding_size.min(limits.max_buffer_size);
        Budget { bytes: largest / 2, upload_per_frame: 32 << 20 }
    }
}

impl Gpu {
    /// Creates a device on the best adapter: WebGPU in browsers, Vulkan, Metal, or DX12 natively.
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
        // Timestamps, where the adapter writes them, measure what each frame costs the GPU.
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
        let gpu = Gpu::create(Some(instance), Some(adapter), device, queue);
        // In a browser what nearly every scene draws with compiles from now, while the page loads its
        // data, so the first view finds it compiled.
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        gpu.warm(web_sys::window().map_or(1.0, |w| w.device_pixel_ratio() as f32));
        Ok(gpu)
    }

    /// Asks, last of all, for what nearly every scene draws with into canvases at `pixel_ratio`:
    /// queued now and started a task later, so a view shown as the GPU is made compiles what it draws
    /// with first.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    fn warm(&self, pixel_ratio: f32) {
        let needs = crate::view::common(FORMAT, crate::view::samples(pixel_ratio));
        self.0.lock().pipelines.queue(&self.0.device, &needs, pipelines::Urgency::Warm, std::task::Waker::noop());
        let gpu = Arc::downgrade(&self.0);
        crate::time::later(std::time::Duration::ZERO, move || {
            if let Some(gpu) = gpu.upgrade()
                && let Some(mut inner) = gpu.try_lock()
            {
                inner.pipelines.pump(&gpu.device);
            }
        });
    }

    /// Draws with an application-owned device and queue without replacing their callbacks.
    /// Forward device loss and uncaptured errors through [`Gpu::device_events`]. Clone this
    /// `Gpu` to share its caches and budget between views.
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
            allow(clippy::arc_with_non_send_sync, reason = "WebGPU objects stay on the one thread a page has")
        )]
        let shared = Arc::new_cyclic(|gpu| {
            let inner = Inner {
                arena: Arena::new(&device, budget.bytes),
                pipelines: Pipelines::new(&device, counters.clone(), gpu.clone()),
                colormaps: Colormaps::new(&device),
                dictionaries: Dictionaries::default(),
                atlas: Atlas::new(&device, counters.clone()),
                icons: Icons::new(&device),
                readbacks: Readbacks::counted(counters.clone()),
                host: None,
                budget,
                ledger: Ledger::default(),
            };
            Shared { instance, adapter, device, queue, counters, sampler, lost, errors, inner: Mutex::new(inner) }
        });
        Gpu(shared)
    }

    /// What this GPU did since it was made, counted exactly. It repeats wherever the budget, the
    /// device's limits, and the frames drawn do, so tests and benchmarks hold it to what it was.
    /// Subtract two for what happened between.
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

    /// The instance a `Gpu` from [`Gpu::new`] was created with, for creating surfaces it can draw to.
    pub fn instance(&self) -> Option<&wgpu::Instance> {
        self.0.instance.as_ref()
    }

    /// The adapter a `Gpu` from [`Gpu::new`] was created on, for a surface's capabilities.
    pub fn adapter(&self) -> Option<&wgpu::Adapter> {
        self.0.adapter.as_ref()
    }

    /// Sets how much GPU memory latkit uses; bytes past what the device binds are not used.
    pub fn set_budget(&self, budget: Budget) {
        let mut inner = self.0.lock();
        inner.arena.set_limit(&self.0.device, budget.bytes);
        inner.budget = budget;
    }

    /// How much GPU memory latkit uses.
    pub fn budget(&self) -> Budget {
        self.0.lock().budget
    }

    /// Gives views the platform's services: setting text, and doing jobs off the frame.
    pub fn set_host(&self, host: impl Host) {
        self.0.lock().host = Some(Arc::new(host));
    }

    /// Whether the device was lost; drawing then does nothing, and a new `Gpu` is needed.
    pub fn lost(&self) -> bool {
        self.0.lost.load(Ordering::Acquire)
    }
}

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The lock, unless something holds it now.
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
        assert_eq!(grant(&mut ledger, 1, 100.0), 100.0, "a view asking less than half the budget has all it asks");
        assert_eq!(grant(&mut ledger, 2, 900.0), 400.0, "the next has what is left");
        assert_eq!(grant(&mut ledger, 3, 900.0), 200.0, "two large views split what the small one leaves");
        ledger.leave(2);
        assert_eq!(grant(&mut ledger, 3, 900.0), 400.0, "a view that leaves gives its share back");
    }

    #[test]
    fn pages_views_share_count_once() {
        let mut ledger = Ledger::default();
        // Eight views of one dataset: 300 bytes of shared pages each reads, and 20 of its own.
        let ask = Ask { own: 20.0, shared: vec![(7, 300.0)] };
        let shares: Vec<f64> = (0..8).map(|view| ledger.grant(view, 320.0, ask.clone(), 1000)).collect();
        assert_eq!(shares[7], 320.0, "300 + 8 × 20 fits the 500 planned: every view draws whole");
        // Two views of other data each, too large together: each has the same part of what it asks.
        let mut ledger = Ledger::default();
        ledger.grant(1, 400.0, Ask { own: 0.0, shared: vec![(1, 400.0)] }, 1000);
        assert_eq!(ledger.grant(2, 400.0, Ask { own: 0.0, shared: vec![(2, 400.0)] }, 1000), 250.0);
    }
}
