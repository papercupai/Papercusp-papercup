/**
 * generation-watermark.test.ts — the pure parser + ref vocabulary behind the
 * 'bg-host-restart' generation watermark (rubric-system-hardening-2026-07-14 P-002,
 * EI-12148). The IO edge (one systemctl exec) is deliberately thin and not exercised
 * here; every parsing/vocabulary decision is.
 */
import { describe, expect, it } from 'vitest';

import {
  BG_HOST_RESTART_WATERMARK,
  BG_HOST_UNIT,
  KNOWN_WATERMARK_REFS,
  assessHostStaleness,
  compareGenerationFreshness,
  parseSystemdTimestamp,
  resolveStagingHeadAsOf,
  resolveWatermarkRef,
} from './generation-watermark';

describe('parseSystemdTimestamp', () => {
  it('resolves the generation boundary against the canonical bg-host unit', () => {
    expect(BG_HOST_UNIT).toBe('papercusp-bg-host.service');
  });

  it('parses the TZ=UTC systemd form (the path the exec pins with TZ=UTC)', () => {
    expect(parseSystemdTimestamp('Tue 2026-07-14 18:08:24 UTC')).toBe(Date.parse('2026-07-14T18:08:24Z'));
  });

  it('parses without the day-of-week prefix and with GMT', () => {
    expect(parseSystemdTimestamp('2026-07-14 18:08:24 GMT')).toBe(Date.parse('2026-07-14T18:08:24Z'));
  });

  it('an inactive/never-started unit ("" / n/a) is null — no watermark, never epoch 0', () => {
    expect(parseSystemdTimestamp('')).toBeNull();
    expect(parseSystemdTimestamp('n/a')).toBeNull();
    expect(parseSystemdTimestamp('  \n')).toBeNull();
    expect(parseSystemdTimestamp(null)).toBeNull();
    expect(parseSystemdTimestamp(undefined)).toBeNull();
  });

  it('garbage is null, never NaN or a throw', () => {
    expect(parseSystemdTimestamp('ActiveEnterTimestamp=')).toBeNull();
    expect(parseSystemdTimestamp('not a date')).toBeNull();
  });

  it('a NON-UTC zone token still resolves via the lenient fallback (V8 US zone abbrevs)', () => {
    // The exec always sets TZ=UTC so this is defense, not the normal path: the value must
    // parse to the same instant, not be misread as UTC wall-clock.
    const parsed = parseSystemdTimestamp('Tue 2026-07-14 14:08:24 EDT');
    expect(parsed).toBe(Date.parse('2026-07-14T18:08:24Z'));
  });
});

describe('assessHostStaleness — classify only measured generation comparisons', () => {
  it('returns unknown when either comparison input is unavailable', () => {
    expect(assessHostStaleness('abc1234', null)).toBeNull();
    expect(assessHostStaleness(null, 'abc1234')).toBeNull();
    expect(assessHostStaleness('  ', 'abc1234')).toBeNull();
  });

  it('returns fresh or stale only when both SHAs resolve', () => {
    expect(assessHostStaleness('abc1234', 'ABC1234abcdef')).toBe(false);
    expect(assessHostStaleness('abc1234', 'def5678')).toBe(true);
  });
});

describe('readRunningGeneration — the stampable generation identity (EI-12147, reworked WI-5397)', () => {
  it('returns string-or-null identity legs and a boolean-or-null staleHost, never throwing', async () => {
    const { readRunningGeneration } = await import('./generation-watermark');
    const gen = await readRunningGeneration();
    expect(gen.deployedSha === null || typeof gen.deployedSha === 'string').toBe(true);
    // On a systemd box with the bg-host running this is its start ISO; elsewhere null.
    expect(gen.hostStartedAt === null || !Number.isNaN(Date.parse(gen.hostStartedAt!))).toBe(true);
    expect(gen.bootHeadSha === null || typeof gen.bootHeadSha === 'string').toBe(true);
    expect(gen.scoutCodeHash === null || typeof gen.scoutCodeHash === 'string').toBe(true);
    expect(gen.staleHost === null || typeof gen.staleHost === 'boolean').toBe(true);
  });

  it('reports unknown when either SHA is unresolved instead of claiming the host is stale', async () => {
    const { readRunningGeneration } = await import('./generation-watermark');
    const gen = await readRunningGeneration();
    if (gen.bootHeadSha === null || gen.deployedSha === null) {
      expect(gen.staleHost).toBeNull();
    }
  });
});

