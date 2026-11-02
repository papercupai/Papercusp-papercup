/**
 * P-008 (b) — the pure half of dependency staleness
 * (unified-agent-state-plane-2026-07-27).
 *
 * Everything asserted here runs without PG, a cell registry, or a dispatcher.
 * That is the point: the three-valued verdict is only worth trusting if every
 * branch of it — including the two that must NOT collapse into each other
 * ("unchanged" vs "could not tell") — is directly exercisable.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  canonicalJson,
  digestCellValue,
  renderObservedValue,
  evaluateDependencyStaleness,
  observationKey,
  captureFactDependencies,
  type CurrentCellObservation,
} from './dependency-staleness';
import { FACT_DEPENDENCY_OBSERVED_CHARS, type FactDependency } from '../../agent-facts/store';

const readCellSpy = vi.hoisted(() => vi.fn());

vi.mock('../../cell-read', () => ({ readCell: readCellSpy }));

const dep = (over: Partial<FactDependency> = {}): FactDependency => ({
  cell: 'pipeline.myChange',
  observedAt: '2026-07-27T00:00:00.000Z',
  digest: digestCellValue('deployed'),
  observed: 'deployed',
  ...over,
});

const now = (entries: Record<string, CurrentCellObservation>) => new Map(Object.entries(entries));

describe('canonicalJson — order-independent for objects, order-SENSITIVE for arrays', () => {
  it('sorts object keys at every depth, so a resolver reordering its result is not a change', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('KEEPS array order — a reordered list is genuine new information', () => {
    // The distinction that matters: `{a,b}` and `{b,a}` are the same value;
    // `[a,b]` and `[b,a]` are not (think pipeline stages).
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('treats undefined-valued keys as absent, so an optional field appearing as undefined is not a change', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('does not throw on a cycle — this runs inside a fail-soft fold, far from its cause', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).not.toThrow();
  });

  it('normalizes non-finite numbers rather than emitting invalid JSON', () => {
    expect(canonicalJson({ n: NaN })).toBe(canonicalJson({ n: null }));
  });
});

describe('digestCellValue — the ONE comparison both halves share', () => {
  it('is stable across key order (the failure that would report everything stale forever)', () => {
    expect(digestCellValue({ x: 1, y: 2 })).toBe(digestCellValue({ y: 2, x: 1 }));
  });

  it('separates values that differ', () => {
    expect(digestCellValue('pushed')).not.toBe(digestCellValue('deployed'));
  });

  it('distinguishes null from the string "null" — a digest over prose would not', () => {
    expect(digestCellValue(null)).not.toBe(digestCellValue('null'));
  });
});

describe('renderObservedValue — a label, never the comparison input', () => {
  it('clips past the bound and marks the elision', () => {
    const rendered = renderObservedValue('x'.repeat(FACT_DEPENDENCY_OBSERVED_CHARS + 50));
    expect(rendered.length).toBe(FACT_DEPENDENCY_OBSERVED_CHARS);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('passes a short string through verbatim (no JSON quoting on the common case)', () => {
    expect(renderObservedValue('deployed')).toBe('deployed');
  });

  it('⚠ two DIFFERENT long values can render identically — which is why renderings are never compared', () => {
    const a = renderObservedValue(`${'x'.repeat(400)}A`);
    const b = renderObservedValue(`${'x'.repeat(400)}B`);
    expect(a).toBe(b);
    expect(digestCellValue(`${'x'.repeat(400)}A`)).not.toBe(digestCellValue(`${'x'.repeat(400)}B`));
  });
});

describe('evaluateDependencyStaleness', () => {
  it('returns null when nothing was declared — no field beats a "fresh" that was never checked', () => {
    expect(evaluateDependencyStaleness([], now({}))).toBeNull();
  });

  it('FRESH when the digest still matches', () => {
    const v = evaluateDependencyStaleness([dep()], now({ 'pipeline.myChange': { digest: digestCellValue('deployed') } }));
    expect(v?.status).toBe('fresh');
    expect(v?.changed).toEqual([]);
    expect(v?.note).toContain('✓');
  });

  it('STALE when the value moved, and the note names the cell, the old value and the new one', () => {
    const v = evaluateDependencyStaleness(
      [dep()],
      now({ 'pipeline.myChange': { digest: digestCellValue('pushed'), observed: 'pushed' } }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual(['pipeline.myChange']);
    expect(v?.deps[0].status).toBe('changed');
    // D-012: staleness stops being a judgement call — the verdict must SHOW its work.
    expect(v?.note).toContain('pipeline.myChange');
    expect(v?.note).toContain('deployed');
    expect(v?.note).toContain('pushed');
  });

  it('UNDETERMINABLE, never fresh, when the cell was unreadable at ASSERT time', () => {
    // No anchor was ever captured, so there is nothing to compare against —
    // even though the cell reads perfectly well right now.
    const v = evaluateDependencyStaleness(
      [dep({ digest: undefined, observed: undefined, unknown: 'not-measured' })],
      now({ 'pipeline.myChange': { digest: digestCellValue('deployed') } }),
    );
    expect(v?.status).toBe('undeterminable');
    expect(v?.undeterminable).toEqual(['pipeline.myChange']);
    expect(v?.deps[0].detail).toMatch(/never been verifiable/);
  });

  it('UNDETERMINABLE, never fresh, when the cell is unreadable NOW', () => {
    const v = evaluateDependencyStaleness([dep()], now({ 'pipeline.myChange': { unknown: 'resolver-failed' } }));
    expect(v?.status).toBe('undeterminable');
    expect(v?.deps[0].detail).toContain('resolver-failed');
  });

  it('UNDETERMINABLE when the cell is missing from the current map entirely', () => {
    const v = evaluateDependencyStaleness([dep()], now({}));
    expect(v?.status).toBe('undeterminable');
  });

  it('⚠ a CHANGED dependency wins over an undeterminable one — a real change is never masked', () => {
    // The precedence that matters: if any dependency demonstrably moved, the
    // fact is stale, however many others could not be checked. Reporting
    // `undeterminable` here would hide a verdict we actually have.
    const v = evaluateDependencyStaleness(
      [dep({ cell: 'a' }), dep({ cell: 'b' })],
      now({
        a: { digest: digestCellValue('moved'), observed: 'moved' },
        b: { unknown: 'not-measured' },
      }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual(['a']);
    expect(v?.undeterminable).toEqual(['b']);
  });

  it('undeterminable dependencies alone NEVER manufacture a stale verdict', () => {
    const v = evaluateDependencyStaleness([dep({ cell: 'a' })], now({ a: { unknown: 'not-measured' } }));
    expect(v?.status).toBe('undeterminable');
    expect(v?.changed).toEqual([]);
    // The note must not read as an all-clear: "not confirmed current" and
    // "known to be stale" are different, and a reader has to be told which.
    expect(v?.note).toMatch(/NOT confirmed current/);
  });

  it('every declared dependency gets a verdict row, whatever its outcome', () => {
    const v = evaluateDependencyStaleness(
      [dep({ cell: 'a' }), dep({ cell: 'b' }), dep({ cell: 'c' })],
      now({ a: { digest: digestCellValue('deployed') }, b: { digest: digestCellValue('other') } }),
    );
    expect(v?.deps.map((d) => `${d.cell}:${d.status}`)).toEqual(['a:fresh', 'b:changed', 'c:undeterminable']);
  });

  it('carries observedAt onto each verdict so a reader can see HOW OLD the anchor is', () => {
    const v = evaluateDependencyStaleness([dep()], now({}));
    expect(v?.deps[0].observedAt).toBe('2026-07-27T00:00:00.000Z');
  });
});

describe('captureFactDependencies — independent reads share the request budget', () => {
  it('starts every declared cell read before waiting for any one slow resolver', async () => {
    readCellSpy.mockReset();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    readCellSpy.mockImplementation(async (cell: string) => {
      started.push(cell);
      await gate;
      return { status: 'value', cell, value: cell } as never;
    });

    const pending = captureFactDependencies(['slow-a', 'slow-b'], {} as never, {} as never);
    try {
      // Allow lazy dispatcher initialization, but keep both resolvers blocked.
      // A serial implementation starts only slow-a until that gate opens.
      await vi.waitFor(() => expect(started).toEqual(['slow-a', 'slow-b']));
    } finally {
      release();
    }

    const dependencies = await pending;
    expect(dependencies.map((dependency) => dependency.cell)).toEqual(['slow-a', 'slow-b']);
    expect(dependencies.every((dependency) => dependency.digest)).toBe(true);
  });
});

describe('subject keying — a caller-relative cell is a different question per subject', () => {
  it('reads the observation under the (cell, subject) key, not the bare cell id', () => {
    const d = dep({ cell: 'git.pipelinePosition', subject: 'a.ts', digest: digestCellValue('deployed') });
    // Keyed by cell alone this would miss and report undeterminable.
    const v = evaluateDependencyStaleness(
      [d],
      now({ [observationKey('git.pipelinePosition', 'a.ts')]: { digest: digestCellValue('deployed') } }),
    );
    expect(v?.status).toBe('fresh');
    expect(v?.deps[0].subject).toBe('a.ts');
  });

  it('⚠ does NOT match another subject\'s reading — the wrong-answer case, not merely a weaker one', () => {
    // Two files both sitting perfectly still would otherwise report `changed`
    // against each other.
    const d = dep({ cell: 'git.pipelinePosition', subject: 'a.ts', digest: digestCellValue('deployed') });
    const v = evaluateDependencyStaleness(
      [d],
      now({ [observationKey('git.pipelinePosition', 'b.ts')]: { digest: digestCellValue('pushed') } }),
    );
    expect(v?.status).toBe('undeterminable');
    expect(v?.changed).toEqual([]);
  });

  it('keeps two subjects of the same cell independent', () => {
    const v = evaluateDependencyStaleness(
      [
        dep({ cell: 'c', subject: 'a.ts', digest: digestCellValue('deployed') }),
        dep({ cell: 'c', subject: 'b.ts', digest: digestCellValue('deployed') }),
      ],
      now({
        [observationKey('c', 'a.ts')]: { digest: digestCellValue('deployed') },
        [observationKey('c', 'b.ts')]: { digest: digestCellValue('moved'), observed: 'moved' },
      }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.deps.map((x) => x.status)).toEqual(['fresh', 'changed']);
  });

  it('observationKey keeps a subjectless cell as its bare id (no key churn for global cells)', () => {
    expect(observationKey('deploy.3070.sha')).toBe('deploy.3070.sha');
    expect(observationKey('c', 'x')).not.toBe(observationKey('c', 'y'));
  });

  it('an over-budget dependency reports undeterminable NAMING the budget, never fresh', () => {
    // "we ran out of read budget" and "nothing changed" are different facts and
    // only one is safe to act on — so the detail must not send a reader hunting
    // a resolver that is working fine.
    const v = evaluateDependencyStaleness([dep({ cell: 'z' })], now({ z: { unknown: 'read-budget-exceeded' } }));
    expect(v?.status).toBe('undeterminable');
    expect(v?.deps[0].detail).toContain('read-budget-exceeded');
  });
});

/**
 * P-021 — SURPRISAL-GATED PUSH: the materiality threshold in the fold.
 *
 * The subject throughout is the real registered case with its real measured
 * churn: `gate.greenCheckpoint.candidate` declares `changeInCandidate.judgingSha`
 * (which follows the staging tip — 335 commits/24h) while the question it exists
 * to answer is `changeInCandidate.judgingContainsPath` (which moves only when the
 * subject's own file lands).
 */
