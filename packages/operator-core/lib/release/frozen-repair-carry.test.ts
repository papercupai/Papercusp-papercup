import { describe, expect, it } from 'vitest';
import type { FrozenCandidateRepairQueue, FrozenRepairAdmission } from './frozen-candidate-repair-queue';
import {
  FROZEN_REPAIR_CARRY_PATH_CAP,
  assessFrozenRepairCarryAtCut,
  buildFrozenRepairCarryRecord,
  buildFrozenRepairPendingCarry,
  frozenRepairCarrySummary,
  nextFrozenRepairPendingCarry,
  parseFrozenRepairCarryRecord,
  parseFrozenRepairPendingCarry,
  type FrozenRepairCarryBlobLookup,
  type FrozenRepairPendingCarry,
} from './frozen-repair-carry';

const NOW = 1_800_000_000_000;
const RETIRED = 'c'.repeat(40);
const RETIRED_HEAD = 'd'.repeat(40);
const QUIET_CUT = 'a'.repeat(40);
const TIP = 'b'.repeat(40);

function admission(paths: string[], blobs: Record<string, string | null>, extra: Partial<FrozenRepairAdmission> = {}): FrozenRepairAdmission {
  return {
    atMs: NOW - 1_000,
    actor: 'su-test',
    source: { ref: 'staging', sha: 'f'.repeat(40) },
    fromRepairHead: RETIRED,
    toRepairHead: RETIRED_HEAD,
    paths,
    unchanged: [],
    blobs,
    ...extra,
  };
}

function queue(admissions: FrozenRepairAdmission[]): Pick<FrozenCandidateRepairQueue, 'candidate' | 'repairHead' | 'admissions'> {
  return { candidate: RETIRED, repairHead: RETIRED_HEAD, admissions };
}

/** Blob table keyed `${sha}:${path}`; a missing key is an absent path, `'THROW'` a failed lookup. */
function lookup(table: Record<string, string | null | 'THROW'>): FrozenRepairCarryBlobLookup {
  return async (sha, path) => {
    const value = table[`${sha}:${path}`];
    if (value === 'THROW') throw new Error(`git cat-file failed for ${sha}:${path}`);
    return value ?? null;
  };
}

describe('P-010 pending carry (written by every retire)', () => {
  it('records each admitted path with the content of its NEWEST admission, sorted', () => {
    const pending = buildFrozenRepairPendingCarry(
      queue([
        admission(['b.ts', 'a.ts'], { 'b.ts': 'b1', 'a.ts': 'a1' }),
        admission(['a.ts', 'gone.ts'], { 'a.ts': 'a2', 'gone.ts': null }),
      ]),
      'owner-retire',
      NOW,
    );
    expect(pending).toEqual({
      schemaVersion: 1,
      fromCandidate: RETIRED,
      fromRepairHead: RETIRED_HEAD,
      reason: 'owner-retire',
      retiredAtMs: NOW,
      admitted: [
        { path: 'a.ts', blob: 'a2' },
        { path: 'b.ts', blob: 'b1' },
        { path: 'gone.ts', blob: null },
      ],
      truncated: false,
    });
  });

  it('is null for a queue that admitted nothing — an unstarted queue has no fixes to carry', () => {
    expect(buildFrozenRepairPendingCarry(queue([]), 'bounded-life', NOW)).toBeNull();
    expect(buildFrozenRepairPendingCarry({ candidate: RETIRED, repairHead: RETIRED_HEAD }, 'bounded-life', NOW)).toBeNull();
  });

  it('caps the carried paths and says so', () => {
    const paths = Array.from({ length: FROZEN_REPAIR_CARRY_PATH_CAP + 3 }, (_, i) => `p${String(i).padStart(4, '0')}.ts`);
    const pending = buildFrozenRepairPendingCarry(
      queue([admission(paths, Object.fromEntries(paths.map((p) => [p, `blob-${p}`])))]),
      'bounded-life',
      NOW,
    )!;
    expect(pending.admitted).toHaveLength(FROZEN_REPAIR_CARRY_PATH_CAP);
    expect(pending.truncated).toBe(true);
  });

  it('survives a restart: the stored JSON parses back to the identical record', () => {
    const pending = buildFrozenRepairPendingCarry(
      queue([admission(['a.ts', 'gone.ts'], { 'a.ts': 'a1', 'gone.ts': null })]),
      'bounded-life',
      NOW,
    )!;
    expect(parseFrozenRepairPendingCarry(JSON.parse(JSON.stringify(pending)))).toEqual(pending);
  });

  it('refuses a malformed stored record instead of half-reading it', () => {
    const good = buildFrozenRepairPendingCarry(queue([admission(['a.ts'], { 'a.ts': 'a1' })]), 'owner-retire', NOW)!;
    expect(parseFrozenRepairPendingCarry(null)).toBeNull();
    expect(parseFrozenRepairPendingCarry({ ...good, schemaVersion: 2 })).toBeNull();
    expect(parseFrozenRepairPendingCarry({ ...good, reason: 'whim' })).toBeNull();
    expect(parseFrozenRepairPendingCarry({ ...good, fromCandidate: '' })).toBeNull();
    expect(parseFrozenRepairPendingCarry({ ...good, admitted: [{ path: 'a.ts', blob: 7 }] })).toBeNull();
  });
});

