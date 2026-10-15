import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextGaugeAnnotator } from './context-gauge-annotator';
import * as ptyDiscovery from '../events/await/psu-pty-discovery';
import {
  recordContextUsage,
  resetContextUsageCacheForTests,
  setContextGaugeEnabled,
} from '../system-health/context-usage-cache';
import {
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
} from '../compaction-usage';

/** A superuser ctx resolves to ownerId === uiClientId (see coordination/identity.ts). */
const ctx = (ownerId: string) => ({ isSuperuser: true, uiClientId: ownerId }) as unknown;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const gaugeText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

/** WI-4154: the annotator's tokens now come from the transcript's current state
 *  (anchored sync read); the usage-cache entry supplies only the LIMIT. Give an
 *  owner a real temp transcript of `tokens*4` bytes + a cached limit. */
let dir: string;
let n = 0;
function trackOwner(
  ownerId: string,
  tokens: number,
  limit: number,
  observedPromptFloor?: { tokens: number; observations: number },
): void {
  const file = path.join(dir, `${++n}.jsonl`);
  const overhead = '{"t":""}\n'.length;
  fs.writeFileSync(file, `{"t":"${'x'.repeat(tokens * 4 - overhead)}"}\n`);
  if (!seedContextAnchorForTests(ownerId, file)) throw new Error('anchor seed failed');
  recordContextUsage(ownerId, tokens, limit, Date.now(), observedPromptFloor);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-annotator-'));
});

