//! H.264 through Windows Media Foundation: the platform's encoder transform, hardware where the
//! machine has one and the software encoder otherwise, on a thread of its own so encoding overlaps
//! drawing. NV12 pictures in, Annex B units out, no B-frames, keyframes where asked.

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use windows::Win32::Media::MediaFoundation::{
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncMPVDefaultBPictureCount,
    CODECAPI_AVEncMPVGOPSize, CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, ICodecAPI, IMFActivate,
    IMFMediaEventGenerator, IMFMediaType, IMFSample, IMFTransform, METransformDrainComplete, METransformHaveOutput,
    METransformNeedInput, MF_E_INVALIDMEDIATYPE, MF_E_NO_EVENTS_AVAILABLE, MF_E_NOTACCEPTING,
    MF_E_TRANSFORM_NEED_MORE_INPUT, MF_E_TRANSFORM_STREAM_CHANGE, MF_EVENT_FLAG_NO_WAIT, MF_LOW_LATENCY,
    MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG_SEQUENCE_HEADER, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX, MF_TRANSFORM_ASYNC,
    MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFMediaType_Video,
    MFNominalRange_16_235, MFSTARTUP_FULL, MFShutdown, MFStartup, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFT_MESSAGE_COMMAND_DRAIN,
    MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
    MFVideoPrimaries_BT709, MFVideoTransFunc_709, MFVideoTransferMatrix_BT709,
    eAVEncCommonRateControlMode_UnconstrainedVBR, eAVEncH264VProfile_High,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows::Win32::System::Variant::VARIANT;
use windows::core::Interface;

use crate::video::{Encoder, Encoding, TIMESCALE, Unit, nals};
use crate::{Error, Pending, Resolver, Result};

/// The longest the transform may take to start, to want a picture, or to drain.
const STALL: Duration = Duration::from_secs(20);
/// Pictures handed to the encoder's thread and not yet taken at most: room for one more while one
/// encodes.
const QUEUED: usize = 1;
/// Seconds between the keyframes the encoder places itself; the video asks for its own besides.
const KEYFRAMES: f64 = 2.0;
/// 100-nanosecond ticks a second, Media Foundation's clock.
const HNS: u64 = 10_000_000;

/// An encoder on a thread of its own, where Media Foundation lives.
struct MediaFoundation {
    work: Option<SyncSender<Work>>,
    done: Arc<Mutex<Done>>,
}

/// What the encoder's thread is handed.
enum Work {
    Picture { nv12: Vec<u8>, time: u64, key: bool },
    Finish(Resolver<Vec<Unit>>),
}

/// What the thread finished and the encoder has not handed out: units, and why it stopped.
#[derive(Default)]
struct Done {
    units: Vec<Unit>,
    error: Option<Error>,
}

/// An encoder for pictures as `encoding` says: the machine's hardware encoder where one starts, else
/// Windows' software encoder.
pub(super) fn encoder(encoding: &Encoding) -> Result<Box<dyn Encoder>> {
    open(*encoding, &[hardware(), software()]).map(|e| Box::new(e) as Box<dyn Encoder>)
}

fn hardware() -> MFT_ENUM_FLAG {
    MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER
}

fn software() -> MFT_ENUM_FLAG {
    MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER
}

/// An encoder from the first transform of `kinds`, in order, that starts.
fn open(encoding: Encoding, kinds: &[MFT_ENUM_FLAG]) -> Result<MediaFoundation> {
    let (started, ready) = mpsc::channel();
    let (work, pictures) = mpsc::sync_channel(QUEUED);
    let done = Arc::new(Mutex::new(Done::default()));
    let kinds = kinds.to_vec();
    let finished = done.clone();
    std::thread::Builder::new()
        .name("latkit encoder".into())
        .spawn(move || run(encoding, &kinds, &started, &pictures, &finished))
        .map_err(|e| Error::Load(format!("the encoder's thread did not start: {e}").into()))?;
    match ready.recv_timeout(STALL) {
        Ok(Ok(())) => Ok(MediaFoundation { work: Some(work), done }),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(Error::Timeout),
    }
}

impl MediaFoundation {
    fn done(&self) -> std::sync::MutexGuard<'_, Done> {
        self.done.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Why the thread stopped, or that it did.
    fn stopped(&self) -> Error {
        self.done().error.clone().unwrap_or_else(|| Error::Load("the encoder stopped".into()))
    }
}

impl Encoder for MediaFoundation {
    fn encode(&mut self, nv12: &[u8], time: u64, key: bool) -> Pending<Vec<Unit>> {
        if let Some(error) = self.done().error.clone() {
            return Pending::ready(Err(error));
        }
        let Some(work) = &self.work else { return Pending::ready(Err(self.stopped())) };
        // Waits while a picture is queued behind the one encoding: the encoder's room.
        if work.send(Work::Picture { nv12: nv12.to_vec(), time, key }).is_err() {
            return Pending::ready(Err(self.stopped()));
        }
        Pending::ready(Ok(std::mem::take(&mut self.done().units)))
    }

    fn finish(&mut self) -> Pending<Vec<Unit>> {
        let (pending, resolver) = Pending::new();
        let Some(work) = self.work.take() else { return Pending::ready(Err(self.stopped())) };
        if work.send(Work::Finish(resolver)).is_err() {
            return Pending::ready(Err(self.stopped()));
        }
        pending
    }
}

/// The encoder's thread: starts Media Foundation and the transform, then encodes what it is handed
/// until it finishes, fails, or the encoder is dropped.
fn run(
    encoding: Encoding,
    kinds: &[MFT_ENUM_FLAG],
    started: &Sender<Result<()>>,
    work: &Receiver<Work>,
    done: &Mutex<Done>,
) {
    let session = match Session::new() {
        Ok(session) => session,
        Err(error) => {
            let _ = started.send(Err(error));
            return;
        }
    };
    let mut transform = match Transform::first(&encoding, kinds) {
        Ok(transform) => transform,
        Err(error) => {
            let _ = started.send(Err(error));
            return;
        }
    };
    let _ = started.send(Ok(()));
    let fail = |error: Error| done.lock().unwrap_or_else(PoisonError::into_inner).error = Some(error);
    while let Ok(item) = work.recv() {
        match item {
            Work::Picture { nv12, time, key } => match transform.encode(&nv12, time, key) {
                Ok(units) => done.lock().unwrap_or_else(PoisonError::into_inner).units.extend(units),
                Err(error) => {
                    fail(error);
                    break;
                }
            },
            Work::Finish(resolver) => {
                let result = transform.finish().map(|units| {
                    let mut all = std::mem::take(&mut done.lock().unwrap_or_else(PoisonError::into_inner).units);
                    all.extend(units);
                    all
                });
                if let Err(error) = &result {
                    fail(error.clone());
                }
                resolver.resolve(result);
                break;
            }
        }
    }
    drop(transform);
    drop(session);
}

/// A failed Media Foundation call, named.
fn failed(call: &str, error: &windows::core::Error) -> Error {
    Error::Unsupported(format!("the Media Foundation encoder's {call}: {error}").into())
}

/// COM and Media Foundation, started on this thread and shut down with it.
struct Session {
    media: bool,
}

impl Session {
    fn new() -> Result<Session> {
        // SAFETY: initialized on this thread, uninitialized on it when the session drops.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|e| failed("CoInitializeEx", &e))? };
        let mut session = Session { media: false };
        // SAFETY: paired with MFShutdown when the session drops, on this thread.
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| failed("MFStartup", &e))? };
        session.media = true;
        Ok(session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: every transform, sample, and buffer of this thread was released before.
        unsafe {
            if self.media {
                let _ = MFShutdown();
            }
            CoUninitialize();
        }
    }
}