describe('P-010 carry assessment at the next cut', () => {
  const pending: FrozenRepairPendingCarry = {
    schemaVersion: 1,
    fromCandidate: RETIRED,
    fromRepairHead: RETIRED_HEAD,
    reason: 'owner-retire',
    retiredAtMs: NOW,
    admitted: [
      { path: 'exact.ts', blob: 'fix-exact' },
      { path: 'hunk.ts', blob: 'synth-hunk' },
      { path: 'late.ts', blob: 'fix-late' },
      { path: 'gone.ts', blob: null },
    ],
    truncated: false,
  };

  it('a quiet cut that predates a just-admitted fix is MISSING it, and the gate must judge the tip', async () => {
    const blobAt = lookup({
      [`${QUIET_CUT}:exact.ts`]: 'fix-exact',
      // hunk-exact: the admitted blob was synthesized; staging holds the fix plus other work.
      [`${QUIET_CUT}:hunk.ts`]: 'staging-hunk-v2',
      [`${TIP}:hunk.ts`]: 'staging-hunk-v2',
      // committed + admitted inside the quiet window: the quiet cut still holds the OLD content.
      [`${QUIET_CUT}:late.ts`]: 'pre-fix',
      [`${TIP}:late.ts`]: 'fix-late',
      [`${TIP}:exact.ts`]: 'fix-exact',
    });
    const initial = await assessFrozenRepairCarryAtCut({ pending, candidate: QUIET_CUT, stagingTip: TIP, blobAt });
    expect(initial.entries).toEqual([
      { path: 'exact.ts', status: 'carried' },
      { path: 'hunk.ts', status: 'carried-via-staging' },
      { path: 'late.ts', status: 'missing' },
      { path: 'gone.ts', status: 'carried' },
    ]);
    expect(initial.missing).toEqual(['late.ts']);
    expect(initial.advanceToTip).toBe(true);

    // At the tip every admitted fix is carried — the bar: the re-cut candidate receives them all.
    const judged = await assessFrozenRepairCarryAtCut({ pending, candidate: TIP, stagingTip: TIP, blobAt });
    expect(judged.missing).toEqual([]);
    expect(judged.unverified).toEqual([]);
    expect(judged.advanceToTip).toBe(false);
    expect(judged.entries.map((entry) => entry.status)).toEqual(['carried', 'carried-via-staging', 'carried', 'carried']);
  });

  it('a cut that already carries every fix keeps the quiet cut', async () => {
    const blobAt = lookup({
      [`${QUIET_CUT}:exact.ts`]: 'fix-exact',
      [`${QUIET_CUT}:hunk.ts`]: 'synth-hunk',
      [`${QUIET_CUT}:late.ts`]: 'fix-late',
    });
    const assessment = await assessFrozenRepairCarryAtCut({ pending, candidate: QUIET_CUT, stagingTip: TIP, blobAt });
    expect(assessment.missing).toEqual([]);
    expect(assessment.advanceToTip).toBe(false);
  });

  it('a fix staging has since reverted is not still-relevant: the tip version is what carries', async () => {
    const blobAt = lookup({ [`${TIP}:late.ts`]: 'reverted', [`${TIP}:exact.ts`]: 'fix-exact', [`${TIP}:hunk.ts`]: 'x' });
    const assessment = await assessFrozenRepairCarryAtCut({ pending, candidate: TIP, stagingTip: TIP, blobAt });
    expect(assessment.entries.find((entry) => entry.path === 'late.ts')).toEqual({ path: 'late.ts', status: 'carried-via-staging' });
    expect(assessment.advanceToTip).toBe(false);
  });

  it('a failed lookup is UNVERIFIED, never carried, and fails closed toward the tip', async () => {
    const blobAt = lookup({
      [`${QUIET_CUT}:exact.ts`]: 'THROW',
      [`${QUIET_CUT}:hunk.ts`]: 'synth-hunk',
      [`${QUIET_CUT}:late.ts`]: 'fix-late',
    });
    const assessment = await assessFrozenRepairCarryAtCut({ pending, candidate: QUIET_CUT, stagingTip: TIP, blobAt });
    expect(assessment.unverified).toEqual(['exact.ts']);
    expect(assessment.advanceToTip).toBe(true);
  });

  it('never asks to advance when the candidate already IS the tip', async () => {
    const blobAt = lookup({ [`${TIP}:exact.ts`]: 'THROW' });
    const assessment = await assessFrozenRepairCarryAtCut({ pending, candidate: TIP, stagingTip: TIP, blobAt });
    expect(assessment.unverified).toEqual(['exact.ts']);
    expect(assessment.advanceToTip).toBe(false);
  });

  it('a legacy admission without a recorded blob is compared with the retired repair head', async () => {
    const legacy: FrozenRepairPendingCarry = { ...pending, admitted: [{ path: 'old.ts', blob: undefined }] };
    const blobAt = lookup({ [`${RETIRED_HEAD}:old.ts`]: 'fix-old', [`${QUIET_CUT}:old.ts`]: 'fix-old' });
    const carried = await assessFrozenRepairCarryAtCut({ pending: legacy, candidate: QUIET_CUT, stagingTip: TIP, blobAt });
    expect(carried.entries).toEqual([{ path: 'old.ts', status: 'carried' }]);
    const missing = await assessFrozenRepairCarryAtCut({
      pending: legacy,
      candidate: QUIET_CUT,
      stagingTip: TIP,
      blobAt: lookup({ [`${RETIRED_HEAD}:old.ts`]: 'fix-old', [`${QUIET_CUT}:old.ts`]: 'pre', [`${TIP}:old.ts`]: 'fix-old' }),
    });
    expect(missing.missing).toEqual(['old.ts']);
  });
});

