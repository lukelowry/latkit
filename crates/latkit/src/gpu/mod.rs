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
}

/// How much GPU memory latkit uses.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize, serde::Deserialize),
    serde(rename_all = "camelCase", deny_unknown_fields)
)]
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
        Ok(Gpu::create(Some(instance), Some(adapter), device, queue))
    }

    /// Draws with a device the application created, sharing its queue.
    pub fn from_wgpu(device: wgpu::Device, queue: wgpu::Queue) -> Gpu {
        Gpu::create(None, None, device, queue)
    }

    fn create(
        instance: Option<wgpu::Instance>,
        adapter: Option<wgpu::Adapter>,
        device: wgpu::Device,
        queue: wgpu::Queue,
    ) -> Gpu {
        let lost = Arc::new(AtomicBool::new(false));
        device.set_device_lost_callback({
            let lost = lost.clone();
            move |_, _| lost.store(true, Ordering::Release)
        });
        let errors: Arc<Mutex<Vec<Error>>> = Arc::default();
        device.on_uncaptured_error({
            let errors = errors.clone();
            Arc::new(move |error: wgpu::Error| {
                let error = Error::Unsupported(format!("the GPU refused: {error}").into());
                errors.lock().unwrap_or_else(PoisonError::into_inner).push(error);
            })
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("latkit ramp"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let budget = Budget::of(&device);
        let counters = Arc::new(Counters::default());
        let inner = Inner {
            arena: Arena::new(&device, budget.bytes),
            pipelines: Pipelines::new(&device, counters.clone()),
            colormaps: Colormaps::new(&device),
            dictionaries: Dictionaries::default(),
            atlas: Atlas::new(&device, counters.clone()),
            icons: Icons::new(&device),
            readbacks: Readbacks::counted(counters.clone()),
            host: None,
            budget,
        };
        let queue = Queue::new(queue, counters.clone());
        #[cfg_attr(
            target_arch = "wasm32",
            allow(clippy::arc_with_non_send_sync, reason = "WebGPU objects stay on the one thread a page has")
        )]
        let shared = Arc::new(Shared {
            instance,
            adapter,
            device,
            queue,
            counters,
            sampler,
            lost,
            errors,
            inner: Mutex::new(inner),
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
}

impl std::fmt::Debug for Gpu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gpu").field("budget", &self.budget()).field("lost", &self.lost()).finish()
    }
}
