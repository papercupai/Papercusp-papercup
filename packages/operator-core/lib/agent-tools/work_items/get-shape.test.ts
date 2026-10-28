/**
 * get-shape.test.ts — work_items:get payload-tier shapers (EI-19447969329510166).
 *
 * The defect these guard: with no shaper declared, a trimmed session fell through
 * to the framework's generic bounded projection, which clipped the CHECKPOINT —
 * the one field this tool exists to deliver on a post-respawn re-orient — to 800
 * chars, silently. The tests below pin the two properties that matter: the
 * checkpoint survives, and anything that does NOT survive says so.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/get-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { PAYLOAD_TIER_HARD_CEILING_CHARS } from "@papercusp/agent-mcp";
import { CHARS_PER_TOKEN_ESTIMATE } from "../../context-doors";
import { RESULT_DOOR_TOKENS } from "../../result-door";
import { COMPLETION_EMITTED_AT_ROW, shapeWorkItemsGet } from "./get-shape";

type Envelope = {
  ok: boolean;
  results: Array<Record<string, unknown>>;
  counts: { ok: number; failed: number };
  read?: Record<string, unknown>;
  _shapeNote?: {
    dropped: string[];
    checkpointCharsPerRow: number;
    summaryCharsPerRow: number;
    next: string;
    stubbed?: {
      count: number;
      note: string;
      completionEvidence?: { all?: boolean; ids?: unknown[] };
    };
    singleItemFloor?: string;
  };
};

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    id: "WI-1",
    workItem: {
      id: "WI-1",
      kind: "bug",
      state: "open",
      title: "a title",
      severity: "major",
      origin: "local",
      assignee: "su-1",
      summary: "S".repeat(4_000),
      payload: { big: "P".repeat(4_000) },
    },
    checkpoint: null,
    checkpointAgeMs: null,
    checkpointUpdatedAtMs: null,
    ...over,
  };
}

function envelope(rows: Array<Record<string, unknown>>): Envelope {
  return { ok: true, results: rows, counts: { ok: rows.length, failed: 0 } };
}

function operationalBrief(subject: string, text: string): Record<string, unknown> {
  return {
    schemaVersion: "operational-brief-v1",
    surface: "work-item",
    subject,
    state: { status: "known", value: "open", source: "workItem.state" },
    owner: { status: "known", value: "su-1", source: "workItem.assignee" },
    nextAction: { status: "known", value: "Read the focused regression result.", source: "checkpoint.next" },
    blockers: { status: "known", value: [], source: "workItem.payload external blockers (active)" },
    lastVerified: { status: "unknown", reason: "no verified completion evidence is recorded" },
    deadline: { status: "unknown", reason: "work-item reads do not measure a deadline" },
    facts: {
      kind: "bug",
      claim: { status: "known", value: { assignee: "su-1", takenAt: null, lastProgressAt: null, holderGoal: null, holderStale: null }, source: "workItem claim" },
      checkpoint: { status: "known", value: { status: "available", updatedAt: null, contentHash: null, structured: false }, source: "workItem checkpoint" },
      successorResidue: { status: "known", value: { left: null, walls: [] }, source: "checkpoint" },
      holdsUp: { status: "unknown", reason: "outgoing links require detail:true" },
      blockedByLinks: { status: "unknown", reason: "incoming links are not read by work_items:get" },
    },
    unknowns: ["lastVerified", "deadline", "facts.holdsUp", "facts.blockedByLinks"],
    text,
  };
}

describe("shapeWorkItemsGet — the checkpoint is the payload, degraded last", () => {
  it('preserves a standalone bounded attachment byte page through both tiers', () => {
    const evidence = { sourceWorkItemId: 'EI-source', attachments: [], page: {
      id: 'attachment', encoding: 'base64', data: Buffer.alloc(2048, 1).toString('base64'),
      offset: 0, byteLength: 2048, totalBytes: 4096, nextOffset: 2048,
    } };
    for (const tier of ['standard', 'trimmed'] as const) {
      const result = shapeWorkItemsGet(envelope([{ ok: true, id: 'WI-1', reportAttachments: evidence }]), tier) as Envelope;
      expect(result.results[0].reportAttachments).toEqual(evidence);
    }
  });
  it('preserves the top-level read/count qualifiers and plan-item text drift', () => {
    const read = {
      schemaVersion: 'work-items-get-read-v1',
      mode: 'projected',
      requested: 1,
      available: 1,
      absent: 0,
      unavailable: 0,
      budgetMs: 30_000,
      elapsedMs: 7,
      baseReadMaxMs: 4,
      enrichmentMaxMs: 0,
      outerStageAttribution: 'tool_invocations.duration_ms minus elapsedMs is combined dispatch/projection/serialization time',
    };
    const out = shapeWorkItemsGet(
      { ...envelope([row({ availability: 'available', planItemTextDrift: { status: 'drifted' } })]), read },
      'trimmed',
    ) as Envelope;

    expect(out.counts).toEqual({ ok: 1, failed: 0 });
    expect(out.read).toEqual({ ...read, detailRows: 1, stubbedRows: 0 });
    expect(out.results[0]).toMatchObject({
      availability: 'available',
      planItemTextDrift: { status: 'drifted' },
    });
  });

  it("shapes checksOnly as a bounded ledger and removes the internal marker and full-read fields", () => {
    const out = shapeWorkItemsGet(
      {
        ok: true,
        __checksOnly: true,
        results: [
          {
            ok: true,
            id: "WI-checks-only",
            workItem: {
              id: "WI-checks-only",
              title: "must be omitted",
              payload: { secret: "must be omitted" },
            },
            checkpoint: "private narrative must be omitted",
            checkpointChecks: {
              count: 2,
              cap: 12,
              remaining: 10,
              rows: [
                { id: "gate-green", claim: "C".repeat(5_000) },
                { claim: "main points at the tested commit" },
              ],
            },
            checkpointAgeMs: 12,
            checkpointUpdatedAtMs: 34,
            checkpointContentHash: "81344e6f2817",
          },
          { ok: false, id: "WI-missing", error: "not found" },
        ],
        counts: { ok: 1, failed: 1 },
      },
      "trimmed",
    ) as Record<string, any>;

    expect(out.__checksOnly).toBeUndefined();
    expect(out._shapeNote).toMatchObject({
      tier: "trimmed",
      checksOnly: true,
    });
    expect(out.results[0]).toMatchObject({
      ok: true,
      id: "WI-checks-only",
      checkpointChecks: {
        count: 2,
        cap: 12,
        remaining: 10,
        rows: [
          { id: "gate-green" },
          { claim: "main points at the tested commit" },
        ],
      },
      checkpointAgeMs: 12,
      checkpointUpdatedAtMs: 34,
      checkpointContentHash: "81344e6f2817",
    });
    expect(out.results[0].checkpointChecks.rows[0].claim).toMatch(/TRUNCATED/);
    expect(out.results[0]).not.toHaveProperty("workItem");
    expect(out.results[0]).not.toHaveProperty("checkpoint");
    expect(out.results[1]).toEqual({ ok: false, id: "WI-missing", error: "not found" });
  });

  it('preserves the exact checkpoint page and marks ordinary clipped checkpoints as recoverable', () => {
    const page = {
      offset: 0,
      limit: 768,
      totalChars: 10_000,
      returnedChars: 768,
      nextOffset: 768,
      text: 'P'.repeat(768),
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const exact = shapeWorkItemsGet({
        ...envelope([{ ok: true, id: 'WI-page', checkpointPage: page, checkpointContentHash: '123456789abc' }]),
        __checkpointOnly: true,
      }, tier) as Envelope;
      expect(exact._shapeNote).toMatchObject({ checkpointOnly: true });
      expect(exact.results[0]).toMatchObject({ checkpointPage: page, checkpointContentHash: '123456789abc' });
      expect(exact.results[0]).not.toHaveProperty('checkpoint');

      const ordinary = shapeWorkItemsGet(envelope([row({ checkpoint: 'C'.repeat(20_000) })]), tier) as Envelope;
      expect(ordinary.results[0].checkpointTruncated).toBe(true);
      expect(String(ordinary.results[0].checkpoint)).toContain('[TRUNCATED');
    }
  });

  it('preserves checkpoint check-row capacity in both payload tiers and compact fallback', () => {
    const checkpointChecks = { count: 10, cap: 12, remaining: 2 };
    for (const tier of ['trimmed', 'standard'] as const) {
      const normal = shapeWorkItemsGet(envelope([row({ checkpointChecks })]), tier) as Envelope;
      expect(normal.results[0].checkpointChecks).toEqual(checkpointChecks);

      const compact = shapeWorkItemsGet(
        envelope([row({ checkpoint: 'C'.repeat(40_000), checkpointChecks })]),
        tier,
      ) as Envelope;
      expect(compact.results[0].checkpointChecks).toEqual(checkpointChecks);
    }
  });

  it('preserves checkpoint subject identity through clipping and checksOnly shaping', () => {
    const checkpointSubjectFingerprint = {
      status: 'mismatch',
      current: { version: 1, sha256: 'a'.repeat(64) },
      stored: { version: 1, sha256: 'b'.repeat(64) },
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const normal = shapeWorkItemsGet(
        envelope([row({ checkpoint: 'C'.repeat(40_000), checkpointSubjectFingerprint })]),
        tier,
      ) as Envelope;
      expect(normal.results[0].checkpointSubjectFingerprint).toEqual(checkpointSubjectFingerprint);
      expect(String(normal.results[0].checkpoint).length).toBeLessThan(40_000);

      const checksOnly = shapeWorkItemsGet(
        {
          ok: true,
          __checksOnly: true,
          results: [{ ok: true, id: 'WI-checks-only', checkpointSubjectFingerprint }],
          counts: { ok: 1, failed: 0 },
        },
        tier,
      ) as Envelope;
      expect(checksOnly.results[0].checkpointSubjectFingerprint).toEqual(checkpointSubjectFingerprint);
    }
  });

  it('bounds normal checkpoint identity claims without dropping the ledger qualifiers', () => {
    const checkpointChecks = {
      count: 1,
      cap: 12,
      remaining: 11,
      rows: [{ id: 'gate-green', claim: 'C'.repeat(5_000) }],
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeWorkItemsGet(envelope([row({ checkpointChecks })]), tier) as Envelope;
      expect(out.results[0].checkpointChecks).toMatchObject({
        count: 1,
        cap: 12,
        remaining: 11,
        rows: [{ id: 'gate-green' }],
      });
      const shapedChecks = out.results[0].checkpointChecks as { rows: Array<{ claim: string }> };
      expect(shapedChecks.rows[0].claim).toMatch(/TRUNCATED/);
      expect(out._shapeNote?.dropped).toContain('checkpointChecks.rows');
    }
  });

  // EI-22659954682164298. The BODY counterpart of the test above, and the reason it
  // exists: at the cap, `work_items:checkpoint` keeps succeeding and evicts the OLDEST
  // content, announcing it only with a marker written into the body AFTER the loss. This
  // envelope is the one signal that arrives while a writer can still act on it, so a
  // shape tier dropping it under budget would restore the silent-eviction reading.
  it('preserves checkpoint BODY headroom in both payload tiers and compact fallback', () => {
    const checkpointBody = { chars: 31_000, cap: 32_000, remaining: 1_000 };
    for (const tier of ['trimmed', 'standard'] as const) {
      const normal = shapeWorkItemsGet(envelope([row({ checkpointBody })]), tier) as Envelope;
      expect(normal.results[0].checkpointBody).toEqual(checkpointBody);

      const compact = shapeWorkItemsGet(
        envelope([row({ checkpoint: 'C'.repeat(40_000), checkpointBody })]),
        tier,
      ) as Envelope;
      expect(compact.results[0].checkpointBody).toEqual(checkpointBody);
    }
  });

  // The specific misreading this field must never produce. `checkpoint` is clipped per
  // tier, so a reader who measured THAT string would infer generous headroom for a note
  // that is actually at the cap and already evicting. `chars` describes the STORED note;
  // it must stay divorced from the clipped payload on the same row.
  it('reports BODY headroom of the STORED note, never of the clipped checkpoint payload', () => {
    const atCap = { chars: 32_000, cap: 32_000, remaining: 0 };
    const out = shapeWorkItemsGet(
      envelope([row({ checkpoint: 'C'.repeat(32_000), checkpointBody: atCap })]),
      'trimmed',
    ) as Envelope;

    const shapedCheckpoint = out.results[0].checkpoint as string;
    expect(shapedCheckpoint.length).toBeLessThan(32_000); // the clip really happened
    expect(out.results[0].checkpointBody).toEqual(atCap);
    expect((out.results[0].checkpointBody as { remaining: number }).remaining).toBe(0);
  });

  // A FAILED checkpoint read must not report maximal headroom — the single most
  // reassuring value this field can carry. `null` is the same contract
  // `checkpointContentHash` already keeps on that leg.
  it('passes a null BODY envelope through rather than synthesising empty-and-roomy', () => {
    const out = shapeWorkItemsGet(
      envelope([row({ checkpointBody: null, checkpointReadFailed: true })]),
      'trimmed',
    ) as Envelope;
    expect(out.results[0].checkpointBody).toBeNull();
  });

  it("keeps a large single-item checkpoint WHOLE (the post-respawn read that was broken)", () => {
    const checkpoint = "C".repeat(5_000);
    const out = shapeWorkItemsGet(envelope([row({ checkpoint })]), "trimmed") as Envelope;

    // Byte-identical: this is the case the generic projection served at 800 chars.
    expect(out.results[0].checkpoint).toBe(checkpoint);
    expect(String(out.results[0].checkpoint)).not.toMatch(/TRUNCATED/);
  });

  /**
   * EI-21379898054596220. The hash is 12 chars and it is the ONLY thing that stays
   * true once the checkpoint above it is clipped — a reader handed a prefix cannot
   * recompute the digest their handoff needs to verify. So it must survive every
   * degradation this shaper performs, including the ones that exist precisely because
   * the checkpoint was too big to keep whole. Dropping it at a reduced tier would
   * remove the verification exactly where it becomes necessary.
   */
  it("keeps checkpointContentHash whole through both the clip and the single-item floor", () => {
    const checkpoint = "C".repeat(40_000);
    const checkpointContentHash = "81344e6f2817";

    for (const tier of ["trimmed", "standard"] as const) {
      const out = shapeWorkItemsGet(envelope([row({ checkpoint, checkpointContentHash })]), tier) as Envelope;
      // Positive control: this case only means something while the clip really happens.
      expect(
        String(out.results[0].checkpoint).length,
        `[${tier}] checkpoint was not clipped — this case no longer tests what it claims to`,
      ).toBeLessThan(checkpoint.length);
      expect(out.results[0].checkpointContentHash).toBe(checkpointContentHash);
    }

    // The compact single-row floor is a SEPARATE projection with its own field list,
    // so it can regress independently — exercise it with the same payload shape the
    // serializer-hold case above uses to reach it.
    const floored = shapeWorkItemsGet(
      envelope([
        row({
          workItem: {
            id: "WI-1",
            kind: "bug",
            family: "issue",
            harness: "papercusp",
            state: "open",
            title: "serializer hold",
            severity: "critical",
            origin: "local",
            assignee: "su-1",
            summary: "S".repeat(40_000),
            payload: { giant: "P".repeat(40_000) },
          },
          checkpoint,
          checkpointContentHash,
          holder: {
            goalRef: "WI-1",
            goalText: "H".repeat(40_000),
            assumptions: { keys: ["hold"] },
            agreement: "sole",
            competing: [],
          },
          lifecycle: { events: Array.from({ length: 100 }, (_, i) => ({ kind: `event-${i}` })) },
          priorAttempts: { attempts: [{ text: "A".repeat(10_000) }] },
          threadWindow: { posts: [{ body: "T".repeat(10_000) }] },
        }),
      ]),
      "trimmed",
    ) as Envelope;

    // Positive control: prove we actually reached the floor, or the assertion below
    // is measuring the ordinary path under a different name.
    expect(floored._shapeNote?.singleItemFloor, "did not reach the single-item floor").toMatch(/reduced identity/);
    expect(floored.results[0].checkpointContentHash).toBe(checkpointContentHash);
  });

  it("spends the budget on the checkpoint by DROPPING summary + payload, and names both", () => {
    const out = shapeWorkItemsGet(envelope([row({ checkpoint: "C".repeat(5_000) })]), "trimmed") as Envelope;
    const w = out.results[0].workItem as Record<string, unknown>;

    expect(w.summary).toBeUndefined();
    expect(w.payload).toBeUndefined();
    // D-004: no silent caps. A reader must be able to tell what is missing.
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["workItem.summary", "workItem.payload"]),
    );
    // Identity survives so the row is still usable + correlatable.
    expect(w).toMatchObject({ id: "WI-1", kind: "bug", state: "open", severity: "major", origin: "local" });
  });

  it("clips an over-budget checkpoint WITH the loud in-band marker, never a bare ellipsis", () => {
    const checkpoint = "C".repeat(40_000);
    const out = shapeWorkItemsGet(envelope([row({ checkpoint })]), "trimmed") as Envelope;
    const got = String(out.results[0].checkpoint);

    expect(got.length).toBeLessThan(checkpoint.length);
    expect(got).toMatch(/…\[TRUNCATED \+\d+ chars — re-read with payloadTier:'full'\]$/);
    expect(out._shapeNote?.dropped).toEqual(expect.arrayContaining(["checkpoint(clipped)"]));
  });

  it("keeps identity on an exact read instead of falling to an id-only stub", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: {
            id: "WI-1",
            kind: "bug",
            family: "issue",
            harness: "papercusp",
            state: "open",
            title: "serializer hold",
            severity: "critical",
            origin: "local",
            assignee: "su-1",
            summary: "S".repeat(40_000),
            payload: { giant: "P".repeat(40_000) },
          },
          checkpoint: "C".repeat(40_000),
          holder: {
            goalRef: "WI-1",
            goalText: "H".repeat(40_000),
            assumptions: { keys: ["hold"] },
            agreement: "sole",
            competing: [],
          },
          lifecycle: { events: Array.from({ length: 100 }, (_, i) => ({ kind: `event-${i}` })) },
          priorAttempts: { attempts: [{ text: "A".repeat(10_000) }] },
          threadWindow: { posts: [{ body: "T".repeat(10_000) }] },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const result = out.results[0];
    const workItem = result.workItem as Record<string, unknown>;

    expect(result._stub).toBeUndefined();
    expect(workItem).toMatchObject({ id: "WI-1", state: "open", assignee: "su-1", title: "serializer hold" });
    expect(String(result.checkpoint)).toMatch(/TRUNCATED/);
    expect(out._shapeNote?.singleItemFloor).toMatch(/reduced identity/);
    expect(out._shapeNote?.stubbed).toBeUndefined();
  });

  it("keeps every 'read before acting' warning the tool's returns-contract promises", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          checkpoint: "C".repeat(1_000),
          planItemClaimCollision: { planSlug: "p", itemId: "P-007", claimedBy: "su-2" },
          planItemBlocked: { reason: "needs-human", planSlug: "p" },
          planItemTextDrift: { status: "drifted", planSlug: "p", itemId: "P-007" },
          checkpointFreshness: { verdict: "stale", changed: [{ dep: "file:a.ts" }] },
          checkpointStale: { stale: true },
          checkpointBgJobWarning: "cites a background job",
          priorWorkWarning: "ALREADY WORKED",
          holder: { goalRef: "g", agreement: "divergent" },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const r = out.results[0];

    // Each of these changes how the checkpoint above must be read — dropping any
    // of them to save bytes would reintroduce the confidently-wrong-state failure
    // from a different direction.
    expect(r.planItemClaimCollision).toBeDefined();
    expect(r.planItemBlocked).toBeDefined();
    expect(r.planItemTextDrift).toBeDefined();
    expect(r.checkpointFreshness).toMatchObject({ verdict: "stale" });
    expect(r.checkpointStale).toBeDefined();
    expect(r.checkpointBgJobWarning).toBeDefined();
    expect(r.priorWorkWarning).toBeDefined();
    expect(r.holder).toMatchObject({ agreement: "divergent" });
  });

  it("keeps the terminal completion-authority verdict in the reduced item identity", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: {
            id: "WI-1",
            kind: "bug",
            state: "done",
            title: "a completed item",
            completionAuthority: "committed",
          },
          checkpoint: null,
        }),
      ]),
      "trimmed",
    ) as Envelope;

    expect((out.results[0].workItem as Record<string, unknown>).completionAuthority).toBe("committed");
  });

  it("exposes a null authority on terminal legacy rows without taxing open-row reads", () => {
    const terminal = shapeWorkItemsGet(
      envelope([
        row({
          workItem: { id: "WI-1", kind: "bug", state: "done", title: "legacy close" },
          checkpoint: null,
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const open = shapeWorkItemsGet(
      envelope([row({ workItem: { id: "WI-2", kind: "bug", state: "open", title: "open item" } })]),
      "trimmed",
    ) as Envelope;

    expect((terminal.results[0].workItem as Record<string, unknown>).completionAuthority).toBeNull();
    expect((open.results[0].workItem as Record<string, unknown>).completionAuthority).toBeUndefined();
  });

  it('preserves terminal completion freshness in normal and exact-read fallback shapes', () => {
    const completionFreshness = {
      verdict: 'stale',
      storedTreeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) },
      currentTreeStamp: { repositoryRoot: '/repo', headSha: 'b'.repeat(40) },
      reason: 're-verify',
    };
    const normal = shapeWorkItemsGet(
      envelope([row({ completionFreshness })]),
      'trimmed',
    ) as Envelope;
    expect(normal.results[0].completionFreshness).toEqual(completionFreshness);

    const compact = shapeWorkItemsGet(
      envelope([row({ checkpoint: 'C'.repeat(40_000), completionFreshness })]),
      'trimmed',
    ) as Envelope;
    expect(compact.results[0].completionFreshness).toEqual(completionFreshness);
  });

  it('keeps canonical completion evidence and exposes the result-level alias', () => {
    const completion = {
      summary: 'implemented the completion-evidence read path',
      testsRun: 'npm run test:file -- get-shape.test.ts',
      testResult: '47 passed',
      verifiedHow: 'focused Vitest regression',
      workOutcome: 'introduced-change',
      addedTests: true,
      filesChanged: ['packages/operator-core/lib/agent-tools/work_items/get-shape.ts'],
    };
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: {
            id: 'WI-completion',
            kind: 'bug',
            state: 'done',
            title: 'completion evidence',
            terminalCompletionEvidence: completion,
          },
          checkpoint: null,
        }),
      ]),
      'trimmed',
    ) as Envelope;
    const result = out.results[0];
    const workItem = result.workItem as Record<string, unknown>;

    expect(result.completion).toEqual(completion);
    expect(result.hasCompletionEvidence).toBe(true);
    // P-001 (oversized-tool-results-reduction-2026-10-12): `completion` is derived from
    // `workItem.terminalCompletionEvidence`, so a shaped row emits the record ONCE and the
    // nested key carries an in-band reference instead of a second copy.
    expect(workItem.terminalCompletionEvidence).toBe(COMPLETION_EMITTED_AT_ROW);
    expect(JSON.stringify(out).split(completion.summary).length - 1).toBe(1);
  });

  it('emits a completion record once at both shaped tiers and keeps a differing nested record', () => {
    const completion = {
      summary: 'S'.repeat(400),
      testsRun: 'npm run test:file -- get-shape.test.ts',
      testResult: 'passed',
      verifiedHow: 'focused Vitest regression',
      filesChanged: ['get-shape.ts'],
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeWorkItemsGet(
        envelope([
          row({
            workItem: { id: 'WI-once', kind: 'bug', state: 'done', title: 'once', terminalCompletionEvidence: completion },
            completion,
            checkpoint: null,
          }),
        ]),
        tier,
      ) as Envelope;
      const body = JSON.stringify(out);
      expect(body.split('S'.repeat(400)).length - 1).toBe(1);
      expect((out.results[0].workItem as Record<string, unknown>).terminalCompletionEvidence).toBe(
        COMPLETION_EMITTED_AT_ROW,
      );
      expect(out.results[0].hasCompletionEvidence).toBe(true);
    }

    // A row-level record that is NOT the nested one must not be collapsed into a reference.
    const other = { ...completion, summary: 'different record' };
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: { id: 'WI-differs', kind: 'bug', state: 'done', title: 'differs', terminalCompletionEvidence: completion },
          completion: other,
          checkpoint: null,
        }),
      ]),
      'trimmed',
    ) as Envelope;
    expect((out.results[0].workItem as Record<string, unknown>).terminalCompletionEvidence).not.toBe(
      COMPLETION_EMITTED_AT_ROW,
    );
    expect(out.results[0].completion).toEqual(other);
  });

  it('keeps the evidence-presence bit when completion detail is clipped', () => {
    const completion = {
      summary: 'E'.repeat(1_200),
      verifiedHow: 'V'.repeat(1_000),
      testsRun: 'npm run test:file -- get-shape.test.ts',
      testResult: 'passed',
      filesChanged: ['packages/operator-core/lib/agent-tools/work_items/get-shape.ts'],
    };
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: {
            id: 'WI-clipped-completion',
            kind: 'bug',
            state: 'done',
            title: 'clipped completion evidence',
            terminalCompletionEvidence: completion,
          },
          checkpoint: null,
        }),
      ]),
      'trimmed',
    ) as Envelope;
    const result = out.results[0];

    expect(result.hasCompletionEvidence).toBe(true);
    expect(result.completion).toBeDefined();
    expect(String((result.completion as Record<string, unknown>).verifiedHow)).toMatch(/TRUNCATED/);
    expect(out._shapeNote?.next).toMatch(/COMPLETION EVIDENCE EXISTS/);
  });

  it('preserves completion presence on an id-only bulk stub', () => {
    const completion = {
      summary: 'completed',
      testsRun: 'npm test',
      testResult: 'passed',
      verifiedHow: 'unit',
      workOutcome: 'verified-existing',
      filesChanged: ['get.ts'],
    };
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({
        id: `WI-completion-${i}`,
        workItem: {
          id: `WI-completion-${i}`,
          kind: 'bug',
          state: 'done',
          title: `completed ${i}`,
          terminalCompletionEvidence: completion,
        },
        checkpoint: null,
      }),
    );
    const out = shapeWorkItemsGet(envelope(rows), 'trimmed') as Envelope;
    const stub = out.results.find((result) => result._stub) as Record<string, unknown> | undefined;

    expect(stub).toBeDefined();
    expect(stub?.hasCompletionEvidence).toBeUndefined();
    expect(out._shapeNote?.stubbed?.completionEvidence).toEqual({ all: true });
    expect(out._shapeNote?.next).toMatch(/COMPLETION EVIDENCE EXISTS/);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });

  it("hoists mixed completion presence by id when only some stub rows carry evidence", () => {
    const evidence = {
      summary: "completed",
      testsRun: "npm test",
      testResult: "passed",
      verifiedHow: "unit",
      filesChanged: ["get.ts"],
    };
    const evidenceIds = ["WI-completion-3", "WI-completion-77"];
    const rows = Array.from({ length: 100 }, (_, i) => {
      const id = `WI-completion-${i}`;
      return row({
        id,
        workItem: {
          id,
          kind: "bug",
          state: "done",
          title: `completed ${i}`,
          ...(evidenceIds.includes(id) ? { terminalCompletionEvidence: evidence } : {}),
        },
        checkpoint: null,
      });
    });

    const out = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;

    expect(out.results.every((result) => result.hasCompletionEvidence === undefined)).toBe(true);
    expect(out._shapeNote?.stubbed?.completionEvidence).toEqual({ ids: evidenceIds });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });

  it('retains completion presence and a bounded body at the exact single-item floor', () => {
    const completion = {
      summary: 'completed',
      testsRun: 'npm test',
      testResult: 'passed',
      verifiedHow: 'unit',
      workOutcome: 'verified-existing',
      filesChanged: ['get.ts'],
    };
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: {
            id: 'WI-floor-completion',
            kind: 'bug',
            family: 'issue',
            harness: 'papercusp',
            state: 'open',
            title: 'large exact read',
            summary: 'S'.repeat(40_000),
            payload: { giant: 'P'.repeat(40_000) },
            terminalCompletionEvidence: completion,
          },
          checkpoint: 'C'.repeat(40_000),
          holder: {
            goalRef: 'WI-floor-completion',
            goalText: 'H'.repeat(40_000),
            assumptions: { keys: ['hold'] },
            agreement: 'sole',
            competing: [],
          },
          lifecycle: { events: Array.from({ length: 100 }, (_, i) => ({ kind: `event-${i}` })) },
          priorAttempts: { attempts: [{ text: 'A'.repeat(10_000) }] },
          threadWindow: { posts: [{ body: 'T'.repeat(10_000) }] },
        }),
      ]),
      'trimmed',
    ) as Envelope;
    const result = out.results[0];

    expect(out._shapeNote?.singleItemFloor).toMatch(/reduced identity/);
    expect(result.hasCompletionEvidence).toBe(true);
    expect(result.completion).toMatchObject({
      summary: 'completed',
      testResult: 'passed',
      verifiedHow: 'unit',
      workOutcome: 'verified-existing',
    });
  });

  it('preserves compact deployment positions and explicit unknown/truncation metadata', () => {
    const deploymentPosition = {
      paths: Array.from({ length: 10 }, (_, i) => ({
        path: `src/${i}.ts`,
        targetSha: `sha-${i}`,
        deployedSha: 'deployed-sha',
        positions: { committedLocal: true, onStaging: true, inMain: i === 0, deployed: i === 0 },
        blockedOn: i === 0 ? null : 'gate',
      })),
      unknownPaths: ['src/unknown.ts'],
      totalPaths: 11,
      truncated: true,
    };
    const normal = shapeWorkItemsGet(envelope([row({ deploymentPosition })]), 'trimmed') as Envelope;
    expect(normal.results[0].deploymentPosition).toMatchObject({
      totalPaths: 11,
      truncated: true,
      unknownPaths: ['src/unknown.ts'],
    });
    expect((normal.results[0].deploymentPosition as any).paths).toHaveLength(4);

    const compact = shapeWorkItemsGet(
      envelope([row({ checkpoint: 'C'.repeat(40_000), deploymentPosition })]),
      'trimmed',
    ) as Envelope;
    expect(compact.results[0].deploymentPosition).toMatchObject({ totalPaths: 11, truncated: true });
    expect((compact.results[0].deploymentPosition as any).paths).toHaveLength(4);
  });

  it("caps lifecycle events but NEVER drops the coverage/flags that qualify them", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ at: `t${i}`, kind: "blocked" }));
    const out = shapeWorkItemsGet(
      envelope([
        row({
          lifecycle: { events, coverage: { notRecorded: ["x"], degraded: false }, flags: { claimHold: true } },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const lc = out.results[0].lifecycle as Record<string, unknown>;

    expect((lc.events as unknown[]).length).toBe(4);
    expect(lc.eventsTruncated).toMatchObject({ shown: 4, total: 30 });
    // An empty/partial `events` is only safely readable alongside `coverage`.
    expect(lc.coverage).toMatchObject({ degraded: false });
    expect(lc.flags).toMatchObject({ claimHold: true });
  });
});

describe("shapeWorkItemsGet — bulk reads stay under the transport ceiling", () => {
  it("keeps a default single-item read below the MCP result-door budget", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          checkpoint: "C".repeat(5_000),
          holder: {
            goalRef: "EI-20243922284675857",
            goalText: "The holder is actively fixing the default read overflow.",
            assumptions: { count: 1, keys: ["launch-provenance"] },
            declaredAt: "2026-08-12T10:56:00.000Z",
            stale: false,
            agreement: "sole",
            competing: [],
          },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const serialized = JSON.stringify(out);

    // The real MCP result door measures this same serialized text and spills
    // anything over its universal floor. The shaper must leave valid JSON for
    // the door, rather than relying on the door's lossy footer after the fact.
    expect(serialized).toMatch(/^\{[\s\S]*\}$/);
    expect(serialized.length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });

  it("fits a 100-id floor below the MCP result door while preserving EVERY id", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({
        id: `EI-${String(i).padStart(17, "0")}`,
        availability: "available",
        workItem: {
          id: `EI-${String(i).padStart(17, "0")}`,
          kind: "bug",
          state: "open",
          title: `t${i}`,
          summary: "S".repeat(3_000),
        },
        checkpoint: "C".repeat(2_000),
      }),
    );
    const out = shapeWorkItemsGet(
      {
        ...envelope(rows),
        read: {
          schemaVersion: "work-items-get-read-v1",
          mode: "complete",
          requested: 100,
          available: 100,
          absent: 0,
          unavailable: 0,
        },
      },
      "trimmed",
    ) as Envelope;
    const size = JSON.stringify(out).length;

    // WI-39844: the old test asserted only PAYLOAD_TIER_HARD_CEILING_CHARS (~30k),
    // while the real MCP door is 6k. The floor measured ~18-22k and still passed
    // that assertion, so the generic projection silently replaced this shaper.
    expect(size).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
    // Correlation is the one thing a caller cannot reconstruct. Every requested
    // id comes back, even when its detail does not.
    expect(out.results).toHaveLength(100);
    expect(out.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // A degraded row stays machine-readable, while the repeated prose lives ONCE
    // at payload level instead of consuming the door once per stub.
    const stub = out.results.at(-1) as Record<string, unknown>;
    expect(stub).toEqual({ ok: true, id: "EI-00000000000000099", _stub: true });
    // The result schema requires `ok` on every keyed row, including id-only
    // degradation stubs. This is the regression for EI-22706203744509223.
    expect(out.results.filter((result) => result._stub).every((result) => result.ok === true)).toBe(true);
    expect(out._shapeNote?.stubbed).toEqual({
      count: 100,
      note: expect.stringMatching(/re-read an id alone/),
    });
    expect(out._shapeNote?.dropped.some((d) => d.startsWith("rows("))).toBe(true);
    expect(out.read).toMatchObject({ requested: 100, available: 100, detailRows: 0, stubbedRows: 100 });
  });

  it("keeps candidate titles and state across a five-ID compact fallback", () => {
    const ids = ["EI-CANDIDATE-1", "EI-CANDIDATE-2", "EI-CANDIDATE-3", "EI-CANDIDATE-4", "EI-CANDIDATE-5"];
    const completion = {
      summary: "S".repeat(7_000),
      testsRun: "T".repeat(7_000),
      testResult: "R".repeat(7_000),
      workOutcome: "O".repeat(7_000),
      verifiedHow: "V".repeat(7_000),
    };
    const checkpointChecks = {
      count: 12,
      cap: 12,
      remaining: 0,
      rows: Array.from({ length: 12 }, (_, check) => ({
        id: `check-${check + 1}`,
        claim: `check ${check + 1}: ${"C".repeat(90)}`,
      })),
    };
    const lifecycle = {
      coverage: { note: "C".repeat(300) },
      flags: { note: "F".repeat(50) },
      events: Array.from({ length: 8 }, (_, event) => ({
        event: `event-${event + 1}`,
        detail: "L".repeat(500),
      })),
    };
    const rows = ids.map((id, index) =>
      row({
        id,
        availability: "available",
        workItem: {
          id,
          kind: "bug",
          family: "issue",
          harness: "papercusp",
          state: index === 3 ? "done" : "open",
          title: `candidate ${index + 1}`,
          severity: "major",
          origin: "local",
          assignee: "su-1",
          ...(index === 3
            ? { completionAuthority: "committed", terminalCompletionEvidence: completion }
            : {}),
          takenAt: "2026-10-10T20:00:00.000Z",
          lastProgressAt: "2026-10-10T20:01:00.000Z",
          parent: null,
          createdAt: "2026-10-10T19:00:00.000Z",
          updatedAt: "2026-10-10T20:01:00.000Z",
          closedAt: null,
          summary: "S".repeat(1_000),
          payload: { description: "P".repeat(2_000) },
        },
        completion,
        checkpoint: "C".repeat(8_000),
        checkpointChecks: index === 3 ? checkpointChecks : { count: 0, cap: 12, remaining: 12, rows: [] },
        checkpointBody: { chars: 31_999, cap: 32_000, remaining: 1 },
        checkpointContentHash: "h".repeat(64),
        checkpointSubjectFingerprint: "f".repeat(64),
        lifecycle,
        ...(index === 3
          ? {
              checkpointStale: { status: "stale", reason: "R".repeat(300) },
              holder: { goalRef: "goal:compact-read", stale: false, agreement: "held", competing: [] },
            }
          : {}),
        ...(index === 4
          ? {
              deploymentPosition: {
                paths: Array.from({ length: 8 }, (_, path) => ({
                  path: `packages/record-${path}.ts`,
                  deployed: false,
                  reason: "D".repeat(60),
                })),
                unknownPaths: [],
                totalPaths: 8,
                truncated: false,
              },
            }
          : {}),
        priorAttempts: {
          schemaVersion: "prior-attempts-v1",
          authority: Array.from({ length: 8 }, (_, attempt) => ({
            ref: `authority-${attempt}`,
            text: "A".repeat(2_000),
          })),
          attempts: Array.from({ length: 8 }, (_, attempt) => ({
            ref: `attempt-${attempt}`,
            text: "P".repeat(2_000),
          })),
          rawRefs: Array.from({ length: 20 }, (_, attempt) => `raw-${attempt}`),
        },
        priorAttemptRefResolution: {
          records: Array.from({ length: 5 }, (_, attempt) => ({
            ref: `resolved-${attempt}`,
            text: "R".repeat(2_000),
          })),
        },
      }),
    );
    for (const tier of ["standard", "trimmed"] as const) {
      const out = shapeWorkItemsGet(
        {
          ...envelope(rows),
          read: {
            schemaVersion: "work-items-get-read-v1",
            mode: "complete",
            requested: ids.length,
            available: ids.length,
            absent: 0,
            unavailable: 0,
          },
        },
        tier,
      ) as Envelope;

      expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
      expect(out.results.map((result) => result.id)).toEqual(ids);
      expect(out.results.every((result) => result._stub !== true)).toBe(true);
      expect(out.results.map((result) => (result.workItem as Record<string, unknown>).title)).toEqual([
        "candidate 1",
        "candidate 2",
        "candidate 3",
        "candidate 4",
        "candidate 5",
      ]);
      expect(out.results.map((result) => (result.workItem as Record<string, unknown>).state)).toEqual([
        "open",
        "open",
        "open",
        "done",
        "open",
      ]);
      expect(out.results.every((result) => result.hasCompletionEvidence === true)).toBe(true);
      expect(out.results[3]).toMatchObject({
        completion: null,
        hasCompletionEvidence: true,
        workItem: { completionAuthority: "committed" },
      });
      expect(Object.keys(out.results[0].workItem as Record<string, unknown>).sort()).toEqual([
        "assignee",
        "family",
        "harness",
        "id",
        "kind",
        "origin",
        "severity",
        "state",
        "title",
      ]);
      expect(out.results[0].lifecycle).toBeUndefined();
      expect(out.results[4].deploymentPosition).toBeUndefined();
      expect(out.read).toMatchObject({ requested: 5, available: 5, detailRows: 5, stubbedRows: 0 });
      expect(out._shapeNote?.dropped).toContain("completion");
      expect(out._shapeNote?.dropped).toContain("priorAttempts");
      expect(out._shapeNote?.dropped).toContain("priorAttemptRefResolution");
      expect(out._shapeNote?.dropped).toContain("deploymentPosition");
      expect(out.results.every((result) => result.priorAttempts === undefined)).toBe(true);
    }
  });

  it("tries all five compact identities before the trimmed three-row stub rung", () => {
    const ids = ["EI-CANDIDATE-1", "EI-CANDIDATE-2", "EI-CANDIDATE-3", "EI-CANDIDATE-4", "EI-CANDIDATE-5"];
    const completion = {
      summary: "S".repeat(7_000),
      testsRun: "T".repeat(7_000),
      testResult: "R".repeat(7_000),
      workOutcome: "O".repeat(7_000),
      verifiedHow: "V".repeat(7_000),
    };
    const rows = ids.map((id, index) =>
      row({
        id,
        availability: "available",
        workItem: {
          id,
          kind: "bug",
          state: "open",
          title: `candidate ${index + 1}`,
        },
        completion,
        checkpoint: "C".repeat(8_000),
      }),
    );
    const out = shapeWorkItemsGet(
      {
        ...envelope(rows),
        read: {
          schemaVersion: "work-items-get-read-v1",
          mode: "complete",
          requested: ids.length,
          available: ids.length,
          absent: 0,
          unavailable: 0,
        },
      },
      "trimmed",
    ) as Envelope;

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
    expect(out.results.map((result) => result.id)).toEqual(ids);
    expect(out.results.every((result) => result._stub !== true)).toBe(true);
    expect(out.results.map((result) => (result.workItem as Record<string, unknown>).title)).toEqual([
      "candidate 1",
      "candidate 2",
      "candidate 3",
      "candidate 4",
      "candidate 5",
    ]);
    expect(out.results.map((result) => (result.workItem as Record<string, unknown>).state)).toEqual([
      "open",
      "open",
      "open",
      "open",
      "open",
    ]);
  });

  it("reports available detail reduced to two id-only stubs while keeping each reread ID", () => {
    const bulkyHolder = {
      goalRef: "WI-2",
      competing: Array.from({ length: 8 }, () => "X".repeat(12_000)),
    };
    const rows = ["WI-1", "WI-2"].map((id) =>
      row({ id, availability: "available", holder: bulkyHolder, workItem: { id, state: "open" } }),
    );
    const out = shapeWorkItemsGet(
      {
        ...envelope(rows),
        read: {
          schemaVersion: "work-items-get-read-v1",
          mode: "complete",
          requested: 2,
          available: 2,
          absent: 0,
          unavailable: 0,
        },
      },
      "trimmed",
    ) as Envelope;

    expect(out.results).toEqual([
      { ok: true, id: "WI-1", _stub: true },
      { ok: true, id: "WI-2", _stub: true },
    ]);
    expect(out.read).toMatchObject({ requested: 2, available: 2, detailRows: 0, stubbedRows: 2 });
  });

  it("keeps absent and unavailable outcomes separate from shaped available detail", () => {
    const out = shapeWorkItemsGet(
      {
        ...envelope([
          row({ id: "WI-available", availability: "available", workItem: { id: "WI-available", state: "open" } }),
          { ok: false, id: "WI-absent", availability: "absent", error: "not found" },
          { ok: false, id: "WI-unavailable", availability: "unavailable", error: "timeout", retryable: true },
        ]),
        read: {
          schemaVersion: "work-items-get-read-v1",
          mode: "complete",
          requested: 3,
          available: 1,
          absent: 1,
          unavailable: 1,
        },
      },
      "trimmed",
    ) as Envelope;

    expect(out.read).toMatchObject({
      requested: 3,
      available: 1,
      absent: 1,
      unavailable: 1,
      detailRows: 1,
      stubbedRows: 0,
    });
    expect(out.results.map((r) => [r.id, r.availability])).toEqual([
      ["WI-available", "available"],
      ["WI-absent", "absent"],
      ["WI-unavailable", "unavailable"],
    ]);
  });

  it("a 10-id read preserves every id when the result door requires stubs", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `WI-${i}`, workItem: { id: `WI-${i}`, state: "open" }, checkpoint: "C".repeat(1_000) }),
    );
    const out = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;

    expect(out.results).toHaveLength(10);
    expect(out.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(out.results.some((r) => r._stub)).toBe(true);
    expect(out._shapeNote?.stubbed?.count).toBeGreaterThan(0);
    expect(out._shapeNote?.stubbed?.note).toMatch(/re-read an id alone/);
    expect(out._shapeNote?.dropped.some((d) => d.startsWith("rows("))).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });
});

