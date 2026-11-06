/**
 * P-004 / D-058 — reading a cell's VALUE.
 *
 * The centre of gravity of this suite is the THREE-WAY distinction between `value`,
 * `unknown` and `absent`, and specifically the case D-058 found: a reader who passes
 * `canReadCell` but is refused by the resolver tool's own role gate. That case must
 * render as an ENUMERATED unknown — never as `absent` (a lie: the reader is entitled
 * to know the cell exists) and never as a throw (P-026 (f): an enrichment must not be
 * able to fail the operation it decorates).
 *
 * The `absent` tests matter for a different reason: `absent` is load-bearing as a
 * NON-oracle. If an out-of-audience read were distinguishable from an unregistered
 * one, a stranger could enumerate the narrow cells by probing — which is the exact
 * hazard D-042 closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    // Only the DISPATCH is faked — `valueAtPath` and the error classification are the
    // real ones, so a change to either fails here rather than passing on a fixture.
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { CELL_READ_TIMEOUT_MS, __resolverInflightCountForTests, formatCellPointers, readCell, unknownForDispatchError } from './cell-read';
import {
  BUILTIN_CELLS,
  GATE_CANDIDATE_FAILURES_CELL,
  GATE_OWNERSHIP_CELL,
  MEMORY_CGROUP_ATTRIBUTION_CELL,
} from './cell-registrations';
import { ReadOnlyDispatchError } from './events/await/predicate-watch';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from './cell-registry';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };

/** A registrable spec. Every axis is satisfied so the registry never refuses for a
 *  reason unrelated to what a given test is about. */
function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.cell',
    owner: 'test',
    headline: 'positions.deployed',
    assessment: {
      path: 'serving.deployState',
      codes: {
        live: {
          meaning: 'the running process is executing the commit this cell reports.',
          safeAction: 'Read the deployed sha as authoritative.',
        },
        stale: {
          meaning: 'the commit is checked out on disk but the process was never restarted onto it.',
          safeAction: 'Restart the serving unit before concluding the deploy took effect.',
        },
      },
      evidence: ['serving.startedSinceCodeChange'],
    },
    nullable: false,
    whyTotal: 'test fixture — the stub resolver returns a value or throws; no read can fail into a default.',
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
});

describe('readCell — the happy path', () => {
  it('dispatches the changeSignal tool and projects its declared path', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, serving: {} });

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.value).toBe(true);
      expect(r.headline).toBe('positions.deployed');
      expect(r.resolver).toBe('git-pipeline-position.ts');
      expect(r.totality).toEqual({
        why: 'test fixture — the stub resolver returns a value or throws; no read can fail into a default.',
      });
    }
    expect(dispatchReadOnlyTool).toHaveBeenCalledWith('dev:pipeline_position', {}, expect.objectContaining({ role: 'su' }));
  });

  it('projects the gate owner identity as declared assessment evidence', async () => {
    registerCell(GATE_OWNERSHIP_CELL);
    dispatchReadOnlyTool.mockResolvedValue({
      gate: {
        ownership: {
          eventKey: 'green-stall:papercusp',
          workItem: 'WI-10002718',
          claimState: 'held',
          takenBy: 'su-gate-holder',
          takenAt: '2026-08-27T04:00:00.000Z',
          lastProgressAt: '2026-08-27T04:30:00.000Z',
          holderSessionState: 'live',
          duplicates: [],
          expiresAt: '2026-08-27T05:00:00.000Z',
        },
      },
      assessments: { gateOwnership: 'held-live' },
    });

    const r = await readCell('gate.greenCheckpoint.ownership', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    expect(r.value).toBe('held');
    expect(r.assessment?.status).toBe('resolved');
    if (r.assessment?.status !== 'resolved') return;
    expect(r.assessment.evidence).toContainEqual({ path: 'gate.ownership.eventKey', value: 'green-stall:papercusp' });
    expect(r.assessment.evidence).toContainEqual({ path: 'gate.ownership.workItem', value: 'WI-10002718' });
    expect(r.assessment.evidence).toContainEqual({ path: 'gate.ownership.takenBy', value: 'su-gate-holder' });
    expect(r.assessment.evidence).toContainEqual({ path: 'gate.ownership.takenAt', value: '2026-08-27T04:00:00.000Z' });
    expect(r.assessment.evidence).toContainEqual({ path: 'gate.ownership.lastProgressAt', value: '2026-08-27T04:30:00.000Z' });
  });

  it('reads target-pot ownership through the target dispatch context', async () => {
    registerCell(GATE_OWNERSHIP_CELL);
    dispatchReadOnlyTool.mockImplementation(async (_tool, _args, env) => ({
      gate: { ownership: {
        eventKey: `green-stall:${env.harnessSlug}`, claimState: 'no-object',
        workItem: null, takenBy: null, takenAt: null, lastProgressAt: null,
        duplicates: [], expiresAt: null, holderSessionState: null,
      } },
      assessments: { gateOwnership: 'unowned' },
      verdictUnknown: [],
    }));
    const harnessSlug = 'slack-asana-bug-drill';
    const result = await readCell(GATE_OWNERSHIP_CELL.cell,
      { ...READER, harnessSlug }, { ...ENV, harnessSlug });
    expect(result.status).toBe('value');
    expect(dispatchReadOnlyTool).toHaveBeenCalledWith('dev:gate_ownership', {},
      expect.objectContaining({ harnessSlug }));
    if (result.status === 'value' && result.assessment?.status === 'resolved') {
      expect(result.assessment.evidence).toContainEqual({
        path: 'gate.ownership.eventKey', value: `green-stall:${harnessSlug}`,
      });
    } else throw new Error('Target ownership assessment was not measured');
  });

  it('projects a declared stage order without a second resolver call', async () => {
    const stages = ['committedLocal', 'onStaging', 'inMain', 'deployed', 'serving'];
    registerCell(spec({ ordered: { stages } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, serving: {} });

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.ordered).toEqual({ stages });
      // The projection must not hand callers a mutable reference into the registry.
      expect(r.ordered?.stages).not.toBe(stages);
    }
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
  });

  it('does not invent an ordering opinion for a cell that declares none', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, serving: {} });

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status === 'value') expect(r.ordered).toBeUndefined();
  });

  it('a null AT the path is a VALUE, not an unknown — a nullable cell must be able to answer "null"', async () => {
    // P-016's goal cell is nullable:true, and "this agent has no goal" is a real
    // answer. If null collapsed to unknown, "no goal" would be indistinguishable from
    // "could not measure the goal" — opposite caller responses.
    // whyTotal is cleared with the flip: the base fixture is non-nullable and attests
    // WHY (EI-18773925664381842), and carrying that attestation onto a nullable cell
    // asserts the verdict cannot be unknown — which is what this cell is denying.
    registerCell(spec({ nullable: true, unknownHoist: 'goalUnknown', whyTotal: undefined }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: null } });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.value).toBeNull();
      expect(r.totality).toBeUndefined();
    }
  });

  it('a nullable nested headline below an explicit null parent is a VALUE null, not path drift', async () => {
    registerCell(GATE_CANDIDATE_FAILURES_CELL);
    dispatchReadOnlyTool.mockResolvedValue({ gate: { candidateFailures: null } });

    const r = await readCell('gate.greenCheckpoint.candidateFailures', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.value).toBeNull();
      expect(r.assessment?.status).toBe('unavailable');
      if (r.assessment?.status === 'unavailable') {
        expect(r.assessment.unknown.detail).toContain('explicit null parent');
        expect(r.assessment.unknown.detail).not.toContain('drifted apart');
      }
      expect(r.unknownHoist).toEqual({
        key: 'gate.candidateFailures.unavailable',
        value: null,
        nullTerminated: true,
      });
      expect(r.assessment?.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'gate.candidateFailures.stillBrokenNeedsRunCount',
          value: null,
          nullTerminated: true,
        }),
      ]));
    }
  });
});

