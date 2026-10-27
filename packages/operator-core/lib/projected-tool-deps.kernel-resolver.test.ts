import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { pinModuleState } from '@papercusp/module-singleton';
import { acquireSnapshot, beginAcquire, DEFAULT_TX_ACQUIRE_DEADLINE_MS } from '@papercusp/db-org';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { dispatchProjectedTool, type ProjectedTool } from '@papercusp/agent-mcp';
import type { IdentityGrantPolicy } from './capability-envelope/identity-grants-port';
import { isLazyIdentityLaunchRecord } from './capability-envelope/lazy-launch-record';
import * as servingIdentity from './serving-host-identity';
import { mockReturnOnceTyped } from './testing/typed-mock';

const db = vi.hoisted(() => {
  const rows: unknown[][] = [];
  // Fixture rows keep a `launch_spec` field for readability. The anchor query
  // (WI-10002721) no longer selects that column, so the mock returns what
  // PostgreSQL would — jsonb_typeof + the two header fields — and keeps the body
  // aside for the separate body query, which runs only on a cache miss.
  const bodies = new Map<string, { launch_spec: unknown; launch_spec_xmin: string | null }>();
  const loadOverrides: Array<unknown[] | Error> = [];
  const typeOf = (value: unknown) =>
    value === null || value === undefined ? null
      : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
  // `known` is the (id, xmin) the resolver passed back in; like the SQL CASE
  // guards, a row still at that version returns no header at all.
  const toWire = (row: unknown, known: { id: unknown; xmin: unknown }) => {
    if (!row || typeof row !== 'object' || !Object.prototype.hasOwnProperty.call(row, 'launch_spec')) return row;
    const { launch_spec: spec, ...rest } = row as Record<string, unknown>;
    const header = typeOf(spec) === 'object' ? spec as Record<string, unknown> : {};
    if (rest.adv_session_id != null) {
      bodies.set(String(rest.adv_session_id), {
        launch_spec: spec ?? null, launch_spec_xmin: (rest.adv_session_xmin as string | null | undefined) ?? null,
      });
    }
    const skipped = rest.adv_session_id != null && rest.adv_session_xmin != null &&
      known.id === String(rest.adv_session_id) && known.xmin === String(rest.adv_session_xmin);
    return {
      ...rest,
      launch_header_known: known.id == null || known.xmin == null || rest.adv_session_id == null ? null : skipped,
      launch_spec_type: skipped ? null : typeOf(spec),
      launch_spec_workspace_id: skipped ? null : header.workspaceId ?? null,
      launch_spec_harness_slug: skipped ? null : header.harnessSlug ?? null,
      launch_spec_has_accepted_operation: skipped ? null : Object.prototype.hasOwnProperty.call(header, 'acceptedOperation'),
      launch_spec_accepted_operation: skipped ? null : header.acceptedOperation ?? null,
    };
  };
  // The guard's first comparison is `(s.id::text = ${knownId} AND s.xmin::text = ${knownXmin})`.
  const knownFrom = (strings: readonly string[], values: unknown[]) => {
    const at = strings.findIndex((part) => part.endsWith('(s.id::text = '));
    return at < 0 ? { id: null, xmin: null } : { id: values[at], xmin: values[at + 1] };
  };
  const bodyReads: Array<{ advSessionId: unknown; want: unknown }> = [];
  const BODY_READ_MARKER = 'AS launch_spec, n.launch_spec_xmin';
  // The narrowing is a postgres.js FRAGMENT (narrowedLaunchSpecSql,
  // identity-receipt-narrowing.ts, WI-10004801): built with `sql`…`` and never
  // awaited, then interpolated into the body read as its first value. Modelled
  // as a marker carrying the `want` parameter (null = read the record whole).
  const fragment = (strings: readonly string[], values: unknown[]) => {
    const text = strings.join(' ').trim();
    return text === 'n.launch_spec' || text.startsWith('CASE')
      ? { narrowedLaunchSpecFragment: true, want: text === 'n.launch_spec' ? null : values[0] }
      : null;
  };
  const query = async (strings: readonly string[], values: unknown[]) => {
    // The narrowed body read: values are [fragment, advSessionId, ownerId,
    // workspaceId]. The mock applies the module's own JS statement of the
    // narrowing, which the real-PG test holds the SQL to.
    // `AS launch_spec, n.launch_spec_xmin` is unique to the body read; the
    // anchor read also selects `s.xmin::text AS launch_spec_xmin`.
    if (strings.join(' ').includes(BODY_READ_MARKER)) {
      const want = (values[0] as { want: unknown }).want;
      bodyReads.push({ advSessionId: values[1], want });
      const override = loadOverrides.shift();
      if (override instanceof Error) throw override;
      if (override) return override;
      const body = bodies.get(String(values[1]));
      if (!body) return [];
      const { narrowIdentityHistory } = await import('./capability-envelope/identity-receipt-narrowing');
      return [{
        ...body,
        launch_spec: want == null ? body.launch_spec
          : narrowIdentityHistory(body.launch_spec, JSON.parse(String(want)) as unknown[]),
      }];
    }
    const known = knownFrom(strings, values);
    const selectorAt = strings.findIndex((part) => part.endsWith('::bigint IS NULL OR s.id = '));
    const callerAdvSessionId = selectorAt < 0 ? null : values[selectorAt];
    // Model only the real anchor query's owner/workspace predicates. P040's
    // dispatch cases also assert the emitted predicates and bound values;
    // PostgreSQL enforcement belongs to the real-DB sibling suite.
    const ownerAt = strings.findIndex((part) => part.endsWith('WHERE s.coord_owner_id = '));
    const workspaceAt = strings.findIndex((part) => part.endsWith(' AND s.workspace_id = '));
    return (rows.shift() ?? [])
      .filter((row) => {
        const candidate = row as Record<string, unknown>;
        return (ownerAt < 0 || candidate.coord_owner_id == null || candidate.coord_owner_id === values[ownerAt]) &&
          (workspaceAt < 0 || candidate.workspace_id == null || candidate.workspace_id === values[workspaceAt]);
      })
      .filter((row) => callerAdvSessionId == null ||
        (row as Record<string, unknown>).adv_session_id != null &&
        String((row as Record<string, unknown>).adv_session_id) === String(callerAdvSessionId))
      .map((row) => toWire(row, known));
  };
  const sql = vi.fn((strings: readonly string[], ...values: unknown[]) =>
    fragment(strings, values) ?? query(strings, values));
  const release = vi.fn();
  const reserve = vi.fn(async () => sql);
  Object.assign(sql, { reserve, release });
  /** Real queries only: a fragment build is not a round trip to PostgreSQL. */
  const queryCalls = () => sql.mock.calls.filter(([strings, ...values]) => !fragment(strings, values));
  const isBodyRead = (template: unknown) => (template as readonly string[]).join(' ').includes(BODY_READ_MARKER);
  return { rows, sql, reserve, release, queryCalls, isBodyRead, bodies, bodyReads, loadOverrides, failClient: false };
});
const grants = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn(async () => true), kernelThrows: false }));
// Keep artifact validation and policy evaluation real; inject only policy I/O.
vi.mock('./capability-envelope/identity-grants-port', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./capability-envelope/identity-grants-port')>();
  return {
    ...actual,
    checkIdentityGrantKernel: (
      request: KernelEnforcementRequest, state: never, record: unknown,
      _readPolicy: unknown, _readClaim: unknown,
      onUngovernedEvaluated?: Parameters<typeof actual.checkIdentityGrantKernel>[5],
    ) => {
      // Stands in for the whole class the resolver's catch exists for: the gate
      // is reached by DYNAMIC import, so a module that fails to load and one
      // that throws are the same event from the caller's side. Defaults off.
      if (grants.kernelThrows) throw new Error('identity policy module unavailable');
      return actual.checkIdentityGrantKernel(request, state, record, grants.read, grants.claim, onUngovernedEvaluated);
    },
  };
});

// Keep the real db-org exports available to the import graph; only the lazy
// query seam is replaced so these tests exercise the actual resolver logic.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    if (db.failClient) throw new Error('client unavailable');
    return { sql: db.sql as never };
  },
}));

// EI-23703586803892464: the authority-safe writer is exercised against real PG in
// session-identity-attribution.integration.test.ts; here only its verdict is
// injected (through the resolver's own seam — a vi.mock of the dynamic import
// does not reach the call site) so the heal-then-re-resolve contract is observable.
const heal = { converge: vi.fn(async (..._args: unknown[]) => false) };

