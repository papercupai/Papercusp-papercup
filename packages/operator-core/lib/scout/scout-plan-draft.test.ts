/**
 * scout-plan-draft.test.ts — Scout P-007 broad rail draft creator.
 * Pure template + the withPlanLock-backed create (injected lock, no PG).
 */
import { describe, it, expect } from 'vitest';
import { buildScoutPlanTemplate, ensureDatedSlug, createScoutPlanDraft, type ScoutPlanDraftDeps } from './scout-plan-draft';
import { specTriadGate } from '../agent-tools/plans/spec-triad-policy';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

describe('ensureDatedSlug', () => {
  it('appends today when no date suffix', () => {
    expect(ensureDatedSlug('my-idea', '2026-06-08')).toBe('my-idea-2026-06-08');
  });
  it('preserves an existing date suffix', () => {
    expect(ensureDatedSlug('my-idea-2026-01-01', '2026-06-08')).toBe('my-idea-2026-01-01');
  });
});

describe('buildScoutPlanTemplate', () => {
  it('produces a valid DRAFT plan body', () => {
    const body = buildScoutPlanTemplate({ slug: 'x-2026-06-08', title: 'A bold idea', date: '2026-06-08', rationale: 'because reasons' });
    expect(body).toContain('status: draft');
    expect(body).toContain('title: A bold idea');
    expect(body).toContain('slug: x-2026-06-08');
    expect(body).toContain('because reasons');
    expect(body).toContain('## Now');
    expect(body).toContain('## Decisions');
  });
  it('falls back to a default background when no rationale', () => {
    const body = buildScoutPlanTemplate({ slug: 'x-2026-06-08', title: 'T', date: '2026-06-08' });
    expect(body).toContain('Blender-generated broad-scope proposal');
  });
  it('marks the default placeholder triad as incomplete for post-epoch gating', () => {
    const body = buildScoutPlanTemplate({
      slug: 'x-2026-08-13',
      title: 'A routed proposal',
      date: '2026-08-13',
      rationale: 'The proposal must leave a verifiable outcome.',
    });
    const verdict = specTriadGate(
      { planSlug: 'x-2026-08-13', content: body, created: '2026-08-13', itemCount: 1 },
      { flagEnabled: true, epoch: new Date('2026-08-09T00:00:00.000Z') },
    );

    expect(body).toContain('specTriad: required');
    expect(body).toContain('## Requirements');
    expect(body).toContain('## Design');
    expect(verdict.gated).toBe(true);
    expect(verdict.missing).toEqual(['requirements', 'design']);
  });
});