describe('readCell — absent is a NON-oracle (P-019 / D-042)', () => {
  it('an UNREGISTERED cell is absent', async () => {
    expect((await readCell('nope.missing', READER, ENV)).status).toBe('absent');
  });

  it('a cell the reader is OUT OF AUDIENCE for is absent — byte-identical to unregistered', async () => {
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const outOfAudience = await readCell('narrow.cell', READER, ENV);
    const unregistered = await readCell('nope.missing', READER, ENV);

    // Same SHAPE, not merely the same status — a caller must not be able to tell the
    // two apart by any field, or the refusal becomes a probe oracle.
    expect(outOfAudience).toEqual({ status: 'absent', cell: 'narrow.cell' });
    expect(Object.keys(outOfAudience).sort()).toEqual(Object.keys(unregistered).sort());
  });

  it('never dispatches for a cell the reader may not see', async () => {
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'role', ref: 'architect' } }));
    await readCell('narrow.cell', READER, ENV);
    // Gate 1 must short-circuit BEFORE gate 2: dispatching first would leak the cell's
    // existence through timing and through the tool_invocations audit row.
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });
});

describe('readCell — ⚠ the TWO-GATE disagreement (D-058), the case this module exists for', () => {
  it('spec readable + resolver ROLE-REFUSED renders as an enumerated unknown, NOT absent', async () => {
    registerCell(spec()); // workspace-visible: gate 1 passes for everyone
    dispatchReadOnlyTool.mockRejectedValue(
      new ReadOnlyDispatchError('role_not_allowed', 'role_not_allowed: role "su" may not call this tool'),
    );

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      // `not-measured`, whose documented lever is "ask for it, not retry the same
      // call" — obtain the role. `resolver-failed` would send the caller to retry.
      expect(r.unknown.code).toBe('not-measured');
      expect(r.unknown.detail).toContain('role_not_allowed');
    }
  });

  it('EVERY access-family dispatcher code maps to not-measured, and everything else to resolver-failed', async () => {
    for (const code of [
      'role_not_allowed',
      'missing_role',
      'missing_capability',
      'capability_denied',
      'authorization_denied',
      'unauthorized',
      'ungated',
    ]) {
      expect(unknownForDispatchError(new ReadOnlyDispatchError(code, `${code}: x`)).code, code).toBe('not-measured');
    }
    for (const code of ['timeout', 'handler_error', 'harness_required', 'invalid_input', 'dispatch_failed']) {
      expect(unknownForDispatchError(new ReadOnlyDispatchError(code, `${code}: x`)).code, code).toBe('resolver-failed');
    }
  });

  it('a REGISTRATION defect (resolver not read-only) is resolver-failed and says it is not transient', async () => {
    // P-003 gap, D-058: validateCellSpec does not check changeSignal.tool's effect, so
    // this surfaces here at read time. The detail must not invite a pointless retry.
    registerCell(spec());
    dispatchReadOnlyTool.mockRejectedValue(
      new ReadOnlyDispatchError('not_read_only', 'tool "x:write" is not read-only (effect=write)'),
    );

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('resolver-failed');
      expect(r.unknown.detail).toContain('REGISTRATION defect');
    }
  });
});

describe('readCell — TOTALITY (P-026 rule f: an enrichment may never fail its caller)', () => {
  it('a NON-dispatcher throw still returns an unknown rather than propagating', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockRejectedValue(new TypeError('something unrelated exploded'));

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('resolver-failed');
      expect(r.unknown.detail).toContain('something unrelated exploded');
    }
  });

  it('a thrown non-Error does not break the classification', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockRejectedValue('a bare string');
    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
  });
});

describe('readCell — axis 3 caller-relativity and the `as` subject', () => {
  it('a PARAMETER-relative cell with no subject is insufficient-data, and names the param', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('insufficient-data');
      expect(r.unknown.detail).toContain('ownerId');
    }
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });

  it('a PARAMETER-relative cell passes the subject under the DECLARED param name', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: 'x' } });

    await readCell('test.cell', READER, ENV, 'su-peer');

    expect(dispatchReadOnlyTool).toHaveBeenCalledWith(
      'dev:pipeline_position',
      { ownerId: 'su-peer' },
      expect.anything(),
    );
  });

  it('a blank subject counts as MISSING, not as a legitimate empty value', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));
    const r = await readCell('test.cell', READER, ENV, '   ');
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') expect(r.unknown.code).toBe('insufficient-data');
  });

  it('an AMBIENT cell IGNORES a supplied subject rather than injecting it', async () => {
    // Injecting it would silently convert an ambient cell into a parameter one and let
    // a caller redirect a read that is defined to be about ITSELF.
    registerCell(spec({ callerRelativity: { kind: 'ambient', source: 'caller identity' } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: 1 } });

    await readCell('test.cell', READER, ENV, 'su-someone-else');

    expect(dispatchReadOnlyTool).toHaveBeenCalledWith('dev:pipeline_position', {}, expect.anything());
  });

  it('the subject NEVER widens the audience check — it is not an identity override', async () => {
    registerCell(
      spec({
        cell: 'narrow.cell',
        visibility: { kind: 'owner', ref: 'su-peer' },
        callerRelativity: { kind: 'parameter', param: 'ownerId' },
      }),
    );
    // Naming the owner the cell belongs to must NOT grant access to it.
    const r = await readCell('narrow.cell', READER, ENV, 'su-peer');
    expect(r.status).toBe('absent');
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });
});

describe('readCell — an event-signalled cell has nothing to poll', () => {
  it('is not-measured and points at state:subscribe, rather than pretending to be absent', async () => {
    registerCell(spec({ assessment: null, changeSignal: { kind: 'event', key: 'deploy:landed' } }));

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('not-measured');
      expect(r.unknown.detail).toContain('state:subscribe');
    }
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });
});

