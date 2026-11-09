use std::{
    cell::{Cell, OnceCell, RefCell},
    collections::HashMap,
    rc::Rc,
};
use web_sys::{WebGl2RenderingContext as Gl, WebGlProgram, WebGlShader};
use wgpu::custom::{
    DispatchBindGroupLayout, RenderPipelineInterface, ShaderCompilationInfoFuture, ShaderModuleInterface,
};

/// A shader stage of a WebGL2 program.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Stage {
    Vertex,
    Fragment,
}

/// A shader module: GLSL ES 3.00 for one entry point, passed through as is, or with the `wgsl`
/// feature, a WGSL module translated for each entry point and constants a pipeline uses.
#[derive(Debug)]
pub(super) enum Shader {
    Glsl {
        entry: String,
        source: Source,
    },
    #[cfg(feature = "wgsl")]
    Wgsl {
        module: Box<Result<(naga::Module, naga::valid::ModuleInfo), String>>,
        sources: RefCell<HashMap<SourceKey, Source>>,
    },
}

#[cfg(feature = "wgsl")]
#[derive(Debug, PartialEq, Eq, Hash)]
pub(super) struct SourceKey {
    stage: Stage,
    entry: String,
    constants: Vec<(String, u64)>,
}

impl Shader {
    /// The GLSL of entry point `entry`, with its bindings named in its header (see
    /// `src/gpu/glsl.rs`).
    pub(super) fn glsl(entry: String, text: &str) -> Self {
        let slot =
            |words: &[&str]| -> Option<Slot> { Some((words.first()?.parse().ok()?, words.get(1)?.parse().ok()?)) };
        let bindings = text
            .lines()
            .skip(1)
            .map_while(|line| line.strip_prefix("//@"))
            .filter_map(|line| {
                let words: Vec<&str> = line.split(' ').collect();
                match *words.first()? {
                    "uniform" => Some(Reflected::Uniform(words.get(1)?.to_string(), slot(&words[2..])?)),
                    "texture" => Some(Reflected::Texture(
                        words.get(1)?.to_string(),
                        slot(&words[2..])?,
                        words.get(4..).and_then(slot),
                    )),
                    _ => None,
                }
            })
            .collect();
        Self::Glsl { entry, source: Source { text: text.into(), bindings, layout: Vec::new() } }
    }

    #[cfg(feature = "wgsl")]
    pub(super) fn wgsl(module: Result<naga::Module, String>) -> Self {
        let module = module.and_then(|module| {
            let info =
                naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
                    .validate(&module)
                    .map_err(|error| error.to_string())?;
            Ok((module, info))
        });
        Self::Wgsl { module: Box::new(module), sources: RefCell::default() }
    }

    pub(super) fn error(&self) -> Option<&str> {
        match self {
            Self::Glsl { .. } => None,
            #[cfg(feature = "wgsl")]
            Self::Wgsl { module, .. } => (**module).as_ref().err().map(String::as_str),
        }
    }
}

impl ShaderModuleInterface for Shader {
    fn get_compilation_info(&self) -> std::pin::Pin<Box<dyn ShaderCompilationInfoFuture>> {
        let messages = self
            .error()
            .map(|message| wgpu::CompilationMessage {
                message: message.to_owned(),
                message_type: wgpu::CompilationMessageType::Error,
                location: None,
            })
            .into_iter()
            .collect();
        Box::pin(async move { wgpu::CompilationInfo { messages } })
    }
}

#[derive(Debug, Clone)]
pub(super) struct Pipeline {
    pub(super) program: Result<Rc<Program>, String>,
    pub(super) primitive: wgpu::PrimitiveState,
    pub(super) depth: Option<wgpu::DepthStencilState>,
    pub(super) targets: Vec<Option<wgpu::ColorTargetState>>,
    pub(super) layouts: Vec<super::resource::Layout>,
    pub(super) vertices: Rc<Vec<super::vertex::Layout>>,
}

impl RenderPipelineInterface for Pipeline {
    fn get_bind_group_layout(&self, index: u32) -> DispatchBindGroupLayout {
        DispatchBindGroupLayout::custom(self.layouts[index as usize].clone())
    }
}

#[derive(Debug)]
pub(super) struct Program {
    pub(super) gl: Gl,
    pub(super) raw: WebGlProgram,
    shaders: Vec<Rc<Compiled>>,
    ready: OnceCell<Result<(), String>>,
    checking: Cell<bool>,
    waiters: RefCell<Vec<std::task::Waker>>,
    bindings: Vec<Reflected>,
    pub(super) uniforms: RefCell<Vec<(Slot, u32)>>,
    pub(super) textures: RefCell<Vec<(Slot, Option<Slot>, u32)>>,
    pub(super) first_instance: RefCell<Option<web_sys::WebGlUniformLocation>>,
    pub(super) layouts: Vec<super::resource::Layout>,
}

