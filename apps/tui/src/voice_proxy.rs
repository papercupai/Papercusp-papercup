//! PUI-side audio API. Device libraries are isolated in the sibling pui-audio.
#![allow(dead_code)]

#[path = "voice_dsp.rs"]
mod dsp;
pub use dsp::*;

use crate::audio_proto::{self, CaptureInfo, Frame, PlaybackState};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default, Clone)]
struct Signals {
    playing: Option<Arc<AtomicBool>>,
    error: Option<Arc<Mutex<Option<String>>>>,
}

impl Signals {
    fn state(&self, state: PlaybackState) {
        if let Some(playing) = &self.playing {
            playing.store(state.playing, Ordering::Relaxed);
        }
        if let Some(error) = &self.error {
            if let Ok(mut slot) = error.lock() {
                *slot = state.error;
            }
        }
    }
    fn fail(&self, error: String) {
        self.state(PlaybackState {
            playing: false,
            error: Some(error),
        });
    }
}

struct HelperPipe {
    input: Option<ChildStdin>,
    child: Arc<Mutex<Child>>,
    frames: Receiver<Result<Frame, String>>,
}

impl HelperPipe {
    fn send(&mut self, kind: u8, payload: &[u8]) -> Result<()> {
        audio_proto::write_frame(
            self.input.as_mut().context("pui-audio has stopped")?,
            kind,
            payload,
        )
        .context("write to pui-audio")
    }
    fn close(&mut self) {
        self.input.take();
    }
    fn recv(&self, timeout: Duration) -> Result<Option<Frame>> {
        match self.frames.recv_timeout(timeout) {
            Ok(Ok(frame)) if frame.kind == audio_proto::ERROR => {
                Err(anyhow!(String::from_utf8_lossy(&frame.payload).into_owned()))
            }
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(error)) => Err(anyhow!(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => bail!("pui-audio stopped"),
        }
    }
    fn ready(&self) -> Result<Frame> {
        let frame = self
            .recv(Duration::from_secs(5))?
            .context("pui-audio did not become ready")?;
        if frame.kind != audio_proto::READY {
            bail!("pui-audio sent {} before READY", frame.kind);
        }
        Ok(frame)
    }
}

impl Drop for HelperPipe {
    fn drop(&mut self) {
        self.close();
        // This exact Child belongs to this pipe. Never leave a device or a
        // blocked reader alive after cancellation, timeout or protocol failure.
        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

fn helper_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("PUI_AUDIO_HELPER").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe().context("resolve pui executable")?;
    let mut dir = exe.parent().context("pui has no parent directory")?;
    if dir.file_name().is_some_and(|n| n == "deps") {
        dir = dir.parent().context("Cargo deps has no parent")?;
    }
    Ok(dir.join(format!("pui-audio{}", std::env::consts::EXE_SUFFIX)))
}

fn helper_failure(path: &Path, code: Option<i32>, stderr: &str) -> String {
    if code == Some(127) || stderr.contains("libasound.so") {
        return "voice is unavailable because the ALSA sound library is missing; install libasound2 (Debian/Ubuntu: sudo apt install libasound2t64), then retry".into();
    }
    format!(
        "pui-audio at {} exited with status {:?}: {}",
        path.display(),
        code,
        stderr.trim()
    )
}

fn spawn_helper_at(path: &Path, command: &str, signals: Signals) -> Result<HelperPipe> {
    // ETXTBSY-tolerant: a just-installed helper can be briefly held busy by a
    // concurrent fork; that is a race, not a broken install.
    let mut child = crate::fresh_exec::spawn(
        Command::new(path)
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .with_context(|| {
        format!(
            "voice is unavailable: pui-audio could not start at {}; reinstall PUI",
            path.display()
        )
    })?;
    let input = child.stdin.take();
    let mut output = child.stdout.take().context("helper stdout missing")?;
    let mut stderr = child.stderr.take().context("helper stderr missing")?;
    let child = Arc::new(Mutex::new(child));
    let reader_child = child.clone();
    let stderr_tail = Arc::new(Mutex::new(Vec::new()));
    let tail_writer = stderr_tail.clone();
    std::thread::spawn(move || {
        let mut buffer = [0; 2048];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if let Ok(mut tail) = tail_writer.lock() {
                tail.extend_from_slice(&buffer[..count]);
                let excess = tail.len().saturating_sub(8192);
                tail.drain(..excess);
            }
        }
    });
    let (tx, frames) = mpsc::sync_channel(16);
    let path = path.to_path_buf();
    std::thread::Builder::new()
        .name("pui-audio-reader".into())
        .spawn(move || {
            loop {
                match audio_proto::read_frame(&mut output) {
                    Ok(Some(frame)) if frame.kind == audio_proto::STATE => {
                        match serde_json::from_slice::<PlaybackState>(&frame.payload) {
                            Ok(state) => signals.state(state),
                            Err(error) => {
                                signals.fail(format!("invalid audio state: {error}"));
                                break;
                            }
                        }
                    }
                    Ok(Some(frame))
                        if frame.kind == audio_proto::ERROR && signals.playing.is_some() =>
                    {
                        // Startup errors must also reach ready(); subsequent errors
                        // are rare terminal protocol failures, never a polling stream.
                        signals.fail(String::from_utf8_lossy(&frame.payload).into_owned());
                        if tx.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(Some(frame)) => {
                        if tx.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = tx.send(Err(format!("read pui-audio: {error}")));
                        break;
                    }
                }
            }
            // Do not hold the Child mutex while waiting: Drop must be able to
            // terminate a helper that closes stdout and then hangs.
            let deadline = Instant::now() + Duration::from_secs(2);
            let status = loop {
                let status = reader_child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten());
                if status.is_some() {
                    break status;
                }
                if Instant::now() >= deadline {
                    if let Ok(mut c) = reader_child.lock() {
                        let _ = c.kill();
                        break c.wait().ok();
                    }
                    break None;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            let stderr = stderr_tail
                .lock()
                .map(|s| String::from_utf8_lossy(&s).into_owned())
                .unwrap_or_default();
            if status.as_ref().is_none_or(|s| !s.success()) {
                let message = helper_failure(&path, status.and_then(|s| s.code()), &stderr);
                signals.fail(message.clone());
                let _ = tx.send(Err(message));
            } else if let Some(playing) = &signals.playing {
                playing.store(false, Ordering::Relaxed);
            }
        })
        .context("spawn audio reader")?;
    Ok(HelperPipe {
        input,
        child,
        frames,
    })
}

struct RawCapture {
    pipe: HelperPipe,
    info: CaptureInfo,
}
impl RawCapture {
    fn open(path: &Path) -> Result<Self> {
        let pipe = spawn_helper_at(path, "capture", Signals::default())?;
        let info: CaptureInfo = serde_json::from_slice(&pipe.ready()?.payload)?;
        if info.rate == 0 || info.channels == 0 {
            bail!("invalid audio capture format");
        }
        Ok(Self { pipe, info })
    }
    fn decode(&self, frame: Frame) -> Result<Vec<f32>> {
        if frame.kind != audio_proto::RAW
            || !frame
                .payload
                .len()
                .is_multiple_of(4 * self.info.channels as usize)
        {
            bail!("invalid raw audio frame");
        }
        let samples: Vec<f32> = frame
            .payload
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        if samples.iter().any(|v| !v.is_finite()) {
            bail!("non-finite audio sample");
        }
        Ok(samples)
    }
}

#[derive(Debug)]
pub struct CaptureResult {
    pub wav: Vec<u8>,
    pub seconds: f32,
    pub src_rate: u32,
    pub device: String,
}
enum CaptureCmd {
    Finish,
    Cancel,
}
pub struct CaptureSession {
    commands: Sender<CaptureCmd>,
    result: Receiver<Result<CaptureResult>>,
    level: Arc<AtomicU32>,
    started: Instant,
}
impl CaptureSession {
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    pub fn finish(self) -> Result<CaptureResult> {
        self.commands
            .send(CaptureCmd::Finish)
            .context("capture stopped")?;
        self.result
            .recv_timeout(Duration::from_secs(10))
            .context("capture did not finish")?
    }
    pub fn cancel(self) {
        let _ = self.commands.send(CaptureCmd::Cancel);
    }
}
pub fn start_capture() -> Result<CaptureSession> {
    start_capture_at(&helper_path()?)
}
fn start_capture_at(path: &Path) -> Result<CaptureSession> {
    let mut capture = RawCapture::open(path)?;
    let (commands, command_rx) = mpsc::channel();
    let (done, result) = mpsc::channel();
    let level = Arc::new(AtomicU32::new(0));
    let meter = level.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<CaptureResult> {
            let mut samples = Vec::new();
            let mut finish_deadline = None;
            loop {
                match command_rx.try_recv() {
                    Ok(CaptureCmd::Finish) => {
                        capture.pipe.close();
                        finish_deadline = Some(Instant::now() + Duration::from_secs(2));
                    }
                    Ok(CaptureCmd::Cancel) | Err(mpsc::TryRecvError::Disconnected) => {
                        bail!("recording cancelled")
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                match capture.pipe.frames.recv_timeout(Duration::from_millis(20)) {
                    Ok(Ok(frame)) => {
                        if frame.kind == audio_proto::ERROR {
                            bail!("{}", String::from_utf8_lossy(&frame.payload));
                        }
                        let chunk = capture.decode(frame)?;
                        meter.store(rms(&chunk).to_bits(), Ordering::Relaxed);
                        samples.extend(chunk);
                    }
                    Ok(Err(error)) => bail!("{error}"),
                    Err(mpsc::RecvTimeoutError::Disconnected) if finish_deadline.is_some() => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        bail!("capture stopped before recording finished")
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if finish_deadline.is_some_and(|end| Instant::now() >= end) {
                    bail!("pui-audio did not stop capture");
                }
            }
            let info = &capture.info;
            Ok(CaptureResult {
                seconds: samples.len() as f32 / info.channels as f32 / info.rate as f32,
                src_rate: info.rate,
                device: info.device.clone(),
                wav: encode_wav_pcm16(
                    &resample_to_16k(&mix_to_mono(&samples, info.channels), info.rate),
                    WHISPER_RATE,
                ),
            })
        })();
        let _ = done.send(result);
    });
    Ok(CaptureSession {
        commands,
        result,
        level,
        started: Instant::now(),
    })
}

pub struct StreamCapture {
    stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    chunks: Option<Receiver<Vec<u8>>>,
}
impl StreamCapture {
    pub fn take_chunks(&mut self) -> Option<Receiver<Vec<u8>>> {
        self.chunks.take()
    }
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
impl Drop for StreamCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn start_raw_stream(
    consume: impl FnMut(&[f32], u16, u32) -> Result<()> + Send + 'static,
) -> Result<StreamCapture> {
    start_raw_stream_at(&helper_path()?, consume)
}

fn start_raw_stream_at(
    path: &Path,
    mut consume: impl FnMut(&[f32], u16, u32) -> Result<()> + Send + 'static,
) -> Result<StreamCapture> {
    let capture = RawCapture::open(path)?;
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let level = Arc::new(AtomicU32::new(0));
    let meter = level.clone();
    std::thread::spawn(move || {
        while !signal.load(Ordering::Relaxed) {
            match capture.pipe.recv(Duration::from_millis(20)) {
                Ok(Some(frame)) => match capture.decode(frame) {
                    Ok(raw) => {
                        meter.store(rms(&raw).to_bits(), Ordering::Relaxed);
                        if consume(&raw, capture.info.channels, capture.info.rate).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    Ok(StreamCapture {
        stop,
        level,
        chunks: None,
    })
}

pub fn start_stream_capture(chunk_ms: u32) -> Result<StreamCapture> {
    let (tx, rx) = mpsc::channel();
    let mut pending = Vec::new();
    let mut capture = start_raw_stream(move |raw, channels, rate| {
        pending.extend_from_slice(raw);
        let count = ((u64::from(rate) * u64::from(chunk_ms.max(50)) / 1000) as usize).max(1)
            * channels as usize;
        while pending.len() >= count {
            let bytes = f32_chunk_to_pcm16le(&pending[..count], channels, rate);
            pending.drain(..count);
            tx.send(bytes).context("voice stream consumer stopped")?;
        }
        Ok(())
    })?;
    capture.chunks = Some(rx);
    Ok(capture)
}

enum PlayerCmd {
    Encoded(Vec<u8>, bool),
    Pcm(Vec<i16>, u32, bool),
    Stop,
}
#[derive(Clone)]
pub struct Player {
    commands: Sender<PlayerCmd>,
    playing: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}
impl Player {
    pub fn spawn() -> Self {
        Self::spawn_with(None)
    }
    pub fn spawn_ready() -> Result<Self> {
        let signals = Signals {
            playing: Some(Arc::new(AtomicBool::new(false))),
            error: Some(Arc::new(Mutex::new(None))),
        };
        let helper = spawn_helper_at(&helper_path()?, "play", signals.clone())?;
        helper.ready()?;
        Ok(Self::spawn_with(Some((helper, signals))))
    }
    fn spawn_with(initial: Option<(HelperPipe, Signals)>) -> Self {
        let signals = initial
            .as_ref()
            .map(|(_, s)| s.clone())
            .unwrap_or_else(|| Signals {
                playing: Some(Arc::new(AtomicBool::new(false))),
                error: Some(Arc::new(Mutex::new(None))),
            });
        let playing = signals.playing.clone().unwrap();
        let error = signals.error.clone().unwrap();
        let (commands, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut helper = initial.map(|(pipe, _)| pipe);
            while let Ok(command) = rx.recv() {
                if helper.is_none() {
                    if matches!(command, PlayerCmd::Stop) {
                        continue;
                    }
                    match helper_path()
                        .and_then(|p| spawn_helper_at(&p, "play", signals.clone()))
                        .and_then(|pipe| {
                            pipe.ready()?;
                            Ok(pipe)
                        }) {
                        Ok(pipe) => helper = Some(pipe),
                        Err(error) => {
                            signals.fail(format!("{error:#}"));
                            continue;
                        }
                    }
                }
                let (kind, payload) = match command {
                    PlayerCmd::Encoded(bytes, replace) => (
                        if replace {
                            audio_proto::PLAY_REPLACE
                        } else {
                            audio_proto::PLAY_APPEND_ENCODED
                        },
                        bytes,
                    ),
                    PlayerCmd::Pcm(samples, rate, realtime) => {
                        let mut bytes = rate.to_le_bytes().to_vec();
                        bytes.extend(samples.into_iter().flat_map(i16::to_le_bytes));
                        (
                            if realtime {
                                audio_proto::PLAY_REALTIME_PCM
                            } else {
                                audio_proto::PLAY_APPEND_PCM
                            },
                            bytes,
                        )
                    }
                    PlayerCmd::Stop => (audio_proto::PLAY_STOP, Vec::new()),
                };
                if let Err(error) = helper.as_mut().unwrap().send(kind, &payload) {
                    signals.fail(format!("{error:#}"));
                    helper = None;
                }
            }
        });
        Self {
            commands,
            playing,
            error,
        }
    }
    pub fn play(&self, bytes: Vec<u8>) {
        let _ = self.commands.send(PlayerCmd::Encoded(bytes, true));
    }
    pub fn append_encoded(&self, bytes: Vec<u8>) {
        let _ = self.commands.send(PlayerCmd::Encoded(bytes, false));
    }
    pub fn append_pcm(&self, samples: Vec<i16>, rate: u32) {
        let _ = self.commands.send(PlayerCmd::Pcm(samples, rate, false));
    }
    pub fn append_realtime_pcm(&self, samples: Vec<i16>, rate: u32) {
        let _ = self.commands.send(PlayerCmd::Pcm(samples, rate, true));
    }
    pub fn stop(&self) {
        let _ = self.commands.send(PlayerCmd::Stop);
    }
    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
    pub fn last_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|s| s.clone())
    }
}
#[derive(Deserialize)]
struct Devices {
    inputs: Vec<String>,
    outputs: Vec<String>,
}
pub fn list_devices() -> (Vec<String>, Vec<String>) {
    let read = || -> Result<Devices> {
        let pipe = spawn_helper_at(&helper_path()?, "devices", Signals::default())?;
        let frame = pipe
            .recv(Duration::from_secs(5))?
            .context("device enumeration timed out")?;
        if frame.kind != audio_proto::DEVICES {
            bail!("unexpected device list response");
        }
        Ok(serde_json::from_slice(&frame.payload)?)
    };
    match read() {
        Ok(d) => (d.inputs, d.outputs),
        Err(e) => {
            eprintln!("voice devices unavailable: {e:#}");
            (Vec::new(), Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_wav(bytes: &[u8]) -> (hound::WavSpec, Vec<i16>) {
        let mut r = hound::WavReader::new(std::io::Cursor::new(bytes)).expect("wav reader");
        let spec = r.spec();
        let samples = r.samples::<i16>().map(|s| s.unwrap()).collect();
        (spec, samples)
    }

    /// Dominant frequency estimate by zero-crossing count.
    fn zero_cross_freq(samples: &[f32], rate: u32) -> f32 {
        if samples.len() < 2 {
            return 0.0;
        }
        let crossings = samples
            .windows(2)
            .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
            .count();
        crossings as f32 / 2.0 / (samples.len() as f32 / rate as f32)
    }

    #[test]
    fn mono_mix_averages_channels() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(mix_to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
        // 1ch passes through.
        assert_eq!(mix_to_mono(&[0.25, -0.25], 1), vec![0.25, -0.25]);
    }

    #[test]
    fn resample_48k_to_16k_decimates_by_3() {
        let tone = sine(440.0, 1.0, 48_000, 0.8);
        let out = resample_to_16k(&tone, 48_000);
        assert_eq!(out.len(), 16_000);
        // The tone survives decimation at the right pitch.
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 440.0).abs() < 10.0, "expected ~440Hz, got {f}");
    }

    #[test]
    fn resample_44k1_to_16k_linear_interp() {
        let tone = sine(440.0, 1.0, 44_100, 0.8);
        let out = resample_to_16k(&tone, 44_100);
        let expected = 16_000;
        assert!(
            (out.len() as i64 - expected).unsigned_abs() <= 2,
            "len {} !~ {expected}",
            out.len()
        );
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 440.0).abs() < 10.0, "expected ~440Hz, got {f}");
    }

    #[test]
    fn resample_8k_upsamples() {
        let tone = sine(300.0, 0.5, 8_000, 0.8);
        let out = resample_to_16k(&tone, 8_000);
        assert!((out.len() as i64 - 8_000).unsigned_abs() <= 2);
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 300.0).abs() < 10.0, "expected ~300Hz, got {f}");
    }

    #[test]
    fn resample_16k_is_identity_and_empty_is_safe() {
        let tone = sine(440.0, 0.1, 16_000, 0.5);
        assert_eq!(resample_to_16k(&tone, 16_000), tone);
        assert!(resample_to_16k(&[], 48_000).is_empty());
        assert!(resample_to_16k(&[0.1], 0).is_empty());
    }

    #[test]
    fn wav_encode_roundtrips_pcm16_mono_16k() {
        let tone = sine(440.0, 0.25, WHISPER_RATE, 0.5);
        let wav = encode_wav_pcm16(&tone, WHISPER_RATE);
        let (spec, samples) = decode_wav(&wav);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, WHISPER_RATE);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(samples.len(), tone.len());
        // Amplitude survives the f32→i16 quantization.
        let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!((peak as f32 / 32767.0 - 0.5).abs() < 0.01);
    }

    #[test]
    fn wav_encode_clamps_overdrive() {
        let wav = encode_wav_pcm16(&[2.0, -2.0], WHISPER_RATE);
        let (_, samples) = decode_wav(&wav);
        assert_eq!(samples, vec![32767, -32767]);
    }

    #[test]
    fn rms_basics() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    // ── hardware smokes (#[ignore] — need an explicit PUI_LIVE_AUDIO=1 opt-in
    // and a real audio stack; run via the isolated null-sink loopback script
    // below). The opt-in is deliberate: `cargo test -- --ignored` is also used
    // for the operator/IPC smokes and must stay green on headless boxes. ──

    fn audio_smoke_opted_in(name: &str) -> bool {
        let enabled = std::env::var("PUI_LIVE_AUDIO")
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);
        if !enabled {
            eprintln!(
                "SKIP {name}: audio hardware smoke is opt-in; \
                 set PUI_LIVE_AUDIO=1 (the audio-loopback-smoke.sh wrapper does this)"
            );
        }
        enabled
    }

    fn capture_for_audio_smoke(name: &str) -> Option<CaptureSession> {
        if !audio_smoke_opted_in(name) {
            return None;
        }
        match start_capture() {
            Ok(session) => Some(session),
            Err(err) => {
                eprintln!("SKIP {name}: no usable audio capture device/backend ({err:#})");
                None
            }
        }
    }

    /// Capture ~1.5s from the default (or PUI_VOICE_INPUT) device and verify
    /// the pipeline yields a sane 16k mono WAV.
    #[test]
    #[ignore]
    fn smoke_record_yields_16k_wav() {
        let Some(session) = capture_for_audio_smoke("smoke_record_yields_16k_wav") else {
            return;
        };
        std::thread::sleep(Duration::from_millis(1500));
        let res = session.finish().expect("finish capture");
        eprintln!(
            "captured {:.2}s at {} Hz from {} → {} wav bytes",
            res.seconds,
            res.src_rate,
            res.device,
            res.wav.len()
        );
        let (spec, samples) = decode_wav(&res.wav);
        assert_eq!(spec.sample_rate, WHISPER_RATE);
        assert_eq!(spec.channels, 1);
        if samples.is_empty() {
            eprintln!("SKIP smoke_record_yields_16k_wav: capture device returned no samples");
            return;
        }
        // ~1.5s of 16k audio, generous margin for stream startup latency.
        assert!(
            samples.len() > WHISPER_RATE as usize, // > 1.0s
            "too few samples: {}",
            samples.len()
        );
    }

    /// Play a 440Hz tone through the default (or PUI_VOICE_OUTPUT) device and
    /// verify the playing flag transitions.
    #[test]
    #[ignore]
    fn smoke_play_tone() {
        if !audio_smoke_opted_in("smoke_play_tone") {
            return;
        }
        let tone = sine(440.0, 0.8, WHISPER_RATE, 0.4);
        let wav = encode_wav_pcm16(&tone, WHISPER_RATE);
        let ready_at = Instant::now();
        let player = Player::spawn_ready().expect("open playback helper and output device");
        eprintln!("playback device READY after {:?}", ready_at.elapsed());
        player.play(wav);
        let playing_deadline = Instant::now() + Duration::from_secs(2);
        while !player.is_playing()
            && player.last_error().is_none()
            && Instant::now() < playing_deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Some(err) = player.last_error() {
            panic!("playback failed after device readiness: {err}");
        }
        assert!(
            player.is_playing(),
            "player never started: {:?}",
            player.last_error()
        );
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!player.is_playing(), "player never finished");
        assert_eq!(player.last_error(), None);
    }

    /// Full loop: play a tone while recording — requires the loopback routing
    /// (play→null sink, capture→its monitor) the verification shell sets up.
    /// Asserts the captured audio contains the played tone.
    ///
    /// The tone (2.5s) is deliberately LONGER than the capture window (~1.6s) so
    /// the whole recording is steady-state tone — and we estimate the frequency
    /// over the middle 60% only, skipping the stream-startup onset. (A naive
    /// estimate over a buffer with trailing silence reads low: 440·tone/window.)
    #[test]
    #[ignore]
    fn smoke_loopback_tone_roundtrip() {
        let Some(session) = capture_for_audio_smoke("smoke_loopback_tone_roundtrip") else {
            return;
        };
        let player = Player::spawn();
        let tone = sine(440.0, 2.5, WHISPER_RATE, 0.6);
        player.play(encode_wav_pcm16(&tone, WHISPER_RATE));
        std::thread::sleep(Duration::from_millis(1600));
        if let Some(err) = player.last_error() {
            eprintln!("SKIP smoke_loopback_tone_roundtrip: no usable audio output device ({err})");
            return;
        }
        let res = session.finish().expect("finish capture");
        let (_, samples) = decode_wav(&res.wav);
        let f32s: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
        if f32s.is_empty() {
            eprintln!("SKIP smoke_loopback_tone_roundtrip: capture device returned no samples");
            return;
        }
        let level = rms(&f32s);
        assert!(level > 0.01, "loopback capture is silent (rms {level})");
        // Middle 60% — past the onset, before finish() trims, all tone.
        let lo = f32s.len() * 2 / 10;
        let hi = f32s.len() * 8 / 10;
        let mid = &f32s[lo..hi];
        let f = zero_cross_freq(mid, WHISPER_RATE);
        assert!(
            (f - 440.0).abs() < 40.0,
            "expected ~440Hz in the loopback capture, got {f}"
        );
    }

    // ── D-006 synthetic SPEECH round trip (voice-final-public-release-2026-10-01).
    // The tone loopback above proves the device path. This proves the PUI speech
    // pipeline end to end, through the same pui-audio helper the TUI uses, with
    // synthetic speech in place of a human at the microphone:
    //   Kokoro WAV → Player (null-sink) → capture (its monitor) → operator STT
    //   operator TTS reply → Player (null-sink) → capture → operator STT
    // Driven by scripts/audio-loopback-smoke.sh, which renders the Kokoro WAV and
    // routes only this process at an isolated null-sink. operator-stt and
    // operator-tts are stateless proxies (no conversation turn is written), so a
    // shared operator is a safe target. PAPERCUSP_REQUIRE_LIVE_VOICE=1 turns every
    // environmental SKIP into a failure: release acceptance must not pass by skipping.

    fn require_live_voice() -> bool {
        matches!(
            std::env::var("PAPERCUSP_REQUIRE_LIVE_VOICE")
                .ok()
                .map(|v| v.trim().to_ascii_lowercase())
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        )
    }

    fn speech_smoke_skip(name: &str, why: &str) {
        assert!(
            !require_live_voice(),
            "{name}: PAPERCUSP_REQUIRE_LIVE_VOICE=1 but {why}"
        );
        eprintln!("SKIP {name}: {why}");
    }

    fn normalize_words(text: &str) -> Vec<String> {
        text.to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .map(str::to_string)
            .collect()
    }

    fn count_heard(heard: &[String], wanted: &[String]) -> usize {
        wanted.iter().filter(|w| heard.contains(w)).count()
    }

    /// Kokoro streams WAV with placeholder 0xFFFFFFFF RIFF and data sizes, which
    /// the player's decoder rejects ("decode audio: end of stream"). The operator
    /// TTS route already rewrites them before audio reaches the TUI; the raw Kokoro
    /// fixture needs the same repair before it is played as the "microphone".
    fn with_real_wav_sizes(mut wav: Vec<u8>) -> Vec<u8> {
        if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
            return wav;
        }
        let total = wav.len();
        wav[4..8].copy_from_slice(&((total - 8) as u32).to_le_bytes());
        let mut i = 12;
        while i + 8 <= total {
            let size =
                u32::from_le_bytes([wav[i + 4], wav[i + 5], wav[i + 6], wav[i + 7]]) as usize;
            if &wav[i..i + 4] == b"data" {
                wav[i + 4..i + 8].copy_from_slice(&((total - i - 8) as u32).to_le_bytes());
                break;
            }
            i = i.saturating_add(8 + size + (size & 1));
        }
        wav
    }