describe('readCell — path drift', () => {
  it('resolver answered but the declared path is absent ⇒ insufficient-data, not resolver-failed', async () => {
    // The resolver WORKED. Calling this `resolver-failed` would send a caller to retry
    // a call that will keep succeeding and keep not containing the path.
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ somethingElse: true });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('insufficient-data');
      expect(r.unknown.detail).toContain('positions.deployed');
    }
  });

  describe('EI-18790908999972569 / D-067 defect 2 — an ERROR payload must not be misdiagnosed as path drift', () => {
    it('a `data.error` sentinel payload is quoted, not blamed on the declared path', async () => {
      // The live shape: a `global`-relativity cell dispatches `{}`, and the tool
      // opens with `if (!args.path && !args.sha) return { data: { error: … } }`.
      // Every declared path was correct; the resolver never produced a result.
      registerCell(spec());
      dispatchReadOnlyTool.mockResolvedValue({ data: { error: 'Provide a path or a sha.' } });

      const r = await readCell('test.cell', READER, ENV);
      expect(r.status).toBe('unknown');
      if (r.status === 'unknown') {
        expect(r.unknown.code).toBe('insufficient-data');
        expect(r.unknown.detail).toContain('Provide a path or a sha.');
        expect(r.unknown.detail).toContain('not path drift');
        // Must NOT emit the old drift wording — that is precisely the misdiagnosis.
        expect(r.unknown.detail).not.toContain('drifted apart');
      }
    });

    it('a top-level `error` sentinel payload is quoted too', async () => {
      registerCell(spec());
      dispatchReadOnlyTool.mockResolvedValue({ error: 'no such resource' });

      const r = await readCell('test.cell', READER, ENV);
      expect(r.status).toBe('unknown');
      if (r.status === 'unknown') {
        expect(r.unknown.code).toBe('insufficient-data');
        expect(r.unknown.detail).toContain('no such resource');
        expect(r.unknown.detail).not.toContain('drifted apart');
      }
    });

    it('names the dispatched args in the error-shape detail — the `{}` for a global cell is the lead', async () => {
      registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));
      dispatchReadOnlyTool.mockResolvedValue({ data: { error: 'missing ownerId' } });

      const r = await readCell('test.cell', READER, ENV, 'su-peer');
      expect(r.status).toBe('unknown');
      if (r.status === 'unknown') {
        expect(r.unknown.detail).toContain('su-peer');
      }
    });

    it('a real result with a non-string `error`/`data.error` field falls back to the drift diagnosis', async () => {
      // Guards against a false positive: a legitimate payload that happens to carry a
      // truthy-but-non-string `error`-named field (e.g. an error COUNT) must not be
      // mistaken for the sentinel shape.
      registerCell(spec());
      dispatchReadOnlyTool.mockResolvedValue({ error: 3, somethingElse: true });

      const r = await readCell('test.cell', READER, ENV);
      expect(r.status).toBe('unknown');
      if (r.status === 'unknown') {
        expect(r.unknown.detail).toContain('drifted apart');
      }
    });
  });
});

describe('WI-36259 — the headline source rides the SAME dispatch and fails SAFE', () => {
  const withSource = () =>
    spec({
      headlineSource: {
        path: 'gate.candidateSource',
        authoritative: ['retriage-marker'],
        why: "a probe degrades to the checkout's live HEAD on a cron run",
      },
    });

  it('reports authoritative:true for a declared authoritative label, without a second call', () => {
    registerCell(withSource());
    dispatchReadOnlyTool.mockResolvedValue({
      positions: { deployed: true },
      gate: { candidateSource: 'retriage-marker' },
    });

    return readCell('test.cell', READER, ENV).then((r) => {
      expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('value');
      if (r.status === 'value') {
        expect(r.source?.value).toBe('retriage-marker');
        expect(r.source?.authoritative).toBe(true);
      }
    });
  });

  it('reports authoritative:false for a known-but-inferred label', () => {
    registerCell(withSource());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, gate: { candidateSource: 'run-probe' } });

    return readCell('test.cell', READER, ENV).then((r) => {
      if (r.status === 'value') {
        expect(r.source?.value).toBe('run-probe');
        expect(r.source?.authoritative).toBe(false);
        // The caller is told what the untrusted reading actually degrades TO — the
        // difference between an unactionable warning and a decision.
        expect(r.source?.why).toContain('live HEAD');
      }
    });
  });

  /**
   * THE DIRECTION THAT MATTERS. `material` OMITS on a drifted path and `hoistFrom` REPORTS
   * the drift; this field does a third thing, and the asymmetry is the whole point:
   * absence must never be able to manufacture trust. A drifted path, an unrecognised
   * label, and a resolver that simply did not attribute the value all converge on
   * "inference" — the same answer the caller would reach if the field were never declared.
   */
  it('fails SAFE to authoritative:false when the declared path is absent or unrecognised', () => {
    registerCell(withSource());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    return readCell('test.cell', READER, ENV)
      .then((r) => {
        if (r.status === 'value') {
          expect(r.source?.value).toBeNull();
          expect(r.source?.authoritative).toBe(false);
        }
        dispatchReadOnlyTool.mockResolvedValue({
          positions: { deployed: true },
          gate: { candidateSource: 'some-future-source' },
        });
        return readCell('test.cell', READER, ENV);
      })
      .then((r) => {
        if (r.status === 'value') {
          expect(r.source?.authoritative).toBe(false);
        }
      });
  });

  it('omits `source` entirely for a cell that does not declare one', () => {
    registerCell(spec({}));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    return readCell('test.cell', READER, ENV).then((r) => {
      if (r.status === 'value') expect(r.source).toBeUndefined();
    });
  });
});

describe('P-021 — the material lens rides the SAME dispatch', () => {
  const withMateriality = () =>
    spec({
      materiality: { path: 'serving.startedSinceCodeChange', why: 'the headline follows every commit; this is the question.' },
    });

  it('extracts the material answer WITHOUT a second resolver call', () => {
    // Axis 5 applied to materiality: the material answer is a LENS on the one
    // derivation. If declaring it cost an extra dispatch, a registry of them
    // would multiply the resolver load the fold already budgets for
    // (STALENESS_READ_BUDGET), and the cheap declaration D-010 requires would
    // stop being cheap.
    registerCell(withMateriality());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, serving: { startedSinceCodeChange: false } });

    return readCell('test.cell', READER, ENV).then((r) => {
      expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('value');
      if (r.status === 'value') {
        expect(r.value).toBe(true);
        expect(r.material).toEqual({ path: 'serving.startedSinceCodeChange', value: false });
      }
    });
  });

  it('OMITS `material` when the cell declares none — no behaviour change for the other cells', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') expect(r.material).toBeUndefined();
  });

  it('⚠ OMITS `material` when the declared path does NOT resolve — never reports it as unchanged', async () => {
    // Registration drift. Omitting forces the caller to the LOUD reading; the
    // alternative (a present-but-empty material answer) would let a broken
    // declaration silently certify a moved cell as materially unchanged, which
    // is the one failure this field must not be able to cause.
    registerCell(withMateriality());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') expect(r.material).toBeUndefined();
  });
});