import {
  controlAnchorKernelResolver,
  installControlAnchorKernelResolver,
  operatorKernelEnforcement,
  readControlAnchorKernelState,
  setKernelEnforcementResolver,
  setStaleArtifactConverger,
  STALE_ARTIFACT_HEAL_RETRY_MS,
  wrapOperatorKernelSpawn,
} from './projected-tool-deps';
import type { KernelEnforcementRequest, UnifiedToolContext } from '@papercusp/agent-mcp';

const PLAIN_ARTIFACT = compileAgentSpecification({
  source: { id: 'kernel-plain', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
  prompt: { role: 'worker', text: 'Plain.' },
});
const PREDECESSOR_ARTIFACT = compileAgentSpecification({
  source: { id: 'kernel-predecessor', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
  prompt: { role: 'worker', text: 'Re-armed predecessor.' },
});
const REVISION_A = {
  specificationRevision: PLAIN_ARTIFACT.specificationRevision,
  stateRevision: 'state-a',
};
const REVISION_B = {
  specificationRevision: 'b'.repeat(64),
  stateRevision: 'state-b',
};

function ctx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return {
    workspaceId: 'ws-a',
    isSuperuser: true,
    uiClientId: 'owner-a',
    ...over,
  } as UnifiedToolContext;
}

function request(over: Partial<KernelEnforcementRequest> = {}): KernelEnforcementRequest {
  return {
    phase: 'enforce',
    boundary: 'dispatch',
    toolName: 'plans:set-status',
    capabilities: ['plans:write'],
    args: { slug: 'p' },
    ctx: ctx(),
    ...over,
  };
}

function anchorRow(control_state: unknown, over: Record<string, unknown> = {}) {
  return {
    control_state,
    control_generation: 9,
    workspace_id: 'ws-a',
    adv_session_id: 1,
    launch_spec: {
      workspaceId: 'ws-a', harnessSlug: 'sales', ...REVISION_A,
      specificationArtifact: PLAIN_ARTIFACT,
    },
    ...over,
  };
}

function appliedActivation(revision = REVISION_A) {
  return {
    schemaVersion: 1,
    attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
    desired: revision,
    prepared: null,
    applied: revision,
    status: 'applied',
  };
}

beforeEach(() => {
  db.rows.splice(0, db.rows.length);
  db.bodies.clear();
  db.bodyReads.splice(0, db.bodyReads.length);
  db.loadOverrides.splice(0, db.loadOverrides.length);
  // The identity-resolution cache is process-pinned; a verdict cached by one
  // test must not turn the next test's miss into a hit.
  pinModuleState('@papercusp/operator-core.identity-resolution-cache', () => new Map<string, unknown>()).clear();
  pinModuleState('@papercusp/operator-core.identity-launch-header-memo', () => new Map<string, unknown>()).clear();
  pinModuleState('@papercusp/operator-core.projected-tool-deps.staleArtifactHeal',
    () => ({ attempts: new Map<string, number>() })).attempts.clear();
  heal.converge.mockReset().mockResolvedValue(false);
  setStaleArtifactConverger(heal.converge as never);
  db.sql.mockClear();
  db.reserve.mockClear().mockImplementation(async () => db.sql);
  db.release.mockClear();
  db.failClient = false;
  grants.read.mockReset();
  grants.claim.mockReset().mockResolvedValue(true);
  setKernelEnforcementResolver(null);
});

afterAll(() => setStaleArtifactConverger(null));

describe('control-anchor kernel resolver (D-030)', () => {
  it('reads only the caller workspace and preserves the applied revision attribution', async () => {
    db.rows.push(
      [anchorRow({ activation: appliedActivation() })],
      [anchorRow({ activation: appliedActivation() })],
    );

    const state = await readControlAnchorKernelState(request());
    expect(state).toMatchObject({
      appliedRevision: REVISION_A,
      policyRevision: 'control:9',
    });
    expect(db.sql).toHaveBeenCalledOnce();
    const [template, ...values] = db.sql.mock.calls[0] as unknown[];
    expect((template as readonly string[]).join(' ')).toContain('workspace_id =');
    // WI-10002721: the anchor read carries the launch record's header, never its
    // body, and no longer serialises the whole adv_sessions row to reach it.
    const anchorSql = (template as readonly string[]).join(' ');
    // The outer SELECT reads a.id; omitting s.id from this derived table makes
    // every authority read fail closed before the tool can run.
    expect(anchorSql).toMatch(/FULL JOIN \(\s*SELECT s\.id\b/);
    expect(anchorSql).toContain('ELSE jsonb_typeof(s.launch_spec) END AS launch_spec_type');
    expect(anchorSql).toContain("ELSE s.launch_spec->'workspaceId' END AS launch_spec_workspace_id");
    expect(anchorSql).toContain("ELSE s.launch_spec->'harnessSlug' END AS launch_spec_harness_slug");
    expect(anchorSql).not.toContain('to_jsonb(s)');
    expect(anchorSql).not.toMatch(/\ba\.launch_spec\s*,/);
    // ...and even the header is skipped while the row is at a version already seen.
    expect(anchorSql).toContain('CASE WHEN s.id::text =');
    expect(values).toContain('ws-a');

    const verdict = await controlAnchorKernelResolver(request());
    expect(verdict).toMatchObject({
      decision: 'allow',
      availability: 'available',
      revisionSource: 'applied',
      executionRevision: REVISION_A,
      policyRevision: 'control:9',
    });
  });

  it('records successful control-anchor SQL and identity-grant evaluation timings', async () => {
    const queryStart = '2026-10-14T23:00:00.000Z';
    db.rows.push([anchorRow({ activation: appliedActivation() }, {
      backend_pid: 73142,
      query_start: queryStart,
    })]);

    const verdict = await controlAnchorKernelResolver(request());

    expect(verdict).toMatchObject({
      decision: 'allow',
      serverAudit: {
        authorityTimings: {
          schemaVersion: 1,
          controlAnchorSql: {
            calls: 1,
            totalMs: expect.any(Number),
            executions: [{
              queryFingerprint: 'controlAnchorSql/v1',
              traceId: expect.stringMatching(/^[a-f0-9-]{36}$/),
              backendPid: 73142,
              queryStart,
              poolAcquisitionMs: expect.any(Number),
              clientQueryMs: expect.any(Number),
              clientCompletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
              outcome: 'fulfilled',
            }],
          },
          identityGrantEvaluation: { calls: 1, totalMs: expect.any(Number) },
        },
      },
    });
    const timings = verdict?.serverAudit?.authorityTimings as Record<string, unknown>;
    const [anchorQuery] = db.queryCalls()[0] as [readonly string[], ...unknown[]];
    expect(anchorQuery.join(' ')).toContain('/* papercusp:controlAnchorSql/v1 */');
    expect(anchorQuery.join(' ')).toContain('pg_backend_pid() AS backend_pid');
    expect(anchorQuery.join(' ')).toContain('statement_timestamp() AS query_start');
    expect(JSON.stringify(timings)).not.toMatch(/ws-a|SELECT|launch_spec/i);
    expect(db.reserve).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('bounds control-anchor pool acquisition and releases a client that arrives after the deadline', async () => {
    vi.useFakeTimers();
    type ReservedConnection = Awaited<ReturnType<typeof db.reserve>>;
    let resolveLateConnection: (connection: ReservedConnection) => void = () => {};
    const pendingConnection = new Promise<ReservedConnection>((resolve) => {
      resolveLateConnection = resolve;
    });
    mockReturnOnceTyped(db.reserve, pendingConnection);

    try {
      const pendingVerdict = controlAnchorKernelResolver(request());
      await vi.advanceTimersByTimeAsync(DEFAULT_TX_ACQUIRE_DEADLINE_MS + 1);
      const verdict = await pendingVerdict;

      expect(verdict).toMatchObject({
        decision: 'deny',
        serverAudit: {
          authorityTimings: {
            controlAnchorSql: {
              calls: 1,
              executions: [{
                outcome: 'rejected',
                poolAcquisitionMs: expect.any(Number),
                clientQueryMs: null,
                clientCompletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                acquisitionDiagnostics: {
                  coverage: 'registered-acquisition-tickets-only',
                  before: { counters: { pool: 'org-admin' } },
                  settled: { counters: { pool: 'org-admin' } },
                },
              }],
            },
          },
        },
      });
      expect(db.reserve).toHaveBeenCalledOnce();
      expect(db.sql).not.toHaveBeenCalled();

      resolveLateConnection(db.sql);
      await pendingConnection;
      await Promise.resolve();
      expect(db.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains bounded pool queue evidence from before and after a delayed authority acquisition', async () => {
    const baseline = acquireSnapshot('org-admin');
    const holder = beginAcquire('org-admin');
    holder.acquired();
    const waiter = beginAcquire('org-admin');
    let resolveConnection!: (connection: typeof db.sql) => void;
    const pendingConnection = new Promise<typeof db.sql>((resolve) => { resolveConnection = resolve; });
    mockReturnOnceTyped(db.reserve, pendingConnection);
    db.rows.push([anchorRow({ activation: appliedActivation() })]);

    try {
      const pendingVerdict = controlAnchorKernelResolver(request());
      await vi.waitFor(() => expect(db.reserve).toHaveBeenCalledOnce());
      resolveConnection(db.sql);
      const verdict = await pendingVerdict;
      const timings = verdict?.serverAudit?.authorityTimings as {
        controlAnchorSql: { executions: Array<{ acquisitionDiagnostics: {
          coverage: string;
          before: { counters: ReturnType<typeof acquireSnapshot>; tickets: { tickets: unknown[] } };
          settled: { counters: ReturnType<typeof acquireSnapshot>; tickets: { tickets: unknown[] } };
        } }> };
      };
      const diagnostics = timings.controlAnchorSql.executions[0].acquisitionDiagnostics;
      expect(verdict).toMatchObject({ decision: 'allow', availability: 'available' });
      expect(diagnostics).toMatchObject({
        coverage: 'registered-acquisition-tickets-only',
        before: { counters: { held: baseline.held + 1, waiting: baseline.waiting + 1 } },
        settled: { counters: { held: baseline.held + 2, waiting: baseline.waiting + 1 } },
      });
      expect(diagnostics.before.tickets.tickets).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'held' }),
        expect.objectContaining({ state: 'waiting' }),
      ]));
      expect(diagnostics.settled.tickets.tickets.length).toBeLessThanOrEqual(8);
      holder.release();
      waiter.release();
      // Retained evidence is a value snapshot, not a later view of the registry.
      expect(diagnostics.before.counters.held).toBe(baseline.held + 1);
      expect(acquireSnapshot('org-admin').held).toBe(baseline.held);
      expect(db.release).toHaveBeenCalledOnce();
      expect(JSON.stringify(diagnostics)).not.toMatch(/ws-a|SELECT|launch_spec/i);
    } finally {
      resolveConnection(db.sql);
      holder.release();
      waiter.release();
    }
  });

  it('selects the verified native caller row instead of a newer re-armed predecessor', async () => {
    db.rows.push([
      anchorRow({ activation: appliedActivation() }, {
        adv_session_id: 31595, adv_session_xmin: '901',
      }),
      anchorRow({ activation: appliedActivation() }, {
        adv_session_id: 32433, adv_session_xmin: '902',
      }),
    ]);

    const state = await readControlAnchorKernelState(request({
      ctx: ctx({ advSessionId: 32433 }),
    }));

    expect(state?.identityLaunchRecordVersion).toEqual({ sessionId: '32433', rowVersion: '902' });
    const [template, ...values] = db.sql.mock.calls[0] as unknown[];
    const anchorSql = (template as readonly string[]).join(' ');
    expect(anchorSql).toContain('OR s.id = ');
    expect(values).toContain(32433);
  });

  it('distinguishes tools:find preflight on a re-armed predecessor from the verified native incarnation', async () => {
    const predecessor = anchorRow({ activation: appliedActivation() }, {
      adv_session_id: 31595,
      adv_session_xmin: '901',
      started_at: '2026-10-03T10:00:00.000Z',
      ended_at: null,
      ended_by: null,
      launch_spec: {
        workspaceId: 'ws-a',
        harnessSlug: 'sales',
        specificationRevision: PREDECESSOR_ARTIFACT.specificationRevision,
        stateRevision: REVISION_A.stateRevision,
        specificationArtifact: PREDECESSOR_ARTIFACT,
      },
    });
    const current = anchorRow({ activation: appliedActivation() }, {
      adv_session_id: 32433,
      adv_session_xmin: '902',
      started_at: '2026-10-03T09:00:00.000Z',
      ended_at: null,
      ended_by: null,
    });
    const toolsFindPreflight = (advSessionId?: number) => request({
      toolName: 'tools:find',
      capabilities: ['agent_tools:read'],
      args: { query: 'fixture' },
      ctx: ctx(advSessionId === undefined ? {} : { advSessionId }),
    });

    // Owner-only SQL elects the latest immutable registration despite the
    // predecessor's resume timestamp. An explicitly bound old caller still
    // judges its own receipt and must fail closed below.
    db.rows.push([current, predecessor]);
    const ownerOnlyState = await readControlAnchorKernelState(toolsFindPreflight());
    expect(ownerOnlyState?.identityLaunchRecordVersion).toEqual({ sessionId: '32433', rowVersion: '902' });
    const [ownerOnlyTemplate] = db.sql.mock.calls[0] as unknown[];
    expect((ownerOnlyTemplate as readonly string[]).join(' ')).toContain(
      'ORDER BY s.id DESC',
    );

    db.rows.push([current, predecessor]);
    await expect(controlAnchorKernelResolver(toolsFindPreflight())).resolves.toMatchObject({
      decision: 'allow',
      serverAudit: {
        identityLaunchRecord: { advSessionId: '32433', xmin: '902' },
      },
    });

    db.rows.push([predecessor, current]);
    await expect(controlAnchorKernelResolver(toolsFindPreflight(31595))).resolves.toMatchObject({
      decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
      serverAudit: {
        identityLaunchRecordSelection: {
          advSessionId: '31595', rowVersion: '901', selection: 'caller-row',
        },
      },
    });

    // A transport-verified native session binds the preflight to the current row.
    db.rows.push([predecessor, current]);
    await expect(controlAnchorKernelResolver(toolsFindPreflight(32433))).resolves.toMatchObject({
      decision: 'allow',
      serverAudit: { identityLaunchRecord: { advSessionId: '32433', xmin: '902' } },
    });
  });

  it('fails closed when the verified native caller row is missing', async () => {
    db.rows.push([
      anchorRow({ activation: appliedActivation() }, {
        adv_session_id: 31595, adv_session_xmin: '901',
      }),
    ]);

    const denied = await controlAnchorKernelResolver(request({
      ctx: ctx({ advSessionId: 32433 }),
    }));
    expect(denied).toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityUnavailableSources: ['verified-caller-row-unavailable'] },
    });
    expect(denied?.serverAudit?.identityLaunchRecord).toBeUndefined();
  });

  it.each([
    { caller: undefined, selected: 541, selection: 'owner-workspace-fallback' },
    { caller: 541, selected: 541, selection: 'caller-row' },
    { caller: 543, selected: 543, selection: 'caller-row' },
  ])('audits $selection for source incarnation $selected on misses and cache hits', async ({ caller, selected, selection }) => {
    const source = anchorRow({ activation: appliedActivation() }, {
      adv_session_id: 541, adv_session_xmin: '901', port_id: null,
    });
    // A same-owner port is a legitimate source incarnation, not an isolated
    // answerer. Its presence must not force attribution to the original row.
    const continuation = anchorRow({ activation: appliedActivation() }, {
      adv_session_id: 543, adv_session_xmin: '903', port_id: 'same-owner-port',
    });
    const call = request({ ctx: ctx(caller === undefined ? {} : { advSessionId: caller }) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      db.rows.push([source, continuation]);
      const verdict = await controlAnchorKernelResolver(call);
      expect(verdict?.decision).toBe('allow');
      expect(verdict?.serverAudit?.identityLaunchRecord).toEqual({
        advSessionId: String(selected), xmin: selected === 541 ? '901' : '903', selection,
      });
    }
    expect(db.bodyReads).toHaveLength(1);
  });

  it('carries the database-owned launch row version into identity enforcement', async () => {
    const launchRow = anchorRow({ activation: appliedActivation() }, {
      adv_session_id: 27, adv_session_xmin: '1549',
    });
    db.rows.push([launchRow]);
    const state = await readControlAnchorKernelState(request());
    expect(state?.identityLaunchRecordVersion).toEqual({ sessionId: '27', rowVersion: '1549' });
    const [template] = db.sql.mock.calls[0] as unknown[];
    expect((template as readonly string[]).join(' ')).toContain("s.xmin::text AS launch_spec_xmin");
    const handle = state?.identityLaunchRecord;
    if (!isLazyIdentityLaunchRecord(handle)) throw new Error('expected a lazy launch record');
    expect(await handle.load()).toEqual({ record: launchRow.launch_spec, rowVersion: '1549' });
    const [bodyTemplate, ...bodyParams] = db.queryCalls()[1] as unknown[];
    expect(db.isBodyRead(bodyTemplate)).toBe(true);
    const bodySql = (bodyTemplate as readonly string[]).join(' ');
    expect(bodySql).toContain('s.xmin::text AS launch_spec_xmin');
    expect(bodySql).toContain('FROM harness_shared.adv_sessions s');
    // No receipts requested ⇒ `want` is null ⇒ the record is read whole.
    expect(bodyParams).toEqual([{ narrowedLaunchSpecFragment: true, want: null }, 27, 'owner-a', 'ws-a']);
  });

  // WI-10004801 (#1155): the body read narrows identityHistory to the receipt
  // the gate will select. A retained history entry is ~1 MB, so shipping all of
  // them to the request worker is what spiked worker heaps.
  it('asks PostgreSQL for only the applied receipt on a cache miss, and still resolves from history', async () => {
    const current = anchorRow({ activation: appliedActivation() }).launch_spec as Record<string, unknown>;
    // The top-level record is at a later STATE revision, so the applied receipt
    // (REVISION_A) must come from identityHistory. One unrelated entry must not
    // survive the narrowing; the matching one must.
    const spec = {
      ...current,
      stateRevision: 'state-later',
      identityHistory: [
        { specificationRevision: 'c'.repeat(64), stateRevision: 'state-c', specificationArtifact: { bulky: 'x'.repeat(64) } },
        {
          specificationRevision: REVISION_A.specificationRevision,
          stateRevision: REVISION_A.stateRevision,
          specificationArtifact: current.specificationArtifact,
        },
      ],
    };
    db.rows.push([anchorRow({ activation: appliedActivation() }, {
      adv_session_id: 41, adv_session_xmin: '4100', launch_spec: spec,
    })]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
    expect(db.bodyReads).toHaveLength(1);
    expect(db.bodyReads[0]).toEqual({
      advSessionId: 41,
      want: JSON.stringify([{
        specificationRevision: REVISION_A.specificationRevision, stateRevision: REVISION_A.stateRevision,
      }]),
    });
    const { narrowIdentityHistory } = await import('./capability-envelope/identity-receipt-narrowing');
    const narrowed = narrowIdentityHistory(spec, [REVISION_A]) as { identityHistory: Array<{ stateRevision: string }> };
    expect(narrowed.identityHistory.map((entry) => entry.stateRevision)).toEqual([REVISION_A.stateRevision]);
  });

  // WI-10002721 — the recurrence guard for the per-call body read. Every
  // preflight used to select and JSON-parse the whole launch_spec (live avg
  // 884KB, max 3.9MB) even when identityResolutionCache already held the
  // verdict for that exact row version.
  describe('launch record body is read only on an identity-resolution cache miss (WI-10002721)', () => {
    const bodyReads = () => db.queryCalls().filter(([template]) => db.isBodyRead(template)).length;
    const rowAt = (xmin: string, over: Record<string, unknown> = {}) =>
      anchorRow({ activation: appliedActivation() }, { adv_session_id: 31, adv_session_xmin: xmin, ...over });

    it('reads the body once, then answers a repeat preflight on the same row version from the cache', async () => {
      db.rows.push([rowAt('700')], [rowAt('700')]);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
      expect(bodyReads()).toBe(1);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
      expect(bodyReads()).toBe(1);
      // Two anchor reads + one body read: the hit issued no body query at all.
      // (Fragment builds are not queries; queryCalls() excludes them.)
      expect(db.queryCalls()).toHaveLength(3);
      // The body query stays scoped to the anchor's owner and workspace.
      const bodyCall = db.queryCalls().find(([template]) => db.isBodyRead(template))!;
      expect(bodyCall.slice(1)).toEqual([
        {
          narrowedLaunchSpecFragment: true,
          want: JSON.stringify([{ specificationRevision: REVISION_A.specificationRevision, stateRevision: REVISION_A.stateRevision }]),
        },
        31, 'owner-a', 'ws-a',
      ]);
    });

    it('reads the body again when the launch row version changes', async () => {
      db.rows.push([rowAt('700')], [rowAt('701')]);
      await controlAnchorKernelResolver(request());
      await controlAnchorKernelResolver(request());
      expect(bodyReads()).toBe(2);
    });

    // D-007: PLAIN_ARTIFACT carries no configuration.grants — the shape of every
    // live session — so the structural verdict stands and must name its row.
    it('persists the evaluated launch row on an ungoverned allow, on the miss and on the cache hit', async () => {
      db.rows.push([rowAt('700')], [rowAt('700')]);
      const serverAudit = { identityLaunchRecord: { advSessionId: '31', xmin: '700' } };
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow', serverAudit });
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow', serverAudit });
      expect(bodyReads()).toBe(1);
    });

    it('names the row version the body was actually read at on an ungoverned miss', async () => {
      const spec = anchorRow({}).launch_spec;
      db.rows.push([rowAt('820')]);
      db.loadOverrides.push([{ launch_spec: spec, launch_spec_xmin: '821' }]);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
        decision: 'allow',
        serverAudit: { identityLaunchRecord: { advSessionId: '31', xmin: '821' } },
      });
    });

    it('keys a miss on the row version the body was read at, not the header read', async () => {
      const spec = anchorRow({}).launch_spec;
      db.rows.push([rowAt('800')]);
      db.loadOverrides.push([{ launch_spec: spec, launch_spec_xmin: '801' }]);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
      expect(bodyReads()).toBe(1);
      // A preflight whose header is at the version the body was judged at hits.
      db.rows.push([rowAt('801')]);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
      expect(bodyReads()).toBe(1);
    });

    it('refuses a tampered loaded body despite a previously valid header when the row changes between reads', async () => {
      const changedBody = {
        ...anchorRow({}).launch_spec as Record<string, unknown>, specificationArtifact: { tampered: true },
      };
      db.rows.push([rowAt('810')]);
      db.loadOverrides.push([{ launch_spec: changedBody, launch_spec_xmin: '811' }]);
      const verdict = await controlAnchorKernelResolver(request());
      expect(verdict).toMatchObject({
        decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
      });
      expect(bodyReads()).toBe(1);
    });

    it('never reads the body for a non-object launch_spec, and still refuses it as stale-artifact', async () => {
      db.rows.push([rowAt('900', { launch_spec: 'not-a-record' })]);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
        decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
      });
      expect(bodyReads()).toBe(0);
    });

    it('refuses as stale-artifact when the row stops being a usable record between the two reads', async () => {
      db.rows.push([rowAt('910')]);
      db.loadOverrides.push([]);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
        decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
      });
    });

    // The header is cheaper than the body but still costs PostgreSQL a full
    // detoast of the TOASTed value, so an unchanged row version skips it too.
    it('passes the last-seen row version back so PostgreSQL skips the header detoast', async () => {
      db.rows.push([rowAt('700')], [rowAt('700')]);
      await controlAnchorKernelResolver(request());
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
      const anchorCalls = db.sql.mock.calls.filter(([template]) =>
        (template as readonly string[]).join(' ').includes('FROM harness_shared.session_briefs'));
      expect(anchorCalls).toHaveLength(2);
      const known = (call: unknown[]) => {
        const strings = call[0] as readonly string[];
        const at = strings.findIndex((part) => part.endsWith('(s.id::text = '));
        return [call[1 + at], call[2 + at]];
      };
      expect(known(anchorCalls[0])).toEqual([null, null]);
      expect(known(anchorCalls[1])).toEqual(['31', '700']);
      // The skipped header was served from the memo, and the verdict from the
      // identity-resolution cache, so the body was still read exactly once.
      expect(bodyReads()).toBe(1);
    });

    it('serves a skipped header from the memo and re-reads it once the launch row version moves', async () => {
      db.rows.push([rowAt('700')], [rowAt('700')], [rowAt('702', {
        launch_spec: { ...anchorRow({}).launch_spec as Record<string, unknown>, workspaceId: 'ws-other' },
      })]);
      const header = (state: Awaited<ReturnType<typeof readControlAnchorKernelState>>) => {
        const { isObject, workspaceId, harnessSlug } = state?.identityLaunchRecord as Record<string, unknown>;
        return { isObject, workspaceId, harnessSlug };
      };
      const first = await readControlAnchorKernelState(request());
      const skipped = await readControlAnchorKernelState(request());
      const moved = await readControlAnchorKernelState(request());
      expect(header(first)).toEqual({ isObject: true, workspaceId: 'ws-a', harnessSlug: 'sales' });
      // The wire row carried no header (PostgreSQL skipped it); the memo supplied it.
      expect(header(skipped)).toEqual({ isObject: true, workspaceId: 'ws-a', harnessSlug: 'sales' });
      // A new row version is read afresh: a stale memo would still say ws-a.
      expect(header(moved)).toEqual({ isObject: true, workspaceId: 'ws-other', harnessSlug: 'sales' });
      expect(bodyReads()).toBe(0);
    });

    it('fails closed when the body read itself fails', async () => {
      db.rows.push([rowAt('920')]);
      db.loadOverrides.push(new Error('adv_sessions read failed'));
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
        decision: 'deny', code: 'policy-unavailable',
      });
    });
  });

  it('keeps a prepared revision visible but does not treat it as applied execution truth', async () => {
    db.rows.push([
      anchorRow({
        activation: {
          schemaVersion: 1,
          attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
          desired: REVISION_A,
          prepared: REVISION_A,
          applied: null,
          status: 'prepared',
        },
      }),
    ]);

    const verdict = await controlAnchorKernelResolver(request());
    expect(verdict).toMatchObject({ decision: 'allow', revisionSource: 'prepared', executionRevision: REVISION_A });
  });

  it('denies an explicitly requested stale revision while allowing soft desired updates', async () => {
    db.rows.push([anchorRow({ activation: appliedActivation() })]);
    await expect(controlAnchorKernelResolver(request({ requestedRevision: REVISION_B }))).resolves.toMatchObject({
      decision: 'deny',
      code: 'stale-activation',
    });

    db.rows.push([anchorRow({
      activation: {
        schemaVersion: 1,
        attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
        desired: REVISION_B,
        prepared: null,
        applied: REVISION_A,
        status: 'desired',
      },
    })]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'allow',
      revisionSource: 'applied',
      executionRevision: REVISION_A,
    });
  });

  it.each([
    ['a durable release marker', { lifecycle: { released: { fleet: 'f', at: 'now', by: 'leader' } } }],
    ['a malformed release marker', { lifecycle: { released: null } }],
    ['a malformed activation', { activation: { status: 'applied' } }],
  ])('fails closed on %s', async (_label, controlState) => {
    db.rows.push([anchorRow(controlState)], [anchorRow(controlState)]);
    const state = await readControlAnchorKernelState(request());
    expect(state?.revoked).toBe(true);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny',
      code: 'revoked',
    });
  });

  it('denies a revoked power-user session, but treats an absent optional row as unavailable', async () => {
    db.rows.push([], [{ revoked_at: new Date('2026-09-05T00:00:00Z') }]);
    await expect(controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }))).resolves.toMatchObject({ decision: 'deny', code: 'revoked' });

    db.rows.push([], []);
    const available = await controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }));
    expect(available).toMatchObject({
      decision: 'allow',
      availability: 'unavailable',
    });
  });

  it('fails closed when the authority read fails, distinguishing failure from an absent legacy row', async () => {
    db.sql.mockRejectedValueOnce(new Error('migration not applied'));
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny',
      code: 'policy-unavailable',
      serverAudit: { authorityUnavailableSources: ['control-anchor-query-failed'] },
    });
    db.rows.push([]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow', availability: 'unavailable' });
  });

  it.each(['55P03', '57014', '08006'])('retains SQLSTATE %s on the failed authority read without exposing SQL or parameters', async (pgCode) => {
    db.sql.mockRejectedValueOnce(Object.assign(new Error('private SQL and credential'), {
      code: pgCode, query: 'SELECT private_value', parameters: ['secret'], detail: 'private detail',
      servingPid: -1, servingProcessId: 'untrusted-error-identity',
    }));
    const verdict = await controlAnchorKernelResolver(request());
    expect(verdict).toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityReadFailures: [{ source: 'control-anchor-query-failed', pgCode }] },
    });
    const failures = verdict?.serverAudit?.authorityReadFailures as Array<Record<string, unknown>>;
    expect(failures).toHaveLength(1);
    expect(Object.keys(failures[0]).sort()).toEqual(['elapsedMs', 'pgCode', 'servingPid', 'servingProcessId', 'source']);
    expect(failures[0].servingPid).toBe(process.pid);
    expect(failures[0].servingProcessId).toBe(servingIdentity.getServingHostIdentity().processId);
    expect(failures[0].elapsedMs).toEqual(expect.any(Number));
    expect(failures[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(verdict?.serverAudit)).not.toMatch(/private|secret|SELECT/);
  });

  it.each(['missing', 'throws'])('preserves denial when the serving process identity %s', async (mode) => {
    const identity = vi.spyOn(servingIdentity, 'getServingHostIdentity');
    if (mode === 'throws') identity.mockImplementation(() => { throw new Error('identity unavailable'); });
    else identity.mockReturnValue({ host: 'fixture', processId: null, buildSha: null });
    try {
      db.sql.mockRejectedValueOnce(Object.assign(new Error('private lock error'), { code: '55P03' }));
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
        decision: 'deny', code: 'policy-unavailable',
        serverAudit: { authorityReadFailures: [{
          source: 'control-anchor-query-failed', pgCode: '55P03',
          servingPid: process.pid, servingProcessId: null,
        }] },
      });
    } finally {
      identity.mockRestore();
    }
  });

  it.each([undefined, 55_003, 'ERR_CONNECTION_RESET', '55P03 private'])('keeps an unclassified authority failure explicit for code %s', async (code) => {
    db.sql.mockRejectedValueOnce(Object.assign(new Error('private error'), { code }));
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityReadFailures: [{ source: 'control-anchor-query-failed', pgCode: null }] },
    });
  });

  it('preserves the denial even when inspecting an error code throws', async () => {
    const error = Object.defineProperty(new Error('private error'), 'code', {
      get() { throw new Error('diagnostic unavailable'); },
    });
    db.sql.mockRejectedValueOnce(error);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityReadFailures: [{ source: 'control-anchor-query-failed', pgCode: null }] },
    });
  });

  it('attributes independent control and revocation SQL failures to their own reads', async () => {
    db.sql.mockRejectedValueOnce(Object.assign(new Error('control locked'), { code: '55P03' }))
      .mockRejectedValueOnce(Object.assign(new Error('revocation canceled'), { code: '57014' }));
    await expect(controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }))).resolves.toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityReadFailures: [
        { source: 'control-anchor-query-failed', pgCode: '55P03' },
        { source: 'power-user-revocation-query-failed', pgCode: '57014' },
      ] },
    });
  });

  it('audits a database lock refusal at dispatch without running the handler', async () => {
    db.sql.mockRejectedValueOnce(Object.assign(new Error('control locked'), { code: '55P03' }));
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'effect' }] }));
    const recordInvocation = vi.fn(async () => {});
    const result = await dispatchProjectedTool({
      pluginName: 'fixture', description: 'fixture', inputSchema: { type: 'object' },
      capabilities: [], expose: { mcp: { name: 'mail:send' } }, fn: handler,
    } as ProjectedTool, 'mail:send', {}, ctx(), { kernelEnforcement: controlAnchorKernelResolver, recordInvocation });
    expect(result.ok).toBe(false);
    expect(recordInvocation).toHaveBeenCalledOnce();
    expect(recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      kernelPreflight: expect.objectContaining({
        decision: 'deny',
        serverAudit: expect.objectContaining({
          authorityReadFailures: [{
            source: 'control-anchor-query-failed', pgCode: '55P03', elapsedMs: expect.any(Number),
            servingPid: process.pid, servingProcessId: servingIdentity.getServingHostIdentity().processId,
          }],
        }),
      }),
    }));
    expect(handler).not.toHaveBeenCalled();
  });

  // The compaction watchdog writes a session_briefs row (carry + control_state,
  // NO activation) for the session it force-compacts. For a launch that never
  // registered an adv_sessions row — every consult-expiry-sweep `psu --fork`
  // measured 2026-09-23 — that write turned an ungoverned session into one
  // denied every verb with `no-launch-record`, while the wedged-identity sweep
  // (no applied receipt ⇒ legacy) reported nothing. No activation means nothing
  // was ever acknowledged, so there is no receipt for a launch row to be missing
  // FROM: this is the legacy path, exactly like an absent session_briefs row.
  it('treats a control anchor with no activation and no adv_sessions row as legacy, not no-launch-record', async () => {
    db.rows.push([{
      control_state: { modes: ['auto'], loop: { active: false }, carry: 'cold' },
      control_generation: 1,
      workspace_id: 'ws-a',
      adv_session_id: null,
      launch_spec: null,
    }]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'allow', availability: 'unavailable', applied: false,
    });
  });

  it('opens only coord:orient when the control anchor has no adv_sessions launch row', async () => {
    const missing = {
      control_state: { activation: appliedActivation() },
      control_generation: 9,
      workspace_id: 'ws-a',
      adv_session_id: null,
      launch_spec: null,
    };
    db.rows.push([missing]);
    await expect(controlAnchorKernelResolver(request({ toolName: 'coord:orient' }))).resolves.toMatchObject({
      decision: 'allow', code: 'identity-recovery', applied: false,
    });

    db.rows.push([missing]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'capability_unsatisfied',
      obligations: { capabilityUnsatisfied: { cause: 'no-launch-record' } },
    });

    // WI-10002028: a real adv_sessions row with no usable launch_spec is still
    // `stale-artifact` rather than `no-launch-record` — the two causes stay
    // distinct, so an operator is never sent chasing a revision mismatch that
    // never existed. What changed is the DISPOSITION of that cause for the
    // recovery verb alone: `stale-artifact` says the identity plane cannot
    // establish WHICH specification is in force, never that this session lacks
    // authority to orient. coord:orient is acknowledgeControlTransition's sole
    // caller, so sealing it here bricked the session for its entire life with no
    // in-band way back. It now opens through the stale-artifact recovery door.
    db.rows.push([{ ...missing, adv_session_id: 7 }]);
    await expect(controlAnchorKernelResolver(request({ toolName: 'coord:orient' }))).resolves.toMatchObject({
      decision: 'allow', code: 'identity-recovery', applied: false,
    });

    // The door stays NARROW, which is what makes this test still discriminating:
    // an ordinary tool on the byte-identical row is refused exactly as before.
    db.rows.push([{ ...missing, adv_session_id: 7 }]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
    });
  });

  it('installs the live resolver through the shared operator port', async () => {
    installControlAnchorKernelResolver();
    db.rows.push([anchorRow({ lifecycle: { released: { fleet: 'f', at: 'now', by: 'leader' } } })]);
    await expect(operatorKernelEnforcement(request())).resolves.toMatchObject({
      decision: 'deny',
      code: 'revoked',
    });
  });

  it('denies client initialization and power-user revocation read failures', async () => {
    db.failClient = true;
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityUnavailableSources: ['authority-reader-initialization-failed'] },
    });
    db.failClient = false;
    db.sql.mockResolvedValueOnce([anchorRow({ activation: appliedActivation() })])
      .mockRejectedValueOnce(new Error('credential authority unavailable'));
    await expect(controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }))).resolves.toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityUnavailableSources: ['power-user-revocation-query-failed'] },
    });
  });
});