    #[test]
    fn streamed_wav_placeholder_sizes_are_rewritten() {
        let mut wav = encode_wav_pcm16(&[0.1, -0.1, 0.2, -0.2], WHISPER_RATE);
        let data_at = wav.windows(4).position(|w| w == b"data").unwrap();
        wav[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        wav[data_at + 4..data_at + 8].copy_from_slice(&u32::MAX.to_le_bytes());
        let fixed = with_real_wav_sizes(wav.clone());
        assert_eq!(&fixed[4..8], &((wav.len() - 8) as u32).to_le_bytes());
        assert_eq!(
            &fixed[data_at + 4..data_at + 8],
            &((wav.len() - data_at - 8) as u32).to_le_bytes()
        );
        let (_, samples) = decode_wav(&fixed);
        assert_eq!(samples.len(), 4);
        assert_eq!(
            with_real_wav_sizes(b"ID3 not a wav".to_vec()),
            b"ID3 not a wav".to_vec()
        );
    }

    #[test]
    fn speech_word_matching_normalizes_case_and_punctuation() {
        let heard = normalize_words("The quick, brown fox — JUMPS over the lazy dog.");
        let wanted = normalize_words("the quick brown fox jumps over the lazy dog");
        assert_eq!(count_heard(&heard, &wanted), wanted.len());
        assert_eq!(count_heard(&normalize_words("lazy cat"), &wanted), 1);
    }

    /// Play `audio` through the PUI Player while the PUI capture records, and
    /// return the captured 16 kHz WAV. Waits (bounded) for playback to start and
    /// end, plus a short tail so the last word is not clipped.
    fn play_and_capture(name: &str, audio: Vec<u8>) -> Option<Vec<u8>> {
        let player = match Player::spawn_ready() {
            Ok(player) => player,
            Err(err) => {
                speech_smoke_skip(name, &format!("no usable audio output device ({err:#})"));
                return None;
            }
        };
        let session = match start_capture() {
            Ok(session) => session,
            Err(err) => {
                speech_smoke_skip(name, &format!("no usable audio capture device ({err:#})"));
                return None;
            }
        };
        player.play(audio);
        let started = std::time::Instant::now();
        while !player.is_playing() && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        while player.is_playing() && started.elapsed() < Duration::from_secs(40) {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(500));
        if let Some(err) = player.last_error() {
            session.cancel();
            speech_smoke_skip(name, &format!("playback failed ({err})"));
            return None;
        }
        Some(session.finish().expect("finish capture").wav)
    }

    #[test]
    #[ignore]
    fn smoke_speech_roundtrip_via_operator() {
        const NAME: &str = "smoke_speech_roundtrip_via_operator";
        if !audio_smoke_opted_in(NAME) {
            assert!(
                !require_live_voice(),
                "{NAME}: PAPERCUSP_REQUIRE_LIVE_VOICE=1 but PUI_LIVE_AUDIO is not set"
            );
            return;
        }
        let Some(wav_path) = std::env::var("PUI_SMOKE_SPEECH_WAV")
            .ok()
            .filter(|p| !p.trim().is_empty())
        else {
            speech_smoke_skip(
                NAME,
                "PUI_SMOKE_SPEECH_WAV (a Kokoro speech WAV) is not set",
            );
            return;
        };
        let expect = std::env::var("PUI_SMOKE_SPEECH_EXPECT")
            .unwrap_or_else(|_| "the quick brown fox jumps over the lazy dog".to_string());
        let speech = with_real_wav_sizes(
            std::fs::read(&wav_path).unwrap_or_else(|e| panic!("read {wav_path}: {e}")),
        );
        let selection = std::env::var("PUI_OPERATOR").unwrap_or_else(|_| "staging".to_string());
        let client = crate::client::OperatorClient::from_selection(&selection)
            .unwrap_or_else(|e| panic!("operator selection {selection:?}: {e:#}"));
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");

        // Leg 1 — synthetic speech at the microphone → PUI capture → operator STT.
        let Some(heard) = play_and_capture(NAME, speech) else {
            return;
        };
        let text = rt
            .block_on(client.stt_transcribe(&heard))
            .unwrap_or_else(|e| panic!("operator-stt (mic leg) via {selection}: {e:#}"));
        let wanted = normalize_words(&expect);
        let hits = count_heard(&normalize_words(&text), &wanted);
        eprintln!(
            "[{NAME}] mic leg heard {text:?} ({hits}/{} words)",
            wanted.len()
        );
        assert!(
            hits * 10 >= wanted.len() * 8,
            "mic leg: STT heard {text:?}; expected about {expect:?}"
        );

        // Leg 2 — a reply's operator TTS audio → PUI Player → loopback → STT, once
        // per engine in PUI_SMOKE_TTS_ENGINES (comma list; empty or unset = the
        // operator's voice-pref engine). Each engine has its own audio format.
        let reply = "The synthetic reply arrived safely.";
        let engines: Vec<Option<String>> = match std::env::var("PUI_SMOKE_TTS_ENGINES") {
            Ok(list) if !list.trim().is_empty() => list
                .split(',')
                .map(|e| e.trim())
                .filter(|e| !e.is_empty())
                .map(|e| Some(e.to_string()))
                .collect(),
            _ => vec![None],
        };
        for engine in engines {
            let label = engine.as_deref().unwrap_or("voice-pref engine");
            let audio = rt
                .block_on(client.tts_speak_with_engine(reply, engine.as_deref()))
                .unwrap_or_else(|e| panic!("operator-tts ({label}) via {selection}: {e:#}"));
            assert!(
                audio.len() > 1_000,
                "operator-tts ({label}) returned only {} bytes",
                audio.len()
            );
            let Some(heard_reply) = play_and_capture(NAME, audio) else {
                return;
            };
            let reply_text = rt
                .block_on(client.stt_transcribe(&heard_reply))
                .unwrap_or_else(|e| {
                    panic!("operator-stt (reply leg, {label}) via {selection}: {e:#}")
                });
            let reply_words = normalize_words(reply);
            let reply_hits = count_heard(&normalize_words(&reply_text), &reply_words);
            eprintln!(
                "[{NAME}] reply leg ({label}) heard {reply_text:?} ({reply_hits}/{} words)",
                reply_words.len()
            );
            assert!(
                reply_hits + 1 >= reply_words.len(),
                "reply leg ({label}): STT heard {reply_text:?}; expected about {reply:?}"
            );
        }
    }

    /// Operator client + runtime for the speech smokes (PUI_OPERATOR, default
    /// `staging`). The STT/TTS proxy routes they call write no conversation turn.
    fn speech_operator() -> (
        crate::client::OperatorClient,
        tokio::runtime::Runtime,
        String,
    ) {
        let selection = std::env::var("PUI_OPERATOR").unwrap_or_else(|_| "staging".to_string());
        let client = crate::client::OperatorClient::from_selection(&selection)
            .unwrap_or_else(|e| panic!("operator selection {selection:?}: {e:#}"));
        (
            client,
            tokio::runtime::Runtime::new().expect("tokio runtime"),
            selection,
        )
    }

    fn live_audio_or_return(name: &str) -> bool {
        if audio_smoke_opted_in(name) {
            return true;
        }
        assert!(
            !require_live_voice(),
            "{name}: PAPERCUSP_REQUIRE_LIVE_VOICE=1 but PUI_LIVE_AUDIO is not set"
        );
        false
    }

    /// D-006 interrupt/stop: a reply stopped partway goes quiet at once, stays
    /// quiet, and its closing sentence never reaches the speaker. The capture
    /// hears the opening, which proves the loopback was measuring.
    #[test]
    #[ignore]
    fn smoke_stop_mid_reply_silences_playback() {
        const NAME: &str = "smoke_stop_mid_reply_silences_playback";
        if !live_audio_or_return(NAME) {
            return;
        }
        let (client, rt, selection) = speech_operator();
        let reply = "Here is the first part of a long spoken reply. It keeps talking for several \
                     more seconds so that it can be stopped partway through. The closing words \
                     are purple elephants dance tonight.";
        let audio = rt
            .block_on(client.tts_speak_with_engine(reply, Some("kokoro")))
            .unwrap_or_else(|e| panic!("operator-tts (kokoro) via {selection}: {e:#}"));
        let player = match Player::spawn_ready() {
            Ok(player) => player,
            Err(err) => {
                speech_smoke_skip(NAME, &format!("no usable audio output device ({err:#})"));
                return;
            }
        };
        let session = match start_capture() {
            Ok(session) => session,
            Err(err) => {
                speech_smoke_skip(NAME, &format!("no usable audio capture device ({err:#})"));
                return;
            }
        };
        player.play(audio);
        let started = std::time::Instant::now();
        while !player.is_playing() && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(player.is_playing(), "{NAME}: playback never started");
        std::thread::sleep(Duration::from_millis(1_800));
        let stop_at = std::time::Instant::now();
        player.stop();
        while player.is_playing() && stop_at.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let stopped_after = stop_at.elapsed();
        assert!(!player.is_playing(), "{NAME}: still playing 2 s after stop");
        assert!(
            stopped_after < Duration::from_millis(500),
            "{NAME}: playback took {stopped_after:?} to stop"
        );
        // The whole reply runs about 10 s: keep listening past where it would end.
        std::thread::sleep(Duration::from_secs(9));
        assert!(!player.is_playing(), "{NAME}: playback resumed after stop");
        assert!(
            player.last_error().is_none(),
            "{NAME}: player error after stop: {:?}",
            player.last_error()
        );
        let heard_wav = session.finish().expect("finish capture").wav;
        let heard = rt
            .block_on(client.stt_transcribe(&heard_wav))
            .unwrap_or_else(|e| panic!("operator-stt via {selection}: {e:#}"));
        let words = normalize_words(&heard);
        eprintln!("[{NAME}] stopped after {stopped_after:?}; heard {heard:?}");
        let opening = normalize_words("here is the first part");
        assert!(
            count_heard(&words, &opening) >= 3,
            "{NAME}: the opening was not heard before stop ({heard:?}), so the loopback is not measuring"
        );
        let closing = normalize_words("purple elephants dance tonight");
        assert_eq!(
            count_heard(&words, &closing),
            0,
            "{NAME}: the closing sentence was heard after stop ({heard:?})"
        );
    }

    /// D-006 denial: when the capture device cannot be opened (here the audio
    /// server is unreachable), starting a capture fails at once with an error
    /// that names the audio problem, and capture works again once it is back.
    #[test]
    #[ignore]
    fn smoke_unreachable_mic_is_named_and_recovers() {
        const NAME: &str = "smoke_unreachable_mic_is_named_and_recovers";
        if !live_audio_or_return(NAME) {
            return;
        }
        // Process-wide override, inherited by the pui-audio helper. Safe only
        // under --test-threads=1, which the smoke script uses.
        let keys = ["PULSE_SERVER", "PIPEWIRE_REMOTE"];
        let previous: Vec<_> = keys.iter().map(|k| std::env::var_os(k)).collect();
        for key in keys {
            std::env::set_var(key, "unix:/nonexistent/pui-denial-smoke/native");
        }
        let started = std::time::Instant::now();
        let denied = start_capture();
        let took = started.elapsed();
        for (key, value) in keys.iter().zip(previous) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let err = match denied {
            Ok(session) => {
                session.cancel();
                panic!("{NAME}: capture opened while the audio server was unreachable");
            }
            Err(err) => format!("{err:#}"),
        };
        eprintln!("[{NAME}] refused in {took:?}: {err}");
        assert!(
            took < Duration::from_secs(10),
            "{NAME}: refusal took {took:?}"
        );
        let lowered = err.to_lowercase();
        assert!(
            ["capture", "input", "mic", "device", "audio"]
                .iter()
                .any(|word| lowered.contains(word)),
            "{NAME}: the error does not name the audio problem: {err}"
        );
        match start_capture() {
            Ok(session) => {
                std::thread::sleep(Duration::from_millis(300));
                let result = session.finish().expect("finish capture after recovery");
                assert!(
                    result.wav.len() > 44,
                    "{NAME}: recovered capture recorded nothing"
                );
            }
            Err(err) => {
                panic!("{NAME}: capture still fails after the audio server is back: {err:#}")
            }
        }
    }

    /// D-006 retry: a transcription of broken audio is reported (or comes back
    /// empty), and the next real capture transcribes normally.
    #[test]
    #[ignore]
    fn smoke_stt_failure_then_retry_transcribes() {
        const NAME: &str = "smoke_stt_failure_then_retry_transcribes";
        if !live_audio_or_return(NAME) {
            return;
        }
        let Some(wav_path) = std::env::var("PUI_SMOKE_SPEECH_WAV")
            .ok()
            .filter(|p| !p.trim().is_empty())
        else {
            speech_smoke_skip(
                NAME,
                "PUI_SMOKE_SPEECH_WAV (a Kokoro speech WAV) is not set",
            );
            return;
        };
        let expect = std::env::var("PUI_SMOKE_SPEECH_EXPECT")
            .unwrap_or_else(|_| "the quick brown fox jumps over the lazy dog".to_string());
        let speech = with_real_wav_sizes(
            std::fs::read(&wav_path).unwrap_or_else(|e| panic!("read {wav_path}: {e}")),
        );
        let (client, rt, selection) = speech_operator();
        match rt.block_on(client.stt_transcribe(b"this is not audio")) {
            Err(err) => eprintln!("[{NAME}] broken audio reported: {err:#}"),
            Ok(text) => assert!(
                text.trim().is_empty(),
                "{NAME}: broken audio was transcribed as {text:?}"
            ),
        }
        let Some(heard) = play_and_capture(NAME, speech) else {
            return;
        };
        let text = rt
            .block_on(client.stt_transcribe(&heard))
            .unwrap_or_else(|e| panic!("{NAME}: retry transcription via {selection}: {e:#}"));
        let wanted = normalize_words(&expect);
        let hits = count_heard(&normalize_words(&text), &wanted);
        eprintln!(
            "[{NAME}] retry heard {text:?} ({hits}/{} words)",
            wanted.len()
        );
        assert!(
            hits * 10 >= wanted.len() * 8,
            "{NAME}: retry heard {text:?}; expected about {expect:?}"
        );
    }
}

#[cfg(all(test, unix))]
mod helper_process_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn helper(script: &str, frames: &[(u8, Vec<u8>)]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("helper");
        let mut bytes = Vec::new();
        for (kind, payload) in frames {
            audio_proto::write_frame(&mut bytes, *kind, payload).unwrap();
        }
        std::fs::write(dir.path().join("helper.frames"), bytes).unwrap();
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, path)
    }

