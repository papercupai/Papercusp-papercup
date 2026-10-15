import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  awaitDependencyPrebuildState,
  dependencyGenerationRootRecord,
  dependencyPrebuildKey,
  dependencyPrebuildRequestFromQueuedState,
  enqueueDependencyPrebuild,
  emitDependencyPrebuildTerminal,
  parseDependencyPrebuildState,
  recoverQueuedDependencyPrebuild,
  resolveDependencyGenerationRoot,
  runDependencyGenerationPrebuild,
  type DependencyPrebuildBuildingState,
  type DependencyPrebuildCommand,
  type DependencyPrebuildQueuedState,
  type DependencyPrebuildReadyState,
  type DependencyPrebuildState,
} from './dependency-generation-prebuild';
import type { Sql } from 'postgres';

const CANDIDATE_A = 'a'.repeat(40);
const CANDIDATE_B = 'b'.repeat(40);
const INPUT = 'c'.repeat(64);
const IDENTITY = `v1-${'d'.repeat(64)}`;
const TOKEN = `v2:${'e'.repeat(64)}`;
const TARGET = { workspaceId: 'ws-1', installSlug: 'papercusp' };

function building(candidate = CANDIDATE_A, inputFingerprint = INPUT): DependencyPrebuildBuildingState {
  return {
    schema: 1,
    status: 'building',
    key: dependencyPrebuildKey(candidate, inputFingerprint),
    candidate,
    inputFingerprint,
    attemptId: 'attempt-1',
    queuedAtMs: 100,
    startedAtMs: 101,
    updatedAtMs: 102,
    completedAtMs: null,
    producerPid: 7,
    childPid: null,
  };
}

function ready(candidate = CANDIDATE_A, inputFingerprint = INPUT): DependencyPrebuildReadyState {
  return {
    ...building(candidate, inputFingerprint),
    status: 'ready',
    updatedAtMs: 110,
    completedAtMs: 110,
    identity: IDENTITY,
    token: TOKEN,
    reused: true,
  };
}

function queued(candidate = CANDIDATE_A): DependencyPrebuildQueuedState {
  return {
    schema: 1,
    status: 'queued',
    candidate,
    queuedAtMs: 100,
    updatedAtMs: 101,
    producerPid: 7,
    integrationRoot: '/integration',
    toolingRoot: '/tooling',
  };
}

function fingerprintResult(candidate: string) {
  return {
    code: 0,
    stdout: `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} input=${INPUT}\n`,
    stderr: '',
  };
}