describe('a stale-artifact session converges from the gate itself (EI-23703586803892464)', () => {
  // The launch record runs REVISION_A; the activation still names REVISION_B as
  // applied — the carry-respawn startup race measured live on 2026-09-27, where a
  // successor's hook calls reached the gate before turn-start converged `applied`.
  function relaunchedBehind() {
    return anchorRow({
      activation: {
        schemaVersion: 1,
        attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
        desired: REVISION_A,
        prepared: null,
        applied: REVISION_B,
        status: 'desired',
      },
    });
  }
  const STALE = { decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } };

  it('converges applied to the launched desired revision and admits the same call on a fresh read', async () => {
    db.rows.push([relaunchedBehind()], [anchorRow({ activation: appliedActivation(REVISION_A) })]);
    heal.converge.mockResolvedValueOnce(true);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'allow', applied: true, executionRevision: REVISION_A,
    });
    expect(heal.converge).toHaveBeenCalledTimes(1);
    // The DESIRED revision (the one the launch carries) at the anchor's own
    // workspace and generation — never the stale applied one.
    expect(heal.converge).toHaveBeenCalledWith(expect.any(String), 'ws-a', 9, REVISION_A);
  });

  it('keeps the original stale-artifact denial when the launch record cannot vouch for desired', async () => {
    db.rows.push([relaunchedBehind()]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject(STALE);
    expect(heal.converge).toHaveBeenCalledTimes(1);
    // A refused convergence never re-reads: one anchor read only.
    expect(db.sql.mock.calls.filter(([strings]) =>
      (strings as readonly string[]).join(' ').includes('control_generation')).length).toBe(1);
  });

  it('does not re-attempt a refused convergence for the same revision pair within the retry window', async () => {
    db.rows.push([relaunchedBehind()], [relaunchedBehind()]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject(STALE);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject(STALE);
    expect(heal.converge).toHaveBeenCalledTimes(1);
  });

  it('retries a refused convergence once the retry window has passed', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    try {
      db.rows.push([relaunchedBehind()], [relaunchedBehind()]);
      await controlAnchorKernelResolver(request());
      vi.setSystemTime(1_000_000 + STALE_ARTIFACT_HEAL_RETRY_MS);
      await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject(STALE);
      expect(heal.converge).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the original denial when the convergence writer throws', async () => {
    db.rows.push([relaunchedBehind()]);
    heal.converge.mockRejectedValueOnce(new Error('writer unavailable'));
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject(STALE);
    expect(heal.converge).toHaveBeenCalledTimes(1);
  });

  it('never attempts a convergence for a session the gate already admits', async () => {
    db.rows.push([anchorRow({ activation: appliedActivation(REVISION_A) })]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow' });
    expect(heal.converge).not.toHaveBeenCalled();
  });

  it('never attempts a convergence without a desired revision to converge to', async () => {
    db.rows.push([anchorRow({ activation: { ...appliedActivation(REVISION_B), desired: undefined } })]);
    await controlAnchorKernelResolver(request());
    expect(heal.converge).not.toHaveBeenCalled();
  });
});

describe('P-005 grants reach actual execution boundaries', () => {
  function grantedRow() {
    const classRef = 'crm.email@1.0.0';
    const pin = {
      kind: 'capability-provider' as const, ref: classRef, providerPackage: 'mail-provider',
      providerVersion: '1.0.0', conformanceRunId: 'run-a', registryRevision: 'registry-a',
      verbBindings: { send: 'mail:send', read: 'mail:read' },
    };
    const artifact = compileAgentSpecification({
      source: {
        id: 'kernel-grants', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
        grants: { requires: [classRef] },
      },
      prompt: { role: 'worker', text: 'Use mail.' }, inputClosure: [pin],
    });
    const revision = { specificationRevision: artifact.specificationRevision, stateRevision: 'granted' };
    const row = anchorRow({ activation: appliedActivation(revision) }, {
      launch_spec: { workspaceId: 'ws-a', harnessSlug: 'sales', ...revision, specificationArtifact: artifact },
    });
    const policy: IdentityGrantPolicy = {
      policyRevision: 'policy-a', potSlug: 'sales', ceilings: [{ allowCapabilities: ['mail:send', 'mail:read'] }],
      protectedAdditions: [], tools: new Map([['mail:send', ['mail:send']], ['mail:read', ['mail:read']]]),
      bindings: [{
        classRef, providerPackage: pin.providerPackage, providerVersion: pin.providerVersion,
        conformanceRunId: pin.conformanceRunId, registryRevision: pin.registryRevision, verbBindings: pin.verbBindings,
        status: 'active', conformanceStatus: 'passed', behavioralStatus: 'not-required', behavioralRunRef: null,
        potSlug: 'sales', boundBy: 'admin', boundAt: '2026-09-13', updatedAt: '2026-09-13',
      }],
    };
    return { row, policy, revision };
  }

  function tool(fn: ProjectedTool['fn'], name = 'mail:send'): ProjectedTool {
    return {
      pluginName: 'fixture', description: 'fixture', inputSchema: { type: 'object' },
      capabilities: [], expose: { mcp: { name } }, fn,
    };
  }

  it.each([
    { caller: undefined, selection: 'owner-workspace-fallback' },
    { caller: 1, selection: 'caller-row' },
  ])('records $selection on governed allows independently of tool arguments and still denies revoked grants', async ({ caller, selection }) => {
    const f = grantedRow();
    const row = { ...f.row, adv_session_xmin: '941' };
    grants.read.mockResolvedValue(f.policy);
    const call = request({
      toolName: 'mail:send', capabilities: ['mail:send'],
      ctx: ctx(caller === undefined ? {} : { advSessionId: caller }),
      args: { identityLaunchRecord: { selection: 'caller-row' } },
    });
    db.rows.push([row], [row]);
    const allowed = await controlAnchorKernelResolver(call);
    expect(allowed).toMatchObject({
      decision: 'allow',
      serverAudit: { identityLaunchRecord: { advSessionId: '1', xmin: '941', selection } },
    });
    grants.read.mockResolvedValue({ ...f.policy, policyRevision: 'policy-revoked', bindings: [] });
    const denied = await controlAnchorKernelResolver(call);
    expect(denied).toMatchObject({ decision: 'deny' });
  });

  it.each(['dispatch', 'indirect-dispatch', 'reaction'] as const)(
    'refuses an unauthorized %s before its handler',
    async (kernelBoundary) => {
      const f = grantedRow();
      grants.read.mockResolvedValue(f.policy);
      db.rows.push([f.row]);
      const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
      const result = await dispatchProjectedTool(tool(handler), 'other:send', {}, ctx({ kernelBoundary }), {
        kernelEnforcement: controlAnchorKernelResolver,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('outside-ceiling');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  // EI-23768233018723089. This resolver reaches the identity gate through a
  // DYNAMIC import inside a try/catch, so an identity-plane fault takes out the
  // recovery door along with everything else: the door's own allow lives INSIDE
  // the module that just failed. The catch then denied every tool, and the
  // session had no way left to ask for help — recovery meant an out-of-band sudo
  // psql write, which is an accident of deployment, not a designed break-glass.
  describe('when the identity gate itself fails to evaluate', () => {
    async function resolveWith(over: Partial<KernelEnforcementRequest>) {
      const f = grantedRow();
      grants.read.mockResolvedValue(f.policy);
      db.rows.push([f.row]);
      grants.kernelThrows = true;
      try {
        return await controlAnchorKernelResolver(request(over));
      } finally {
        grants.kernelThrows = false;
      }
    }

    it('keeps the recovery door open, named directly or carried by the dispatch wrapper', async () => {
      expect(await resolveWith({ toolName: 'coord:orient' }))
        .toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });
      // The route that actually matters: a TRIMMED surface carries no
      // coord:orient in its seed, so this wrapper form is the only way an
      // affected session can reach the door at all.
      expect(await resolveWith({ toolName: 'tools:invoke', args: { name: 'coord:orient', args: {} } }))
        .toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });
    });

    // The control that keeps this a DOOR. Without it, "the gate threw" would
    // widen into a blanket allow — the opposite failure, and the worse one.
    it('still fails closed for every other tool, including through the wrapper', async () => {
      const refused: Partial<KernelEnforcementRequest>[] = [
        { toolName: 'plans:set-status' },
        { toolName: 'tools:invoke', args: { name: 'work_items:complete', args: {} } },
        { toolName: 'tools:invoke', args: {} },
        { toolName: 'tools:invoke', args: { name: 42 } },
      ];
      for (const over of refused) {
        expect(await resolveWith(over), JSON.stringify(over)).toMatchObject({ decision: 'deny' });
      }
    });
  });

  it('allows the exact provider, then refuses a reduction after preflight before invoking', async () => {
    const f = grantedRow();
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    grants.read.mockResolvedValue(f.policy);
    db.rows.push([f.row], [f.row]);
    const allowed = await dispatchProjectedTool(tool(handler), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(allowed.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    handler.mockClear();
    grants.read.mockReset().mockResolvedValueOnce(f.policy)
      .mockResolvedValueOnce({ ...f.policy, policyRevision: 'policy-revoked', bindings: [] });
    db.rows.push([f.row], [f.row]);
    const refused = await dispatchProjectedTool(tool(handler), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain('provider-unbound');
    expect(handler).not.toHaveBeenCalled();
  });

  it('permits one accepted operation tool and blocks another permitted-by-identity tool at direct and nested dispatch', async () => {
    const f = grantedRow();
    const acceptedOperation = {
      kind: 'blueprint-operation-worker', workItemId: 'WI-1',
      operationId: 'send', specificationRevision: 'a'.repeat(64), requiredTools: ['mail:send'],
      pin: { kind: 'blueprint-operation', harnessSlug: 'sales', operationId: 'send',
        specificationRevision: 'a'.repeat(64), operationVersion: '1.0.0', input: {} },
    };
    const row = { ...f.row, launch_spec: { ...f.row.launch_spec, acceptedOperation } };
    grants.read.mockResolvedValue(f.policy);
    for (let i = 0; i < 8; i++) db.rows.push([row]);
    const send = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sent' }] }));
    const read = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }));
    const allowed = await dispatchProjectedTool(tool(send), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(allowed.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    for (const kernelBoundary of ['dispatch', 'indirect-dispatch'] as const) {
      const refused = await dispatchProjectedTool(tool(read, 'mail:read'), 'mail:read', {}, ctx({ kernelBoundary }), {
        kernelEnforcement: controlAnchorKernelResolver,
      });
      expect(refused.ok).toBe(false);
      expect(refused.error?.message).toContain('outside-ceiling');
    }
    expect(read).not.toHaveBeenCalled();
    installControlAnchorKernelResolver();
    const spawn = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));
    const native = wrapOperatorKernelSpawn(spawn, ctx(), ['mail:send']);
    await expect(native('sh', ['-c', 'true'])).rejects.toThrow('outside-ceiling');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses native shell execution even when the caller supplies a granted capability label', async () => {
    const f = grantedRow();
    installControlAnchorKernelResolver();
    grants.read.mockResolvedValue(f.policy);
    db.rows.push([f.row]);
    const spawn = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));
    const wrapped = wrapOperatorKernelSpawn(spawn, ctx(), ['mail:send']);
    await expect(wrapped('sh', ['-c', 'true'])).rejects.toThrow('outside-ceiling');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not treat a grant-bearing launch without its control receipt as a legacy session', async () => {
    const f = grantedRow();
    db.rows.push([{ ...f.row, control_state: null, control_generation: null }]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'capability_unsatisfied',
      obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
    });
    expect(grants.read).not.toHaveBeenCalled();
  });
});

