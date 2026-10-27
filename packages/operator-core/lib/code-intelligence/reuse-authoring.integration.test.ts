/** R18: independent real plan handlers, private PG writes and issued-provider ledger.
 * Controlled providers exercise delivery policy; producer semantics have their own
 * integration suites, and R21 separately owns the native semantic runtime proof. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { setupPlanPgFixture, registerHarnessProject, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import * as registry from '../harness-registry';
import { readPlanBySlug } from '../agent-tools/plans/source';
import newPlan from '../agent-tools/plans/new';
import addItem from '../agent-tools/plans/add-item';
import * as issuedLedger from './reuse-brief-ledger';
import { REUSE_PROVIDER_POLICY, briefCodePoints, registerReuseBriefProvider,
  type ReuseBriefProvider, type ReuseProviderId } from './reuse-brief-providers';

const OWNER = 'su-p010-authoring-integration';
const HARNESS = 'zzz-p010-authoring';
const ids = Object.keys(REUSE_PROVIDER_POLICY) as ReuseProviderId[];
type Mode = 'match' | 'no-match' | 'oversized' | 'failed' | 'slow' | 'source-mismatch';
let fx: PlanPgFixture, root: string, sequence = 0;
const ledgerFailures: string[] = [];
const realRecordIssued = issuedLedger.recordReuseBriefIssued;

beforeAll(async () => {
  vi.spyOn(issuedLedger, 'recordReuseBriefIssued').mockImplementation(async (input, signal) => {
    const samples: unknown[] = [];
    let finished = false;
    const started = Date.now();
    // Sample only this disposable database. Retain execution waits on failure,
    // rather than inferring the cause from the statement_timeout error alone.
    const monitor = (async () => {
      while (!finished) {
        const active = await fx.admin`SELECT pid, state, wait_event_type, wait_event,
          extract(epoch FROM (clock_timestamp() - query_start)) * 1000 AS elapsed_ms,
          pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND state = 'active'
          AND query LIKE 'INSERT INTO harness_shared.code_intel_pushes%'`;
        if (active.length && samples.length < 100) samples.push({ atMs: Date.now() - started, active });
        if (!finished) await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    try {
      const recorded = await realRecordIssued(input, signal);
      if (!recorded) ledgerFailures.push(`not-recorded: aborted=${signal.aborted}`);
      return recorded;
    } catch (error) {
      ledgerFailures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      console.info('R18_LEDGER_FAILURE_WAITS', JSON.stringify({ invocation: input.context.invocation,
        elapsedMs: Date.now() - started, samples }));
      throw error;
    } finally {
      finished = true;
      await monitor;
    }
  });
  fx = await setupPlanPgFixture({ isolated: true });
  root = await mkdtemp(join(tmpdir(), 'p010-authoring-'));
  await writeFile(join(root, 'target.ts'), 'export function target() { return 1; }\n');
  await registerHarnessProject(fx.admin, fx.workspaceId, HARNESS);
  vi.spyOn(registry, 'loadHarnessRegistry').mockResolvedValue({ projects: [{ slug: HARNESS, path: root }] });
  await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
    VALUES (${fx.workspaceId}, ${OWNER}, 'p010-authoring-turn')`;
  // Warm handler/module initialization outside the bounded advisory measurements.
  const warm = payload(await newPlan.handler(newPlan.args.parse({ harness: HARNESS,
    slug: 'p010-authoring-warm-2026-10-25', title: 'Warm controlled authoring fixture',
    force: true, content: '# Fixture\n\n## Phase 1 — Work\n' }), {
    workspaceId: fx.workspaceId, harnessSlug: HARNESS, uiClientId: OWNER,
    isSuperuser: true, log: vi.fn(), emit: vi.fn(), progress: vi.fn(), metadata: vi.fn(),
  } as unknown as UnifiedToolContext));
  expect(warm.ok, JSON.stringify(warm)).toBe(true);
}, 180_000);
afterAll(async () => { vi.restoreAllMocks(); await fx?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });

function controlled(id: ReuseProviderId, mode: Mode): ReuseBriefProvider {
  return { id, read: async (context, signal) => {
    if (id === 'semantic' && mode === 'failed') throw new Error('controlled provider failure');
    if (id === 'semantic' && mode === 'slow') await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const line = id === 'clones' ? 'Copy family target.ts:1 sibling; verify before reuse'
      : id === 'semantic' ? 'Suggested anchor target.ts:1 target; verify before reuse' : `${id} target.ts:1 scoped evidence`;
    return { status: 'measured', sourceVersion: mode === 'source-mismatch' ? 'stale-source' : context.sourceVersion,
      indexVersion: `controlled-${id}-v1`, citedPaths: ['target.ts'],
      lines: mode === 'no-match' ? [] : Array.from({ length: mode === 'oversized' ? 200 : 1 }, () => line) };
  } };
}

function payload(response: unknown): Record<string, any> {
  const out = response as { data?: Record<string, any>; content?: Array<{ text?: string }> };
  return out.data ?? JSON.parse(out.content?.[0]?.text ?? '{}');
}

describe.each(['plans:new', 'plans:add-item'] as const)('R18 %s independent authoring response', surface => {
  it.each(['match', 'no-match', 'oversized', 'failed', 'slow', 'source-mismatch'] as const)(
    '%s preserves the canonical write and records only issued, scoped identities', async mode => {
      ledgerFailures.length = 0;
      // plans:new dates undated slugs; use the canonical key for every read/write.
      const slug = `p010-authoring-${++sequence}-2026-10-25`, invocation = `${surface}-${mode}-${sequence}`;
      const ctx = { workspaceId: fx.workspaceId, harnessSlug: HARNESS, uiClientId: OWNER,
        isSuperuser: true, dispatchCallId: invocation, signal: new AbortController().signal,
        metadata: vi.fn(), log: vi.fn(), emit: vi.fn(), progress: vi.fn() } as unknown as UnifiedToolContext;
      // add-item gets its own persisted parent, without borrowing plans:new's advice.
      if (surface === 'plans:add-item') {
        const parent = payload(await newPlan.handler(newPlan.args.parse({ harness: HARNESS, slug,
          title: slug, force: true, content: '# Fixture\n\n## Phase 1 — Work\n' }), { ...ctx, dispatchCallId: undefined }));
        expect(parent.ok, JSON.stringify(parent)).toBe(true);
      }
      const unregister = [...ids].reverse().map(id => registerReuseBriefProvider(controlled(id, mode)));
      try {
        const started = Date.now();
        const result = surface === 'plans:new'
          ? payload(await newPlan.handler(newPlan.args.parse({ harness: HARNESS, slug, title: slug,
            force: true, content: '# Fixture\n\nChange target.ts\n\n## Phase 1 — Work\n' }), ctx))
          : payload(await addItem.handler(addItem.args.parse({ harness: HARNESS, slug, phase: 'Phase 1 — Work',
            text: 'Change target.ts', importance: 'normal' }), ctx)).results[0];
        expect(Date.now() - started).toBeLessThan(6_000);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const persisted = await readPlanBySlug(slug, { workspaceId: fx.workspaceId, harnessSlug: HARNESS });
        expect(persisted?.row.content).toContain('Change target.ts');
        expect(result.slug).toBe(slug);
        if (surface === 'plans:add-item') expect(result.itemId).toMatch(/^P-\d+$/);
        const advice = result.reuseAdvice;
        expect(advice, JSON.stringify(result)).toBeDefined();
        expect(briefCodePoints(JSON.stringify({ hints: advice.hints }))).toBeLessThanOrEqual(3_000);
        const observations = advice.observations as Array<{ provider: ReuseProviderId; status: string; reason: string; chars: number }>;
        expect(observations.map(row => row.provider)).toEqual(ids);
        for (const row of observations) expect(row.chars).toBeLessThanOrEqual(REUSE_PROVIDER_POLICY[row.provider].cap);
        if (mode === 'no-match' || mode === 'source-mismatch') {
          expect(advice.hints).toEqual([]);
          expect(observations.every(row => row.status === (mode === 'no-match' ? 'no-match' : 'unknown'))).toBe(true);
        } else {
          expect(advice.hints[0].text).toContain('Copy family');
          if (mode === 'match') expect(advice.hints.at(-1).text).toContain('Suggested anchor');
          if (mode === 'oversized') expect(observations.some(row => row.reason === 'truncated')).toBe(true);
          if (mode === 'failed' || mode === 'slow') expect(observations.find(row => row.provider === 'semantic'))
            .toMatchObject({ status: 'unknown', reason: mode === 'failed' ? 'failure' : 'timeout' });
        }
        const rows = await fx.admin`SELECT subject, chars, turn_id FROM harness_shared.code_intel_pushes
          WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${OWNER}
          AND subject::jsonb->>'invocation' = ${invocation} ORDER BY id`;
        const issued = observations.filter(row => row.status === 'issued');
        expect(advice.ledger, JSON.stringify({ ledgerFailures, ledger: advice.ledger, invocation }))
          .toBe(issued.length ? 'recorded' : 'not-needed');
        expect(rows, JSON.stringify({ ledgerFailures, ledger: advice.ledger, invocation })).toHaveLength(issued.length);
        expect(rows.map(row => JSON.parse(row.subject).provider).sort()).toEqual(issued.map(row => row.provider).sort());
        for (const row of rows) {
          expect(row.turn_id).toBe('p010-authoring-turn');
          expect(JSON.parse(row.subject)).toMatchObject({ surface: 'authoring', invocation, plan: slug,
            planItems: surface === 'plans:new' ? [] : [result.itemId], sourceVersion: expect.any(String),
            indexVersion: expect.stringMatching(/^controlled-/) });
        }
      } finally { unregister.forEach(release => release()); }
    }, 30_000);
});