/**
 * P-006 (was WI-6506) — THE DECLARED SEMANTICS REACH THE READER, walked over the REAL
 * built-ins rather than a fixture.
 *
 * The defect this block exists against is a CLASS, not one field: a property declared
 * on every cell, validated at registration, and read by nothing. It has now bitten
 * twice — `unknownHoist` (D-039, below) and `falsifier` (WI-6506, whose fixture-level
 * tests this block used to hold). P-006 deleted `falsifier` outright and made
 * `assessment` the one property that carries a cell's meaning, so the sweep is
 * REPOINTED at it rather than removed: the fixture-level assessment semantics
 * (MISSING ≠ NULL, undeclared code, door truncation) are covered in
 * `cell-assessment.test.ts`, and what only THIS block can prove is that all ten
 * shipped registrations are actually REACHABLE — path, declared code and every
 * evidence path — through `readCell`'s single dispatch.
 *
 * ⚠ A fixture-only test would have passed throughout the entire life of both bugs.
 * That is why the sweep below walks `BUILTIN_CELLS`.
 */
describe('P-006 — every built-in cell delivers its DECLARED assessment through readCell', () => {
  /** Recursive merge of two `{a:{b:v}}`-shaped payload fragments — needed because a
   *  cell's headline and assessment can share a top-level key (`gate.greenCheckpoint.candidate`
   *  declares both under `changeInCandidate`), and a shallow spread would let the
   *  second fragment silently clobber the first's leaf. */
  function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const existing = out[k];
      if (
        existing !== null &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v)
      ) {
        out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** Build `{a:{b:value}}` from "a.b" — mirrors the D-039 sweep's `payloadAtPath` below. */
  function payloadAtPath(path: string, value: unknown): Record<string, unknown> {
    const segs = path.split('.');
    const root: Record<string, unknown> = {};
    let cur = root;
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) cur[seg] = value;
      else {
        const next: Record<string, unknown> = {};
        cur[seg] = next;
        cur = next;
      }
    });
    return root;
  }

  const pollBuiltins = BUILTIN_CELLS.filter((s) => s.changeSignal.kind === 'poll');

  it('the sweep is NON-VACUOUS — there are registered poll cells, each declaring a real assessment', () => {
    expect(pollBuiltins.length).toBeGreaterThanOrEqual(6);
    for (const s of pollBuiltins) {
      /** P-006's own requirement, asserted over the shipped population rather than a
       *  fixture: a value-bearing cell may not carry `null` here. Registration refuses
       *  it (`assessment-missing`), and this is the check that the refusal is
       *  non-vacuous — i.e. that there is a population for it to police. */
      expect(s.assessment).not.toBeNull();
      expect(s.assessment?.path.trim()).toBeTruthy();
      expect(Object.keys(s.assessment?.codes ?? {}).length).toBeGreaterThan(0);
      expect(s.assessment?.evidence.length).toBeGreaterThan(0);
    }
  });

  it.each(pollBuiltins.map((s) => [s.cell, s] as const))(
    '%s delivers its declared assessment through readCell, resolved',
    async (_cell, s) => {
      registerCell(s);
      const a = s.assessment;
      // Guarded rather than asserted non-null: the non-vacuity test above owns that
      // claim, and a `!` here would turn its failure into an unreadable TypeError.
      if (a == null) throw new Error(`${s.cell} is a poll cell with no assessment — see the non-vacuity test`);

      const headlinePath = (s.changeSignal as { path: string }).path;
      // The FIRST declared code, chosen from the spec rather than hard-coded: an
      // undeclared code is refused by `assessmentFrom`, so this can only pass by
      // reading the registration the cell actually shipped.
      const declaredCode = Object.keys(a.codes)[0];
      let payload = deepMerge(
        payloadAtPath(headlinePath, s.nullable ? null : 'headline-value'),
        payloadAtPath(a.path, declaredCode),
      );
      // Evidence is part of the contract, not decoration: a resolved code whose
      // declared substantiation did not arrive is DOWNGRADED to unavailable (D-008).
      // So every declared evidence path has to be reachable too, or this fails.
      for (const e of a.evidence) payload = deepMerge(payload, payloadAtPath(e, 'evidence-value'));
      dispatchReadOnlyTool.mockResolvedValue(payload);

      const subject = s.callerRelativity.kind === 'parameter' ? 'a-subject' : undefined;
      const r = await readCell(s.cell, READER, ENV, subject);

      expect(r.status).toBe('value');
      if (r.status === 'value') {
        // The assertion the bug class would have failed: PRESENT, keyed by what the
        // spec declares rather than by a name this test hard-codes, and RESOLVED —
        // carrying the meaning and the safe action, not merely the code.
        expect(r.assessment?.status).toBe('resolved');
        expect(r.assessment?.path).toBe(a.path);
        expect(r.assessment?.code).toBe(declaredCode);
        expect(r.assessment?.meaning).toBe(a.codes[declaredCode].meaning);
        expect(r.assessment?.safeAction).toBe(a.codes[declaredCode].safeAction);
        expect(r.assessment?.evidence.map((e) => e.path)).toEqual([...a.evidence]);
      }
    },
  );
});

/**
 * D-039 / WI-6444 — THE HOIST REACHES THE READER.
 *
 * The defect these tests exist against: `unknownHoist` was declared on all six
 * nullable cells AND enforced at registration (`validateCellSpec` REJECTS a nullable
 * cell without one) — and read by nothing. Six declarations, one validator, zero
 * consumers. Every nullable cell answered `value: null` with the reason dropped,
 * while every unit gate stayed green, because nothing anywhere tested that a
 * DECLARED field is REACHABLE from the read path.
 *
 * So the last block below is the one that matters most: it walks the real
 * `BUILTIN_CELLS` rather than a fixture, because a fixture-only test would have
 * passed throughout the entire life of the bug.
 */
