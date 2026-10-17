/**
 * su-cold-loop.test.ts — the cold-auto wake DECISION (su-cold-auto-mode-2026-07-03
 * Phase 2; P-005 cadence + P-006 carry-note precondition). Pure — no DB / spawn.
 */
import { describe, expect, it } from 'vitest';
import {
  readColdLoopMarker,
  coldWakeMode,
  decideColdWake,
  renderColdWakeInjection,
  DEFAULT_COLD_LOOP_CAPS,
} from './su-cold-loop';

describe('readColdLoopMarker', () => {
  it('returns null for a payload with neither cold field (an ordinary warm wake)', () => {
    expect(readColdLoopMarker(null)).toBeNull();
    expect(readColdLoopMarker(undefined)).toBeNull();
    expect(readColdLoopMarker({})).toBeNull();
    expect(readColdLoopMarker({ kickoff: 'do the thing' })).toBeNull();
    expect(readColdLoopMarker('a string')).toBeNull();
  });
  it('reads carry + wakeCount when present, ignoring wrong types', () => {
    expect(readColdLoopMarker({ carry: 'cold', wakeCount: 3 })).toEqual({ carry: 'cold', wakeCount: 3 });
    expect(readColdLoopMarker({ carry: 'warm' })).toEqual({ carry: 'warm', wakeCount: undefined });
    expect(readColdLoopMarker({ wakeCount: 5 })).toEqual({ carry: undefined, wakeCount: 5 });
    // wrong types are dropped, not coerced
    expect(readColdLoopMarker({ carry: 7, wakeCount: 'x' })).toBeNull();
    expect(readColdLoopMarker({ carry: 'cold', wakeCount: Number.NaN })).toEqual({ carry: 'cold', wakeCount: undefined });
  });

  // WI-5510: routineId (the loop-instance id) rides the marker alongside
  // wakeCount so the delivery-side stale-fire guard can tell a superseded
  // delivery from a fresh one, scoped per loop instance.
  it('reads routineId when present (WI-5510), ignoring wrong types / empty string', () => {
    expect(readColdLoopMarker({ carry: 'cold', wakeCount: 3, routineId: 'routine-abc' })).toEqual({
      carry: 'cold', wakeCount: 3, routineId: 'routine-abc',
    });
    // routineId alone (no carry/wakeCount) is still a real marker, not null.
    expect(readColdLoopMarker({ routineId: 'r-1' })).toEqual({
      carry: undefined, wakeCount: undefined, routineId: 'r-1',
    });
    // wrong type / empty string ⇒ dropped
    expect(readColdLoopMarker({ carry: 'cold', routineId: 42 })).toEqual({ carry: 'cold', wakeCount: undefined });
    expect(readColdLoopMarker({ carry: 'cold', routineId: '' })).toEqual({ carry: 'cold', wakeCount: undefined });
  });

  it('does not treat ordinary harness metadata as a loop marker', () => {
    expect(
      readColdLoopMarker({
        id: 'WI-41390',
        state: 'closed',
        kind: 'task',
        harness: 'papercusp',
        title: 'settled child work item',
      }),
    ).toBeNull();
  });
});

describe('coldWakeMode — the HYBRID cadence (reset each wake, recycle every Nth)', () => {
  it('resets on the non-Nth wakes and recycles on the Nth (default N=8)', () => {
    const modes = Array.from({ length: 16 }, (_, i) => coldWakeMode(i + 1));
    // wakes 1..7 reset, 8 recycles, 9..15 reset, 16 recycles
    expect(modes).toEqual([
      'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'recycle',
      'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'reset', 'recycle',
    ]);
  });
  it('an unknown / zero / negative wakeCount is a plain reset (never a surprise recycle)', () => {
    expect(coldWakeMode(0)).toBe('reset');
    expect(coldWakeMode(-3)).toBe('reset');
    expect(coldWakeMode(Number.NaN)).toBe('reset');
  });
  it('a non-positive cap disables recycle entirely (reset-only)', () => {
    expect(coldWakeMode(8, { recycleEveryNWakes: 0 })).toBe('reset');
    expect(coldWakeMode(16, { recycleEveryNWakes: -1 })).toBe('reset');
  });
  it('honours a custom cadence', () => {
    expect(coldWakeMode(3, { recycleEveryNWakes: 3 })).toBe('recycle');
    expect(coldWakeMode(4, { recycleEveryNWakes: 3 })).toBe('reset');
  });
  it('the default cadence matches the bee transcript-cap default (8)', () => {
    expect(DEFAULT_COLD_LOOP_CAPS.recycleEveryNWakes).toBe(8);
  });
});

