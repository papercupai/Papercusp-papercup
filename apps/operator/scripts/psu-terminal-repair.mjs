/**
 * Adopt the existing fdinfo identity repair in a legacy interactive PTY host.
 * Reuses the production reader and CDP lifecycle. No host/child restart, module
 * reload, terminal change, or automatic interactive re-exec is involved.
 * Only the exact known legacy function is eligible; unknown source fails closed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { metaPathFor } from './psu-pty-host.mjs';
import { closeInspector, createCdpClient, discoverInspector } from '../../../scripts/cdp-inspector.mjs';

export const LEGACY_IDENTITY_FUNCTION = `export function codexNativeIdForPty(codexHome, ptyPid, {
  readHolder = codexThreadWriterHolder,
  readStartupPid = resolveLinuxCodexStartupPid,
} = {}) {
  if (!Number.isSafeInteger(ptyPid) || ptyPid <= 0) return null;
  try {
    const nativePid = readStartupPid(ptyPid);
    if (!nativePid) return null;
    const holder = readHolder(codexHome, null, { holderPid: nativePid });
    if (!holder.held || !holder.sessionId || !holder.pid) return null;
    if (holder.pid !== nativePid) return null;
    return holder.sessionId;
  } catch {
    return null;
  }
}`;
const MARKER = '/* psu-terminal-identity-fdinfo-v1 */';
const INSPECTOR_PUBLISH_UID_FLAG = '--inspect-publish-uid=';
const hash = (text) => createHash('sha256').update(text).digest('hex');
// Read original ESM bytes: Function#toString on a bundled/test-transformed
// module carries synthetic import bindings that do not exist in a live host.
const launcherSource = readFileSync(new URL('./psu-launcher.mjs', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = launcherSource.indexOf('export function ' + name + '(');
  const end = launcherSource.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('Production repair reader is unavailable');
  return launcherSource.slice(start, end + 2);
}
const readerSource = productionFunction('readLinuxProcessFlockText').slice('export '.length);
// Qualified by the captured-callback integration probe. The current entry adds
// container custody, while the exact legacy host source accepted below retains
// its host-only startup-PID and holder checks. Pin all current bytes so a future
// production change still requires an explicit qualification.
const QUALIFIED_PRODUCTION_IDENTITY_HASH = '2902fab7ba16347546ed231d1f58e6b2a4be76079675008343248a8ee91cf2c6';

/**
 * Node's SIGUSR1 inspector activation writes its URL to fd 2 when the
 * `stderr` publish destination is enabled. Interactive psu hosts must publish
 * the URL through HTTP only so a repair cannot append a debugger banner to the
 * owner's TUI. The last option wins, matching Node's command-line handling.
 * @param {{cmdline?:string[],environment?:string}} [options]
 */
export function hasTerminalSafeInspectorPublication({ cmdline = [], environment = '' } = {}) {
  let destinations = null;
  const options = [];
  for (const value of String(environment).split('\0')) {
    if (value.startsWith('NODE_OPTIONS=')) options.push(...value.slice('NODE_OPTIONS='.length).trim().split(/\s+/));
  }
  options.push(...(Array.isArray(cmdline) ? cmdline : []));
  for (let i = 0; i < options.length; i += 1) {
    const option = String(options[i]);
    let value = option.startsWith(INSPECTOR_PUBLISH_UID_FLAG)
      ? option.slice(INSPECTOR_PUBLISH_UID_FLAG.length)
      : null;
    if (option === '--inspect-publish-uid' && i + 1 < options.length) value = String(options[++i]);
    if (value !== null) destinations = value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return Boolean(destinations?.includes('http') && !destinations.includes('stderr'));
}

/** A function-body-only change is safe for V8 live edit of an existing module.
 * Inline the SAME production reader because legacy modules lack its binding.
 * Existing filesystem bindings are unchanged, and the exact-child filter stays.
 */
export function terminalIdentityRepairSource(source) {
  if (source.includes(MARKER) || source.includes('export function readLinuxProcessFlockText('))
    return { needed: false, source, beforeHash: hash(source), afterHash: hash(source) };
  const first = source.indexOf(LEGACY_IDENTITY_FUNCTION);
  if (first < 0 || source.indexOf(LEGACY_IDENTITY_FUNCTION, first + 1) >= 0)
    throw new Error('Unknown or ambiguous terminal identity function; repair refused');
  // Pin the maintained entry too: source drift must be re-qualified, not copied
  // blindly into legacy processes. The inline reader is the only changed call.
  if (hash(productionFunction('codexNativeIdForPty')) !== QUALIFIED_PRODUCTION_IDENTITY_HASH)
    throw new Error('Production identity function changed; repair needs re-qualification');
  const repaired = LEGACY_IDENTITY_FUNCTION.replace(
    'const holder = readHolder(codexHome, null, { holderPid: nativePid });',
    `const holder = readHolder(codexHome, null, { holderPid: nativePid,
      ${MARKER}
      readProcLocks: () => (${readerSource})(nativePid),
    });`,
  );
  const next = source.slice(0, first) + repaired + source.slice(first + LEGACY_IDENTITY_FUNCTION.length);
  return { needed: true, source: next, beforeHash: hash(source), afterHash: hash(next) };
}

/** Apply/read back the exact prepared source. No debugger pause is requested.
 * @param {Pick<ReturnType<typeof createCdpClient>, 'send'>} client
 * @param {{scriptId:string,source:string,apply?:boolean}} options
 */
export async function applyTerminalIdentityRepair(client, { scriptId, source, apply = false }) {
  const prepared = terminalIdentityRepairSource(source);
  const receipt = { needed: prepared.needed, applied: false,
    beforeHash: prepared.beforeHash, afterHash: prepared.afterHash };
  if (!prepared.needed) return receipt;
  const preview = await client.send('Debugger.setScriptSource', {
    scriptId, scriptSource: prepared.source, dryRun: true,
  });
  if (preview.status !== 'Ok') throw new Error('V8 refused terminal repair preview: ' + preview.status);
  if (!apply) return receipt;
  const current = await client.send('Debugger.getScriptSource', { scriptId });
  if (current.scriptSource !== source) throw new Error('Loaded source changed after preview; repair refused');
  const result = await client.send('Debugger.setScriptSource', { scriptId, scriptSource: prepared.source });
  if (result.status !== 'Ok') throw new Error('V8 refused terminal repair: ' + result.status);
  const readback = await client.send('Debugger.getScriptSource', { scriptId });
  if (readback.scriptSource !== prepared.source) throw new Error('Terminal repair readback mismatch');
  return { ...receipt, applied: true };
}

/**
 * SIGUSR1 activation can be delayed behind a blocked Node main thread. Keep the
 * activation attempt owned after the caller's short foreground budget expires,
 * and close only a target that proves it is the same PID/incarnation and
 * launcher entry. A late target belonging to another process is never closed.
 * @param {{pid:number,entry:string,started:string,maxWaitMs?:number,pollIntervalMs?:number,
 *   discover?:typeof discoverInspector,create?:typeof createCdpClient,close?:typeof closeInspector,
 *   sleepImpl?:(ms:number)=>Promise<unknown>}} options
 */
export async function closeLateInspectorWhenAvailable({
  pid,
  entry,
  started,
  maxWaitMs = 30_000,
  pollIntervalMs = 100,
  discover = discoverInspector,
  create = createCdpClient,
  close = closeInspector,
  sleepImpl = sleep,
}) {
  const deadline = Date.now() + maxWaitMs;
  try {
    while (Date.now() < deadline) {
      const target = await discover({ portCount: 1, requestTimeoutMs: 250 });
      if (!target) {
        await sleepImpl(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      const client = create(target.wsUrl, { requestTimeoutMs: 5_000 });
      try {
        await client.connect();
        const identity = (await client.evaluate(
          '({pid:process.pid,entry:process.argv[1]})',
          { returnByValue: true },
        )).result.value;
        const exact = identity?.pid === pid && identity.entry === entry && startTicks(pid) === started;
        if (exact) {
          await close(client, target.port);
          return { closed: true, port: target.port };
        }
      } finally {
        // A verified close can fail before it releases the transport. Ownership
        // of this connection ends here on success, refusal, and failure alike.
        client.close();
      }
      return { closed: false, reason: 'identity-mismatch' };
    }
    return { closed: false, reason: 'activation-timeout' };
  } catch (error) {
    return { closed: false, reason: 'cleanup-error',
      error: error instanceof Error ? error.message : String(error) };
  }
}

function startTicks(pid) {
  const text = readFileSync('/proc/' + pid + '/stat', 'utf8');
  return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
}

/** Explicit exact-host operation; caller supplies its discovery owner identity.
 * The inspector is temporarily loopback-only and verified closed afterwards.
 * The loaded-source hash proves this repair, not a whole-host code upgrade.
 * @param {{pid:number,ownerId:string,apply?:boolean}} options
 */
export async function repairTerminalHost({ pid, ownerId, apply = false }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof ownerId !== 'string' || !/^su-[a-zA-Z0-9-]+$/.test(ownerId))
    throw new Error('An exact positive host PID and discovery owner ID are required');
  const metaPath = metaPathFor(ownerId);
  const before = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (before.ownerId !== ownerId || before.pid !== pid || before.bridgeTty !== true)
    throw new Error('Discovery identity or interactive terminal changed; repair refused');
  const argv = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
  const entry = argv.find((arg) => arg.endsWith('/psu-launcher.mjs'));
  // Linux appends this literal suffix to an executable unlinked by an upgrade;
  // the running inode is still Node. Keep all other executable names refused.
  const executable = basename(readlinkSync('/proc/' + pid + '/exe')).replace(/ \(deleted\)$/, '');
  if (!entry || !/^node(?:js)?$/.test(executable))
    throw new Error('Discovery PID is not a Node terminal host; repair refused before signaling');
  const environment = readFileSync('/proc/' + pid + '/environ', 'utf8');
  if (!hasTerminalSafeInspectorPublication({ cmdline: argv, environment })) {
    throw new Error(
      'Terminal inspector attachment refused: launch the host with --inspect-publish-uid=http ' +
      '(stderr publication is unsafe for an interactive TUI)',
    );
  }
  const started = startTicks(pid);
  if (await discoverInspector({ portCount: 1 })) throw new Error('Inspector port is already occupied; leave the existing debugger alone');
  process.kill(pid, 'SIGUSR1');
  let target;
  for (let i = 0; i < 30; i++) {
    target = await discoverInspector({ portCount: 1, requestTimeoutMs: 250 });
    if (target) break;
    await sleep(100);
  }
  if (!target) {
    // The signal may have been accepted while the main thread was blocked. Keep
    // Own cleanup until its bounded attempt settles. A detached promise loses
    // the close verdict when the repair caller exits; attach the full receipt
    // to the original activation failure so unresolved cleanup stays visible.
    const inspectorCleanup = await closeLateInspectorWhenAvailable({ pid, entry, started });
    throw Object.assign(new Error('Terminal inspector did not open on loopback; cleanup: ' +
      (inspectorCleanup.closed ? 'closed' : inspectorCleanup.reason)), { inspectorCleanup });
  }
  const client = createCdpClient(target.wsUrl, { requestTimeoutMs: 5000 });
  let verified = false;
  let receipt;
  try {
    await client.connect();
    const identity = (await client.evaluate('({pid:process.pid,entry:process.argv[1]})', { returnByValue: true })).result.value;
    if (identity?.pid !== pid || identity.entry !== entry || startTicks(pid) !== started)
      throw new Error('Inspector identity mismatch; repair refused');
    verified = true;
    const scripts = [];
    const parsed = (data) => {
      const event = JSON.parse(String(data));
      if (event.method === 'Debugger.scriptParsed' && event.params.url === 'file://' + identity.entry)
        scripts.push(event.params);
    };
    client.ws.on('message', parsed);
    await client.send('Debugger.enable');
    client.ws.off('message', parsed);
    if (scripts.length !== 1) throw new Error('Loaded launcher script is ambiguous; repair refused');
    const scriptId = scripts[0].scriptId;
    const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId });
    receipt = await applyTerminalIdentityRepair(client, { scriptId, source: scriptSource, apply });
    const after = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (startTicks(pid) !== started || after.pid !== pid || after.ptyPid !== before.ptyPid || after.ownerId !== ownerId)
      throw new Error('Terminal or native child changed during repair');
    return { ...receipt, pid, ownerId, nativeChildPid: before.ptyPid, startTicks: started,
      inspectorClosed: true };
  } finally {
    if (verified) await closeInspector(client, target.port);
    else client.close();
  }
}
