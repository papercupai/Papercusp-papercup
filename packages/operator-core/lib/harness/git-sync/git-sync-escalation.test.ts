import { describe, it, expect } from 'vitest';
import {
  CHRONIC_CUMULATIVE_PEEL_TICKS,
  CHRONIC_CUMULATIVE_REBROADCAST_TICKS,
  classifyGitSyncFailingLeg,
  CONTENT_QUARANTINE_REALARM_TICKS,
  decideContentQuarantineNotice,
  decideGitSyncEscalation,
  effectivePublishRefusal,
  oversizedKey,
  PUSH_FAILURE_ESCALATION_TICKS,
  selectContentNoticeRecipients,
} from './git-sync-escalation';
import {
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_MAX_COMMIT_TOTAL_BYTES,
  type ScopedOversized,
} from './run-git-sync';

const big: ScopedOversized = { scope: 'superproject', path: 'apps/tui/target/huge.rlib', sizeBytes: 200 * 1048576 };

const base = {
  installSlug: 'papercusp',
  status: 'synced' as const,
  consecutiveErrorTicks: 0,
  errors: [],
  oversized: [],
  maxBlobBytes: DEFAULT_MAX_BLOB_BYTES,
  maxCommitTotalBytes: DEFAULT_MAX_COMMIT_TOTAL_BYTES,
  prevOversizedKeys: [],
};

