//! GPU memory latkit no longer needs. In a browser, a dropped buffer or texture keeps its memory
//! until JavaScript collects the object, which a page whose work runs in wasm may not do for a long
//! time. So every buffer and texture latkit replaces, or stops using, is retired here, and in a
//! page destroyed once no command still being recorded can use it: after the page's animation
//! frame submits its work, or between frames. Work already submitted still completes. Destroying it
//! sooner would invalidate commands still being recorded. Natively, a retired buffer or texture is
//! dropped at once, and wgpu frees it once no command that uses it remains.

use std::sync::Arc;
#[cfg(target_arch = "wasm32")]
use std::sync::{Mutex, PoisonError};

use super::work::{Count, Counters};

/// A buffer or texture latkit no longer needs.
pub(crate) enum Gone {
    Buffer(wgpu::Buffer),
    Texture(wgpu::Texture),
}

impl Gone {
    /// The bytes it holds on the GPU.
    fn bytes(&self) -> u64 {
        match self {
            Gone::Buffer(buffer) => buffer.size(),
            Gone::Texture(texture) => {
                let texel =
                    u64::from(texture.format().block_copy_size(None).unwrap_or(4)) * u64::from(texture.sample_count());
                (0..texture.mip_level_count())
                    .map(|level| {
                        let size = texture.size().mip_level_size(level, texture.dimension());
                        u64::from(size.width) * u64::from(size.height) * u64::from(size.depth_or_array_layers) * texel
                    })
                    .sum()
            }
        }
    }
}

impl From<wgpu::Buffer> for Gone {
    fn from(buffer: wgpu::Buffer) -> Gone {
        Gone::Buffer(buffer)
    }
}

impl From<wgpu::Texture> for Gone {
    fn from(texture: wgpu::Texture) -> Gone {
        Gone::Texture(texture)
    }
}

/// The buffers and textures retired, in a page until they are destroyed. Cheap to clone: clones
/// share one list.
#[derive(Clone)]
pub(crate) struct Retired {
    #[cfg(target_arch = "wasm32")]
    gone: Arc<Mutex<Vec<Gone>>>,
    counters: Arc<Counters>,
}

impl Retired {
    pub(crate) fn new(counters: Arc<Counters>) -> Retired {
        #[cfg(target_arch = "wasm32")]
        #[allow(clippy::arc_with_non_send_sync, reason = "WebGL objects stay on the page's single thread")]
        let gone = Arc::new(Mutex::new(Vec::new()));
        Retired {
            #[cfg(target_arch = "wasm32")]
            gone,
            counters,
        }
    }

    /// Retires `gone`: in a page, to be destroyed once no command still being recorded can use it,
    /// and natively, dropped now. Either way it counts as destroyed.
    pub(crate) fn retire(&self, gone: impl Into<Gone>) {
        let gone = gone.into();
        #[cfg(target_arch = "wasm32")]
        self.gone.lock().unwrap_or_else(PoisonError::into_inner).push(gone);
        #[cfg(not(target_arch = "wasm32"))]
        self.counters.add(Count::Destroyed, gone.bytes());
    }

    /// Destroys everything retired, counted as destroyed. Call it only where no command still
    /// being recorded can use what was retired: after the page's animation frame submits its work,
    /// or between frames.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn destroy(&self) {
        let gone = std::mem::take(&mut *self.gone.lock().unwrap_or_else(PoisonError::into_inner));
        if gone.is_empty() {
            return;
        }
        let mut bytes = 0;
        for gone in gone {
            bytes += gone.bytes();
            match gone {
                Gone::Buffer(buffer) => buffer.destroy(),
                Gone::Texture(texture) => texture.destroy(),
            }
        }
        self.counters.add(Count::Destroyed, bytes);
    }
}
