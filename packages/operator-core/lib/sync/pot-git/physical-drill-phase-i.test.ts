import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { existsSync } from 'node:fs';
import { verifyEd25519 } from '../../identity/ed25519';
import {
  PHASE_I_INPUT_SCHEMA,
  attemptPhysicalPhaseI,
  ownerSocketSigner,
  phaseIRepoKey,
  phaseICanaryOwnerSigner,
  startPhaseIOwner,
  validatePhysicalPhaseI,
  type PhysicalPhaseIInput,
} from './physical-drill-phase-i';
import { buildPhysicalPhaseIInput } from './physical-drill-phase-i.fixture';

const RUN_ID = 'p505-physical-20260930T010000Z-4242';
const tower = generateEd25519KeypairDer();
const vm = generateEd25519KeypairDer();
const signer = (key: Buffer) => async (bytes: Buffer) => signWithPrivateKeyDer(key, bytes);
const dirs: string[] = [];
let valid: PhysicalPhaseIInput;

/**
 * The whole leg on one machine: two host directories, an in-process owner that
 * is closed (not SIGKILLed) for the outage, and the same production sinks the
 * physical run drives.
 */
async function runLeg(): Promise<PhysicalPhaseIInput> {
  const vmDir = await mkdtemp(join(tmpdir(), 'phase-i-vm-'));
  const towerDir = await mkdtemp(join(tmpdir(), 'phase-i-tower-'));
  dirs.push(vmDir, towerDir);
  const startedAt = new Date().toISOString();
  const first = await startPhaseIOwner({ dir: vmDir, runId: RUN_ID, pid: 900_001 });
  const socket = join(vmDir, 'owner', 'owner.sock');
  const base = { runId: RUN_ID, hiveId: first.record.hiveId };
  const vmHost = { ...base, host: 'vm' as const, dir: vmDir, deviceKey: vm.pubkeyBase64, ownerSocket: socket };
  const towerHost = { ...base, host: 'tower' as const, dir: towerDir, deviceKey: tower.pubkeyBase64 };
  const vmDeps = { signDevice: signer(vm.privateKeyDer) };
  const towerDeps = { signDevice: signer(tower.privateKeyDer) };

  const liveVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'live' }, vmDeps);
  const liveTower = await attemptPhysicalPhaseI({ ...towerHost, step: 'live', vmLive: liveVm }, towerDeps);
  let closed = false;
  const lostVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'lost' }, {
    ...vmDeps,
    killOwner: async () => { await first.close(); closed = true; return true; },
  });
  const outageVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'outage' }, vmDeps);
  const outageTower = await attemptPhysicalPhaseI({ ...towerHost, step: 'outage', vmLive: liveVm, vmOutage: outageVm }, towerDeps);
  const restored = await startPhaseIOwner({ dir: vmDir, runId: RUN_ID, pid: 900_002 });
  const restoredVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'restored' }, vmDeps);
  const restoredTower = await attemptPhysicalPhaseI({ ...towerHost, step: 'restored', vmLive: liveVm }, towerDeps);
  await restored.close();
  return {
    schemaVersion: PHASE_I_INPUT_SCHEMA,
    runId: RUN_ID,
    window: { startedAt, finishedAt: new Date().toISOString() },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    owner: { first: first.record, restored: restored.record, goneAfterLost: closed },
    steps: {
      live: { vm: liveVm, tower: liveTower },
      lost: { vm: lostVm },
      outage: { vm: outageVm, tower: outageTower },
      restored: { vm: restoredVm, tower: restoredTower },
    },
  };
}

beforeAll(async () => { valid = await runLeg(); }, 300_000);
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

const clone = (): PhysicalPhaseIInput => structuredClone(valid);