describe('P040 retained-wake authority through ordinary dispatch', () => {
  const ordinary: Omit<ProjectedTool, 'fn'> = {
    pluginName: 'fixture', description: 'P040 local ordinary handler', inputSchema: { type: 'object' },
    capabilities: [], expose: { mcp: { name: 'fixture:ordinary' } },
  };

  it.each(['history', 'control-only', 'owner', 'workspace', 'verified-incarnation', 'missing-verified-row',
    'missing-receipt', 'desired-only', 'wrong-state', 'malformed-history'] as const)(
    'enforces %s provenance before the ordinary handler', async (scenario) => {
      const next = { specificationRevision: PREDECESSOR_ARTIFACT.specificationRevision, stateRevision: 'prepared-b' };
      const record = {
        workspaceId: 'ws-a', harnessSlug: 'sales', ...next, specificationArtifact: PREDECESSOR_ARTIFACT,
        identityHistory: [{ ...REVISION_A, specificationArtifact: PLAIN_ARTIFACT }],
      };
      const launch = scenario === 'control-only'
        ? { ...record, ...REVISION_A, specificationArtifact: PLAIN_ARTIFACT, identityHistory: [] }
        : scenario === 'missing-receipt' || scenario === 'desired-only' ? { ...record, identityHistory: [] }
        : scenario === 'wrong-state' ? { ...record, identityHistory: [{ ...record.identityHistory[0], stateRevision: 'wrong' }] }
        : scenario === 'malformed-history' ? { ...record, identityHistory: { receipt: record.identityHistory[0] } }
        : record;
      const activation = {
        ...appliedActivation(scenario === 'control-only' ? { ...REVISION_A, stateRevision: 'state-next' } : REVISION_A),
        desired: next, status: 'desired',
      };
      const row = anchorRow({ activation }, {
        adv_session_id: 31, adv_session_xmin: 'p040-1', coord_owner_id: 'owner-a', launch_spec: launch,
      });
      const before = structuredClone(row);
      const callCtx = ctx({
        advSessionId: scenario === 'verified-incarnation' || scenario === 'missing-verified-row' ? 32 : 31,
        ...(scenario === 'owner' ? { uiClientId: 'owner-b' } : {}),
        ...(scenario === 'workspace' ? { workspaceId: 'ws-b' } : {}),
      });
      // Ordinary dispatch evaluates the kernel port twice: once in preflight
      // and again immediately before the handler. Keep both authority reads
      // backed by the same fixture row so the second read cannot masquerade as
      // an unavailable session, while the missing-row case still fails closed
      // on its first read.
      db.rows.push(...(scenario === 'missing-verified-row' ? [[], []] : [[row], [row]]));
      const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'P040 ordinary sentinel' }] }));
      const result = await dispatchProjectedTool({ ...ordinary, fn: handler }, 'fixture:ordinary', {}, callCtx, {
        kernelEnforcement: controlAnchorKernelResolver,
      });
      const positive = scenario === 'history' || scenario === 'control-only';
      expect(result.ok).toBe(positive);
      if (positive) {
        expect(handler).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).toContain('P040 ordinary sentinel');
      } else {
        expect(handler).not.toHaveBeenCalled();
        const authorityUnavailable = ['owner', 'workspace', 'verified-incarnation', 'missing-verified-row'].includes(scenario);
        expect(result.error?.meta).toMatchObject({
          kernelCode: authorityUnavailable ? 'policy-unavailable' : 'capability_unsatisfied',
        });
        if (!authorityUnavailable) {
          expect(result.error?.meta).toMatchObject({
            kernelDecision: { obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } },
          });
        }
      }
      const anchorCalls = db.queryCalls().filter(([template]) => !db.isBodyRead(template));
      expect(anchorCalls).toHaveLength(positive ? 2 : 1);
      const [template, ...values] = anchorCalls[0];
      const statement = template.join(' ');
      expect(statement).toContain('WHERE s.coord_owner_id =');
      expect(statement).toContain('AND s.workspace_id =');
      expect(values).toContain(scenario === 'owner' ? 'owner-b' : 'owner-a');
      expect(values).toContain(scenario === 'workspace' ? 'ws-b' : 'ws-a');
      expect(row).toEqual(before);
      if (['missing-receipt', 'desired-only', 'wrong-state', 'malformed-history'].includes(scenario)) {
        expect(heal.converge).toHaveBeenCalledWith('owner-a', 'ws-a', 9, next);
      } else {
        expect(heal.converge).not.toHaveBeenCalled();
      }
    },
  );
});