describe('P-010 carry record (what the gate records when it consumes the carry)', () => {
  it('records the quiet cut, what it lacked, the judged candidate and every path status', async () => {
    const pending = buildFrozenRepairPendingCarry(
      queue([admission(['late.ts', 'ok.ts'], { 'late.ts': 'fix-late', 'ok.ts': 'fix-ok' })]),
      'bounded-life',
      NOW - 60_000,
    )!;
    const blobAt = lookup({
      [`${QUIET_CUT}:late.ts`]: 'pre-fix',
      [`${QUIET_CUT}:ok.ts`]: 'fix-ok',
      [`${TIP}:late.ts`]: 'fix-late',
      [`${TIP}:ok.ts`]: 'fix-ok',
    });
    const initial = await assessFrozenRepairCarryAtCut({ pending, candidate: QUIET_CUT, stagingTip: TIP, blobAt });
    const judged = await assessFrozenRepairCarryAtCut({ pending, candidate: TIP, stagingTip: TIP, blobAt });
    const record = buildFrozenRepairCarryRecord({ pending, initial, judged, nowMs: NOW });
    expect(record).toMatchObject({
      fromCandidate: RETIRED,
      reason: 'bounded-life',
      initialCandidate: QUIET_CUT,
      initialMissing: ['late.ts'],
      judgedCandidate: TIP,
      advancedToTip: true,
      entries: [
        { path: 'late.ts', status: 'carried' },
        { path: 'ok.ts', status: 'carried' },
      ],
    });
    expect(parseFrozenRepairCarryRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(frozenRepairCarrySummary(record)).toContain('lacked 1 fix(es), judging the staging tip instead');
    expect(parseFrozenRepairCarryRecord({ ...record, entries: [{ path: 'x', status: 'teleported' }] })).toBeNull();
  });
});

describe('P-010 next pending carry (a retire never overwrites an unconsumed carry)', () => {
  const NEWER = 'e'.repeat(40);
  const NEWER_HEAD = '9'.repeat(40);
  const prior: FrozenRepairPendingCarry = {
    schemaVersion: 1,
    fromCandidate: RETIRED,
    fromRepairHead: RETIRED_HEAD,
    reason: 'owner-retire',
    retiredAtMs: NOW - 60_000,
    admitted: [
      { path: 'a.ts', blob: 'a-old' },
      { path: 'only-prior.ts', blob: 'p1' },
    ],
    truncated: false,
  };
  const newer = (admissions: FrozenRepairAdmission[]) => ({ candidate: NEWER, repairHead: NEWER_HEAD, admissions });

  it('with no stored carry it is exactly the retired queue\'s own carry (or null when nothing was admitted)', () => {
    const q = queue([admission(['a.ts'], { 'a.ts': 'a1' })]);
    expect(nextFrozenRepairPendingCarry(undefined, q, 'bounded-life', NOW)).toEqual(
      buildFrozenRepairPendingCarry(q, 'bounded-life', NOW),
    );
    expect(nextFrozenRepairPendingCarry(null, queue([]), 'bounded-life', NOW)).toBeNull();
    // A malformed stored value carries nothing forward; it is not a reason to drop this retire's fixes.
    expect(nextFrozenRepairPendingCarry({ schemaVersion: 7 }, q, 'owner-retire', NOW)?.admitted).toEqual([
      { path: 'a.ts', blob: 'a1' },
    ]);
  });

  it('unions an unconsumed carry with the newer retire: newer header, newer content on a shared path', () => {
    const next = nextFrozenRepairPendingCarry(
      JSON.parse(JSON.stringify(prior)),
      newer([admission(['a.ts', 'b.ts'], { 'a.ts': 'a-new', 'b.ts': 'b1' })]),
      'bounded-life',
      NOW,
    );
    expect(next).toEqual({
      schemaVersion: 1,
      fromCandidate: NEWER,
      fromRepairHead: NEWER_HEAD,
      reason: 'bounded-life',
      retiredAtMs: NOW,
      admitted: [
        { path: 'a.ts', blob: 'a-new' },
        { path: 'b.ts', blob: 'b1' },
        { path: 'only-prior.ts', blob: 'p1' },
      ],
      truncated: false,
    });
  });

  it('keeps an unconsumed carry when the newer retired queue admitted nothing', () => {
    const next = nextFrozenRepairPendingCarry(prior, newer([]), 'owner-retire', NOW);
    expect(next?.admitted).toEqual(prior.admitted);
    expect(next?.fromCandidate).toBe(NEWER);
  });

  it('caps the union and says so', () => {
    const many = Array.from({ length: FROZEN_REPAIR_CARRY_PATH_CAP }, (_, i) => `f${String(i).padStart(4, '0')}.ts`);
    const blobs = Object.fromEntries(many.map((path) => [path, 'x']));
    const next = nextFrozenRepairPendingCarry(prior, newer([admission(many, blobs)]), 'bounded-life', NOW);
    expect(next?.admitted).toHaveLength(FROZEN_REPAIR_CARRY_PATH_CAP);
    expect(next?.truncated).toBe(true);
  });
});
