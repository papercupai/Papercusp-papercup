import { describe, it, expect } from 'vitest';
import { pathExists, stampStatePlane } from './state-plane-stamp';
import { BUILTIN_CELLS } from './cell-registrations';
import type { CellSpec } from './cell-registry';

/**
 * state-plane-adoption-2026-08-02 P-010 — the door emits the plane.
 *
 * The module is pure, so everything here is hermetic. The cases are grouped by the
 * failure each one prevents, because two of them are the difference between a handle
 * that re-reads the caller's value and one that confidently answers a different question.
 */

const DOOR = 'dev:pipeline_position';

function cell(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.cell',
    owner: 'test',
    headline: 'a.b',
    falsifier: { field: 'a.c', measurement: 'an independent probe', kills: 'a false reading' },
    nullable: false,
    callerRelativity: { kind: 'global' },
    provenance: { kind: 'measured', evidence: 'test' },
    resolver: 'testResolver()',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: DOOR, path: 'a.b' },
    shape: 'string',
    ...over,
  } as CellSpec;
}

describe('pathExists — MISSING is not NULL', () => {
  it('reports a present-and-null value as EXISTING', () => {
    expect(pathExists({ deployedSha: null }, 'deployedSha')).toEqual({ exists: true, value: null });
  });

  it('reports a present-and-undefined value as EXISTING (the key is there)', () => {
    expect(pathExists({ x: undefined }, 'x').exists).toBe(true);
  });

  it('reports a missing key as absent and names where the walk stopped', () => {
    expect(pathExists({ a: { b: 1 } }, 'a.z')).toEqual({ exists: false, value: undefined, missingAt: 'a.z' });
    expect(pathExists({ a: { b: 1 } }, 'q.b')).toEqual({ exists: false, value: undefined, missingAt: 'q' });
  });

  it('stops at a non-object segment rather than pretending to walk through it', () => {
    expect(pathExists({ a: 5 }, 'a.b').missingAt).toBe('a.b');
    expect(pathExists({ a: null }, 'a.b').missingAt).toBe('a.b');
  });

  it('can distinguish an explicit null parent from a missing key on request', () => {
    expect(pathExists({ a: null }, 'a.b', { reportNullTermination: true })).toEqual({
      exists: false,
      value: undefined,
      missingAt: 'a.b',
      nullTerminatedAt: 'a',
    });
    expect(pathExists({ a: {} }, 'a.b', { reportNullTermination: true })).toEqual({
      exists: false,
      value: undefined,
      missingAt: 'a.b',
    });
    // Root null is a malformed/empty payload, not an explicit parent field.
    expect(pathExists(null, 'a.b', { reportNullTermination: true })).toEqual({
      exists: false,
      value: undefined,
      missingAt: 'a',
    });
  });

  it('does NOT see inherited properties — own-key only', () => {
    // `toString` resolves through the prototype chain; a stamp keyed on it would be a
    // phantom. This is why the walk uses hasOwnProperty rather than an `in` test.
    expect(pathExists({}, 'toString').exists).toBe(false);
  });

  it('is TOTAL — a throwing getter degrades to absent instead of escaping', () => {
    const hostile = Object.defineProperty({}, 'boom', {
      get() {
        throw new Error('nope');
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => pathExists(hostile, 'boom')).not.toThrow();
    expect(pathExists(hostile, 'boom').exists).toBe(false);
  });
});

describe('stampStatePlane — which cells are stamped', () => {
  it('stamps only cells whose changeSignal names THIS door', () => {
    const cells = [
      cell({ cell: 'mine', changeSignal: { kind: 'poll', tool: DOOR, path: 'a.b' } }),
      cell({ cell: 'theirs', changeSignal: { kind: 'poll', tool: 'coord:goal', path: 'a.b' } }),
    ];
    const out = stampStatePlane({ payload: { a: { b: 1 } }, tool: DOOR, cells });
    expect(out?.cells.map((c) => c.cell)).toEqual(['mine']);
  });

  it('stamps a registry-declared alternate door while keeping state:read on the canonical cell resolver', () => {
    const cells = [
      cell({
        cell: 'deploy.3070.sha',
        changeSignal: { kind: 'poll', tool: DOOR, path: 'deployedSha' },
        doorProjections: [{ tool: 'release:deploy', path: 'deploy.deployedSha' }],
      }),
    ];
    const out = stampStatePlane({
      payload: { deploy: { deployedSha: 'abc123' } },
      tool: 'release:deploy',
      cells,
    });
    expect(out?.cells).toEqual([
      expect.objectContaining({
        path: 'deploy.deployedSha',
        cell: 'deploy.3070.sha',
        reread: { tool: 'state:read', args: { cell: 'deploy.3070.sha' } },
      }),
    ]);
  });

  it('projects release:trace target.sha back to the path-scoped candidate cell', () => {
    const cells = [
      cell({
        cell: 'gate.greenCheckpoint.candidate',
        callerRelativity: { kind: 'parameter', param: 'path' },
        changeSignal: { kind: 'poll', tool: DOOR, path: 'changeInCandidate.judgingSha' },
        doorProjections: [{ tool: 'release:trace', path: 'target.sha' }],
      }),
    ];
    const out = stampStatePlane({
      payload: { target: { sha: 'abc123' } },
      tool: 'release:trace',
      args: { path: 'apps/x.ts' },
      cells,
    });
    expect(out?.cells).toEqual([
      {
        path: 'target.sha',
        cell: 'gate.greenCheckpoint.candidate',
        reread: { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.candidate', as: 'apps/x.ts' } },
      },
    ]);
  });

  it('skips event-signalled cells — they have no poll path into this payload', () => {
    const cells = [cell({ changeSignal: { kind: 'event', key: 'coord:presence-changed' } as never })];
    expect(stampStatePlane({ payload: { a: { b: 1 } }, tool: DOOR, cells })).toBeNull();
  });

  it('omits a declared path that is ABSENT from this payload (a per-path leg on a no-arg call)', () => {
    const cells = [cell({ changeSignal: { kind: 'poll', tool: DOOR, path: 'changeInCandidate.judgingSha' } })];
    expect(stampStatePlane({ payload: { deployedSha: 'abc' }, tool: DOOR, cells })).toBeNull();
  });

  /**
   * THE REGRESSION THAT WOULD MAKE THIS FEATURE VANISH WHERE IT MATTERS MOST. Keying
   * existence on `valueAtPath` would drop the stamp for a null value — i.e. exactly when
   * the door could not determine the deployed sha, which is the reading a caller must not
   * transcribe. A null value is the strongest reason to hand over a re-read handle.
   */
  it('STAMPS a present-and-null value', () => {
    const cells = [cell({ cell: 'deploy.3070.sha', changeSignal: { kind: 'poll', tool: DOOR, path: 'deployedSha' } })];
    const out = stampStatePlane({ payload: { deployedSha: null }, tool: DOOR, cells });
    expect(out?.cells).toHaveLength(1);
    expect(out?.cells[0]).toMatchObject({
      path: 'deployedSha',
      cell: 'deploy.3070.sha',
      reread: { tool: 'state:read', args: { cell: 'deploy.3070.sha' } },
    });
  });

  it('returns null rather than an empty shell when nothing stamps', () => {
    expect(stampStatePlane({ payload: {}, tool: DOOR, cells: [] })).toBeNull();
  });

  it('emits one stamp per path when two cells collide on it, deterministically', () => {
    const cells = [
      cell({ cell: 'first', changeSignal: { kind: 'poll', tool: DOOR, path: 'a.b' } }),
      cell({ cell: 'second', changeSignal: { kind: 'poll', tool: DOOR, path: 'a.b' } }),
    ];
    const out = stampStatePlane({ payload: { a: { b: 1 } }, tool: DOOR, cells });
    expect(out?.cells).toHaveLength(1);
    expect(out?.cells[0]?.cell).toBe('first');
  });

  it('sorts by path so two reads of the same payload cannot produce a spurious diff', () => {
    const cells = [
      cell({ cell: 'z', changeSignal: { kind: 'poll', tool: DOOR, path: 'zeta' } }),
      cell({ cell: 'a', changeSignal: { kind: 'poll', tool: DOOR, path: 'alpha' } }),
    ];
    const out = stampStatePlane({ payload: { zeta: 1, alpha: 2 }, tool: DOOR, cells });
    expect(out?.cells.map((c) => c.path)).toEqual(['alpha', 'zeta']);
  });
});

describe('stampStatePlane — caller-relativity decides whether the handle is CORRECT', () => {
  const relative = cell({
    cell: 'gate.greenCheckpoint.candidate',
    callerRelativity: { kind: 'parameter', param: 'path' },
    changeSignal: { kind: 'poll', tool: DOOR, path: 'changeInCandidate.judgingSha' },
  });
  const payload = { changeInCandidate: { judgingSha: 'abc123' } };

  it("threads the caller's own subject into `as`", () => {
    const out = stampStatePlane({ payload, tool: DOOR, cells: [relative], args: { path: 'apps/x.ts' } });
    expect(out?.cells[0]?.reread).toEqual({
      tool: 'state:read',
      args: { cell: 'gate.greenCheckpoint.candidate', as: 'apps/x.ts' },
    });
  });

  it('reads the param NAME off the spec — never positionally, never hardcoded', () => {
    const byOwner = cell({
      cell: 'agent.goal',
      callerRelativity: { kind: 'parameter', param: 'ownerId' },
      changeSignal: { kind: 'poll', tool: DOOR, path: 'goalRef' },
    });
    const out = stampStatePlane({
      payload: { goalRef: 'WI-1' },
      tool: DOOR,
      cells: [byOwner],
      // `path` is present and WRONG for this cell; only `ownerId` may be used.
      args: { path: 'apps/x.ts', ownerId: 'su-abc' },
    });
    expect(out?.cells[0]?.reread?.args.as).toBe('su-abc');
  });

  /**
   * FAIL SAFE. An unqualified re-read of a caller-relative cell answers about a different
   * subject (or refuses). A handle that looks authoritative and resolves elsewhere is worse
   * than no handle, so no partial handle is emitted — same direction as `canReadCell`
   * failing closed and `headlineSource` degrading to authoritative:false.
   */
  it('emits NO handle — and says what is needed — when the subject is missing', () => {
    const out = stampStatePlane({ payload, tool: DOOR, cells: [relative], args: {} });
    const stamp = out?.cells[0];
    expect(stamp?.reread).toBeUndefined();
    expect(stamp?.unreadable?.needs).toBe('path');
    expect(stamp?.unreadable?.why).toMatch(/different subject/);
  });

  it('treats a blank subject as missing, not as a valid `as`', () => {
    const out = stampStatePlane({ payload, tool: DOOR, cells: [relative], args: { path: '   ' } });
    expect(out?.cells[0]?.reread).toBeUndefined();
    expect(out?.cells[0]?.unreadable?.needs).toBe('path');
  });

  it('a GLOBAL cell needs no subject and gets a complete handle', () => {
    const out = stampStatePlane({
      payload: { deployedSha: 'x' },
      tool: DOOR,
      args: {},
      cells: [cell({ cell: 'deploy.3070.sha', changeSignal: { kind: 'poll', tool: DOOR, path: 'deployedSha' } })],
    });
    expect(out?.cells[0]?.reread?.args).toEqual({ cell: 'deploy.3070.sha' });
    expect(out?.cells[0]?.unreadable).toBeUndefined();
  });
});

describe('stampStatePlane — audience (P-019: a stamp must not be an enumeration oracle)', () => {
  it('never advertises a cell the reader may not read', () => {
    const cells = [
      cell({ cell: 'open', visibility: { kind: 'workspace' }, changeSignal: { kind: 'poll', tool: DOOR, path: 'a' } }),
      cell({
        cell: 'narrow',
        visibility: { kind: 'owner', ref: 'someone-else' },
        changeSignal: { kind: 'poll', tool: DOOR, path: 'b' },
      }),
    ];
    const out = stampStatePlane({
      payload: { a: 1, b: 2 },
      tool: DOOR,
      cells,
      reader: { ownerId: 'me', roles: [] },
    });
    expect(out?.cells.map((c) => c.cell)).toEqual(['open']);
  });

  it('admits an owner-visible cell to its owner', () => {
    const cells = [
      cell({
        cell: 'mine',
        visibility: { kind: 'owner', ref: 'me' },
        changeSignal: { kind: 'poll', tool: DOOR, path: 'a' },
      }),
    ];
    const out = stampStatePlane({ payload: { a: 1 }, tool: DOOR, cells, reader: { ownerId: 'me', roles: [] } });
    expect(out?.cells.map((c) => c.cell)).toEqual(['mine']);
  });
});

describe('stampStatePlane — totality (an enrichment must never fail the call it decorates)', () => {
  it('does not throw on a hostile payload', () => {
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error('trap');
        },
        get() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(() => stampStatePlane({ payload: hostile, tool: DOOR, cells: [cell()] })).not.toThrow();
  });

  it('tolerates a malformed cell list without dropping the good entries', () => {
    const cells = [
      null as unknown as CellSpec,
      cell({ cell: 'good', changeSignal: { kind: 'poll', tool: DOOR, path: 'a' } }),
      { cell: 'no-signal' } as unknown as CellSpec,
    ];
    const out = stampStatePlane({ payload: { a: 1 }, tool: DOOR, cells });
    expect(out?.cells.map((c) => c.cell)).toEqual(['good']);
  });
});

/**
 * AGAINST THE REAL REGISTRY, not fixtures. The hermetic cases above would all pass if the
 * declared paths had drifted from the door's actual payload shape — the stamp would simply
 * emit nothing, silently, which is the failure mode this whole plan keeps rediscovering.
 */
describe('stampStatePlane — the REAL built-in cells stamp a REAL-shaped payload', () => {
  const pipelineCells = BUILTIN_CELLS.filter((c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === DOOR);

  it('the door has cells registered against it at all', () => {
    // If this ever hits zero the feature is dead and every other test here still passes.
    expect(pipelineCells.length).toBeGreaterThan(0);
  });

  it('stamps every built-in pipeline cell whose path the payload carries', () => {
    // Shaped from the declared paths themselves, with deliberately NULL/false values —
    // the readings a caller is most tempted to transcribe.
    const payload = {
      positions: { deployed: false },
      deployedSha: null,
      // Carry the registered LEAF with a null reading. A null qualification
      // parent does not carry `gate.qualification.attemptId` at all.
      gate: {
        consecutiveReds: 0,
        qualification: { attemptId: null },
        ownership: { claimState: null },
        candidateFailures: {
          assessment: null,
          stillBrokenCount: null,
          distinctFailingFiles: [],
          filesJudged: 0,
          scope: null,
          nonTestLegsMeasured: 'not-recorded',
        },
        ownerBrief: {
          answer: null,
          assessment: null,
          mainGreen: { value: null },
          whyNot: { failingLegs: [] },
          ownership: { assessmentCode: null },
          remediation: { fixerAlive: null },
          vintageSpreadMs: null,
          unknownLegs: [],
        },
        // P-004 (convergence + freezeDisposition) and P-009 (retriage) registered three
        // more pipeline cells and did not extend this fixture, so it fell behind the
        // registry: this census went from 9-of-9 green at 11:27Z to 9-of-11 and then
        // 9-of-12 red, WITHOUT any edit to the file. Adding a member to a registry obliges
        // EVERY census over that registry, and this is the third one.
        //
        // Each subject is carried with NULL leaves on purpose, matching the rest of the
        // fixture: the point is that the path is PRESENT and stampable, not that it has a
        // value. A cell whose path the payload does not carry is silently unstamped, which
        // is precisely the drift this test exists to catch.
        convergence: { code: null, shrinkTotal: null },
        freezeDisposition: { code: null, state: null },
        retriage: { code: null, inFlight: null },
        // The `gate.run.code` cell joined the registry after the three above; same rule.
        run: { code: null },
      },
      changeInCandidate: { judgingSha: null },
      // The pair is ONE reading in two polarities, so they must stay consistent
      // negations of each other or this fixture stops mirroring the resolver
      // (EI-20046248345042252). `mainBehindStaging: true` is the tempting-to-misread
      // one here: a buffer is the normal steady state, not a fault.
      verdictProvenance: { mainFastForwarded: false, mainBehindStaging: true },
    };
    const out = stampStatePlane({
      payload,
      tool: DOOR,
      args: { path: 'apps/operator/x.ts' },
      cells: pipelineCells,
    });
    expect(out?.cells).toHaveLength(pipelineCells.length);
    // Every one is re-readable: the caller supplied a path, so even the caller-relative
    // cells get a complete, correctly-addressed handle.
    for (const stamp of out?.cells ?? []) {
      expect(stamp.reread, `${stamp.cell} should be re-readable`).toBeDefined();
    }
  });

  it("addresses each caller-relative built-in cell to the caller's path", () => {
    const relative = pipelineCells.filter((c) => c.callerRelativity.kind === 'parameter');
    expect(relative.length).toBeGreaterThan(0); // else this assertion is vacuous
    const out = stampStatePlane({
      payload: {
        positions: { deployed: true },
        deployedSha: 'abc',
        gate: { consecutiveReds: 1, ownership: { claimState: 'held' } },
        changeInCandidate: { judgingSha: 'def' },
        verdictProvenance: { mainFastForwarded: true, mainBehindStaging: false },
      },
      tool: DOOR,
      args: { path: 'apps/operator/x.ts' },
      cells: pipelineCells,
    });
    for (const spec of relative) {
      const stamp = out?.cells.find((c) => c.cell === spec.cell);
      expect(stamp?.reread?.args.as, `${spec.cell} must carry the caller's subject`).toBe('apps/operator/x.ts');
    }
  });
});

/**
 * P-005 — the plane block must survive an OPERATOR-SCOPE reader.
 *
 * The audience filter in `collect()` is a second consumer of `canReadCell`, and that
 * makes its failure mode much quieter than an unreadable cell. When the harness check
 * refused `harnessSlug:'*'`, every pipeline cell was filtered out here, `stamps.length`
 * hit zero, and `stampStatePlane` returned `null` — so `dev:pipeline_position` emitted
 * NO `plane` key at all. Not an error, not an empty block: an absent field, on a door
 * whose documented job is to hand you that very handle.
 *
 * That is why this is pinned separately from the reach probe. A reader who cannot read
 * a cell at least gets an `absent` reply to a question they asked; a suppressed plane
 * block answers a question they never got the chance to ask.
 */
describe('P-005 — an operator-scope reader still gets the plane block', () => {
  const pipelineCells = BUILTIN_CELLS.filter((c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === DOOR);

  /** A payload carrying each candidate cell's declared path, so own-key existence holds. */
  const payload = {
    positions: { deployed: false },
    gate: { consecutiveReds: 22 },
    deployedSha: 'a2d69cef',
    mainBehindStaging: true,
  };

  const stampFor = (harnessSlug: string) =>
    stampStatePlane({
      payload,
      tool: DOOR,
      args: { path: 'apps/operator/x.ts' },
      cells: BUILTIN_CELLS,
      reader: { ownerId: 'su-p005', roles: ['operator'], harnessSlug },
    });

  it('emits a plane block for harnessSlug "*" (the regression)', () => {
    const out = stampFor('*');
    expect(
      out,
      'stampStatePlane returned null for an operator-scope reader — the door emits no ' +
        '`plane` key at all, which is silently indistinguishable from a door that never ' +
        'stamped one.',
    ).not.toBeNull();
    expect(out!.cells.length).toBeGreaterThan(0);
  });

  it('still suppresses the block for a foreign-harness reader', () => {
    // Calibration: proves the assertion above is measuring the audience filter and not
    // simply that this door always stamps something.
    expect(pipelineCells.length).toBeGreaterThan(0);
    expect(stampFor('sidestage')).toBeNull();
  });
});