    fn capture_frames(samples: &[f32]) -> Vec<(u8, Vec<u8>)> {
        vec![
            (
                audio_proto::READY,
                serde_json::to_vec(&CaptureInfo {
                    device: "fixture48k".into(),
                    rate: 48_000,
                    channels: 2,
                })
                .unwrap(),
            ),
            (
                audio_proto::RAW,
                samples.iter().flat_map(|v| v.to_le_bytes()).collect(),
            ),
        ]
    }

    #[test]
    fn native_capture_frames_produce_wav_in_the_parent() {
        let raw: Vec<f32> = (0..480).flat_map(|_| [0.5, 0.25]).collect();
        let (_dir, path) = helper(
            "cat \"$0.frames\"\nwhile read -r line; do :; done",
            &capture_frames(&raw),
        );
        let capture = start_capture_at(&path).unwrap();
        let result = capture.finish().unwrap();
        let mut wav = hound::WavReader::new(std::io::Cursor::new(result.wav)).unwrap();
        assert_eq!(wav.spec().sample_rate, 16_000);
        assert_eq!(wav.spec().channels, 1);
        let samples: Vec<i16> = wav.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples.len(), 160);
        assert!(samples
            .iter()
            .all(|v| (*v as f32 / 32767.0 - 0.375).abs() < 0.001));
        assert_eq!(result.src_rate, 48_000);
        assert_eq!(result.device, "fixture48k");
        assert!((result.seconds - 0.01).abs() < 0.0001);
    }

    #[test]
    fn voice_bus_receives_native_samples_without_a_16k_intermediate() {
        let raw: Vec<f32> = sine(10_000.0, 0.01, 48_000, 0.7)
            .into_iter()
            .flat_map(|s| [s, -s])
            .collect();
        let (_dir, path) = helper(
            "cat \"$0.frames\"\nwhile read -r line; do :; done",
            &capture_frames(&raw),
        );
        let (tx, rx) = mpsc::channel();
        let capture = start_raw_stream_at(&path, move |samples, channels, rate| {
            tx.send((samples.to_vec(), channels, rate)).unwrap();
            Ok(())
        })
        .unwrap();
        let (actual, channels, rate) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!((channels, rate), (2, 48_000));
        assert_eq!(actual, raw);
        drop(capture);
    }

    #[test]
    fn helper_errors_refuse_readiness_and_missing_alsa_has_a_remedy() {
        let (_dir, path) = helper(
            "cat \"$0.frames\"\nexit 1",
            &[(audio_proto::ERROR, b"no output device".to_vec())],
        );
        let pipe = spawn_helper_at(&path, "play", Signals::default()).unwrap();
        assert!(pipe
            .ready()
            .unwrap_err()
            .to_string()
            .contains("no output device"));
        let (_dir, path) = helper("echo 'libasound.so.2 missing' >&2\nexit 127", &[]);
        let pipe = spawn_helper_at(&path, "capture", Signals::default()).unwrap();
        assert!(pipe
            .ready()
            .unwrap_err()
            .to_string()
            .contains("install libasound2"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_survives_a_helper_briefly_held_open_for_writing() {
        // Exec of a file that is open for writing fails with ETXTBSY. That is what a
        // concurrent fork inheriting the installer's write fd looks like; the spawn
        // must wait it out instead of reporting a broken install.
        let (_dir, path) = helper("while read -r line; do :; done", &[]);
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let busy = Command::new(&path).arg("capture").spawn();
        assert_eq!(busy.err().and_then(|e| e.raw_os_error()), Some(26));
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            drop(writer);
        });
        let pipe = spawn_helper_at(&path, "capture", Signals::default()).unwrap();
        release.join().unwrap();
        drop(pipe);
    }

    #[test]
    fn dropping_pipe_reaps_its_own_helper() {
        let (_dir, path) = helper("while read -r line; do :; done", &[]);
        let pipe = spawn_helper_at(&path, "capture", Signals::default()).unwrap();
        let child = pipe.child.clone();
        drop(pipe);
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn playback_state_clears_prior_errors_on_recovery() {
        let state = Signals {
            playing: Some(Arc::new(AtomicBool::new(false))),
            error: Some(Arc::new(Mutex::new(None))),
        };
        state.fail("no device".into());
        state.state(PlaybackState {
            playing: true,
            error: None,
        });
        assert!(state.playing.unwrap().load(Ordering::Relaxed));
        assert_eq!(*state.error.unwrap().lock().unwrap(), None);
    }
}