/**
 * Plan token-efficiency-prompts-cache-and-behavior-2026-10-11 P-011 (D-018): the
 * refused-compaction retry loop was a re-armed predecessor's launch row judging a
 * live owner's `session:request-compaction`. These cases replay REAL rows instead
 * of compiled stand-ins: one owner's `session_briefs` control anchor and both of
 * its open `adv_sessions` rows, read verbatim from the live database at 08:57Z on
 * 2026-10-12 (read-only transaction; capture script recorded on the plan) and
 * stored brotli-compressed. The SHA-256 pin makes a hand-edited fixture fail loudly.
 * Row 39614 is the owner's current launch (its specificationRevision is the applied
 * pair); row 39406 is an older, still-open launch at an earlier revision with no
 * receipt for the applied pair — the re-armed predecessor.
 */
interface RealKernelCapture {
  capturedAt: string;
  ownerId: string;
  workspaceId: string;
  brief: { control_state: { activation?: { applied?: { specificationRevision?: string; stateRevision?: string } } }; control_generation: number; workspace_id: string };
  sessions: Array<{
    adv_session_id: number; adv_session_xmin: string; started_at: string; ended_at: string | null;
    ended_by: string | null; port_id: string | null;
    launch_spec: { specificationRevision: string; stateRevision: string; identityHistory?: Array<{ specificationRevision: string; stateRevision: string }> };
  }>;
}
const REAL_ROWS_FIXTURE = new URL('./__fixtures__/kernel-anchor-rows.re-armed-predecessor.json.br', import.meta.url);
const REAL_ROWS_SHA256 = 'c184f14f95f4fd51c1dd56ae7283b81556dab1515c64d8889d8112ca9dd18e56';
const REAL_CURRENT_ROW = 39614;
const REAL_PREDECESSOR_ROW = 39406;