const CANDIDATE = 'gate.greenCheckpoint.candidate';
const MATERIAL_PATH = 'changeInCandidate.judgingContainsPath';
const SUBJECT = 'packages/operator-core/lib/cell-registry.ts';

/** A dependency filed while the gate judged `sha`, with the path contained or not. */
const candidateDep = (sha: string, contained: boolean): FactDependency => ({
  cell: CANDIDATE,
  subject: SUBJECT,
  observedAt: '2026-07-27T08:55:00.000Z',
  digest: digestCellValue(sha),
  observed: sha,
  materialDigest: digestCellValue(contained),
  material: String(contained),
  materialPath: MATERIAL_PATH,
});

/** What that cell resolves to now. */
const candidateNow = (sha: string, contained: boolean): CurrentCellObservation => ({
  digest: digestCellValue(sha),
  observed: sha,
  materialDigest: digestCellValue(contained),
  material: String(contained),
  materialPath: MATERIAL_PATH,
});

/** Strip the material anchor — a fact filed before P-021, i.e. today's behaviour. */
const unanchor = (d: FactDependency): FactDependency => {
  const c = { ...d };
  delete (c as { materialDigest?: string }).materialDigest;
  return c;
};

const keyed = (o: CurrentCellObservation) => now({ [observationKey(CANDIDATE, SUBJECT)]: o });