describe("shapeWorkItemsGet — operationalBrief stays bounded across multi-item reads", () => {
  const DOOR = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

  function briefRow(id: string, text: string): Record<string, unknown> {
    return row({
      id,
      availability: "available",
      workItem: { id, kind: "bug", state: "open", title: "brief subject" },
      operationalBrief: operationalBrief(id, text),
    });
  }

  it("retains each requested brief and marks clipped row text", () => {
    const rows = ["WI-brief-a", "WI-brief-b"].map((id) =>
      briefRow(id, "A verified next action, blocker, and evidence summary. ".repeat(100)),
    );

    for (const tier of ["trimmed", "standard"] as const) {
      const out = shapeWorkItemsGet(envelope(rows), tier) as Envelope;
      expect(out.results.map((result) => result.id)).toEqual(rows.map((source) => source.id));
      for (const result of out.results) {
        expect(result._stub).toBeUndefined();
        expect(result.operationalBrief).toMatchObject({
          schemaVersion: "operational-brief-v1",
          subject: result.id,
          shapeNote: {
            clipped: true,
            paths: expect.arrayContaining(["operationalBrief.text"]),
          },
        });
        expect((result.operationalBrief as Record<string, unknown>).text).toMatch(/TRUNCATED/);
      }
      expect(out._shapeNote?.dropped).toContain("operationalBrief(clipped)");
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(DOOR);
    }
  });

  it("retains a compact operational brief when a single row descends to a zero-brief rung", () => {
    const id = "EI-25491082181195271";
    const input = row({
      id,
      availability: "available",
      checkpoint: "C".repeat(25_000),
      checkpointFreshness: { diagnostic: "F".repeat(3_000) },
      operationalBrief: operationalBrief(id, "Verified next action and evidence. ".repeat(100)),
    });

    const out = shapeWorkItemsGet(envelope([input]), "standard") as Envelope;
    const result = out.results[0];

    expect(result.operationalBrief).toMatchObject({
      schemaVersion: "operational-brief-v1",
      subject: id,
      state: { status: "known", value: "open" },
      owner: { status: "known", value: "su-1" },
    });
    expect(result.operationalBrief).toHaveProperty("shapeNote.clipped", true);
    expect(out._shapeNote?.dropped).toContain("operationalBrief(clipped)");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(DOOR);
  });

  it("keeps three brief rows when duplicated completion bodies exhaust the door", () => {
    const evidence = {
      summary: "S".repeat(1_800),
      testsRun: "T".repeat(1_600),
      testResult: "R".repeat(1_600),
      verifiedHow: "V".repeat(600),
      workOutcome: "O".repeat(1_200),
      addedTests: "A".repeat(900),
      filesChanged: Array.from(
        { length: 24 },
        (_, index) => `packages/path/${String(index).padStart(2, "0")}-${"x".repeat(80)}`,
      ),
    };
    const ids = ["EI-11111111111111111", "EI-22222222222222222", "EI-33333333333333333"];
    const rows = ids.map((id) => row({
      id,
      availability: "available",
      workItem: {
        id,
        kind: "bug",
        family: "issue",
        harness: "papercusp",
        state: "done",
        title: "terminal item",
        severity: "major",
        origin: "local",
        assignee: "su-1",
        summary: "summary ".repeat(500),
        payload: { details: "P".repeat(4_000) },
        terminalCompletionEvidence: evidence,
      },
      checkpoint: "C".repeat(3_000),
      completion: evidence,
      hasCompletionEvidence: true,
      operationalBrief: operationalBrief(id, "Verified next action and evidence. ".repeat(100)),
    }));
    const read = {
      schemaVersion: "work-items-get-read-v1",
      mode: "complete",
      requested: 3,
      available: 3,
      absent: 0,
      unavailable: 0,
      budgetMs: 30_000,
      elapsedMs: 7,
      baseReadMaxMs: 4,
      enrichmentMaxMs: 0,
      outerStageAttribution: "tool_invocations.duration_ms minus elapsedMs is combined dispatch/projection/serialization time",
    };

    for (const tier of ["trimmed", "standard"] as const) {
      const out = shapeWorkItemsGet({ ...envelope(rows), read }, tier) as Envelope;

      expect(out.results.map((result) => result.id)).toEqual(ids);
      expect(out.results.every((result) => result._stub === undefined)).toBe(true);
      for (const result of out.results) {
        const workItem = result.workItem as Record<string, unknown>;
        expect(result.operationalBrief).toMatchObject({
          subject: result.id,
          state: { status: "known", value: "open" },
          shapeNote: {
            clipped: true,
            paths: expect.arrayContaining([
              "operationalBrief.text",
              "operationalBrief.facts",
              "operationalBrief.unknowns",
            ]),
          },
        });
        expect(result.operationalBrief).not.toHaveProperty("text");
        expect(result.operationalBrief).not.toHaveProperty("facts");
        expect(result.operationalBrief).not.toHaveProperty("unknowns");
        expect(result.operationalBrief).toMatchObject({
          owner: { status: "known", value: "su-1" },
          nextAction: { status: "known" },
        });
        expect(result.hasCompletionEvidence).toBe(true);
        expect(result.completion).toBeNull();
        expect(workItem.terminalCompletionEvidence).toBeNull();
      }
      expect(out._shapeNote?.dropped).toEqual(
        expect.arrayContaining(["completion", "workItem.terminalCompletionEvidence"]),
      );
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(DOOR);
    }
  });

  it("does not spend more bulk-row capacity on briefs whose shared share is too small", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      briefRow(`EI-${String(index).padStart(17, "0")}`, "Large brief text. ".repeat(300)),
    );
    const withBriefs = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;
    const withoutBriefs = shapeWorkItemsGet(
      envelope(rows.map(({ operationalBrief: _brief, ...rest }) => rest)),
      "trimmed",
    ) as Envelope;

    expect(withBriefs.results.map((result) => result.id)).toEqual(rows.map((source) => source.id));
    expect(withBriefs.results.every((result) => result.operationalBrief === undefined)).toBe(true);
    expect(withBriefs._shapeNote?.dropped).toContain("operationalBrief");
    expect(withBriefs.results.every((result) => result._stub === undefined)).toBe(true);
    expect(withBriefs.results.filter((result) => result._stub).length).toBe(
      withoutBriefs.results.filter((result) => result._stub).length,
    );
    expect(JSON.stringify(withBriefs).length).toBeLessThanOrEqual(DOOR);
  });
});