describe('dependency generation background prebuild', () => {
  it('ready publication promptly schedules only its matching idle qualification and preserves admission guards', async () => {
    const emit = vi.fn(async () => ({}));
    const unsafe = vi.fn(async () => []);
    await emitDependencyPrebuildTerminal(TARGET, ready(), { emit: emit as never, sql: { unsafe } as unknown as Sql });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([TARGET.installSlug, TARGET.workspaceId, CANDIDATE_A]);
    expect(query).toContain("phase' IN ('waiting', 'ready')");
    expect(query).toContain("'currentPhysicalRunner'), 'null') = 'null'");
    expect(query).toContain("metadata->'pause' IS NULL");
    expect(query).toContain('active = true');
    expect(query).toContain("candidate' = $3");
    expect(query).toContain("next_fire_at > now() + interval '1 minute'");
  });

  it('failed preparation emits its outcome without scheduling a checkpoint', async () => {
    const emit = vi.fn(async () => ({}));
    const unsafe = vi.fn(async () => []);
    await emitDependencyPrebuildTerminal(TARGET, {
      ...building(), status: 'failed', completedAtMs: 120, updatedAtMs: 120, error: 'publisher failed',
    }, { emit: emit as never, sql: { unsafe } as unknown as Sql });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('ready publication still schedules its matching checkpoint when terminal event delivery fails', async () => {
    const emit = vi.fn(async () => { throw new Error('event delivery unavailable'); });
    const unsafe = vi.fn(async () => []);
    await expect(emitDependencyPrebuildTerminal(TARGET, ready(), {
      emit: emit as never, sql: { unsafe } as unknown as Sql,
    })).rejects.toThrow('event delivery unavailable');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [, params] = unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([TARGET.installSlug, TARGET.workspaceId, CANDIDATE_A]);
  });

  it('claims candidate+input once, publishes through the existing helper, then persists/emits ready', async () => {
    const calls: string[][] = [];
    let state: DependencyPrebuildState | null = null;
    const emitted: DependencyPrebuildState[] = [];
    let clock = 1_000;
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args, options) => {
      calls.push(args);
      if (args.includes('--fingerprint-ref')) return fingerprintResult(CANDIDATE_A);
      options.onSpawn?.(4321);
      options.onProgress?.();
      return {
        code: 0,
        stdout:
          `DEPENDENCY_GENERATION_RESULT schema=1 identity=${IDENTITY} source=fixture ` +
          `input=${INPUT} scope=full reused=true token=${TOKEN} path=/generation\n`,
        stderr: '',
      };
    });

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
        queuedAtMs: 999,
      },
      {
        command,
        now: () => clock++,
        attemptId: () => 'attempt-1',
        readState: async () => state,
        claimState: async (_target, next) => {
          state = next;
          return true;
        },
        heartbeatState: async (_target, next) => {
          state = next;
          return true;
        },
        settleState: async (_target, next) => {
          state = next;
          return true;
        },
        emitTerminal: async (_target, terminal) => {
          emitted.push(terminal);
        },
      },
    );

    expect(outcome).toBe('ready');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--fingerprint-ref');
    expect(calls[1]).toContain('--ensure-ref');
    expect(state).toMatchObject({
      status: 'ready',
      candidate: CANDIDATE_A,
      inputFingerprint: INPUT,
      identity: IDENTITY,
      token: TOKEN,
      childPid: 4321,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ status: 'ready', identity: IDENTITY });
  });

  it('P-005: keeps the publisher-emitted phase timings on a SUCCESSFUL build, not only on failure', async () => {
    let state: DependencyPrebuildState | null = null;
    let clock = 1_000;
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) => {
      if (args.includes('--fingerprint-ref')) return fingerprintResult(CANDIDATE_A);
      return {
        code: 0,
        stdout:
          `DEPENDENCY_GENERATION_RESULT schema=1 identity=${IDENTITY} source=fixture ` +
          `input=${INPUT} scope=full reused=false token=${TOKEN} path=/generation\n`,
        // Shape copied from a real producer row: the publisher writes its phase
        // records to stderr, which the success path used to discard entirely.
        stderr: [
          '[dependency-generation] PHASE schema=1 phase=source-manifest-before outcome=ok duration_ms=8180',
          '[dependency-generation] PHASE schema=1 phase=cache-validation outcome=miss duration_ms=13',
          '[dependency-generation] PHASE schema=1 phase=tree-copy outcome=ok duration_ms=10845' +
            ' trees_reused=93 trees_copied=1 trees_removed=0 predecessor=v1-predecessor',
          '[dependency-generation] SUMMARY schema=1 result=incremental source=fixture' +
            ` identity=${IDENTITY} predecessor=v1-predecessor trees_total=94 trees_reused=93` +
            ' trees_copied=1 trees_removed=0 total_ms=753500',
        ].join('\n'),
      };
    });

    const outcome = await runDependencyGenerationPrebuild(
      { ...TARGET, candidate: CANDIDATE_A, integrationRoot: '/integration', toolingRoot: '/tooling', queuedAtMs: 999 },
      {
        command,
        now: () => clock++,
        attemptId: () => 'attempt-1',
        readState: async () => state,
        claimState: async (_target, next) => ((state = next), true),
        heartbeatState: async (_target, next) => ((state = next), true),
        settleState: async (_target, next) => ((state = next), true),
        emitTerminal: async () => {},
      },
    );

    // Read through a closure so the assertion sees the settled state rather
    // than the initializer's narrowed `null` type.
    const settled = (): DependencyPrebuildReadyState => {
      if (!state || state.status !== 'ready') throw new Error(`expected ready, got ${state?.status ?? 'null'}`);
      return state;
    };

    expect(outcome).toBe('ready');
    const persisted = settled();
    // The durations must be the publisher's own numbers, never re-derived here.
    expect(persisted.telemetry).toEqual({
      schema: 1,
      phases: [
        { phase: 'source-manifest-before', outcome: 'ok', durationMs: 8180 },
        { phase: 'cache-validation', outcome: 'miss', durationMs: 13 },
        { phase: 'tree-copy', outcome: 'ok', durationMs: 10845 },
      ],
      result: 'incremental',
      predecessor: 'v1-predecessor',
      treesTotal: 94,
      treesReused: 93,
      treesCopied: 1,
      treesRemoved: 0,
      totalMs: 753500,
    });

    // Persisting is only half the fix: the strict decoder reconstructs state
    // from named fields, so telemetry it does not name would round-trip away
    // and the producer would look fixed while the evidence still vanished.
    const roundTripped = parseDependencyPrebuildState(JSON.parse(JSON.stringify(persisted)));
    expect(roundTripped).toEqual(persisted);
    // WI-10004797: the store the identity lives in must survive the round trip,
    // or a consumer cannot tell a moved root from a valid marker.
    expect(persisted.generationRoot).toMatch(/^\//);
    expect(roundTripped && 'generationRoot' in roundTripped && roundTripped.generationRoot).toBe(
      persisted.generationRoot,
    );
  });

  it('WI-10005159: an env-less resolve follows the root recorded for the integration root, and env still wins', () => {
    const integration = mkdtempSync(join(tmpdir(), 'dep-gen-root-record-'));
    try {
      const record = dependencyGenerationRootRecord(integration);
      expect(record).toBe(join(integration, '.papercusp/dependency-generation-root'));
      mkdirSync(dirname(record), { recursive: true });

      writeFileSync(record, '/mnt/data/recorded-gens\n');
      expect(resolveDependencyGenerationRoot(integration, {})).toBe('/mnt/data/recorded-gens');
      expect(resolveDependencyGenerationRoot(integration, { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' })).toBe(
        '/mnt/data/recorded-gens',
      );
      expect(
        resolveDependencyGenerationRoot(integration, { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '/mnt/data/env-gens' }),
      ).toBe('/mnt/data/env-gens');

      // bash only honors an absolute first line; anything else falls through to the tree store.
      writeFileSync(record, 'relative/gens\n');
      expect(resolveDependencyGenerationRoot(integration, {})).toBe(
        join(integration, '.papercusp/dependency-generations'),
      );
    } finally {
      rmSync(integration, { recursive: true, force: true });
    }
  });

  it('WI-10004797: resolves the generation root exactly like dependency-generation.sh and rejects a malformed recorded root', () => {
    expect(resolveDependencyGenerationRoot('/repo', {})).toBe('/repo/.papercusp/dependency-generations');
    // bash `${VAR:-default}` treats empty as unset.
    expect(resolveDependencyGenerationRoot('/repo', { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' })).toBe(
      '/repo/.papercusp/dependency-generations',
    );
    expect(
      resolveDependencyGenerationRoot('/repo', { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '/mnt/data/gens/' }),
    ).toBe('/mnt/data/gens');

    const ready = {
      schema: 1,
      status: 'ready',
      key: `${'a'.repeat(40)}:${'b'.repeat(64)}`,
      candidate: 'a'.repeat(40),
      inputFingerprint: 'b'.repeat(64),
      attemptId: 'attempt',
      queuedAtMs: 1,
      startedAtMs: 2,
      updatedAtMs: 3,
      completedAtMs: 3,
      producerPid: 4,
      childPid: null,
      identity: 'v1-' + 'c'.repeat(64),
      token: '1:2:3',
      reused: false,
    };
    const legacy = parseDependencyPrebuildState(ready);
    if (legacy === null) throw new Error('fixture identity must satisfy GENERATION_ID_RE');
    expect(legacy).not.toHaveProperty('generationRoot');
    expect(parseDependencyPrebuildState({ ...ready, generationRoot: '/mnt/data/gens' })).toMatchObject({
      generationRoot: '/mnt/data/gens',
    });
    expect(parseDependencyPrebuildState({ ...ready, generationRoot: 'relative/gens' })).toBeNull();
  });

  it('P-005: records no telemetry for a re-keyed generation, and drops malformed telemetry without voiding state', async () => {
    // A re-key runs no publisher, so there are no phases to attribute to it.
    let state: DependencyPrebuildState | null = ready(CANDIDATE_A, INPUT);
    let clock = 2_000;
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) => {
      expect(args).toContain('--fingerprint-ref');
      return fingerprintResult(CANDIDATE_B);
    });

    const outcome = await runDependencyGenerationPrebuild(
      { ...TARGET, candidate: CANDIDATE_B, integrationRoot: '/integration', toolingRoot: '/tooling' },
      {
        command,
        now: () => clock++,
        attemptId: () => 'attempt-2',
        readState: async () => state,
        claimState: async (_target, next) => ((state = next), true),
        heartbeatState: async (_target, next) => ((state = next), true),
        settleState: async (_target, next) => ((state = next), true),
        emitTerminal: async () => {},
      },
    );

    const settled = (): DependencyPrebuildReadyState => {
      if (!state || state.status !== 'ready') throw new Error(`expected ready, got ${state?.status ?? 'null'}`);
      return state;
    };

    expect(outcome).toBe('ready');
    expect(settled().reused).toBe(true);
    expect(settled().telemetry).toBeUndefined();

    // Telemetry is diagnostic, never a readiness input: a corrupt record must
    // not promote itself into a fabricated timing, nor void a usable marker.
    const corrupt = parseDependencyPrebuildState({
      ...ready(),
      telemetry: { schema: 1, phases: [{ phase: 'tree-copy', outcome: 'ok', durationMs: 'soon' }] },
    });
    expect(corrupt).toMatchObject({ status: 'ready', identity: IDENTITY });
    expect(corrupt?.status === 'ready' ? corrupt.telemetry : 'not-ready').toBeUndefined();
  });

  it('dedupes an exact ready marker before running or claiming the publisher', async () => {
    const claimState = vi.fn(async () => true);
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) => {
      expect(args).toContain('--fingerprint-ref');
      return fingerprintResult(CANDIDATE_A);
    });

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      },
      {
        command,
        readState: async () => ready(),
        claimState,
      },
    );

    expect(outcome).toBe('deduped-ready');
    expect(command).toHaveBeenCalledOnce();
    expect(claimState).not.toHaveBeenCalled();
  });

  it('re-keys a ready generation for a new candidate with identical inputs without rebuilding', async () => {
    const prior = ready(CANDIDATE_A);
    let settled: DependencyPrebuildState | null = null;
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) => {
      expect(args).toContain('--fingerprint-ref');
      return fingerprintResult(CANDIDATE_B);
    });

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_B,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      },
      {
        command,
        readState: async () => prior,
        claimState: async () => true,
        settleState: async (_target, next) => {
          settled = next;
          return true;
        },
        emitTerminal: async () => {},
        attemptId: () => 'attempt-b',
      },
    );

    expect(outcome).toBe('ready');
    expect(command).toHaveBeenCalledOnce();
    expect(settled).toMatchObject({
      status: 'ready',
      candidate: CANDIDATE_B,
      inputFingerprint: INPUT,
      identity: IDENTITY,
      token: TOKEN,
      reused: true,
    });
  });

  it('persists and emits a failed terminal marker when the existing publisher refuses', async () => {
    let settled: DependencyPrebuildState | null = null;
    const emitted: DependencyPrebuildState[] = [];
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) =>
      args.includes('--fingerprint-ref')
        ? fingerprintResult(CANDIDATE_A)
        : {
            code: 74,
            stdout: '',
            stderr: 'FATAL: no prewarmed dependency generation for input fingerprint fixture',
          },
    );

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      },
      {
        command,
        readState: async () => null,
        claimState: async () => true,
        settleState: async (_target, next) => {
          settled = next;
          return true;
        },
        emitTerminal: async (_target, next) => {
          emitted.push(next);
        },
        attemptId: () => 'attempt-failed',
      },
    );

    expect(outcome).toBe('failed');
    expect(settled).toMatchObject({
      status: 'failed',
      candidate: CANDIDATE_A,
      error: expect.stringContaining('exited 74'),
    });
    expect(emitted).toHaveLength(1);
  });
});