describe('physical Phase I (P-521 F6 protected effects)', () => {
  it('only the single owning hive authorizes; every other authority is refused with no effect', () => {
    const verdict = validatePhysicalPhaseI(valid);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
    // live owner x5 + restored owner x5 + push #1 before the owner died.
    expect(verdict.result?.counts.authorized).toBe(11);
    // live: 5 stale-scope + 20 tower; outage: 5 VM + 15 tower; restored: 15 tower; lost: push #2 + submodule.
    expect(verdict.result?.counts.refused).toBe(62);
  });

  it('the advisory views diverge at one roster epoch', () => {
    const { vm: v, tower: t } = valid.steps.live;
    expect(v.advisory.rosterEpoch).toBe(t.advisory.rosterEpoch);
    expect([v.advisory.isSelf, t.advisory.isSelf]).toEqual([true, true]);
    expect(v.advisory.leaderDevicePubkey).not.toBe(t.advisory.leaderDevicePubkey);
  });

  it('a genuine replayed owner proof is refused on the tower', () => {
    const replay = valid.steps.live.tower.attempts.filter((a) => a.variant === 'replayed-owner-proof');
    expect(replay).toHaveLength(5);
    for (const a of replay) {
      expect(a.ok).toBe(false);
      expect(a.after.protected).toEqual(a.before.protected);
    }
  });

  it('losing the owner between pushes freezes the next push; restoring it permits fresh progress', () => {
    const lost = valid.steps.lost.vm.lost!;
    expect(lost.push1.ok).toBe(true);
    expect(lost.forkPr.reason).toMatch(/open PR authorization failed/);
    expect(lost.push2.ok).toBe(false);
    expect(lost.push2.after.protected.githubMain).toBe(lost.push1.candidate);
    const restoredGithub = valid.steps.restored.vm.attempts.find((a) => a.effect === 'github-push' && a.variant === 'owner')!;
    expect(restoredGithub.ok).toBe(true);
    expect(restoredGithub.after.protected.githubMain).not.toBe(lost.push1.candidate);
  });

  // Falsifiability: each mutation removes exactly one property the leg proves.
  const mutations: Array<[string, (i: PhysicalPhaseIInput) => void, RegExp]> = [
    ['a refused attempt moved a protected ref', (i) => { i.steps.live.tower.attempts[2]!.after.protected.githubMain = 'f'.repeat(40); }, /protected target moved/],
    ['a refusal did not come from the fence', (i) => { i.steps.outage.tower.attempts[0]!.reason = 'not-advanced'; }, /owning-hive fence/],
    ['a denied sink reported success', (i) => { i.steps.lost.vm.lost!.push2.ok = true; }, /sink reported the effect happened/],
    ['restoration replaced the key', (i) => { i.owner.restored.hiveId = tower.pubkeyBase64; }, /SAME hive key/],
    ['the key was minted twice', (i) => { i.owner.restored.mintedKey = true; }, /minted exactly once/],
    ['advisory epochs differ', (i) => { i.steps.live.tower.advisory.rosterEpoch += 1; }, /shared roster epoch/],
    ['an attempt is missing', (i) => { i.steps.outage.vm.attempts.pop(); }, /attempt matrix/],
    ['device-head exchange was refused', (i) => { i.steps.outage.tower.deviceHeadAcceptance = { ok: false, reason: 'bad-signature' }; }, /device head/],
    ['the tower held the owner key', (i) => { i.steps.restored.tower.ownerKeyMaterialOnHost = true; }, /owner key is present on the tower/],
    ['an owner push used force', (i) => { i.steps.live.vm.attempts[2]!.pushArgs.push(['push', '--force', 'x']); }, /used force/],
    ['the owner was never confirmed gone', (i) => { i.owner.goneAfterLost = false; }, /owner process was gone/],
    ['a PR opened after the owner died', (i) => { i.steps.lost.vm.lost!.forkPr.after.protected.pullRequests.push({ number: 99, headRef: 'x' }); }, /PR opened after the owner died/],
    ['no fresh progress after restore', (i) => {
      const live = i.steps.live.vm.attempts.find((a) => a.variant === 'owner' && a.effect === 'release-promotion')!;
      i.steps.restored.vm.attempts.find((a) => a.effect === 'release-promotion')!.candidate = live.candidate;
    }, /release-promotion/],
    ['the attempt ran inside the owner', (i) => { i.steps.outage.tower.attemptPid = i.owner.first.pid; }, /inside the owner process/],
  ];
  it.each(mutations)('rejects evidence where %s', (_label, mutate, message) => {
    const input = clone();
    mutate(input);
    const verdict = validatePhysicalPhaseI(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(message);
  });
});

describe('physical Phase I canary-owner target (WI-10004748, D-119)', () => {
  const canary = { workspaceId: 'papercusp-workspace', potHomeSlug: 'hello-world-3-pot', repoKey: 'hello-world-3-pot:main' };
  const build = () => buildPhysicalPhaseIInput({ runId: RUN_ID, towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64, startMs: Date.parse('2026-10-04T00:00:00.000Z'), canary });

  it('resolves only the existing matching hive key and signs through that keychain scope', async () => {
    const key = generateEd25519KeypairDer();
    const target = { kind: 'canary-owner' as const, ...canary, hiveId: key.pubkeyBase64 };
    const loadKeyStatus = vi.fn(async () => ({ kind: 'ok' as const, pubkeyBase64: key.pubkeyBase64 }));
    const sign = vi.fn(async (_workspace: string, _slug: string, bytes: Buffer) => signWithPrivateKeyDer(key.privateKeyDer, bytes));
    const owner = await phaseICanaryOwnerSigner(target, { loadKeyStatus, sign });
    const bytes = Buffer.from('existing-owner-proof');
    expect(verifyEd25519(bytes, target.hiveId, await owner.sign(bytes))).toBe(true);
    expect(loadKeyStatus).toHaveBeenCalledWith(canary.workspaceId, canary.potHomeSlug);
    expect(sign).toHaveBeenCalledWith(canary.workspaceId, canary.potHomeSlug, bytes);
    for (const status of [{ kind: 'not_found' as const }, { kind: 'error' as const, reason: 'locked' }, { kind: 'ok' as const, pubkeyBase64: vm.pubkeyBase64 }]) {
      const refusedSign = vi.fn();
      await expect(phaseICanaryOwnerSigner(target, { loadKeyStatus: async () => status, sign: refusedSign })).rejects.toThrow(/unavailable or foreign/);
      expect(refusedSign).not.toHaveBeenCalled();
    }
  });

  it('keeps the actual canary observation and repoKey in a production-sink attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase-i-canary-receipt-'));
    dirs.push(dir);
    const input = build();
    if (input.target?.kind !== 'canary-owner') throw new Error('canary fixture missing');
    const observation = input.target.realTargets.beforeOutage;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let result;
    try {
      result = await attemptPhysicalPhaseI({ host: 'tower', step: 'live', dir, runId: RUN_ID,
      deviceKey: tower.pubkeyBase64, hiveId: input.target.hiveId, repoKey: canary.repoKey,
      vmLive: input.steps.live.vm, realTargetSnapshot: observation }, { signDevice: signer(tower.privateKeyDer) });
      expect(warning.mock.calls.some((args) => /git-sync publication refused: hive-effect-authority/.test(args.join(' ')))).toBe(true);
    } finally { warning.mockRestore(); }
    expect(result.repoKey).toBe(canary.repoKey);
    expect(result.realTargetSnapshot).toEqual(observation);
    expect(result.realTargetSnapshot).not.toBe(observation);
    expect(result.attempts.every((attempt) => !attempt.ok && JSON.stringify(attempt.before.protected) === JSON.stringify(attempt.after.protected))).toBe(true);
    // A runner failure also freezes refs, but proves nothing about authority.
    // Every sink must reach the authority fence, including git-sync's private-index commit.
    expect(result.attempts.every((attempt) => /owning hive key|missing-hive-authority/.test(attempt.reason ?? ''))).toBe(true);
    await expect(attemptPhysicalPhaseI({ host: 'tower', step: 'live', dir, runId: RUN_ID,
      deviceKey: tower.pubkeyBase64, hiveId: input.target.hiveId, repoKey: canary.repoKey,
      realTargetSnapshot: { ...observation, forkRefs: undefined } as never }, { signDevice: signer(tower.privateKeyDer) })).rejects.toThrow(/complete observation/);
  }, 60_000);

  it('owner signs through the host keychain: never mints, never writes a key file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase-i-canary-owner-'));
    dirs.push(dir);
    const hive = generateEd25519KeypairDer();
    const owner = await startPhaseIOwner({ dir, runId: RUN_ID, pid: 900_101, signer: { hiveId: hive.pubkeyBase64, sign: signer(hive.privateKeyDer) } });
    try {
      expect(owner.record).toMatchObject({ hiveId: hive.pubkeyBase64, mintedKey: false, keySource: 'host-keychain' });
      expect(existsSync(join(dir, 'owner', 'hive-key.der'))).toBe(false);
      const bytes = Buffer.from('canary-owner-probe');
      const signature = await ownerSocketSigner(join(dir, 'owner', 'owner.sock'))(bytes);
      expect(verifyEd25519(bytes, hive.pubkeyBase64, signature)).toBe(true);
    } finally {
      await owner.close();
    }
  });

  it('refuses the run-bound drill key as a canary repo_key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase-i-canary-attempt-'));
    dirs.push(dir);
    await expect(attemptPhysicalPhaseI(
      { host: 'tower', step: 'live', dir, runId: RUN_ID, deviceKey: tower.pubkeyBase64, hiveId: vm.pubkeyBase64, repoKey: phaseIRepoKey(RUN_ID) },
      { signDevice: signer(tower.privateKeyDer) },
    )).rejects.toThrow(/real repo_key/);
  });

  it('accepts a canary-owner run bound to the real key, repo_key and G1/G3 refs', () => {
    const verdict = validatePhysicalPhaseI(build());
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  const canaryMutations: Array<[string, (i: PhysicalPhaseIInput) => void, RegExp]> = [
    ['the canary owner minted a key', (i) => { i.owner.first.mintedKey = true; }, /must never mint/],
    ['the canary owner used a drill key file', (i) => { i.owner.restored.keySource = 'drill-minted'; }, /real hive key/],
    ['the owner key is not the target hive', (i) => { if (i.target?.kind === 'canary-owner') i.target.hiveId = vm.pubkeyBase64; }, /not the canary hive key/],
    ['attempts were scoped by the drill repo_key', (i) => { i.steps.live.vm.repoKey = phaseIRepoKey(i.runId); }, /not bound to this run/],
    ['real refs moved during the outage', (i) => { if (i.target?.kind === 'canary-owner') i.target.realTargets.duringOutage.releaseRef = 'e'.repeat(40); }, /G1/],
    ['no real advance after recovery', (i) => { if (i.target?.kind === 'canary-owner') i.target.realTargets.afterRecovery.stagingRef = i.target.realTargets.duringOutage.stagingRef; }, /G3/],
    ['real-target snapshots are missing', (i) => { if (i.target?.kind === 'canary-owner') (i.target as { realTargets?: unknown }).realTargets = undefined; }, /real-target snapshots/],
  ];
  it.each(canaryMutations)('rejects canary evidence where %s', (_label, mutate, message) => {
    const input = build();
    mutate(input);
    const verdict = validatePhysicalPhaseI(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(message);
  });

  it('an ephemeral run claiming a host-keychain owner is refused', () => {
    const input = buildPhysicalPhaseIInput({ runId: RUN_ID, towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64, startMs: Date.parse('2026-10-04T00:00:00.000Z') });
    input.owner.first.keySource = 'host-keychain';
    expect(validatePhysicalPhaseI(input).errors.join('\n')).toMatch(/drill-minted key/);
  });
});