describe('decideGitSyncEscalation (EI-18)', () => {
  it('clean synced pass → clear, no escalation, no broadcast', () => {
    const d = decideGitSyncEscalation(base);
    expect(d).toEqual({ escalate: false, reasons: [], clear: true, broadcast: null });
  });

  it('clean "nothing" pass → clear too', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'nothing' });
    expect(d.clear).toBe(true);
    expect(d.escalate).toBe(false);
  });

  it('errors BELOW the threshold → no escalation, no broadcast, no clear (condition may still be brewing)', () => {
    for (const ticks of [1, PUSH_FAILURE_ESCALATION_TICKS - 1]) {
      const d = decideGitSyncEscalation({
        ...base,
        status: 'error',
        consecutiveErrorTicks: ticks,
        errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
      });
      expect(d.escalate).toBe(false);
      expect(d.broadcast).toBeNull();
      expect(d.clear).toBe(false);
    }
  });

  it('errors AT the threshold → escalate + broadcast naming the failure', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500\nsend-pack: disconnect' }],
    });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toEqual(['push-failure']);
    expect(d.broadcast).toContain(`FAILED ${PUSH_FAILURE_ESCALATION_TICKS} consecutive ticks`);
    expect(d.broadcast).toContain('git-sync on papercusp');
    expect(d.broadcast).toContain('HTTP 500');
    expect(d.broadcast).not.toContain('send-pack'); // first line only
  });

  it('errors ABOVE the threshold → still escalates (row refresh) but broadcast only fired at the transition', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS + 2,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
    });
    expect(d.escalate).toBe(true);
    expect(d.broadcast).toBeNull();
  });

  it('a NEW oversized file → escalate + broadcast listing it', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big] });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toEqual(['oversized-blobs']);
    expect(d.clear).toBe(false); // the unpushable file still sits in the tree
    expect(d.broadcast).toContain('git-sync on papercusp');
    expect(d.broadcast).toContain('apps/tui/target/huge.rlib');
    expect(d.broadcast).toContain('200.0MB');
    expect(d.broadcast).toContain('configured per-file limit of 95.0MB');
    expect(d.broadcast).toContain("GitHub's individual-blob ceiling is 100MB");
  });

  it('a cumulative-guard exclusion names the dirty-set limit, not GitHub’s per-blob ceiling', () => {
    const d = decideGitSyncEscalation({
      ...base,
      oversized: [
        {
          scope: 'superproject',
          path: 'apps/operator/public/internal/docs/llms-full.txt',
          sizeBytes: 11.7 * 1048576,
          exclusionReason: 'cumulative-limit',
        },
      ],
    });
    expect(d.broadcast).toContain('configured cumulative limit of 250.0MB');
    expect(d.broadcast).toContain('individual blobs, not this guard');
    expect(d.broadcast).not.toContain('they will never push (GitHub 100MB limit)');
  });

  it('a PERSISTING oversized file (same key as last tick) → escalate, but NO repeat broadcast', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big], prevOversizedKeys: [oversizedKey(big)] });
    expect(d.escalate).toBe(true);
    expect(d.broadcast).toBeNull();
  });

  /**
   * EI-21906459740652039 — the edge trigger's blind spot.
   *
   * The `newOversized` filter is right for a one-off stray blob and structurally blind
   * to the condition that actually occurred: the SAME set peeled every tick for 13h,
   * silent after the first, because nothing about it was ever "new" again. So the
   * absence of repeat broadcasts is not evidence the peel stopped — it is exactly what
   * the edge trigger does, which is why nobody noticed for 13h.
   */
  describe('a CHRONIC cumulative-limit peel re-announces itself', () => {
    const peeled = {
      scope: 'superproject' as const,
      path: 'apps/operator/public/internal/docs/agent-insights-index.html',
      sizeBytes: 4 * 1048576,
      exclusionReason: 'cumulative-limit' as const,
    };
    const persisting = {
      ...base,
      oversized: [peeled],
      prevOversizedKeys: [oversizedKey(peeled)], // not "new" — the edge trigger is silent
    };

    it('stays silent below the threshold (a transient bulk import clears itself)', () => {
      for (let t = 1; t < CHRONIC_CUMULATIVE_PEEL_TICKS; t++) {
        expect(decideGitSyncEscalation({ ...persisting, chronicCumulativeTicks: t }).broadcast).toBeNull();
      }
    });

    it('breaks the silence at the threshold, naming the tick count and the stale-on-disk consequence', () => {
      const d = decideGitSyncEscalation({
        ...persisting,
        chronicCumulativeTicks: CHRONIC_CUMULATIVE_PEEL_TICKS,
      });
      expect(d.escalate).toBe(true);
      expect(d.broadcast).toContain(`${CHRONIC_CUMULATIVE_PEEL_TICKS} CONSECUTIVE ticks`);
      expect(d.broadcast).toContain('agent-insights-index.html');
      expect(d.broadcast).toContain('every tick reported success');
    });

    it('then re-broadcasts on a bounded cadence, not every tick', () => {
      const spoken: number[] = [];
      for (let t = CHRONIC_CUMULATIVE_PEEL_TICKS; t <= CHRONIC_CUMULATIVE_PEEL_TICKS + 2 * CHRONIC_CUMULATIVE_REBROADCAST_TICKS; t++) {
        if (decideGitSyncEscalation({ ...persisting, chronicCumulativeTicks: t }).broadcast) spoken.push(t);
      }
      expect(spoken).toEqual([
        CHRONIC_CUMULATIVE_PEEL_TICKS,
        CHRONIC_CUMULATIVE_PEEL_TICKS + CHRONIC_CUMULATIVE_REBROADCAST_TICKS,
        CHRONIC_CUMULATIVE_PEEL_TICKS + 2 * CHRONIC_CUMULATIVE_REBROADCAST_TICKS,
      ]);
    });

    it('is scoped to the CUMULATIVE guard — a chronic per-file oversized blob is a different condition', () => {
      const d = decideGitSyncEscalation({
        ...base,
        oversized: [big], // no exclusionReason ⇒ the per-file cap, not the cumulative one
        prevOversizedKeys: [oversizedKey(big)],
        chronicCumulativeTicks: CHRONIC_CUMULATIVE_PEEL_TICKS,
      });
      expect(d.broadcast).toBeNull();
    });

    it('a tick that peels NOTHING cannot be chronic, whatever the carried counter says', () => {
      const d = decideGitSyncEscalation({ ...base, chronicCumulativeTicks: 999 });
      expect(d.broadcast).toBeNull();
      expect(d.clear).toBe(true);
    });
  });

  it('threshold + new oversized together → both reasons, one combined broadcast', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
      oversized: [big],
    });
    expect(d.reasons).toEqual(['push-failure', 'oversized-blobs']);
    expect(d.broadcast).toContain('consecutive ticks');
    expect(d.broadcast).toContain('huge.rlib');
  });

  it('a conflict tick neither escalates the error kind nor clears it (the conflict path owns that tick)', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'conflict' });
    expect(d.escalate).toBe(false);
    expect(d.clear).toBe(false);
  });

  it('a skipped-locked tick neither escalates nor clears a prior error', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'skipped-locked' });
    expect(d.escalate).toBe(false);
    expect(d.clear).toBe(false);
    expect(d.broadcast).toBeNull();
  });

  it('oversizedKey is scope-qualified (same path in two repos = two keys)', () => {
    expect(oversizedKey(big)).toBe('superproject:apps/tui/target/huge.rlib');
    expect(oversizedKey({ ...big, scope: 'libs/sub' })).not.toBe(oversizedKey(big));
  });
});

