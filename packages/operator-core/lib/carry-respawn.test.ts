/** carry-respawn (deterministic-context-carry P-018 deterministic core): the pure
 *  producer→consumer bridge that turns a built CarryDoc into a respawn launch spec
 *  — the renderCarryDoc({budgetChars}) handoff + the open-owner-message first
 *  prompt (P-010) + the open-owner-question boundary gate. */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
const carryPolicy = vi.hoisted(() => vi.fn());
vi.mock('./capability-envelope/session-confinement-port', async importOriginal => ({
  ...await importOriginal<typeof import('./capability-envelope/session-confinement-port')>(),
  sessionCarryPolicy: carryPolicy,
}));
beforeEach(() => carryPolicy.mockReset().mockResolvedValue(undefined));
import type { CarryBrief } from './carry-brief';
import {
  renderCarryDoc,
  carryDocBudgetChars,
  gateOpenOwnerQuestion,
  type BuildCarryDocOpts,
  type CarryDoc,
  type CarryDocContinuation,
} from './carry-doc';
import {
  carryNoteSnapshotIdentity,
  compareCarryNoteFreshness,
  buildOwnerRespawnLaunchSpec,
  buildRespawnLaunchSpec,
  buildFrozenAssignmentRespawnSpec,
  frozenCarryTriggerReceipt,
  deriveRespawnFirstPrompt,
  renderCarryNoteFreshnessWarning,
} from './carry-respawn';

const NOW = 1_800_000_000_000;