/// One H.264 encoder transform, streaming.
struct Transform {
    activate: IMFActivate,
    mft: IMFTransform,
    codec: Option<ICodecAPI>,
    /// An asynchronous transform's events: hardware encoders are asynchronous.
    events: Option<IMFMediaEventGenerator>,
    /// Inputs an asynchronous transform asked for and was not given.
    wanted: u32,
    input: u32,
    output: u32,
    /// Whether the transform makes its output samples; else, how large a buffer it takes.
    provides: bool,
    output_size: u32,
    /// The times of the pictures given and not yet encoded, in order: no B-frames reorder them.
    times: VecDeque<u64>,
    /// The SPS and PPS, Annex B, for keyframes that leave them out.
    header: Vec<u8>,
    /// Parameter sets the transform gave as units of their own, for the next picture.
    prefix: Vec<u8>,
    encoding: Encoding,
}

impl Transform {
    /// The first transform of `kinds` that starts for `encoding`.
    fn first(encoding: &Encoding, kinds: &[MFT_ENUM_FLAG]) -> Result<Transform> {
        let mut last = Error::Unsupported("this machine has no H.264 encoder".into());
        for &kind in kinds {
            for activate in activates(kind)? {
                match Transform::new(activate, encoding) {
                    Ok(transform) => return Ok(transform),
                    Err(error) => last = error,
                }
            }
        }
        Err(last)
    }