/**
 * EI-21230011589307899 — on 2026-08-26 a secret-SHAPED test fixture (a bare PEM
 * private-key header line, used as a NEGATIVE fixture asserting a scanner rejects it)
 * froze this device's own-head publish at one commit. Egress stayed dead for 51
 * minutes with 54 commits queued behind it, and NOTHING raised an alarm:
 * `decideGitSyncEscalation` was never given the publish state at all, so the condition
 * was structurally un-escalatable.
 *
 * Worse than silent — the commit leg still succeeded, so the tick reported status
 * 'synced' and actively CLEARED any open error escalation while egress was frozen.
 * That is the same silent metadata-only failure mode EI-18 fixed for the push and
 * oversized legs, reached through the one hole it left.
 *
 * (Writing this very file produced a live positive control: the write-time
 * secrets-guard hook BLOCKED the first draft for quoting that header literally. The
 * hook is sound on the Edit path — which is why the offending blob can only have
 * reached history through a write path the hook's matcher does not cover.)
 */
describe('decideGitSyncEscalation — own-head publish refusal (EI-21230011589307899)', () => {
  const refusal = { refused: 'secrets', blockedAtCommit: '97bb154c1aaf393e328d4e93bbe7c28eb01a3bc7' };

  it('escalates on SIGHT — no consecutive-tick threshold, unlike push-failure', () => {
    const d = decideGitSyncEscalation({ ...base, publishRefusal: refusal });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toContain('publish-refused');
    // The freeze cannot self-clear (the blob is already in history), so waiting out a
    // flake-absorbing threshold would only extend the outage.
    expect(base.consecutiveErrorTicks).toBeLessThan(PUSH_FAILURE_ESCALATION_TICKS);
  });

  it('does NOT let a frozen-egress tick be reported clean (the 2026-08-26 regression)', () => {
    // status 'synced' — the commit leg succeeded; only the publish leg refused. Before
    // this fix that combination cleared the escalation row while egress was dead.
    const d = decideGitSyncEscalation({ ...base, status: 'synced', publishRefusal: refusal });
    expect(d.clear).toBe(false);
  });

  it('broadcast names the blocked commit AND the remedy that actually works', () => {
    const d = decideGitSyncEscalation({ ...base, publishRefusal: refusal });
    expect(d.broadcast).toContain('97bb154c1aaf'); // where the freeze is pinned
    expect(d.broadcast).toContain('secrets'); // why it refused
    expect(d.broadcast).toContain('pot_git:secrets_exemptions'); // the lever
    // The two misreadings that cost the most time on the day: blaming the origin ref,
    // and trying to fix the file forward.
    expect(d.broadcast).toContain('does NOT clear this');
    expect(d.broadcast).toMatch(/SYMPTOM, not the cause/);
  });

  it('a PERSISTING freeze refreshes the row but does not re-broadcast every tick', () => {
    const d = decideGitSyncEscalation({
      ...base,
      publishRefusal: refusal,
      prevPublishBlockedAtCommit: refusal.blockedAtCommit,
    });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toContain('publish-refused');
    expect(d.broadcast).toBeNull();
  });

  it('a freeze that MOVES to a new commit broadcasts again', () => {
    const d = decideGitSyncEscalation({
      ...base,
      publishRefusal: refusal,
      prevPublishBlockedAtCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(d.broadcast).toContain('97bb154c1aaf');
  });

  it('refused:null is a HEALTHY publish, not a freeze', () => {
    const d = decideGitSyncEscalation({ ...base, publishRefusal: { refused: '', blockedAtCommit: null } });
    expect(d.reasons).not.toContain('publish-refused');
    expect(d.clear).toBe(true);
  });

  it('omitting publishRefusal changes nothing — every pre-existing caller is unaffected', () => {
    expect(decideGitSyncEscalation(base)).toEqual({ escalate: false, reasons: [], clear: true, broadcast: null });
  });

  it('combines with the other reasons rather than replacing them', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big], publishRefusal: refusal });
    expect(d.reasons).toEqual(expect.arrayContaining(['oversized-blobs', 'publish-refused']));
  });
});