describe('frozen assignment carry assembly', () => {
  const initialPrompt = 'Solve only this frozen task. Frozen memory: initial bytes.';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const boundary = { initialPrompt, initialPromptSha256: hash(initialPrompt), mode: 'on' as const };
  it('restarts from the same initial task and includes explicit prior state only when enabled', () => {
    const on = buildFrozenAssignmentRespawnSpec(boundary, '  Work left: verify iron collection.  ');
    const off = buildFrozenAssignmentRespawnSpec({ ...boundary, mode: 'off' }, 'SECRET prior progress');
    expect(on.firstPrompt).toBe(initialPrompt + "\n\nContinuation note from this assignment's prior session:\nWork left: verify iron collection.");
    expect(off.firstPrompt).toBe(initialPrompt);
    expect(on.systemPromptAddendum).toBe(''); expect(off.systemPromptAddendum).toBe('');
    expect(off.frozenAssignmentCarry).toEqual({ mode: 'off', initialPromptSha256: hash(initialPrompt),
      noteSha256: null, firstPromptSha256: hash(initialPrompt) });
    expect(on.frozenAssignmentCarry?.noteSha256).toBe(hash('Work left: verify iron collection.'));
    expect(on.frozenAssignmentCarry?.firstPromptSha256).toBe(hash(on.firstPrompt!));
  });
  it('refuses modified initial bytes, malformed policy and oversized notes instead of silently falling back', () => {
    for (const changed of [{ ...boundary, initialPrompt: initialPrompt + ' altered' },
      { ...boundary, initialPromptSha256: 'invalid' }, { ...boundary, mode: 'unknown' },
      { ...boundary, extra: true }])
      expect(() => buildFrozenAssignmentRespawnSpec(changed as typeof boundary)).toThrow(/invalid/);
    expect(() => buildFrozenAssignmentRespawnSpec(boundary, 'x'.repeat(1001))).toThrow(/invalid/);
  });
  it.each(['on', 'off'] as const)('requires a fresh measured trigger for frozen %s carry and preserves recovery provenance', mode => {
    const policy = { ...boundary, mode, compactionLimit: 20_000 };
    const usage = { backend: 'codex', nativeSessionId: 'native-own', sessionStartedAtMs: NOW - 1000,
      unavailableReason: null, reading: { tokens: 20_000, observedAtMs: Date.now(), source: 'codex-last-token-usage' as const } };
    expect(() => buildFrozenAssignmentRespawnSpec(policy)).toThrow(/measured trigger/);
    for (const changed of [{ ...usage, reading: null },
      { ...usage, reading: { ...usage.reading, tokens: 19_999 } },
      { ...usage, reading: { ...usage.reading, observedAtMs: Date.now() - 60_001 } },
      { ...usage, nativeSessionId: '' }])
      expect(() => frozenCarryTriggerReceipt(policy, { source: 'self-request', usage: changed })).toThrow(/trigger/);
    expect(() => frozenCarryTriggerReceipt(policy, { source: 'watchdog-soft', usage, runtimeLimit: 25_000 })).toThrow(/trigger/);
    const trigger = frozenCarryTriggerReceipt(policy, { source: 'watchdog-soft', usage, runtimeLimit: 20_000 });
    const spec = buildFrozenAssignmentRespawnSpec(policy, 'own progress', trigger);
    expect(spec.frozenAssignmentCarry?.trigger).toMatchObject({ kind: 'matched-threshold', source: 'watchdog-soft',
      nativeSessionId: 'native-own', limitTokens: 20_000, observedTokens: 20_000 });
    expect(spec.firstPrompt?.includes('own progress')).toBe(mode === 'on');
    for (const source of ['watchdog-force', 'context-death', 'tool-reference-death'] as const) {
      const recovery = frozenCarryTriggerReceipt(policy, { source, usage });
      expect(recovery.kind).toBe('recovery');
      expect(() => buildFrozenAssignmentRespawnSpec(policy, undefined, { ...recovery, kind: 'matched-threshold' })).toThrow(/invalid/);
    }
  });
  it.each(['on', 'off'] as const)('branches before general readers for frozen carry %s', async mode => {
    carryPolicy.mockResolvedValue({ ...boundary, mode });
    const buildFn = vi.fn(async () => doc(NO_OWNER));
    const refresh = vi.fn();
    const spec = await buildOwnerRespawnLaunchSpec('su-private', { effectiveWindowTokens: 200_000,
      buildOpts: { workspaceId: 'bench-private' }, buildFn, refreshLoopCarryNoteWithMetaFn: refresh,
      continueNote: 'Own prior progress' });
    expect(carryPolicy).toHaveBeenCalledWith({ ownerId: 'su-private', workspaceId: 'bench-private' });
    expect(spec?.firstPrompt?.includes('Own prior progress')).toBe(mode === 'on');
    expect(buildFn).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
  it('never falls through after a policy read or frozen-integrity failure', async () => {
    const buildFn = vi.fn(async () => doc(NO_OWNER));
    for (const kind of ['unreadable', 'modified'] as const) {
      if (kind === 'unreadable') carryPolicy.mockRejectedValue(new Error('authority unavailable'));
      else carryPolicy.mockResolvedValue({ ...boundary, initialPrompt: 'modified' });
      expect(await buildOwnerRespawnLaunchSpec('su-private', { effectiveWindowTokens: 200_000, buildFn })).toBeNull();
    }
    expect(buildFn).not.toHaveBeenCalled();
  });
});

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-1',
    loop: { harness: 'papercusp', active: true, intervalSec: 60, goal: null, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

function doc(continuation: CarryDocContinuation, over: Partial<CarryDoc> = {}): CarryDoc {
  return {
    brief: brief(),
    identity: {
      ownerId: 'su-1',
      ownerLabel: 'su · su-1',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      fleet: null,
      account: null,
    },
    sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }], loopActive: true, loopIntervalSec: 60 },
    planItems: [],
    asks: [],
    tail: [],
    continuation,
    ...over,
  };
}

const OPEN_DELIBERATE: CarryDocContinuation = {
  lastOwnerMessage: { text: 'ship the release when the gate is green', ts: '2026-07-14T20:00:00.000Z' },
  answered: false,
  deliberate: true,
  selfRequested: true,
};
const OPEN_FORCED: CarryDocContinuation = { ...OPEN_DELIBERATE, deliberate: false };
const ANSWERED: CarryDocContinuation = { ...OPEN_DELIBERATE, answered: true };
const NO_OWNER: CarryDocContinuation = { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true };