describe("shapeWorkItemsGet — tier differences and defensive behaviour", () => {
  // EI-20743148487714069 REPLACED this test's contract. It used to assert
  // "standard keeps a clipped summary; trimmed drops it entirely" — which pinned
  // the defect: a trimmed read returned the TITLE and no sentence of the body, on
  // a payload using ~15% of its door budget. The tier difference is now one of
  // BUDGET, not presence: both carry the summary when the rung has slack, standard
  // simply affords more of it.
  it("both tiers carry the summary when there is slack; standard affords more", () => {
    const env = envelope([row({ checkpoint: "C".repeat(500) })]);
    const std = shapeWorkItemsGet(env, "standard") as Envelope;
    const trm = shapeWorkItemsGet(env, "trimmed") as Envelope;
    const stdSummary = String((std.results[0].workItem as Record<string, unknown>).summary);
    const trmSummary = String((trm.results[0].workItem as Record<string, unknown>).summary);

    expect(stdSummary.length).toBeGreaterThan(trmSummary.length);
    // Neither is the useless head the old flat cap produced.
    expect(trmSummary.length).toBeGreaterThan(1_000);
    // A clip still says so in-band, and the small checkpoint is untouched at both.
    expect(trmSummary).toMatch(/TRUNCATED/);
    expect(trm.results[0].checkpoint).toBe("C".repeat(500));
    expect(std.results[0].checkpoint).toBe("C".repeat(500));
  });

  it("passes an error row through untouched — it is already tiny and self-describing", () => {
    const err = { ok: false, id: "WI-9", error: "not_found" };
    const out = shapeWorkItemsGet(envelope([err]), "trimmed") as Envelope;
    expect(out.results[0]).toEqual(err);
  });

  it("returns non-envelope data unchanged rather than mangling it", () => {
    expect(shapeWorkItemsGet(null, "trimmed")).toBeNull();
    expect(shapeWorkItemsGet({ ok: true }, "trimmed")).toEqual({ ok: true });
    expect(shapeWorkItemsGet("nope", "trimmed")).toBe("nope");
  });

  it("emits NO _shapeNote when nothing was dropped — the note must mean something", () => {
    const out = shapeWorkItemsGet(
      envelope([{ ok: true, id: "WI-1", workItem: { id: "WI-1", state: "open" }, checkpoint: "short" }]),
      "trimmed",
    ) as Envelope;
    expect(out._shapeNote).toBeUndefined();
  });
});