/**
 * WI-6554700010010939 — a stale refusal re-broadcast. On 2026-10-13 the own-head publish
 * was refused at 19:42:25Z; a secrets exemption added at 19:45Z cleared it; the next
 * tick (one-tick lag, ~35 min on papercusp) still broadcast "egress is FROZEN" at
 * 20:16:22Z, 50 s before that same tick's publish leg retried and published.
 */
describe('effectivePublishRefusal — exemption newer than the refusal (WI-6554700010010939)', () => {
  const refusedAt = Date.parse('2026-10-13T19:42:25Z');
  const exemptedAt = Date.parse('2026-10-13T19:45:00Z');
  const secrets = { refused: 'secrets', blockedAtCommit: '6c1f826a7a90aaaaaaaaaaaaaaaaaaaaaaaaaaaa', atMs: refusedAt };

  it('drops a secrets refusal recorded BEFORE the latest exemption (the measured incident)', () => {
    expect(effectivePublishRefusal(secrets, exemptedAt)).toBeNull();
  });

  it('the incident tick therefore neither escalates nor broadcasts', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'synced',
      publishRefusal: effectivePublishRefusal(secrets, exemptedAt),
      prevPublishBlockedAtCommit: null,
    });
    expect(d.reasons).not.toContain('publish-refused');
    expect(d.broadcast).toBeNull();
  });

  it('keeps a refusal recorded AFTER the latest exemption — the retry failed again', () => {
    const later = { ...secrets, atMs: exemptedAt + 60_000 };
    expect(effectivePublishRefusal(later, exemptedAt)).toEqual({
      refused: 'secrets',
      blockedAtCommit: secrets.blockedAtCommit,
    });
    // And because the superseded tick recorded no freeze point, the repeat refusal at
    // the SAME commit still broadcasts instead of being treated as a persisting freeze.
    const d = decideGitSyncEscalation({
      ...base,
      publishRefusal: effectivePublishRefusal(later, exemptedAt),
      prevPublishBlockedAtCommit: null,
    });
    expect(d.broadcast).toContain('6c1f826a7a90');
  });

  it('keeps the refusal when no exemption exists or either timestamp is unreadable (fail loud)', () => {
    expect(effectivePublishRefusal(secrets, null)).not.toBeNull();
    expect(effectivePublishRefusal(secrets, Number.NaN)).not.toBeNull();
    expect(effectivePublishRefusal({ ...secrets, atMs: null }, exemptedAt)).not.toBeNull();
  });

  it('an exemption cannot supersede a non-secrets refusal', () => {
    expect(effectivePublishRefusal({ ...secrets, refused: 'oversized' }, exemptedAt)).toEqual({
      refused: 'oversized',
      blockedAtCommit: secrets.blockedAtCommit,
    });
  });

  it('an empty or absent refusal stays null', () => {
    expect(effectivePublishRefusal(null, exemptedAt)).toBeNull();
    expect(effectivePublishRefusal({ ...secrets, refused: '' }, exemptedAt)).toBeNull();
  });

  it('an exemption at the SAME instant as the refusal does not supersede it', () => {
    expect(effectivePublishRefusal(secrets, refusedAt)).not.toBeNull();
  });
});

/**
 * EI-19275994927087666 — both the escalation broadcast and the /admin/git deploy
 * panel called EVERY git-sync failure a PUSH failure. For 32h the fleet inbox read
 * "PUSH FAILING … commits NOT reaching origin" while origin/staging was byte-identical
 * to local HEAD and 18 of 19 routines sat at 0 error ticks. The single offender was an
 * abandoned scratch pot whose corrupt git object broke the COMMIT leg — it never
 * reached the network at all.
 */
