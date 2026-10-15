import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as phaseI from './physical-drill-phase-i';
import * as hiveKeys from '../../identity/hive-keypair';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import {
  PHYSICAL_DRILL_INCOMPLETE_EXIT,
  cli,
  parsePhysicalPhaseICliArgs,
  PhysicalDrillIncompleteEvidenceError,
  physicalDrillFailureLine,
  physicalPhaseJMode,
  runPhysicalDrillCliToExit,
} from './physical-drill-producer';
import {
  PHASE_J_MIN_ATTEMPTS,
  PHASE_J_MIN_HOLD_MS,
  PHASE_J_OBSERVATION_SCHEMA,
  phaseJWriteSummary,
  phaseJWriteTitle,
  type PhysicalPhaseJObservation,
} from './physical-drill-phase-j';

// WI-10003741 / P-505 run 23: a producer mode that opened the @papercusp/locks
// pg pool wrote its receipt and then never exited, so the scenario's ssh call
// hung. The CLI must end the process itself once the result is flushed.

describe('Phase I canary CLI (P-502 real owning authority)', () => {
  afterEach(() => vi.restoreAllMocks());
  function inputs() {
    const dir = mkdtempSync(join(tmpdir(), 'phase-i-cli-'));
    const hiveId = generateEd25519KeypairDer().pubkeyBase64;
    const target = { kind: 'canary-owner', workspaceId: 'workspace-test', potHomeSlug: 'canary-test', hiveId, repoKey: 'gh-canary-test' };
    const snapshot = { observedAt: '2026-10-13T00:00:00Z', stagingRef: 'a'.repeat(40), releaseRef: null, githubMain: 'b'.repeat(40), forkRefs: [], pullRequests: [] };
    writeFileSync(join(dir, 'target.json'), JSON.stringify(target));
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot));
    return { dir, target, snapshot, flags: ['--canary-target', join(dir, 'target.json')], snapshotFlags: ['--real-target-snapshot', join(dir, 'snapshot.json')] };
  }

  it('routes the canary attempt through the existing sink with its real scope and observation', async () => {
    const i = inputs();
    try {
      const receipt: Awaited<ReturnType<typeof phaseI.attemptPhysicalPhaseI>> = {
        schemaVersion: phaseI.PHASE_I_ATTEMPT_SCHEMA, hostId: 'tower', step: 'live',
        runId: 'p502-cli-test-run', startedAt: i.snapshot.observedAt, finishedAt: i.snapshot.observedAt,
        attemptPid: process.pid, hiveId: i.target.hiveId, repoKey: i.target.repoKey,
        advisory: { provenance: 'drill-supplied-roster-inputs', rosterEpoch: 1, isSelf: true, leaderDevicePubkey: null },
        deviceSigner: { devicePubkey: i.target.hiveId, verified: true }, ownerKeyMaterialOnHost: false,
        attempts: [], localCommit: { oid: 'a'.repeat(40), landed: true }, capturedOwnerProof: null,
        deviceHead: null, deviceHeadAcceptance: null, lost: null,
      };
      const attempt = vi.spyOn(phaseI, 'attemptPhysicalPhaseI').mockResolvedValue(receipt);
      const args = ['tower', 'live', i.dir, 'p502-cli-test-run', i.target.hiveId, 'test-device-keychain', i.target.hiveId];
      expect(await cli(['phase-i-attempt', ...args, ...i.flags, ...i.snapshotFlags])).toEqual(receipt);
      expect(attempt.mock.calls[0]![0]).toMatchObject({ repoKey: i.target.repoKey, hiveId: i.target.hiveId, realTargetSnapshot: i.snapshot });
      await expect(cli(['phase-i-attempt', ...args, ...i.flags])).rejects.toThrow(/real-target snapshot/);
      await expect(cli(['phase-i-attempt', ...args.slice(0, 6), generateEd25519KeypairDer().pubkeyBase64, ...i.flags, ...i.snapshotFlags])).rejects.toThrow(/matching hiveId/);
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally { rmSync(i.dir, { recursive: true, force: true }); }
  });

  it('refuses a missing canary key instead of starting a minted-key owner', async () => {
    const i = inputs();
    try {
      vi.spyOn(hiveKeys, 'loadHiveKeyStatus').mockResolvedValue({ kind: 'not_found' });
      const start = vi.spyOn(phaseI, 'startPhaseIOwner');
      await expect(cli(['phase-i-owner', i.dir, 'p502-cli-test-run', ...i.flags])).rejects.toThrow(/unavailable or foreign/);
      expect(start).not.toHaveBeenCalled();
    } finally { rmSync(i.dir, { recursive: true, force: true }); }
  });

  it('fails closed on missing, duplicate or malformed canary observation flags', () => {
    const i = inputs();
    try {
      expect(() => parsePhysicalPhaseICliArgs(['--canary-target'])).toThrow(/requires a JSON file/);
      expect(() => parsePhysicalPhaseICliArgs([...i.flags, ...i.flags])).toThrow(/duplicate/);
      expect(() => parsePhysicalPhaseICliArgs(i.snapshotFlags)).toThrow(/requires --canary-target/);
      writeFileSync(join(i.dir, 'snapshot.json'), '{}');
      expect(() => parsePhysicalPhaseICliArgs([...i.flags, ...i.snapshotFlags])).toThrow(/invalid real-target snapshot/);
      expect(parsePhysicalPhaseICliArgs(['vm', 'live'])).toEqual({ positional: ['vm', 'live'] });
    } finally { rmSync(i.dir, { recursive: true, force: true }); }
  });
});

