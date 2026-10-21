/** Private IO boundaries; real create, registry mutation/readers, removal and git-sync spine. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { HarnessRegistry } from '../../../harness-registry';

const io = vi.hoisted(() => ({
  registries: new Map<string, HarnessRegistry>(),
  schemas: new Set<string>(), routines: new Set<string>(), mutations: 0,
}));
vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: async (_table: string, ws: string) => structuredClone(io.registries.get(ws) ?? { projects: [] }),
  writeOperatorState: async (_table: string, value: HarnessRegistry, ws: string) => {
    io.registries.set(ws, structuredClone(value));
  },
  updateOperatorState: async (_table: string, initial: HarnessRegistry, mutator: (r: HarnessRegistry) => HarnessRegistry, ws: string) => {
    // No await inside the modeled row transaction: each writer sees the last commit.
    const next = mutator(structuredClone(io.registries.get(ws) ?? initial));
    io.registries.set(ws, structuredClone(next));
    io.mutations++;
    return structuredClone(next);
  },
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: async () => [] } }),
  upsertRoutine: async (_sql: unknown, input: { installSlug: string }) => {
    io.routines.add(input.installSlug);
    return input;
  },
  setRoutineActive: async () => true,
}));
vi.mock('../../../harness/projects-lite', () => ({ bustProjectsLiteCache: () => {} }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: async () => {} }));
vi.mock('../../../scaffold-harness-schema', () => ({
  scaffoldHarnessSchema: async (slug: string) => { io.schemas.add(slug); },
}));
vi.mock('../../../blueprint/materialize-triggers', () => ({
  materializeBlueprintTriggers: async () => { io.routines.add('blueprint-trigger'); return []; },
}));
vi.mock('../../../harness/docs/seed-doc-tracking', () => ({
  seedHarnessDocTracking: async () => ({ seeded: true, registered: 0, total: 0, reason: 'no_docs' }),
}));
vi.mock('../../../cupboard/pack-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../cupboard/pack-catalog')>();
  const { operatorResolveExtends } = await import('../../../blueprint/installed-blueprints');
  const { loadBlueprintFromFile } = await import('@papercusp/orchestrator/blueprint');
  const resolve = operatorResolveExtends();
  const { blueprint } = loadBlueprintFromFile(resolve('coding')!, resolve);
  return { ...actual, derivePackCatalog: async () => actual.assemblePackCatalog({
    installed: [], projectedTools: [], legacyCatalogNames: blueprint.dependencies?.tools ?? [],
    cupboardUnits: [], cupboardReachable: true,
  }) };
});

import tool from '../create';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../../harness-registry';
import { removeHarnessFromWorkspace } from '../../../harness-membership';
import { runJudgeGitEvidence } from '../../capability/git-evidence';
import { seedGitSyncRoutineForMember } from '../../../harness/git-sync/git-sync-routine';
import { reconcileGitSyncRoutines } from '../../../harness/git-sync/git-sync-reconcile';

let home: string;
let root: string;
let commitSha: string;
const workspaceId = 'private-registration-fixture';
const context = () => ({ workspaceId, principal: { workspaceId }, signal: new AbortController().signal }) as never;
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
}).trim();
const args = () => ({ slug: 'proof-root', path: root, registrationOnly: true, expectedCommit: commitSha });
const invoke = async (input: unknown = args(), ctx = context()) => {
  const parsed = tool.args.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_args' };
  const result = await tool.handler(parsed.data, ctx);
  const response = result as { content: Array<{ text: string }> };
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
};
function bytes(dir: string): string {
  const entries: Array<[string, string]> = [];
  const walk = (at: string, prefix = '') => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), name + '/');
      else entries.push([name, createHash('sha256').update(readFileSync(join(at, entry.name))).digest('hex')]);
    }
  };
  walk(dir);
  return JSON.stringify(entries);
}
async function lifecycle() {
  expect(await invoke()).toMatchObject({ ok: true, existing: false });
  expect(await invoke()).toMatchObject({ ok: true, existing: true });
  const reg = await loadHarnessRegistry(workspaceId);
  const sql = (async () => []) as unknown as Sql;
  const entry = reg.projects[0];
  expect(await seedGitSyncRoutineForMember({ workspaceId, installSlug: entry.slug, entry }, { sql }))
    .toMatchObject({ seeded: false, reason: 'ineligible', ineligibleReason: 'registration_only' });
  expect(await reconcileGitSyncRoutines({ workspaceId, sql, getRoutine: async () => null }))
    .toEqual({ seeded: [], skipped: [], unseeded: [] });
  expect(await removeHarnessFromWorkspace(workspaceId, entry.slug)).toMatchObject({ changed: true });
}
beforeEach(() => {
  io.registries.clear(); io.schemas.clear(); io.routines.clear(); io.mutations = 0;
  home = mkdtempSync(join(tmpdir(), 'create-passive-'));
  root = join(home, 'checkout'); mkdirSync(root);
  git(root, 'init', '--quiet');
  writeFileSync(join(root, 'evidence.txt'), 'private pinned evidence\n');
  git(root, 'add', 'evidence.txt');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  commitSha = git(root, 'rev-parse', 'HEAD');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('harness:create registration-only lifecycle', () => {
  it('R8 resolves the registered canonical root through real rootHarnessSlug evidence reads', async () => {
    const alias = join(home, 'alias'); symlinkSync(root, alias, 'dir');
    expect(await invoke({ ...args(), path: alias })).toMatchObject({ ok: true, path: root });
    expect(resolveHarnessContentPath(await loadHarnessRegistry(workspaceId), 'proof-root')).toBe(root);
    expect(await runJudgeGitEvidence({ op: 'readFileAtCommit', rootHarnessSlug: 'proof-root', commitSha, path: 'evidence.txt' }, {
      workspaceId, repositoryDir: home, signal: new AbortController().signal,
    })).toMatchObject({ ok: true, content: 'private pinned evidence\n', commitSha });
    expect(await loadHarnessRegistry('foreign-workspace')).toEqual({ projects: [] });
  });
  it('R9 preserves every checkout byte through registration retry reconciliation and removal', async () => {
    const before = bytes(root);
    await lifecycle();
    expect(bytes(root)).toBe(before);
  });
  it('R10 leaves the schema catalog unchanged through the complete passive lifecycle', async () => {
    io.schemas.add('pre-existing');
    await lifecycle();
    expect([...io.schemas]).toEqual(['pre-existing']);
  });
  it('R11 leaves the routine ledger unchanged through direct seeding and reconciliation', async () => {
    io.routines.add('pre-existing');
    await lifecycle();
    expect([...io.routines]).toEqual(['pre-existing']);
  });
  it.each(['missing', 'dirty', 'wrong-pin', 'subdirectory', 'foreign-context', 'unknown-workspace', 'scaffolding'])(
    'R12 rejects %s before registry mutation', async (kind) => {
      let input: Record<string, unknown> = args();
      let ctx = context();
      if (kind === 'missing') input.path = join(home, 'missing');
      if (kind === 'dirty') writeFileSync(join(root, 'untracked.txt'), 'dirty');
      if (kind === 'wrong-pin') input.expectedCommit = '0'.repeat(40);
      if (kind === 'subdirectory') { mkdirSync(join(root, 'sub')); input.path = join(root, 'sub'); }
      if (kind === 'foreign-context') ctx = { workspaceId, principal: { workspaceId: 'foreign' } } as never;
      if (kind === 'unknown-workspace') ctx = { workspaceId: '*' } as never;
      if (kind === 'scaffolding') input.blueprintId = 'coding';
      const before = bytes(root);
      expect(await invoke(input, ctx)).toMatchObject({ ok: false });
      expect(io.mutations).toBe(0);
      expect(io.registries.size).toBe(0);
      expect(bytes(root)).toBe(before);
      expect(io.schemas.size + io.routines.size).toBe(0);
    },
  );
  it('R13 concurrent identical retries keep one registration identity', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => invoke()));
    expect(results.every((r) => r.ok === true)).toBe(true);
    expect(results.filter((r) => r.existing === false)).toHaveLength(1);
    expect((await loadHarnessRegistry(workspaceId)).projects).toEqual([{
      slug: 'proof-root', path: root, registrationOnly: { commitSha },
    }]);
  });
  it('R14 rejects same-path different-slug collisions without replacing the winner', async () => {
    const results = await Promise.all([invoke(), invoke({ ...args(), slug: 'other-root' })]);
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.error === 'registration_identity_conflict')).toHaveLength(1);
    expect((await loadHarnessRegistry(workspaceId)).projects).toHaveLength(1);
  });
  it('R14 refuses conflicting slug path pin and existing managed identities', async () => {
    const existing = { slug: 'proof-root', path: home };
    io.registries.set(workspaceId, { projects: [existing] });
    expect(await invoke()).toMatchObject({ ok: false, error: 'registration_identity_conflict' });
    expect((await loadHarnessRegistry(workspaceId)).projects).toEqual([existing]);
    io.registries.set(workspaceId, { projects: [{ ...existing, path: root, registrationOnly: { commitSha: 'f'.repeat(40) } }] });
    expect(await invoke()).toMatchObject({ ok: false, error: 'registration_identity_conflict' });
  });
  it('ordinary create still provisions its schema blueprint and scheduled routines', async () => {
    const result = await invoke({ slug: 'ordinary', path: root, blueprintId: 'coding' });
    expect(result).toMatchObject({ ok: true, provisioning: { ok: true } });
    expect(io.schemas.has('ordinary')).toBe(true);
    expect(io.routines.has('blueprint-trigger')).toBe(true);
    expect(readFileSync(join(root, '.papercusp', 'blueprint.yaml'), 'utf8')).toContain('coding');
  });
});
