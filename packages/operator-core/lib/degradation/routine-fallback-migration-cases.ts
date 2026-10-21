/** P-009 producer proof at real dependency seams; reuses the existing entrypoint AST runner. */
import ts from 'typescript';
import { execute, original, source } from './host-startup-migration-cases';
import type { RailMigrationCase } from './rail-migration-cases';
import type { DueReleaseRequestRow } from '../work-items-release-request';

type Observation = { eligible: number; applied: number; reason: string; scope?: string | null };
const prefix = 'packages/operator-core/lib/';


/** Keep the real producer's database and delivery seams isolated from the shared fleet. */
async function conditionMeasured(
  run: (deps: {
    broadcastSevereEvent: (input: { conditionKey?: string; oneShot?: boolean }) => Promise<boolean>;
    resolveAlarm: (key: string) => Promise<boolean>;
  }) => Promise<void>,
): Promise<{ route: 'condition'; openedKeys: string[]; resolvedKeys: string[] }> {
  const { expect } = await import('vitest');
  const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
  await run({
    broadcastSevereEvent: async ({ conditionKey, oneShot }) => {
      expect(oneShot).toBe(true); expect(conditionKey).toMatch(/^alarm:/);
      if (!open.has(conditionKey!)) openedKeys.push(conditionKey!);
      open.add(conditionKey!); return true;
    },
    resolveAlarm: async (key) => {
      if (open.delete(key)) resolvedKeys.push(key); return true;
    },
  });
  expect(openedKeys.length).toBeGreaterThan(0);
  expect(resolvedKeys).toEqual(openedKeys);
  return { route: 'condition', openedKeys, resolvedKeys };
}
function variable(path: string, name: string, marker = ''): ts.VariableDeclaration {
  const file = source(path);
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === name && node.getText(file).includes(marker)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`missing original variable ${path}: ${name}`);
  return found;
}
function statementRange(path: string, start: string, end: string): string {
  const file = source(path);
  let found: ts.NodeArray<ts.Statement> | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) && node.statements.some((s) => s.getText(file).startsWith(start))
      && node.statements.some((s) => s.getText(file).startsWith(end))) found = node.statements;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`missing original statement range ${path}`);
  const first = found.findIndex((s) => s.getText(file).startsWith(start));
  const last = found.findIndex((s) => s.getText(file).startsWith(end));
  return found.slice(first, last).map((s) => s.getText(file)).join('\n');
}
function row(path: string, enclosing: string, ordinal = 1): string {
  return `log-only-fallback|${prefix}${path}|${enclosing}|${ordinal}`;
}
async function measured(
  mechanism: string, scope: string,
  run: (observe: (name: string, observation: Observation) => boolean) => Promise<void>,
): Promise<{ route: 'observation'; mechanism: string; observations: Observation[] }> {
  const { expect } = await import('vitest');
  const observations: Observation[] = [];
  await run((name, observation) => {
    expect(name).toBe(mechanism); expect(observation.scope).toBe(scope);
    observations.push(observation); return true;
  });
  expect(observations.some((o) => o.eligible === 1 && o.applied === 0)).toBe(true);
  expect(observations.some((o) => o.eligible === 1 && o.applied === 1 && o.reason === 'applied')).toBe(true);
  return { route: 'observation', mechanism, observations };
}