function loadRealCapture(): RealKernelCapture {
  const bytes = readFileSync(REAL_ROWS_FIXTURE);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(REAL_ROWS_SHA256);
  return JSON.parse(brotliDecompressSync(bytes).toString('utf8')) as RealKernelCapture;
}

/** The anchor read's rows for this owner, newest first — the SQL's `ORDER BY s.id DESC`. */
function realAnchorRows(capture: RealKernelCapture) {
  return capture.sessions.map((session) => ({ ...capture.brief, ...session }));
}

function realCompactionRequest(capture: RealKernelCapture, advSessionId?: number) {
  return request({
    toolName: 'session:request-compaction',
    capabilities: ['coord:write'],
    args: { autoContinue: true },
    ctx: ctx({
      workspaceId: capture.workspaceId,
      uiClientId: capture.ownerId,
      ...(advSessionId === undefined ? {} : { advSessionId }),
    }),
  });
}

describe('control-anchor kernel resolver over real captured rows (P-011)', () => {
  it('the captured rows reproduce a re-armed predecessor beside the current launch', () => {
    const capture = loadRealCapture();
    const applied = capture.brief.control_state.activation?.applied;
    expect(applied?.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    const byId = new Map(capture.sessions.map((s) => [s.adv_session_id, s]));
    const current = byId.get(REAL_CURRENT_ROW);
    const predecessor = byId.get(REAL_PREDECESSOR_ROW);
    // Both launches are still open for the same owner and workspace.
    expect(current?.ended_at).toBeNull();
    expect(predecessor?.ended_at).toBeNull();
    expect(capture.sessions.map((s) => s.adv_session_id)).toEqual([REAL_CURRENT_ROW, REAL_PREDECESSOR_ROW]);
    // The current row carries the applied pair; the predecessor carries neither it nor a receipt for it.
    expect(current?.launch_spec.specificationRevision).toBe(applied?.specificationRevision);
    expect(current?.launch_spec.stateRevision).toBe(applied?.stateRevision);
    expect(predecessor?.launch_spec.specificationRevision).not.toBe(applied?.specificationRevision);
    expect((predecessor?.launch_spec.identityHistory ?? []).some((h) =>
      h.specificationRevision === applied?.specificationRevision && h.stateRevision === applied?.stateRevision)).toBe(false);
  });

  it('refuses a flipped fixture byte through the SHA-256 pin', () => {
    const bytes = Buffer.from(readFileSync(REAL_ROWS_FIXTURE));
    bytes[bytes.length >> 1] ^= 0x01;
    expect(createHash('sha256').update(bytes).digest('hex')).not.toBe(REAL_ROWS_SHA256);
  });

  it('allows the current launch to request compaction when it is the verified caller', async () => {
    const capture = loadRealCapture();
    db.rows.push(realAnchorRows(capture));
    const verdict = await controlAnchorKernelResolver(realCompactionRequest(capture, REAL_CURRENT_ROW));
    expect(verdict).toMatchObject({
      decision: 'allow',
      serverAudit: { identityLaunchRecord: { advSessionId: String(REAL_CURRENT_ROW), selection: 'caller-row' } },
    });
  });

  it('denies the re-armed predecessor as stale-artifact when it is the verified caller', async () => {
    const capture = loadRealCapture();
    db.rows.push(realAnchorRows(capture));
    const verdict = await controlAnchorKernelResolver(realCompactionRequest(capture, REAL_PREDECESSOR_ROW));
    expect(verdict).toMatchObject({
      decision: 'deny',
      obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
      serverAudit: {
        identityLaunchRecordSelection: { advSessionId: String(REAL_PREDECESSOR_ROW), selection: 'caller-row' },
      },
    });
  });

  it('fails closed as verified-caller-row-unavailable when the verified caller row is absent', async () => {
    const capture = loadRealCapture();
    db.rows.push(realAnchorRows(capture));
    const verdict = await controlAnchorKernelResolver(realCompactionRequest(capture, REAL_CURRENT_ROW + 1));
    expect(verdict).toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityUnavailableSources: ['verified-caller-row-unavailable'] },
    });
  });

  it('elects the newest launch, not the predecessor, when no caller row is bound', async () => {
    const capture = loadRealCapture();
    db.rows.push(realAnchorRows(capture));
    const verdict = await controlAnchorKernelResolver(realCompactionRequest(capture));
    expect(verdict).toMatchObject({
      decision: 'allow',
      serverAudit: {
        identityLaunchRecord: { advSessionId: String(REAL_CURRENT_ROW), selection: 'owner-workspace-fallback' },
      },
    });
  });
});
