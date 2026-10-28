import { describe, expect, it } from 'vitest';
import {
  STRAGGLER_EXCLUDED_REF, STRAGGLER_ITEMS, STRAGGLER_SUBJECT_PLAN, dropNote, nowSection, parseDisposition,
  scoreStragglerDispositions, stragglerRescoreVerdict, summarizeStragglerScore, type RefTarget, type StragglerSnapshot,
} from './straggler-dispositions';

describe('stragglerRescoreVerdict', () => {
  it('maps rubric verdicts onto the rescore ledger shape', () => {
    expect(stragglerRescoreVerdict('healthy')).toBe('pass');
    expect(stragglerRescoreVerdict('broken')).toBe('fail');
    expect(stragglerRescoreVerdict('unknown')).toBe('unknown');
  });
});

const NATIVE_P026 = 'native-code-intelligence-ecosystem-and-dream-2026-10-09#P-026';
const OTHER = 'some-successor-plan-2026-11-01';

function slugOf(ref: string): string { return ref.includes('#') ? ref.slice(0, ref.indexOf('#')) : ref; }

/** Every straggler done, every source readable; override per test. */
function snap(overrides: Record<string, RefTarget | undefined> = {}, opts: { nowText?: string | null; unread?: string[] } = {}): StragglerSnapshot {
  const targets = new Map<string, RefTarget>();
  for (const ref of STRAGGLER_ITEMS) targets.set(ref, { status: 'done', text: 'shipped' });
  for (const [ref, t] of Object.entries(overrides)) { if (t) targets.set(ref, t); else targets.delete(ref); }
  const queried = new Set<string>([...STRAGGLER_ITEMS.map(slugOf), STRAGGLER_SUBJECT_PLAN, OTHER, 'WI-1', 'WI-2']);
  for (const k of opts.unread ?? []) queried.delete(k);
  return { targets, queried, nowText: opts.nowText === undefined ? 'state' : opts.nowText };
}

const dropped = (note: string): RefTarget => ({ status: 'dropped', text: `Evaluate something. — note: ${note}` });

describe('STRAGGLER_ITEMS', () => {
  it('is exactly the 11 R-11 refs and excludes the held semantic-index item by name', () => {
    expect(STRAGGLER_ITEMS).toHaveLength(11);
    expect(new Set(STRAGGLER_ITEMS).size).toBe(11);
    expect(STRAGGLER_ITEMS).not.toContain(STRAGGLER_EXCLUDED_REF);
    expect(STRAGGLER_ITEMS).toContain('gitnexus-selective-hardening-and-comparison-2026-09-13#P-009');
    expect(STRAGGLER_ITEMS).toContain('native-code-intelligence-optional-evaluations-2026-10-15#P-005');
  });
});

describe('dropNote / parseDisposition', () => {
  it('extracts the note suffix and returns null when there is none', () => {
    expect(dropNote('Do X. — note: superseded-by WI-1')).toBe('superseded-by WI-1');
    expect(dropNote('Do X.')).toBeNull();
  });

  it('accepts each class with valid evidence', () => {
    expect(parseDisposition('superseded-by WI-1.')).toEqual({ ok: true, cls: 'superseded-by', ref: 'WI-1' });
    expect(parseDisposition(`obligations-moved-to ${OTHER}#P-003`)).toEqual({ ok: true, cls: 'obligations-moved-to', ref: `${OTHER}#P-003` });
    expect(parseDisposition('abandoned: no consumer exists for this view.')).toEqual({ ok: true, cls: 'abandoned', reason: 'no consumer exists for this view.' });
  });

  it('refuses a missing note, no class, two classes, a bad ref, a missing ref and a long abandon reason', () => {
    expect(parseDisposition(null).ok).toBe(false);
    expect(parseDisposition('not needed any more').ok).toBe(false);
    expect(parseDisposition('superseded-by WI-1 and abandoned: dup').ok).toBe(false);
    expect(parseDisposition('superseded-by the-new-thing').ok).toBe(false);
    expect(parseDisposition('superseded-by').ok).toBe(false);
    expect(parseDisposition('abandoned:').ok).toBe(false);
    expect(parseDisposition('abandoned: one. two.').ok).toBe(false);
  });
});

