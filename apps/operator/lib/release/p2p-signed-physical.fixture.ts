/** Private signed unit fixture reused from hive-git-drill-zero-skip-guard.test.ts.
 * The maintained Phase D-J validators, host receipts and real crypto define its
 * bytes. No rig is run and no real physical evidence is emitted by this helper.
 * WI-6554700010020476; caller owns the temporary directory and cleanup.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { physicalDrillSigningBytes } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-evidence';
import { physicalDrillHostReceiptSigningBytes } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt';
import { PHASE_A_REPO_KEY, physicalDrillGitSyncSlug } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-a';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../../packages/operator-core/lib/identity/ed25519';
import { stagingAdvanceSigningBytes } from '../../../../packages/operator-core/lib/sync/pot-git/staging-advance';
import { PHASE_G_INPUT_SCHEMA, executePhysicalPhaseG, type PhysicalPhaseGInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-g';
import { buildPhysicalPhaseHInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-h.fixture';
import { buildPhysicalPhaseIInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.fixture';
import { buildPhysicalPhaseJInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-j.fixture';

export async function buildSignedPhysicalFixture(evidenceDir: string, offsetMs = 0,
  pins: { sourceSha: string; artifactDigest: string } | Record<string, never> = {}) {
  const at = (stamp: string) => new Date(Date.parse(stamp) + offsetMs).toISOString();
  const physicalRunId = `private-physical-run-${offsetMs}`;
  let fixtureTrust: Record<string, any> | undefined;
  let signingDevices: ReturnType<typeof generateEd25519KeypairDer>[] = [];
  const baselineTower = generateEd25519KeypairDer();
  const baselineVm = generateEd25519KeypairDer();
  const result = await executePhysicalPhaseG(
    { runId: physicalRunId, towerDeviceKey: baselineTower.pubkeyBase64, vmDeviceKey: baselineVm.pubkeyBase64 },
    { now: () => at('2026-08-13T12:20:00Z') },
  );
  const physicalPhaseGBaseline: PhysicalPhaseGInput = {
    schemaVersion: PHASE_G_INPUT_SCHEMA, runId: physicalRunId,
    window: { startedAt: at('2026-08-13T12:19:00Z'), finishedAt: at('2026-08-13T12:21:00Z') },
    identities: { towerDeviceKey: baselineTower.pubkeyBase64, vmDeviceKey: baselineVm.pubkeyBase64 }, result,
  };
  function physicalLegD(
    tower: ReturnType<typeof generateEd25519KeypairDer>,
    vm: ReturnType<typeof generateEd25519KeypairDer>,
  ): Record<string, any> {
    const runId = physicalRunId;
    const base = 'a'.repeat(40);
    const first = 'b'.repeat(40);
    const second = 'c'.repeat(40);
    const dirtyHash = 'd'.repeat(64);
    const advance = (seq: number, stagingSha: string, ts: number) => {
      const payload = {
        v: 1,
        device_pubkey: tower.pubkeyBase64,
        epoch: 9,
        seq,
        staging_sha: stagingSha,
        ts,
      };
      return {
        ...payload,
        sig: signWithPrivateKeyDer(tower.privateKeyDer, stagingAdvanceSigningBytes(payload)).toString('base64'),
      };
    };
    const firstAdvance = advance(1, first, Date.parse(at('2026-08-13T12:12:00Z')));
    const secondAdvance = advance(2, second, Date.parse(at('2026-08-13T12:17:00Z')));
    const trigger = (host: 'tower' | 'vm', role: string, startedAt: string, finishedAt: string) => ({
      tool: 'git-sync:run',
      installSlug: physicalDrillGitSyncSlug(host),
      host,
      role,
      fired: true,
      startedAt,
      finishedAt,
    });
    const observation = (input: {
      hostId: 'tower' | 'vm';
      stage: string;
      stagingSha: string;
      rowId: number;
      seq: number;
      observedAt: string;
      worktreeHead?: string;
      dirty?: boolean;
    }) => ({
      schemaVersion: 'hive-git-physical-phase-d-observation/v1',
      hostId: input.hostId,
      runId,
      stage: input.stage,
      observedAt: input.observedAt,
      repoPath: `/${input.hostId}/.papercusp/pot-git/hello-world-3-pot/${PHASE_A_REPO_KEY}.git`,
      worktreePath: `/${input.hostId}/hello-world-3-pot`,
      integratorDeviceKey: tower.pubkeyBase64,
      integratorNamespaceStagingOid: input.stagingSha,
      canonicalStagingOid: input.stagingSha,
      worktreeHeadOid: input.worktreeHead ?? input.stagingSha,
      dirtyPaths: input.dirty ? ['p505-phase-d-overlap.txt'] : [],
      protectedPath: 'p505-phase-d-overlap.txt',
      protectedFileSha256: input.dirty ? dirtyHash : null,
      cursor: {
        lastEventId: input.rowId,
        epochSeq: { epoch: 9, seq: input.seq },
        stagingSha: input.stagingSha,
      },
    });
    const event = (hostId: 'tower' | 'vm', rowId: number, observedAt: string, payload: Record<string, any>) => ({
      schemaVersion: 'hive-git-physical-phase-d-event/v1',
      hostId,
      rowId,
      observedAt,
      key: 'pot-git:staging-advance',
      source: 'git-sync-integrator',
      repoKey: PHASE_A_REPO_KEY,
      payload,
    });
    const pending = {
      workspaceId: 'papercusp-workspace',
      potSlug: 'hello-world-3-pot',
      repoKey: PHASE_A_REPO_KEY,
      devicePubkey: vm.pubkeyBase64,
      headSha: first,
      authorGithubUserId: 4243,
      reason: 'below-steer-tier',
      state: 'pending',
      createdTs: Date.parse(at('2026-08-13T12:10:30Z')),
      ratifiedTs: null,
    };
    return {
      schemaVersion: 'hive-git-physical-phase-d-input/v1',
      runId,
      window: { startedAt: at('2026-08-13T12:08:00Z'), finishedAt: at('2026-08-13T12:19:00Z') },
      identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
      belowSteer: {
        mutation: {
          schemaVersion: 'hive-git-physical-phase-d-mutation/v1',
          runId,
          kind: 'below-steer',
          sourceHost: 'vm',
          sourceDeviceKey: vm.pubkeyBase64,
          method: 'fixed-worktree-commit',
          worktreePath: '/vm/hello-world-3-pot',
          protectedPath: 'p505-phase-d-overlap.txt',
          baseOid: base,
          headOid: first,
          payloadSha256: '1'.repeat(64),
          createdAt: at('2026-08-13T12:09:00Z'),
        },
        publishTrigger: trigger('vm', 'below-steer-publish', at('2026-08-13T12:09:10Z'), at('2026-08-13T12:09:30Z')),
        queueTrigger: trigger('tower', 'queue-receive', at('2026-08-13T12:10:00Z'), at('2026-08-13T12:10:20Z')),
        pendingReceipt: pending,
        ratification: {
          schemaVersion: 'hive-git-physical-phase-d-ratification/v1',
          tool: 'ratifyIntegrationRequest',
          accepted: true,
          observedAt: at('2026-08-13T12:11:00Z'),
          pending,
          ratified: { ...pending, state: 'ratified', ratifiedTs: Date.parse(at('2026-08-13T12:11:00Z')) },
        },
      },
      firstAdvance: {
        integratorTrigger: trigger('tower', 'ratified-integrate', at('2026-08-13T12:11:10Z'), at('2026-08-13T12:11:40Z')),
        sourceEvent: event('tower', 101, at('2026-08-13T12:12:01Z'), firstAdvance),
        destinationEvent: event('vm', 501, at('2026-08-13T12:12:10Z'), firstAdvance),
        destinationTrigger: trigger('vm', 'first-bridge', at('2026-08-13T12:12:20Z'), at('2026-08-13T12:12:40Z')),
        sourceObservation: observation({ hostId: 'tower', stage: 'first-source', stagingSha: first, rowId: 101, seq: 1, observedAt: at('2026-08-13T12:12:41Z') }),
        destinationObservation: observation({ hostId: 'vm', stage: 'first-destination', stagingSha: first, rowId: 501, seq: 1, observedAt: at('2026-08-13T12:12:42Z') }),
      },
      dirtyAdvance: {
        mutation: {
          schemaVersion: 'hive-git-physical-phase-d-mutation/v1',
          runId,
          kind: 'dirty-overlap',
          sourceHost: 'tower',
          sourceDeviceKey: tower.pubkeyBase64,
          method: 'fixed-worktree-commit',
          worktreePath: '/tower/hello-world-3-pot',
          protectedPath: 'p505-phase-d-overlap.txt',
          baseOid: first,
          headOid: second,
          payloadSha256: '2'.repeat(64),
          createdAt: at('2026-08-13T12:15:00Z'),
        },
        integratorTrigger: trigger('tower', 'dirty-integrate', at('2026-08-13T12:16:10Z'), at('2026-08-13T12:16:40Z')),
        sourceEvent: event('tower', 102, at('2026-08-13T12:17:01Z'), secondAdvance),
        destinationEvent: event('vm', 502, at('2026-08-13T12:17:10Z'), secondAdvance),
        destinationTrigger: trigger('vm', 'dirty-bridge', at('2026-08-13T12:17:20Z'), at('2026-08-13T12:17:40Z')),
        dirtyBefore: observation({ hostId: 'vm', stage: 'dirty-before', stagingSha: first, rowId: 501, seq: 1, observedAt: at('2026-08-13T12:14:00Z'), dirty: true }),
        dirtyAfter: observation({ hostId: 'vm', stage: 'dirty-after', stagingSha: second, worktreeHead: first, rowId: 502, seq: 2, observedAt: at('2026-08-13T12:17:41Z'), dirty: true }),
      },
    };
  }

  function physicalLegE(
    tower: ReturnType<typeof generateEd25519KeypairDer>,
    vm: ReturnType<typeof generateEd25519KeypairDer>,
  ): Record<string, any> {
    const runId = physicalRunId;
    const upstreamBefore = '1'.repeat(40);
    const ingress = '2'.repeat(40);
    const canonicalBefore = '3'.repeat(40);
    const canonicalAfter = '4'.repeat(40);
    const divergence = '5'.repeat(40);
    const clearBridge = {
      at: Date.parse(at('2026-08-13T12:21:40Z')),
      ran: true,
      skipped: null,
      egressTarget: 'fork',
      lastAdmitted: ingress,
      egressHead: canonicalAfter,
      divergence: 'clear',
      needsOwner: false,
      errors: [],
    };
    const trigger = (
      host: 'tower' | 'vm',
      role: string,
      startedAt: string,
      finishedAt: string,
    ) => ({
      tool: 'git-sync:run',
      installSlug: physicalDrillGitSyncSlug(host),
      host,
      role,
      fired: true,
      startedAt,
      finishedAt,
    });
    const observation = (input: {
      hostId: 'tower' | 'vm';
      deviceKey: string;
      stage: string;
      observedAt: string;
      mode: 'legacy' | 'bridged';
      canonical?: string;
      upstream?: string;
      remote?: string;
      bridge?: Record<string, any> | null;
      bridgeEscalation?: Record<string, any> | null;
    }) => ({
      schemaVersion: 'hive-git-physical-phase-e-observation/v1',
      runId,
      hostId: input.hostId,
      deviceKey: input.deviceKey,
      stage: input.stage,
      observedAt: input.observedAt,
      mode: { value: input.mode, source: 'set' },
      routine: {
        active: true,
        lastFiredAt: input.observedAt,
        pushMode: input.mode === 'bridged' ? 'commit-only:bridged' : 'legacy',
        lastStatus: 'ok',
        lastPushed: [],
        headSha: input.canonical ?? canonicalAfter,
        watchdogAlerted: false,
        watchdogErrorSweeps: 0,
        watchdogStallSweeps: 0,
        githubBridge: input.bridge ?? null,
        // WI-10004055: the finished fire whose verdict this observation read.
        fire: {
          active: false,
          phase: 'complete',
          startedAt: Date.parse(input.observedAt) - 1,
          completedAt: Date.parse(input.observedAt) - 1,
          outcomeStatus: 'nothing',
        },
      },
      refs: {
        canonicalStaging: input.canonical ?? canonicalAfter,
        upstreamDefault: input.upstream ?? ingress,
        remoteStaging: input.remote ?? canonicalAfter,
      },
      bridgeEscalation: input.bridgeEscalation ?? null,
      watchdogEscalation: null,
    });
    const watchdog = (ordinal: 1 | 2, startedAt: string, finishedAt: string) => ({
      schemaVersion: 'hive-git-physical-phase-e-watchdog/v1',
      runId,
      hostId: 'tower',
      ordinal,
      tool: 'checkGitSyncStall',
      startedAt,
      finishedAt,
      fixedRoutineActive: true,
      fixedPushMode: 'commit-only:bridged',
      fixedWatchdogAlerted: false,
      fixedWatchdogErrorSweeps: 0,
      fixedWatchdogStallSweeps: 0,
      alarmed: [],
      recovered: [],
    });
    return {
      schemaVersion: 'hive-git-physical-phase-e-input/v1',
      runId,
      window: { startedAt: at('2026-08-13T12:19:00Z'), finishedAt: at('2026-08-13T12:28:00Z') },
      identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
      before: {
        tower: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'legacy-before', observedAt: at('2026-08-13T12:19:10Z'), mode: 'legacy', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore }),
        vm: observation({ hostId: 'vm', deviceKey: vm.pubkeyBase64, stage: 'legacy-before', observedAt: at('2026-08-13T12:19:20Z'), mode: 'legacy', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore }),
      },
      activation: {
        modeChange: {
          schemaVersion: 'hive-git-physical-phase-e-mode-change/v1',
          runId,
          hostId: 'tower',
          tool: 'setPotGitMode',
          from: 'legacy',
          to: 'bridged',
          workspaceId: 'papercusp-workspace',
          potHomeSlug: 'hello-world-3-pot',
          observedAt: at('2026-08-13T12:19:30Z'),
        },
        towerTrigger: trigger('tower', 'tower-member', at('2026-08-13T12:19:40Z'), at('2026-08-13T12:19:50Z')),
        vmTrigger: trigger('vm', 'vm-member', at('2026-08-13T12:20:00Z'), at('2026-08-13T12:20:10Z')),
        tower: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'bridged-member', observedAt: at('2026-08-13T12:20:20Z'), mode: 'bridged', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore, bridge: { ...clearBridge, at: Date.parse(at('2026-08-13T12:20:10Z')) } }),
        vm: observation({ hostId: 'vm', deviceKey: vm.pubkeyBase64, stage: 'bridged-member', observedAt: at('2026-08-13T12:20:30Z'), mode: 'bridged', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore }),
      },
      healthy: {
        ingressMutation: {
          schemaVersion: 'hive-git-physical-phase-e-mutation/v1',
          runId,
          kind: 'ingress',
          hostId: 'tower',
          method: 'fixed-empty-commit-ff-push',
          remoteRole: 'upstream',
          remoteRef: 'refs/heads/main',
          baseOid: upstreamBefore,
          canonicalOid: canonicalBefore,
          headOid: ingress,
          createdAt: at('2026-08-13T12:21:00Z'),
        },
        ingressTrigger: trigger('tower', 'healthy-ingress', at('2026-08-13T12:21:10Z'), at('2026-08-13T12:21:15Z')),
        integrateTrigger: trigger('tower', 'healthy-integrate', at('2026-08-13T12:21:20Z'), at('2026-08-13T12:21:25Z')),
        egressTrigger: trigger('tower', 'healthy-egress', at('2026-08-13T12:21:30Z'), at('2026-08-13T12:21:35Z')),
        observation: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'healthy-egress', observedAt: at('2026-08-13T12:21:40Z'), mode: 'bridged', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter, bridge: clearBridge }),
      },
      watchdogSweeps: [
        watchdog(1, at('2026-08-13T12:22:00Z'), at('2026-08-13T12:22:01Z')),
        watchdog(2, at('2026-08-13T12:24:00Z'), at('2026-08-13T12:24:01Z')),
      ],
      divergence: {
        before: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'divergence-before', observedAt: at('2026-08-13T12:25:00Z'), mode: 'bridged', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter, bridge: clearBridge }),
        mutation: {
          schemaVersion: 'hive-git-physical-phase-e-mutation/v1',
          runId,
          kind: 'fork-ahead',
          hostId: 'tower',
          method: 'fixed-empty-commit-ff-push',
          remoteRole: 'fork',
          remoteRef: 'refs/heads/staging',
          baseOid: canonicalAfter,
          canonicalOid: canonicalAfter,
          headOid: divergence,
          createdAt: at('2026-08-13T12:25:10Z'),
        },
        trigger: trigger('tower', 'divergence-egress', at('2026-08-13T12:25:20Z'), at('2026-08-13T12:25:30Z')),
        after: observation({
          hostId: 'tower',
          deviceKey: tower.pubkeyBase64,
          stage: 'divergence-after',
          observedAt: at('2026-08-13T12:25:40Z'),
          mode: 'bridged',
          canonical: canonicalAfter,
          upstream: ingress,
          remote: divergence,
          // WI-10004055: the verdict of the divergence-egress fire, written after its trigger.
          bridge: { ...clearBridge, at: Date.parse(at('2026-08-13T12:25:35Z')), divergence: 'escalate' },
          bridgeEscalation: { signals: [{ kind: 'egress-non-ff', localSha: canonicalAfter, remoteSha: divergence }] },
        }),
        recovery: {
          schemaVersion: 'hive-git-physical-phase-e-recovery/v1',
          runId,
          hostId: 'tower',
          method: 'fixed-force-with-lease-restore',
          remoteRef: 'refs/heads/staging',
          expectedDivergenceOid: divergence,
          restoredOid: canonicalAfter,
          observedRemoteOid: canonicalAfter,
          observedAt: at('2026-08-13T12:26:00Z'),
        },
      },
      rollback: {
        modeChange: {
          schemaVersion: 'hive-git-physical-phase-e-mode-change/v1',
          runId,
          hostId: 'tower',
          tool: 'setPotGitMode',
          from: 'bridged',
          to: 'legacy',
          workspaceId: 'papercusp-workspace',
          potHomeSlug: 'hello-world-3-pot',
          observedAt: at('2026-08-13T12:27:00Z'),
        },
        towerTrigger: trigger('tower', 'rollback-observe', at('2026-08-13T12:27:10Z'), at('2026-08-13T12:27:15Z')),
        vmTrigger: trigger('vm', 'rollback-observe', at('2026-08-13T12:27:20Z'), at('2026-08-13T12:27:25Z')),
        tower: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'legacy-after', observedAt: at('2026-08-13T12:27:30Z'), mode: 'legacy', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter }),
        vm: observation({ hostId: 'vm', deviceKey: vm.pubkeyBase64, stage: 'legacy-after', observedAt: at('2026-08-13T12:27:40Z'), mode: 'legacy', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter }),
      },
    };
  }

  function physicalLegF(
    tower: ReturnType<typeof generateEd25519KeypairDer>,
    vm: ReturnType<typeof generateEd25519KeypairDer>,
  ): Record<string, any> {
    const runId = physicalRunId;
    const namespace = (deviceKey: string) => Buffer.from(deviceKey, 'base64').toString('hex');
    const hostResult = (
      hostId: 'tower' | 'vm',
      deviceKey: string,
      peerDeviceKey: string,
      observedAt: string,
    ) => {
      const live = namespace(deviceKey);
      const departed = namespace(peerDeviceKey);
      const beforeRefs = [
        `refs/namespaces/${departed}/published/v1`,
        `refs/namespaces/${live}/published/v1`,
        `refs/namespaces/${live}/published/v2`,
        `refs/namespaces/${live}/published/v3`,
        `refs/namespaces/${live}/refs/heads/work`,
      ].sort();
      const afterRefs = [
        `refs/archive/namespaces/${departed}/published/v1`,
        `refs/namespaces/${live}/published/v2`,
        `refs/namespaces/${live}/published/v3`,
        `refs/namespaces/${live}/refs/heads/work`,
      ].sort();
      return {
        schemaVersion: 'hive-git-physical-phase-f-host/v1',
        runId,
        planItem: 'P-307',
        hostId,
        deviceKey,
        peerDeviceKey,
        observedAt,
        productionSurfaces: ['gcHiveGitRepo', 'checkPublishGuard'],
        namespaces: { live, departed },
        gc: {
          beforeRefs,
          afterRefs,
          result: {
            archivedNamespaces: [departed],
            deletedRefs: [
              `refs/namespaces/${live}/published/v1`,
              `refs/namespaces/${departed}/published/v1`,
            ],
            errors: [],
            keptRefs: afterRefs.filter((ref) => ref.startsWith('refs/namespaces/')),
            reclaimedTmpPacks: 0,
            reclaimedTmpPackBytes: 0,
          },
        },
        guards: {
          clean: {
            ok: true,
            refusalCode: null,
            newObjectCount: 3,
            newTotalBytes: 280,
            oversizeCount: 0,
            secretFindingCount: 0,
            errors: [],
          },
          secret: {
            ok: false,
            refusalCode: 'secrets',
            newObjectCount: 3,
            newTotalBytes: 340,
            oversizeCount: 0,
            secretFindingCount: 1,
            errors: ['credential.txt: planted AWS access key'],
          },
          oversized: {
            ok: false,
            refusalCode: 'blob-over-cap',
            newObjectCount: 3,
            newTotalBytes: 6_400,
            oversizeCount: 1,
            secretFindingCount: 0,
            errors: ['oversized.bin: 6144 bytes > cap 4096'],
          },
        },
        temporaryReposRemoved: true,
      };
    };
    return {
      schemaVersion: 'hive-git-physical-phase-f-input/v1',
      runId,
      window: { startedAt: at('2026-08-13T12:28:00Z'), finishedAt: at('2026-08-13T12:29:50Z') },
      identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
      hostResults: [
        hostResult('tower', tower.pubkeyBase64, vm.pubkeyBase64, at('2026-08-13T12:29:00Z')),
        hostResult('vm', vm.pubkeyBase64, tower.pubkeyBase64, at('2026-08-13T12:29:30Z')),
      ],
    };
  }

  function physicalFixture(): Record<string, any> {
    const towerLog = join(evidenceDir, 'tower.log');
    const vmLog = join(evidenceDir, 'vm.log');
    writeFileSync(towerLog, 'tower physical witness\n');
    writeFileSync(vmLog, 'vm physical witness\n');
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const tower = generateEd25519KeypairDer();
    const vm = generateEd25519KeypairDer();
    signingDevices = [tower, vm];
    const fixture: Record<string, any> = {
      schemaVersion: 'hive-git-physical-evidence/v3',
      plan: 'p2p-git-live-activation-2026-07-09',
      runId: physicalRunId,
      window: { startedAt: at('2026-08-13T12:00:00Z'), finishedAt: at('2026-08-13T12:30:00Z') },
      topology: {
        kind: 'two-physical-machines',
        hosts: [
          { id: 'tower', deviceKey: tower.pubkeyBase64 },
          { id: 'vm', deviceKey: vm.pubkeyBase64 },
        ],
      },
      artifacts: [
        { host: 'tower', path: towerLog, sha256: digest(towerLog) },
        { host: 'vm', path: vmLog, sha256: digest(vmLog) },
      ],
      legVerdicts: [...'ABCDEFGHIJ'].map((leg, index) => ({
        leg,
        status: 'pass',
        scope: 'physical',
        observedAt: at(`2026-08-13T12:${String(index).padStart(2, '0')}:00Z`),
      })),
      legD: physicalLegD(tower, vm),
      legE: physicalLegE(tower, vm),
      legF: physicalLegF(tower, vm),
      legG: (() => {
        const input = structuredClone(physicalPhaseGBaseline);
        input.identities = { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 };
        input.result.physicalExecutionBinding = {
          provenance: 'outer-manifest-host-receipts',
          towerDeviceKey: tower.pubkeyBase64,
          vmDeviceKey: vm.pubkeyBase64,
        };
        return input;
      })(),
      legH: buildPhysicalPhaseHInput({
        runId: physicalRunId,
        towerDeviceKey: tower.pubkeyBase64,
        vmDeviceKey: vm.pubkeyBase64,
        startMs: Date.parse(at('2026-08-13T12:20:00Z')),
      }),
      legI: buildPhysicalPhaseIInput({
        runId: physicalRunId,
        towerDeviceKey: tower.pubkeyBase64,
        vmDeviceKey: vm.pubkeyBase64,
        startMs: Date.parse(at('2026-08-13T12:25:00Z')),
      }),
      // PHASE_J_FIXTURE_WINDOW_MS is 5min, so 12:24–12:29 sits inside the 12:00–12:30 run window.
      legJ: buildPhysicalPhaseJInput({
        runId: physicalRunId,
        towerDeviceKey: tower.pubkeyBase64,
        vmDeviceKey: vm.pubkeyBase64,
        startMs: Date.parse(at('2026-08-13T12:24:00Z')),
      }),
    };
    Object.assign(fixture, pins);
    const bytes = physicalDrillSigningBytes(fixture);
    fixture.attestations = [tower, vm].map((device) => ({
      deviceKey: device.pubkeyBase64,
      signature: signWithPrivateKeyDer(device.privateKeyDer, bytes).toString('base64'),
    }));
    const receipts = [
      { hostId: 'tower', device: tower, githubUserId: 4242, githubLogin: 'tower-owner', fingerprint: '8'.repeat(64) },
      { hostId: 'vm', device: vm, githubUserId: 4243, githubLogin: 'vm-owner', fingerprint: '9'.repeat(64) },
    ].map(({ hostId, device, githubUserId, githubLogin, fingerprint }) => {
      const unsigned = {
        schemaVersion: 'hive-git-physical-host-receipt/v1',
        runId: fixture.runId,
        hostId,
        deviceKey: device.pubkeyBase64,
        keychainId: `${githubUserId}:${hostId}-machine`,
        githubUserId,
        githubLogin,
        machineFingerprint: fingerprint,
        evidenceSigningSha256: createHash('sha256').update(bytes).digest('hex'),
        signedAt: at('2026-08-13T12:30:30.000Z'),
        evidenceAttestation: fixture.attestations.find(
          (attestation: Record<string, any>) => attestation.deviceKey === device.pubkeyBase64,
        ).signature,
      };
      return {
        ...unsigned,
        signature: signWithPrivateKeyDer(device.privateKeyDer, physicalDrillHostReceiptSigningBytes(unsigned)).toString(
          'base64',
        ),
      };
    });
    fixtureTrust = {
      schemaVersion: 'hive-git-physical-trust/v1',
      source: 'papercusp-vm-rig/v1',
      runId: fixture.runId,
      observedAt: fixture.window.finishedAt,
      hosts: receipts.map((receipt) => ({
        id: receipt.hostId,
        deviceKey: receipt.deviceKey,
        machineFingerprint: receipt.machineFingerprint,
      })),
      receipts,
    };
    return fixture;
  }
  const evidence = physicalFixture();
  if (!fixtureTrust) throw new Error('physical fixture trust was not initialized');
  return { evidence, trust: fixtureTrust, signingDevices };
}