describe('P-021 materiality — a version bump is carried, not raised', () => {
  it('raw value moved but the material answer held ⇒ immaterial, and the fact is NOT stale', () => {
    const v = evaluateDependencyStaleness([candidateDep('4c871fdc', true)], keyed(candidateNow('a63daa83', true)));
    expect(v?.status).toBe('fresh');
    expect(v?.immaterial).toEqual([CANDIDATE]);
    expect(v?.changed).toEqual([]);
    expect(v?.deps[0].status).toBe('immaterial');
  });

  it('DROPS the intermediate raw values — that omission IS the deliverable', () => {
    // "agents learn of material changes WITHOUT RECEIVING EVERY INTERMEDIATE
    // VERSION". `was`/`now` ARE those versions, so an immaterial entry must not
    // carry them — and the key must be genuinely absent, not merely undefined.
    const entry = evaluateDependencyStaleness(
      [candidateDep('4c871fdc', true)],
      keyed(candidateNow('a63daa83', true)),
    )!.deps[0];
    expect(Object.prototype.hasOwnProperty.call(entry, 'was')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, 'now')).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('a63daa83');
    expect(JSON.stringify(entry)).not.toContain('4c871fdc');
  });

  it('keeps the suppression AUDITABLE, but in the MACHINE channel rather than the prose', () => {
    // A suppression a reader cannot check is a blind spot, not a threshold. But
    // the audit belongs where it is free: `immaterial[]` names what was
    // suppressed and each dep carries the material ANSWER, so a reader can check
    // it without EVERY reader paying a paragraph to be told.
    const v = evaluateDependencyStaleness([candidateDep('4c871fdc', true)], keyed(candidateNow('a63daa83', true)));
    expect(v?.immaterial).toEqual([CANDIDATE]);
    expect(v?.deps[0].material).toBe('true');
    // The note must stay SHORT and must NOT claim the cell stood still.
    expect(v?.note).not.toContain('still reads as it did');
    expect(v!.note.length).toBeLessThan(80);
  });

  it('does NOT copy the registry-constant materialPath onto every verdict row', () => {
    // Repeating a per-cell constant on every dep of every fact of every fold is
    // both the repetition this item removes and a transcription that rots when
    // the resolver's shape moves. The path lives on the spec.
    const entry = evaluateDependencyStaleness(
      [candidateDep('4c871fdc', true)],
      keyed(candidateNow('a63daa83', true)),
    )!.deps[0];
    expect(Object.prototype.hasOwnProperty.call(entry, 'materialPath')).toBe(false);
  });

  it('⚠ a RE-AIMED materiality path falls back to LOUD — it is a different question', () => {
    // Same rule as FactDependency.subject: a comparison that silently changes
    // the question does not give a weaker answer, it gives a wrong one.
    const filed = candidateDep('4c871fdc', true);
    const reAimed: CurrentCellObservation = {
      ...candidateNow('a63daa83', true),
      materialPath: 'changeInCandidate.nextContainsPath',
    };
    const v = evaluateDependencyStaleness([filed], keyed(reAimed));
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual([CANDIDATE]);
  });

  it('a MATERIAL change is still loud — containment flipping is the news', () => {
    const v = evaluateDependencyStaleness([candidateDep('4c871fdc', true)], keyed(candidateNow('a63daa83', false)));
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual([CANDIDATE]);
    expect(v?.immaterial).toEqual([]);
    expect(v?.note).toContain('STALE');
  });

  it('⚠ materiality can SUPPRESS a raw change but must never MASK a material one', () => {
    // The ordering guard. The two paths are SIBLINGS in one result and move
    // independently: the same candidate can be re-judged (judgingSha static)
    // while the subject's own file lands (judgingContainsPath flips). Comparing
    // materiality only *after* a raw-digest change would report this `fresh` —
    // a false all-clear on precisely the change the reader cares most about,
    // produced by the mechanism meant to protect them.
    const v = evaluateDependencyStaleness([candidateDep('4c871fdc', false)], keyed(candidateNow('4c871fdc', true)));
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual([CANDIDATE]);
  });

  it('an UNANCHORED dependency falls back to LOUD, never to "materially unchanged"', () => {
    // A fact filed before this field existed has no `materialDigest`. The safe
    // direction is today's behaviour; the opposite default would let a schema
    // gap silently certify a moved cell as unchanged.
    const v = evaluateDependencyStaleness([unanchor(candidateDep('4c871fdc', true))], keyed(candidateNow('a63daa83', true)));
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual([CANDIDATE]);
  });

  it('falls back to LOUD when the material path stops resolving NOW (registration drift)', () => {
    const nowNoMaterial: CurrentCellObservation = { digest: digestCellValue('a63daa83'), observed: 'a63daa83' };
    const v = evaluateDependencyStaleness([candidateDep('4c871fdc', true)], keyed(nowNoMaterial));
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual([CANDIDATE]);
  });

  it('a cell declaring NO materiality is completely unaffected (opt-in, not a behaviour change)', () => {
    const v = evaluateDependencyStaleness(
      [dep()],
      now({ 'pipeline.myChange': { digest: digestCellValue('serving'), observed: 'serving' } }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.immaterial).toEqual([]);
  });
});