    fn new(activate: IMFActivate, encoding: &Encoding) -> Result<Transform> {
        let [width, height] = encoding.size;
        let (num, den) = rational(encoding.fps);
        // SAFETY: owned COM handles; every pointer argument borrows a value that outlives its call.
        unsafe {
            let mft: IMFTransform = activate.ActivateObject().map_err(|e| failed("ActivateObject", &e))?;
            let mut transform = Transform {
                activate,
                codec: mft.cast::<ICodecAPI>().ok(),
                events: None,
                wanted: 0,
                input: 0,
                output: 0,
                provides: false,
                output_size: 0,
                times: VecDeque::new(),
                header: Vec::new(),
                prefix: Vec::new(),
                encoding: *encoding,
                mft,
            };
            if let Ok(attributes) = transform.mft.GetAttributes() {
                if attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                    attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(|e| failed("SetUINT32", &e))?;
                    transform.events = Some(transform.mft.cast().map_err(|e| failed("cast", &e))?);
                }
                let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            let (mut inputs, mut outputs) = ([0_u32], [0_u32]);
            if transform.mft.GetStreamIDs(&mut inputs, &mut outputs).is_ok() {
                (transform.input, transform.output) = (inputs[0], outputs[0]);
            }
            if let Some(codec) = &transform.codec {
                // What an encoder cannot set it does without: these only shape its output.
                let gop = (encoding.fps * KEYFRAMES).round().max(1.0) as u32;
                let rate = eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32;
                for (api, value) in [
                    (&CODECAPI_AVEncCommonRateControlMode, VARIANT::from(rate)),
                    (&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(encoding.bitrate)),
                    (&CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0_u32)),
                    (&CODECAPI_AVEncMPVGOPSize, VARIANT::from(gop)),
                    (&CODECAPI_AVLowLatencyMode, VARIANT::from(true)),
                ] {
                    let _ = codec.SetValue(api, &raw const value);
                }
            }
            let output = MFCreateMediaType().map_err(|e| failed("MFCreateMediaType", &e))?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| failed("SetGUID", &e))?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| failed("SetGUID", &e))?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, encoding.bitrate).map_err(|e| failed("SetUINT32", &e))?;
            output
                .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                .map_err(|e| failed("SetUINT32", &e))?;
            picture(&output, width, height, num, den)?;
            transform.mft.SetOutputType(transform.output, &output, 0).map_err(|e| {
                if e.code() == MF_E_INVALIDMEDIATYPE {
                    Error::Unsupported(
                        format!("this H.264 encoder takes no {width}×{height} pictures at {num}/{den} fps").into(),
                    )
                } else {
                    failed("SetOutputType", &e)
                }
            })?;
            let input = transform.input_type(width, height, num, den)?;
            transform.mft.SetInputType(transform.input, &input, 0).map_err(|e| failed("SetInputType", &e))?;
            transform.output_info()?;
            transform.header = header(&transform.mft, transform.output);
            transform
                .mft
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|e| failed("ProcessMessage", &e))?;
            transform
                .mft
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|e| failed("ProcessMessage", &e))?;
            Ok(transform)
        }
    }

    /// The NV12 input type: the transform's own where it offers one, else a type of ours.
    fn input_type(&self, width: u32, height: u32, num: u32, den: u32) -> Result<IMFMediaType> {
        // SAFETY: owned COM handles only.
        unsafe {
            let offered = (0..64)
                .map_while(|i| self.mft.GetInputAvailableType(self.input, i).ok())
                .find(|t| t.GetGUID(&MF_MT_SUBTYPE).is_ok_and(|s| s == MFVideoFormat_NV12));
            let input = if let Some(input) = offered {
                input
            } else {
                let input = MFCreateMediaType().map_err(|e| failed("MFCreateMediaType", &e))?;
                input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| failed("SetGUID", &e))?;
                input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| failed("SetGUID", &e))?;
                input
            };
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, width).map_err(|e| failed("SetUINT32", &e))?;
            picture(&input, width, height, num, den)?;
            Ok(input)
        }
    }

    /// Whether the transform makes its own output samples, and how large ours must be otherwise.
    fn output_info(&mut self) -> Result<()> {
        // SAFETY: owned COM handles only.
        let info =
            unsafe { self.mft.GetOutputStreamInfo(self.output) }.map_err(|e| failed("GetOutputStreamInfo", &e))?;
        self.provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let [width, height] = self.encoding.size;
        self.output_size = info.cbSize.max(width * height * 3 / 2);
        Ok(())
    }

    /// Encodes one NV12 picture at `time` ticks, a keyframe when `key`: the units the transform
    /// finished meanwhile.
    fn encode(&mut self, nv12: &[u8], time: u64, key: bool) -> Result<Vec<Unit>> {
        let sample = self.sample(nv12, time)?;
        if key && let Some(codec) = &self.codec {
            let force = VARIANT::from(1_u32);
            // SAFETY: a value borrowed for the call.
            let _ = unsafe { codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &raw const force) };
        }
        self.times.push_back(time);
        let mut units = Vec::new();
        if self.events.is_some() {
            let started = Instant::now();
            while self.wanted == 0 {
                self.event(started, true, &mut units)?;
            }
            self.wanted -= 1;
            self.input(&sample)?;
            // Whatever it says without waiting: outputs ready, and inputs wanted.
            while self.event(started, false, &mut units)? {}
        } else {
            let started = Instant::now();
            loop {
                // SAFETY: an owned sample, borrowed for the call.
                match unsafe { self.mft.ProcessInput(self.input, &sample, 0) } {
                    Ok(()) => break,
                    Err(e) if e.code() == MF_E_NOTACCEPTING && started.elapsed() < STALL => self.drain(&mut units)?,
                    Err(e) => return Err(failed("ProcessInput", &e)),
                }
            }
            self.drain(&mut units)?;
        }
        Ok(units)
    }

    /// The units the transform still holds once every picture given is encoded.
    fn finish(&mut self) -> Result<Vec<Unit>> {
        let mut units = Vec::new();
        // SAFETY: plain messages to an owned transform.
        unsafe {
            self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0).map_err(|e| failed("ProcessMessage", &e))?;
            self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0).map_err(|e| failed("ProcessMessage", &e))?;
        }
        if self.events.is_some() {
            let started = Instant::now();
            let drained = loop {
                match self.next_event(started, true)? {
                    Some(kind) if kind == METransformHaveOutput.0 as u32 => self.drain_one(&mut units)?,
                    Some(kind) if kind == METransformDrainComplete.0 as u32 => break true,
                    Some(_) => {}
                    None => break false,
                }
            };
            if !drained {
                return Err(Error::Timeout);
            }
        } else {
            self.drain(&mut units)?;
        }
        // SAFETY: a plain message to an owned transform.
        let _ = unsafe { self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0) };
        Ok(units)
    }

    /// Gives a synchronous transform `sample`, or an asynchronous one that asked for it.
    fn input(&self, sample: &IMFSample) -> Result<()> {
        // SAFETY: an owned sample, borrowed for the call.
        unsafe { self.mft.ProcessInput(self.input, sample, 0) }.map_err(|e| failed("ProcessInput", &e))
    }

    /// Handles the asynchronous transform's next event, waiting for it when `wait`: an input wanted is
    /// counted, an output ready is taken into `units`. Whether there was one.
    fn event(&mut self, started: Instant, wait: bool, units: &mut Vec<Unit>) -> Result<bool> {
        match self.next_event(started, wait)? {
            Some(kind) if kind == METransformNeedInput.0 as u32 => self.wanted += 1,
            Some(kind) if kind == METransformHaveOutput.0 as u32 => self.drain_one(units)?,
            Some(_) => {}
            None if wait => return Err(Error::Timeout),
            None => return Ok(false),
        }
        Ok(true)
    }

    /// The type of the asynchronous transform's next event; `None` when it has none, having waited
    /// up to the stall when `wait`.
    fn next_event(&self, started: Instant, wait: bool) -> Result<Option<u32>> {
        let events = self.events.as_ref().expect("an asynchronous transform");
        loop {
            // SAFETY: owned COM handles.
            match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => return unsafe { event.GetType() }.map(Some).map_err(|e| failed("GetType", &e)),
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    if !wait || started.elapsed() >= STALL {
                        return Ok(None);
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(e) => return Err(failed("GetEvent", &e)),
            }
        }
    }

    /// Takes every output a synchronous transform has ready into `units`.
    fn drain(&mut self, units: &mut Vec<Unit>) -> Result<()> {
        while self.output(units)? {}
        Ok(())
    }

    /// Takes the output an asynchronous transform said it has.
    fn drain_one(&mut self, units: &mut Vec<Unit>) -> Result<()> {
        self.output(units).map(|_| ())
    }

    /// Takes one output into `units`: whether there was one, rather than a want of input.
    fn output(&mut self, units: &mut Vec<Unit>) -> Result<bool> {
        for _ in 0..4 {
            let sample = if self.provides { None } else { Some(empty(self.output_size)?) };
            let mut buffer = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: self.output,
                pSample: ManuallyDrop::new(sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            };
            let mut status = 0;
            // SAFETY: the buffer's sample and events are taken back below, whatever the result.
            let result = unsafe { self.mft.ProcessOutput(0, std::slice::from_mut(&mut buffer), &raw mut status) };
            let sample = unsafe { ManuallyDrop::take(&mut buffer.pSample) };
            drop(unsafe { ManuallyDrop::take(&mut buffer.pEvents) });
            match result {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(false),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    // SAFETY: owned COM handles.
                    unsafe {
                        let changed = self
                            .mft
                            .GetOutputAvailableType(self.output, 0)
                            .map_err(|e| failed("GetOutputAvailableType", &e))?;
                        self.mft.SetOutputType(self.output, &changed, 0).map_err(|e| failed("SetOutputType", &e))?;
                        self.output_info()?;
                    }
                    // An asynchronous transform says when the output is ready in its new type.
                    if self.events.is_some() {
                        return Ok(true);
                    }
                    continue;
                }
                Err(e) => return Err(failed("ProcessOutput", &e)),
            }
            let Some(sample) = sample else { return Err(Error::Load("the encoder gave no sample".into())) };
            let bytes = bytes(&sample)?;
            let types: Vec<u8> = nals(&bytes).map(|nal| nal[0] & 0x1f).collect();
            if !types.iter().any(|t| (1..=5).contains(t)) {
                // Parameter sets alone: they lead the next picture.
                self.prefix.extend_from_slice(&bytes);
                return Ok(true);
            }
            let key = types.contains(&5);
            let mut annex_b = std::mem::take(&mut self.prefix);
            if key && !types.contains(&7) && !annex_b.windows(4).any(|w| w == [0, 0, 1, 0x67]) {
                annex_b.extend_from_slice(&self.header);
            }
            annex_b.extend_from_slice(&bytes);
            let time = self.times.pop_front().ok_or_else(|| Error::Load("the encoder gave more than given".into()))?;
            units.push(Unit { time, key, annex_b });
            return Ok(true);
        }
        Err(Error::Load("the encoder kept changing its output".into()))
    }

    /// A sample of NV12 `bytes` showing at `time` ticks for a frame's duration.
    fn sample(&self, bytes: &[u8], time: u64) -> Result<IMFSample> {
        let length = u32::try_from(bytes.len()).map_err(|_| Error::invalid("the picture is too large to encode"))?;
        let sample = empty(length)?;
        // SAFETY: the buffer holds `length` bytes; the mapped slice never outlives its lock.
        unsafe {
            let buffer = sample.GetBufferByIndex(0).map_err(|e| failed("GetBufferByIndex", &e))?;
            let mut address = std::ptr::null_mut();
            buffer.Lock(&raw mut address, None, None).map_err(|e| failed("Lock", &e))?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), address, bytes.len());
            buffer.Unlock().map_err(|e| failed("Unlock", &e))?;
            buffer.SetCurrentLength(length).map_err(|e| failed("SetCurrentLength", &e))?;
            let hns = |ticks: u64| (u128::from(ticks) * u128::from(HNS) / u128::from(TIMESCALE)) as i64;
            sample.SetSampleTime(hns(time)).map_err(|e| failed("SetSampleTime", &e))?;
            let frame = (HNS as f64 / self.encoding.fps).round() as i64;
            sample.SetSampleDuration(frame).map_err(|e| failed("SetSampleDuration", &e))?;
        }
        Ok(sample)
    }
}