/**
 * EI-20743148487714069. `work_items:get` is how an agent reads a backlog item
 * before acting on it, and the trimmed tier returned the TITLE with no sentence of
 * the body — the one shape the standing "a title is a LABEL, read the writer"
 * discipline exists to prevent. The budget was there all along: a single-item
 * trimmed read measured ~890 chars against a 6,000-char door.
 *
 * The repair is a LADDER-SHARED summary budget, and these tests pin the two
 * properties that make it safe — it must not cost the checkpoint anything, and it
 * must not cost a bulk read its rows.
 */
describe("shapeWorkItemsGet — the summary rides the slack (EI-20743148487714069)", () => {
  const DOOR = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

  function itemRow(id: string, summaryLen: number, checkpointLen = 0): Record<string, unknown> {
    return {
      ok: true,
      id,
      workItem: {
        id,
        kind: "bug",
        state: "open",
        title: "a title",
        severity: "major",
        summary: "S".repeat(summaryLen),
      },
      ...(checkpointLen > 0 ? { checkpoint: "C".repeat(checkpointLen) } : {}),
    };
  }

  it("delivers a median-sized body WHOLE on the single-item read that was title-only", () => {
    // 402 chars is the measured p50 body length across 33,853 open work-items.
    const summary = "S".repeat(402);
    const out = shapeWorkItemsGet(envelope([itemRow("WI-1", 402)]), "trimmed") as Envelope;
    const w = out.results[0].workItem as Record<string, unknown>;

    expect(w.summary).toBe(summary);
    expect(String(w.summary)).not.toMatch(/TRUNCATED/);
    // Nothing was lost, so there must be no note at all (the note must keep meaning
    // something — see the sibling test above).
    expect(out._shapeNote).toBeUndefined();
  });

  it("NEVER buys summary bytes from the checkpoint — the summary yields first", () => {
    // The rung that would fit this summary cannot also fit the checkpoint whole.
    // "Degraded last" means the checkpoint wins and the summary is what goes.
    const checkpoint = "C".repeat(5_000);
    const out = shapeWorkItemsGet(
      envelope([itemRow("WI-1", 4_000, 5_000)]),
      "trimmed",
    ) as Envelope;
    const w = out.results[0].workItem as Record<string, unknown>;

    expect(out.results[0].checkpoint).toBe(checkpoint); // byte-identical
    expect(w.summary).toBeUndefined();
    expect(out._shapeNote?.dropped).toEqual(expect.arrayContaining(["workItem.summary"]));
  });

  it("costs a 100-id bulk read NOTHING — no row is stubbed to pay for prose", () => {
    // The regression this design exists to avoid: a FLAT per-row summary cap is
    // multiplied by the row count and pushes a bulk read down the ladder, trading
    // 97 items' identity for 3 items' prose. The ladder-shared budget falls below
    // the useful floor at this width and is dropped instead.
    const rows = Array.from({ length: 100 }, (_, i) => itemRow(`WI-${i}`, 1_091));
    const out = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;
    const full = out.results.filter((r) => r._stub === undefined);

    // Correlation is never broken, whatever the shaping.
    expect(out.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // No summary survives at this width, and that is the CORRECT trade.
    expect(
      out.results.every((r) => (r.workItem as Record<string, unknown> | undefined)?.summary === undefined),
    ).toBe(true);
    // EI-21349427754992019: a ZERO budget is OMITTED from the note rather than
    // emitted as 0 — these bytes sit on a payload graded against this very door.
    // The drop itself is still named in `dropped` (asserted via every row's
    // missing summary above and the arrayContaining checks in sibling tests).
    expect(out._shapeNote?.summaryCharsPerRow).toBeFalsy();
    // CALIBRATION: the same 100 rows WITHOUT summaries must degrade identically.
    // If the summary budget were being paid for out of rows, these would differ —
    // which is what makes the assertion above non-vacuous.
    const bare = shapeWorkItemsGet(
      envelope(Array.from({ length: 100 }, (_, i) => itemRow(`WI-${i}`, 0))),
      "trimmed",
    ) as Envelope;
    expect(full.length).toBe(bare.results.filter((r) => r._stub === undefined).length);
  });

  it("distinguishes a CLIPPED summary from a DROPPED one — different losses", () => {
    // A clip is recoverable from what is in hand; a drop is not. A reader acts
    // differently on them, so one label for both would be a worse answer.
    const clipped = shapeWorkItemsGet(envelope([itemRow("WI-1", 40_000)]), "trimmed") as Envelope;
    expect(clipped._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["workItem.summary(clipped)"]),
    );
    expect(String((clipped.results[0].workItem as Record<string, unknown>).summary)).toMatch(
      /TRUNCATED/,
    );
    expect(clipped._shapeNote?.dropped).not.toContain("workItem.summary");

    const dropped = shapeWorkItemsGet(
      envelope([itemRow("WI-1", 4_000, 5_000)]),
      "trimmed",
    ) as Envelope;
    expect(dropped._shapeNote?.dropped).toContain("workItem.summary");
    expect(dropped._shapeNote?.dropped).not.toContain("workItem.summary(clipped)");
  });

  it("says the SUMMARY specifically was dropped, not just that something was", () => {
    // The generic size advisory reads as "you got the item, just smaller" — which
    // is how a reader ends up acting on the title.
    const dropped = shapeWorkItemsGet(
      envelope([itemRow("WI-1", 4_000, 5_000)]),
      "trimmed",
    ) as Envelope;
    expect(dropped._shapeNote?.next).toMatch(/SUMMARY was dropped/);
    expect(dropped._shapeNote?.next).toMatch(/title is a LABEL/i);

    // And it does NOT cry summary when the summary survived — the warning has to
    // stay worth reading.
    const kept = shapeWorkItemsGet(envelope([itemRow("WI-1", 40_000)]), "trimmed") as Envelope;
    expect(kept._shapeNote?.next).not.toMatch(/SUMMARY was dropped/);
  });

  it("keeps every scenario under the result door", () => {
    for (const rows of [
      [itemRow("WI-1", 402)],
      [itemRow("WI-1", 42_220)],
      [itemRow("WI-1", 4_000, 13_000)],
      Array.from({ length: 10 }, (_, i) => itemRow(`WI-${i}`, 1_091)),
    ]) {
      const out = shapeWorkItemsGet(envelope(rows), "trimmed");
      expect(JSON.stringify(out)!.length).toBeLessThanOrEqual(DOOR);
    }
  });
});

