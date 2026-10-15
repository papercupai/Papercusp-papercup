/**
 * github-divergence (github-bridge-hive-egress P-006) — pure classification +
 * the escalation writer against an injected fake sql (unit-hermetic).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject sql in tests');
  },
}));

import {
  collectDivergenceSignals,
  classifyDivergence,
  recordDivergenceVerdict,
  GITHUB_BRIDGE_ESCALATION_PHASE,
  GITHUB_BRIDGE_ESCALATION_KIND,
  GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS,
  githubBridgeNeedsOwnerConditionKey,
  needsOwnerCause,
  decideNeedsOwnerAlarm,
  isSameBridgeEscalation,
  importWithRetry,
  EMPTY_NEEDS_OWNER_LATCH,
  isWorkflowScopeRefusal,
  workflowScopeRemedy,
  type NeedsOwnerLatch,
} from './github-divergence';

const egressNonFF = { remoteRef: 'refs/heads/staging', remoteSha: 'aaa', localSha: 'bbb', reason: 'diverged' };
const ingressNonFF = { branch: 'main', local: 'ccc', remote: 'ddd' };
const blockedAdmission = {
  head: 'eee',
  result: { admit: false, basis: 'blocked' as const, blockedAuthors: [{ githubUserId: 7, commits: ['eee'] }], errors: [] },
};
const secretBlock = { remoteRef: 'refs/heads/staging', findings: [{ kind: 'x' }] as never[], overflow: false, skippedLargeBlobs: 0 };

describe('collectDivergenceSignals — folds the mechanism residues', () => {
  it('collects all four signal classes', () => {
    const signals = collectDivergenceSignals({
      egress: { rejectedNonFF: [egressNonFF], blockedSecrets: [secretBlock] },
      ingress: { nonFF: [ingressNonFF] },
      admissions: [blockedAdmission],
    });
    expect(signals.map((s) => s.kind).sort()).toEqual([
      'admission-blocked',
      'egress-non-ff',
      'egress-secret-block',
      'ingress-non-ff',
    ]);
  });

  it('an unreachable remote is its own signal — NOT a clean pass (oddsmith 2026-07-19)', () => {
    const signals = collectDivergenceSignals({
      remoteUnreachable: {
        remoteUrl: 'https://github.com/aviynw/oddsmith.git',
        branches: ['staging'],
        errors: ['remote: Repository not found.'],
      },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('bridge-remote-unreachable');
    // The whole point: it must ESCALATE and need a human, because every
    // structured residue is empty exactly BECAUSE nothing was fetched.
    const verdict = classifyDivergence(signals);
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(true);
    expect(verdict.detail).toMatch(/INERT/);
  });

  it('a TRANSIENT unreachable remote (spawn-level fault, EI-18152354175913564) escalates but does not need an owner', () => {
    const signals = collectDivergenceSignals({
      remoteUnreachable: {
        remoteUrl: 'https://github.com/acme/widgets.git',
        branches: ['main'],
        errors: ['Error: spawn git ENOENT'],
        transient: true,
      },
    });
    expect(signals[0]!.kind).toBe('bridge-remote-unreachable');
    const verdict = classifyDivergence(signals);
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(false);
    expect(verdict.detail).not.toMatch(/fix the remote URL or wire the credential/i);
    expect(verdict.detail).toMatch(/transient/i);
  });

  it('an egress transport failure is not a clear pass (WI-37949)', () => {
    const signals = collectDivergenceSignals({
      egress: {
        rejectedNonFF: [],
        blockedSecrets: [],
        remoteErrors: [{ message: 'push refs/heads/staging: 403 email verification required', transient: false }],
      },
    });
    expect(signals).toEqual([
      {
        kind: 'bridge-egress-unreachable',
        errors: ['push refs/heads/staging: 403 email verification required'],
        transient: false,
      },
    ]);
    const verdict = classifyDivergence(signals);
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(true);
    expect(verdict.detail).toMatch(/egress transport/i);
  });

  it('a workflow-scope refusal is agent-actionable, with the exact local remedy attached', () => {
    const message =
      'push refs/heads/staging: refusing to allow an OAuth App to create or update workflow without workflow scope';
    expect(isWorkflowScopeRefusal(message)).toBe(true);
    const signals = collectDivergenceSignals({
      egress: { rejectedNonFF: [], blockedSecrets: [], remoteErrors: [{ message, transient: false }] },
    });
    expect(signals).toEqual([
      {
        kind: 'bridge-egress-agent-actionable',
        errors: [message],
        transient: false,
        remedy: {
          kind: 'github-workflow-scope',
          paths: ['.github/workflows/ci.yml'],
          command: 'git checkout origin/staging -- .github/workflows/ci.yml',
        },
      },
    ]);
    const verdict = classifyDivergence(signals);
    expect(verdict.needsOwner).toBe(false);
    expect(verdict.agentActionable).toBe(true);
    expect(verdict.agentRemedies).toEqual([workflowScopeRemedy([message])]);
    expect(verdict.detail).toMatch(/git checkout origin\/staging -- \.github\/workflows\/ci\.yml/);
    expect(verdict.detail).not.toMatch(/fix the remote account\/credential/i);
  });

  it('mixed workflow-scope + credential failures keep both the agent remedy and owner rail', () => {
    const workflow = 'remote rejected workflow update without workflow scope';
    const credential = 'remote: Repository not found';
    const verdict = classifyDivergence(
      collectDivergenceSignals({
        egress: {
          rejectedNonFF: [],
          blockedSecrets: [],
          remoteErrors: [
            { message: workflow, transient: false },
            { message: credential, transient: false },
          ],
        },
      }),
    );
    expect(verdict.needsOwner).toBe(true);
    expect(verdict.agentActionable).toBe(true);
    expect(verdict.signals.map((s) => s.kind)).toEqual(['bridge-egress-agent-actionable', 'bridge-egress-unreachable']);
  });

  it('an egress DNS failure escalates without an owner lever', () => {
    const verdict = classifyDivergence(
      collectDivergenceSignals({
        egress: {
          rejectedNonFF: [],
          blockedSecrets: [],
          remoteErrors: [
            { message: 'push refs/heads/staging: Could not resolve host: github.com', transient: true },
          ],
        },
      }),
    );
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(false);
    expect(verdict.detail).toMatch(/transient network or transport failure/i);
  });

  it('admitted heads (baseline/clean) are non-events; empty/absent inputs yield no signals', () => {
    expect(
      collectDivergenceSignals({
        admissions: [
          { head: 'x', result: { admit: true, basis: 'baseline', blockedAuthors: [], errors: [] } },
          { head: 'y', result: { admit: true, basis: 'clean', blockedAuthors: [], errors: [] } },
        ],
      }),
    ).toEqual([]);
    expect(collectDivergenceSignals({})).toEqual([]);
    expect(collectDivergenceSignals({ egress: null, ingress: null })).toEqual([]);
  });

  it('a fail-closed admission error surfaces as basis error', () => {
    const s = collectDivergenceSignals({
      admissions: [{ head: 'z', result: { admit: false, basis: 'error', blockedAuthors: [], errors: ['pg down'] } }],
    });
    expect(s).toEqual([{ kind: 'admission-blocked', head: 'z', basis: 'error', blockedAuthors: [], errors: ['pg down'] }]);
  });

  // EI-18751829787526583: canonical EXISTS but is stale — the sibling gap to
  // egress-canonical-missing (a ref that is ABSENT). A green-reading 3h freeze
  // was caused by this case, not the absent one.
  it('a stale-but-present canonical ref is its own signal', () => {
    const s = collectDivergenceSignals({
      canonicalStale: { canonicalSha: 'c'.repeat(40), expectedSha: 'e'.repeat(40), behindCount: 21 },
    });
    expect(s).toEqual([
      { kind: 'egress-canonical-stale', canonicalSha: 'c'.repeat(40), expectedSha: 'e'.repeat(40), behindCount: 21 },
    ]);
  });
});

describe('classifyDivergence — policy', () => {
  it('no signals → clear', () => {
    const v = classifyDivergence([]);
    expect(v.action).toBe('clear');
    expect(v.needsOwner).toBe(false);
  });

  it('egress non-FF / secret block alone escalate WITHOUT the owner lever (integrator/scrub self-heal)', () => {
    const v = classifyDivergence(collectDivergenceSignals({ egress: { rejectedNonFF: [egressNonFF], blockedSecrets: [secretBlock] } }));
    expect(v.action).toBe('escalate');
    expect(v.needsOwner).toBe(false);
    expect(v.detail).toMatch(/NOT forced/);
    expect(v.detail).toMatch(/never force-pushed/);
  });

  it('ingress non-FF (history rewrite) and admission-blocked need the OWNER lever', () => {
    for (const signals of [
      collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }),
      collectDivergenceSignals({ admissions: [blockedAdmission] }),
    ]) {
      const v = classifyDivergence(signals);
      expect(v.action).toBe('escalate');
      expect(v.needsOwner).toBe(true);
    }
  });
});

describe('recordDivergenceVerdict — escalation writer (injected sql)', () => {
  const capture = () => {
    const calls: Array<{ q: string; params: unknown[] }> = [];
    const sql = { unsafe: async (q: string, params: unknown[]) => (calls.push({ q, params }), []) } as unknown as Sql;
    return { calls, sql };
  };

  /** The writer now READS the prior row first (WI-38327 alarm latch), so the
   *  store call of interest is the last one, not the only one. */
  const lastCall = (calls: Array<{ q: string; params: unknown[] }>) => calls[calls.length - 1];

  it('escalate → upserts one row on the github-bridge phase with the divergence kind', async () => {
    const { calls, sql } = capture();
    const verdict = classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }));
    await recordDivergenceVerdict('shop-hive', 'ws', verdict, sql);
    const write = lastCall(calls);
    expect(write.q).toMatch(/INSERT INTO harness_shared.harness_escalations/);
    const [slug, phase, body] = write.params as [string, string, string];
    expect(slug).toBe('shop-hive');
    expect(phase).toBe(GITHUB_BRIDGE_ESCALATION_PHASE);
    const parsed = JSON.parse(body);
    expect(parsed.kind).toBe(GITHUB_BRIDGE_ESCALATION_KIND);
    expect(parsed.needs_owner).toBe(true);
    expect(parsed.signals).toHaveLength(1);
  });

  it('clear → clears ONLY its own kind (strict non-clobber, git-sync idiom)', async () => {
    const { calls, sql } = capture();
    await recordDivergenceVerdict('shop-hive', 'ws', classifyDivergence([]), sql);
    const write = lastCall(calls);
    expect(write.q).toMatch(/SET escalation = NULL/);
    expect(write.params).toContain(GITHUB_BRIDGE_ESCALATION_KIND);
  });

  it('WI-38327: persists the alarm latch on the row so the alarm can be one-shot across ticks', async () => {
    const { calls, sql } = capture();
    const verdict = classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }));
    await recordDivergenceVerdict('shop-hive', 'ws', verdict, sql);
    const parsed = JSON.parse((lastCall(calls).params as [string, string, string])[2]);
    // First owner-actionable tick: counted, but BELOW the debounce threshold,
    // so it must not have latched an alarm yet.
    expect(parsed.needs_owner_sweeps).toBe(1);
    expect(parsed.needs_owner_alerted).toBe(false);
    expect(parsed.needs_owner_cause).toBeNull();
  });

  it('WI-38327: reads the prior latch before writing (otherwise every tick looks like the first)', async () => {
    const { calls, sql } = capture();
    await recordDivergenceVerdict('shop-hive', 'ws', classifyDivergence([]), sql);
    expect(calls[0].q).toMatch(/SELECT escalation FROM harness_shared.harness_escalations/);
    expect(calls[0].params).toContain(GITHUB_BRIDGE_ESCALATION_PHASE);
  });
});