export const ROUTINE_FALLBACK_MIGRATION_CASES: RailMigrationCase[] = [{
  id: 'release-request-original-timeout-delivery-retry-unknown-and-measured-recovery', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}dbos/in-process-periodic.ts|tick|1`],
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const { hasWorkItemProgressAfterReleaseRequest } = await import('../work-items-release-request');
    const row: DueReleaseRequestRow = { id: 'WI-fixture', harness: 'fixture', workspaceId: 'fixture',
      holderNow: 'holder', lastProgressAt: null, terminal: false, conditionRequest: null, paths: [],
      request: { by: 'requester', holder: 'holder', reason: 'fixture timeout', onSilence: 'escalate',
        deadlineAt: 1000, requestedAt: 500, resolved: false, resolution: null, resolvedAt: null } };
    let scanFails = false, broadcasts = 0, resolves = 0, pages = 0, retirementFails = true;
    const modules: Record<string, unknown> = {
      '@papercusp/db-org': { getOrgPg: () => ({ sql: {} }) },
      '../work-items-release-request': {
        hasWorkItemProgressAfterReleaseRequest,
        findDueReleaseRequests: async (_sql: unknown, opts: { alarmPending?: boolean }) => {
          if (scanFails) throw new Error('request scan unreadable');
          return opts.alarmPending ? (row.conditionRequest ? [row] : []) : (row.request.resolved ? [] : [row]);
        },
        resolveWorkItemReleaseRequest: async () => {
          row.conditionRequest = { by: row.request.by, holder: row.request.holder, deadlineAt: row.request.deadlineAt };
          row.request.resolved = true; row.request.resolution = 'consequence-escalate'; return row.request;
        },
        settleReleaseRequestCondition: async (_sql: unknown, _row: unknown, recovered: boolean) => {
          if (recovered) row.conditionRequest = null; return true;
        },
      },
      '../work-items': { releaseWorkItem: async () => { throw new Error('must not reclaim'); },
        setWorkItemClaimHold: async () => { throw new Error('must not change lease'); }, commentWorkItem: async () => {} },
      '../work-item-lock-release': {}, '../agent-tools/work_items/release-force-guard': {},
      '../agent-tools/coordination/messages': { sendMessage: async () => {} },
      '../attention-notify': { notifyAttention: async () => { pages++; throw new Error('page unavailable'); } },
      '../severe-event-broadcast': {
        broadcastSevereEvent: async (input: Parameters<typeof rail.broadcastSevereEvent>[0]) => {
          broadcasts++; if (broadcasts === 1) return false; return rail.broadcastSevereEvent(input);
        },
        broadcastSevereEventResolved: async (input: { conditionKey: string }) => rail.resolveAlarm(input.conditionKey),
      },
      '../alarm-attention': { resolveAlarm: async (key: string) => {
        resolves++; if (retirementFails) return false; return rail.resolveAlarm(key);
      } },
    };
    const ast = variable(prefix + 'dbos/in-process-periodic.ts', 'releaseRequestSweepCheck');
    const check = await execute(`return (${ast.initializer!.getText()});`, {
      observeFallback: () => true, require: (name: string) => {
        if (!(name in modules)) throw new Error(`unexpected dependency ${name}`); return modules[name];
      },
    }) as { tick: () => Promise<void> };
    await check.tick(); expect(pages).toBe(1); expect(broadcasts).toBe(1);
    await check.tick(); await check.tick(); expect(broadcasts).toBe(3); expect(pages).toBe(1); expect(resolves).toBe(0);
    scanFails = true; await expect(check.tick()).rejects.toThrow('request scan unreadable'); expect(resolves).toBe(0);
    scanFails = false; row.lastProgressAt = new Date(501).toISOString();
    await check.tick(); expect(row.conditionRequest).not.toBeNull();
    retirementFails = false; await check.tick(); expect(row.conditionRequest).toBeNull();
    // Subsequent episodes recover only from a measured release, terminal state or replacement request.
    for (const recovery of ['release', 'terminal', 'replacement']) {
      row.holderNow = 'holder'; row.lastProgressAt = null; row.terminal = false;
      row.conditionRequest = { by: row.request.by, holder: row.request.holder, deadlineAt: row.request.deadlineAt };
      await check.tick();
      if (recovery === 'release') row.holderNow = null;
      if (recovery === 'terminal') row.terminal = true;
      if (recovery === 'replacement') row.request.deadlineAt++;
      await check.tick(); expect(row.conditionRequest).toBeNull();
    }
    expect(pages).toBe(1);
  }),
}, {
  id: 'loop-arm-prior-facts-read-error-and-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('agent-tools/loop/arm.ts', 'handler')],
  run: () => measured('routine-capability-read', 'loop-prior-facts', async (observeFallback) => {
    const text = original(prefix + 'agent-tools/loop/arm.ts', 'prior-loop read failed', 'try');
    for (const fail of [true, false]) await execute(text, { observeFallback, ownerId: 'fixture', prior: null,
      measure: (_label: string, work: () => Promise<unknown>) => work(),
      readActiveLoopFacts: async () => { if (fail) throw new Error('read failed'); return null; } });
  }),
}, {
  id: 'loop-checkpoint-scope-probe-error-and-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('agent-tools/loop/checkpoint.ts', 'handler')],
  run: () => measured('routine-capability-read', 'loop-checkpoint-scope', async (observeFallback) => {
    const text = statementRange(prefix + 'agent-tools/loop/checkpoint.ts', 'const routineProbe =', 'const activeRoutine =');
    const { withBoundedTimeout } = await import('../bounded-timeout');
    const { expect, vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const fail of [true, false]) await execute(text, { observeFallback, withBoundedTimeout,
        ownerId: 'fixture', CONTINUATION_READ_BUDGET_MS: 1000, routineProbeFailed: false,
        readActiveLoopFacts: async () => { if (fail) throw new Error('read failed'); return { active: false }; } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('armed-routine scope probe failed: read failed'));
    } finally { warn.mockRestore(); }
  }),
}, {
  id: 'dbos-lifecycle-grant-failed-and-verified-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('dbos/bootstrap.ts', 'startDbosOnce')],
  run: () => measured('routine-capability-read', 'dbos-lifecycle-read-grant', async (observeFallback) => {
    const text = original(prefix + 'dbos/bootstrap.ts', 'await grantDbosWorkflowStatusRead()', 'expression');
    for (const fail of [true, false]) await execute(text, { observeFallback,
      grantDbosWorkflowStatusRead: async () => { if (fail) throw new Error('grant denied'); } });
  }),
}, {
  id: 'dbos-reaper-invalid-and-unsafe-override-valid-primary-and-absent-exclusion', item: 'P-009', route: 'observation',
  mechanism: 'routine-config', rowIds: [row('dbos/dbos-executor-reaper.ts', '<module>', 1), row('dbos/dbos-executor-reaper.ts', '<module>', 2)],
  run: () => measured('routine-config', 'reaper-fire-window', async (observeFallback) => {
    const { expect } = await import('vitest');
    const value = variable(prefix + 'dbos/dbos-executor-reaper.ts', 'STALE_ROUTINE_FIRE_NO_OUTPUT_MS').initializer!;
    const text = `const result = ${value.getText()}; return result;`;
    const floor = 180 * 60_000, ceiling = 190 * 60_000, fallback = 185 * 60_000;
    let decisions = 0;
    const record = (name: string, observation: Observation) => { decisions++; return observeFallback(name, observation); };
    for (const raw of ['bad', '0', String(floor), String(ceiling), String(fallback), undefined, '']) {
      const result = await execute(text, { observeFallback: record, process: { env: { PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS: raw } },
        NO_OUTPUT_OVERRIDE_FLOOR_MS: floor, NO_OUTPUT_OVERRIDE_CEILING_MS: ceiling,
        DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS: fallback });
      expect(result).toBe(fallback);
    }
    expect(decisions).toBe(5); // Neither absent nor empty overrides claim a primary measurement.
  }),
}, {
  id: 'gitnexus-output-log-fallback-and-opened-primary', item: 'P-009', route: 'observation',
  mechanism: 'routine-output-log', rowIds: [row('harness/routines/gitnexus-reindex-action.ts', 'openAnalyzeLog')],
  run: () => measured('routine-output-log', 'gitnexus-analyze', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = original(prefix + 'harness/routines/gitnexus-reindex-action.ts', 'function openAnalyzeLog(', 'function');
    for (const fail of [true, false]) {
      const open = execute(text, { observeFallback, path: { dirname: () => '/fixture' },
        mkdirSync() {}, pruneAnalyzeLogs() {}, GITNEXUS_ANALYZE_LOGS_KEPT: 5,
        openSync: () => { if (fail) throw new Error('cannot open'); return 42; } }, 'openAnalyzeLog') as (path: string) => number | null;
      expect(open('/fixture/analyze.log')).toBe(fail ? null : 42);
    }
  }),
}, {
  id: 'silent-halt-wake-markers-page-fallback-and-verified-read', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('harness/routines/silent-halt-reconcile.ts', 'sweepSilentHalts')],
  run: () => measured('routine-capability-read', 'silent-halt-wake-markers', async (observeFallback) => {
    const text = original(prefix + 'harness/routines/silent-halt-reconcile.ts', 'markers = await readMarkers(', 'try');
    for (const fail of [true, false]) await execute(text, { observeFallback, markers: null, nowMs: 1_000_000, lookbackMs: 1000,
      readMarkers: async () => { if (fail) throw new Error('unreadable'); return []; } });
  }),
}, {
  id: 'loop-terminal-guard-fail-soft-and-verified-capability', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('harness/routines/reconcile-loop-routines.ts', 'reconcileLoopRoutines')],
  run: () => measured('routine-capability-read', 'loop-terminal-guard', async (observeFallback) => {
    const { expect } = await import('vitest');
    const declaration = variable(prefix + 'harness/routines/reconcile-loop-routines.ts', 'guard', 'checkUnreachableTerminalGuard');
    const text = `const ${declaration.getText()}; return guard;`;
    for (const fail of [true, false]) {
      const result = await execute(text, { observeFallback, db: {}, row: { id: 'fixture', target_owner_id: 'fixture' },
        nowMs: 10_000, lastFiredMs: 1, intervalMs: 1000, stuckFireCount: 4, circuitOpen: false,
        checkUnreachableTerminalGuard: async () => { if (fail) throw new Error('read failed'); return { breach: true }; } });
      expect(result).toEqual({ breach: !fail });
    }
  }),
}, {
  id: 'routine-dispatch-derivation-unreadable-incomplete-primary-and-cache-exclusion', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('routines-dispatch-derivation.ts', 'dispatchedSweepMatcher')],
  run: () => measured('routine-capability-read', 'dispatch-derivation', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = original(prefix + 'routines-dispatch-derivation.ts', 'function dispatchedSweepMatcher()', 'function');
    for (const outcome of ['error', 'incomplete', 'primary']) {
      let reads = 0;
      const match = execute(text, { observeFallback, cached: null, NEVER: /(?!)/, WORKFLOW_REL: 'fixture',
        escapeRe: (s: string) => s,
        dispatchedSweepPaths: () => { reads++; if (outcome === 'error') throw new Error('unreadable');
          return outcome === 'incomplete' ? [] : Array.from({ length: 10 }, (_, i) => `path${i}`); },
      }, 'dispatchedSweepMatcher') as () => RegExp;
      expect(match().test('path0')).toBe(outcome === 'primary');
      expect(match().test('path0')).toBe(outcome === 'primary');
      expect(reads).toBe(1);
    }
  }),
}, {
  id: 'release-request-lock-release-error-primary-and-skipped-exclusion', item: 'P-009', route: 'observation',
  mechanism: 'routine-capability-read', rowIds: [row('dbos/in-process-periodic.ts', 'tick')],
  run: () => measured('routine-capability-read', 'release-request-locks', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = statementRange(prefix + 'dbos/in-process-periodic.ts', 'const lockRelease =', 'const reclaimHolder =');
    let decisions = 0;
    const record = (name: string, observation: Observation) => { decisions++; return observeFallback(name, observation); };
    for (const result of [{ failures: 1, skipped: null }, { failures: 0, skipped: null },
      { failures: 0, skipped: 'missing-owner' }, { failures: 0, skipped: 'no-paths' }]) {
      await execute(text, { observeFallback: record, row: { id: 'fixture', holderNow: 'fixture', paths: [] },
        resolved: { holder: 'fixture' }, releaseReclaimedWorkItemLocks: async () => result });
    }
    expect(decisions).toBe(2);
  }),
}, {
  id: 'smoke-test-persisted-failure-repeat-pass-and-write-failure', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}endpoint-route/routes/internal/smoke-test-event.ts|handler|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const { z } = await import('zod');
    const path = prefix + 'endpoint-route/routes/internal/smoke-test-event.ts';
    const file = source(path);
    let handler: ts.MethodDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'handler') handler = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!handler) throw new Error('missing original smoke event handler');
    const BodySchema = await execute(`return ${variable(path, 'BodySchema').initializer!.getText(file)};`, { z });
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let status = 'fail', priorStatus: string | undefined, writeFails = false, notifications = 0, attempts = 0;
    const db = {
      select: (fields: Record<string, string>) => ({ from: () => ({ where: () => ({ limit: async () =>
        'harness_slug' in fields ? [{ harness_slug: 'fixture' }] : priorStatus ? [{ status: priorStatus }] : [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {
        if (writeFails) throw new Error('persist unavailable'); priorStatus = status;
      } }) }),
    };
    const run = await execute(`return {${handler.getText(file)}}.handler;`, {
      BodySchema, Response, getOrgPg: () => ({ db }), ti: { token: 'token', harnessSlug: 'slug' }, hs: {},
      eq: () => true, dsql: () => null, activeWorkspaceId: () => 'fixture-workspace',
      notifySyncInvalidate: async () => {}, notifyAttention: async () => { notifications++; },
      broadcastSevereEvent: async ({ conditionKey }: { conditionKey: string }) => {
        attempts++; if (!open.has(conditionKey)) openedKeys.push(conditionKey); open.add(conditionKey); return true;
      },
      resolveAlarm: async (key: string) => { if (open.delete(key)) resolvedKeys.push(key); return true; },
    }) as (req: Request) => Promise<Response>;
    const request = () => new Request('http://fixture/internal/smoke-test-event', {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    expect((await run(request())).status).toBe(200);
    expect((await run(request())).status).toBe(200);
    expect(attempts).toBe(2); expect(notifications).toBe(1);
    status = 'pass'; writeFails = true;
    await expect(run(request())).rejects.toThrow('persist unavailable');
    expect(resolvedKeys).toEqual([]);
    writeFails = false;
    expect((await run(request())).status).toBe(200);
    expect(openedKeys).toEqual(['alarm:smoke-test:fixture']);
    expect(resolvedKeys).toEqual(openedKeys);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'loop-dead-man-original-owner-page-rail-rearm-and-unreadable-preservation', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}harness/routines/loop-dead-man.ts|checkLoopDeadMan|1`],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const producer = await import('../harness/routines/loop-dead-man');
    const attention = await import('../attention-notify');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let row = { armed_ms: 1000, fire_count: 5, fire_count_at_arm: 0, target_owner_id: 'fixture', workspace_id: 'fixture' };
    let readFails = false, pageFails = true;
    const sql = async () => { if (readFails) throw new Error('read unavailable'); return [row]; };
    const deps: import('../harness/routines/loop-dead-man').LoopDeadManDeps = {
      autoPause: async () => {}, getModes: async () => [{ mode: 'auto' } as never],
      broadcast: async ({ conditionKey, oneShot }) => {
        expect(oneShot).toBe(true); if (!open.has(conditionKey!)) openedKeys.push(conditionKey!);
        open.add(conditionKey!); return true;
      },
      resolve: async ({ conditionKey }) => { if (open.delete(conditionKey)) resolvedKeys.push(conditionKey); return true; },
    };
    const page = vi.spyOn(attention, 'notifyAttention').mockImplementation(async () => {
      if (pageFails) throw new Error('page unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const input = { sql: sql as never, routineId: 'fixture', maxFires: 5, nowMs: 10_000 };
      expect((await producer.checkLoopDeadMan(input, deps)).escalated).toBe(false);
      expect(openedKeys).toEqual(['alarm:loop-dead-man:fixture']);
      expect(page).toHaveBeenCalledOnce();
      readFails = true;
      await expect(producer.checkLoopDeadMan(input, deps)).rejects.toThrow('read unavailable');
      expect(resolvedKeys).toEqual([]);
      readFails = false; row = { ...row, armed_ms: Number.NaN, fire_count: 0 };
      await producer.checkLoopDeadMan(input, deps); expect(resolvedKeys).toEqual([]);
      pageFails = false; row = { ...row, armed_ms: 9000, fire_count: 5, fire_count_at_arm: 5 };
      expect((await producer.checkLoopDeadMan(input, deps)).breach).toBe(false);
      expect(resolvedKeys).toEqual(openedKeys);
      // A re-arm that removes the bounds never enters the fire-time reader. Execute
      // the real materializer's post-write arm/stamp boundary, preserving the same key.
      const armText = original(prefix + 'harness/routines/loop.ts', 'await stampLoopArmedAt(sql, row.id, now.getTime())', 'try');
      let stampsFail = false, armsResolved = 0;
      const arm = async (armInput: Record<string, unknown>) => execute(armText, {
        input: armInput, sql: {}, row: { id: 'fixture' }, now: new Date(9000),
        stampLoopArmedAt: async () => { if (stampsFail) throw new Error('stamp unavailable'); },
        require: () => ({ resolveAlarm: async (key: string) => {
          expect(key).toBe('alarm:loop-dead-man:fixture'); armsResolved++; return true;
        } }),
      });
      await arm({ active: false }); await arm({ maxFires: 5 }); await arm({ maxDurationSec: 60 });
      expect(armsResolved).toBe(0);
      stampsFail = true; await arm({}); expect(armsResolved).toBe(0);
      stampsFail = false; await arm({}); expect(armsResolved).toBe(1);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); page.mockRestore(); }
  },
}, {
  id: 'routines-pool-critical-floor-and-ordinary-admission', item: 'P-009', route: 'observation',
  mechanism: 'routine-scheduler-admission', rowIds: [row('dbos/routines-workflow.ts', 'routinesTickImpl')],
  run: () => measured('routine-scheduler-admission', 'dispatch', async (observeFallback) => {
    const { expect } = await import('vitest');
    const text = statementRange(prefix + 'dbos/routines-workflow.ts', 'const pool =', 'const { sql } =');
    let shedRecords = 0;
    for (const pool of ['critical', 'warm', 'ok']) await execute(text, {
      observeFallback, poolPressure: async () => pool, lastPoolProbeMs: () => 100,
      recordPoolShed: () => 1, lastPoolProbeRawMs: () => 100, lastPoolProbeLoopDelayMs: () => 10,
      CRITICAL_PROBE_MS: 1000, activeWorkspaceId: () => 'fixture',
      recordPoolShedEvent: () => { shedRecords++; },
    });
    expect(shedRecords).toBe(1);
  }),
}, {
  id: 'always-on-boot-original-alarm-healthy-held-fresh-and-unreadable', item: 'P-009', route: 'condition',
  rowIds: ['owner-only-alarm|apps/operator/bin/host-bootstrap.ts|runBootstrap|1'],
  run: async () => {
    const { expect } = await import('vitest');
    // Select this exact guard rather than another primary-only bootstrap block.
    const file = source('apps/operator/bin/host-bootstrap.ts');
    let guard: ts.IfStatement | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node) && node.expression.getText(file) === 'cluster.isPrimary'
        && node.getText(file).includes('checkBespokeActiveSeeds')) guard = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!guard) throw new Error('missing original primary-only always-on guard');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let outcome = 'broken', pageFails = true, desktop = false, primary = true, fresh = false;
    let reads = 0, notifications = 0;
    const entry = { name: 'fixture-routine', installSlug: 'fixture-install', seedScript: 'seed.ts', pauseReason: null };
    const executeGuard = async () => {
      await execute(guard!.getText(file), {
        cluster: { isPrimary: primary }, process: { env: { PAPERCUSP_DESKTOP: desktop ? '1' : '0' } },
        isLikelyFreshInstallGap: async () => fresh,
        require: (path: string) => path.endsWith('bespoke-active-seeds-check') ? {
          operatorHomeScope: () => ({ installSlug: 'fixture-install', workspaceId: 'fixture-workspace' }),
          checkBespokeActiveSeeds: async () => {
            reads++; if (outcome === 'unreadable') throw new Error('check unavailable');
            return { ok: outcome === 'healthy', missing: outcome === 'healthy' ? [] : [entry], inactive: [], dark: [],
              escalatable: outcome === 'broken' ? [entry] : [] };
          },
        } : path === '@papercusp/db-org' ? { getOrgPg: () => ({ sql: {} }) }
          : path.endsWith('alarm-attention') ? { resolveAlarm: async (key: string) => {
            if (open.delete(key)) resolvedKeys.push(key); return true;
          } } : path.endsWith('severe-event-broadcast') ? { broadcastSevereEvent: async ({ conditionKey, oneShot }: { conditionKey: string; oneShot: boolean }) => {
            expect(oneShot).toBe(true); if (!open.has(conditionKey)) openedKeys.push(conditionKey);
            open.add(conditionKey); return true;
          } } : { notifyAttention: async () => { notifications++; if (pageFails) throw new Error('page unavailable'); } },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    await executeGuard(); expect(openedKeys).toEqual(['alarm:always-on-routines:fixture-workspace']);
    outcome = 'unreadable'; await executeGuard(); expect(resolvedKeys).toEqual([]);
    desktop = true; fresh = true; await executeGuard(); expect(reads).toBe(2); expect(resolvedKeys).toEqual([]);
    primary = false; await executeGuard(); expect(reads).toBe(2);
    primary = true; desktop = false; pageFails = false; outcome = 'healthy'; await executeGuard();
    expect(resolvedKeys).toEqual(openedKeys);
    outcome = 'broken'; await executeGuard();
    outcome = 'held'; await executeGuard(); expect(open.size).toBe(0);
    expect(notifications).toBe(2);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}];

ROUTINE_FALLBACK_MIGRATION_CASES.push({
  id: 'gitnexus-capacity-original-alarms-repeat-unknown-and-measured-recovery', item: 'P-009', route: 'condition',
  rowIds: [1, 2].map((n) => `owner-only-alarm|${prefix}harness/routines/gitnexus-reindex-action.ts|trackGitnexusDbCapacity|${n}`),
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const producer = await import('../harness/routines/gitnexus-reindex-action');
    let health: Record<string, unknown> = {};
    let unreadable = false, writeFails = false, pages = 0, resolutions = 0;
    let usage: import('../harness/routines/gitnexus-reindex-action').GitnexusDbUsage = {
      dbBytes: 90, dbMaxBytes: 100, dbUtilization: 0.9, dbHeadroomBytes: 10,
    };
    let disk = { status: 'over-ceiling', measuredMb: 100, budgetMb: 50, acceptedCeilingMb: null };
    const sql = { unsafe: async (query: string, args: unknown[]) => {
      if (unreadable) throw new Error('read unavailable');
      if (query.startsWith('SELECT')) return [{ gh: health }];
      if (writeFails) throw new Error('write unavailable');
      health = JSON.parse(args[1] as string).gitnexus_health; return [];
    } };
    const track = execute(original(prefix + 'harness/routines/gitnexus-reindex-action.ts', 'async function trackGitnexusDbCapacity(', 'function'), {
      ...rail, resolveAlarm: async (key: string) => { resolutions++; return rail.resolveAlarm(key); },
      measureGitnexusDbUsage: () => usage, measureGitnexusIndexDisk: () => disk,
      GITNEXUS_HEALTH_DEFAULT: producer.GITNEXUS_HEALTH_DEFAULT,
      decideGitnexusDbHealthUpdate: producer.decideGitnexusDbHealthUpdate,
      decideIndexDiskHealthUpdate: producer.decideIndexDiskHealthUpdate,
      require: () => ({ getOrgPg: () => ({ sql }), notifyAttention: async () => { pages++; throw new Error('page unavailable'); } }),
    }, 'trackGitnexusDbCapacity') as (ctx: unknown, root: string, threshold: number) => Promise<void>;
    const tick = () => track({ installSlug: 'fixture', workspaceId: 'fixture' }, '/fixture', 0.8);
    await tick(); await tick(); expect(pages).toBe(1); // Page failure cannot suppress either rail key.
    usage = { ...usage, dbBytes: null, dbUtilization: null }; disk = { ...disk, status: 'not-measured' };
    await tick(); expect(resolutions).toBe(0);
    usage = { ...usage, dbBytes: 10, dbUtilization: 0.1 }; disk = { ...disk, status: 'within-budget' };
    unreadable = true; await tick(); expect(resolutions).toBe(0);
    unreadable = false; writeFails = true; await tick(); expect(resolutions).toBe(0);
    writeFails = false; await tick(); expect(resolutions).toBe(2);
  }),
}, {
  id: 'gitnexus-dependency-original-alarm-repeat-read-failure-and-usable-recovery', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}harness/routines/gitnexus-reindex-action.ts|trackDependencySnapshot|1`],
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const producer = await import('../harness/routines/gitnexus-reindex-action');
    let status = 'missing', readFails = false, producerFails = false, pages = 0, resolutions = 0, ticks = 0;
    const sql = { unsafe: async (query: string) => {
      if (readFails) throw new Error('read unavailable');
      return query.startsWith('SELECT') ? [{ ds: null }] : [];
    } };
    const track = execute(original(prefix + 'harness/routines/gitnexus-reindex-action.ts', 'async function trackDependencySnapshot(', 'function'), {
      ...rail, resolveAlarm: async (key: string) => { resolutions++; return rail.resolveAlarm(key); },
      pickIndexFreshness: () => ({ lastCommit: 'fixture' }), readRegistryEntry: () => ({}), registryPath: () => 'fixture',
      readIndexMetaFreshness: () => ({}), dependencySnapshotBackend: () => 'fixture', logDependencySnapshotCheck() {},
      dependencySnapshotUsable: producer.dependencySnapshotUsable, canaryBin: () => 'fixture',
      DEPENDENCY_SNAPSHOT_MAX_AGE_MS: producer.DEPENDENCY_SNAPSHOT_MAX_AGE_MS,
      refreshDependencySnapshot: async () => {
        if (producerFails) throw new Error('refresh unreadable');
        ticks++; return { next: { status, path: 'fixture' }, shouldAlert: ticks === 1, shouldResolve: status === 'fresh' };
      },
      require: () => ({ getOrgPg: () => ({ sql }), notifyAttention: async () => { pages++; throw new Error('page unavailable'); } }),
    }, 'trackDependencySnapshot') as (ctx: unknown, root: string, name: string) => Promise<void>;
    const tick = () => track({ installSlug: 'fixture', workspaceId: 'fixture' }, '/fixture', 'fixture');
    await tick(); await tick(); expect(pages).toBe(1);
    status = 'fresh'; readFails = true; await tick(); expect(resolutions).toBe(0);
    readFails = false; producerFails = true; await tick(); expect(resolutions).toBe(0);
    producerFails = false; await tick(); expect(resolutions).toBe(1);
  }),
}, {
  id: 'gitnexus-finish-original-alarm-canary-failure-bookkeeping-error-and-recovery', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}harness/routines/gitnexus-reindex-action.ts|finishAnalyzeTick|1`],
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const producer = await import('../harness/routines/gitnexus-reindex-action');
    let health = producer.GITNEXUS_HEALTH_DEFAULT, healthy = false, canaryFails = false;
    let readFails = false, writeFails = false, resolutions = 0, pages = 0;
    const sql = { unsafe: async (query: string, args: unknown[]) => {
      if (readFails) throw new Error('read unavailable');
      if (query.startsWith('SELECT')) return [{ gh: health }];
      if (writeFails) throw new Error('write unavailable');
      health = JSON.parse(args[1] as string).gitnexus_health; return [];
    } };
    const finish = execute(original(prefix + 'harness/routines/gitnexus-reindex-action.ts', 'async function finishAnalyzeTick(', 'function'), {
      ...rail, resolveAlarm: async (key: string) => { resolutions++; return rail.resolveAlarm(key); },
      readIndexStatsForHealth: () => ({ files: 1, embeddings: 1 }), analyzeEmbeddingsExpected: () => true,
      buildAnalyzeArgs: () => [], runCanary: async () => {
        if (canaryFails) throw new Error('probe unavailable'); return { healthy, degraded: false, summary: 'fixture' };
      },
      trackGitnexusDbCapacity: async () => {}, analyzeTickSucceeded: producer.analyzeTickSucceeded,
      cleanStrandedParseCaches: async () => {}, readStrandedIncompleteIndex: () => null,
      describeStrandedIncompleteIndex: () => '', classifyAnalyzeFailure: () => null,
      describeAnalyzeFailure: () => '', cleanCrashResidue: () => null,
      GITNEXUS_HEALTH_DEFAULT: producer.GITNEXUS_HEALTH_DEFAULT,
      GITNEXUS_FAILURE_ALERT_THRESHOLD: producer.GITNEXUS_FAILURE_ALERT_THRESHOLD,
      decideGitnexusHealthUpdate: producer.decideGitnexusHealthUpdate, trackDependencySnapshot: async () => {},
      require: () => ({ getOrgPg: () => ({ sql }), notifyAttention: async () => { pages++; throw new Error('page unavailable'); } }),
    }, 'finishAnalyzeTick') as (input: unknown) => Promise<void>;
    const tick = () => finish({ ctx: { installSlug: 'fixture', workspaceId: 'fixture' }, root: '/fixture', repoName: 'fixture',
      dbAlertRatio: 0.8, timeoutMs: 1000, r: { code: 0, timedOut: false, stdout: '', stderr: '' }, elapsedSec: 1, adopted: null });
    await tick(); await tick(); expect(resolutions).toBe(0);
    await tick(); await tick(); expect(pages).toBe(1); // Exit zero with a failed graph canary remains degraded.
    healthy = true; canaryFails = true; await tick(); expect(resolutions).toBe(0);
    canaryFails = false; readFails = true; await tick(); expect(resolutions).toBe(0);
    readFails = false; writeFails = true; await tick(); expect(resolutions).toBe(0);
    writeFails = false; await tick(); expect(resolutions).toBe(1);
  }),
}, {
  id: 'history-refresh-original-streak-alarm-unreadable-persistence-and-measured-recovery', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}harness/routines/project-history-refresh-action.ts|persistProjectHistoryHealth|1`],
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const producer = await import('../harness/routines/project-history-refresh-action');
    let health = producer.PROJECT_HISTORY_HEALTH_DEFAULT, success = false;
    let readFails = false, writeFails = false, resolutions = 0, pages = 0;
    const sql = { unsafe: async (query: string, args: unknown[]) => {
      if (readFails) throw new Error('read unavailable');
      if (query.startsWith('SELECT')) return [{ ph: health }];
      if (writeFails) throw new Error('write unavailable');
      health = JSON.parse(args[1] as string).project_history_health; return [];
    } };
    const text = original(prefix + 'harness/routines/project-history-refresh-action.ts', 'health bookkeeping skipped', 'try');
    const tick = () => execute(text, {
      ...rail, resolveAlarm: async (key: string) => { resolutions++; return rail.resolveAlarm(key); },
      ctx: { installSlug: 'fixture', workspaceId: 'fixture' },
      outcome: { success, timedOut: false, code: success ? 0 : 1, stdout: '', stderr: '', timeoutMs: 1000, output: '/fixture/history' },
      PROJECT_HISTORY_HEALTH_DEFAULT: producer.PROJECT_HISTORY_HEALTH_DEFAULT,
      PROJECT_HISTORY_FAILURE_ALERT_THRESHOLD: producer.PROJECT_HISTORY_FAILURE_ALERT_THRESHOLD,
      decideProjectHistoryHealthUpdate: producer.decideProjectHistoryHealthUpdate,
      require: () => ({ getOrgPg: () => ({ sql }), notifyAttention: async () => { pages++; throw new Error('page unavailable'); } }),
    });
    await tick(); expect(resolutions).toBe(0); await tick(); await tick(); expect(pages).toBe(1);
    success = true; readFails = true; await tick(); expect(resolutions).toBe(0);
    readFails = false; writeFails = true; await tick(); expect(resolutions).toBe(0);
    writeFails = false; await tick(); expect(resolutions).toBe(1);
  }),
});

ROUTINE_FALLBACK_MIGRATION_CASES.push({
  id: 'fleet-ekg-original-alarm-refresh-after-page-and-measured-recovery', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}fleet-ekg/scan.ts|alarm|1`],
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const path = prefix + 'fleet-ekg/scan.ts';
    let pages = 0, broadcasts = 0, resolves = 0, status = 'ok', healthy = false, dryRun = false;
    let persisted: Array<{ id: number; feature: string; severity: string; attributed: boolean; alreadyNotified: boolean }> = [];
    const findings = [{ feature: 'latency', severity: 'major', kind: 'numeric', score: 1, attributed: false }];
    const delivery = {
      broadcastSevereEvent: async (input: Parameters<typeof rail.broadcastSevereEvent>[0]) => {
        broadcasts++; return rail.broadcastSevereEvent(input);
      },
      resolveAlarm: async (key: string) => { resolves++; return rail.resolveAlarm(key); },
      notifyAttention: async () => { pages++; throw new Error('owner page unavailable'); },
    };
    // Execute the original alarm callback, including its default production wiring.
    const defaultDeps = execute(original(path, 'function defaultFleetEkgDeps(', 'function'), {
      require: () => delivery,
    }, 'defaultFleetEkgDeps') as (sql: unknown) => Record<string, unknown>;
    const deps = { ...defaultDeps({}),
      readSessions: async () => [], persistVectors: async () => {}, readCohort: async () => [],
      readLedger: async () => [], persistShifts: async () => persisted, markNotified: async () => {},
      nowMs: () => 10_000, log: () => {},
    };
    const run = execute(original(path, 'function runFleetEkgTick(', 'function'), {
      MIN_SESSION_EVENTS: 10, ATTRIBUTION_LOOKBACK_MS: 1000,
      detectDrift: () => ({ status, findings: healthy ? [] : findings, windowSessions: 30, baselineSessions: 50 }),
      attributeFindings: (input: unknown) => input, alarmBody: () => 'measured shift',
      require: () => ({ notifySyncInvalidate: async () => {} }),
    }, 'runFleetEkgTick') as (workspace: string, deps: unknown, opts: unknown) => Promise<unknown>;
    const tick = () => run('fixture-workspace', deps, { dryRun });
    persisted = [{ id: 1, feature: 'latency', severity: 'major', attributed: false, alreadyNotified: false }];
    await tick(); expect(pages).toBe(1); expect(broadcasts).toBe(1);
    persisted[0].alreadyNotified = true;
    await tick(); expect(pages).toBe(1); expect(broadcasts).toBe(2); expect(resolves).toBe(0);
    status = 'insufficient-baseline'; healthy = true;
    await tick(); expect(resolves).toBe(0);
    status = 'ok'; dryRun = true;
    await tick(); expect(resolves).toBe(0);
    dryRun = false;
    const read = deps.readCohort;
    deps.readCohort = async () => { throw new Error('cohort unavailable'); };
    await expect(tick()).rejects.toThrow('cohort unavailable'); expect(resolves).toBe(0);
    deps.readCohort = read;
    await tick(); expect(resolves).toBe(1);
  }),
}, {
  id: 'silent-halt-original-sweep-page-failure-unknown-read-and-measured-recovery', item: 'P-009', route: 'condition',
  rowIds: [`owner-only-alarm|${prefix}harness/routines/silent-halt-reconcile.ts|sweepSilentHalts|1`],
  run: () => conditionMeasured(async (rail) => {
    const { expect } = await import('vitest');
    const producer = await import('../harness/routines/silent-halt-reconcile');
    const nowMs = 10_000_000;
    const candidate = { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', routineId: 'fixture-loop',
      intervalSec: 60, heartbeatAgeMs: 1000, inactiveForMs: 7_200_000, pendingAwaits: 0,
      heldWorkItems: 1, modes: [{ mode: 'auto' }] };
    let active = false, readFails = false, candidateReadFails = false, empty = false, dryRun = false;
    let broadcasts = 0, resolves = 0, pages = 0;
    const deps = { nowMs, wakeFirstEnabled: false,
      readCandidates: async () => { if (candidateReadFails) throw new Error('candidates unavailable'); return empty ? [] : [candidate]; },
      readLoopStatuses: async () => { if (readFails) throw new Error('status unavailable');
        return new Map([[candidate.ownerId, { active, lastRealTurnAt: new Date(nowMs - 7_200_000).toISOString() }]]); },
      readEngineLoopRows: async () => [], readHostClass: async () => null,
      // Fail the initial aggregate delivery so the ORIGINAL owner notifier must
      // execute its own rail retry before its independently failing owner page.
      broadcast: async () => false,
      resolveCondition: async (key: string) => { resolves++; return rail.resolveAlarm(key); },
    };
    const run = execute(original(prefix + 'harness/routines/silent-halt-reconcile.ts', 'function sweepSilentHalts(', 'function'), {
      ...rail,
      broadcastSevereEvent: async (input: Parameters<typeof rail.broadcastSevereEvent>[0]) => {
        broadcasts++; return rail.broadcastSevereEvent(input);
      },
      require: () => ({ notifyAttentionOnce: async () => { pages++; throw new Error('owner page unavailable'); } }),
      evaluateSilentHalt: producer.evaluateSilentHalt, hasAutonomyPosture: () => true,
      disarmEpochToken: producer.disarmEpochToken, wakeMarkerSummary: producer.wakeMarkerSummary,
      classifyEndedHolder: () => 'fixture-classification',
      SILENT_HALT_MAX_WAKES_PER_SWEEP: producer.SILENT_HALT_MAX_WAKES_PER_SWEEP,
      SILENT_HALT_MAX_PAGES_PER_SWEEP: producer.SILENT_HALT_MAX_PAGES_PER_SWEEP,
    }, 'sweepSilentHalts') as (opts: unknown) => Promise<unknown>;
    const tick = () => run({ workspaceId: candidate.workspaceId, sql: {}, deps, dryRun });
    await tick(); await tick(); expect(broadcasts).toBe(2); expect(pages).toBe(2); expect(resolves).toBe(0);
    // An exemption beside an unreadable status must preserve the previous condition.
    candidate.pendingAwaits = 1; readFails = true;
    await tick(); expect(resolves).toBe(0);
    candidateReadFails = true;
    await expect(tick()).rejects.toThrow('candidates unavailable'); expect(resolves).toBe(0);
    candidateReadFails = false; readFails = false; candidate.pendingAwaits = 0; active = true;
    dryRun = true; await tick(); expect(resolves).toBe(0);
    dryRun = false; await tick(); expect(resolves).toBe(1);
    // A complete successful empty census also measures the end of this predicate.
    active = false; await tick(); empty = true; await tick(); expect(resolves).toBe(2);
  }),
});
