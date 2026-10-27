import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { PUSH_LEG_FLAGS } from './push-channel';

// code-intel-delivery-and-outcomes-2026-10-26 SPEC-P-002-B: every never-fired push leg carries a
// recorded disposition. A never-fired leg (interface, incident, completion, notes, cochange or
// provenance) may not stay ON without either a fix proven by a replayed push or a switch to OFF
// with a reason. The dispositions are recorded in the committed evidence file below; this test
// is the gate that keeps every leg resolved there (no leg dropped, none left pending, no OFF
// switch without its reason and owning work-item).
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DISPOSITIONS_FILE = 'docs/evidence/code-intel-never-fired-legs-dispositions-2026-10-27.json';
const NEVER_FIRED_LEGS = ['interface', 'incident', 'completion', 'notes', 'cochange', 'provenance'] as const;
// cochange and provenance are task-brief reuse providers, not hook push legs; each has its own flag.
const LEG_FLAGS: Record<(typeof NEVER_FIRED_LEGS)[number], string> = {
  interface: PUSH_LEG_FLAGS.interface, incident: PUSH_LEG_FLAGS.incident,
  completion: PUSH_LEG_FLAGS.completion, notes: PUSH_LEG_FLAGS.notes,
  cochange: FLAGS.CODE_INTEL_REUSE_COCHANGE, provenance: FLAGS.CODE_INTEL_REUSE_PROVENANCE,
};
const REPLAYED = new Set(['fixed-replayed', 'works-when-input-exists-replayed']);

interface Disposition {
  leg: string; disposition: string; evidence?: string; replay?: unknown;
  flag?: string; reason?: string; fixTrackedBy?: string;
}

/** Every reason the recorded dispositions fail the clause; empty means every leg is resolved. */
function dispositionGaps(records: readonly Disposition[]): string[] {
  const gaps: string[] = [];
  for (const leg of NEVER_FIRED_LEGS) {
    const mine = records.filter(r => r.leg === leg);
    if (mine.length !== 1) { gaps.push(`${leg}: ${mine.length} dispositions recorded (want exactly 1)`); continue; }
    const [r] = mine;
    if (REPLAYED.has(r.disposition)) {
      // A replayed push is proven by a code_intel_pushes row the replay wrote.
      const cited = `${r.evidence ?? ''} ${JSON.stringify(r.replay ?? '')}`;
      if (!/code_intel_pushes/.test(cited)) gaps.push(`${leg}: ${r.disposition} cites no replayed code_intel_pushes row`);
    } else if (r.disposition === 'switched-off-with-reason') {
      if (r.flag !== LEG_FLAGS[leg]) gaps.push(`${leg}: switched OFF flag ${r.flag ?? '(none)'} is not the leg's flag ${LEG_FLAGS[leg]}`);
      if ((r.reason ?? '').trim().length < 40) gaps.push(`${leg}: switched OFF without a reason`);
      if (!/^(WI|EI)-\d+$/.test(r.fixTrackedBy ?? '')) gaps.push(`${leg}: switched OFF with no owning work-item for the fix`);
    } else {
      gaps.push(`${leg}: disposition '${r.disposition}' is neither a replayed fix nor an OFF switch with a reason`);
    }
  }
  return gaps;
}

const recorded = (): Disposition[] =>
  (JSON.parse(readFileSync(`${ROOT}${DISPOSITIONS_FILE}`, 'utf8')) as { dispositions: Disposition[] }).dispositions;

describe('never-fired push leg dispositions (P-002, SPEC-P-002-B)', () => {
  it('SPEC-P-002-B: every never-fired push leg carries a recorded disposition', () => {
    expect(dispositionGaps(recorded())).toEqual([]);
  });

  it('the legs the clause names are real push legs or reuse providers with their own flag', () => {
    for (const leg of NEVER_FIRED_LEGS) expect(LEG_FLAGS[leg], leg).toMatch(/^papercusp-code-intel-/);
    expect(Object.keys(PUSH_LEG_FLAGS)).toEqual(expect.arrayContaining(['interface', 'incident', 'completion', 'notes']));
  });

  it('a missing, pending, reasonless, unowned or unproven disposition is reported (fixture calibration)', () => {
    const base = recorded();
    const without = base.filter(r => r.leg !== 'notes');
    expect(dispositionGaps(without)).toEqual(['notes: 0 dispositions recorded (want exactly 1)']);
    const pending = base.map(r => (r.leg === 'interface' ? { ...r, disposition: 'pending' } : r));
    expect(dispositionGaps(pending)).toEqual([`interface: disposition 'pending' is neither a replayed fix nor an OFF switch with a reason`]);
    const reasonless = base.map(r => (r.leg === 'cochange' ? { ...r, reason: '' } : r));
    expect(dispositionGaps(reasonless)).toEqual(['cochange: switched OFF without a reason']);
    const unowned = base.map(r => (r.leg === 'completion' ? { ...r, fixTrackedBy: undefined } : r));
    expect(dispositionGaps(unowned)).toEqual(['completion: switched OFF with no owning work-item for the fix']);
    const wrongFlag = base.map(r => (r.leg === 'provenance' ? { ...r, flag: PUSH_LEG_FLAGS.completion } : r));
    expect(dispositionGaps(wrongFlag)).toEqual([`provenance: switched OFF flag ${PUSH_LEG_FLAGS.completion} is not the leg's flag ${FLAGS.CODE_INTEL_REUSE_PROVENANCE}`]);
    const unproven = base.map(r => (r.leg === 'incident' ? { ...r, evidence: 'fixed', replay: undefined } : r));
    expect(dispositionGaps(unproven)).toEqual(['incident: fixed-replayed cites no replayed code_intel_pushes row']);
  });
});