pub(super) type Slot = (u32, u32);
#[derive(Debug, Clone)]
pub(super) enum Reflected {
    Uniform(String, Slot),
    Texture(String, Slot, Option<Slot>),
}
#[derive(Debug, Clone)]
pub(super) struct Source {
    // The module, stage cache, and linked-program cache own the same immutable source.
    pub(super) text: Rc<str>,
    pub(super) bindings: Vec<Reflected>,
    pub(super) layout: super::bindings::Entries,
}

#[derive(Debug)]
/// A compiled WebGL shader.
pub(super) struct Compiled {
    gl: Gl,
    raw: WebGlShader,
}
impl Drop for Compiled {
    fn drop(&mut self) {
        self.gl.delete_shader(Some(&self.raw));
    }
}
pub(super) type Stages = HashMap<(u32, Rc<str>), Rc<Compiled>>;

impl Program {
    pub(super) fn new(gl: &Gl, sources: &[Source], stages: &mut Stages) -> Result<Self, String> {
        let layouts = super::bindings::merge(sources.iter().map(|source| source.layout.clone()))?;
        let mut shaders = Vec::new();
        for (index, source) in sources.iter().enumerate() {
            let kind = if index == 0 { Gl::VERTEX_SHADER } else { Gl::FRAGMENT_SHADER };
            let key = (kind, source.text.clone());
            let shader = if let Some(shader) = stages.get(&key) {
                shader.clone()
            } else {
                let shader = gl.create_shader(kind).ok_or("cannot allocate a WebGL shader")?;
                gl.shader_source(&shader, &source.text);
                gl.compile_shader(&shader);
                let shader = Rc::new(Compiled { gl: gl.clone(), raw: shader });
                stages.insert(key, shader.clone());
                shader
            };
            shaders.push(shader);
        }
        // Allocate the program only after both stages exist. A failed shader allocation
        // must not leave a program without an owner to delete it.
        let raw = gl.create_program().ok_or("cannot allocate a WebGL program")?;
        for shader in &shaders {
            gl.attach_shader(&raw, &shader.raw);
        }
        // No status query here: with KHR_parallel_shader_compile these return before linking.
        gl.link_program(&raw);
        gl.flush();
        Ok(Self {
            gl: gl.clone(),
            raw,
            shaders,
            ready: OnceCell::new(),
            checking: Cell::new(false),
            waiters: RefCell::default(),
            bindings: sources.iter().flat_map(|s| s.bindings.clone()).collect(),
            uniforms: RefCell::default(),
            textures: RefCell::default(),
            first_instance: RefCell::default(),
            layouts,
        })
    }

    /// Has the device's poller follow the link until it ends. A program may belong to several
    /// pipelines and nested scopes, and is followed once.
    pub(super) fn watch(self: &Rc<Self>, state: &Rc<super::device::State>) {
        if self.ready.get().is_none() && !self.checking.replace(true) {
            super::waits::Waits::link(state, self);
        }
    }

    /// Wakes those waiting for the link's result.
    pub(super) fn wake(&self) {
        for waker in std::mem::take(&mut *self.waiters.borrow_mut()) {
            waker.wake();
        }
    }

    /// The link's result, once the poller [watches](Program::watch) it end.
    pub(super) async fn result(&self) -> Result<(), String> {
        std::future::poll_fn(|cx| {
            if let Some(result) = self.ready.get() {
                return std::task::Poll::Ready(result.clone());
            }
            let mut waiters = self.waiters.borrow_mut();
            if !waiters.iter().any(|w| w.will_wake(cx.waker())) {
                waiters.push(cx.waker().clone());
            }
            std::task::Poll::Pending
        })
        .await
    }

    pub(super) fn finish(&self) -> Result<(), String> {
        self.ready.get_or_init(|| self.linked()).clone()
    }

    fn linked(&self) -> Result<(), String> {
        if self.gl.get_program_parameter(&self.raw, Gl::LINK_STATUS).as_bool() != Some(true) {
            return Err(self.gl.get_program_info_log(&self.raw).unwrap_or_else(|| "WebGL linking failed".into()));
        }
        self.gl.use_program(Some(&self.raw));
        let mut uniforms = self.uniforms.borrow_mut();
        let mut textures = self.textures.borrow_mut();
        for binding in &self.bindings {
            match binding {
                Reflected::Uniform(name, slot) => {
                    let index = self.gl.get_uniform_block_index(&self.raw, name);
                    if index == Gl::INVALID_INDEX {
                        continue;
                    }
                    let unit = if let Some((_, unit)) = uniforms.iter().find(|(bound, _)| bound == slot) {
                        *unit
                    } else {
                        let unit = uniforms.len() as u32;
                        uniforms.push((*slot, unit));
                        unit
                    };
                    self.gl.uniform_block_binding(&self.raw, index, unit);
                }
                Reflected::Texture(name, texture, sampler) => {
                    let Some(location) = self.gl.get_uniform_location(&self.raw, name) else {
                        continue;
                    };
                    let unit =
                        if let Some((_, _, unit)) = textures.iter().find(|(t, s, _)| t == texture && s == sampler) {
                            *unit
                        } else {
                            let unit = textures.len() as u32;
                            textures.push((*texture, *sampler, unit));
                            unit
                        };
                    self.gl.uniform1i(Some(&location), unit as i32);
                }
            }
        }
        *self.first_instance.borrow_mut() = self.gl.get_uniform_location(&self.raw, "naga_vs_first_instance");
        Ok(())
    }
}

