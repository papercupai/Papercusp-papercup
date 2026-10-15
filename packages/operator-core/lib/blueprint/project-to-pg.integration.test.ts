/**
 * P-006 (`autoloop-pot-operator-rebuild-2026-06-05` D-005) — the dispatch-policy
 * read path the orchestrator tick uses, against REAL PG (throwaway DB):
 *
 *   1. `getEffectiveBlueprint` lazily projects a git-canonical
 *      `.papercusp/blueprint.yaml` into the `harness_shared.blueprints` cache on
 *      a miss and returns the resolved blueprint (the `dispatch:` section
 *      surviving the write → read → `BlueprintSchema.parse` round trip);
 *   2. a second resolve is a pure CACHE HIT (the file is not re-read);
 *   3. the resolved policy composes through `resolveDispatchPolicy` to the cap
 *      the tick enforces (coding-style `concurrency: 4`).
 *
 * Table DDL mirrors migration 133 (PK + resolved jsonb — RLS/grants are
 * irrelevant on the throwaway admin connection).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  clearBlueprintReprojectionState,
  getEffectiveBlueprint,
  readBlueprintFromPg,
  readBlueprintReprojectionAttempt,
  readOrProjectBlueprintHash,
} from './project-to-pg';
import { resolveDispatchPolicy } from '../dbos/orchestrator-loop';
import type { HarnessConfig } from '@papercusp/orchestrator';

let db: FreshPgDb;
let dir: string;
let blueprintPath: string;

/** A standalone (no-extends) blueprint declaring a coding-style dispatch policy. */
const YAML = `
id: dispatch-demo
version: 0.1.0
workItem:
  kind: feature
  idPrefix: F
spine:
  decider: director
  edges:
    DONE: { to: done }
dispatch:
  concurrency: 4
  priority: plan-order
`;

const LOCAL_PARENT_YAML = `
id: local-parent
version: 0.1.0
workItem:
  kind: feature
  idPrefix: F
spine:
  decider: director
  edges:
    DONE: { to: done }
dispatch:
  concurrency: 3
  priority: plan-order
`;

const LOCAL_CHILD_YAML = `
id: local-child
version: 0.1.0
extends: local-parent
`;