describe("citedFacts survives the shaper (EI-19465127338264010)", () => {
  const citedFacts = {
    dangling: 1,
    decayed: 2,
    note: "This item's prose cites 3 fact key(s) as its authority; 3 no longer resolve live.",
    cited: Array.from({ length: 8 }, (_, i) => ({
      key: `some-cited-key-${i}`,
      condition: i === 0 ? "dangling" : "retracted",
      ref: i === 0 ? null : `fact:workspace:some-cited-key-${i}@v${i}`,
      scope: i === 0 ? null : "workspace",
      scopeRef: null,
      versionId: i === 0 ? null : i,
      ...(i === 0 ? {} : { excerpt: "E".repeat(400) }),
    })),
  };

  // THE DEFECT THIS PINS: projectRow rebuilds each row from a WHITELIST, so a new
  // conditional field added to get.ts is dropped SILENTLY unless it is added here
  // too — the exact class of loss this whole file was filed for, one field over.
  for (const tier of ["trimmed", "standard"] as const) {
    it(`keeps the finding and its note at the '${tier}' tier`, () => {
      const out = shapeWorkItemsGet(
        { ok: true, results: [row({ citedFacts })], counts: { ok: 1, failed: 0 } },
        tier,
      ) as Envelope;
      const cf = out.results[0].citedFacts as Record<string, unknown>;
      expect(cf).toBeDefined();
      // The counts and the note ARE the finding — never degraded.
      expect(cf.dangling).toBe(1);
      expect(cf.decayed).toBe(2);
      expect(cf.note).toBe(citedFacts.note);
      // The bulk (per-key excerpts) is capped, and never silently.
      const kept = cf.cited as Array<Record<string, unknown>>;
      expect(kept.length).toBeLessThan(citedFacts.cited.length);
      expect(cf.citedTruncated).toEqual({ shown: kept.length, total: 8 });
      expect(out._shapeNote?.dropped).toContain("citedFacts.cited");
      // A clipped excerpt carries the loud in-band marker, not a bare ellipsis.
      const withExcerpt = kept.find((k) => typeof k.excerpt === "string");
      expect(withExcerpt?.excerpt).toContain("TRUNCATED");
      // Identity survives clipping — the key is what a reader looks up.
      expect(kept[0].key).toBe("some-cited-key-0");
    });
  }

  it("is absent when the handler emitted no finding", () => {
    const out = shapeWorkItemsGet(
      { ok: true, results: [row()], counts: { ok: 1, failed: 0 } },
      "trimmed",
    ) as Envelope;
    expect(out.results[0].citedFacts).toBeUndefined();
  });

  it("CONTROL: an unlisted field really is dropped, so the test above is not vacuous", () => {
    // Without this, `citedFacts` surviving could look like a property of the
    // shaper rather than of the whitelist entry that was added for it — and the
    // test would still pass if the shaper stopped projecting rows at all.
    // A sibling field of identical shape, deliberately NOT whitelisted, must
    // vanish; the same call keeps citedFacts.
    const out = shapeWorkItemsGet(
      {
        ok: true,
        results: [row({ citedFacts, notAWhitelistedField: { dangling: 1, note: "should vanish" } })],
        counts: { ok: 1, failed: 0 },
      },
      "trimmed",
    ) as Envelope;
    expect(out.results[0].notAWhitelistedField).toBeUndefined();
    expect(out.results[0].citedFacts).toBeDefined();
  });
});

