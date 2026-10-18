/** Real-PG mode implication rows feeding the canonical built-in identity stack. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { composeSuStackSource, layerContentHash, suSessionBinding } from '@papercusp/orchestrator/blueprint';
import { BUILTIN_MODE_COMPONENTS } from '@papercusp/orchestrator/mode-catalog';
import { bindSelectedIdentityOutputArtifact, bindSelectedIdentityOutputs, getIdentitySource, resolvePinnedIdentityLaunchSelection } from './agent-identities/source';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from './blueprint/installed-blueprints';
import { commitBlueprintRelease, snapshotBlueprintReleaseSource } from './cupboard/blueprint-release';
import { getModes, setMode } from './modes/store';
import { attestGoalBootstrapModes } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { compileLaunchSpecificationArtifact } from './role-launch-spec';
import { parseSuLaunchSpecRecord, pinnedSuRecoveryPrompt } from './su-persona-render';
import type { OrgTestDb } from '../test/_org-test-db';

// Mode writes emit the Orders invalidation as a best-effort peripheral effect.
// Keep this fixture on its throwaway database: the sync-sse producer otherwise
// resolves the protected live operator database and fails the integration
// suite's console-error guard, even though the mode assertions use `db.adminSql`.
const ordersNotify = vi.hoisted(() => ({
  notifyAgentOrdersChanged: vi.fn(async (_ownerId: string | null | undefined) => {}),
}));
vi.mock('./agent-orders-notify', () => ordersNotify);

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('GOAL plus IDEATE selects authored components from persisted mode state', () => {
  let db: OrgTestDb;
  const workspaceId = 'mode-identity-p003';
  const ownerId = 'su-mode-identity-p003';
  const goalId = 'goal-mode-identity-p003';

  beforeAll(async () => {
    db = await createOrgTestDb();
    await insertGoalRow(db.adminSql, {
      id: goalId,
      workspaceId,
      installSlug: 'papercusp',
      title: 'Mode identity integration fixture',
      body: 'Verify mode state selects the same authored components.',
      status: 'active',
      killCriterion: 'The goal subject or a required mode component is lost.',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists GOAL subject and AUTO+IDEATE implications, then renders all three mode packages', async () => {
    const declared = BUILTIN_MODE_COMPONENTS.find((entry) => entry.id === 'goal')!;
    expect(declared.implies).toEqual(['auto', 'ideate']);
    expect(declared.requiresSubject).toBe(true);
    expect(declared.launchable).toBe(false);
    // The public mode:set subject guard is exercised by agent-tools/mode/set.test.ts.
    // Here the internal store proves the declared cascade persists atomically.
    const transition = await setMode({
      workspaceId, ownerId, modeId: 'goal', subject: goalId, enabled: true,
      reason: 'P-003 identity composition proof', setBy: ownerId, sql: db.adminSql,
    });
    expect(transition.ok).toBe(true);
    const rows = await getModes(workspaceId, ownerId, db.adminSql);
    expect(rows.map((row) => row.mode).sort()).toEqual(['auto', 'goal', 'ideate']);
    expect(rows.map((row) => row.mode).sort()).toEqual([declared.id, ...declared.implies].sort());
    expect(rows.find((row) => row.mode === 'goal')?.subject).toBe(goalId);
    expect(rows.find((row) => row.mode === 'auto')?.impliedBy).toMatchObject({ mode: 'goal', subject: goalId });
    expect(rows.find((row) => row.mode === 'ideate')?.impliedBy).toMatchObject({ mode: 'goal', subject: goalId });
    expect(attestGoalBootstrapModes(goalId, rows)).toEqual({ status: 'ready' });
    expect(attestGoalBootstrapModes('another-goal', rows).status).toBe('invalid');
    const stack = composeSuStackSource({ binding: suSessionBinding({ modes: rows.map((row) => row.mode) }) });
    expect(stack.order.filter((entry) => entry.layer === 'modes').map((entry) => entry.id))
      .toEqual(['su.mode-auto', 'su.mode-ideate', 'su.mode-goal']);
    expect(stack.text).toContain('IDEATE × AUTO compose');
    expect(stack.text).toContain('GOAL keeps portfolio ownership and delegates every build');
    expect(stack.findings.filter((finding) => finding.tier === 'block')).toEqual([]);
  });
});

describe('installed identity pin and current SU mode source', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('refuses an omitted required generated component after reading persisted mode state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p007-required-mode-output-'));
    const identityId = 'provider-domain';
    const identityDir = join(root, '.papercusp', 'blueprints', identityId);
    const workspaceId = 'p007-required-mode-workspace';
    const ownerId = 'su-p007-required-mode';
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), readFileSync(
        process.env.PAPERCUSP_MUTATION_PROBE_SOURCE ??
          new URL('./agent-identities/fixtures/required-provider-domain.yaml', import.meta.url), 'utf8'));
      writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'REQUIRED MODE PROVIDER\n');
      expect((await setMode({ workspaceId, ownerId, modeId: 'ideate', enabled: true,
        reason: 'P007 persisted producer fixture', setBy: ownerId, sql: db.adminSql })).ok).toBe(true);
      const value = await getModes(workspaceId, ownerId, db.adminSql);
      expect(value.map(row => row.mode)).toEqual(['ideate']);
      const selected = { identityId, repoDir: root,
        scope: { workspace: workspaceId, ownerId, harness: 'papercusp' },
        observedAt: '2026-09-26T00:00:00.000Z' };
      const guidance = { contributionId: 'current-guidance', value: 'P007 CURRENT GUIDANCE' };
      const bound = await bindSelectedIdentityOutputArtifact({ ...selected,
        outputs: [{ contributionId: 'current-brief', value }, guidance] });
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: root, workspaceId, harnessSlug: 'papercusp', role: 'su',
        stack: [`domain:${identityId}`], state: { schemaVersion: 1 }, renderStack: true,
        producerBindings: [{ identityId, artifact: bound.artifact }],
      });
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'setting', ref: 'current-brief', producerRef: 'papercusp.mode-state@1', value,
      }));
      // Same real source and selected identity, with only the required output omitted.
      await expect(bindSelectedIdentityOutputArtifact({ ...selected, outputs: [guidance] }))
        .rejects.toThrow(/declared operational input is absent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains installed v1 instructions after v2 while the declared mode value refreshes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p006-mode-pin-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    const id = 'p006-mode-pin-domain';
    const ref = `domain:${id}`;
    const workspaceId = 'p006-mode-pin-workspace';
    const ownerId = 'su-p006-mode-pin';
    try {
      process.env.PAPERCUSP_HOME = root;
      const install = async (version: string, marker: string) => {
        const sourceDir = join(root, `source-${version}`);
        mkdirSync(join(sourceDir, 'prompts'), { recursive: true });
        const raw = { id, extends: 'base', version, slots: [{ slot: 'domain' }] };
        writeFileSync(join(sourceDir, 'blueprint.yaml'), stringify({
          ...raw, attestation: { contentHash: layerContentHash(raw), signedBy: 'test-publisher' },
        }));
        writeFileSync(join(sourceDir, 'prompts', 'domain.md'), `${marker}\n`);
        const snapshot = await snapshotBlueprintReleaseSource({
          blueprintFile: join(sourceDir, 'blueprint.yaml'),
          resolveExtends: operatorResolveExtends(),
        });
        return commitBlueprintRelease({
          installedDir: INSTALLED_BLUEPRINTS_DIR(), sourceDir, id, version,
          source: 'https://example.invalid/p006-mode-pin', pins: snapshot.archive.pins,
        });
      };

      expect((await install('1.0.0', 'P006 PINNED V1')).operation).toBe('install');
      const v1 = await getIdentitySource(id, { repoDir: root });
      expect(v1.ok).toBe(true);
      if (!v1.ok) throw new Error('installed v1 did not resolve');
      const compiled = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: root, workspaceId, harnessSlug: 'papercusp',
        role: 'su', stack: [ref], state: { schemaVersion: 1 }, renderStack: true,
      });
      expect(compiled.promptText).toContain('P006 PINNED V1');
      const record = parseSuLaunchSpecRecord({
        v: 1, agent: 'codex', workspaceId, stack: [ref],
        selectedIdentity: { ref, sourceRevision: v1.contentHash },
        specificationRevision: compiled.specificationRevision,
        specificationArtifact: compiled.specificationArtifact,
      });
      expect(record).not.toBeNull();
      const ideate = await setMode({
        workspaceId, ownerId, modeId: 'ideate', enabled: true,
        reason: 'P-006 active component before package update', setBy: ownerId, sql: db.adminSql,
      });
      expect(ideate.ok).toBe(true);
      const bindMode = async (observedAt: string) => bindSelectedIdentityOutputs({
        identityId: 'su.mode-ideate', sourceTier: 'builtin',
        outputs: [{ contributionId: 'current-mode-state',
          value: await getModes(workspaceId, ownerId, db.adminSql) }],
        scope: { workspace: workspaceId, ownerId, harness: 'papercusp' }, observedAt,
      });
      const before = await bindMode('2026-09-25T00:00:00.000Z');

      expect((await install('1.0.1', 'P006 INSTALLED V2')).operation).toBe('update');
      await expect(resolvePinnedIdentityLaunchSelection({
        ref, sourceRevision: v1.contentHash, repoDir: root, stack: [ref],
      })).rejects.toThrow(/source revision changed before rebuild/);
      const recovered = pinnedSuRecoveryPrompt(record!);
      expect(recovered?.promptText).toContain('P006 PINNED V1');
      expect(recovered?.promptText).not.toContain('P006 INSTALLED V2');

      const enabled = await setMode({
        workspaceId, ownerId, modeId: 'auto', enabled: true,
        reason: 'P-006 current source after package update', setBy: ownerId, sql: db.adminSql,
      });
      expect(enabled.ok).toBe(true);
      const after = await bindMode('2026-09-25T00:00:01.000Z');
      expect(after.sourceRevision).toBe(before.sourceRevision);
      expect(after.specificationRevision).not.toBe(before.specificationRevision);
      const currentMode = after.contributions.find((entry) => entry.contributionId === 'current-mode-state');
      expect(currentMode?.outputRevision).not.toBe(
        before.contributions.find((entry) => entry.contributionId === 'current-mode-state')?.outputRevision,
      );
      expect((await getModes(workspaceId, ownerId, db.adminSql)).map((row) => row.mode))
        .toEqual(expect.arrayContaining(['auto', 'ideate']));
      expect(pinnedSuRecoveryPrompt(record!)?.specificationRevision)
        .toBe(compiled.specificationRevision);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