describe('buildRespawnLaunchSpec — assembly', () => {
  it('renders the carry doc to the budget-B addendum and derives the budget from the window', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(NO_OWNER), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.budgetChars).toBe(carryDocBudgetChars(400_000));
    // The addendum IS renderCarryDoc held to that exact budget — wired through, not re-implemented.
    expect(spec.systemPromptAddendum).toBe(renderCarryDoc(doc(NO_OWNER), NOW, { budgetChars: spec.budgetChars }));
    // It carries the minimum-viable orientation (banner + identity + self-recall).
    expect(spec.systemPromptAddendum).toContain('Carry document (deterministic');
    expect(spec.systemPromptAddendum).toContain('su · su-1');
    expect(spec.systemPromptAddendum).toContain('Self-recall');
  });

  it('carries same-session retracted continuation refs into the launch spec', () => {
    const spec = buildRespawnLaunchSpec({
      doc: doc(NO_OWNER, { retractedContinuationRefs: ['EI-20191442676357637'] }),
      effectiveWindowTokens: 400_000,
      now: NOW,
    });
    expect(spec.retractedContinuationRefs).toEqual(['EI-20191442676357637']);
    expect(spec.systemPromptAddendum).toContain('Retraction guard');
  });

  it('holds the addendum within the constant budget B (aging ladder fit)', () => {
    // A tail-heavy doc against the smallest budget still fits.
    const bigTail = doc(NO_OWNER, {
      tail: Array.from({ length: 8 }, (_, i) => ({
        speaker: 'assistant' as const,
        text: 'x'.repeat(6000) + ` turn ${i}`,
        ts: null,
      })),
    });
    const spec = buildRespawnLaunchSpec({ doc: bigTail, effectiveWindowTokens: 1000, now: NOW });
    expect(spec.budgetChars).toBe(carryDocBudgetChars(1000)); // floors at 8*4000
    expect(spec.systemPromptAddendum.length).toBeLessThanOrEqual(spec.budgetChars);
  });

  it('keeps a superseded carry-check warning inside the constant budget', () => {
    const snapshot = carryNoteSnapshotIdentity({ note: 'old', updatedAtMs: NOW, readFailed: false });
    const live = carryNoteSnapshotIdentity({ note: 'new', updatedAtMs: NOW + 1, readFailed: false });
    const freshness = compareCarryNoteFreshness(snapshot, live);
    const spec = buildRespawnLaunchSpec({
      doc: doc(NO_OWNER),
      effectiveWindowTokens: 1000,
      now: NOW,
      carryNoteFreshness: freshness,
    });
    expect(freshness.status).toBe('superseded');
    expect(renderCarryNoteFreshnessWarning(freshness)).toContain('SUPERSEDED');
    expect(spec.systemPromptAddendum.length).toBeLessThanOrEqual(spec.budgetChars);
    expect(spec.systemPromptAddendum).toContain('CARRIED LOOP CHECKS SUPERSEDED');
  });
});

describe('buildRespawnLaunchSpec — first prompt (P-010)', () => {
  it('an OPEN owner message becomes the successor first prompt, verbatim', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_DELIBERATE), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBe('ship the release when the gate is green');
  });

  it('an OPEN owner message is delivered on a FORCED boundary too (carried, not lost)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_FORCED), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBe('ship the release when the gate is green');
  });

  it('an ANSWERED owner message yields NO first prompt (already handled)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(ANSWERED), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBeNull();
  });

  it('no owner message ⇒ no first prompt (successor opens on the carry doc)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(NO_OWNER), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBeNull();
  });

  it('carries the FULL open owner message only in the first prompt; the addendum shows a truncated preview + framing', () => {
    // >240 chars: the continuation block previews the head (framing) but the tail
    // marker beyond the preview cap must live ONLY in the first prompt, never
    // duplicated as quoted history in the addendum (P-010 "never quoted material").
    const longText = 'PLEASE ' + 'x'.repeat(300) + ' UNIQUE_TAIL_MARKER';
    const cont: CarryDocContinuation = { lastOwnerMessage: { text: longText, ts: null }, answered: false, deliberate: true, selfRequested: true };
    const spec = buildRespawnLaunchSpec({ doc: doc(cont), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toContain('UNIQUE_TAIL_MARKER');
    expect(spec.systemPromptAddendum).not.toContain('UNIQUE_TAIL_MARKER');
    // The addendum still FRAMES it: the successor is told it arrives as the first prompt.
    expect(spec.systemPromptAddendum).toContain('FIRST PROMPT');
  });

  it('a plan-bound respawn appends the exact plans:get pointer to the first prompt', () => {
    const spec = buildRespawnLaunchSpec({
      doc: doc(OPEN_DELIBERATE),
      effectiveWindowTokens: 400_000,
      now: NOW,
      plan: { slug: 'deterministic-context-carry-2026-07-14', harness: 'papercusp' },
    });
    expect(spec.firstPrompt).toContain('ship the release when the gate is green');
    expect(spec.firstPrompt).toContain('deterministic-context-carry-2026-07-14');
    expect(spec.firstPrompt).toContain('plans:get');
  });
});

