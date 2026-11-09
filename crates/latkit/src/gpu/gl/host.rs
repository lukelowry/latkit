use super::{device::Device, queue::Queue, resource::Texture};
use crate::gpu::browser::{Canvas, Sink};
use std::{cell::RefCell, pin::Pin, rc::Rc};
use wasm_bindgen::{JsCast, JsValue};
use wgpu::custom::DeviceInterface;
use wgpu::custom::{
    AdapterInterface, DispatchAdapter, DispatchDevice, DispatchQueue, DispatchSurface, DispatchSurfaceOutputDetail,
    DispatchTexture, EnumerateAdapterFuture, InstanceInterface, RequestAdapterFuture, RequestDeviceFuture,
    SurfaceInterface, SurfaceOutputDetailInterface,
};

#[derive(Debug, Clone)]
pub(super) struct Instance(pub(super) Device);
#[derive(Debug, Clone)]
pub(super) struct Adapter(pub(super) Device);
impl InstanceInterface for Instance {
    fn new(_: wgpu::InstanceDescriptor) -> Self {
        let canvas = web_sys::OffscreenCanvas::new(1, 1).expect("offscreen canvas");
        let gl = canvas.get_context("webgl2").unwrap().expect("WebGL2").dyn_into().unwrap();
        Self(Device::new(gl).unwrap())
    }
    unsafe fn create_surface(
        &self,
        target: wgpu::SurfaceTargetUnsafe,
    ) -> Result<DispatchSurface, wgpu::CreateSurfaceError> {
        let wgpu::SurfaceTargetUnsafe::RawHandle { raw_window_handle, .. } = target else {
            panic!("a WebGL2 surface requires a browser canvas")
        };
        let pointer = match raw_window_handle {
            raw_window_handle::RawWindowHandle::WebCanvas(handle) => handle.obj,
            raw_window_handle::RawWindowHandle::WebOffscreenCanvas(handle) => handle.obj,
            _ => panic!("a WebGL2 surface requires a browser canvas"),
        };
        // The unsafe interface requires a live raw handle. wgpu's safe Canvas variants keep
        // the referenced JsValue alive through this call. Clone it before that borrow ends.
        let canvas = unsafe { &*pointer.as_ptr().cast::<JsValue>() }.clone();
        let sink = Canvas::from_value(canvas).and_then(Sink::on).expect("a writable canvas surface");
        let source = Canvas::from_value(self.0.0.gl.canvas().expect("WebGL2 canvas").into()).expect("browser canvas");
        Ok(DispatchSurface::custom(Surface { device: self.0.clone(), source, sink, texture: RefCell::default() }))
    }
    fn request_adapter(&self, _: &wgpu::RequestAdapterOptions<'_, '_>) -> Pin<Box<dyn RequestAdapterFuture>> {
        let adapter = Adapter(self.0.clone());
        Box::pin(async move { Ok(DispatchAdapter::custom(adapter)) })
    }
    fn poll_all_devices(&self, _: bool) -> bool {
        true
    }
    #[cfg(feature = "wgsl")]
    fn wgsl_language_features(&self) -> wgpu::WgslLanguageFeatures {
        wgpu::WgslLanguageFeatures::empty()
    }
    fn enumerate_adapters(&self, backends: wgpu::Backends) -> Pin<Box<dyn EnumerateAdapterFuture>> {
        let adapters = if backends.contains(wgpu::Backends::GL) {
            vec![DispatchAdapter::custom(Adapter(self.0.clone()))]
        } else {
            Vec::new()
        };
        Box::pin(async move { adapters })
    }
}
impl AdapterInterface for Adapter {
    fn request_device(&self, desc: &wgpu::DeviceDescriptor<'_>) -> Pin<Box<dyn RequestDeviceFuture>> {
        let supported = desc.required_features.is_empty() && desc.required_limits.check_limits(&self.0.limits());
        let device = self.0.clone();
        Box::pin(async move {
            if !supported {
                return Err(wgpu::RequestDeviceError::from_message(
                    "requested features or limits exceed this WebGL2 device".into(),
                ));
            }
            let queue = Queue { state: device.0.clone(), submitted: std::cell::Cell::default() };
            Ok((DispatchDevice::custom(device), DispatchQueue::custom(queue)))
        })
    }
    fn is_surface_supported(&self, surface: &DispatchSurface) -> bool {
        surface.as_custom::<Surface>().is_some_and(|s| Rc::ptr_eq(&s.device.0, &self.0.0))
    }
    fn features(&self) -> wgpu::Features {
        self.0.features()
    }
    fn limits(&self) -> wgpu::Limits {
        self.0.limits()
    }
    fn downlevel_capabilities(&self) -> wgpu::DownlevelCapabilities {
        wgpu::DownlevelCapabilities { flags: wgpu::DownlevelFlags::empty(), ..Default::default() }
    }
    fn get_info(&self) -> wgpu::AdapterInfo {
        self.0.adapter_info()
    }
    fn get_texture_format_features(&self, format: wgpu::TextureFormat) -> wgpu::TextureFormatFeatures {
        if !matches!(
            format,
            wgpu::TextureFormat::Rgba8Unorm
                | wgpu::TextureFormat::R8Unorm
                | wgpu::TextureFormat::R32Uint
                | wgpu::TextureFormat::Rgba32Uint
                | wgpu::TextureFormat::Depth32Float
        ) {
            return wgpu::TextureFormatFeatures {
                allowed_usages: wgpu::TextureUsages::empty(),
                flags: wgpu::TextureFormatFeatureFlags::empty(),
            };
        }
        let flags = if matches!(
            format,
            wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::R8Unorm | wgpu::TextureFormat::Depth32Float
        ) {
            wgpu::TextureFormatFeatureFlags::FILTERABLE
                | wgpu::TextureFormatFeatureFlags::MULTISAMPLE_X4
                | if format.is_depth_stencil_format() {
                    wgpu::TextureFormatFeatureFlags::empty()
                } else {
                    wgpu::TextureFormatFeatureFlags::MULTISAMPLE_RESOLVE
                }
        } else {
            wgpu::TextureFormatFeatureFlags::empty()
        };
        wgpu::TextureFormatFeatures {
            // WebGL2 depth is rendered and sampled directly. Its readPixels path cannot
            // copy depth into a buffer, so do not advertise the color transfer contract.
            allowed_usages: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | if format.is_depth_stencil_format() {
                    wgpu::TextureUsages::empty()
                } else {
                    wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST
                },
            flags,
        }
    }
    fn get_presentation_timestamp(&self) -> wgpu::PresentationTimestamp {
        wgpu::PresentationTimestamp::INVALID_TIMESTAMP
    }
    fn cooperative_matrix_properties(&self) -> Vec<wgpu_types::CooperativeMatrixProperties> {
        Vec::new()
    }
}
#[derive(Debug)]
pub(super) struct Surface {
    device: Device,
    source: Canvas,
    sink: Sink,
    texture: RefCell<Option<Texture>>,
}
impl SurfaceInterface for Surface {
    fn get_capabilities(&self, adapter: &DispatchAdapter) -> wgpu::SurfaceCapabilities {
        if !adapter.as_custom::<Adapter>().is_some_and(|a| Rc::ptr_eq(&a.0.0, &self.device.0)) {
            return wgpu::SurfaceCapabilities::default();
        }
        wgpu::SurfaceCapabilities {
            formats: vec![wgpu::TextureFormat::Rgba8Unorm],
            format_capabilities: vec![wgpu::SurfaceFormatCapabilities {
                format: wgpu::TextureFormat::Rgba8Unorm,
                color_spaces: wgpu::SurfaceColorSpaces::SRGB,
            }],
            present_modes: vec![wgpu::PresentMode::Fifo],
            alpha_modes: vec![wgpu::CompositeAlphaMode::Opaque],
            usages: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
        }
    }
    fn configure(&self, device: &DispatchDevice, config: &wgpu::SurfaceConfiguration) {
        assert!(Rc::ptr_eq(&device.as_custom::<Device>().unwrap().0, &self.device.0));
        assert_eq!(config.format, wgpu::TextureFormat::Rgba8Unorm);
        self.source.reserve([config.width, config.height]);
        let texture = Texture::new(
            &self.device.0.gl,
            &wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d { width: config.width, height: config.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: config.format,
                usage: config.usage,
                view_formats: &[],
            },
        );
        *self.texture.borrow_mut() = Some(texture);
    }
    fn get_current_texture(&self) -> (Option<DispatchTexture>, wgpu::SurfaceStatus, DispatchSurfaceOutputDetail) {
        let texture = self.texture.borrow().as_ref().expect("configured surface").clone();
        let detail = DispatchSurfaceOutputDetail::custom(Output {
            texture: texture.clone(),
            source: self.source.clone(),
            sink: self.sink.clone(),
        });
        if self.device.0.gl.is_context_lost() {
            (None, wgpu::SurfaceStatus::Lost, detail)
        } else {
            (Some(DispatchTexture::custom(texture)), wgpu::SurfaceStatus::Good, detail)
        }
    }
}
#[derive(Debug)]
pub(super) struct Output {
    texture: Texture,
    source: Canvas,
    sink: Sink,
}
impl SurfaceOutputDetailInterface for Output {
    fn texture_discard(&self) {}
    fn texture_release(&self) {}
}
impl Output {
    pub(super) fn present(&self) {
        let size = self.texture.0.size;
        super::blit(&self.texture, &self.source).expect("WebGL2 surface presentation");
        self.sink.resize([size.width, size.height]);
        self.sink.copy(&self.source, [size.width, size.height]).expect("canvas presentation");
    }
}