describe('createScoutPlanDraft', () => {
  function fakeLock(over: { current?: string | null; busy?: boolean; stampThrows?: boolean } = {}): {
    deps: ScoutPlanDraftDeps;
    captured: { body: string | null; revisionCalls: unknown[]; stampCalls: unknown[]; lockScopes: unknown[] };
  } {
    const captured = {
      body: null as string | null,
      revisionCalls: [] as unknown[],
      stampCalls: [] as unknown[],
      lockScopes: [] as unknown[],
    };
    const deps: ScoutPlanDraftDeps = {
      // Always injected, so no test can reach the real helper (which opens the org PG).
      stampPlanGoalProvenance: (async (args) => {
        captured.stampCalls.push(args);
        if (over.stampThrows) throw new Error('goal holder authority: not the elected holder');
        return 'goal-from-owner-context';
      }) as NonNullable<ScoutPlanDraftDeps['stampPlanGoalProvenance']>,
      withPlanLock: (async (_ctx, opts, mutator) => {
        captured.lockScopes.push({ harnessSlug: opts.harnessSlug, workspaceId: opts.workspaceId });
        if (over.busy) return { kind: 'busy', busy: [] };
        const { newBody, value } = await mutator(over.current ?? null, null, { workspaceId: 'ws-test', harnessSlug: 'papercup' });
        captured.body = newBody;
        if (newBody !== null && opts.afterWrite) {
          await opts.afterWrite(newBody, { workspaceId: 'ws-test', harnessSlug: 'papercup' }, null);
        }
        return { kind: 'applied', value, filePath: 'synthetic', version: 1 };
      }) as ScoutPlanDraftDeps['withPlanLock'],
      recordPlanRevision: (async (args) => {
        captured.revisionCalls.push(args);
        return { seq: 1, contentHash: 'test' };
      }) as NonNullable<ScoutPlanDraftDeps['recordPlanRevision']>,
    };
    return { deps, captured };
  }

  it('homes a workspace-singleton draft to the platform Hive while retaining its workspace', async () => {
    const { deps, captured } = fakeLock();
    await createScoutPlanDraft({ slug: 'singleton', title: 'T', harnessSlug: 'ws-scout', workspaceId: 'ws-scout' }, deps);
    expect(captured.lockScopes).toEqual([{ harnessSlug: operatorHomeHarnessSlug(), workspaceId: 'ws-scout' }]);
  });

  it('preserves an explicit member Hive scope for the canonical plan writer to resolve', async () => {
    const { deps, captured } = fakeLock();
    await createScoutPlanDraft({ slug: 'member', title: 'T', harnessSlug: 'team-member', workspaceId: 'ws-team' }, deps);
    expect(captured.lockScopes).toEqual([{ harnessSlug: 'team-member', workspaceId: 'ws-team' }]);
  });

  it('creates a new draft (created:true) and writes the templated body', async () => {
    const { deps, captured } = fakeLock({ current: null });
    const r = await createScoutPlanDraft({ slug: 'idea', title: 'T', date: '2026-06-08', harnessSlug: 'papercup' }, deps);
    expect(r).toEqual({ slug: 'idea-2026-06-08', created: true });
    expect(captured.body).toContain('status: draft');
  });

  it('records an initial plan revision for a newly-created draft', async () => {
    const { deps, captured } = fakeLock({ current: null });
    const result = await createScoutPlanDraft({ slug: 'revisioned-idea', title: 'T', date: '2026-06-08' }, deps);
    expect(result.created).toBe(true);
    // The injected writer is called through the canonical afterWrite hook. The
    // production implementation writes this row to plan_revisions, making
    // activation audit immediately usable instead of racing a best-effort repair.
    expect(captured.revisionCalls).toHaveLength(1);
    expect(captured.revisionCalls[0]).toMatchObject({
      planSlug: 'revisioned-idea-2026-06-08',
      workspaceId: 'ws-test',
      harnessSlug: 'papercup',
      content: expect.stringContaining('status: draft'),
    });
  });

  it('is idempotent: an existing slug returns created:false and writes nothing', async () => {
    const { deps, captured } = fakeLock({ current: '---\ntitle: existing\n---\n' });
    const r = await createScoutPlanDraft({ slug: 'idea-2026-06-08', title: 'T' }, deps);
    expect(r.created).toBe(false);
    expect(captured.body).toBeNull();
  });

  /**
   * Goal attribution (WI-2142649). This rail is a THIRD plan-creation path beside
   * plans:new and plans:launch, and it reached NEITHER goal stamp — so every draft
   * routed through `blender:route-idea` landed with `harness_plans.goal_id` NULL and
   * was invisible on the goal page (measured: 4 of 4 routed origins over 48h). These
   * pin the same three properties `launch.goal-stamp.test.ts` pins for plans:launch.
   */
  describe('goal provenance', () => {
    // Typed fixture, not a cast: it stays checked against AgentIdentity, so a field
    // added to the real interface strands HERE at tsc (the same discipline
    // launch.goal-stamp.test.ts uses for its identity fixture).
    const routerIdentity: NonNullable<
      Parameters<typeof createScoutPlanDraft>[0]['revisionIdentity']
    > = {
      ownerId: 'su-router-1',
      ownerLabel: 'su · router',
      source: 'omp-hook-session',
      workspaceId: 'ws-test',
      userId: null,
    };

    /** The single assertion under test, so the control below can be aimed at it. */
    function expectStampedOnCreate(stampCalls: unknown[], planSlug: string) {
      expect(stampCalls).toHaveLength(1);
      expect(stampCalls[0]).toEqual({
        workspaceId: 'ws-test',
        harnessSlug: 'papercup',
        planSlug,
        ownerId: 'su-router-1',
      });
    }

    // CALIBRATION: the REAL subject must satisfy the assertion.
    it('stamps a newly-created draft from the RESOLVED scope and the caller identity', async () => {
      const { deps, captured } = fakeLock({ current: null });
      // `harnessSlug: 'member-harness'` is deliberately NOT the scope the lock
      // resolved ('papercup'): the stamp must follow the pair the row was actually
      // written with, or it misses pot-scoped plans as a silent zero-row UPDATE.
      const r = await createScoutPlanDraft(
        {
          slug: 'stamped-idea',
          title: 'T',
          date: '2026-06-08',
          harnessSlug: 'member-harness',
          revisionIdentity: routerIdentity,
        },
        deps,
      );

      expect(r.created).toBe(true);
      expectStampedOnCreate(captured.stampCalls, 'stamped-idea-2026-06-08');
    });

    /**
     * FALSIFIABILITY CONTROL (CLAUDE.md § "Proving a guard is falsifiable", MODULE
     * tier: keep a deliberately-wrong implementation as a permanent control rather
     * than mutating production code). A guard that has never failed is untested, and
     * the assertion above would be vacuous if it passed on the PRE-FIX rail — which
     * recorded the revision and stamped nothing. Aimed at the same helper the
     * calibration case uses, so the two cannot drift apart.
     */
    it('CONTROL: those assertions REJECT the pre-fix rail, which stamped nothing', () => {
      const preFixStampCalls: unknown[] = []; // what blender:route-idea did before WI-2142649
      expect(() => expectStampedOnCreate(preFixStampCalls, 'stamped-idea-2026-06-08')).toThrow();

      // ...and reject a stamp aimed at the CALLER's raw harness instead of the
      // resolved one — the silent zero-row UPDATE new.ts documents.
      const rawHarnessStamp = [
        {
          workspaceId: 'ws-test',
          harnessSlug: 'member-harness',
          planSlug: 'stamped-idea-2026-06-08',
          ownerId: 'su-router-1',
        },
      ];
      expect(() => expectStampedOnCreate(rawHarnessStamp, 'stamped-idea-2026-06-08')).toThrow();
    });

    it('does not stamp on the idempotent already-exists path', async () => {
      const { deps, captured } = fakeLock({ current: '---\ntitle: existing\n---\n' });
      const r = await createScoutPlanDraft(
        { slug: 'idea-2026-06-08', title: 'T', revisionIdentity: routerIdentity },
        deps,
      );
      // A replayed routine step must not stamp a plan it did not author.
      expect(r.created).toBe(false);
      expect(captured.stampCalls).toEqual([]);
    });

    it('passes no ownerId for a system scout-cycle step, so nothing is attributed', async () => {
      const { deps, captured } = fakeLock({ current: null });
      await createScoutPlanDraft({ slug: 'system-idea', title: 'T', date: '2026-06-08' }, deps);
      // The `scout:route-idea` static fallback identity is for the REVISION row only.
      // Handing it to the stamp would attribute a routine's draft to a pseudo-owner;
      // an undefined ownerId makes the helper's own guard decline instead.
      expect(captured.stampCalls).toHaveLength(1);
      expect((captured.stampCalls[0] as { ownerId?: string }).ownerId).toBeUndefined();
    });

    it('never fails a created plan when the stamp throws', async () => {
      const { deps, captured } = fakeLock({ current: null, stampThrows: true });
      // withPlanLock AWAITS afterWrite, so an unswallowed rejection here would fail a
      // plan that was already written. Provenance is metadata; the create still stands.
      const r = await createScoutPlanDraft(
        { slug: 'resilient-idea', title: 'T', date: '2026-06-08', revisionIdentity: routerIdentity },
        deps,
      );
      expect(r).toEqual({ slug: 'resilient-idea-2026-06-08', created: true });
      expect(captured.stampCalls).toHaveLength(1);
      expect(captured.revisionCalls).toHaveLength(1);
    });
  });

  it('keeps substantive custom buildBody content eligible for the spec triad', async () => {
    const customBody = [
      '---',
      'slug: custom-2026-08-13',
      'status: draft',
      'specTriad: required',
      'created: 2026-08-13',
      '---',
      '',
      '# Custom proposal',
      '',
      '## Requirements',
      '',
      'The first slice must expose a deterministic result that a reviewer can verify.',
      '',
      '## Design',
      '',
      'The implementation will isolate the smallest observable change and its test seam.',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement and verify the custom proposal',
      '',
    ].join('\n');
    const { deps, captured } = fakeLock({ current: null });

    const result = await createScoutPlanDraft(
      {
        slug: 'custom',
        title: 'Custom proposal',
        date: '2026-08-13',
        buildBody: () => customBody,
      },
      deps,
    );

    expect(result).toEqual({ slug: 'custom-2026-08-13', created: true });
    const verdict = specTriadGate(
      {
        planSlug: result.slug,
        content: captured.body!,
        created: '2026-08-13',
        itemCount: 1,
      },
      { flagEnabled: true, epoch: new Date('2026-08-09T00:00:00.000Z') },
    );
    expect(verdict.gated).toBe(false);
    expect(verdict.missing).toEqual([]);
  });

  it('throws on lock contention (busy)', async () => {
    const { deps } = fakeLock({ busy: true });
    await expect(createScoutPlanDraft({ slug: 'idea', title: 'T' }, deps)).rejects.toThrow(/being written/);
  });
});