/**
 * P-003 (R-3, carry-recheck-and-governed-memory-2026-10-14): the retraction cascade's
 * READ seam. A flag that the whitelist drops is a flag nobody sees — R-3 requires it
 * be VISIBLE, naming the fact and the reason — so it must survive every tier,
 * including the compact single-item floor, and say so when it is cut.
 */
describe("assumptionFlags survive the shaper (P-003 / R-3)", () => {
  const flag = (i: number) => ({
    dedupeKey: `retracted:workspace::release-window:${i}`,
    condition: "retracted",
    factRef: `workspace:release-window-${i}`,
    scope: "workspace",
    scopeRef: null,
    key: `release-window-${i}`,
    citedVersionId: null,
    versionId: 10 + i,
    supersededBy: null,
    reason: "window moved",
    by: "su-peer",
    at: "2026-10-14T18:00:00.000Z",
    line: `Fact workspace:release-window-${i} was retracted by su-peer: window moved`,
  });

  for (const tier of ["trimmed", "standard"] as const) {
    it(`keeps the flag, naming fact and reason, at the '${tier}' tier`, () => {
      const out = shapeWorkItemsGet(envelope([row({ assumptionFlags: [flag(0)] })]), tier) as Envelope;
      const flags = out.results[0].assumptionFlags as Array<Record<string, unknown>>;
      expect(flags).toHaveLength(1);
      expect(flags[0].factRef).toBe("workspace:release-window-0");
      expect(flags[0].line).toContain("window moved");
      expect(out.results[0].assumptionFlagsTruncated).toBeUndefined();
    });
  }

  it("discloses truncation as { shown, total } rather than dropping flags silently", () => {
    const many = Array.from({ length: 9 }, (_, i) => flag(i));
    const out = shapeWorkItemsGet(envelope([row({ assumptionFlags: many })]), "trimmed") as Envelope;
    const flags = out.results[0].assumptionFlags as unknown[];
    expect(flags.length).toBeLessThan(many.length);
    expect(out.results[0].assumptionFlagsTruncated).toEqual({ shown: flags.length, total: 9 });
    expect(out._shapeNote?.dropped).toContain("assumptionFlags");
  });

  it("keeps the flag line at the compact single-item floor", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          checkpoint: "C".repeat(40_000),
          holder: { goalRef: "WI-1", goalText: "H".repeat(40_000), assumptions: { keys: [] }, agreement: "sole", competing: [] },
          lifecycle: { events: Array.from({ length: 100 }, (_, i) => ({ kind: `event-${i}` })) },
          priorAttempts: { attempts: [{ text: "A".repeat(10_000) }] },
          assumptionFlags: [flag(0)],
        }),
      ]),
      "trimmed",
    ) as Envelope;
    expect(out._shapeNote?.singleItemFloor, "did not reach the single-item floor").toMatch(/reduced identity/);
    const flags = out.results[0].assumptionFlags as Array<Record<string, unknown>>;
    expect(flags).toEqual([
      { condition: "retracted", factRef: "workspace:release-window-0", line: flag(0).line },
    ]);
  });

  it("is absent when the item carries no flag", () => {
    const out = shapeWorkItemsGet(envelope([row()]), "trimmed") as Envelope;
    expect(out.results[0].assumptionFlags).toBeUndefined();
    expect(out.results[0].assumptionFlagsTruncated).toBeUndefined();
  });

  it("CONTROL: an unlisted sibling of identical shape is dropped, so the keep is the whitelist's doing", () => {
    const out = shapeWorkItemsGet(
      envelope([row({ assumptionFlags: [flag(0)], notWhitelistedFlags: [flag(1)] })]),
      "trimmed",
    ) as Envelope;
    expect(out.results[0].notWhitelistedFlags).toBeUndefined();
    expect(out.results[0].assumptionFlags).toBeDefined();
  });
});

/**
 * EI-19454477695046958 — the SAME whitelist-drop class as the block above, and it
 * recurred anyway: `checkpointRetractions` was added to get.ts, shipped unit-green
 * and typecheck-clean, and was dropped here silently. Caught only by probing the
 * LIVE tool, which returned the field at `full` and nothing at `trimmed`.
 *
 * Why the drop mattered more than usual: this advisory exists BECAUSE a trimmed
 * reader gets the summary nearly whole and the checkpoint as a short prefix, so a
 * retraction past the clip is invisible while the claim it withdraws still reads as
 * the item's definition. Measured on WI-39344 — retractions at offsets 1803/1965/2349
 * of a 24,597-char note the trimmed tier delivered as 849 chars. Dropping it here
 * defeated the fix on precisely the tier the fix was for.
 */