describe('buildRespawnLaunchSpec — open-owner-question gate (P-010)', () => {
  it('a DELIBERATE boundary across an OPEN owner message trips the gate', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_DELIBERATE), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.openOwnerQuestion.crossesOpenOwnerMessage).toBe(true);
    expect(spec.openOwnerQuestion.refusalText).toBeTruthy();
    // Mirrors the pure gate exactly — no re-implementation.
    expect(spec.openOwnerQuestion).toEqual(gateOpenOwnerQuestion(OPEN_DELIBERATE));
  });

  it('a FORCED boundary across an OPEN owner message does NOT trip it (nothing to refuse)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_FORCED), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.openOwnerQuestion.crossesOpenOwnerMessage).toBe(false);
  });

  it('an answered / absent owner message never trips it', () => {
    expect(
      buildRespawnLaunchSpec({ doc: doc(ANSWERED), effectiveWindowTokens: 400_000, now: NOW }).openOwnerQuestion
        .crossesOpenOwnerMessage,
    ).toBe(false);
    expect(
      buildRespawnLaunchSpec({ doc: doc(NO_OWNER), effectiveWindowTokens: 400_000, now: NOW }).openOwnerQuestion
        .crossesOpenOwnerMessage,
    ).toBe(false);
  });

  it('carries an open coord:ask-owner ledger row alongside the transcript gate', () => {
    const spec = buildRespawnLaunchSpec({
      doc: doc(NO_OWNER, {
        asks: [{ id: 'conv-open', question: 'Which release route?', askedAtMs: NOW }],
      }),
      effectiveWindowTokens: 400_000,
      now: NOW,
    });
    // The conversation is open even though the transcript has no unanswered
    // human turn. request-compaction reports the union; P-010 consumers keep
    // using crossesOpenOwnerMessage for the transcript-only refuse-once gate.
    expect(spec.openOwnerAskCount).toBe(1);
    expect(spec.openOwnerQuestion.crossesOpenOwnerMessage).toBe(false);
  });
});

describe('deriveRespawnFirstPrompt (pure branch)', () => {
  it('returns the owner text only when present + unanswered', () => {
    expect(deriveRespawnFirstPrompt(doc(OPEN_DELIBERATE))).toBe('ship the release when the gate is green');
    expect(deriveRespawnFirstPrompt(doc(ANSWERED))).toBeNull();
    expect(deriveRespawnFirstPrompt(doc(NO_OWNER))).toBeNull();
  });

  it('guards a blank owner message from falling through to the empty-note kickoff', () => {
    const blank: CarryDocContinuation = { lastOwnerMessage: { text: '   \n  ', ts: null }, answered: false, deliberate: true, selfRequested: true };
    expect(deriveRespawnFirstPrompt(doc(blank))).toBeNull();
  });

  it('reissues every unresolved request together and does not replay a fully delivered set', () => {
    const multiple: CarryDocContinuation = {
      lastOwnerMessage: { text: 'newer request', ts: null },
      answered: true,
      pendingOwnerMessages: [
        { requestId: 'request-1', text: 'older unfinished request', ts: null },
        { requestId: 'request-3', text: 'third unfinished request', ts: null },
      ],
      deliberate: false,
      selfRequested: false,
    };
    const prompt = deriveRespawnFirstPrompt(doc(multiple));
    expect(prompt).toContain('older unfinished request');
    expect(prompt).toContain('third unfinished request');
    expect(prompt).toContain('Address every request');
    expect(prompt).not.toContain('newer request'); // it was delivered; no replay

    expect(deriveRespawnFirstPrompt(doc({
      ...multiple,
      pendingOwnerMessages: [],
    }))).toBeNull();
  });

  it('threads autoMode + plan through to deriveLaunchPromptText', () => {
    const out = deriveRespawnFirstPrompt(doc(OPEN_DELIBERATE), false, { slug: 'p', harness: 'papercusp' });
    expect(out).toContain('ship the release when the gate is green');
    expect(out).toContain('plans:get');
  });
});

