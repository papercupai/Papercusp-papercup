/**
 * Regression guard for WI-6554700010016978.
 *
 * These background readers run in a shared operator process, so a literal
 * dogfood workspace fallback silently reads the wrong tenant whenever the
 * process is serving another workspace. Their optional workspace arguments
 * must resolve through activeWorkspaceId() instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PRODUCTION_FILES = [
  'agent-plane-measurement-sweep.ts',
  'agent-state-divergence-sweep.ts',
  'agent-tools/plans/slug-scope.ts',
  'harness/routines/launch-cost-ceiling-action.ts',
  'harness/routines/host-code-staleness-from-ledger.ts',
  'harness/routines/sql-read-census-action.ts',
  'harness/routines/stale-routine-executor-watchdog.ts',
  'release-deploy-staleness-watchdog.ts',
  'rubric-staleness-watchdog.ts',
  'search/session-ingest-lag-watchdog.ts',
  'stale-prompt-render-sweep.ts',
  'sync/hyperbee/cold-join-canary.ts',
] as const;

const SENTINEL_FALLBACK = /(?:workspaceId|workspace_id)\s*\?\?\s*['"]papercusp-workspace['"]/;

describe('workspace-scoped background readers', () => {
  it('never falls back to the dogfood sentinel', () => {
    for (const relativePath of PRODUCTION_FILES) {
      const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(SENTINEL_FALLBACK);
      expect(source, relativePath).toContain('activeWorkspaceId');
    }
  });
});