describe('D-039 — the unknown hoist rides the SAME dispatch to the reader', () => {
  const nullableSpec = (over: Partial<CellSpec> = {}) =>
    spec({ nullable: true, unknownHoist: 'goalUnknown', whyTotal: undefined, ...over });

  it('emits the hoist, keyed by the DECLARED name, with the resolver value intact', async () => {
    registerCell(nullableSpec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: null }, goalUnknown: 'nothing-held' });

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status === 'value') {
      // The live regression, verbatim: `state:read { cell:'agent.goal' }` returned
      // `value: null` and NO reason field at all, so a caller could not tell "this
      // agent holds nothing" from "the resolver could not tell".
      expect(r.value).toBeNull();
      expect(r.unknownHoist).toEqual({ key: 'goalUnknown', value: 'nothing-held' });
    }
    // Axis 5 — a lens on the one derivation, never a second call.
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
  });

  it('a MEASURED silence is reported as a value, not as an absence — `verdictUnknown: []` survives', async () => {
    // The negative result is load-bearing. A hoist that fired on the healthy path
    // would be one agents learn to ignore, so "measured, nothing unknown" must be
    // distinguishable from "the channel is broken" — that is what `drifted` is for.
    registerCell(nullableSpec({ unknownHoist: 'verdictUnknown' }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, verdictUnknown: [] });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.unknownHoist).toEqual({ key: 'verdictUnknown', value: [] });
      expect(r.unknownHoist?.drifted).toBeUndefined();
    }
  });

  it('⚠ hoists even when the HEADLINE is known — an unknown leg must not hide behind a known one', async () => {
    // `positions.deployed` reads true while `inMain` was never measured. Gating the
    // hoist on a null headline would drop exactly this case, which is the shape of
    // the defect the result-level rule exists to surface.
    registerCell(nullableSpec({ unknownHoist: 'positionsUnknown' }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, positionsUnknown: ['inMain'] });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.value).toBe(true);
      expect(r.unknownHoist).toEqual({ key: 'positionsUnknown', value: ['inMain'] });
    }
  });

  it('⚠ a DECLARED-but-absent hoist is reported as drifted, NEVER omitted', async () => {
    // The opposite rule to `material`'s drift case, on purpose. Omitting here would
    // reproduce WI-6444 byte for byte: a nullable cell answering `value: null` with
    // no reason attached, silently. The read still succeeds — P-026 (f) — but the
    // caller is told the channel is broken rather than empty.
    registerCell(nullableSpec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: null } });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.unknownHoist).toEqual({ key: 'goalUnknown', value: null, drifted: true });
    }
  });

  it('OMITS the hoist for a NON-nullable cell — no behaviour change for a cell that declares none', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, goalUnknown: 'stray' });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') expect(r.unknownHoist).toBeUndefined();
  });
});

/**
 * ⚠ THE REACHABILITY GUARD — the test whose ABSENCE was the root cause.
 *
 * Declared-vs-consumed is the gap: `validateCellSpec` proves every nullable cell
 * DECLARES a hoist, and nothing proved the read path EMITS one. Both halves were
 * green while the feature did not exist. This walks the REAL registrations, so a
 * future refactor that drops the hoist reds here instead of going quiet.
 */
