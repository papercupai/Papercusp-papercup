import { describe, expect, it, vi } from 'vitest';
import {
  classifyAcceptanceBarMigration,
  effectiveLegacyBarKey,
  runAcceptanceBarMigration,
  type AcceptanceBarMigrationPlan,
} from './acceptance-bar-migration';

describe('EI-23379913422335853 — legacy-backfill bar-key attribution', () => {
  // THE BUG. A plan old enough to need legacy backfill is exactly the plan whose clauses
  // predate `source_bar_key`. Filtering on the criterion's barKey excluded every row, so
  // `mapRows` came back empty and the branch could never satisfy its own precondition —
  // the migration refused `bar-backfill-required` for the very cohort it was written for.
  // null is load-bearing: it makes the caller's
  // `(${key}::text IS NULL OR r.source_bar_key = ${key})` short-circuit to an agnostic match.
  it('falls back to a barKey-AGNOSTIC match when the plan attributes no clause at all', () => {
    expect(effectiveLegacyBarKey('R-1', false)).toBeNull();
  });

  // THE SAFETY PROPERTY, and the reason the fix is not just "stop filtering". A future
  // simplification that drops the attribution guard and always returns null would still
  // pass the test above while silently mis-attributing clauses to the wrong bar. This is
  // the arm that catches it.
  it('keeps the STRICT match when the plan does attribute, so no clause is mis-attributed', () => {
    expect(effectiveLegacyBarKey('R-1', true)).toBe('R-1');
    expect(effectiveLegacyBarKey('R-2', true)).toBe('R-2');
  });

  // An attributing plan whose criterion carries no barKey has nothing to filter ON; it must
  // degrade to the agnostic match rather than to the string "undefined".
  it('returns null when an attributing plan has a criterion with no barKey', () => {
    expect(effectiveLegacyBarKey(undefined, true)).toBeNull();
    expect(effectiveLegacyBarKey(null, true)).toBeNull();
  });

  // The caller reads `attributionRows[0]?.has_attribution ?? false`. An EMPTY result set is
  // "this plan attributes nothing", which must reach the agnostic arm — not be treated as
  // attributing and re-strand the cohort this fix exists to unblock.
  it('treats an absent attribution row as no-attribution', () => {
    const rows: Array<{ has_attribution: boolean }> = [];
    expect(effectiveLegacyBarKey('R-1', rows[0]?.has_attribution ?? false)).toBeNull();
  });
});

const plan = (over: Partial<AcceptanceBarMigrationPlan> = {}): AcceptanceBarMigrationPlan => ({
  planSlug: 'plan-a',
  status: 'ready',
  content: '**R-1 — Outcome.** The outcome exists. ',
  ...over,
});

describe('acceptance BAR cohort migration policy (P-010)', () => {
  it('keeps terminal history closed', () => {
    expect(classifyAcceptanceBarMigration(plan({ status: 'shipped', content: '' }))).toMatchObject({
      action: 'skip-historical-terminal',
      cohort: null,
    });
  });

  it('strictly seeds drafts', () => {
    expect(classifyAcceptanceBarMigration(plan({ status: 'draft', content: '' }))).toMatchObject({
      action: 'seed-strict',
      cohort: 'post-epoch',
    });
  });

  it.each(['wip', 'done', 'blocked', 'needs-human'])(
    'backfills a draft containing %s work without removing strict enforcement', (status) => {
      const content = `${plan().content}\n\n## Phase 1 — Build\n\n- **P-001** \`${status}\` implement the outcome\n`;
      expect(classifyAcceptanceBarMigration(plan({ status: 'draft', content }))).toMatchObject({
        action: 'legacy-backfill', cohort: 'post-epoch',
      });
    },
  );

  it.each(['todo', 'dropped'])('keeps a draft with only %s items prospective', (status) => {
    const content = `${plan().content}\n\n## Phase 1 — Build\n\n- **P-001** \`${status}\` implement the outcome\n`;
    expect(classifyAcceptanceBarMigration(plan({ status: 'draft', content }))).toMatchObject({
      action: 'seed-strict', cohort: 'post-epoch',
    });
  });

  it('refuses to invent requirements for an already-started draft', () => {
    const content = '## Phase 1 — Build\n\n- **P-001** `wip` implement the outcome\n';
    expect(classifyAcceptanceBarMigration(plan({ status: 'draft', content }))).toMatchObject({
      action: 'bar-backfill-required',
    });
  });

  it('legacy-backfills only from Requirements or an explicit live mapped criterion', () => {
    expect(classifyAcceptanceBarMigration(plan())).toMatchObject({ action: 'legacy-backfill' });
    expect(classifyAcceptanceBarMigration(plan({ acceptanceBarCohort: 'post-epoch' }))).toMatchObject({
      action: 'legacy-backfill',
      cohort: 'post-epoch',
    });
    expect(classifyAcceptanceBarMigration(plan({ acceptanceBarEpoch: 1 }))).toMatchObject({
      action: 'legacy-backfill', cohort: 'post-epoch',
    });
    expect(
      classifyAcceptanceBarMigration(
        plan({ content: '', explicitLegacyCriterion: { model: 'x' }, hasLiveMapping: true }),
      ),
    ).toMatchObject({ action: 'legacy-backfill' });
    expect(
      classifyAcceptanceBarMigration(
        plan({ content: '', explicitLegacyCriterion: { model: 'x' }, hasLiveMapping: false }),
      ),
    ).toMatchObject({ action: 'bar-backfill-required' });
  });

  it('refuses to fabricate a BAR source', () => {
    const result = classifyAcceptanceBarMigration(plan({ content: '' }));
    expect(result.action).toBe('bar-backfill-required');
    expect(result.reason).toMatch(/fabricated BARs are forbidden/);
  });
});

describe('runAcceptanceBarMigration', () => {
  it('is dry-runnable and returns a resumable cursor without applying plans', async () => {
    const applyPlan = vi.fn();
    const result = await runAcceptanceBarMigration({
      cursor: 'after-0',
      batchSize: 2,
      dryRun: true,
      readPage: async ({ cursor, limit }) => {
        expect(cursor).toBe('after-0');
        expect(limit).toBe(2);
        return {
          plans: [plan({ planSlug: 'a' }), plan({ planSlug: 'b', status: 'shipped', content: '' })],
          nextCursor: 'after-b',
        };
      },
      applyPlan,
    });
    expect(result).toMatchObject({ dryRun: true, startCursor: 'after-0', nextCursor: 'after-b', complete: false });
    expect(result.outcomes.map((item) => item.status)).toEqual(['dry-run', 'skipped']);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('isolates per-plan rollback failures and still advances the page', async () => {
    const result = await runAcceptanceBarMigration({
      readPage: async () => ({ plans: [plan({ planSlug: 'a' }), plan({ planSlug: 'b' })], nextCursor: null }),
      applyPlan: async ({ plan: current }) => {
        if (current.planSlug === 'a') throw new Error('transaction rolled back');
        return 'committed idempotently';
      },
    });
    expect(result.complete).toBe(true);
    expect(result.outcomes.map((item) => item.status)).toEqual(['failed', 'applied']);
    expect(result.outcomes[0]?.detail).toContain('rolled back');
  });
});