beforeAll(async () => {
  db = await createFreshPgDb('p006-dispatch-cache');
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.blueprints (
      workspace_id  text NOT NULL,
      harness_slug  text NOT NULL,
      blueprint_id  text NOT NULL,
      version       text NOT NULL DEFAULT '0.1.0',
      resolved      jsonb NOT NULL,
      content_hash  text NOT NULL,
      source_path   text,
      source_commit text,
      projected_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug)
    );
  `);
  dir = mkdtempSync(join(tmpdir(), 'p006-bp-'));
  mkdirSync(join(dir, '.papercusp'), { recursive: true });
  blueprintPath = join(dir, '.papercusp', 'blueprint.yaml');
  writeFileSync(blueprintPath, YAML, 'utf8');
  mkdirSync(join(dir, '.papercusp', 'blueprints', 'local-parent'), { recursive: true });
  writeFileSync(join(dir, '.papercusp', 'blueprints', 'local-parent', 'blueprint.yaml'), LOCAL_PARENT_YAML, 'utf8');
}, 90_000);

afterAll(async () => {
  clearBlueprintReprojectionState();
  await db?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function projectedAtOf(harnessSlug: string): Promise<number> {
  const rows = await db.sql<{ projected_at: Date }[]>`
    SELECT projected_at FROM harness_shared.blueprints
     WHERE workspace_id = 'default' AND harness_slug = ${harnessSlug}
  `;
  return new Date(rows[0].projected_at).getTime();
}

/** Stamp the source file strictly after the row's projected_at (deterministic, no sleep). */
async function touchAfterProjection(harnessSlug: string, path: string, aheadMs = 1_000): Promise<void> {
  const when = new Date((await projectedAtOf(harnessSlug)) + aheadMs);
  utimesSync(path, when, when);
}

describe('getEffectiveBlueprint — the dispatch-policy read path of the orchestrator tick', () => {
  it('cache miss → lazily projects the file and returns the dispatch policy', async () => {
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'demo',
      blueprintPath,
    });
    expect(bp).not.toBeNull();
    expect(bp!.dispatch).toEqual({
      concurrency: 4,
      priority: 'plan-order',
      // the schema default — the legacy needs-work set (byte-equivalence anchor)
      readiness: ['todo', 'failing', 'pending', 'failed'],
    });
    // …and the projection row landed in the PG cache.
    const cached = await readBlueprintFromPg(db.sql as never, 'default', 'demo');
    expect(cached?.dispatch?.concurrency).toBe(4);
  });

  it('second resolve is a cache HIT — the (now deleted) file is not re-read', async () => {
    rmSync(blueprintPath);
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'demo',
      blueprintPath,
    });
    expect(bp?.dispatch?.concurrency).toBe(4);
  });

  it('no cache row + no file → null (the tick falls back to the legacy config-only gate)', async () => {
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'no-such-harness',
      blueprintPath: join(dir, '.papercusp', 'missing.yaml'),
    });
    expect(bp).toBeNull();
  });

  it('cache miss resolves a project-local extends parent before installed/built-in tiers', async () => {
    const localChildPath = join(dir, '.papercusp', 'local-child.yaml');
    writeFileSync(localChildPath, LOCAL_CHILD_YAML, 'utf8');
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'local-child-demo',
      blueprintPath: localChildPath,
    });
    expect(bp?.id).toBe('local-child');
    expect(bp?.dispatch?.concurrency).toBe(3);
  });

  it('a cached row follows its source file: an edit after projection is re-projected (WI-10006722)', async () => {
    clearBlueprintReprojectionState();
    const path = join(dir, '.papercusp', 'drift.yaml');
    writeFileSync(path, YAML, 'utf8');
    const first = await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift', blueprintPath: path });
    expect(first?.dispatch?.concurrency).toBe(4);
    const firstHash = await readOrProjectBlueprintHash(db.sql as never, 'default', 'drift');

    writeFileSync(path, YAML.replace('concurrency: 4', 'concurrency: 7'), 'utf8');
    await touchAfterProjection('drift', path);

    // The submit path (hash) and the dispatcher path (blueprint) both see the edit.
    const nextHash = await readOrProjectBlueprintHash(db.sql as never, 'default', 'drift');
    expect(nextHash).not.toBe(firstHash);
    const next = await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift', blueprintPath: path });
    expect(next?.dispatch?.concurrency).toBe(7);
    expect((await readBlueprintFromPg(db.sql as never, 'default', 'drift'))?.dispatch?.concurrency).toBe(7);
    expect(readBlueprintReprojectionAttempt('default', 'drift')).toMatchObject({ ok: true, error: null, path });
  });

  it('an invalid edit keeps the last valid row, reports the error, and is parsed once', async () => {
    clearBlueprintReprojectionState();
    const path = join(dir, '.papercusp', 'drift-invalid.yaml');
    writeFileSync(path, YAML, 'utf8');
    await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-invalid', blueprintPath: path });
    const validHash = await readOrProjectBlueprintHash(db.sql as never, 'default', 'drift-invalid');

    writeFileSync(path, 'id: dispatch-demo\nversion: 0.1.0\nworkItem: 42\n', 'utf8');
    await touchAfterProjection('drift-invalid', path);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kept = await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-invalid', blueprintPath: path });
      expect(kept?.dispatch?.concurrency).toBe(4);
      expect(await readOrProjectBlueprintHash(db.sql as never, 'default', 'drift-invalid')).toBe(validHash);
      const failed = readBlueprintReprojectionAttempt('default', 'drift-invalid');
      expect(failed).toMatchObject({ ok: false, path });
      expect(failed?.error).toContain('workItem');
      // The same file version is not re-parsed on every call: one warning, one attempt.
      await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-invalid', blueprintPath: path });
      expect(readBlueprintReprojectionAttempt('default', 'drift-invalid')?.at).toBe(failed?.at);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('keeping the last projected blueprint');
    } finally {
      warn.mockRestore();
    }

    // Fixing the file recovers without touching the cache by hand.
    writeFileSync(path, YAML.replace('concurrency: 4', 'concurrency: 5'), 'utf8');
    await touchAfterProjection('drift-invalid', path, 2_000);
    const fixed = await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-invalid', blueprintPath: path });
    expect(fixed?.dispatch?.concurrency).toBe(5);
  });

  it('a source mtime ahead of the database clock re-projects once, not on every call', async () => {
    clearBlueprintReprojectionState();
    const path = join(dir, '.papercusp', 'drift-future.yaml');
    writeFileSync(path, YAML, 'utf8');
    await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-future', blueprintPath: path });
    writeFileSync(path, YAML.replace('concurrency: 4', 'concurrency: 6'), 'utf8');
    await touchAfterProjection('drift-future', path, 3_600_000);

    expect((await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-future', blueprintPath: path }))?.dispatch?.concurrency).toBe(6);
    const projectedAt = await projectedAtOf('drift-future');
    await getEffectiveBlueprint(db.sql as never, { workspaceId: 'default', harnessSlug: 'drift-future', blueprintPath: path });
    await readOrProjectBlueprintHash(db.sql as never, 'default', 'drift-future');
    expect(await projectedAtOf('drift-future')).toBe(projectedAt);
  });

  it('the cached policy composes through resolveDispatchPolicy to the tick cap', async () => {
    const bp = await readBlueprintFromPg(db.sql as never, 'default', 'demo');
    const r = resolveDispatchPolicy({ dispatch: bp?.dispatch ?? null, cfg: {} as HarnessConfig });
    expect(r.cap).toBe(4); // the blueprint fills the silent per-install config
    // per-install config still wins (instance refines shape)
    const tightened = resolveDispatchPolicy({
      dispatch: bp?.dispatch ?? null,
      cfg: { parallelWorkers: { max: 2 } } as HarnessConfig,
    });
    expect(tightened.cap).toBe(2);
  });
});