describe('decideColdWake — the three-gate cold precondition', () => {
  const coldPayload = (wakeCount?: number) => ({ carry: 'cold', ...(wakeCount != null ? { wakeCount } : {}) });

  it('WARM when the loop is not cold (opt-in gate, D-001/P-003)', () => {
    expect(decideColdWake({ payload: { carry: 'warm' }, coldEnabled: true, carryNote: 'note' })).toEqual({
      cold: false,
      reason: 'warm loop (or not a cold loop wake)',
    });
    // not a loop wake at all
    expect(decideColdWake({ payload: { kickoff: 'x' }, coldEnabled: true, carryNote: 'note' }).cold).toBe(false);
  });

  it('WARM when cold-auto is disabled at the master gate (P-007), even for a cold loop', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: false, carryNote: 'note' })).toEqual({
      cold: false,
      reason: 'cold-auto disabled (master gate off)',
    });
  });

  it('WARM when there is NO carry-note to reconstruct from (P-006 — the key safety)', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: null }).cold).toBe(false);
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: '   ' })).toEqual({
      cold: false,
      reason: 'no carry-note anchor — cannot safely cold-start (P-006)',
    });
  });

  it('COLD reset on a normal cold wake with a carry-note (trimmed)', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: '  the note  ' })).toEqual({
      cold: true,
      mode: 'reset',
      carryNote: 'the note',
    });
  });

  it('COLD recycle on the Nth cold wake (cadence flows through)', () => {
    expect(decideColdWake({ payload: coldPayload(8), coldEnabled: true, carryNote: 'note' })).toEqual({
      cold: true,
      mode: 'recycle',
      carryNote: 'note',
    });
  });

  it('all three gates must pass — any one failing is warm', () => {
    // cold loop + enabled + note ⇒ cold; drop any one ⇒ warm
    expect(decideColdWake({ payload: coldPayload(1), coldEnabled: true, carryNote: 'n' }).cold).toBe(true);
    expect(decideColdWake({ payload: { carry: 'warm', wakeCount: 1 }, coldEnabled: true, carryNote: 'n' }).cold).toBe(false);
    expect(decideColdWake({ payload: coldPayload(1), coldEnabled: false, carryNote: 'n' }).cold).toBe(false);
    expect(decideColdWake({ payload: coldPayload(1), coldEnabled: true, carryNote: '' }).cold).toBe(false);
  });
});

describe('decideColdWake — a present human outranks the explicit opt-in (D-005, EI-21572316039386007)', () => {
  const coldPayload = (wakeCount?: number) => ({ carry: 'cold', ...(wakeCount != null ? { wakeCount } : {}) });

  // CALIBRATION: without the flag, this exact wake IS cold. Every assertion below is
  // only meaningful against this control — it proves the cases that follow go warm
  // because of the human-presence guard, not because the wake was ineligible anyway.
  it('control: the identical opt-in wake colds when no human is present', () => {
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: 'note' })).toEqual({
      cold: true,
      mode: 'reset',
      carryNote: 'note',
    });
  });

  it('WARM on the EXPLICIT carry:cold opt-in when a human is mid-exchange — the regression', () => {
    // This is the exact shape that reset a live session twice while its owner was typing:
    // opt-in cold, master gate on, carry-note present. Every other precondition says COLD.
    expect(
      decideColdWake({
        payload: coldPayload(3),
        coldEnabled: true,
        carryNote: 'note',
        activeInteractiveExchange: true,
      }),
    ).toEqual({
      cold: false,
      reason: 'active interactive exchange (recent human input) — stays warm (D-005)',
    });
  });

  it('WARM on a RECYCLE-cadence wake too — the guard is not cadence-dependent', () => {
    expect(
      decideColdWake({
        payload: coldPayload(8),
        coldEnabled: true,
        carryNote: 'note',
        activeInteractiveExchange: true,
      }).cold,
    ).toBe(false);
  });

  it('WARM on the P-021 verdict route as well — one guard covers both routes', () => {
    expect(
      decideColdWake({
        payload: { wakeCount: 3, harness: 'h' },
        coldEnabled: true,
        carryNote: 'note',
        classDefaultCold: true,
        activeInteractiveExchange: true,
      }).cold,
    ).toBe(false);
  });

  it('absent/false is byte-identical to today — a headless session has no keystroke to report', () => {
    const expected = { cold: true, mode: 'reset' as const, carryNote: 'note' };
    expect(decideColdWake({ payload: coldPayload(3), coldEnabled: true, carryNote: 'note' })).toEqual(expected);
    expect(
      decideColdWake({
        payload: coldPayload(3),
        coldEnabled: true,
        carryNote: 'note',
        activeInteractiveExchange: false,
      }),
    ).toEqual(expected);
  });

  it('only a literal true engages it — a truthy non-boolean must not silently warm a fleet', () => {
    // The dep is caller-resolved and fail-soft; an accidental truthy value (a Promise, a
    // string) must not disable cold wakes fleet-wide, which is the blast radius of the
    // opposite mistake to the one being fixed.
    expect(
      decideColdWake({
        payload: coldPayload(3),
        coldEnabled: true,
        carryNote: 'note',
        activeInteractiveExchange: 'yes' as unknown as boolean,
      }).cold,
    ).toBe(true);
  });
});