/// A sample with one empty buffer of `length` bytes.
fn empty(length: u32) -> Result<IMFSample> {
    // SAFETY: owned COM handles.
    unsafe {
        let buffer = MFCreateMemoryBuffer(length).map_err(|e| failed("MFCreateMemoryBuffer", &e))?;
        let sample = MFCreateSample().map_err(|e| failed("MFCreateSample", &e))?;
        sample.AddBuffer(&buffer).map_err(|e| failed("AddBuffer", &e))?;
        Ok(sample)
    }
}

impl Drop for Transform {
    fn drop(&mut self) {
        // SAFETY: an asynchronous transform is shut down through what activated it, once.
        let _ = unsafe { self.activate.ShutdownObject() };
    }
}

/// The transforms encoding NV12 into H.264 of `kind`, the best first.
fn activates(kind: MFT_ENUM_FLAG) -> Result<Vec<IMFActivate>> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0_u32;
    // SAFETY: Media Foundation allocates the list; each item is taken from it, then it is freed.
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            kind,
            Some(&raw const input),
            Some(&raw const output),
            &raw mut list,
            &raw mut count,
        )
        .map_err(|e| failed("MFTEnumEx", &e))?;
        if list.is_null() {
            return Ok(Vec::new());
        }
        let items = std::slice::from_raw_parts_mut(list, count as usize);
        let activates = items.iter_mut().filter_map(Option::take).collect();
        CoTaskMemFree(Some(list.cast_const().cast()));
        Ok(activates)
    }
}

