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
  if (productionFunction('codexNativeIdForPty') !== LEGACY_IDENTITY_FUNCTION)
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
  const started = startTicks(pid);
  if (await discoverInspector({ portCount: 1 })) throw new Error('Inspector port is already occupied; leave the existing debugger alone');
  process.kill(pid, 'SIGUSR1');
  let target;
  for (let i = 0; i < 30; i++) {
    target = await discoverInspector({ portCount: 1, requestTimeoutMs: 250 });
    if (target) break;
    await sleep(100);
  }
  if (!target) throw new Error('Terminal inspector did not open on loopback');
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
