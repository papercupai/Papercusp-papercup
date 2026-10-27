/** Host-only snapshot of executables needed inside the sealed runtime image. */
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export type RuntimeToolSources = { nodeExecutable?: string; driverRoot?: string };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function refuse(): never { throw new Error('broker_runtime_tools_invalid'); }
async function stableBytes(source: string, maxBytes: number, signal?: AbortSignal, executable = false) {
  signal?.throwIfAborted();
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes) ||
        executable && (before.size === 0n || !(before.mode & 0o111n))) refuse();
    // readFile() may follow a concurrently growing donor past its size bound.
    // Read only the measured allocation and reject any metadata change.
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
      if (!bytesRead) refuse();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) refuse();
    return { bytes, mode: before.mode };
  } finally { await handle.close(); }
}

/** Capture the native result, never a launcher, build home or target tree. */
export async function captureRuntimeDesktopExecutable(destination: string, source: string, signal?: AbortSignal) {
  const { bytes } = await stableBytes(source, 512 * 1024 * 1024, signal, true);
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 || bytes[5] !== 1 || ![2, 3].includes(bytes.readUInt16LE(16))) refuse();
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o555 });
  return sha(bytes);
}

/**
 * Paths are chosen by the host build adapter, never by a reviewer request.
 * Copy only Node plus the driver's package/dist/dependency trees; no host home,
 * npm config, global sibling package, socket, environment or credential store.
 * Open each resolved regular file once and reject a changing donor. The later
 * generated-input census and sealed-image census still remain mandatory.
 */
export async function captureRuntimeTools(destination: string, sources: RuntimeToolSources = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const node = await realpath(sources.nodeExecutable ?? process.execPath);
  const driver = await realpath(sources.driverRoot ?? join(dirname(node), '../lib/node_modules/tauri-agent-tools'));
  const metadataPath = join(driver, 'package.json');
  if (await realpath(metadataPath) !== metadataPath) refuse();
  const { bytes: metadataBytes } = await stableBytes(metadataPath, 1024 * 1024, signal);
  let metadata;
  try { metadata = JSON.parse(metadataBytes.toString('utf8')); } catch { refuse(); }
  if (!metadata || typeof metadata !== 'object') refuse();
  if (metadata.name !== 'tauri-agent-tools' || typeof metadata.version !== 'string' ||
      !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(metadata.version) ||
      metadata.bin?.['tauri-agent-tools'] !== './dist/cli.js') refuse();
  const dependencies = metadata.dependencies ?? {};
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) refuse();
  const require = createRequire(join(driver, 'package.json'));
  for (const dependency of Object.keys(dependencies)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(dependency) || dependency.length > 214) refuse();
    const entry = await realpath(require.resolve(dependency));
    if (!entry.startsWith(driver + sep)) refuse();
  }
  await stat(join(driver, 'dist/cli.js')).then(info => { if (!info.isFile()) refuse(); });
  destination = resolve(destination);
  if (await realpath(dirname(destination)) !== dirname(destination)) refuse();
  await mkdir(destination, { mode: 0o700 }); // EEXIST refuses adoption.
  let copied = 0, total = 0;
  async function copyRegular(source: string, target: string, maxBytes: number, executable = false): Promise<string> {
    const { bytes, mode } = await stableBytes(source, maxBytes, signal, executable);
    total += bytes.length;
    if (++copied > 25_000 || total > 384 * 1024 * 1024) refuse();
    signal?.throwIfAborted();
    await writeFile(target, bytes, { flag: 'wx', mode: mode & 0o111n ? 0o555 : 0o444 });
    return sha(bytes);
  }
  async function copyDriver(path: string, target: string, ancestors: ReadonlySet<string> = new Set()): Promise<void> {
    signal?.throwIfAborted();
    const source = await realpath(path);
    if (!source.startsWith(driver + sep) || ancestors.has(source)) refuse();
    const info = await stat(source);
    if (info.isDirectory()) {
      await mkdir(target, { mode: 0o700 });
      const next = new Set(ancestors); next.add(source);
      for (const name of (await readdir(source)).sort()) await copyDriver(join(source, name), join(target, name), next);
    } else if (info.isFile()) await copyRegular(source, target, 32 * 1024 * 1024);
    else refuse();
  }
  try {
    const nodeSha256 = await copyRegular(node, join(destination, 'node'), 256 * 1024 * 1024, true);
    await mkdir(join(destination, 'driver'), { mode: 0o700 });
    const packageSha256 = await copyRegular(join(driver, 'package.json'), join(destination, 'driver/package.json'), 1024 * 1024);
    if (packageSha256 !== sha(metadataBytes)) refuse();
    await copyDriver(join(driver, 'dist'), join(destination, 'driver/dist'));
    if (Object.keys(dependencies).length) await copyDriver(join(driver, 'node_modules'), join(destination, 'driver/node_modules'));
    await writeFile(join(destination, 'tools.json'), JSON.stringify({ version: 1, nodeSha256,
      driver: { name: metadata.name, version: metadata.version, packageSha256 } }) + '\n', { flag: 'wx', mode: 0o444 });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