/**
 * THE DONE-CONDITION MEASUREMENT.
 *
 * The item is done "when a high-churn cell can be registered such that agents
 * learn of material changes without receiving every intermediate version,
 * MEASURED AGAINST THE FOLD'S PAYLOAD SIZE". So the saving is asserted here as a
 * number, in the units the fold actually pays: serialized bytes.
 *
 * The BEFORE arm is not a mock of the old code — it is the SAME function over an
 * unanchored dependency, which is exactly how every fact behaved before this
 * change and how every pre-existing fact still behaves.
 */
describe('P-021 measurement — the fold payload a version bump costs', () => {
  const foldBytes = (deps: FactDependency[], o: CurrentCellObservation) =>
    JSON.stringify(evaluateDependencyStaleness(deps, keyed(o))).length;

  it('one version bump on one fact costs less than half of the ungated verdict', () => {
    const after = foldBytes([candidateDep('4c871fdc', true)], candidateNow('a63daa83', true));
    const before = foldBytes([unanchor(candidateDep('4c871fdc', true))], candidateNow('a63daa83', true));
    expect(after).toBeLessThan(before / 2);
    // eslint-disable-next-line no-console
    console.log(
      `[P-021] fold bytes, 1 fact: ungated ${before} → gated ${after} (${Math.round((1 - after / before) * 100)}% saved)`,
    );
  });

  it('the saving scales with the fold — the verdict is paid PER FACT, per orient', () => {
    // ⚠ MODEL THE FOLD THE WAY IT IS ACTUALLY BUILT. `markStaleDependencyFacts`
    // attaches a SEPARATE verdict — its own note and its own dep rows — to EVERY
    // fact that declared the dependency. So N facts resting on one churny cell is
    // N verdicts, not one verdict with N deps. (Getting this wrong understates
    // the saving badly: a single fact with 12 copies of one dependency amortises
    // the note across rows that `dedupeCells` would have collapsed anyway.)
    const o = candidateNow('a63daa83', true);
    const facts = 12;
    const after = Array.from({ length: facts }, () => foldBytes([candidateDep('4c871fdc', true)], o)).reduce((a, b) => a + b, 0);
    const before = Array.from({ length: facts }, () => foldBytes([unanchor(candidateDep('4c871fdc', true))], o)).reduce((a, b) => a + b, 0);
    expect(after).toBeLessThan(before / 2);
    // eslint-disable-next-line no-console
    console.log(
      `[P-021] fold bytes, ${facts} facts on one high-churn cell: ungated ${before} → gated ${after} ` +
        `(${before - after} bytes saved per orient, per agent)`,
    );
  });
});