describe("checkpointRetractions survives the shaper (EI-19454477695046958)", () => {
  // count 5 / 3 excerpts / more 2 — the real WI-39344 shape.
  const checkpointRetractions = {
    count: 5,
    excerpts: Array.from({ length: 3 }, (_, i) => `CORRECTION ${i + 1} — ${"R".repeat(400)}`),
    more: 2,
  };

  for (const tier of ["trimmed", "standard"] as const) {
    it(`keeps the count at the '${tier}' tier, where the checkpoint is clipped`, () => {
      const out = shapeWorkItemsGet(
        { ok: true, results: [row({ checkpointRetractions })], counts: { ok: 1, failed: 0 } },
        tier,
      ) as Envelope;
      const cr = out.results[0].checkpointRetractions as Record<string, unknown>;
      expect(cr).toBeDefined();
      // The COUNT is the irreducible signal — the documented failure is missing the
      // SECOND retraction, which a boolean or a shortened list cannot convey.
      expect(cr.count).toBe(5);
    });

    it(`re-derives 'more' from what it kept at the '${tier}' tier, so the arithmetic stays true`, () => {
      const out = shapeWorkItemsGet(
        { ok: true, results: [row({ checkpointRetractions })], counts: { ok: 1, failed: 0 } },
        tier,
      ) as Envelope;
      const cr = out.results[0].checkpointRetractions as Record<string, unknown>;
      const kept = cr.excerpts as string[];
      const more = (cr.more as number | undefined) ?? 0;
      // scanCheckpointRetractions guarantees excerpts.length + more === count. Forwarding
      // the ORIGINAL more (2) beside a shortened excerpts list would understate the
      // remainder — a wrong number from the one field whose job is to be counted on.
      expect(kept.length + more).toBe(5);
    });
  }

  it("announces an excerpt cut rather than shrinking the list silently", () => {
    const many = { count: 9, excerpts: Array.from({ length: 9 }, (_, i) => `CORRECTION ${i + 1}`) };
    const out = shapeWorkItemsGet(
      { ok: true, results: [row({ checkpointRetractions: many })], counts: { ok: 1, failed: 0 } },
      "trimmed",
    ) as Envelope;
    const cr = out.results[0].checkpointRetractions as Record<string, unknown>;
    expect((cr.excerpts as string[]).length).toBeLessThan(9);
    expect(cr.count).toBe(9);
    expect(out._shapeNote?.dropped).toContain("checkpointRetractions.excerpts");
  });

  it("omits the field entirely when the checkpoint carries no retraction, so a clean read stays lean", () => {
    const out = shapeWorkItemsGet(
      { ok: true, results: [row({})], counts: { ok: 1, failed: 0 } },
      "trimmed",
    ) as Envelope;
    expect("checkpointRetractions" in out.results[0]).toBe(false);
  });
});

/**
 * EI-26070715751470427 — exact `detail:true` reads must keep the bounded coord
 * substrate that the handler already fetched. The old whitelist dropped
 * `{ topics, posts, links }` even though `getWorkItemDetail` had limited the
 * thread, forcing a reviewer onto the unshaped spill path. Bulk reads still
 * disclose counts instead of multiplying detail bodies across every row.
 */
describe("detail:true — bounded exact detail, bulk evidence-of-content", () => {
  const detailRow = (id = "WI-1", posts = 7) => ({
    ok: true,
    id,
    workItem: {
      id,
      state: "open",
      title: "a title",
      topics: ["coord-dx", "git-sync"],
      posts: Array.from({ length: posts }, (_, i) => ({ post_id: i, body: "B".repeat(600) })),
      links: [{ rel: "blocks", dst: { kind: "work_item", ref: "WI-2" } }],
    },
    checkpoint: "short",
  });
  const emptyDetail = () => ({
    ok: true,
    id: "WI-1",
    workItem: { id: "WI-1", state: "open", topics: [], posts: [], links: [] },
    checkpoint: "short",
  });
  const wi = (e: Envelope, i = 0) => e.results[i].workItem as Record<string, unknown>;

  it("keeps bounded posts/topics/links on an exact read and discloses any remainder", () => {
    const out = shapeWorkItemsGet(envelope([detailRow()]), "trimmed") as Envelope;

    expect(wi(out).posts).toHaveLength(5);
    expect((wi(out).posts as Array<{ post_id: number }>).map((post) => post.post_id)).toEqual([2, 3, 4, 5, 6]);
    expect(wi(out).topics).toEqual(["coord-dx", "git-sync"]);
    expect(wi(out).links).toEqual([{ rel: "blocks", dst: { kind: "work_item", ref: "WI-2" } }]);
    expect(wi(out).detailOmitted).toBeUndefined();
    expect(wi(out).detailTruncated).toEqual({ posts: { shown: 5, total: 7 } });
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["workItem.posts"]),
    );
  });

  it("keeps EMPTY arrays as a real answer — no marker, and no _shapeNote", () => {
    const out = shapeWorkItemsGet(envelope([emptyDetail()]), "trimmed") as Envelope;
    expect(wi(out).posts).toEqual([]);
    expect(wi(out).topics).toEqual([]);
    expect(wi(out).links).toEqual([]);
    expect(wi(out).detailOmitted).toBeUndefined();
    expect(out._shapeNote).toBeUndefined();
  });

  it("a detail:false read (fields absent entirely) carries no marker either", () => {
    const out = shapeWorkItemsGet(
      envelope([{ ok: true, id: "WI-1", workItem: { id: "WI-1", state: "open" }, checkpoint: "short" }]),
      "trimmed",
    ) as Envelope;
    expect(wi(out).detailOmitted).toBeUndefined();
  });

  it("attributes bounded detail to the RIGHT row — payload-level _shapeNote cannot", () => {
    const out = shapeWorkItemsGet(
      envelope([emptyDetail(), detailRow("WI-loud", 3)]),
      "trimmed",
    ) as Envelope;
    expect(wi(out, 0).detailOmitted).toBeUndefined();
    expect(wi(out, 0).posts).toBeUndefined();
    expect(wi(out, 1).detailOmitted).toMatchObject({ posts: 3 });
    expect(wi(out, 1).posts).toBeUndefined();
  });

  it("uses the bounded detail reader's same-snapshot post total", () => {
    const out = shapeWorkItemsGet(
      envelope([{
        ...detailRow("WI-bounded", 2),
        workItem: { ...detailRow("WI-bounded", 2).workItem, postsTotal: 137 },
      }]),
      "trimmed",
    ) as Envelope;

    expect(wi(out).posts).toHaveLength(2);
    expect(wi(out).postsTotal).toBe(137);
    expect(wi(out).detailTruncated).toMatchObject({ posts: { shown: 2, total: 137 } });
  });

  it("stays under the hard ceiling on a 100-row detail read, with ONE label per field", () => {
    const out = shapeWorkItemsGet(
      envelope(Array.from({ length: 100 }, (_, i) => detailRow(`WI-${i}`, 20))),
      "trimmed",
    ) as Envelope;

    expect(JSON.stringify(out).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    expect(out.results).toHaveLength(100);
    // Pins the label design: interpolating the count into the `dropped` label
    // would emit up to 100 distinct strings here, spending the budget this
    // shaper exists to protect. The count belongs per row instead.
    expect(out._shapeNote?.dropped.filter((d) => d === "workItem.posts")).toHaveLength(1);
  });

  it("CONTROL: a DEFENSIVE always-emit implementation fails the empty-detail property", () => {
    // Kept PERMANENTLY. Empty detail arrays are a measured answer, not an
    // omission. Modelling the wrong implementation here proves the exact read
    // retains that answer and the bulk omission marker remains meaningful.
    const defensive = (w: Record<string, unknown>) => {
      const omitted: Record<string, number> = {};
      for (const f of ["posts", "topics", "links"] as const) {
        omitted[f] = Array.isArray(w[f]) ? (w[f] as unknown[]).length : 0;
      }
      return omitted; // always emits — the bug
    };

    const empty = emptyDetail();
    expect(defensive(empty.workItem)).toEqual({ posts: 0, topics: 0, links: 0 });
    // The REAL implementation keeps the empty arrays on that same input.
    const out = shapeWorkItemsGet(envelope([empty]), "trimmed") as Envelope;
    expect(wi(out).detailOmitted).toBeUndefined();
    expect(wi(out).posts).toEqual([]);
    // Calibration: a bulk read DOES speak when detail content is omitted, so
    // the omission disclosure is not simply broken.
    const loud = shapeWorkItemsGet(envelope([detailRow()]), "trimmed") as Envelope;
    const bulk = shapeWorkItemsGet(envelope([detailRow("WI-1"), detailRow("WI-2")]), "trimmed") as Envelope;
    expect(wi(loud).posts).toHaveLength(5);
    expect(wi(bulk, 0).detailOmitted).toMatchObject({ posts: 7 });
  });
});

describe("threadLimit — bounded diagnostic thread stays consumable", () => {
  it("keeps the requested window when an oversized exact read reaches the compact floor", () => {
    const threadWindow = {
      posts: [{
        id: 7,
        thread_id: "thread-1",
        author_id: "su-peer",
        body: "latest evidence",
        created_ts: "2026-08-12T10:00:00.000Z",
      }],
      total: 150,
      topics: ["release-gate"],
      createdAt: "2026-08-12T09:00:00.000Z",
    };
    const out = shapeWorkItemsGet(
      envelope([
        row({
          checkpoint: "C".repeat(40_000),
          holder: {
            goalRef: "WI-1",
            goalText: "H".repeat(40_000),
            assumptions: { keys: ["hold"] },
            agreement: "sole",
            competing: [],
          },
          lifecycle: { events: Array.from({ length: 100 }, (_, i) => ({ kind: `event-${i}` })) },
          priorAttempts: { attempts: [{ text: "A".repeat(10_000) }] },
          threadWindow,
        }),
      ]),
      "trimmed",
    ) as Envelope;

    expect(out._shapeNote?.singleItemFloor).toMatch(/reduced identity/);
    expect(out.results[0].threadWindow).toMatchObject({
      shown: 1,
      total: 150,
      posts: [{ id: 7, body: "latest evidence" }],
    });
    expect(out._shapeNote?.dropped ?? []).not.toContain("threadWindow");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(
      RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE,
    );
  });

  it("keeps the bounded window, counts it, and marks large post bodies", () => {
    const threadWindow = {
      posts: Array.from({ length: 6 }, (_, i) => ({
        id: i + 1,
        thread_id: "thread-1",
        author_id: "su-peer",
        body: "B".repeat(800),
        created_ts: `2026-08-12T10:0${i}:00.000Z`,
      })),
      total: 12,
      topics: ["release-gate"],
      createdAt: "2026-08-12T09:00:00.000Z",
    };
    const out = shapeWorkItemsGet(envelope([row({ threadWindow })]), "trimmed") as Envelope;
    const thread = out.results[0].threadWindow as Record<string, any>;

    expect(thread.shown).toBe(5);
    expect(thread.total).toBe(12);
    expect(thread.posts[0].id).toBe(2);
    expect(thread.posts[0].bodyTruncated).toBe(true);
    expect(thread.posts[0].bodyChars).toBe(800);
    expect(thread.posts[0].body).toMatch(/TRUNCATED/);
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["threadWindow.posts", "threadWindow.postBodies"]),
    );
  });

  it("does not invent a missing-comment warning for a measured empty thread", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: { id: "WI-1", state: "open", topics: [], posts: [], links: [] },
          threadWindow: { posts: [], total: 0, topics: [], createdAt: "2026-08-12T09:00:00.000Z" },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    expect(out.results[0].threadWindow).toMatchObject({ shown: 0, total: 0, posts: [] });
    expect(out._shapeNote?.dropped ?? []).not.toEqual(
      expect.arrayContaining(["threadWindow.posts", "threadWindow.postBodies", "threadWindow.topics"]),
    );
  });

  it("preserves an explicit failed bounded read instead of rendering silence", () => {
    const out = shapeWorkItemsGet(envelope([row({ threadWindow: null, threadWindowReadFailed: true })]), "trimmed") as Envelope;
    expect(out.results[0]).toMatchObject({ threadWindow: null, threadWindowReadFailed: true });
  });
});

