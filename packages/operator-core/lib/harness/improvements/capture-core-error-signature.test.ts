/**
 * capture-core-error-signature.test.ts — the one intake folds two reports of the
 * same error onto one candidate, whoever filed them, and scrubs report text before
 * anything reads it (unified-bug-pipeline-and-honest-queue-2026-10-05 P-011,
 * SPEC-P-011, D-046).
 *
 * Falsifier (SPEC-P-011): two reports with the same tool and error signature
 * create two separate candidates. Driven through the real captureImprovement over
 * a stateful fake store, so the second call genuinely reads the first one back.
 * The pure normalization is error-signature.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { captureImprovement, redactIntakeText, type CaptureDeps } from './capture-core';
import { ERROR_SIGNATURE_KEY_PREFIX } from './error-signature';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

// Fixture secrets are assembled at runtime so no secret-shaped literal sits in the tree.
const FAKE_PASSWORD = ['hunter', 'two', 'x'.repeat(12)].join('');
const FAKE_TOKEN = ['tok', 'Q'.repeat(30)].join('');

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug', scope: 'operator', body: '', severity: 'minor', source: 'su', state: 'open',
    assignee: null, assignedBy: null, assignedAt: null, payload: null, foundDuring: null,
    linkedFeatureId: null, parent: null, createdBy: null, signalOrigin: 'organic', assigneeRank: null,
    rankWriter: null, rankUpdatedAt: null, lastProgressAt: null, origin: 'local', terminalOwner: null,
    terminalCompletionRef: null, completionAuthority: null, featureOrder: null,
    createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', closedAt: null, goalId: null,
    ...p,
  };
}

function storeDeps(): CaptureDeps & { created: CreateIssueInput[]; store: EngineerIssue[] } {
  const created: CreateIssueInput[] = [];
  const store: EngineerIssue[] = [];
  let nextId = 700;
  return {
    created,
    store,
    recordIssueOccurrence: async () => null,
    searchIssues: async () => [],
    createIssue: async (input) => {
      created.push(input);
      const row = issue({
        id: `EI-${nextId++}`, title: input.title, body: input.body ?? '',
        kind: (input.kind as 'bug' | 'change') ?? 'bug', payload: input.payload ?? null,
        createdBy: input.createdBy ?? null,
      });
      store.push(row);
      return row;
    },
    findIssuesByWatchdogKeys: async (keys) =>
      store.filter((i) => {
        const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
        return typeof k === 'string' && keys.includes(k);
      }),
    mergeIssuePayload: async (id, patch) => {
      const i = store.find((x) => x.id === id);
      if (!i) return null;
      i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
      return i;
    },
    updateIssuePatch: async (id, patch) => {
      const i = store.find((x) => x.id === id);
      if (!i) return null;
      if (patch.title !== undefined) i.title = patch.title;
      if (patch.body !== undefined) i.body = patch.body;
      return i;
    },
  };
}

const ERROR = 'plans:list failed (500): relation "harness_shared.plan_items_v2" does not exist';

describe('captureImprovement — one candidate per error signature (SPEC-P-011)', () => {
  it('a person and an agent reporting the same error land on ONE candidate (falsifier)', async () => {
    const d = storeDeps();
    const first = await captureImprovement(
      {
        title: 'The plans page shows an error and never loads',
        body: 'I opened Plans and it just says relation does not exist.',
        kind: 'bug',
        reporterKind: 'end-user',
        reportContext: { recentErrors: [{ message: `Error: ${ERROR}` }] },
      },
      d,
    );
    expect(first.created).toBe(true);
    const second = await captureImprovement(
      {
        title: 'plans:list fails against the new schema',
        body: 'Every call errors since the last migration.',
        kind: 'bug',
        createdBy: 'su-4a152da3',
        reportContext: { recentErrors: [{ message: ERROR.replace('500', '503'), source: 'plans:list' }] },
      },
      d,
    );
    expect(d.created).toHaveLength(1);
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(second.issue?.id).toBe(first.issue?.id);
    expect(second.coalescedOnto?.identity).toBe('error-signature');
    const row = d.store[0]!;
    const payload = row.payload as Record<string, unknown>;
    expect(String(payload.watchdogKey)).toMatch(new RegExp(`^${ERROR_SIGNATURE_KEY_PREFIX}[0-9a-f]{16}$`));
    // D-044: distinct reporter kinds in canonical order.
    expect(payload.reporterKinds).toEqual(['agent', 'end-user']);
    expect(payload.repeatCount).toBe(2);
    // The person's report keeps its words; the agent's account is an occurrence, not an overwrite.
    // The first report was the person's, so the candidate keeps its title, quoted as evidence (P-013, D-047).
    expect(row.title).toBe('“The plans page shows an error and never loads”');
    // The first report named no tool; the second does, so the stored signature learns it.
    expect((payload.errorSignature as { tool: string | null }).tool).toBe('plans:list');
  });

  it('the same error from two DIFFERENT known tools stays two candidates', async () => {
    const d = storeDeps();
    const msg = 'connection terminated unexpectedly while reading the result set';
    await captureImprovement(
      { title: 'coord:send drops messages', kind: 'bug', reportContext: { recentErrors: [{ message: msg, source: 'coord:send' }] } },
      d,
    );
    const second = await captureImprovement(
      { title: 'memory:search returns nothing', kind: 'bug', reportContext: { recentErrors: [{ message: msg, source: 'memory:search' }] } },
      d,
    );
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2);
    expect((d.created[1]!.payload as Record<string, unknown>).watchdogKey).toBeUndefined();
  });

  it('a generic error ("timeout") does not fold unrelated reports', async () => {
    const d = storeDeps();
    await captureImprovement({ title: 'Sync stalls on open', kind: 'bug', reportContext: { recentErrors: [{ message: 'Error: timeout' }] } }, d);
    await captureImprovement({ title: 'Export button does nothing', kind: 'bug', reportContext: { recentErrors: [{ message: 'timeout' }] } }, d);
    expect(d.created).toHaveLength(2);
  });

  it('changes and keyed watchdog filings are untouched by the inference', async () => {
    const d = storeDeps();
    await captureImprovement(
      { title: 'Add a dark theme', kind: 'feature', reportContext: { recentErrors: [{ message: ERROR }] } },
      d,
    );
    await captureImprovement(
      { title: 'collector saw it', kind: 'bug', watchdogKey: 'collector:x', reportContext: { recentErrors: [{ message: ERROR }] } },
      d,
    );
    expect((d.created[0]!.payload as Record<string, unknown>).watchdogKey).toBeUndefined();
    expect((d.created[1]!.payload as Record<string, unknown>).watchdogKey).toBe('collector:x');
  });
});

describe('redactIntakeText — every filing is scrubbed at the door (P-011)', () => {
  it('redacts credentials in title and body and records which fields changed', () => {
    const out = redactIntakeText({
      title: `login fails with password=${FAKE_PASSWORD}`,
      body: `the request sent token=${FAKE_TOKEN} and was refused`,
      kind: 'bug',
    });
    expect(out.title).not.toContain(FAKE_PASSWORD);
    expect(out.body).not.toContain(FAKE_TOKEN);
    expect(out.payloadExtra?.intakeRedaction).toMatchObject({ fields: ['title', 'body'] });
  });

  it('leaves clean text and payload untouched', () => {
    const input = { title: 'Plans page does not load', body: 'Nothing secret here.', kind: 'bug' as const };
    expect(redactIntakeText(input)).toBe(input);
  });

  it('captureImprovement stores the redacted text', async () => {
    const d = storeDeps();
    await captureImprovement({ title: 'credential leaked in a log line', body: `saw password=${FAKE_PASSWORD} in output`, kind: 'bug' }, d);
    expect(d.created[0]!.body).not.toContain(FAKE_PASSWORD);
    expect((d.created[0]!.payload as Record<string, unknown>).intakeRedaction).toMatchObject({ fields: ['body'] });
  });
});