function deferredStream() {
  const chunks: string[] = [];
  const pending: Array<() => void> = [];
  return {
    chunks,
    flush: () => {
      while (pending.length) pending.shift()!();
    },
    write: vi.fn((chunk: string, callback: (error?: Error | null) => void) => {
      chunks.push(chunk);
      pending.push(() => callback());
      return true;
    }),
  };
}

describe('runPhysicalDrillCliToExit', () => {
  it('writes the result and exits 0 only after stdout has flushed', async () => {
    const stdout = deferredStream();
    const stderr = deferredStream();
    const exit = vi.fn();
    const done = runPhysicalDrillCliToExit(['phase-d-dirty', 'run-1'], {
      run: async (argv) => ({ mode: argv[0], reset: false }),
      stdout,
      stderr,
      exit,
    });
    await vi.waitFor(() => expect(stdout.write).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();
    stdout.flush();
    await done;
    expect(stdout.chunks).toEqual(['{"mode":"phase-d-dirty","reset":false}\n']);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reports a failed mode on stderr and exits 1 after stderr has flushed', async () => {
    const stdout = deferredStream();
    const stderr = deferredStream();
    const exit = vi.fn();
    const done = runPhysicalDrillCliToExit(['phase-d-reset'], {
      run: async () => {
        throw new Error('usage: physical-drill-producer phase-d-reset <run-id>');
      },
      stdout,
      stderr,
      exit,
    });
    await vi.waitFor(() => expect(stderr.write).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();
    stderr.flush();
    await done;
    expect(stderr.chunks).toEqual([
      'physical-drill-producer: phase-d-reset: usage: physical-drill-producer phase-d-reset <run-id>\n',
    ]);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  // Same-box run 20260930T054405Z: Phase A threw a bare `physical Phase A git ...`
  // message and the drill summary reported "no prefixed reason line". The failure
  // line must carry the prefix the summary reads, and the real summary script must
  // name the phase and that reason from it.
  it('prefixes a bare phase error so the drill summary names the phase and reason', async () => {
    const stdout = deferredStream();
    const stderr = deferredStream();
    const exit = vi.fn();
    const bare = 'physical Phase A git rev-parse --is-bare-repository failed for /x/gh-1.git: fatal: not a git repository';
    const done = runPhysicalDrillCliToExit(['phase-a-observe', 'run-1'], {
      run: async () => {
        throw new Error(bare);
      },
      stdout,
      stderr,
      exit,
    });
    await vi.waitFor(() => expect(stderr.write).toHaveBeenCalledTimes(1));
    stderr.flush();
    await done;
    const line = `physical-drill-producer: phase-a-observe: ${bare}`;
    expect(stderr.chunks).toEqual([`${line}\n`]);
    expect(exit).toHaveBeenCalledWith(1);

    const dir = mkdtempSync(join(tmpdir(), 'pds-failure-line-'));
    try {
      const errFile = join(dir, 'physical-probe.stderr');
      writeFileSync(
        errFile,
        [
          'hive-git-physical-scenario: PHASE_START A phase_a_storage_join 2026-09-30T05:44:45.201Z',
          '[vmcall port=18572 source=env]',
          stderr.chunks.join('').trimEnd(),
          'hive-git-physical-probe: preserved failed-run diagnostics at /tmp/x.failure-diagnostics',
        ].join('\n') + '\n',
      );
      const summary = fileURLToPath(
        new URL('../../../../../papercusp-desktop/bin/lib/physical-failure-summary.sh', import.meta.url),
      );
      const result = spawnSync('bash', [summary, errFile], { encoding: 'utf8', timeout: 20_000 });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`phase A (phase_a_storage_join): ${line}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a message that already carries a physical-drill module prefix unchanged', () => {
    const own = 'physical-drill-host-receipt: cached announce identity/keychain mismatch at /x';
    expect(physicalDrillFailureLine('phase-b-announce', own)).toBe(own);
    expect(physicalDrillFailureLine(undefined, 'boom')).toBe('physical-drill-producer: <no mode>: boom');
  });

  // WI-10003811 / P-505 run 30: an observation read before the host converged
  // must still reach stdout, so the scenario's retry loop keeps it as evidence,
  // and must exit with the distinct retry code rather than a hard failure.
  it('prints incomplete evidence to stdout and exits 3 so the scenario can retry', async () => {
    const stdout = deferredStream();
    const stderr = deferredStream();
    const exit = vi.fn();
    const evidence = { stage: 'first-source', canonicalStagingOid: 'a'.repeat(40) };
    const done = runPhysicalDrillCliToExit(['phase-d-observe'], {
      run: async () => {
        throw new PhysicalDrillIncompleteEvidenceError('tower first-source has not converged: lagging canonical', evidence);
      },
      stdout,
      stderr,
      exit,
    });
    await vi.waitFor(() => expect(stdout.write).toHaveBeenCalledTimes(1));
    stdout.flush();
    await vi.waitFor(() => expect(stderr.write).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();
    stderr.flush();
    await done;
    expect(stdout.chunks).toEqual([`${JSON.stringify(evidence)}\n`]);
    expect(stderr.chunks).toEqual(['tower first-source has not converged: lagging canonical\n']);
    expect(PHYSICAL_DRILL_INCOMPLETE_EXIT).toBe(3);
    expect(exit).toHaveBeenCalledWith(3);
  });

  it('is what the self-exec entry runs, with a real process.exit', () => {
    const source = readFileSync(fileURLToPath(new URL('./physical-drill-producer.ts', import.meta.url)), 'utf8');
    const entry = source.slice(source.indexOf('const invokedPath = process.argv[1];'));
    expect(entry).toContain('runPhysicalDrillCliToExit(process.argv.slice(2)');
    expect(entry).toContain('exit: (code) => process.exit(code)');
    // Setting only exitCode is the shape that hung run 23.
    expect(source).not.toMatch(/process\.exitCode\s*=/);
  });
});

// WI-10003961 / P-521 F4: the scenario drives Phase J only through these modes.
describe('physicalPhaseJMode', () => {
  const runId = 'p521-physical-20260930T011500Z-1234';
  const observedAt = '2026-09-30T01:20:00.000Z';

  function heldObservation(attempts: number, heldMs: number): PhysicalPhaseJObservation {
    return {
      schemaVersion: PHASE_J_OBSERVATION_SCHEMA,
      hostId: 'vm',
      step: 'held',
      runId,
      observedAt,
      observerPid: 4242,
      writes: { A: { count: 0, row: null }, B: { count: 0, row: null } },
      cursors: [{
        harnessSlug: 'hello-world-3-pot',
        logKeyHex: 'ab'.repeat(32),
        position: 7,
        peerDevicePubkey: 'tower-device',
        updatedAt: observedAt,
        applyFailure: {
          position: 8,
          kind: 'retryable',
          groupKey: 'work_items/WI-501',
          reason: `57P03: p521 phase J bounded target-apply outage ${runId}`,
          errorCode: '57P03',
          attempts,
          firstSeenAt: Date.parse(observedAt) - heldMs,
          lastSeenAt: Date.parse(observedAt),
        },
      }],
      faultPresent: true,
    };
  }

  it('emits the tower create args for a run-bound write, and nothing else', async () => {
    await expect(physicalPhaseJMode('phase-j-write', ['A', runId])).resolves.toEqual({
      kind: 'task',
      title: phaseJWriteTitle(runId, 'A'),
      summary: phaseJWriteSummary(runId, 'A'),
      force: true,
    });
    await expect(physicalPhaseJMode('phase-j-write', ['C', runId])).rejects.toThrow(/usage: .*phase-j-write <A\|B>/);
    await expect(physicalPhaseJMode('phase-j-write', ['B'])).rejects.toThrow(/usage/);
  });

  it('only ever faults the VM, and routes each action to its own step', async () => {
    const install = vi.fn(async () => ({ action: 'install' }) as never);
    const remove = vi.fn(async () => ({ action: 'remove' }) as never);
    const sweep = vi.fn(async () => ({ removed: [], remaining: [] }));
    const deps = { install, remove, sweep };
    // The tower is the fleet's live bg-host: no mode may fault it.
    await expect(physicalPhaseJMode('phase-j-fault', ['tower', 'install', runId], deps)).rejects.toThrow(/usage/);
    await expect(physicalPhaseJMode('phase-j-fault', ['vm', 'drop', runId], deps)).rejects.toThrow(/usage/);
    await expect(physicalPhaseJMode('phase-j-fault', ['vm', 'install'], deps)).rejects.toThrow(/usage/);
    await expect(physicalPhaseJMode('phase-j-fault', ['vm', 'sweep', runId], deps)).rejects.toThrow(/usage/);
    expect(install).not.toHaveBeenCalled();
    await physicalPhaseJMode('phase-j-fault', ['vm', 'install', runId], deps);
    await physicalPhaseJMode('phase-j-fault', ['vm', 'remove', runId], deps);
    await physicalPhaseJMode('phase-j-fault', ['vm', 'sweep'], deps);
    expect(install).toHaveBeenCalledWith({ runId });
    expect(remove).toHaveBeenCalledWith({ runId });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('turns an unmet step into incomplete evidence (exit 3) that still carries the observation', async () => {
    const early = heldObservation(PHASE_J_MIN_ATTEMPTS - 1, PHASE_J_MIN_HOLD_MS - 1);
    const observe = vi.fn(async () => early);
    const error = await physicalPhaseJMode('phase-j-observe', ['vm', 'held', runId, 'WI-501'], { observe })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PhysicalDrillIncompleteEvidenceError);
    expect((error as PhysicalDrillIncompleteEvidenceError).evidence).toBe(early);
    expect((error as Error).message).toMatch(/attempts .* < .*held .*ms </);
    expect(observe).toHaveBeenCalledWith({ hostId: 'vm', step: 'held', runId, featureIds: ['WI-501'] });
  });

  it('returns the observation once the step is reached', async () => {
    const reached = heldObservation(PHASE_J_MIN_ATTEMPTS, PHASE_J_MIN_HOLD_MS);
    const observe = vi.fn(async () => reached);
    await expect(physicalPhaseJMode('phase-j-observe', ['vm', 'held', runId, 'WI-501'], { observe })).resolves.toBe(reached);
  });

  it('refuses a malformed held position before touching the database', async () => {
    const observe = vi.fn();
    await expect(
      physicalPhaseJMode('phase-j-observe', ['vm', 'replayed', runId, 'WI-501', 'ab'.repeat(32), '8x'], { observe }),
    ).rejects.toThrow(/held-position must be an integer/);
    await expect(physicalPhaseJMode('phase-j-observe', ['mac', 'held', runId], { observe })).rejects.toThrow(/usage/);
    expect(observe).not.toHaveBeenCalled();
  });

  it('rejects a verify input that does not prove the phase', async () => {
    const readInput = vi.fn(() => ({ schemaVersion: 'wrong' }));
    await expect(physicalPhaseJMode('phase-j-verify', ['/private/input.json'], { readInput })).rejects.toThrow(
      /Phase J rejected: schemaVersion must be/,
    );
    expect(readInput).toHaveBeenCalledWith('/private/input.json');
  });
});