/// Sets what a picture is on `kind`: its size and rate, progressive, square pixels, BT.709 limited.
fn picture(kind: &IMFMediaType, width: u32, height: u32, num: u32, den: u32) -> Result<()> {
    // SAFETY: owned COM handles, values borrowed for each call.
    unsafe {
        kind.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(width) << 32) | u64::from(height))
            .map_err(|e| failed("SetUINT64", &e))?;
        kind.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(num) << 32) | u64::from(den))
            .map_err(|e| failed("SetUINT64", &e))?;
        kind.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|e| failed("SetUINT32", &e))?;
        kind.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1_u64 << 32) | 1).map_err(|e| failed("SetUINT64", &e))?;
        let _ = kind.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32);
        let _ = kind.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32);
        let _ = kind.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32);
        let _ = kind.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
    }
    Ok(())
}

/// The SPS and PPS the transform's output type carries, Annex B; none where it carries them in band.
fn header(mft: &IMFTransform, output: u32) -> Vec<u8> {
    // SAFETY: owned COM handles; the blob is copied into a buffer of its size.
    unsafe {
        let Ok(kind) = mft.GetOutputCurrentType(output) else { return Vec::new() };
        let Ok(size) = kind.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) else { return Vec::new() };
        let mut blob = vec![0; size as usize];
        if kind.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None).is_err() || !blob.starts_with(&[0, 0]) {
            return Vec::new();
        }
        blob
    }
}

