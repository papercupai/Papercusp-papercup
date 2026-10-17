/**
 * EI-19455334047866968 — dangling work-item refs in a written body.
 *
 * The probe is INJECTED throughout, so these run with no DB and no dynamic import.
 * The load-bearing case is `probe throws → silence`: that is the difference between
 * an advisory nudge and a check that manufactures phantom-ref accusations out of a
 * transient store fault.
 */
import { describe, it, expect, vi } from 'vitest';
import { unresolvedRefsInBody, unresolvedRefsWarning, MAX_REFS_PROBED } from './unresolved-refs';
import { completionRefBody } from './complete';

/** A probe where only the listed ids exist. */
const probeWith = (...existing: string[]) => {
  const set = new Set(existing.map((s) => s.toUpperCase()));
  return vi.fn(async (id: string) => (set.has(id.toUpperCase()) ? { id } : null));
};

describe('unresolvedRefsInBody', () => {
  it('says nothing when the body cites no refs', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('landed the fix, all green', { probe })).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  // The tuple list is heterogeneous (string | null | undefined in slot 0), so
  // vitest types the callback as a UNION of tuple spreads — a single-parameter
  // callback is not assignable to it (TS2345). Declaring both slots satisfies
  // every member of that union.
  it.each<[string | null | undefined, string]>([
    ['', 'empty'],
    ['   ', 'whitespace'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('says nothing for a %s body (%s)', async (body, _label) => {
    expect(await unresolvedRefsInBody(body, { probe: probeWith() })).toBeUndefined();
  });

  it('says nothing when every cited ref resolves', async () => {
    const probe = probeWith('EI-100', 'WI-200');
    expect(await unresolvedRefsInBody('see EI-100 and WI-200', { probe })).toBeUndefined();
  });

  it('reports a ref that resolves to nothing', async () => {
    const probe = probeWith('EI-100');
    const out = await unresolvedRefsInBody('filed as EI-999, superseding EI-100', { probe });
    expect(out?.missing).toEqual(['EI-999']);
  });

  it('reproduces the measured incident: a miscited freshly-minted id', async () => {
    // The real filing was EI-19454705610327667; the comment cited …3856572431492.
    const probe = probeWith('EI-19454705610327667');
    const out = await unresolvedRefsInBody('Filed as EI-19453856572431492', { probe });
    expect(out?.missing).toEqual(['EI-19453856572431492']);
  });

  it('keeps the full numeric suffix when resolving a long WI id', async () => {
    const full = 'WI-6554700010009391';
    const probe = probeWith(full);
    const out = await unresolvedRefsInBody(`checkpoint cites the existing item ${full}`, { probe });
    expect(out).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(full);
  });

  it('suppresses the unique short prefix of the known long WI checkpoint subject', async () => {
    const full = 'WI-6554700010009391';
    const shorthand = 'WI-655470';
    const probe = probeWith();
    const out = await unresolvedRefsInBody(`checkpoint subject ${shorthand}`, {
      probe,
      known: [full],
    });
    expect(out).toBeUndefined();
    expect(probe).toHaveBeenCalledWith(shorthand);
  });

  it('reports several phantoms in one body, in order of appearance', async () => {
    const probe = probeWith('EI-2');
    const out = await unresolvedRefsInBody('EI-1 then EI-2 then EI-3', { probe });
    expect(out?.missing).toEqual(['EI-1', 'EI-3']);
  });

  it('suppresses a unique shorthand when the exact ref resolves in the same body', async () => {
    const full = 'EI-21159658753576313';
    const shorthand = 'EI-211596';
    const probe = probeWith(full);
    const out = await unresolvedRefsInBody(`exact ${full}, then shorthand ${shorthand}`, { probe });
    expect(out).toBeUndefined();
  });

  it('suppresses a unique shorthand when the exact ref is caller-known', async () => {
    const full = 'EI-23105271390470612';
    const shorthand = 'EI-231052';
    const probe = probeWith();
    const out = await unresolvedRefsInBody(`checkpointed ${full}, shorthand ${shorthand}`, {
      probe,
      known: [full],
    });
    expect(out).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(shorthand);
  });

  it('suppresses a unique shorthand for the caller-known item when its full id is absent from the body', async () => {
    const full = 'EI-25936638201757906';
    const shorthand = 'EI-259366';
    const probe = probeWith();
    const out = await unresolvedRefsInBody(`checkpoint refers to ${shorthand}`, {
      probe,
      known: [full],
    });
    expect(out).toBeUndefined();
    expect(probe).toHaveBeenCalledWith(shorthand);
  });

  it('keeps a shorthand warning when multiple caller-known refs share its prefix', async () => {
    const first = 'EI-21159658753576313';
    const second = 'EI-21159658753576314';
    const shorthand = 'EI-211596';
    const probe = probeWith();
    const out = await unresolvedRefsInBody(`checkpoint refers to ${shorthand}`, {
      probe,
      known: [first, second],
    });
    expect(out?.missing).toEqual([shorthand]);
  });

  it('keeps a shorthand warning when multiple resolved refs share its prefix', async () => {
    const first = 'EI-21159658753576313';
    const second = 'EI-21159658753576314';
    const shorthand = 'EI-211596';
    const probe = probeWith(first, second);
    const out = await unresolvedRefsInBody(`${first}, ${second}, then ${shorthand}`, { probe });
    expect(out?.missing).toEqual([shorthand]);
  });

  // THE safety margin: a store that cannot answer is not evidence of a phantom.
  it('stays SILENT when the probe throws — never accuses on a store fault', async () => {
    const probe = vi.fn(async () => {
      throw new Error('PG connection lost');
    });
    expect(await unresolvedRefsInBody('see EI-999', { probe })).toBeUndefined();
  });

  it('reports only the refs it could judge when SOME probes throw', async () => {
    const probe = vi.fn(async (id: string) => {
      if (id === 'EI-1') throw new Error('transient');
      if (id === 'EI-2') return { id };
      return null;
    });
    const out = await unresolvedRefsInBody('EI-1 EI-2 EI-3', { probe });
    expect(out?.missing).toEqual(['EI-3']);
  });

  it('skips ids the caller already resolved, case-insensitively', async () => {
    const probe = probeWith();
    const out = await unresolvedRefsInBody('this item EI-500 is done', { probe, known: ['ei-500'] });
    expect(out).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('de-dupes a repeated ref into ONE probe and ONE report', async () => {
    const probe = probeWith();
    const out = await unresolvedRefsInBody('EI-7 blocks EI-7 which blocks EI-7', { probe });
    expect(out?.missing).toEqual(['EI-7']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not flag F- ids (excluded upstream as collision-prone in prose)', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('see F-123', { probe })).toBeUndefined();
  });

  it('does not flag an id-like substring inside a larger token', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('XEI-123 and blah-WI-9x', { probe })).toBeUndefined();
  });

  it('does not extract a shorter prefix from a hyphenated diagnostic handle', async () => {
    const full = 'EI-22480960228489210';
    const probe = probeWith(full);
    const out = await unresolvedRefsInBody(
      `owner diag-EI-224809-unlabeled-1788666441808 cited ${full}`,
      { probe },
    );
    expect(out).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(full);
  });

  it('bounds the probes it will run', async () => {
    const probe = probeWith();
    const many = Array.from({ length: MAX_REFS_PROBED + 20 }, (_, i) => `EI-${i + 1}`).join(' ');
    const out = await unresolvedRefsInBody(many, { probe });
    expect(probe.mock.calls.length).toBeLessThanOrEqual(MAX_REFS_PROBED);
    expect(out?.missing.length).toBeLessThanOrEqual(MAX_REFS_PROBED);
  });

  it('probes nothing when max is 0', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('EI-1', { probe, max: 0 })).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('completionRefBody — WHICH fields feed the scan', () => {
  // The regression this exists to prevent: scanning only CompletionVerificationEvidence
  // (summary/testsRun/testResult) and silently missing the fields where the measured
  // phantoms actually landed.
  it('includes deferred — the field EI-19411072468868467 measured the phantom in', () => {
    const body = completionRefBody({ summary: 'done', deferred: ['follow-up filed as EI-19408968252646575'] });
    expect(body).toContain('EI-19408968252646575');
  });

  it('includes coordNotes, whatLanded and migrations', () => {
    const body = completionRefBody({
      summary: 's',
      coordNotes: 'told the fleet via EI-1',
      whatLanded: ['landed EI-2'],
      migrations: ['790 supersedes EI-3'],
    });
    for (const id of ['EI-1', 'EI-2', 'EI-3']) expect(body).toContain(id);
  });

  it('carries every scanned field through to the ref scan end-to-end', async () => {
    const probe = probeWith(); // nothing exists
    const body = completionRefBody({
      summary: 'closes EI-1',
      testsRun: 'suite for EI-2',
      testResult: 'green, see EI-3',
      coordNotes: 'notified on EI-4',
      whatLanded: ['EI-5'],
      deferred: ['EI-6'],
    });
    const out = await unresolvedRefsInBody(body, { probe, max: 50 });
    expect(out?.missing).toEqual(['EI-1', 'EI-2', 'EI-3', 'EI-4', 'EI-5', 'EI-6']);
  });

  it('falls back to gate evidence when the raw record was a coerced bare string', () => {
    // A bare-string completion coerces to { summary } only, so the other raw fields are
    // genuinely absent and the evidence is the only place the prose survives.
    const body = completionRefBody({ summary: 'coerced' }, { testsRun: 'ran against EI-9' } as never);
    expect(body).toContain('EI-9');
  });

  it('survives a malformed record without throwing', () => {
    for (const bad of [null, undefined, 'a string', 42, { deferred: 'not-an-array', whatLanded: [1, 2] }]) {
      expect(() => completionRefBody(bad)).not.toThrow();
    }
  });
});

describe('unresolvedRefsWarning', () => {
  it('claims only non-RESOLUTION, never non-EXISTENCE', async () => {
    const w = unresolvedRefsWarning('EI-1', ['WI-3']);
    // WI-<n> ids come from a per-database sequence, so "does not exist" would be a
    // claim the resolution cannot support (see the module docstring).
    expect(w).toContain('does NOT resolve in this workspace');
    expect(w).not.toMatch(/does not exist|never existed in|no such work-item/i);
  });

  it('names every unresolved ref and stays singular/plural correct', () => {
    expect(unresolvedRefsWarning('EI-1', ['EI-9'])).toContain('a work-item ref that does');
    const many = unresolvedRefsWarning('EI-1', ['EI-9', 'EI-10']);
    expect(many).toContain('2 work-item refs that do');
    expect(many).toContain('EI-9, EI-10');
  });

  it('names the legitimate causes so it can be ignored without guilt', () => {
    const w = unresolvedRefsWarning('EI-1', ['EI-9']);
    expect(w).toMatch(/federated|another harness|deliberately quoted/i);
    expect(w).toContain('RECORDED');
  });

  it('names illustrative slash-separated id shapes as safe to ignore', () => {
    const w = unresolvedRefsWarning('EI-1', ['WI-2', 'WI-3']);
    expect(w).toMatch(/illustrative slash-separated id shapes/i);
    expect(w).toMatch(/ignore this advisory/i);
  });
});