describe('classifyGitSyncFailingLeg (EI-19275994927087666)', () => {
  it('classifies the REAL incident error as a commit failure, not a push failure', () => {
    const actual =
      "superproject: commit failed: error: invalid object 100644 d75c463ae71a1031fc95c9ba48982924e195320b for '.papercusp/blueprint.yaml'";
    expect(classifyGitSyncFailingLeg(actual, 'push')).toBe('commit');
  });

  it('does not let push_mode override an explicit commit failure', () => {
    // The real offender's push_mode was 'push', so push_mode alone could never have
    // caught this — the recorded error text has to be the load-bearing signal.
    expect(classifyGitSyncFailingLeg('commit failed: bad object', 'push')).toBe('commit');
  });

  it('classifies a genuine push failure as push', () => {
    expect(classifyGitSyncFailingLeg('failed to push some refs to origin', 'push')).toBe('push');
  });

  it.each([
    'git-sync publication refused: serving unavailable (unknown: lazy serving recovery failed: migration gate failed: snapshot admission)',
    'git-sync publication refused: serving capability has no usable device actor',
  ])('escalates a serving refusal before push with its startup cause: %s', (cause) => {
    const actual = `push failed: ${cause}`;
    expect(classifyGitSyncFailingLeg(actual, 'push')).toBe('serving');
    const decision = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'libs/papercusp', message: actual }],
    });
    expect(decision.escalate).toBe(true);
    expect(decision.broadcast).toContain('serving owner unavailable');
    expect(decision.broadcast).toContain('repair substrate startup');
    expect(decision.broadcast).toContain(cause);
    expect(decision.broadcast).not.toContain('commits NOT reaching origin');
    expect(decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS + 1,
      errors: [{ scope: 'libs/papercusp', message: actual }],
    }).broadcast).toBeNull();
    expect(decideGitSyncEscalation(base).clear).toBe(true);
  });

  it('classifies a conflict as conflict, even though the text also mentions commit', () => {
    expect(classifyGitSyncFailingLeg('merge conflict in lib/x.ts; commit aborted', 'push')).toBe('conflict');
  });

  it('EI-20347384139844425: classifies submodule config-lock contention by its local cause', () => {
    const actual =
      'submodule-config: canonical submodule URL sync failed: error: could not lock config file /repo/.git/config: File exists';
    expect(classifyGitSyncFailingLeg(actual, 'push')).toBe('config-lock');

    const decision = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'submodule-config', message: actual }],
    });
    expect(decision.broadcast).toContain('submodule config-lock contention');
    expect(decision.broadcast).toContain('origin is unaffected');
    expect(decision.broadcast).not.toContain('cause unclassified');
  });

  it('WI-10004397: a disk-headroom refusal is classified as the DISK, never as push or unclassified', () => {
    // The two real 2026-09-30 forms (object-store path shortened). A fetch reserve
    // refusal measures the fetch, not whether the superproject committed locally.
    const verifyForm =
      'fetch failed; submodule remote state could not be verified before superproject publication: ' +
      'git fetch stopped for disk headroom at /repo/.git/modules/libs/generic/cache/objects: ' +
      '25012805632 bytes available; critical reserve 40279831019 bytes';
    const unpushedForm =
      'fetch failed; HEAD has unpushed commits not on origin/main (cannot reconcile): ' +
      'git fetch stopped for disk headroom at /repo/.git/modules/libs/token-kit/objects: ' +
      '25012805632 bytes available; critical reserve 40279831019 bytes';
    expect(classifyGitSyncFailingLeg(verifyForm, 'push')).toBe('disk-headroom');
    // "unpushed" contains "push": without the disk arm first this read as a PUSH failure.
    expect(classifyGitSyncFailingLeg(unpushedForm, 'push')).toBe('disk-headroom');
    expect(classifyGitSyncFailingLeg('error: unable to write file: No space left on device', 'push')).toBe(
      'disk-headroom',
    );
    // A measurement failure is not evidence the disk is full.
    expect(classifyGitSyncFailingLeg('git fetch disk headroom unmeasured at /repo/.git/objects', 'push')).toBe(
      'unknown',
    );

    const decision = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'libs/token-kit', message: unpushedForm }],
    });
    expect(decision.broadcast).toContain('DISK SPACE / HEADROOM');
    expect(decision.broadcast).not.toContain('cause unclassified');
    expect(decision.broadcast).not.toContain('NOT reaching origin');
  });

  it('EI-25439777241393921: a locally synced tick can report submodule headroom errors without claiming commits stopped', () => {
    const decision = decideGitSyncEscalation({
      ...base,
      status: 'synced',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{
        scope: 'libs/token-kit',
        message: 'fetch failed; git fetch stopped for disk headroom at /repo/.git/objects: 32 bytes available; critical reserve 40 bytes',
      }],
    });
    expect(decision.broadcast).toContain('DISK SPACE / HEADROOM');
    expect(decision.broadcast).toContain('does not establish a local commit failure');
    expect(decision.broadcast).not.toContain('nothing commits');
    expect(decision.broadcast).not.toContain('LOCAL DISK FULL');
  });

  it('infers commit for a commit-only member when the error text is unusable', () => {
    // A commit-only:* member never pushes, so its failure cannot be a push failure.
    expect(classifyGitSyncFailingLeg(null, 'commit-only:bridged')).toBe('commit');
    expect(classifyGitSyncFailingLeg('', 'commit-only:config')).toBe('commit');
  });

  it('returns unknown rather than guessing "push" when nothing is decidable', () => {
    expect(classifyGitSyncFailingLeg(null, null)).toBe('unknown');
    expect(classifyGitSyncFailingLeg('something weird happened', 'push')).toBe('unknown');
  });
});