describe('decideColdWake — P-021 verdict-gated cold-by-default (classDefaultCold)', () => {
  // The marker a WARM loop's fire now stamps: {wakeCount, harness}, NO carry.
  const warmLoopPayload = (wakeCount = 3) => ({ wakeCount, harness: 'papercusp' });

  it('a no-carry LOOP marker colds when the caller resolved classDefaultCold (all other gates held)', () => {
    expect(
      decideColdWake({ payload: warmLoopPayload(), coldEnabled: true, carryNote: 'note', classDefaultCold: true }),
    ).toEqual({ cold: true, mode: 'reset', carryNote: 'note' });
  });

  it('the recycle cadence flows through on the verdict route exactly as on the opt-in route', () => {
    expect(
      decideColdWake({ payload: warmLoopPayload(8), coldEnabled: true, carryNote: 'note', classDefaultCold: true }),
    ).toEqual({ cold: true, mode: 'recycle', carryNote: 'note' });
  });

  it('classDefaultCold absent/false keeps a no-carry loop WARM (today’s behavior, byte-identical)', () => {
    expect(decideColdWake({ payload: warmLoopPayload(), coldEnabled: true, carryNote: 'note' }).cold).toBe(false);
    expect(
      decideColdWake({ payload: warmLoopPayload(), coldEnabled: true, carryNote: 'note', classDefaultCold: false }).cold,
    ).toBe(false);
  });

  it('the verdict route still requires the master gate AND the carry-note (P-006/P-007 unchanged)', () => {
    expect(
      decideColdWake({ payload: warmLoopPayload(), coldEnabled: false, carryNote: 'note', classDefaultCold: true }),
    ).toEqual({ cold: false, reason: 'cold-auto disabled (master gate off)' });
    expect(
      decideColdWake({ payload: warmLoopPayload(), coldEnabled: true, carryNote: '  ', classDefaultCold: true }).cold,
    ).toBe(false);
  });

  it('a NON-loop wake (no marker) never colds, even with the verdict', () => {
    expect(decideColdWake({ payload: null, coldEnabled: true, carryNote: 'n', classDefaultCold: true }).cold).toBe(false);
    expect(
      decideColdWake({ payload: { kickoff: 'x' }, coldEnabled: true, carryNote: 'n', classDefaultCold: true }).cold,
    ).toBe(false);
  });

  it('a marker without a harness scope never colds by verdict (carry-note cannot be scoped)', () => {
    expect(
      decideColdWake({ payload: { wakeCount: 2 }, coldEnabled: true, carryNote: 'n', classDefaultCold: true }).cold,
    ).toBe(false);
  });

  it('an EXPLICIT non-cold carry stamp opts the loop out of the default (future carry:"warm")', () => {
    expect(
      decideColdWake({
        payload: { carry: 'warm', wakeCount: 2, harness: 'papercusp' },
        coldEnabled: true,
        carryNote: 'n',
        classDefaultCold: true,
      }).cold,
    ).toBe(false);
  });

  it('the explicit cold opt-in is unchanged by the verdict input (either value)', () => {
    for (const classDefaultCold of [true, false]) {
      expect(
        decideColdWake({
          payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' },
          coldEnabled: true,
          carryNote: 'n',
          classDefaultCold,
        }),
      ).toEqual({ cold: true, mode: 'reset', carryNote: 'n' });
    }
  });
});