describe('readScoutGenerationCodeHash — the LEDGER-stamped scout identity (WI-5397 doc/impl divergence fix)', () => {
  it("reports the hash bg-host stamped on the tick ledger, floored at the generation boundary — never this process's own module hash", async () => {
    const { readScoutGenerationCodeHash } = await import('./generation-watermark');
    const calls: Array<{ sinceMs: number }> = [];
    const hash = await readScoutGenerationCodeHash(1_785_077_592_000, {
      readNewestScoutCodeHash: async (opts) => {
        calls.push(opts);
        return 'b01b01128a38273c';
      },
    });
    expect(hash).toBe('b01b01128a38273c');
    // The floor must be the generation boundary, so a stamp the PREVIOUS generation
    // wrote can never be attributed to the running one (WI-5451 intersect semantics).
    expect(calls).toEqual([{ sinceMs: 1_785_077_592_000 }]);
  });

  it('a null boundary (hostStartedAt unresolvable) is null WITHOUT touching the ledger — no instant to attribute a stamp to', async () => {
    const { readScoutGenerationCodeHash } = await import('./generation-watermark');
    let touched = false;
    const hash = await readScoutGenerationCodeHash(null, {
      readNewestScoutCodeHash: async () => {
        touched = true;
        return 'never';
      },
    });
    expect(hash).toBeNull();
    expect(touched).toBe(false);
  });

  it('a ledger read failure degrades to null, never throws — best-effort like every other leg', async () => {
    const { readScoutGenerationCodeHash } = await import('./generation-watermark');
    const hash = await readScoutGenerationCodeHash(1, {
      readNewestScoutCodeHash: async () => {
        throw new Error('pg unreachable');
      },
    });
    expect(hash).toBeNull();
  });
});

describe('resolveStagingHeadAsOf — retroactive git-history reconstruction of a boot-time HEAD', () => {
  it('resolves a 40-char sha for a timestamp within this repo\'s own history', async () => {
    const sha = await resolveStagingHeadAsOf(new Date().toISOString());
    // best-effort: null is acceptable (no git / not a repo in some sandboxes), but if it
    // resolves it must be a well-formed sha, never garbage.
    expect(sha === null || /^[0-9a-f]{7,40}$/i.test(sha!)).toBe(true);
  });

  it('degrades to null rather than throwing on a bogus cwd', async () => {
    const sha = await resolveStagingHeadAsOf(new Date().toISOString(), { cwd: '/nonexistent-dir-xyz' });
    expect(sha).toBeNull();
  });
});

describe('resolveWatermarkRef — the ref vocabulary', () => {
  it("an unknown ref is a TEACHING error naming the vocabulary — a typo must not judge some other window", async () => {
    const r = await resolveWatermarkRef('bg-host-restrat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(BG_HOST_RESTART_WATERMARK);
  });

  it('the known-refs vocabulary carries bg-host-restart', () => {
    expect(KNOWN_WATERMARK_REFS).toContain(BG_HOST_RESTART_WATERMARK);
  });
});

/**
 * WI-5277 — "has the generation this evidence graded ENDED?", which is a question no
 * STORED field can answer (it needs the live boundary at read time). Every ambiguous case
 * must resolve to `unknown`, never to `fresh`: a false `fresh` is what lets a GO be
 * assembled from dead evidence, which is the whole failure this exists to stop.
 */
describe('compareGenerationFreshness — is a stamped generation still the live one?', () => {
  const GRADED = '2026-07-17T14:39:17.000Z';
  const AFTER_RESTART = '2026-07-17T17:25:32.000Z';

  it('FRESH only when the two boundaries match exactly', () => {
    const r = compareGenerationFreshness(GRADED, Date.parse(GRADED));
    expect(r.status).toBe('fresh');
  });

  it('STALE when the live boundary is later — the generation ended (the 2026-07-17 case)', () => {
    const r = compareGenerationFreshness(GRADED, Date.parse(AFTER_RESTART));
    expect(r.status).toBe('stale');
    if (r.status === 'stale') {
      expect(r.gradedHostStartedAt).toBe(GRADED);
      expect(r.liveHostStartedAt).toBe(AFTER_RESTART);
      expect(r.reason).toMatch(/no longer exists/);
    }
  });

  it('UNKNOWN, never fresh, when the evidence carries no boundary (a pre-stamp row)', () => {
    for (const absent of [null, undefined, '', '   ']) {
      expect(compareGenerationFreshness(absent, Date.parse(GRADED)).status).toBe('unknown');
    }
  });

  it('UNKNOWN, never fresh, when the LIVE boundary is unreadable', () => {
    const r = compareGenerationFreshness(GRADED, null);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') expect(r.reason).toMatch(/unreadable/);
  });

  it('UNKNOWN on an unparseable stamp rather than throwing', () => {
    expect(compareGenerationFreshness('not-a-timestamp', Date.parse(GRADED)).status).toBe('unknown');
  });

  it('UNKNOWN — never FRESH — when the stamp is NEWER than the live boundary (skew / foreign host)', () => {
    // The tempting shortcut is `live > graded ? stale : fresh`, which reports a
    // backwards-skewed stamp as FRESH. It is not fresh; it is unexplained.
    const r = compareGenerationFreshness(AFTER_RESTART, Date.parse(GRADED));
    expect(r.status).toBe('unknown');
  });

  it('CONTROL — a stamp-time `staleHost:false` cannot substitute for this verdict', () => {
    // The field that hid this bug for a year: `staleHost` is frozen at stamp time and
    // says the scout was provably running the graded code THEN. A row can be
    // staleHost:false and still be judging a generation that has since ended — so a
    // reader consulting staleHost alone gets a confident, wrong all-clear. This asserts
    // the two properties genuinely diverge on the same input.
    const stampSaidFreshWhenGraded = { hostStartedAt: GRADED, staleHost: false } as const;
    expect(stampSaidFreshWhenGraded.staleHost).toBe(false);
    expect(compareGenerationFreshness(stampSaidFreshWhenGraded.hostStartedAt, Date.parse(AFTER_RESTART)).status).toBe(
      'stale',
    );
  });
});
