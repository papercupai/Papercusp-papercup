/** portable-identity-packages P-011 / PORTABLE-P-011@1 — the pre-tool guard over
 * a REAL compiled identity artifact, the REAL gate-selected launch record and the
 * REAL applied revision in session_briefs, through the tool-guard port's own
 * `toolGuardText` (the endpoint the shared hook dispatcher calls).
 *
 * Normal case: a worn deny predicate refuses the one pending call it names, and
 * a call it does not name proceeds. Counterexample (the falsifier): a guard that
 * cannot EVALUATE — its predicate throws, or the adapter cut the input — refuses,
 * naming the rule; only an UNREADABLE artifact (no rule can be named) fails open. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { pinPackageInput, resolveBlueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { compileBlueprintWithPackages } from '../blueprint/compile-packages';
import { toolGuardText } from '../endpoint-route/routes/agent-mcp/identity-hook-sinks';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));

const WS = 'sync-guard-ws';
const guardRule = (id: string, tools: string[], guard: Record<string, unknown>) => pinPackageInput({
  packageKind: 'rule', ref: id, revision: '1.0.0', files: [{ path: 'rule.json', bytes: id }],
  value: { id, title: id, description: `${id} guard`, version: '1.0.0', delivery: 'sync', sink: 'pre-tool', tools, guard },
});
const RULES = {
  'no-rm': guardRule('no-rm', ['capability:bash'], { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' }),
  // An invalid pattern is an author bug the matcher throws on at evaluation.
  broken: guardRule('broken', ['fs:*'], { deny: { 'input.path': { matches: '[' } } }),
};

describe('pre-tool guard (real artifact + launch record + applied revision)', () => {
  let db: OrgTestDb;
  let nextSessionId = 9400;

  async function wear(ownerId: string, recorded: { specificationRevision: string; stateRevision: string } | null,
    applied: { specificationRevision: string; stateRevision: string }, artifact: unknown) {
    if (recorded) {
      await db.adminSql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,mode,coord_owner_id,session_id,started_at,launch_spec)
        VALUES (${nextSessionId++},${WS},'console',${ownerId},${`native-${ownerId}`},now(),
          ${JSON.stringify({ ...recorded, specificationArtifact: artifact })}::text::jsonb)`;
    }
    await db.adminSql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
      VALUES (${ownerId}, ${WS}, 1, ${db.adminSql.json({ activation: { applied } })})`;
  }
  const guard = (ownerId: string, tool: string, input: unknown, inputTruncated = false) =>
    toolGuardText({ ownerId, workspaceId: WS, call: { tool, input, client: 'claude', ...(inputTruncated ? { inputTruncated } : {}) } });

  let revision: { specificationRevision: string; stateRevision: string };

  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
    const source = resolveBlueprint({ id: 'guarded-coder', bundles: [{ kind: 'rule', ref: 'no-rm' }, { kind: 'rule', ref: 'broken' }],
      workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
    const artifact = await compileBlueprintWithPackages(source, { workspaceId: WS, harnessSlug: 'sync-guard',
      resolvePackage: async ({ ref }) => RULES[ref as keyof typeof RULES] ?? null });
    revision = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-guarded' };
    await wear('owner-guarded', revision, revision, artifact);
    // A control-only activation (D-028 §7): the applied STATE revision moved without a
    // re-render, so no receipt carries it, but the record's specification IS the applied one.
    await wear('owner-reregistered', revision, { ...revision, stateRevision: 'state-reregistered' }, artifact);
    // Applied SPECIFICATION the gate-selected launch record cannot resolve: no rule can be named.
    await wear('owner-unreadable', revision, { ...revision, specificationRevision: 'spec-elsewhere' }, artifact);
  }, 180_000);

  afterAll(async () => {
    pg.sql = null;
    await db?.cleanup();
  });

  it('refuses the call a worn deny predicate names, and lets every other call proceed', async () => {
    await expect(guard('owner-guarded', 'capability:bash', { command: 'rm -rf /' }))
      .resolves.toMatch(/^Refused by identity \S+ rule no-rm: no recursive deletes$/);
    await expect(guard('owner-guarded', 'capability:bash', { command: 'ls' })).resolves.toBe('');
    await expect(guard('owner-guarded', 'coord:send', { command: 'rm -rf /' })).resolves.toBe('');
  });

  it('fails CLOSED, naming the rule, when a worn predicate cannot evaluate', async () => {
    await expect(guard('owner-guarded', 'fs:open', { path: '/etc/hosts' }))
      .resolves.toMatch(/^Refused by identity \S+ rule broken: guard broken failed to evaluate: /);
    // capability:bash is a shell tool the kernel rails read, so a cut input is the
    // kernel's refusal before any worn guard runs (R-11: no budget drops a rail).
    await expect(guard('owner-guarded', 'capability:bash', null, true))
      .resolves.toMatch(/^Refused by identity kernel rule kernel:guard-input-bound: tool input exceeds the guard input bound/);
  });

  it('keeps a worn guard live across a control-only activation (no receipt carries the new state revision)', async () => {
    await expect(guard('owner-reregistered', 'capability:bash', { command: 'rm -rf /' }))
      .resolves.toMatch(/^Refused by identity \S+ rule no-rm: no recursive deletes$/);
    await expect(guard('owner-reregistered', 'capability:bash', { command: 'ls' })).resolves.toBe('');
  });

  it('fails OPEN only where no rule can be named: nothing applied, or an unreadable artifact', async () => {
    await expect(guard('owner-bare', 'capability:bash', { command: 'rm -rf /' })).resolves.toBe('');
    await expect(guard('owner-unreadable', 'fs:open', { path: '/etc/hosts' })).resolves.toBe('');
  });
});