describe('renderColdWakeInjection — the cold-wake injected text (P-002 producer)', () => {
  it('carries the carry-note verbatim', () => {
    const note = '## Did\nwired the producer\n\n## Next action\nrun the tests';
    expect(renderColdWakeInjection(note)).toContain(note);
  });

  it('frames the note as the working continuity (transcript is gone)', () => {
    const out = renderColdWakeInjection('some note');
    expect(out).toContain('COLD LOOP WAKE');
    expect(out.toLowerCase()).toContain('transcript');
    expect(out).toContain('Next action');
  });

  it('appends the STANDING re-checkpoint mandate so the next cold wake has a fresh anchor', () => {
    const out = renderColdWakeInjection('note');
    // the exact tool + the structured shape the agent must re-write
    expect(out).toContain('loop:checkpoint');
    for (const f of ['did', 'left', 'insight', 'next']) expect(out).toContain(f);
    // and the escape hatch when there is nothing left to do
    expect(out).toContain('loop:end');
  });

  it('trims surrounding whitespace on the note (a padded note injects clean)', () => {
    expect(renderColdWakeInjection('   padded   ')).toContain('\npadded\n');
  });

  describe('transient exec-handle carry warning (EI-21201371887345177)', () => {
    it('warns before a numeric exec session handle is handed to the cold successor', () => {
      const note = '## Next action\nuse write_stdin on unified exec session_id 64399 to read the result';
      const out = renderColdWakeInjection(note);
      const warningAt = out.indexOf('CARRIED TRANSIENT EXEC HANDLE');
      const noteAt = out.indexOf(note);

      expect(warningAt).toBeGreaterThanOrEqual(0);
      expect(warningAt).toBeLessThan(noteAt);
      expect(out).toContain('DO NOT call `write_stdin` with the carried id');
      expect(out).toContain('durable spill/log/work-item evidence');
      expect(out).toContain('fresh exec');
    });

    it('routes long-running commands to the existing durable tracked-task surface', () => {
      const note = '## Next action\npoll write_stdin on test suite session_id 93939 after carry';
      const out = renderColdWakeInjection(note);

      expect(out).toContain('capability:bash tracked-task flow');
      expect(out).toContain('run_in_background');
      expect(out).toContain('require_task_confinement');
      expect(out).toContain('task_id and log pointer');
      expect(out).toContain('capability:bash_output');
      expect(out).toContain('bounded rerun');
    });

    it('warns for a Markdown-wrapped command session even when the checkpoint omits the tool name', () => {
      const note = '## Next action\npoll the operator-core typecheck session `11400` for the verdict';
      const out = renderColdWakeInjection(note);

      expect(out).toContain('CARRIED TRANSIENT EXEC HANDLE');
      expect(out).toContain('DO NOT call `write_stdin` with the carried id');
    });

    it('routes carried Codex device-auth handle lists to durable task recovery', () => {
      const note =
        'A predecessor launched `codex login --device-auth` via `exec_command`; saved exec handles ' +
        '12345/23456/34567 are process-local.';
      const out = renderColdWakeInjection(note);

      expect(out).toContain('CARRIED DEVICE-AUTH EXEC HANDLE');
      expect(out).toContain('the prior device code has expired');
      expect(out).toContain('capability:bash` tracked-task flow');
      expect(out).toContain('capability:bash_output { task_id }');
      expect(out).not.toContain('rerun the command with a fresh exec');
    });

    it('does not warn for a stable native session identifier', () => {
      const note = '## Next action\nresume the stable native session 64399; no transient exec handle is carried';
      expect(renderColdWakeInjection(note)).not.toContain('CARRIED TRANSIENT EXEC HANDLE');
    });
  });

  it('tolerates an empty note without throwing (the P-006 guard means this is unreachable in practice, but stays safe)', () => {
    expect(() => renderColdWakeInjection('')).not.toThrow();
    expect(renderColdWakeInjection('')).toContain('loop:checkpoint');
  });

  // EI-15799: a stale/superseded cold-wake delivery must be self-identifying (a fire marker +
  // reconciliation instruction) instead of unconditionally claiming "your context was just reset".
  it('stamps a "(fire #N)" marker + a reconciliation instruction into the header when wakeCount is a positive finite number', () => {
    const out = renderColdWakeInjection('note', undefined, 4);
    expect(out).toContain('(fire #4)');
    expect(out.toLowerCase()).toContain('stale');
    expect(out.toLowerCase()).toContain('reconcile');
  });

  it('is byte-identical to the no-wakeCount rendering when wakeCount is absent, undefined, zero, negative, or non-finite', () => {
    const base = renderColdWakeInjection('note');
    expect(renderColdWakeInjection('note', undefined, undefined)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, 0)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, -1)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, Number.NaN)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, Number.POSITIVE_INFINITY)).toBe(base);
    expect(base).not.toContain('fire #');
    expect(base.toLowerCase()).not.toContain('stale');
  });

  // WI-6849: the preamble used to ASSERT the reset as accomplished. The system only knows the
  // SOCKET WRITE succeeded (wake-executor books `psu-socket-reset` on injectPsuHost => ok), so
  // when a respawn is itself killed — observed live: a usage_limit wall took the retry 4s after
  // the reset was booked `delivered` — the session resumes WARM and the claim is simply false.
  describe('states the reset as REQUESTED, not accomplished (WI-6849)', () => {
    it('never claims the transcript is already gone, in any rendering', () => {
      for (const out of [renderColdWakeInjection('note'), renderColdWakeInjection('note', undefined, 4)]) {
        expect(out).not.toContain('transcript is GONE');
        expect(out).not.toContain('your context was just reset');
        expect(out).toContain('REQUESTED');
      }
    });

    it('carries the TOTAL invariant unconditionally — it needs no fire number to be decidable', () => {
      // The EI-15799 clause keys on "turns from AFTER this fire number", so it cannot fire when
      // the surviving turns predate the delivery — exactly the fire-#6 case that went unguarded.
      const base = renderColdWakeInjection('note');
      expect(base).toContain('THE RESET DID NOT TAKE');
      expect(base.toLowerCase()).toContain('prior turns or tool calls');
      expect(base.toLowerCase()).toContain('do not discard it');
    });

    it('keeps the invariant free of "stale" so the no-wakeCount rendering stays stale-free (EI-15799)', () => {
      // Guards the interaction, not the wording: these are two DIFFERENT claims — "the reset did
      // not take" vs "a later fire superseded this delivery" — and only the latter is fire-gated.
      const base = renderColdWakeInjection('note');
      expect(base).toContain('THE RESET DID NOT TAKE');
      expect(base.toLowerCase()).not.toContain('stale');
      expect(renderColdWakeInjection('note', undefined, 4).toLowerCase()).toContain('stale');
    });
  });

  // EI-18224278118395857: the cold-wake text is composed at fire time and can be flushed
  // minutes late from the host busy-gate, so a note fresh at fire time can be stale by the
  // time a cold successor (whose transcript is gone) reads it. Stamp the note's ABSOLUTE
  // write-time so the successor can detect the staleness against its own wall-clock —
  // mirroring the warm path's EI-13592 treatment (renderLoopCheckpointBlock).
  it('stamps the carry-note write-time + a reconcile instruction when updatedAtMs is a positive finite number', () => {
    // 2026-07-21T03:10:00Z → compact stamp "07-21T03:10:00Z" (mm-ddThh:mm:ssZ).
    const updatedAtMs = Date.parse('2026-07-21T03:10:00.000Z');
    const out = renderColdWakeInjection('note', undefined, 96, updatedAtMs);
    expect(out).toContain('[07-21T03:10:00Z]');
    expect(out).toContain('last written');
    expect(out).toContain('ago as of NOW');
    expect(out.toLowerCase()).toContain('stale');
    expect(out.toLowerCase()).toContain('reconcile');
    // the concrete probes the successor is told to run
    expect(out).toContain('work_items:get');
    expect(out).toContain('loop:checkpoint');
    // the fire tag is still present and the note verbatim
    expect(out).toContain('(fire #96)');
    expect(out).toContain('\nnote\n');
  });

  it('is byte-identical to the no-updatedAtMs rendering when updatedAtMs is absent, null, zero, negative, or non-finite', () => {
    const base = renderColdWakeInjection('note', undefined, 4);
    expect(renderColdWakeInjection('note', undefined, 4, undefined)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, 4, null)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, 4, 0)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, 4, -1)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, 4, Number.NaN)).toBe(base);
    expect(renderColdWakeInjection('note', undefined, 4, Number.POSITIVE_INFINITY)).toBe(base);
    expect(base).not.toContain('last written');
  });

  it('the write-time stamp is independent of the fire tag (present even with no wakeCount)', () => {
    const updatedAtMs = Date.parse('2026-07-21T03:10:00.000Z');
    const out = renderColdWakeInjection('note', undefined, undefined, updatedAtMs);
    expect(out).toContain('[07-21T03:10:00Z]');
    expect(out).not.toContain('fire #');
  });

  // EI-19294445744419497 — the note's AGE is subjective ("older than you would expect"),
  // but a turn that completed AFTER the note was written is objective proof of work the
  // note cannot describe, because only loop:checkpoint rewrites it. The failure guarded
  // here is not a note that is merely stale, but one whose "Next action" is already DONE.
  describe('un-checkpointed-work detection (lastTurnAtMs)', () => {
    const noteAt = Date.parse('2026-08-01T21:04:56.000Z');

    it('warns when a turn completed well after the note write, and names the recovery probe', () => {
      const out = renderColdWakeInjection('note', undefined, 51, noteAt, noteAt + 37 * 60_000);
      expect(out).toContain('UN-CHECKPOINTED WORK EXISTS');
      expect(out).toContain('[08-01T21:41:56Z]'); // the turn-completion instant
      expect(out).toContain('~37m AFTER this note was written');
      expect(out).toContain('ALREADY BE DONE');
      // the successor is told how to recover what it actually did
      expect(out).toContain('sessions:timeline');
      // and the pre-existing signals still render
      expect(out).toContain('(fire #51)');
      expect(out).toContain('last written');
    });

    // EI-23796602281828820: the banner used to open "you completed a turn at [<lastTurnAt>]", which
    // names the latest turn BOUNDARY rather than the work. Those differ — the boundary is routinely
    // an errored/bounced turn while the licensing tool calls sit earlier in the window — and a reader
    // who checked the cited turn, found an API error, and concluded the detector was broken filed
    // that misreading as a defect. The banner must cite the COUNT, which is the actual evidence.
    describe('the banner cites its evidence, and never asserts an unverified case', () => {
      const turnAt = noteAt + 37 * 60_000;

      it('states the tool-call count as the evidence when the count is known', () => {
        const out = renderColdWakeInjection('note', undefined, 51, noteAt, turnAt, 12);
        expect(out).toContain('UN-CHECKPOINTED WORK EXISTS');
        expect(out).toContain('12 agent tool call(s) ran AFTER this note was written');
        expect(out).not.toContain('UNVERIFIED');
      });

      // NEGATIVE CONTROL: without this, a render that simply stopped emitting the banner would
      // satisfy every `not.toContain` above and below.
      it('still downgrades to the bounced-fire note when the count is a confirmed zero', () => {
        const out = renderColdWakeInjection('note', undefined, 51, noteAt, turnAt, 0);
        expect(out).toContain('bounced fire');
        expect(out).not.toContain('UN-CHECKPOINTED WORK EXISTS');
      });

      // Evidence-unavailable still WARNS (reading a failed query as zero would silently suppress a
      // real warning) but must not borrow the confident wording of a measured case.
      it('labels the case UNVERIFIED when the evidence query did not return', () => {
        for (const missing of [undefined, null]) {
          const out = renderColdWakeInjection('note', undefined, 51, noteAt, turnAt, missing);
          expect(out).toContain('UN-CHECKPOINTED WORK EXISTS'); // still warns
          expect(out).toContain('UNVERIFIED');
          expect(out).toContain('did NOT return');
          expect(out).not.toContain('agent tool call(s) ran AFTER'); // claims no count it does not have
        }
      });

      // The specific misreading that produced the filing: judging the warning by the last turn's text.
      it('warns that the cited turn stamp may itself be an errored turn', () => {
        const out = renderColdWakeInjection('note', undefined, 51, noteAt, turnAt, 12);
        expect(out).toContain('latest turn BOUNDARY');
        expect(out).toContain('do not dismiss this warning because the last turn looks like a failure');
      });
    });

    it('stays silent for the mechanical same-turn tail (checkpoint, then the turn ends)', () => {
      // The writing turn necessarily completes AFTER the note; a bare `>` would fire on
      // every cold wake and train the reader to skip the warning entirely.
      const base = renderColdWakeInjection('note', undefined, 7, noteAt);
      expect(renderColdWakeInjection('note', undefined, 7, noteAt, noteAt + 1_000)).toBe(base);
      expect(renderColdWakeInjection('note', undefined, 7, noteAt, noteAt + 60_000)).toBe(base);
      // ...and never for a turn that predates the note at all.
      expect(renderColdWakeInjection('note', undefined, 7, noteAt, noteAt - 60 * 60_000)).toBe(base);
    });

    it('is byte-identical when lastTurnAtMs is absent, null, zero, negative, or non-finite', () => {
      const base = renderColdWakeInjection('note', undefined, 7, noteAt);
      for (const v of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(renderColdWakeInjection('note', undefined, 7, noteAt, v as number | null)).toBe(base);
      }
      expect(base).not.toContain('UN-CHECKPOINTED');
    });

    it('cannot fire without the note write-time, since the verdict is a COMPARISON of the two', () => {
      const out = renderColdWakeInjection('note', undefined, 7, undefined, Date.now());
      expect(out).not.toContain('UN-CHECKPOINTED');
    });

    it('reproduces the 2026-08-01 fire #51 near-miss: note 21:04Z, work to 21:42Z, usage-limit death', () => {
      // The dead session had already implemented AND committed the note's "Next action";
      // the note even asserted no re-check was needed. Absent this line the successor is
      // told only to "continue from its Next action".
      const out = renderColdWakeInjection(
        '## Next action\nImplement item 1: widen classifyPremiseRef...',
        undefined,
        51,
        noteAt,
        Date.parse('2026-08-01T21:42:00.000Z'),
      );
      expect(out).toContain('UN-CHECKPOINTED WORK EXISTS');
      expect(out).toContain('VERIFY IT IS STILL NEEDED');
      // the note itself is still delivered verbatim — the warning frames it, never replaces it
      expect(out).toContain('Implement item 1: widen classifyPremiseRef...');
    });

    describe('agentToolCallsSinceNote — evidence, not just existence (EI-19984789589075138)', () => {
      it('downgrades to a bounced-fire notice when the caller CONFIRMS zero agent tool calls', () => {
        const out = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 37 * 60_000, 0);
        expect(out).not.toContain('UN-CHECKPOINTED WORK EXISTS');
        expect(out).toContain('bounced fire');
        expect(out).toContain('ZERO agent tool calls');
        expect(out).toContain('usage-wall');
        expect(out).toContain('CURRENT');
        // still names the same turn instant/age the strong banner would have
        expect(out).toContain('[08-01T21:41:56Z]');
        expect(out).toContain('~37m after this note was written');
      });

      it('keeps the strong banner when the count is positive (real evidence of work)', () => {
        const out = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 37 * 60_000, 4);
        expect(out).toContain('UN-CHECKPOINTED WORK EXISTS');
        expect(out).not.toContain('bounced fire');
      });

      it('keeps the strong (existing) banner, unchanged, when evidence is unavailable (undefined/null) — never suppress on "unknown"', () => {
        const withEvidenceOmitted = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 37 * 60_000);
        const withEvidenceUndefined = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 37 * 60_000, undefined);
        const withEvidenceNull = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 37 * 60_000, null);
        for (const out of [withEvidenceOmitted, withEvidenceUndefined, withEvidenceNull]) {
          expect(out).toContain('UN-CHECKPOINTED WORK EXISTS');
          expect(out).not.toContain('bounced fire');
        }
        expect(withEvidenceUndefined).toBe(withEvidenceOmitted);
        expect(withEvidenceNull).toBe(withEvidenceOmitted);
      });

      it('a confirmed zero has no effect when the banner would not have fired anyway (inside the floor)', () => {
        const base = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 60_000);
        const withEvidence = renderColdWakeInjection('note', undefined, 6, noteAt, noteAt + 60_000, 0);
        expect(withEvidence).toBe(base);
        expect(withEvidence).not.toContain('bounced fire');
      });
    });
  });
});
