/** Fixed host-only native build stage. No reviewer-selected command or origin. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { runVerifierDependencyCommand } from '../../../scripts/source-preview.mjs';
import { captureRuntimeDesktopExecutable } from './blind-review-runtime-tools';

export const RUNTIME_PRODUCT_ORIGIN = 'http://127.0.0.1:3070';
/** Only the trusted build adapter supplies toolchains; fixtures use this seam. */
export type RuntimeDesktopToolchain = { cargoExecutable: string; rustcExecutable: string; registryRoot: string };
const refuse = (): never => { throw new Error('broker_native_build_invalid'); };

/**
 * Compile the private measured checkout in private Cargo home/target storage.
 * Reuse native storage admission and the maintained sidecar reader lock. Copy
 * only registry index/cache; locked offline Cargo reconstructs sources from
 * checksum-verified archives, excluding mutable host src/config/credentials.
 * Select Cargo's source-bound JSON executable instead of guessing a pathname.
 * Caller owns work and retains it when process-group termination is unknown.
 */
export async function buildRuntimeDesktop(options: {
  root: string; work: string; sourceCommit: string; env: NodeJS.ProcessEnv;
  signal?: AbortSignal; toolchain?: RuntimeDesktopToolchain;
}) {
  const { signal } = options;
  signal?.throwIfAborted();
  const root = await realpath(options.root), work = await realpath(options.work);
  const outputRoot = join(root, 'apps/operator/dist-verify');
  await mkdir(outputRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!(await lstat(outputRoot)).isDirectory() || await realpath(outputRoot) !== outputRoot) refuse();
  const destination = join(outputRoot, 'native');
  // Establish ownership and the output precondition before expensive work.
  await mkdir(destination, { mode: 0o700 });
  const manifestRoot = join(root, 'papercusp-desktop/src-tauri');
  const lock = await readFile(join(manifestRoot, 'Cargo.lock'));
  if (lock.includes('source = "git+')) refuse();
  const env = { ...options.env };
  let toolchain = options.toolchain;
  if (!toolchain) {
    const rustup = join(homedir(), '.cargo/bin/rustup');
    const lookupEnv = { ...env, RUSTUP_HOME: join(homedir(), '.rustup') };
    const find = async (name: string) => realpath((await runVerifierDependencyCommand(rustup,
      ['which', name], { cwd: root, env: lookupEnv, signal })).trim());
    toolchain = { cargoExecutable: await find('cargo'), rustcExecutable: await find('rustc'),
      registryRoot: join(homedir(), '.cargo/registry') };
  }
  const cargo = await realpath(toolchain.cargoExecutable);
  const rustc = await realpath(toolchain.rustcExecutable);
  const cargoHome = join(work, 'cargo-home'), target = join(work, 'cargo-target');
  await mkdir(cargoHome, { mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  const registry = await realpath(toolchain.registryRoot);
  Object.assign(env, { CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target, RUSTC: rustc,
    PATH: dirname(cargo) + ':' + dirname(process.execPath) + ':/usr/bin:/bin',
    CARGO_INCREMENTAL: '0', CARGO_NET_OFFLINE: 'true', PAPERCUSP_DESKTOP_NATIVE_DEV: '1',
    PAPERCUSP_BUILD_SHA: options.sourceCommit,
    PAPERCUSP_VERIFY_TAURI_DEV_URL: RUNTIME_PRODUCT_ORIGIN,
    TAURI_CONFIG: JSON.stringify({ build: { devUrl: RUNTIME_PRODUCT_ORIGIN }, bundle: { resources: [] } }) });
  const output = await runVerifierDependencyCommand('/bin/bash', ['-c', `set -euo pipefail
source papercusp-desktop/bin/lib/claim-target-dir.sh
trap 'papercusp_release_disk_reservation' EXIT
mkdir "$CARGO_HOME/registry"
/bin/cp -a --reflink=auto -- "$1/index" "$1/cache" "$CARGO_HOME/registry/"
/usr/bin/python3 -I -S - "$CARGO_HOME/registry" papercusp-desktop/src-tauri/Cargo.lock <<'REGISTRY'
import hashlib,json,os,re,stat,sys,tomllib
for root,dirs,files in os.walk(sys.argv[1],followlinks=False):
 for name in dirs+files:
  mode=os.lstat(os.path.join(root,name)).st_mode
  if not stat.S_ISREG(mode) and not stat.S_ISDIR(mode):
   raise ValueError('broker_native_registry_redirect')
verified=[]
with open(sys.argv[2],'rb') as source:
 lock=tomllib.load(source)
cache=os.path.join(sys.argv[1],'cache')
for package in lock.get('package',[]):
 if not package.get('source','').startswith('registry+'):
  continue
 name,version,expected=package.get('name',''),package.get('version',''),package.get('checksum','')
 if not re.fullmatch('[A-Za-z0-9_-]+',name) or not re.fullmatch('[A-Za-z0-9.+_-]+',version) or not re.fullmatch('[a-f0-9]{64}',expected):
  raise ValueError('broker_native_registry_lock_invalid')
 for registry in sorted(os.listdir(cache)):
  archive=os.path.join(cache,registry,name+'-'+version+'.crate')
  if not os.path.exists(archive):
   continue
  with open(archive,'rb') as source:
   actual=hashlib.file_digest(source,'sha256').hexdigest()
  if actual!=expected:
   raise ValueError('broker_native_registry_checksum_mismatch')
  verified.append({'name':name,'version':version,'sha256':actual})
with open(os.path.join(sys.argv[1],'verified-archives.json'),'x') as receipt:
 json.dump(verified,receipt,sort_keys=True,separators=(',',':'))
REGISTRY
bash papercusp-desktop/bin/cargo-build-safe.sh build --locked --offline --bin papercusp-desktop --message-format=json`,
    'broker-native-build', registry], { cwd: root, env, signal });
  let finished = false;
  const artifacts: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try { row = JSON.parse(line); } catch { refuse(); }
    if (row.reason === 'build-finished') {
      if (finished || row.success !== true) refuse();
      finished = true;
    }
    if (row.reason === 'compiler-artifact' && row.target?.name === 'papercusp-desktop' &&
        row.target?.kind?.includes('bin')) {
      if (row.target.src_path !== join(manifestRoot, 'src/main.rs') ||
          row.profile?.test !== false || typeof row.executable !== 'string') refuse();
      artifacts.push(row.executable);
    }
  }
  if (!finished || artifacts.length !== 1) refuse();
  const executable = await realpath(artifacts[0]);
  if (!executable.startsWith(target + sep) || executable !== artifacts[0]) refuse();
  const executableSha256 = await captureRuntimeDesktopExecutable(join(destination, 'papercusp-desktop'), executable, signal);
  const registryReceipt = await readFile(join(cargoHome, 'registry/verified-archives.json'));
  await writeFile(join(destination, 'build.json'), JSON.stringify({ version: 1,
    sourceCommit: options.sourceCommit, cargoLockSha256: createHash('sha256').update(lock).digest('hex'),
    registryArchivesSha256: createHash('sha256').update(registryReceipt).digest('hex'),
    executableSha256, origin: RUNTIME_PRODUCT_ORIGIN }) + '\n', { flag: 'wx', mode: 0o444 });
}
