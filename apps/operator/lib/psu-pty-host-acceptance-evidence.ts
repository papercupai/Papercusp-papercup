import { readFileSync } from 'node:fs';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export interface TerminalHostIncarnation {
  ownerId: string;
  pid: number;
  starttime: string;
  hostCodeVersion: string;
}

/** Validate captured observations against the current host incarnation, without attaching or restarting it.
 * This verifies the recorded trace, not a new trace; native child generations may advance on carry.
 */
export function validateTerminalHostAcceptance(raw: unknown, current: TerminalHostIncarnation) {
  const artifact = record(raw);
  const runtime = record(artifact.runtime);
  const loaded = record(artifact.loadedSource);
  const trace = record(artifact.trace);
  const modules = Array.isArray(loaded.loaded) ? loaded.loaded.map(record) : [];
  const host = modules.find(module => module.path === 'apps/operator/scripts/psu-pty-host.mjs') ?? {};
  const launcher = modules.find(module => module.path === 'apps/operator/scripts/psu-launcher.mjs') ?? {};
  const postDetach = Array.isArray(artifact.postDetachChecks) ? artifact.postDetachChecks.map(record) : [];
  const identityMatches = runtime.ownerId === current.ownerId && runtime.pid === current.pid &&
    runtime.starttime === current.starttime && runtime.hostCodeVersion === current.hostCodeVersion &&
    loaded.owner === current.ownerId && loaded.hostPid === current.pid && loaded.hostStarttime === current.starttime;
  const assertions = [
    { id: 'exact-current-host-incarnation', passed: identityMatches },
    { id: 'loaded-host-hash-and-output-repair', passed: hash(current.hostCodeVersion) &&
      host.loadedSha256 === current.hostCodeVersion && loaded.metadataHostHash === current.hostCodeVersion &&
      host.diagnosticsUseAsyncWriter === true && host.dualStreamDrain === true },
    { id: 'loaded-periodic-local-reader', passed: hash(launcher.loadedSha256) &&
      launcher.processLocalLockReader === true && launcher.unknownPidEarlyReturn === true },
    { id: 'positive-local-read-and-no-global-oracle', passed: trace.hostPid === current.pid &&
      trace.hostStart === current.starttime && trace.traceAttached === true &&
      finite(trace.localFdinfoOpens) && trace.localFdinfoOpens > 0 && trace.globalLockOpens === 0 },
    { id: 'recorded-native-and-pty-continuity', passed: typeof trace.nativeBefore === 'string' &&
      trace.nativeBefore.length > 0 && trace.nativeBefore === trace.nativeAfter &&
      finite(trace.ptyBefore) && trace.ptyBefore > 0 && trace.ptyBefore === trace.ptyAfter },
    { id: 'observed-peer-incarnations-preserved', passed: finite(trace.interactiveInventoryBeforeCount) &&
      trace.interactiveInventoryBeforeCount > 0 &&
      trace.interactiveInventoryBeforeCount === trace.interactiveInventoryAfterCount &&
      hash(trace.beforeInventorySha256) && trace.beforeInventorySha256 === trace.afterInventorySha256 &&
      Array.isArray(trace.externalChurnUnknown) && trace.externalChurnUnknown.length === 0 &&
      trace.commandsRestartedPeers === false },
    { id: 'inspector-closed', passed: loaded.inspectorClosed === true },
    { id: 'post-detach-progress', passed: postDetach.some(witness => witness.status === 'pass' &&
      finite(witness.durationSec) && witness.durationSec >= 20 &&
      finite(witness.observedBefore) && finite(witness.observedAfter) &&
      witness.observedAfter > witness.observedBefore &&
      witness.hostPidBefore === current.pid && witness.hostPidAfter === current.pid &&
      typeof witness.nativeBefore === 'string' && witness.nativeBefore.length > 0 &&
      witness.nativeBefore === witness.nativeAfter) },
  ];
  return { passed: assertions.every(assertion => assertion.passed), assertions,
    measuredHost: current, capturedNativeId: trace.nativeBefore ?? null,
    limitation: 'Validates captured measurements and current host incarnation; does not re-trace, compare scrollback, or assert the captured native child generation is current.' };
}

export function readTerminalHostAcceptance(artifactPath: string, discoveryPath: string, ownerId: string,
  readText: (path: string) => string = path => readFileSync(path, 'utf8')) {
  const discovery = record(JSON.parse(readText(discoveryPath)));
  const pid = discovery.pid;
  if (discovery.ownerId !== ownerId || !Number.isSafeInteger(pid) || Number(pid) <= 0) {
    throw new Error('Discovery must identify the requested owner and a positive host PID.');
  }
  const stat = readText(`/proc/${pid}/stat`);
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!starttime || !/^\d+$/.test(starttime) || !hash(discovery.hostCodeVersion)) {
    throw new Error('Host process identity or advertised code version is unavailable.');
  }
  return validateTerminalHostAcceptance(JSON.parse(readText(artifactPath)), {
    ownerId, pid: Number(pid), starttime, hostCodeVersion: discovery.hostCodeVersion,
  });
}
