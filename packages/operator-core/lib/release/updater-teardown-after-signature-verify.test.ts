/**
 * Guard: the desktop's sidecar teardown must happen AFTER the updater's minisign
 * verification, never as `download_and_install`'s pre-verification hook.
 *
 * security-boundary-remediation-and-usability-2026-09-04 P-007 / WI-2144851 — the
 * "verify signed updates and rollback FAILURE cases" half. The sibling file
 * `updater-signature-and-loopback-transport.test.ts` guards the CONFIGURATION that
 * makes the signature the last remaining barrier; this one guards what happens when
 * that barrier actually FIRES.
 *
 * WHAT WENT WRONG
 *
 * `install_update` and `revert_to` both called
 * `Update::download_and_install(on_chunk, on_download_finish)` and passed the
 * sidecar teardown — `shutdown_done = true` then `kill_sidecar` — as the
 * `on_download_finish` hook. The plugin calls that hook BEFORE it verifies the
 * signature (tauri-plugin-updater-2.10.1 `src/updater.rs`: `on_download_finish()`
 * then `verify_signature(..)?` two lines later, both inside `download`). So the
 * operator was torn down for an artifact nobody had authenticated yet.
 *
 * The damage is on the REJECTION path, which is the counter-intuitive part: when the
 * signature check refuses a bad artifact — the control working exactly as designed —
 * the `?` returns before `app.restart()`, leaving the app running with a killed
 * sidecar and a LATCHED `shutdown_done`. `spawn_serve_supervisor` reads that latch as
 * "normal quit / self-update — don't fight the teardown" and deliberately does not
 * respawn. Net effect: a correctly-refused update (bad signature, tampered bytes,
 * truncated download) bricks the running app until the user manually relaunches it,
 * and a failed binary swap does the same. `revert_to` inherits all of it, which is
 * the rollback failure case.
 *
 * THE INVARIANT
 *
 * Both commands delegate to `download_verify_then_install`, which splits the plugin
 * call: `download()` returns only on a verified payload, THEN the teardown runs, THEN
 * `install()`. That still satisfies EI-9002 (the bytes stream through the sidecar's
 * own /api/updates proxy, so it must survive the whole download) and WI-2667 (latch
 * before killing, so the Server supervisor does not respawn the operator mid-swap) —
 * it just stops doing the teardown on unauthenticated bytes. An `install` failure
 * clears the latch so the supervisor revives the operator.
 *
 * THE SECOND INVARIANT: ONLY `revert_to` MAY ACCEPT A DOWNGRADE
 *
 * The other half of "signed updates / rollback failure cases" is the downgrade offer.
 * `/api/updates/manifest` only compares versions for EQUALITY
 * (`latest.version === currentVersion` → 204), so a release host serving a latest.json
 * that names an OLDER version does get a 200 with a manifest. Nothing bad happens today
 * because the plugin refuses it: with no override the decision is
 * `release.version > self.current_version` (updater.rs `should_update`). So the whole
 * no-downgrade property rests on `check_for_update` / `install_update` continuing to use
 * the DEFAULT comparator.
 *
 * `revert_to` deliberately overrides it with `|_current, _release| true`, because a
 * revert IS a downgrade and the rollback route has already channel-gated the tag. The
 * two functions sit a couple of hundred lines apart with near-identical bodies, and
 * copying that one line into `install_update` would silently turn a signed-but-old
 * artifact into an accepted update — no error, no test failure, nothing in the tree
 * would notice. Hence: exactly one function may override the comparator, by name.
 *
 * All three analyses are pure functions over file text, so the deliberately-broken
 * controls below run the same code as the real-tree case — CLAUDE.md's fixture tier, no
 * mutation of the shared checkout to prove falsifiability.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MAIN_RS_PATH = path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri', 'src', 'main.rs');
const CARGO_LOCK_PATH = path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri', 'Cargo.lock');

/** The commands that must not hand raw bytes to the installer themselves. */
const INSTALLING_COMMANDS = ['install_update', 'revert_to'] as const;
/** The one place allowed to sequence download → verify → teardown → install. */
const HELPER = 'download_verify_then_install';
/** The ONLY function allowed to switch off the plugin's "must be newer" gate. */
const MAY_ACCEPT_DOWNGRADE = ['revert_to'] as const;

