/**
 * Coverage for the New-plan kickoff brief resolution.
 *
 * Regression guard for the silent-drop bug (offsite-planner demo B3): the
 * curated brief `apps/operator/prompts/kickoffs/new-plan.md` was resolved via
 * the workspace DATA root (`papercuspPath()` → `~/.papercusp-workspaces/<id>/
 * .papercusp/…`), which never contains the repo's prompt files. So
 * `buildKickoffPromptFile({ kind: 'new-plan' })` always returned null and the
 * "New plan" launch dropped `--launch-context` — the planner pane opened with
 * `--role=planner` but NO interview brief. The fix resolves via `promptsDir()`
 * (the same resolver role personas use: dev cwd, the import.meta walk-up, AND
 * the packaged-desktop `PAPERCUSP_PROMPTS_DIR` env). These tests assert the
 * brief now resolves + carries its content, so the regression can't return.
 */
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { controlPlaneTempCandidates } from '../../control-plane-temp.mjs';

// renderFeatureBody (WI-5383: migrated off getLegacyClient) reads the feature
// row via harnessQuery — mock it explicitly, or the REAL implementation runs
// here and tries to reach live Postgres, which this unit test environment has
// none of. `getFeatureLineage`/`formatLineageForPrompt` are imported but never
// invoked by the current renderFeatureBody body (lineage rendering is
// deliberately skipped — see the `void` no-ops in prompt-file.ts), so they are
// stubbed only to satisfy the module shape.
const dbMocks = vi.hoisted(() => ({
  harnessQuery: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  harnessQuery: dbMocks.harnessQuery,
}));

import { buildKickoffPromptFile } from '../prompt-file';

describe('buildKickoffPromptFile new-plan', () => {
  it('resolves the curated brief to a real temp file (not null)', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: null });
    // The pre-fix bug: papercuspPath() pointed at the workspace data root, the
    // file read threw, and this came back null → the launch dropped the brief.
    expect(path).not.toBeNull();
    expect(path).toMatch(/new-plan\.md$/);
    expect(controlPlaneTempCandidates('payload').some((root) => path!.startsWith(root + sep))).toBe(true);
  });

  it('writes the new-plan interview brief body into the file', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: null });
    expect(path).not.toBeNull();
    const body = readFileSync(path as string, 'utf8');
    // Stable markers from apps/operator/prompts/kickoffs/new-plan.md — the
    // interview-first contract + the plans:* authoring sequence the planner runs.
    expect(body).toMatch(/New plan — kickoff brief/);
    expect(body).toMatch(/Interview first, write second/);
    expect(body).toMatch(/plans:new/);
    expect(body).toMatch(/plans:lint/);
    // The {{harness_context}} placeholder must be substituted, never left raw.
    expect(body).not.toMatch(/\{\{harness_context\}\}/);
  });

  it('stamps the active harness into the brief when one is in context', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: 'papercup' });
    expect(path).not.toBeNull();
    const body = readFileSync(path as string, 'utf8');
    expect(body).toMatch(/\*\*Active harness:\*\* `papercup`/);
  });

  it('falls back to the "ask the user" harness line when none is in context', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: null });
    expect(path).not.toBeNull();
    const body = readFileSync(path as string, 'utf8');
    expect(body).toMatch(/\*\*Active harness:\*\* none/);
  });
});

describe('buildKickoffPromptFile feature (renderFeatureBody, WI-5383 regression)', () => {
  const unsafe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // harnessQuery's callback receives a postgres.js-shaped `sql` handle;
    // renderFeatureBody only calls `.unsafe(text, params)` on it.
    dbMocks.harnessQuery.mockImplementation(async (_slug: string, fn: any) => fn({ unsafe }));
  });

  it('queries via harnessQuery with the harness slug + feature id bound as $1/$2 (direct-mode behavior unchanged from getLegacyClient)', async () => {
    unsafe.mockResolvedValueOnce([
      { feature_id: 'F-042', title: 'Widget support', summary: 'Adds widgets', status: 'wip' },
    ]);

    const path = await buildKickoffPromptFile({ kind: 'feature', harnessSlug: 'sheets', featureId: 'F-042' });

    expect(path).not.toBeNull();
    expect(dbMocks.harnessQuery).toHaveBeenCalledWith('sheets', expect.any(Function));
    const sql = String(unsafe.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain('WHERE harness_slug = $1 AND feature_id = $2');
    // The same two positional binds the old `.prepare(...).get(harnessSlug, featureId)`
    // (`?`, `?` placeholders) sent — proving the `?` -> `$N` translation preserved
    // both parameters and their order.
    expect(unsafe.mock.calls[0]?.[1]).toEqual(['sheets', 'F-042']);

    const body = readFileSync(path as string, 'utf8');
    expect(body).toMatch(/## Feature: Widget support/);
  });

  it('returns null when the feature row is not found (behavior unchanged)', async () => {
    unsafe.mockResolvedValueOnce([]);

    const path = await buildKickoffPromptFile({ kind: 'feature', harnessSlug: 'sheets', featureId: 'F-missing' });

    expect(path).toBeNull();
  });
});