describe('scoreStragglerDispositions', () => {
  it('passes when every straggler is done', () => {
    const s = scoreStragglerDispositions(snap());
    expect(s.verdict).toBe('healthy');
    expect(s.disposed).toBe(11);
  });

  it('fails a straggler that is still todo, wip, blocked or needs-human', () => {
    for (const status of ['todo', 'wip', 'blocked', 'needs-human']) {
      const s = scoreStragglerDispositions(snap({ [NATIVE_P026]: { status, text: 'x' } }));
      expect(s.verdict).toBe('broken');
      expect(s.findings.find(f => f.ref === NATIVE_P026)?.problem).toBe(`still ${status}`);
    }
  });

  it('fails a drop with no disposition class', () => {
    expect(scoreStragglerDispositions(snap({ [NATIVE_P026]: dropped('no longer needed') })).verdict).toBe('broken');
  });

  it('passes a superseded-by ref that resolves, is live and names the source; fails each broken variant', () => {
    const good = snap({ [NATIVE_P026]: dropped('superseded-by WI-1'), 'WI-1': { status: 'open', text: `carries ${NATIVE_P026}` } });
    expect(scoreStragglerDispositions(good).verdict).toBe('healthy');

    const missing = scoreStragglerDispositions(snap({ [NATIVE_P026]: dropped('superseded-by WI-1') }));
    expect(missing.findings.find(f => f.ref === NATIVE_P026)?.problem).toMatch(/does not resolve/);

    const unnamed = scoreStragglerDispositions(snap({ [NATIVE_P026]: dropped('superseded-by WI-1'), 'WI-1': { status: 'open', text: 'unrelated' } }));
    expect(unnamed.findings.find(f => f.ref === NATIVE_P026)?.problem).toMatch(/does not carry the obligation/);

    const toDropped = scoreStragglerDispositions(snap({
      [NATIVE_P026]: dropped('superseded-by WI-1'),
      'WI-1': { status: 'dropped', text: `carries ${NATIVE_P026} — note: abandoned: gone.` },
    }));
    expect(toDropped.findings.find(f => f.ref === NATIVE_P026)?.problem).toMatch(/points at a dropped item/);
  });

  it('names a cycle when the refs loop back', () => {
    const s = scoreStragglerDispositions(snap({
      [NATIVE_P026]: dropped('superseded-by WI-1'),
      'WI-1': { status: 'dropped', text: `x — note: superseded-by WI-2` },
      'WI-2': { status: 'dropped', text: `x — note: obligations-moved-to ${NATIVE_P026}` },
    }));
    expect(s.verdict).toBe('broken');
    expect(s.findings.find(f => f.ref === NATIVE_P026)?.problem).toMatch(/forms a cycle/);
  });

  it('passes an abandoned drop listed in ## Now and fails one that is not', () => {
    const t = { [NATIVE_P026]: dropped('abandoned: superseded by the native graph.') };
    expect(scoreStragglerDispositions(snap(t, { nowText: `Will not exist: ${NATIVE_P026}` })).verdict).toBe('healthy');
    const s = scoreStragglerDispositions(snap(t, { nowText: 'nothing listed' }));
    expect(s.findings.find(f => f.ref === NATIVE_P026)?.problem).toMatch(/not listed in .* ## Now/);
  });

  it('reports unknown, never healthy, when a source could not be read', () => {
    expect(scoreStragglerDispositions(snap({}, { unread: [slugOf(NATIVE_P026)] })).verdict).toBe('unknown');
    const t = { [NATIVE_P026]: dropped('abandoned: gone.') };
    expect(scoreStragglerDispositions(snap(t, { nowText: null })).verdict).toBe('unknown');
    const ref = { [NATIVE_P026]: dropped('superseded-by WI-9') };
    expect(scoreStragglerDispositions(snap(ref)).verdict).toBe('unknown');
  });

  it('fails an enumerated straggler missing from a readable plan, and broken outranks unknown', () => {
    expect(scoreStragglerDispositions(snap({ [NATIVE_P026]: undefined })).verdict).toBe('broken');
    const mixed = snap({ [NATIVE_P026]: { status: 'todo', text: 'x' } }, { unread: ['gitnexus-selective-hardening-and-comparison-2026-09-13'] });
    const s = scoreStragglerDispositions(mixed);
    expect(s.verdict).toBe('broken');
    expect(summarizeStragglerScore(s)).toMatch(/Broken: .*Unknown: /);
  });
});

describe('nowSection', () => {
  it('returns only the ## Now section', () => {
    const body = '# T\n\n## Now\nstate: x\nnext: y\n\n## Items\n- P-001';
    expect(nowSection(body)).toBe('## Now\nstate: x\nnext: y\n\n');
    expect(nowSection('# T\n## Items')).toBe('');
    expect(nowSection('# T\n## Now\nlast')).toBe('## Now\nlast');
  });
});