it('compiled install helper keeps the sidecar alive on Mac authorization refusal', () => {
  const src = readFileSync(MAIN_RS_PATH, 'utf8');
  const start = src.indexOf(`async fn ${HELPER}(`);
  const body = extractFnBody(src, HELPER)!;
  expect(body).toBeTruthy();
  const open = src.indexOf('{', start);
  // Compile the exact production helper on this host with a controlled cfg
  // selecting its Mac adapter. These mocks measure ordering, not Mac OS approval.
  const helper = src.slice(start, open + body.length)
    .replace('#[cfg(target_os = "macos")]', '#[cfg(mac_adapter)]')
    .replace('#[cfg(not(target_os = "macos"))]', '#[cfg(not(mac_adapter))]');
  const root = mkdtempSync(path.join(os.tmpdir(), 'updater-install-order-'));
  try {
    const driver = `
use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
static EVENTS:Mutex<Vec<&str>>=Mutex::new(Vec::new());
static DOWNLOAD:AtomicBool=AtomicBool::new(true);
static AUTH:AtomicBool=AtomicBool::new(true);
static INSTALL:AtomicBool=AtomicBool::new(true);
fn event(s:&'static str){EVENTS.lock().unwrap().push(s);}
struct SidecarState {shutdown_done:AtomicBool}
struct Config {identifier:String}
#[derive(Clone)] struct AppHandle {state:Arc<SidecarState>,config:Arc<Config>}
impl AppHandle {fn state(&self)->&SidecarState {&self.state} fn config(&self)->&Config {&self.config}}
mod tauri {pub type State<'a,T> = &'a T;}
fn make_download_progress_reporter(_:AppHandle) {}
fn kill_sidecar(app:&AppHandle) {assert!(app.state.shutdown_done.load(Ordering::SeqCst));event("teardown");}
mod tauri_plugin_updater {
    use super::*;
    pub fn target()->Option<String>{Some("darwin-x86_64".into())}
    pub struct Update {pub version:String,pub raw_json:&'static str}
    impl Update {
        pub async fn download(&self,_:(),_:impl FnOnce())->Result<Vec<u8>,&str>{
            event("download");if DOWNLOAD.load(Ordering::SeqCst){Ok(b"actual downloaded bytes".to_vec())}else{Err("bad download signature")}}
        pub fn install(&self,bytes:impl AsRef<[u8]>)->Result<(),&str>{
            assert_eq!(bytes.as_ref(),b"actual downloaded bytes"); event("install");
            if INSTALL.load(Ordering::SeqCst){Ok(())}else{Err("swap failed")}}
    }
}
mod update_authorization {
    use super::*;
    pub struct DownloadedUpdate<'a>{pub artifact:&'a [u8],pub manifest:&'a &'static str,
        pub version:&'a str,pub product:&'a str,pub platform:&'a str}
    pub fn activate_downloaded_macos_update<T>(d:&DownloadedUpdate<'_>,install:impl FnOnce()->Result<T,String>)->Result<T,String>{
        assert_eq!(d.artifact,b"actual downloaded bytes");assert_eq!(*d.manifest,"raw manifest authorization");
        assert_eq!(d.version,"1.2.3");assert_eq!(d.product,"com.papercusp.gui");assert_eq!(d.platform,"darwin-x86_64");
        event("authorize");if AUTH.load(Ordering::SeqCst){install()}else{Err("authorization or persistence refused".into())}}
}
${helper}
fn run<F:std::future::Future>(f:F)->F::Output {
    struct Wake;impl std::task::Wake for Wake {fn wake(self:Arc<Self>){}}
    let waker=std::task::Waker::from(Arc::new(Wake));let mut cx=std::task::Context::from_waker(&waker);
    match Box::pin(f).as_mut().poll(&mut cx){std::task::Poll::Ready(v)=>v,_=>panic!("unexpected pending mock")}
}
fn main(){
    for (download,auth,install) in [(false,true,true),(true,false,true),(true,true,false),(true,true,true)]{
        EVENTS.lock().unwrap().clear();DOWNLOAD.store(download,Ordering::SeqCst);AUTH.store(auth,Ordering::SeqCst);INSTALL.store(install,Ordering::SeqCst);
        let app=AppHandle {state:Arc::new(SidecarState {shutdown_done:AtomicBool::new(false)}),config:Arc::new(Config {identifier:"com.papercusp.gui".into()})};
        let update=tauri_plugin_updater::Update {version:"1.2.3".into(),raw_json:"raw manifest authorization"};
        let result=run(download_verify_then_install(&app,update));
        let authorized=!cfg!(mac_adapter)||auth;
        assert_eq!(result.is_ok(),download&&authorized&&install);
        let expected=if !download {vec!["download"]}else if !authorized {vec!["download","authorize"]}
            else if cfg!(mac_adapter){vec!["download","authorize","teardown","install"]}else{vec!["download","teardown","install"]};
        assert_eq!(*EVENTS.lock().unwrap(),expected);
        assert_eq!(app.state.shutdown_done.load(Ordering::SeqCst),download&&authorized&&install);
    }
    println!("compiled installer: refusal has no teardown; failed swap clears latch");
}
`;
    const source = path.join(root, 'driver.rs');
    writeFileSync(source, driver);
    for (const mac of [true, false]) {
      const binary = path.join(root, mac ? 'mac-adapter' : 'other-adapter');
      const built = spawnSync('rustc', ['--edition=2021', ...(mac ? ['--cfg', 'mac_adapter'] : []), source, '-o', binary],
        { encoding: 'utf8', timeout: 60_000 });
      expect(built.status, [built.error?.message, built.stderr, built.stdout].join('\n')).toBe(0);
      const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status, [result.error?.message, result.stderr, result.stdout].join('\n')).toBe(0);
      expect(result.stdout).toContain('compiled installer: refusal has no teardown; failed swap clears latch');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

// ── Pure analysis over main.rs ──────────────────────────────────────────────

/** Body of `async fn <name>(`, by brace matching. Null when the fn is absent. */
export function extractFnBody(src: string, name: string): string | null {
  const sig = src.indexOf(`async fn ${name}(`);
  if (sig === -1) return null;
  const open = src.indexOf('{', sig);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

export type TeardownAnalysis = {
  /** Commands that delegate to the helper instead of installing inline. */
  delegating: string[];
  /** Commands that do NOT delegate — each is a place the hazard can come back. */
  notDelegating: string[];
  /** `download_and_install` call sites whose argument text tears the sidecar down. */
  teardownInPreVerifyHook: string[];
  /** Marker order inside the helper, or null when the helper is missing. */
  helperOrder: {
    download: number;
    latch: number;
    kill: number;
    install: number;
    unlatchAfterInstall: boolean;
  } | null;
};

/**
 * `download_and_install(a, b)` argument text, for every call site. Brace/paren
 * matched rather than regexed so a multi-line closure argument is captured whole —
 * which is exactly the shape the hazard took.
 */
function downloadAndInstallArgs(src: string): string[] {
  const out: string[] = [];
  const needle = '.download_and_install(';
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    const open = at + needle.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return out;
    out.push(src.slice(open + 1, end));
    from = end + 1;
  }
}

/**
 * Every function that calls `.version_comparator(`, by the nearest enclosing
 * `async fn` — i.e. every place the plugin's "remote must be NEWER" gate is
 * switched off. Sorted + de-duplicated so the assertion reads as a set.
 */
export function versionComparatorOverrides(src: string): string[] {
  const found = new Set<string>();
  const needle = '.version_comparator(';
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    const before = src.slice(0, at);
    const fnAt = before.lastIndexOf('async fn ');
    if (fnAt === -1) {
      found.add('<top-level>');
      continue;
    }
    const name = before.slice(fnAt + 'async fn '.length).match(/^[A-Za-z0-9_]+/)?.[0];
    found.add(name ?? '<unparsed>');
  }
  return [...found].sort();
}

export function analyzeTeardown(src: string): TeardownAnalysis {
  const delegating: string[] = [];
  const notDelegating: string[] = [];
  for (const cmd of INSTALLING_COMMANDS) {
    const body = extractFnBody(src, cmd);
    // A missing command is "not delegating": it cannot be shown safe.
    if (body && body.includes(`${HELPER}(`)) delegating.push(cmd);
    else notDelegating.push(cmd);
  }

  const teardownInPreVerifyHook = downloadAndInstallArgs(src).filter(
    (args) => args.includes('kill_sidecar') || args.includes('shutdown_done'),
  );

  const helper = extractFnBody(src, HELPER);
  let helperOrder: TeardownAnalysis['helperOrder'] = null;
  if (helper) {
    const install = helper.indexOf('.install(');
    helperOrder = {
      download: helper.indexOf('.download('),
      latch: helper.indexOf('set_shutdown(true)'),
      kill: helper.indexOf('kill_sidecar('),
      install,
      unlatchAfterInstall:
        install !== -1 &&
        helper.indexOf('set_shutdown(false)') > install,
    };
  }
  return { delegating, notDelegating, teardownInPreVerifyHook, helperOrder };
}

// ── Pure analysis over the vendored plugin source ───────────────────────────

export type PluginOrder =
  | { available: true; order: 'hook-then-verify' | 'verify-then-hook' }
  | { available: false; reason: string };

/** Order of `on_download_finish()` vs `verify_signature(` inside `download`. */
export function analyzePluginDownload(downloadFnSrc: string): 'hook-then-verify' | 'verify-then-hook' {
  const hook = downloadFnSrc.indexOf('on_download_finish()');
  const verify = downloadFnSrc.indexOf('verify_signature(');
  if (hook === -1 || verify === -1) {
    throw new Error(`markers missing: on_download_finish=${hook} verify_signature=${verify}`);
  }
  return hook < verify ? 'hook-then-verify' : 'verify-then-hook';
}

function pinnedUpdaterVersion(): string | null {
  if (!existsSync(CARGO_LOCK_PATH)) return null;
  const lock = readFileSync(CARGO_LOCK_PATH, 'utf8');
  const m = lock.match(/name = "tauri-plugin-updater"\nversion = "([^"]+)"/);
  return m?.[1] ?? null;
}

function readPluginDownloadFn(): PluginOrder {
  const version = pinnedUpdaterVersion();
  if (!version) return { available: false, reason: 'tauri-plugin-updater is not pinned in Cargo.lock' };
  const registry = path.join(os.homedir(), '.cargo', 'registry', 'src');
  if (!existsSync(registry)) {
    return { available: false, reason: `tauri-plugin-updater-${version} not found in the cargo registry` };
  }
  for (const index of readdirSync(registry)) {
    const file = path.join(registry, index, `tauri-plugin-updater-${version}`, 'src', 'updater.rs');
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    const at = src.indexOf('pub async fn download<');
    if (at === -1) return { available: false, reason: 'download fn not found in updater.rs' };
    // Bound the window at the next `pub ` item so `download_and_install`'s own
    // body cannot supply the markers.
    const next = src.indexOf('pub fn install(', at);
    return { available: true, order: analyzePluginDownload(src.slice(at, next === -1 ? undefined : next)) };
  }
  return { available: false, reason: `tauri-plugin-updater-${version} not found in the cargo registry` };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('desktop updater: teardown happens after signature verification', () => {
  const src = readFileSync(MAIN_RS_PATH, 'utf8');
  const analysis = analyzeTeardown(src);

  it('no sidecar teardown is wired to the pre-verification on_download_finish hook', () => {
    // The hazard, stated as the plugin exposes it: anything in that hook runs on
    // bytes whose signature has NOT been checked.
    expect(analysis.teardownInPreVerifyHook).toEqual([]);
  });

  it('install_update and revert_to both delegate to the ordered helper', () => {
    expect(analysis.notDelegating).toEqual([]);
    expect(analysis.delegating).toEqual([...INSTALLING_COMMANDS]);
  });

  it('the helper orders download → latch → kill → install, and un-latches on install failure', () => {
    const order = analysis.helperOrder;
    expect(order, `${HELPER} is missing from main.rs`).not.toBeNull();
    const o = order!;
    // Every marker present...
    expect(Object.entries(o).filter(([, v]) => v === -1)).toEqual([]);
    // ...and in the only order that keeps the teardown off unverified bytes.
    expect(o.download).toBeLessThan(o.latch);
    expect(o.latch).toBeLessThan(o.kill);
    expect(o.kill).toBeLessThan(o.install);
    // A failed swap must not leave the supervisor's "deliberate teardown" latch set.
    expect(o.unlatchAfterInstall).toBe(true);
  });

  it('only revert_to switches off the plugin "must be newer" gate', () => {
    // The manifest route only compares versions for EQUALITY, so an older
    // latest.json IS served as a 200. The default comparator is what refuses it;
    // a second override here would make that offer installable.
    expect(versionComparatorOverrides(src)).toEqual([...MAY_ACCEPT_DOWNGRADE]);
  });

  it('the upstream ordering this split exists to work around still holds', () => {
    const plugin = readPluginDownloadFn();
    if (plugin.available) {
      // If this ever flips to 'verify-then-hook', upstream fixed it and the split
      // above can be revisited — a divergence check, not a permanent assumption.
      expect(plugin.order).toBe('hook-then-verify');
    } else {
      // Loud rather than silently green: say plainly that this leg measured nothing.
      expect(plugin.reason).toMatch(/not found in the cargo registry|not pinned|not found in updater\.rs/);
    }
  });
});

describe('falsifiability controls (fixtures, not the shared tree)', () => {
  const HOOK_TEARDOWN = `
    async fn install_update(app: AppHandle) -> Result<(), String> {
        update
            .download_and_install(progress_reporter, move || {
                let state: tauri::State<SidecarState> = teardown_app.state();
                state.shutdown_done.store(true, std::sync::atomic::Ordering::SeqCst);
                kill_sidecar(&teardown_app);
            })
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    async fn revert_to(app: AppHandle, tag: String) -> Result<(), String> {
        download_verify_then_install(&app, update).await?;
    }
    async fn download_verify_then_install(app: &AppHandle, update: Update) -> Result<(), String> {
        let bytes = update.download(progress_reporter, || {}).await.map_err(|e| e.to_string())?;
        set_shutdown(true);
        kill_sidecar(app);
        if let Err(e) = update.install(bytes) { set_shutdown(false); return Err(e.to_string()); }
        Ok(())
    }`;

  it('catches the original shape: teardown inside the pre-verification hook', () => {
    const a = analyzeTeardown(HOOK_TEARDOWN);
    expect(a.teardownInPreVerifyHook).toHaveLength(1);
    expect(a.notDelegating).toEqual(['install_update']);
  });

  it('catches a helper that tears down before the download completes', () => {
    const a = analyzeTeardown(
      HOOK_TEARDOWN.replace(
        'let bytes = update.download(progress_reporter, || {}).await.map_err(|e| e.to_string())?;\n        set_shutdown(true);\n        kill_sidecar(app);',
        'set_shutdown(true);\n        kill_sidecar(app);\n        let bytes = update.download(progress_reporter, || {}).await.map_err(|e| e.to_string())?;',
      ),
    );
    expect(a.helperOrder!.download).toBeGreaterThan(a.helperOrder!.kill);
  });

  it('catches a helper that leaves the latch set when the swap fails', () => {
    const a = analyzeTeardown(
      HOOK_TEARDOWN.replace('set_shutdown(false); return Err(e.to_string());', 'return Err(e.to_string());'),
    );
    expect(a.helperOrder!.unlatchAfterInstall).toBe(false);
  });

  it('calibration: the real-tree shape passes the same analyzer', () => {
    const a = analyzeTeardown(readFileSync(MAIN_RS_PATH, 'utf8'));
    expect(a.teardownInPreVerifyHook).toEqual([]);
    expect(a.notDelegating).toEqual([]);
  });

  it('catches a downgrade gate switched off in install_update too', () => {
    const OVERRIDE_IN_BOTH = `
      async fn install_update(app: AppHandle) -> Result<(), String> {
          let updater = app.updater_builder()
              .version_comparator(|_current, _release| true)
              .build().map_err(|e| e.to_string())?;
      }
      async fn revert_to(app: AppHandle, tag: String) -> Result<(), String> {
          let updater = app.updater_builder()
              .version_comparator(|_current, _release| true)
              .build().map_err(|e| e.to_string())?;
      }`;
    expect(versionComparatorOverrides(OVERRIDE_IN_BOTH)).toEqual(['install_update', 'revert_to']);
    // Calibration: the real tree yields only the sanctioned one.
    expect(versionComparatorOverrides(readFileSync(MAIN_RS_PATH, 'utf8'))).toEqual(['revert_to']);
  });

  it('catches an upstream ordering claim stated backwards', () => {
    expect(
      analyzePluginDownload('on_download_finish();\nverify_signature(&buffer, &sig, &key)?;'),
    ).toBe('hook-then-verify');
    expect(
      analyzePluginDownload('verify_signature(&buffer, &sig, &key)?;\non_download_finish();'),
    ).toBe('verify-then-hook');
  });
});
