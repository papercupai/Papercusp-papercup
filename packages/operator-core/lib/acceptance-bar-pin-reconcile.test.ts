import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ withWorkspace: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: h.withWorkspace,
}));
vi.mock('./agent-tools/plans/plan-lock-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/plans/plan-lock-key')>()),
  acquirePlanAdvisoryLock: vi.fn(async () => undefined),
}));

import { reconcileStaleAcceptanceBarSubjectPin } from './acceptance-bar-pin-reconcile';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import { hashPlanContent } from './agent-tools/plans/content-hash';

// EI-22752422043395332: a BAR-neutral plan write that landed before the pin
// synchronizer was live strands the rubric's subjectPlanRevision. These cases pin
// the catch-up contract: neutral drift repairs, everything else refuses to guess.
function subjectPlan(overrides: { requirements?: string; now?: string } = {}): string {
  return `---
title: Subject plan
slug: subject-plan
status: active
created: 2026-09-06
updated: 2026-09-06
---

# Subject plan

## Now

**State:** ${overrides.now ?? 'working'}

**Next:** keep going

## Requirements

${overrides.requirements ?? '**R-1 — Canonical outcome.** The writer persists one canonical BAR.'}

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
`;
}

const SEEDED_PIN = 2;

function seed(seedContent: string = subjectPlan(), seedPin: number = SEEDED_PIN) {
  const seeded = buildAcceptanceBarSeed({
    planSlug: 'subject-plan',
    planContent: seedContent,
    actorId: 'seed-author',
    declaredAt: '2026-09-06T00:00:00.000Z',
    cohort: 'post-epoch',
    adoptionEpoch: 1,
    subjectPlanRevision: seedPin,
    planStatus: 'active',
    rubricSlug: 'acceptance-subject-plan',
    rubricRevision: 4,
  });
  if (!seeded.ok) throw new Error('fixture seed failed');
  return seeded;
}

/** A fake tx keyed on statement text, like acceptance-bar-amendment.test.ts. */
function fakeTx(opts: {
  version: number;
  content: string;
  witnessSnapshot: string | null;
  witnessHashOverride?: string;
  pin: number;
  rubricSlug?: string | null;
  /** The plan_revisions row at seq = pin; absent (the default) = history lacks it. */
  pinnedSnapshot?: string | null;
  pinnedHashOverride?: string;
  /** The body the rubric's BAR set was seeded/amended from (default: subjectPlan()). */
  seedContent?: string;
}) {
  const seeded = seed(opts.seedContent ?? subjectPlan(), opts.pin);
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const s = strings.join(' ');
    if (s.includes('LEFT JOIN harness_shared.plan_revisions')) {
      const snap = opts.pinnedSnapshot ?? null;
      return [{
        subject_version: String(opts.pin),
        content_snapshot: snap,
        content_hash: snap == null ? null : (opts.pinnedHashOverride ?? hashPlanContent(snap)),
      }];
    }
    if (s.includes('FROM harness_shared.plan_audits')) {
      if (opts.witnessSnapshot == null) return [];
      return [{
        content_snapshot: opts.witnessSnapshot,
        content_hash: opts.witnessHashOverride ?? hashPlanContent(opts.witnessSnapshot),
      }];
    }
    if (s.includes('SELECT version, content, acceptance_bar_rubric_slug')) {
      return [{
        version: opts.version, content: opts.content,
        acceptance_bar_rubric_slug: opts.rubricSlug === undefined ? 'acceptance-subject-plan' : opts.rubricSlug,
      }];
    }
    // synchronizeAcceptanceBarSubjectRevision's own statements.
    if (s.includes('SELECT status, acceptance_bar_rubric_slug')) {
      return [{
        status: 'active', acceptance_bar_rubric_slug: 'acceptance-subject-plan',
        acceptance_bar_rubric_revision: 4, acceptance_bar_set_hash: seeded.barSetHash,
      }];
    }
    if (s.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (s.includes('SELECT version, template_data')) return [{ version: 4, template_data: seeded.templateData }];
    if (s.includes('UPDATE harness_shared.harness_plans')) return [{ plan_slug: 'acceptance-subject-plan' }];
    throw new Error(`unexpected SQL: ${s}`);
  });
  h.withWorkspace.mockImplementation(async (_workspace: string, fn: (tx: unknown) => unknown) => fn(sql));
  const pinWrites = () => sql.mock.calls.filter(([strings]) =>
    strings.join(' ').includes('UPDATE harness_shared.harness_plans')).length;
  return { sql, pinWrites };
}

const ARGS = { workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'subject-plan' };