// P-009 (EI-24015486799447670): a content quarantine held 29 files for 18 ticks with nobody
// told. The author had ended, the one alarm went to that dead inbox, and it never re-alarmed.
describe('decideContentQuarantineNotice', () => {
  const alarmTicks = 5;
  const at = (contentTicks: number, prevContentTicks = contentTicks - 1) =>
    decideContentQuarantineNotice({ contentTicks, prevContentTicks, alarmTicks });

  it('tells the editor on the FIRST quarantined tick only', () => {
    expect(at(1, 0)).toBe('editor-first-tick');
    expect(at(2)).toBeNull();
    expect(at(4)).toBeNull();
  });

  it('alarms on the fixer-budget transition, once', () => {
    expect(at(5)).toBe('alarm');
    expect(at(6)).toBeNull();
  });

  it('re-alarms every CONTENT_QUARANTINE_REALARM_TICKS while the quarantine persists', () => {
    const every = CONTENT_QUARANTINE_REALARM_TICKS;
    // The 2026-09-23 incident reached tick 18; it must have re-alarmed at least once by then.
    expect(alarmTicks + every).toBeLessThanOrEqual(18);
    const fired = Array.from({ length: alarmTicks + 3 * every }, (_, k) => k + 1).filter((t) => at(t) === 'realarm');
    expect(fired).toEqual([alarmTicks + every, alarmTicks + 2 * every, alarmTicks + 3 * every]);
  });

  it('alarms (not first-tick) when the counter jumps straight past the budget', () => {
    expect(at(7, 0)).toBe('alarm');
  });

  it('is silent on a clean tick', () => {
    expect(at(0, 3)).toBeNull();
  });
});

describe('selectContentNoticeRecipients', () => {
  const states: Record<string, string | null> = { alive: 'live', parked: 'parked', gone: 'ended', rec: 'recorded' };
  const stateOf = (id: string) => states[id] ?? null;

  it('first-tick notice: attributed editors not known to be gone, never a broadcast', () => {
    expect(selectContentNoticeRecipients('editor-first-tick', ['alive', 'gone', 'rec', 'unknown'], stateOf)).toEqual([
      'alive',
      'unknown',
    ]);
    expect(selectContentNoticeRecipients('editor-first-tick', ['*'], stateOf)).toEqual([]);
    expect(selectContentNoticeRecipients('editor-first-tick', ['gone'], stateOf)).toEqual([]);
  });

  it('alarm to an ENDED-only editor set falls back to the broadcast (the 2026-09-23 silent case)', () => {
    expect(selectContentNoticeRecipients('alarm', ['gone'], stateOf)).toEqual(['*']);
    expect(selectContentNoticeRecipients('realarm', ['gone', 'unknown'], stateOf)).toEqual(['*']);
  });

  it('alarm goes to proven-reachable editors only, deduplicated', () => {
    expect(selectContentNoticeRecipients('alarm', ['alive', 'parked', 'gone', 'alive'], stateOf)).toEqual([
      'alive',
      'parked',
    ]);
  });

  it('unattributable alarm stays a broadcast (attribution flag off)', () => {
    expect(selectContentNoticeRecipients('alarm', ['*'], stateOf)).toEqual(['*']);
  });
});