describe('buildOwnerRespawnLaunchSpec — live fail-soft adapter', () => {
  it('builds with a deliberate threshold boundary by default', async () => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.boundaryDeliberate).toBe(true);
      return doc(NO_OWNER);
    };
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildFn,
    });
    expect(out?.systemPromptAddendum).toContain('Carry document (deterministic');
  });

  it('threads the effective role into CarryDoc so judge recovery stays safe', async () => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.role).toBe('judge');
      const base = doc(NO_OWNER);
      return {
        ...base,
        identity: { ...base.identity, role: opts?.role },
        automaticRecovery: null,
      };
    };
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      role: 'judge',
      buildFn,
    });
    expect(out?.systemPromptAddendum).toContain('evaluation context');
    expect(out?.systemPromptAddendum).not.toContain('coord:orient');
    expect(out?.systemPromptAddendum).not.toContain('sessions:search');
  });

  it('lets the live caller explicitly mark a forced boundary', async () => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.boundaryDeliberate).toBe(false);
      return doc(OPEN_FORCED);
    };
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildOpts: { boundaryDeliberate: false },
      buildFn,
    });
    expect(out?.openOwnerQuestion.crossesOpenOwnerMessage).toBe(false);
  });

  it('quietly accepts an equal final loop-note snapshot', async () => {
    const note = '## Next\ngo';
    const finalRead = vi.fn(async () => ({ note, updatedAtMs: NOW, readFailed: false }));
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildFn: async () => {
        const base = doc(NO_OWNER);
        return {
          ...base,
          brief: {
            ...base.brief,
            loop: {
              ...base.brief.loop!,
              carryNote: note,
              carryNoteUpdatedAtMs: NOW,
              carryNoteReadFailed: false,
            },
          },
        };
      },
      refreshLoopCarryNoteWithMetaFn: finalRead,
    });
    expect(finalRead).toHaveBeenCalledOnce();
    expect(out?.carryNoteFreshness?.status).toBe('equal');
    expect(out?.systemPromptAddendum).not.toContain('CARRIED LOOP CHECKS SUPERSEDED');
    expect(out?.systemPromptAddendum).not.toContain('UNABLE-TO-VERIFY');
  });

  it('marks newer or hash-different final loop-note state SUPERSEDED', async () => {
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildFn: async () => doc(NO_OWNER),
      refreshLoopCarryNoteWithMetaFn: async () => ({
        note: '## Next\nnewer',
        updatedAtMs: NOW + 1,
        readFailed: false,
      }),
    });
    expect(out?.carryNoteFreshness?.status).toBe('superseded');
    expect(out?.carryNoteFreshness?.changedFields).toEqual(expect.arrayContaining(['bodyHash', 'updatedAtMs']));
    expect(out?.systemPromptAddendum).toContain('CARRIED LOOP CHECKS SUPERSEDED');
    expect(out?.systemPromptAddendum).toContain('Read the live loop:checkpoint before');
  });

  it('marks a failed final loop-note read unable-to-verify without dropping the spec', async () => {
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildFn: async () => doc(NO_OWNER),
      refreshLoopCarryNoteWithMetaFn: async () => {
        throw new Error('carry store unavailable');
      },
    });
    expect(out?.carryNoteFreshness?.status).toBe('unable-to-verify');
    expect(out?.systemPromptAddendum).toContain('CARRIED LOOP CHECKS UNABLE-TO-VERIFY');
    expect(out?.systemPromptAddendum).toContain('NOT confirmation');
    expect(out?.systemPromptAddendum).toContain('loop:checkpoint');
  });

  it('returns null for a blank owner or any builder failure', async () => {
    expect(
      await buildOwnerRespawnLaunchSpec('  ', {
        effectiveWindowTokens: 400_000,
        buildFn: async () => doc(NO_OWNER),
      }),
    ).toBeNull();
    expect(
      await buildOwnerRespawnLaunchSpec('su-1', {
        effectiveWindowTokens: 400_000,
        buildFn: async () => {
          throw new Error('db unavailable');
        },
      }),
    ).toBeNull();
  });
});