afterEach(() => {
  resetContextUsageCacheForTests();
  resetContextAnchorsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('contextGaugeAnnotator (P-013 wiring logic)', () => {
  it('appends a banded gauge when the owner is over the quiet band', () => {
    trackOwner('su-hot', 270_000, 300_000); // 90% → critical
    const out = contextGaugeAnnotator(ok('result body'), ctx('su-hot'));
    const texts = gaugeText(out);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('context: 270000/300000 (90%)');
    expect(texts[1]).toContain('CRITICAL');
    // The synchronous result-annotation seam does not probe for a live host;
    // precise host support is rendered by the async coord:inbox path.
    expect(texts[1]).not.toContain('request-compaction');
    expect(texts[1]).toContain("session's supported continuation path");
    expect((out._meta as Record<string, unknown>)?._contextGauge).toContain('90%');
  });

  it('does not synchronously probe psu-pty host availability on the result hot path', () => {
    trackOwner('su-no-host-probe', 270_000, 300_000);
    const availability = vi.spyOn(ptyDiscovery, 'selfCompactionAvailability');
    contextGaugeAnnotator(ok('result body'), ctx('su-no-host-probe'));
    expect(availability).not.toHaveBeenCalled();
  });

  // EI-23761864550626068: the gauge numerator is transcript bytes/4, so the rendered line
  // and the structured meta must both say it is an ESTIMATE rather than a measured count.
  it('qualifies a CRITICAL gauge as a bytes/4 estimate and attaches the evidence contract', () => {
    trackOwner('su-evidence', 270_000, 300_000); // 90% → critical
    const out = contextGaugeAnnotator(ok('result body'), ctx('su-evidence'));
    const texts = gaugeText(out);
    expect(texts[1]).toContain('estimate: transcript-bytes/4, not provider usage');
    expect(texts[1]).toContain('no provider-measured corroboration');
    const ev = (out._meta as Record<string, unknown>)?._contextGaugeEvidence as {
      exactness: string;
      method: string;
      denominator: { value: number; recordedAt: number | null; source: string };
      corroboratedByObservedFloor: boolean;
    };
    expect(ev.exactness).toBe('estimate');
    expect(ev.method).toBe('transcript-bytes/4');
    expect(ev.denominator.value).toBe(300_000);
    expect(ev.denominator.source).toBe('watchdog-cache(coord_presence.compaction_limit)');
    // The cache entry was recorded moments ago by trackOwner — calibration time must be real.
    expect(typeof ev.denominator.recordedAt).toBe('number');
    expect(Date.now() - (ev.denominator.recordedAt as number)).toBeLessThan(60_000);
    expect(ev.corroboratedByObservedFloor).toBe(false);
  });

  it('marks corroboration when the cache carries a provider-observed floor', () => {
    trackOwner('su-evidence-floor', 270_000, 300_000, { tokens: 120_000, observations: 4 });
    const out = contextGaugeAnnotator(ok('result body'), ctx('su-evidence-floor'));
    const ev = (out._meta as Record<string, unknown>)?._contextGaugeEvidence as {
      corroboratedByObservedFloor: boolean;
    };
    expect(ev.corroboratedByObservedFloor).toBe(true);
    expect(gaugeText(out)[1]).toContain('a provider-observed input floor is shown');
  });

  it('keeps the quiet band a bare fact (no qualifier cost) while still carrying the meta contract', () => {
    trackOwner('su-evidence-quiet', 210_000, 300_000); // 70% → quiet
    const out = contextGaugeAnnotator(ok('result body'), ctx('su-evidence-quiet'));
    const texts = gaugeText(out);
    expect(texts[1]).toBe('context: 210000/300000 (70%)');
    expect(texts[1]).not.toContain('estimate:');
    expect(
      ((out._meta as Record<string, unknown>)?._contextGaugeEvidence as { exactness: string }).exactness,
    ).toBe('estimate');
  });

  it('appends NOTHING below the quiet band (the common case)', () => {
    trackOwner('su-cool', 60_000, 300_000); // 20%
    const r = ok('body');
    const out = contextGaugeAnnotator(r, ctx('su-cool'));
    expect(out).toBe(r); // untouched reference
  });

  it('appends NOTHING for an owner the watchdog is not tracking (no cache entry)', () => {
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-unknown'))).toBe(r);
  });

  it('appends NOTHING for an unattributable ctx (resolveAgentIdentity throws)', () => {
    trackOwner('whatever', 270_000, 300_000);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, {})).toBe(r); // no identity fields → throws → swallowed
  });

  it('does NOT double-render when the result already carries a context line', () => {
    trackOwner('su-hot', 270_000, 300_000);
    // e.g. a coord:inbox result whose JSON already contains the usage line
    const r = ok('{"injection":"context: 270000/300000 (90%)\\n[coord+1]"}');
    expect(contextGaugeAnnotator(r, ctx('su-hot'))).toBe(r);
  });

  it('is suppressed when the gauge flag mirror is disabled', () => {
    trackOwner('su-hot', 270_000, 300_000);
    setContextGaugeEnabled(false);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-hot'))).toBe(r);
  });

  it('renders the quiet bare fact in 65–79%', () => {
    trackOwner('su-mid', 210_000, 300_000); // 70%
    const out = contextGaugeAnnotator(ok('body'), ctx('su-mid'));
    const texts = gaugeText(out);
    expect(texts[1]).toBe('context: 210000/300000 (70%)');
    expect(texts[1]).not.toContain('⚠');
  });

  it('renders conservative working-room evidence from the watchdog cache', () => {
    trackOwner('su-runway', 200_000, 250_000, { tokens: 167_686, observations: 3 });
    const out = contextGaugeAnnotator(ok('body'), ctx('su-runway'));
    const line = gaugeText(out)[1];
    expect(line).toContain('observed-input floor 167686 (3 samples)');
    expect(line).toContain('conservative usable runway 82314');
  });

  it('renders the CURRENT transcript state, not the cached tokens (WI-4154)', () => {
    // Cache says 90% (pre-compaction), but the live transcript is small — the
    // render must follow the transcript. This is the false-alarm regression test.
    trackOwner('su-boundary', 270_000, 300_000);
    const small = path.join(dir, 'post-compaction.jsonl');
    fs.writeFileSync(small, `{"t":"${'x'.repeat(40_000)}"}\n`);
    seedContextAnchorForTests('su-boundary', small); // transcript now reads ~10k tokens (3%)
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-boundary'))).toBe(r); // 3% → silent, no false alarm
  });

  it('renders NOTHING when no live read is possible (never a stale cached number)', () => {
    // Tracked (limit known) but no anchor and no resolvable transcript in tests:
    // the annotator must stay silent rather than render the cached 90%.
    recordContextUsage('su-blind', 270_000, 300_000);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-blind'))).toBe(r);
  });
});