/**
 * P-017 — the prior-attempt brief through the shaper.
 *
 * Two hazards, and the first is structural: projectRow rebuilds each row from a
 * WHITELIST, so a field the handler adds and the shaper does not know about is
 * dropped SILENTLY at every tier. That is not a smaller answer — an agent asking
 * "what was already tried here" gets a payload with no prior-attempt field at
 * all, which reads as "nothing was tried".
 *
 * The second is the clip. A prior attempt whose body reads "tried X; X was the
 * wrong lead" becomes, truncated at the wrong place, a recommendation to try X —
 * the same misreading EI-19447969329510166 pinned for the checkpoint, in a field
 * whose whole purpose is to stop a successor repeating a dead end.
 */
function briefRow(over: Record<string, unknown> = {}, records = 1, textChars = 40) {
  return row({
    workItem: { id: "WI-1", kind: "task", state: "open", title: "t" },
    priorAttempts: {
      schemaVersion: "prior-attempt-brief-v1",
      fingerprint: "fp-1",
      authority: [],
      residue: [],
      attempts: Array.from({ length: records }, (_, i) => ({
        authority: "attempt",
        scope: "same-plan-item",
        rawRef: `WI-${i + 2}#checkpoint`,
        text: "T".repeat(textChars),
      })),
      rawRefs: Array.from({ length: records }, (_, i) => `WI-${i + 2}#checkpoint`),
      protectedRefs: { authority: [], residue: [] },
      omission: {
        omittedRecords: 2,
        omittedByAuthority: { attempt: 2 },
        omittedRefs: [{ authority: "attempt", scope: "plan-wide", rawRef: "WI-99#checkpoint" }],
        omittedRefsTruncated: false,
        sourceCount: 3,
        deduplicatedCount: 3,
        truncated: true,
      },
      estimatedTokens: 40,
      serializedChars: 160,
    },
    ...over,
  });
}

describe("shapeWorkItemsGet — priorAttempts survives, and says what it cut", () => {
  it("carries the brief through the row WHITELIST at all (the silent-drop trap)", () => {
    const out = shapeWorkItemsGet(envelope([briefRow()]), "trimmed") as Envelope;
    const pa = out.results[0].priorAttempts as Record<string, any>;
    expect(pa).toBeTruthy();
    expect(pa.fingerprint).toBe("fp-1");
    expect(pa.attempts).toHaveLength(1);
  });

  it("MARKS a text it clipped, so a truncated dead end cannot read as a recommendation", () => {
    const out = shapeWorkItemsGet(envelope([briefRow({}, 1, 5_000)]), "trimmed") as Envelope;
    const rec = (out.results[0].priorAttempts as any).attempts[0];
    expect(rec.text.length).toBeLessThan(5_000);
    expect(rec.textTruncated).toBe(true);
    // The pre-clip length, so the reader can size the drill-down before paying
    // for it — and the rawRef that makes the drill-down possible at all.
    expect(rec.fullTextChars).toBe(5_000);
    expect(rec.rawRef).toBe("WI-2#checkpoint");
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["priorAttempts.attempts(text clipped)"]),
    );
    expect(out._shapeNote?.next).toContain("priorAttemptRefs");
    expect(out._shapeNote?.next).toContain("rawRef");
    expect(out._shapeNote?.next).toContain("retry alone does not retrieve");
    expect(out._shapeNote?.next).not.toContain("Fields were dropped or clipped for the '");
  });

  it("names both recovery routes when prior-attempt text and a tier-shaped field are clipped", () => {
    const out = shapeWorkItemsGet(
      envelope([briefRow({ checkpoint: "C".repeat(40_000) }, 1, 5_000)]),
      "trimmed",
    ) as Envelope;
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["priorAttempts.attempts(text clipped)", "checkpoint(clipped)"]),
    );
    expect(out._shapeNote?.next).toContain("priorAttemptRefs");
    expect(out._shapeNote?.next).toContain("payloadTier:'full'");
  });

  it("keeps the OMISSION accounting whole while cutting records — the qualifier outlives what it qualifies", () => {
    const out = shapeWorkItemsGet(envelope([briefRow({}, 25, 40)]), "trimmed") as Envelope;
    const pa = out.results[0].priorAttempts as Record<string, any>;
    expect(pa.attempts.length).toBeLessThan(25);
    expect(out._shapeNote?.dropped).toEqual(expect.arrayContaining(["priorAttempts.attempts"]));
    // Dropping this to make room for records would leave a record list that
    // reads as the complete history — the exact failure `lifecycle.coverage`
    // exists to prevent, one field over.
    expect(pa.omission).toMatchObject({ omittedRecords: 2, truncated: true });
    expect(pa.omission.omittedRefs[0].rawRef).toBe("WI-99#checkpoint");
  });

  it("flips omittedRefsTruncated IN BAND when it cuts the ref list itself", () => {
    const many = briefRow();
    (many.priorAttempts as any).omission.omittedRefs = Array.from({ length: 40 }, (_, i) => ({
      authority: "attempt",
      scope: "plan-wide",
      rawRef: `WI-${100 + i}#checkpoint`,
    }));
    const out = shapeWorkItemsGet(envelope([many]), "trimmed") as Envelope;
    const omission = (out.results[0].priorAttempts as any).omission;
    expect(omission.omittedRefs.length).toBeLessThan(40);
    // Without this an exhausted ref list is indistinguishable from a complete
    // one, and the reader stops asking after the last ref it can see.
    expect(omission.omittedRefsTruncated).toBe(true);
  });

  it("leaves a 100-row read with briefs under the MCP result door", () => {
    const rows = Array.from({ length: 100 }, (_, i) => {
      const r = briefRow({ id: `WI-${i}` }, 6, 2_000);
      (r.workItem as Record<string, unknown>).id = `WI-${i}`;
      return r;
    });
    const out = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(
      RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE,
    );
    expect(out.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});

describe("shapeWorkItemsGet — priorAttemptRefResolution", () => {
  const resolutionRow = (records: number, textChars: number) =>
    row({
      workItem: { id: "WI-1", kind: "task", state: "open", title: "t" },
      priorAttemptRefResolution: {
        schemaVersion: "prior-attempt-refs-v1",
        records: Array.from({ length: records }, (_, i) => ({
          authority: "attempt",
          scope: "plan-wide",
          rawRef: `WI-${i + 2}#checkpoint`,
          text: "R".repeat(textChars),
        })),
        unresolved: ["WI-9#gone"],
        fingerprint: "fp-1",
      },
    });

  it("carries the resolution through the whitelist and keeps `unresolved`", () => {
    const out = shapeWorkItemsGet(envelope([resolutionRow(1, 20)]), "trimmed") as Envelope;
    const res = out.results[0].priorAttemptRefResolution as Record<string, any>;
    expect(res.records).toHaveLength(1);
    // "the ref you asked for is gone" and "the shaper cut it" are different
    // answers; only this field separates them.
    expect(res.unresolved).toEqual(["WI-9#gone"]);
    expect(res.fingerprint).toBe("fp-1");
  });

  it("bounds a large drill-down and discloses BOTH the cut and the clip", () => {
    const out = shapeWorkItemsGet(envelope([resolutionRow(9, 9_000)]), "trimmed") as Envelope;
    const res = out.results[0].priorAttemptRefResolution as Record<string, any>;
    expect(res.records.length).toBeLessThan(9);
    expect(res.recordsTruncated).toMatchObject({ total: 9 });
    expect(res.records[0].textTruncated).toBe(true);
    expect(res.records[0].fullTextChars).toBe(9_000);
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["priorAttemptRefResolution.records"]),
    );
  });

  // EI-21349427754992019: three detail rows with chatty lifecycle timelines used
  // to descend the WHOLE ladder — lifecycle events were count-capped but never
  // char-budgeted, so every non-floor rung exceeded the door and ALL rows
  // collapsed to {id,_stub}. Lifecycle is ladder-budgeted now; some rung must
  // fit with reduced identity intact.
  it("keeps reduced identity rows when fat lifecycle events would force stubbing", () => {
    const fatEvent = () => ({
      at: "2026-08-24T00:00:00Z",
      kind: "comment",
      by: "agA",
      body: "x".repeat(1_500),
    });
    const rows = ["EI-1", "WI-2", "WI-3"].map((id) =>
      row({
        id,
        checkpoint: "C".repeat(3_000),
        checkpointAgeMs: 4_200,
        checkpointUpdatedAtMs: 1_712_345_678_901,
        checkpointContentHash: "hash-1",
        lifecycle: { coverage: "full", flags: {}, events: [fatEvent(), fatEvent(), fatEvent(), fatEvent()] },
        workItem: {
          id,
          kind: "bug",
          state: "open",
          title: `title for ${id}`,
          severity: "major",
          origin: "local",
          assignee: "su-1",
          summary: "S".repeat(1_200),
          payload: { big: "P".repeat(2_000) },
        },
      }),
    );
    const sourceProjection = {
      pick: [
        "results[].id",
        "results[].workItem.assignee",
        "results[].workItem.state",
        "results[].workItem.title",
        "results[].checkpointAgeMs",
        "results[].checkpointUpdatedAtMs",
        "results[].checkpointContentHash",
      ],
    };
    const out = shapeWorkItemsGet(envelope(rows), "trimmed", sourceProjection) as Envelope;
    expect(out.results.filter((r) => (r as Record<string, unknown>)._stub)).toHaveLength(0);
    for (const r of out.results) {
      const w = r.workItem as Record<string, unknown>;
      expect(w.title).toBeTruthy();
      expect(w.state).toBeTruthy();
      expect(w.assignee).toBe("su-1");
      expect(r.checkpointAgeMs).toBe(4_200);
      expect(r.checkpointUpdatedAtMs).toBe(1_712_345_678_901);
      expect(r.checkpointContentHash).toBe("hash-1");
    }
    // The bulk that gave way is NAMED, never silently gone (D-004).
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["lifecycle.events", "workItem.summary"]),
    );
    // And the shaped result actually fits the door it is graded against.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });
});