describe('reconcileStaleAcceptanceBarSubjectPin', () => {
  // Braces matter: `mockReset()` returns the mock, and vitest runs a function returned from
  // beforeEach as a teardown hook — which would call the mock with no `fn` after every test.
  beforeEach(() => {
    h.withWorkspace.mockReset();
  });

  it('catches a stranded pin up when only BAR-neutral prose changed since the activation audit', async () => {
    const { pinWrites } = fakeTx({
      version: 5, content: subjectPlan({ now: 'note: ← WI-1 released' }),
      witnessSnapshot: subjectPlan(), pin: SEEDED_PIN,
    });
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: true, fromRevision: SEEDED_PIN, toRevision: 5, witness: 'activation_audit',
    });
    expect(pinWrites()).toBeGreaterThan(0);
  });

  // WI-6554700010010492: Requirements were amended AFTER activation (rubrics:amend re-pins
  // to the amended revision), then a decision-only write landed on a build that left the pin
  // behind. The activation snapshot carries the PRE-amendment Requirements, so it can never
  // be source-equal to the current body; only the revision the pin names can witness it.
  describe('after a Requirements amendment', () => {
    const AMENDED = '**R-1 — Canonical outcome.** The writer persists one canonical BAR and its audit row.';
    const AMENDED_PIN = 4;
    const amendedAtPin = subjectPlan({ requirements: AMENDED });
    const decisionOnlyLater = subjectPlan({ requirements: AMENDED, now: 'D-013 recorded' });

    it('catches up from the pinned revision snapshot', async () => {
      const { pinWrites } = fakeTx({
        version: 6, content: decisionOnlyLater, pin: AMENDED_PIN, seedContent: amendedAtPin,
        witnessSnapshot: subjectPlan(), pinnedSnapshot: amendedAtPin,
      });
      await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
        reconciled: true, fromRevision: AMENDED_PIN, toRevision: 6, witness: 'pinned_revision',
      });
      expect(pinWrites()).toBeGreaterThan(0);
    });

    it('stays stranded when only the activation snapshot is available (the pre-fix behaviour)', async () => {
      const { pinWrites } = fakeTx({
        version: 6, content: decisionOnlyLater, pin: AMENDED_PIN, seedContent: amendedAtPin,
        witnessSnapshot: subjectPlan(), pinnedSnapshot: null,
      });
      await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
        reconciled: false, reason: 'not_neutral',
      });
      expect(pinWrites()).toBe(0);
    });

    it('still refuses a Requirements change made after the pin, even with the pinned witness', async () => {
      const { pinWrites } = fakeTx({
        version: 6,
        content: subjectPlan({ requirements: '**R-1 — Canonical outcome.** Changed again without an amend.' }),
        pin: AMENDED_PIN, seedContent: amendedAtPin, witnessSnapshot: subjectPlan(), pinnedSnapshot: amendedAtPin,
      });
      await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
        reconciled: false, reason: 'not_neutral',
      });
      expect(pinWrites()).toBe(0);
    });

    it('does not trust a pinned row whose bytes no longer match its hash', async () => {
      const { pinWrites } = fakeTx({
        version: 6, content: decisionOnlyLater, pin: AMENDED_PIN, seedContent: amendedAtPin,
        witnessSnapshot: null, pinnedSnapshot: amendedAtPin, pinnedHashOverride: 'e'.repeat(64),
      });
      await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
        reconciled: false, reason: 'no_witness',
      });
      expect(pinWrites()).toBe(0);
    });
  });

  it('refuses to repair when the Requirements changed — that needs rubrics:amend', async () => {
    const { pinWrites } = fakeTx({
      version: 5,
      content: subjectPlan({ requirements: '**R-1 — Canonical outcome.** The promise itself changed.' }),
      witnessSnapshot: subjectPlan(), pin: SEEDED_PIN,
    });
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: false, reason: 'not_neutral',
    });
    expect(pinWrites()).toBe(0);
  });

  it('does nothing without any witness (no pinned row, no activation audit)', async () => {
    const { pinWrites } = fakeTx({
      version: 5, content: subjectPlan({ now: 'edited' }), witnessSnapshot: null, pin: SEEDED_PIN,
    });
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: false, reason: 'no_witness',
    });
    expect(pinWrites()).toBe(0);
  });

  it('does not trust a witness snapshot whose bytes no longer match its recorded hash', async () => {
    const { pinWrites } = fakeTx({
      version: 5, content: subjectPlan({ now: 'edited' }),
      witnessSnapshot: subjectPlan(), witnessHashOverride: 'f'.repeat(64), pin: SEEDED_PIN,
    });
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: false, reason: 'no_witness',
    });
    expect(pinWrites()).toBe(0);
  });

  it('is a no-op when the pin already names the current revision', async () => {
    const { pinWrites } = fakeTx({
      version: SEEDED_PIN, content: subjectPlan(), witnessSnapshot: subjectPlan(), pin: SEEDED_PIN,
    });
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: false, reason: 'pin_current',
    });
    expect(pinWrites()).toBe(0);
  });

  it('is a no-op for a plan that has no acceptance rubric', async () => {
    fakeTx({
      version: 5, content: subjectPlan(), witnessSnapshot: subjectPlan(), pin: SEEDED_PIN, rubricSlug: null,
    });
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: false, reason: 'not_bar_subject',
    });
  });

  it('degrades a busy plan lock (55P03) to a refusal instead of crashing the start door', async () => {
    h.withWorkspace.mockRejectedValue(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    );
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).resolves.toEqual({
      reconciled: false, reason: 'not_neutral',
    });
  });

  it('still surfaces an unrelated database failure', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: '57P01' });
    h.withWorkspace.mockRejectedValue(boom);
    await expect(reconcileStaleAcceptanceBarSubjectPin(ARGS)).rejects.toBe(boom);
  });
});