impl Drop for Program {
    fn drop(&mut self) {
        for shader in &self.shaders {
            self.gl.detach_shader(&self.raw, &shader.raw);
        }
        self.gl.delete_program(Some(&self.raw));
    }
}

/// The GLSL of `shader`'s entry point `name` for `stage`, specialized with `constants`. GLSL passed
/// through takes no constants.
pub(super) fn glsl(
    shader: &wgpu::ShaderModule,
    name: Option<&str>,
    stage: Stage,
    constants: &[(&str, f64)],
) -> Result<Source, String> {
    let shader = shader.as_custom::<Shader>().ok_or("shader belongs to another backend")?;
    #[cfg(not(feature = "wgsl"))]
    let _ = stage;
    match shader {
        Shader::Glsl { entry, source } => {
            if name.is_some_and(|name| name != entry) {
                return Err(format!("the GLSL module's entry point is {entry}, not {}", name.unwrap_or_default()));
            }
            if !constants.is_empty() {
                return Err("a GLSL module takes no pipeline constants".into());
            }
            Ok(source.clone())
        }
        #[cfg(feature = "wgsl")]
        Shader::Wgsl { module, sources } => translated(module, sources, name, stage, constants),
    }
}

/// The GLSL of a WGSL module's entry point, translated on first use.
#[cfg(feature = "wgsl")]
fn translated(
    module: &Result<(naga::Module, naga::valid::ModuleInfo), String>,
    sources: &RefCell<HashMap<SourceKey, Source>>,
    name: Option<&str>,
    stage: Stage,
    constants: &[(&str, f64)],
) -> Result<Source, String> {
    let (module, info) = module.as_ref().map_err(Clone::clone)?;
    let stage_of = |stage: Stage| match stage {
        Stage::Vertex => naga::ShaderStage::Vertex,
        Stage::Fragment => naga::ShaderStage::Fragment,
    };
    let mut matching = module
        .entry_points
        .iter()
        .filter(|entry| entry.stage == stage_of(stage) && name.is_none_or(|name| entry.name == name));
    let entry = matching.next().ok_or("no matching shader entry point")?;
    if matching.next().is_some() {
        return Err("an entry point must be specified when a shader has more than one for this stage".into());
    }
    let entry = entry.name.clone();
    // Naga uses the last value of a repeated constant. Sorting makes equivalent options
    // share a source, while keeping different specializations out of the same cache entry.
    let constants: std::collections::BTreeMap<_, _> =
        constants.iter().map(|(k, v)| ((*k).to_owned(), v.to_bits())).collect();
    let key = SourceKey { stage, entry: entry.clone(), constants: constants.into_iter().collect() };
    if let Some(source) = sources.borrow().get(&key) {
        return Ok(source.clone());
    }
    let stage = stage_of(stage);
    let specialized;
    let (module, info) = if module.overrides.is_empty() && key.constants.is_empty() {
        (module, info)
    } else {
        let constants = key.constants.iter().map(|(k, v)| (k.clone(), f64::from_bits(*v))).collect();
        specialized =
            naga::back::pipeline_constants::process_overrides(module, info, Some((stage, &entry)), &constants)
                .map_err(|e| e.to_string())?;
        (specialized.0.as_ref(), specialized.1.as_ref())
    };
    let options = naga::back::glsl::Options {
        version: naga::back::glsl::Version::Embedded { version: 300, is_webgl: true },
        writer_flags: naga::back::glsl::WriterFlags::ADJUST_COORDINATE_SPACE
            | naga::back::glsl::WriterFlags::FORCE_POINT_SIZE,
        ..Default::default()
    };
    let pipeline = naga::back::glsl::PipelineOptions { shader_stage: stage, entry_point: entry, multiview: None };
    let mut output = String::new();
    let reflection = naga::back::glsl::Writer::new(
        &mut output,
        module,
        info,
        &options,
        &pipeline,
        naga::proc::BoundsCheckPolicies::default(),
    )
    .map_err(|e| e.to_string())?
    .write()
    .map_err(|e| e.to_string())?;
    let layout = super::bindings::reflect(module, &reflection, stage)?;
    let slot = |handle: naga::Handle<naga::GlobalVariable>| {
        let binding = module.global_variables[handle].binding.as_ref().expect("resource binding");
        (binding.group, binding.binding)
    };
    let mut bindings = Vec::new();
    for (handle, name) in reflection.uniforms {
        bindings.push(Reflected::Uniform(name, slot(handle)));
    }
    for (name, texture) in reflection.texture_mapping {
        bindings.push(Reflected::Texture(name, slot(texture.texture), texture.sampler.map(slot)));
    }
    let source = Source { text: output.into(), bindings, layout };
    sources.borrow_mut().insert(key, source.clone());
    Ok(source)
}

pub(super) type Programs = HashMap<Vec<Rc<str>>, Rc<Program>>;