describe('D-039 — every nullable BUILTIN cell reaches a reader with its hoist', () => {
  /** Build one resolver payload from dotted paths, preserving shared parents. A
   *  shallow spread (or a literal computed key) breaks cells whose headline and
   *  hoist are siblings, such as `memory.pressure` + `memory.unknown`. */
  function payloadAtPaths(
    entries: ReadonlyArray<readonly [path: string, value: unknown]>,
  ): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (const [path, value] of entries) {
      const segs = path.split('.');
      let cur = root;
      segs.forEach((seg, i) => {
        if (i === segs.length - 1) {
          cur[seg] = value;
          return;
        }
        const existing = cur[seg];
        if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
          cur[seg] = {};
        }
        cur = cur[seg] as Record<string, unknown>;
      });
    }
    return root;
  }

  const nullableBuiltins = BUILTIN_CELLS.filter((s) => s.nullable && s.changeSignal.kind === 'poll');

  it('the sweep is NON-VACUOUS — there are nullable built-in cells to check', () => {
    // Without this, deleting every nullable declaration would make the sweep below
    // pass by iterating nothing. Seven today: git.pipelinePosition, the four verdict
    // cells, gate.greenCheckpoint.qualification, and agent.goal.
    expect(nullableBuiltins.length).toBeGreaterThanOrEqual(6);
    for (const s of nullableBuiltins) expect(s.unknownHoist?.trim()).toBeTruthy();
  });

  it.each(nullableBuiltins.map((s) => [s.cell, s] as const))(
    '%s emits its declared hoist through readCell',
    async (_cell, s) => {
      registerCell(s);
      const hoistKey = s.unknownHoist as string;
      const path = (s.changeSignal as { path: string }).path;
      // Some resolvers return an object containing the hoist (checkpoint.unknown).
      // Writing that child after a null parent would silently replace our fixture.
      const nestedHoist = hoistKey.startsWith(`${path}.`);
      const resolverValue = nestedHoist
        ? payloadAtPaths([[hoistKey.slice(path.length + 1), 'measured-unknown-reason']])
        : null;
      const entries: Array<readonly [string, unknown]> = [[path, resolverValue]];
      if (!nestedHoist) entries.push([hoistKey, 'measured-unknown-reason']);
      dispatchReadOnlyTool.mockResolvedValue(payloadAtPaths(entries));

      const subject = s.callerRelativity.kind === 'parameter' ? 'a-subject' : undefined;
      const r = await readCell(s.cell, READER, ENV, subject);

      expect(r.status).toBe('value');
      if (r.status === 'value') {
        expect(r.value).toEqual(resolverValue);
        // The assertion the bug would have failed: PRESENT, and keyed by what the
        // spec declares rather than by a name this test hard-codes.
        expect(r.unknownHoist).toBeDefined();
        expect(r.unknownHoist?.key).toBe(hoistKey);
        expect(r.unknownHoist?.value).toBe('measured-unknown-reason');
        expect(r.unknownHoist?.drifted).toBeUndefined();
      }
    },
  );

  it.each(nullableBuiltins.map((s) => [s.cell, s] as const))(
    '%s preserves an explicit null resolver value, including a nested hoist',
    async (_cell, s) => {
      registerCell(s);
      const path = (s.changeSignal as { path: string }).path;
      dispatchReadOnlyTool.mockResolvedValue(payloadAtPaths([[path, null]]));

      const subject = s.callerRelativity.kind === 'parameter' ? 'a-subject' : undefined;
      const r = await readCell(s.cell, READER, ENV, subject);

      expect(r).toMatchObject({ status: 'value', value: null });
      if (s.unknownHoist!.startsWith(`${path}.`)) {
        expect(r).toMatchObject({
          unknownHoist: { key: s.unknownHoist, value: null, nullTerminated: true },
        });
      }
    },
  );

  it('the ordered built-in cell reaches readers with its declared order', async () => {
    const orderedBuiltins = BUILTIN_CELLS.filter((s) => s.ordered && s.changeSignal.kind === 'poll');
    // Without this control, deleting the only ordered registration makes the loop
    // vacuous and the reachability guard keeps passing.
    expect(orderedBuiltins.length).toBeGreaterThan(0);

    for (const s of orderedBuiltins) {
      registerCell(s);
      const path = (s.changeSignal as { path: string }).path;
      dispatchReadOnlyTool.mockResolvedValue(payloadAtPaths([[path, true]]));

      const subject = s.callerRelativity.kind === 'parameter' ? 'a-subject' : undefined;
      const r = await readCell(s.cell, READER, ENV, subject);

      expect(r.status).toBe('value');
      if (r.status === 'value') {
        expect(r.ordered).toEqual({ stages: s.ordered?.stages });
        expect(r.ordered?.stages.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('EI-21572281184148497 — attribution cell reads the existing host resolver lens', () => {
  it('projects memory.cgroupAttribution and its contextual assessment from one dispatch', async () => {
    registerCell(MEMORY_CGROUP_ATTRIBUTION_CELL);
    const attribution = {
      accounting: 'cgroup-v2-inclusive-descendants',
      partial: false,
      largestCapturedCgroup: {
        path: '/user.slice/papercup-dev-api.service',
        memoryBytes: 48 * 1024 ** 3,
      },
      throttled: null,
      top: [
        {
          path: '/user.slice/papercup-dev-api.service',
          memoryBytes: 48 * 1024 ** 3,
          swapBytes: 4 * 1024 ** 3,
          directPids: 17,
          memoryShareOfLargestCapturedCgroup: 1,
        },
      ],
    };
    dispatchReadOnlyTool.mockResolvedValue({
      memory: { cgroupAttribution: attribution, pressure: 'crit', unknown: [] },
    });

    const r = await readCell(MEMORY_CGROUP_ATTRIBUTION_CELL.cell, READER, ENV);

    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.value).toEqual(attribution);
      expect(r.assessment).toMatchObject({ status: 'resolved', path: 'memory.pressure', code: 'crit' });
      expect(r.unknownHoist).toEqual({ key: 'memory.unknown', value: [] });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-007 — TOTALITY FUZZ
// (agent-state-plane-verification-2026-07-27, per P-026 rule (f))
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-026 rule (f) makes `readCell`'s no-throw contract a REQUIREMENT, not a courtesy:
 * every consumer is on a hot path (a lock acquire, a claim, a presence read), so an
 * enrichment that can throw is an enrichment that can fail the operation it decorates.
 *
 * The suites above test that property one hand-picked failure at a time. This one drives
 * it exhaustively, because the failures that break totality are never the ones anybody
 * thought to hand-pick — they are the shapes a real resolver emits on a bad day: a
 * non-object, a bare null, a payload whose declared path walks through a getter.
 *
 * THE ASSERTION IS THE SAME FOR EVERY ROW, and that is the design. Each case asserts
 * only the CONTRACT — did not throw, returned one of exactly three statuses, and the
 * result is well-formed for the status it claims. Asserting a specific classification
 * per row would turn this into a change-detector; the contract is what must hold for
 * inputs nobody has imagined yet.
 */
describe('P-007 — TOTALITY FUZZ: readCell never throws, whatever the resolver does', () => {
  /** A circular object — its own `JSON.stringify` throws, so anything that stringifies
   *  a resolver payload on the way out is caught here rather than in production. */
  function circular(): Record<string, unknown> {
    const o: Record<string, unknown> = { positions: {} };
    o.self = o;
    (o.positions as Record<string, unknown>).deployed = o;
    return o;
  }

  /** A payload whose declared path walks through a THROWING getter — the shape that
   *  breaks a naive path-walker, and the one a Proxy-backed or lazily-computed resolver
   *  result really can produce. */
  function throwingGetter(): Record<string, unknown> {
    return {
      get positions(): Record<string, unknown> {
        throw new Error('resolver getter exploded mid-walk');
      },
    };
  }

  const ADVERSARIAL: Array<{ label: string; arrange: () => void }> = [
    // ── the resolver THREW
    { label: 'throws an Error', arrange: () => dispatchReadOnlyTool.mockRejectedValue(new Error('boom')) },
    { label: 'throws a string', arrange: () => dispatchReadOnlyTool.mockRejectedValue('a bare string') },
    { label: 'throws null', arrange: () => dispatchReadOnlyTool.mockRejectedValue(null) },
    { label: 'throws undefined', arrange: () => dispatchReadOnlyTool.mockRejectedValue(undefined) },
    { label: 'throws a number', arrange: () => dispatchReadOnlyTool.mockRejectedValue(42) },
    {
      label: 'throws an object with no message',
      arrange: () => dispatchReadOnlyTool.mockRejectedValue({ weird: true }),
    },
    {
      label: 'throws a classified dispatch error (access denial)',
      arrange: () =>
        dispatchReadOnlyTool.mockRejectedValue(new ReadOnlyDispatchError('role_not_allowed', 'nope')),
    },
    {
      label: 'throws a classified dispatch error (transport)',
      arrange: () => dispatchReadOnlyTool.mockRejectedValue(new ReadOnlyDispatchError('handler_error', 'nope')),
    },
    // ── the resolver TIMED OUT (a rejection, the shape a bounded caller produces)
    {
      label: 'rejects with a TIMEOUT',
      arrange: () => {
        const e = new Error('resolver timed out after 30000ms');
        e.name = 'TimeoutError';
        dispatchReadOnlyTool.mockRejectedValue(e);
      },
    },
    {
      label: 'rejects with an AbortError',
      arrange: () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        dispatchReadOnlyTool.mockRejectedValue(e);
      },
    },
    // ── the resolver RETURNED something that is not a result
    { label: 'returns null', arrange: () => dispatchReadOnlyTool.mockResolvedValue(null) },
    { label: 'returns undefined', arrange: () => dispatchReadOnlyTool.mockResolvedValue(undefined) },
    { label: 'returns a number', arrange: () => dispatchReadOnlyTool.mockResolvedValue(7) },
    { label: 'returns a string', arrange: () => dispatchReadOnlyTool.mockResolvedValue('not json') },
    { label: 'returns a boolean', arrange: () => dispatchReadOnlyTool.mockResolvedValue(false) },
    { label: 'returns an array', arrange: () => dispatchReadOnlyTool.mockResolvedValue([1, 2, 3]) },
    { label: 'returns a bare empty object', arrange: () => dispatchReadOnlyTool.mockResolvedValue({}) },
    // ── the resolver returned a RESULT that does not match the declared shape
    {
      label: 'returns a shape MISSING the declared path',
      arrange: () => dispatchReadOnlyTool.mockResolvedValue({ somethingElse: true }),
    },
    {
      label: 'returns null MID-path (positions is null)',
      arrange: () => dispatchReadOnlyTool.mockResolvedValue({ positions: null }),
    },
    {
      label: 'returns a NON-object mid-path (positions is a string)',
      arrange: () => dispatchReadOnlyTool.mockResolvedValue({ positions: 'nope' }),
    },
    {
      label: 'returns an error-sentinel payload',
      arrange: () => dispatchReadOnlyTool.mockResolvedValue({ data: { error: 'I could not answer' } }),
    },
    {
      label: '⚠ returns a CIRCULAR object — anything that stringifies it throws',
      arrange: () => dispatchReadOnlyTool.mockResolvedValue(circular()),
    },
    {
      label: '⚠ returns a payload whose declared path walks a THROWING getter',
      arrange: () => dispatchReadOnlyTool.mockResolvedValue(throwingGetter()),
    },
  ];

  /**
   * The cell shapes to fuzz each behaviour against. The nullable+hoist+materiality row
   * is the point: it is the RICHEST post-dispatch path (`hoistFrom`, the material lens,
   * the drift branch), so a payload that breaks a path-walk has three more chances to
   * escape there than on the plain cell.
   */
  const SHAPES: Array<{ label: string; over: Partial<CellSpec> }> = [
    { label: 'plain non-nullable cell', over: {} },
    {
      label: 'nullable cell WITH a hoist and a materiality path',
      over: {
        nullable: true,
        // cleared with the flip — the base fixture attests WHY it is total, and that
        // attestation contradicts `nullable: true` (EI-18773925664381842).
        whyTotal: undefined,
        unknownHoist: 'positionsUnknown',
        materiality: {
          path: 'serving.startedSinceCodeChange',
          why: 'the churny headline moves on every commit; this is the answer that changes behaviour',
        },
      },
    },
    {
      label: 'parameter-relative cell (subject supplied)',
      over: { callerRelativity: { kind: 'parameter', param: 'path' } },
    },
  ];

  for (const shape of SHAPES) {
    for (const { label, arrange } of ADVERSARIAL) {
      it(`${shape.label} · resolver ${label}`, async () => {
        registerCell(spec(shape.over));
        arrange();

        const subject = shape.over.callerRelativity?.kind === 'parameter' ? 'CLAUDE.md' : undefined;

        // (1) IT DID NOT THROW. Awaiting inside expect().resolves keeps a rejection a
        // test failure rather than an unhandled rejection that vitest reports elsewhere.
        const out = await readCell('test.cell', READER, ENV, subject);

        // (2) EXACTLY ONE OF THREE STATUSES — no fourth, no undefined, no empty string.
        expect(['value', 'unknown', 'absent'], `status was ${JSON.stringify(out.status)}`).toContain(
          out.status,
        );

        // (3) WELL-FORMED FOR THE STATUS IT CLAIMS. A total function that returns a
        // three-way union and then hands back an `unknown` with no code has satisfied
        // the type and broken the contract — the caller still cannot branch.
        expect(out.cell).toBe('test.cell');
        if (out.status === 'unknown') {
          expect(out.unknown, 'an unknown must carry its enumerated payload').toBeDefined();
          expect(typeof out.unknown.code, 'the code must be branchable').toBe('string');
          expect(out.unknown.code.length).toBeGreaterThan(0);
          expect(typeof out.unknown.detail).toBe('string');
        }
        if (out.status === 'value') {
          expect(typeof out.headline).toBe('string');
          expect(typeof out.resolver).toBe('string');
          // A hoist, if emitted, is always keyed — a hoist with no key cannot be read.
          if (out.unknownHoist) expect(typeof out.unknownHoist.key).toBe('string');
        }
      });
    }
  }

  it('the fuzz is NON-VACUOUS — it drives a real cross-product, not an empty loop', () => {
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(20);
    expect(SHAPES.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION for P-007. Proves the harness above would actually catch
   * a totality break — without it, a `readCell` that threw on every one of the 23 rows
   * could still be reported by a suite that silently swallowed the rejection.
   */
  it('DELIBERATE VIOLATION: a throwing read IS caught by this harness', async () => {
    const thrower = async (): Promise<never> => {
      throw new Error('an enrichment that fails its caller');
    };
    await expect(thrower()).rejects.toThrow('an enrichment that fails its caller');
  });
});

/**
 * ⚠⚠ TOTALITY IS "NEVER THROWS" — AND NOW, ALSO, "ALWAYS TERMINATES" (WI-6488 FIXED).
 *
 * Every row above proves `readCell` cannot fail its caller by THROWING. Until WI-6488,
 * nothing bounded how long the resolver could take — verified by inspection 2026-07-27:
 * no timeout, no `Promise.race`, no AbortSignal anywhere on the
 * `readCell → dispatchReadOnlyTool → dispatchProjectedTool` path. A resolver that HUNG
 * hung `readCell`, and through it whatever it was decorating.
 *
 * On this module's own stated consumers — "a lock acquire, a claim, a presence read" —
 * that was STRICTLY WORSE than the throw P-026 (f) forbids: a throw is caught by the
 * `catch` in gate 2 and the operation proceeds without its enrichment, but a hang holds
 * the lock. The fix bounds `readCell`'s own WAIT via `withBoundedTimeout` (reused from
 * `bounded-timeout.ts` rather than a hand-rolled race) — see `CELL_READ_TIMEOUT_MS`'s
 * doc comment in `cell-read.ts` for why this bounds the CALLER, not the resolver dispatch
 * itself (`readCell` does not supply the dispatch helper's optional AbortSignal — a
 * resolver that leaks a lock or a connection on its own is a separate bug).
 *
 * This test used to PIN the absent bound (a test asserting a bound that did not exist
 * would have been red forever). Now that the bound exists, it asserts it: a resolver that
 * never settles must not make `readCell` wait past `CELL_READ_TIMEOUT_MS`, and the
 * timed-out read must render as an ENUMERATED unknown — never a throw, never a silent
 * hang — with code `resolver-failed` (the resolver was allowed to look; it just did not
 * finish, so the caller's lever is retry-or-escalate, not "obtain access").
 */
describe('WI-6488 — readCell now BOUNDS a resolver that never settles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a resolver that never settles no longer hangs readCell — it times out as resolver-failed', async () => {
    registerCell(spec());
    let finishResolver!: (value: unknown) => void;
    const dispatch = new Promise<unknown>((resolve) => { finishResolver = resolve; });
    dispatchReadOnlyTool.mockReturnValue(dispatch);

    try {
      const pending = readCell('test.cell', READER, ENV);
      await vi.advanceTimersByTimeAsync(CELL_READ_TIMEOUT_MS);
      const out = await pending;

      expect(out.status).toBe('unknown');
      if (out.status === 'unknown') {
        expect(out.unknown.code).toBe('resolver-failed');
        expect(out.unknown.detail).toMatch(/did not respond within/);
      }
      // The deadline bounds this waiter; the underlying dispatch remains shared
      // until it settles. Do not leave a synthetic hung flight in later tests.
      expect(__resolverInflightCountForTests()).toBe(1);
    } finally {
      finishResolver({ positions: { deployed: true } });
      await dispatch;
    }
    expect(__resolverInflightCountForTests()).toBe(0);
  });

  it('a resolver that settles just under the bound still returns its real value', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ positions: { deployed: true } }), CELL_READ_TIMEOUT_MS - 1);
        }),
    );

    const pending = readCell('test.cell', READER, ENV);
    await vi.advanceTimersByTimeAsync(CELL_READ_TIMEOUT_MS - 1);
    const out = await pending;

    expect(out.status).toBe('value');
    if (out.status === 'value') expect(out.value).toBe(true);
  });
});

/**
 * P-006 — POINTERS, projected.
 *
 * The feature fixes a DISCOVERY failure, not a measurement one: an agent reading
 * `gate.greenCheckpoint.verdict` on a red gate got a correct answer and no route to the
 * cell naming who owns the incident. So the assertions here are about REACHABILITY —
 * which statuses carry the pointer, and whether the two quiet cases stay distinguishable.
 */
describe('readCell — pointers (P-006)', () => {
  const ptr = {
    cell: 'other.cell',
    when: 'the streak is nonzero',
    answers: 'who owns the red and whether that ownership is real',
  };

  /** A registrable target for the pointer to resolve to. */
  const target = (over: Partial<CellSpec> = {}) =>
    spec({ cell: 'other.cell', resolver: 'other-cell-resolver.ts', ...over });

  it('carries the declared pointer on a VALUE read, resolved clean', async () => {
    registerCell(spec({ pointers: [ptr] }));
    registerCell(target());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    // when/answers are CARRIED, not re-derived — a reader must not have to consult the
    // registry to know whether the hop is worth a dispatch.
    if (r.status === 'value') expect(r.pointers).toEqual([ptr]);
  });

  it('carries pointers on an UNKNOWN too — the target has its OWN resolver', async () => {
    // The case this exists for: `gate.greenCheckpoint.verdict` fails to resolve, but
    // `readGateOwnership()` is a different apparatus that has not necessarily failed
    // with it. A reader whose read just broke can still learn who owns the incident.
    registerCell(spec({ pointers: [ptr] }));
    registerCell(target());
    dispatchReadOnlyTool.mockRejectedValue(new ReadOnlyDispatchError('handler_error', 'boom'));

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') expect(r.pointers).toEqual([ptr]);
  });

  it('does NOT carry pointers on ABSENT — a refusal must not enumerate neighbours', async () => {
    // `absent` is load-bearing as a non-oracle (P-019/D-042). Naming this cell's
    // neighbours to a reader who may not see the cell itself would turn the one
    // deliberately-uninformative result into an enumeration surface.
    registerCell(
      spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-other' }, pointers: [ptr] }),
    );
    registerCell(target());

    expect(await readCell('narrow.cell', READER, ENV)).toEqual({ status: 'absent', cell: 'narrow.cell' });
  });

  it('flags a pointer whose target does not resolve', async () => {
    registerCell(spec({ pointers: [ptr] })); // `other.cell` deliberately never registered
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const r = await readCell('test.cell', READER, ENV);

    if (r.status !== 'value') throw new Error('expected a value read');
    expect(r.pointers).toEqual([{ ...ptr, unresolved: true }]);
  });

  /**
   * P-019 CARRIES THROUGH THE POINTER, and this is the test that says so.
   *
   * An earlier draft split these into `drifted` (in no registry) and `hidden` (yours to
   * ask a peer for) because that is more USEFUL. It also re-opened the enumeration
   * oracle `absent` closes: a narrow cell's existence would become observable to a
   * reader who may not see it, via whatever ordinary cell points at it. So the two must
   * be BYTE-IDENTICAL here for the same reason `absent` is byte-identical there.
   */
  it('an OUT-OF-AUDIENCE target is indistinguishable from an unregistered one (P-019)', async () => {
    registerCell(spec({ pointers: [ptr] }));
    registerCell(target({ visibility: { kind: 'owner', ref: 'su-someone-else' } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const outOfAudience = await readCell('test.cell', READER, ENV);

    __resetCellRegistryForTests();
    registerCell(spec({ pointers: [ptr] })); // same pointer, target never registered
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });
    const unregistered = await readCell('test.cell', READER, ENV);

    if (outOfAudience.status !== 'value' || unregistered.status !== 'value') {
      throw new Error('expected value reads');
    }
    // Same SHAPE, not merely both flagged — any field that differed would be the oracle.
    expect(outOfAudience.pointers).toEqual(unregistered.pointers);
    expect(outOfAudience.pointers).toEqual([{ ...ptr, unresolved: true }]);
  });

  it('a target the reader CAN see resolves clean — the flag is not simply always set', async () => {
    // The calibration for the pair above: if `unresolved` were unconditional, both
    // halves of the P-019 test would pass while the pointer measured nothing.
    registerCell(spec({ pointers: [ptr] }));
    registerCell(target({ visibility: { kind: 'workspace' } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const r = await readCell('test.cell', READER, ENV);

    if (r.status !== 'value') throw new Error('expected a value read');
    expect(r.pointers?.[0]).not.toHaveProperty('unresolved');
  });

  it('omits the field entirely when the spec declares none — no empty array to branch on', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    const r = await readCell('test.cell', READER, ENV);

    if (r.status !== 'value') throw new Error('expected a value read');
    expect(r).not.toHaveProperty('pointers');
  });

  it('resolves the pointer WITHOUT dispatching the target — one read stays one dispatch', async () => {
    // A pointer says where to go; it must not fan out. Resolving the target's VALUE here
    // would make one read an unbounded fan-out and re-derive a cell this one does not own.
    registerCell(spec({ pointers: [ptr] }));
    registerCell(
      target({ changeSignal: { kind: 'poll', tool: 'other:tool', path: 'positions.deployed' } }),
    );
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true } });

    await readCell('test.cell', READER, ENV);

    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
    expect(dispatchReadOnlyTool).not.toHaveBeenCalledWith('other:tool', expect.anything(), expect.anything());
  });
});

describe('formatCellPointers — the prose half', () => {
  const ptr = {
    cell: 'gate.greenCheckpoint.ownership',
    when: 'the streak is nonzero',
    answers: 'who owns the red',
  };

  it('is silent on an empty list', () => {
    expect(formatCellPointers([])).toBeNull();
  });

  it('names the cell, its condition, and a ready call', () => {
    const s = formatCellPointers([ptr]) ?? '';
    expect(s).toContain('gate.greenCheckpoint.ownership');
    expect(s).toContain('the streak is nonzero');
    expect(s).toContain("state:read { cell: 'gate.greenCheckpoint.ownership' }");
  });

  it('an UNRESOLVED pointer names BOTH possibilities rather than asserting either', () => {
    const s = formatCellPointers([{ ...ptr, unresolved: true }]) ?? '';
    // It must not claim the cell is missing (a bug report against a fine cell) NOR that
    // it exists (the P-019 leak). `absent`'s own wording is the model.
    expect(s).toMatch(/may not exist/);
    expect(s).toMatch(/outside your audience/i);
    expect(s).toMatch(/ask a peer/i);
    // And it must NOT hand the reader a call that cannot work for them.
    expect(s).not.toContain('state:read {');
  });
});