describe('WI-10003620 — an unchanged verdict does not rewrite (and git-commit) its escalation', () => {
  /** A fake sql whose SELECT returns `stored` (the prior row) and records every call. */
  const withStoredRow = (stored: Record<string, unknown> | null) => {
    const calls: Array<{ q: string; params: unknown[] }> = [];
    const sql = {
      unsafe: async (q: string, params: unknown[]) => {
        calls.push({ q, params });
        return /^\s*SELECT/.test(q) && stored ? [{ escalation: JSON.stringify(stored) }] : [];
      },
    } as unknown as Sql;
    return { calls, sql };
  };
  const inserts = (calls: Array<{ q: string; params: unknown[] }>) =>
    calls.filter((c) => /INSERT INTO harness_shared.harness_escalations/.test(c.q));

  /** A self-healing (not owner-actionable) residue: the latch stays empty, so
   *  two sweeps of the same verdict build the same body bar emitted_at. */
  const selfHealingVerdict = () => {
    const v = classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }));
    return { ...v, needsOwner: false };
  };

  /** Run one sweep against an empty store and return the body it wrote. */
  const firstWrite = async (verdict: ReturnType<typeof selfHealingVerdict>) => {
    const { calls, sql } = withStoredRow(null);
    await recordDivergenceVerdict('shop-hive', 'ws', verdict, sql);
    const [write] = inserts(calls);
    expect(write).toBeDefined();
    return JSON.parse((write.params as [string, string, string])[2]) as Record<string, unknown>;
  };

  it('a sweep that restates the stored verdict issues NO write (only emitted_at would have changed)', async () => {
    const verdict = selfHealingVerdict();
    const stored = { ...(await firstWrite(verdict)), emitted_at: 1 };
    const { calls, sql } = withStoredRow(stored);
    await recordDivergenceVerdict('shop-hive', 'ws', verdict, sql);
    expect(calls.length).toBeGreaterThan(0); // it did read the prior row
    expect(inserts(calls)).toHaveLength(0);
  });

  it('control: a changed detail DOES rewrite the row', async () => {
    const verdict = selfHealingVerdict();
    const stored = { ...(await firstWrite(verdict)), detail: 'an older, different finding' };
    const { calls, sql } = withStoredRow(stored);
    await recordDivergenceVerdict('shop-hive', 'ws', verdict, sql);
    expect(inserts(calls)).toHaveLength(1);
  });

  it('isSameBridgeEscalation ignores emitted_at and key order, and nothing else', () => {
    const base = { kind: GITHUB_BRIDGE_ESCALATION_KIND, needs_owner: false, signals: [{ kind: 'x', ref: 'a' }], emitted_at: 1 };
    const reordered = { emitted_at: 2, signals: [{ ref: 'a', kind: 'x' }], needs_owner: false, kind: GITHUB_BRIDGE_ESCALATION_KIND };
    expect(isSameBridgeEscalation(base, reordered)).toBe(true);
    expect(isSameBridgeEscalation(base, { ...reordered, needs_owner: true })).toBe(false);
    expect(isSameBridgeEscalation(base, { ...reordered, signals: [{ kind: 'x', ref: 'b' }] })).toBe(false);
    expect(isSameBridgeEscalation(null, base)).toBe(false);
  });
});