describe('dependency prebuild state/wait contract', () => {
  it('strictly parses a queued handoff and reconstructs the complete producer request', () => {
    const state = queued();
    expect(parseDependencyPrebuildState(state)).toEqual(state);
    expect(dependencyPrebuildRequestFromQueuedState(TARGET, state)).toEqual({
      ...TARGET,
      candidate: CANDIDATE_A,
      integrationRoot: '/integration',
      toolingRoot: '/tooling',
      queuedAtMs: 100,
    });
    expect(parseDependencyPrebuildState({ ...state, integrationRoot: 'relative' })).toBeNull();
    expect(parseDependencyPrebuildState({ ...state, updatedAtMs: 99 })).toBeNull();
    expect(parseDependencyPrebuildState({ ...state, producerPid: 0 })).toBeNull();
  });

  it('recovers only a queued marker and passes its persisted paths to the producer', async () => {
    const run = vi.fn(async (request: { candidate: string; integrationRoot: string; toolingRoot: string }) => {
      expect(request).toMatchObject({
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      });
      return 'ready' as const;
    });
    await expect(
      recoverQueuedDependencyPrebuild(TARGET, {
        readState: async () => queued(),
        run,
      }),
    ).resolves.toBe('ready');
    expect(run).toHaveBeenCalledOnce();
    await expect(
      recoverQueuedDependencyPrebuild(TARGET, {
        readState: async () => ready(),
        run,
      }),
    ).resolves.toBe('none');
    expect(run).toHaveBeenCalledOnce();
  });

  it('writes the queued handoff atomically and preserves a newer candidate marker', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    let returnRows: Array<{ queued: boolean }> = [{ queued: true }];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      if (strings.join('?').includes('UPDATE harness_shared.routines')) {
        const rows = returnRows;
        returnRows = [];
        return Promise.resolve(rows);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    await expect(
      enqueueDependencyPrebuild(
        {
          ...TARGET,
          candidate: CANDIDATE_A,
          integrationRoot: '/integration',
          toolingRoot: '/tooling',
          queuedAtMs: 123,
        },
        sql,
      ),
    ).resolves.toBe(true);
    const update = calls.find((call) => call.text.includes('UPDATE harness_shared.routines'));
    expect(update?.text).toContain("'dependency_prebuild'");
    expect(update?.values).toContain(TARGET.workspaceId);
    expect(update?.values).toContain(TARGET.installSlug);
    expect(update?.values.some((value) => String(value).includes('"status":"queued"'))).toBe(true);

    returnRows = [];
    await expect(
      enqueueDependencyPrebuild(
        {
          ...TARGET,
          candidate: CANDIDATE_B,
          integrationRoot: '/integration',
          toolingRoot: '/tooling',
          queuedAtMs: 123,
        },
        sql,
      ),
    ).resolves.toBe(false);
  });

  it('rejects malformed or mismatched ready metadata instead of treating it as usable', () => {
    expect(parseDependencyPrebuildState({ ...ready(), token: '' })).toBeNull();
    expect(
      parseDependencyPrebuildState({
        ...ready(),
        key: dependencyPrebuildKey(CANDIDATE_B, INPUT),
      }),
    ).toBeNull();
    expect(parseDependencyPrebuildState(ready())).toMatchObject({
      status: 'ready',
      identity: IDENTITY,
    });
  });

  it('subscribes before reading and resolves the exact terminal edge, with state authoritative', async () => {
    let state: DependencyPrebuildState = building();
    let handler!: (payload: string) => void;
    const unsubscribe = vi.fn();
    const pending = awaitDependencyPrebuildState(
      TARGET,
      CANDIDATE_A,
      INPUT,
      { timeoutMs: 5_000, reconcileMs: 5_000 },
      {
        readState: async () => state,
        subscribe: (next) => {
          handler = next;
          return unsubscribe;
        },
      },
    );

    await Promise.resolve();
    state = ready();
    handler(
      JSON.stringify({
        ...TARGET,
        candidate: CANDIDATE_A,
        inputFingerprint: INPUT,
        status: 'ready',
      }),
    );

    await expect(pending).resolves.toMatchObject({
      status: 'ready',
      identity: IDENTITY,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