/// The bytes of `sample`'s buffers, in order.
fn bytes(sample: &IMFSample) -> Result<Vec<u8>> {
    // SAFETY: the mapped bytes are copied out before the buffer unlocks.
    unsafe {
        let buffer = sample.ConvertToContiguousBuffer().map_err(|e| failed("ConvertToContiguousBuffer", &e))?;
        let (mut address, mut length) = (std::ptr::null_mut(), 0_u32);
        buffer.Lock(&raw mut address, None, Some(&raw mut length)).map_err(|e| failed("Lock", &e))?;
        let bytes = std::slice::from_raw_parts(address, length as usize).to_vec();
        buffer.Unlock().map_err(|e| failed("Unlock", &e))?;
        Ok(bytes)
    }
}

/// `fps` as a ratio of whole numbers: 30000/1001 for 29.97, 60/1 for 60.
fn rational(fps: f64) -> (u32, u32) {
    for den in [1_u32, 1001, 1000] {
        let num = (fps * f64::from(den)).round();
        if (num / f64::from(den) - fps).abs() < 1e-6 * fps {
            return (num as u32, den);
        }
    }
    ((fps * 1000.0).round() as u32, 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A gray NV12 picture of `size` with a light square that moves with `frame`.
    fn picture_of(size: [u32; 2], frame: u32) -> Vec<u8> {
        let [w, h] = size;
        let mut nv12 = vec![128; (w * h * 3 / 2) as usize];
        for y in 0..h {
            for x in 0..w {
                let inside = (x + w - frame * 2 % w) % w < 16 && (8..24).contains(&y);
                nv12[(y * w + x) as usize] = if inside { 220 } else { 60 };
            }
        }
        nv12
    }

    fn encodes_a_short_video(kinds: &[MFT_ENUM_FLAG]) {
        let encoding = Encoding::new([64, 64], 30.0);
        let mut encoder = match open(encoding, kinds) {
            Ok(encoder) => encoder,
            Err(Error::Unsupported(reason)) => return eprintln!("skipping: {reason}"),
            Err(error) => panic!("{error}"),
        };
        let mut units = Vec::new();
        for i in 0..12_u32 {
            let time = u64::from(i) * 3000;
            units.extend(pollster::block_on(encoder.encode(&picture_of(encoding.size, i), time, i % 6 == 0)).unwrap());
        }
        units.extend(pollster::block_on(encoder.finish()).unwrap());
        assert_eq!(units.len(), 12, "a unit for every picture");
        assert_eq!(units.iter().map(|u| u.time).collect::<Vec<_>>(), (0..12).map(|i| i * 3000).collect::<Vec<_>>());
        assert!(units[0].key, "the first is a keyframe");
        let first: Vec<u8> = nals(&units[0].annex_b).map(|nal| nal[0] & 0x1f).collect();
        assert!(first.contains(&7) && first.contains(&8), "the first keyframe carries its parameter sets: {first:?}");
        assert!(units[6].key, "a keyframe where asked");
    }

    #[test]
    fn the_software_encoder_gives_a_unit_a_picture() {
        encodes_a_short_video(&[software()]);
    }

    #[test]
    fn the_hardware_encoder_gives_a_unit_a_picture() {
        encodes_a_short_video(&[hardware()]);
    }

    #[test]
    fn frame_rates_are_ratios() {
        assert_eq!(rational(60.0), (60, 1));
        assert_eq!(rational(30_000.0 / 1001.0), (30_000, 1001));
        assert_eq!(rational(12.5), (12_500, 1000));
    }
}