describe('WI-38327 — the needs-owner alarm latch (pure policy, no database)', () => {
  const ownerActionable = () => classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }));
  const differentCause = () => classifyDivergence(collectDivergenceSignals({ admissions: [blockedAdmission] }));
  const selfHealing = () =>
    classifyDivergence(collectDivergenceSignals({ egress: { rejectedNonFF: [egressNonFF], blockedSecrets: [] } }));
  const latch = (o: Partial<NeedsOwnerLatch> = {}): NeedsOwnerLatch => ({ ...EMPTY_NEEDS_OWNER_LATCH, ...o });

  it('needsOwnerCause names only the OWNER-actionable kinds, and is order-independent', () => {
    expect(needsOwnerCause(ownerActionable().signals)).toBe('ingress-non-ff');
    expect(needsOwnerCause(differentCause().signals)).toBe('admission-blocked');
    // An egress non-FF self-heals via the integrator's next merge — not an owner lever.
    expect(needsOwnerCause(selfHealing().signals)).toBeNull();
    expect(needsOwnerCause([])).toBeNull();
    const both = [...ownerActionable().signals, ...differentCause().signals];
    expect(needsOwnerCause(both)).toBe(needsOwnerCause([...both].reverse()));
    expect(needsOwnerCause(both)).toBe('admission-blocked+ingress-non-ff');
  });

  it('a TRANSIENT DNS failure never pages an owner and does not suggest repairing URL or credentials', () => {
    const transient = collectDivergenceSignals({
      remoteUnreachable: {
        remoteUrl: 'u',
        branches: ['main'],
        errors: ['Could not resolve host: github.com'],
        transient: true,
      },
    });
    expect(needsOwnerCause(transient)).toBeNull();
    const verdict = classifyDivergence(transient);
    expect(verdict.detail).toMatch(/DNS or connection failure/i);
    expect(verdict.detail).not.toMatch(/fix the remote URL or wire the credential/i);
    const persistent = collectDivergenceSignals({
      remoteUnreachable: { remoteUrl: 'u', branches: ['main'], errors: ['Repository not found'], transient: false },
    });
    expect(needsOwnerCause(persistent)).toBe('bridge-remote-unreachable');
  });

  it('debounces: the first owner-actionable tick counts but does NOT page', () => {
    const d = decideNeedsOwnerAlarm(latch(), ownerActionable());
    expect(GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS).toBeGreaterThan(1);
    expect(d.alarm).toBe(false);
    expect(d.next.sweeps).toBe(1);
    expect(d.next.alerted).toBe(false);
  });

  it('pages once the condition is SUSTAINED, then stays silent while the cause is unchanged', () => {
    const first = decideNeedsOwnerAlarm(latch(), ownerActionable());
    const second = decideNeedsOwnerAlarm(first.next, ownerActionable());
    expect(second.alarm).toBe(true);
    expect(second.next.alerted).toBe(true);
    expect(second.next.cause).toBe('ingress-non-ff');

    // One-shot: the same cause must not re-page on every subsequent tick.
    const third = decideNeedsOwnerAlarm(second.next, ownerActionable());
    expect(third.alarm).toBe(false);
    expect(third.next.alerted).toBe(true);
    // WI-10003620: the counter saturates at the debounce threshold, so a
    // standing owner-actionable verdict stops rewriting its escalation row.
    expect(third.next.sweeps).toBe(GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS);
    expect(decideNeedsOwnerAlarm(third.next, ownerActionable()).next).toEqual(third.next);
  });

  it('a CHANGE of cause re-pages once — the WI-6643 masking bug, guarded', () => {
    // Regression control for the exact defect this latch is keyed by cause to
    // avoid: with a bare boolean, whichever signal latched FIRST would silence
    // every later, DIFFERENT failure for as long as it stayed unresolved.
    const alerted = latch({ alerted: true, cause: 'ingress-non-ff', sweeps: 5 });
    const changed = decideNeedsOwnerAlarm(alerted, differentCause());
    expect(changed.alarm).toBe(true);
    expect(changed.next.cause).toBe('admission-blocked');

    // ...and then falls back to one-shot on the NEW cause.
    expect(decideNeedsOwnerAlarm(changed.next, differentCause()).alarm).toBe(false);
  });

  it('recovers: a clean verdict after an alarm resets the latch and announces an all-clear', () => {
    const alerted = latch({ alerted: true, cause: 'ingress-non-ff', sweeps: 4 });
    const d = decideNeedsOwnerAlarm(alerted, classifyDivergence([]));
    expect(d.recovered).toBe(true);
    expect(d.alarm).toBe(false);
    expect(d.next).toEqual(EMPTY_NEEDS_OWNER_LATCH);
  });

  it('an escalate verdict whose residues all SELF-HEAL is a recovery too — an owner has nothing to do', () => {
    const alerted = latch({ alerted: true, cause: 'ingress-non-ff', sweeps: 4 });
    const v = selfHealing();
    expect(v.action).toBe('escalate'); // still an escalation row...
    expect(v.needsOwner).toBe(false); // ...but not an owner lever
    const d = decideNeedsOwnerAlarm(alerted, v);
    expect(d.recovered).toBe(true);
    expect(d.next.alerted).toBe(false);
  });

  it('never announces an all-clear for an alarm it never raised', () => {
    expect(decideNeedsOwnerAlarm(latch(), classifyDivergence([])).recovered).toBe(false);
    // Below the debounce threshold: counted, never paged, so nothing to resolve.
    const belowThreshold = decideNeedsOwnerAlarm(latch(), ownerActionable());
    expect(decideNeedsOwnerAlarm(belowThreshold.next, classifyDivergence([])).recovered).toBe(false);
  });

  it('the condition key is stable per hive, so repeat sweeps coalesce instead of storming', () => {
    expect(githubBridgeNeedsOwnerConditionKey('papercusp')).toBe('github-bridge-needs-owner:papercusp');
    expect(githubBridgeNeedsOwnerConditionKey('oddsmith-hive')).not.toBe(githubBridgeNeedsOwnerConditionKey('papercusp'));
  });

  // EI-20562689651892687: the alarm's one-shot latch persists BEFORE delivery is
  // attempted, so a single swallowed delivery failure silences the alarm for the
  // rest of the episode with no retry until the cause changes. Root cause traced
  // to the bg-host journal: `deliverNeedsOwnerAlarm`'s dynamic `import()` of
  // attention-notify/severe-event-broadcast hit a transient "Cannot find module"
  // (git-sync mutating the tree mid-tick) on the ONE tick the one-shot alarm
  // fired for papercusp, and was never retried. `importWithRetry` is the fix.
  describe('importWithRetry — EI-20562689651892687 (transient dynamic-import resilience)', () => {
    it('returns the loader result immediately when it succeeds first try', async () => {
      const loader = vi.fn().mockResolvedValue('ok');
      await expect(importWithRetry(loader, 3, 0)).resolves.toBe('ok');
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('retries past a transient failure and succeeds within the attempt budget', async () => {
      const loader = vi
        .fn()
        .mockRejectedValueOnce(new Error("Cannot find module '../../attention-notify'"))
        .mockRejectedValueOnce(new Error("Cannot find module '../../attention-notify'"))
        .mockResolvedValueOnce('ok');
      await expect(importWithRetry(loader, 3, 0)).resolves.toBe('ok');
      expect(loader).toHaveBeenCalledTimes(3);
    });

    it('exhausts the attempt budget and rethrows the LAST error when every attempt fails', async () => {
      const loader = vi
        .fn()
        .mockRejectedValueOnce(new Error('first'))
        .mockRejectedValueOnce(new Error('second'))
        .mockRejectedValueOnce(new Error('third'));
      await expect(importWithRetry(loader, 3, 0)).rejects.toThrow('third');
      expect(loader).toHaveBeenCalledTimes(3);
    });
  });

  it('never throws — a store failure is swallowed with a warn (best-effort, bridge tick must not die)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = { unsafe: async () => { throw new Error('pg down'); } } as unknown as Sql;
      await expect(
        recordDivergenceVerdict('shop-hive', 'ws', classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } })), sql),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to record divergence verdict (shop-hive)'));
    } finally {
      warn.mockRestore();
    }
  });
});
