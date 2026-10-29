import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  resolveSidecarSpawnPlan,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  gracefulStopChild,
  registerSidecarShutdownHooks,
  _resetSidecarShutdownHookRegistryForTests,
  isSidecarEnabledFromEnv,
  verifySidecarFitness,
  parseLoopbackListenerUids,
  loopbackListenerUids,
  loopbackListenerOwnedBy,
} from './sidecar-spawn-shared';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

describe('loopback listener ownership (P-530, WI-10005523)', () => {
  // Real /proc/net/tcp shape: sl local rem st tx:rx tr:when retrnsmt uid timeout inode
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const row = (local: string, st: string, uid: number) =>
    `   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 12345 1 0000000000000000 100 0 0 10 0`;
  const port = 0x9c41; // 40001

  it('reads the uid of LISTEN sockets reachable at 127.0.0.1:port only', () => {
    const table = [
      header,
      row('0100007F:9C41', '0A', 1000), // 127.0.0.1, LISTEN
      row('00000000:9C41', '0A', 1001), // 0.0.0.0, LISTEN — reachable via loopback
      row('0100007F:9C42', '0A', 1002), // other port
      row('0100007F:9C41', '01', 1003), // ESTABLISHED, not a listener
      row('0A00000A:9C41', '0A', 1004), // 10.0.0.10 — not reachable at 127.0.0.1
    ].join('\n');
    expect(parseLoopbackListenerUids(table, port)).toEqual([1000, 1001]);
  });

  it('reads tcp6 dual-stack and v4-mapped loopback listeners', () => {
    const table = [
      header,
      row('00000000000000000000000000000000:9C41', '0A', 1005),
      row('0000000000000000FFFF00000100007F:9C41', '0A', 1006),
    ].join('\n');
    expect(parseLoopbackListenerUids(table, port)).toEqual([1005, 1006]);
  });

  it('null when no socket table is readable, [] when nothing listens', () => {
    expect(loopbackListenerUids(port, () => null)).toBeNull();
    expect(loopbackListenerUids(port, () => header)).toEqual([]);
  });

  it('owned only when every listener is the uid; unknown stays unknown', () => {
    expect(loopbackListenerOwnedBy([1000], 1000)).toBe(true);
    expect(loopbackListenerOwnedBy([1000, 1001], 1000)).toBe(false);
    expect(loopbackListenerOwnedBy([], 1000)).toBe(false);
    expect(loopbackListenerOwnedBy(null, 1000)).toBeNull();
  });

  // Positive control against the REAL host table: a listener this process
  // opens must come back as this uid. Without it, a reader that silently
  // fails (the helper once called readFileSync with no import, and the
  // catch turned the ReferenceError into "no table") reads as "unknown" on
  // every host and every ownership check quietly stops checking.
  it.skipIf(process.platform !== 'linux' || typeof process.getuid !== 'function')(
    'sees a listener this process opens, owned by this uid',
    async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const addr = server.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        expect(loopbackListenerUids(p)).toEqual([process.getuid!()]);
      } finally {
        await new Promise((r) => server.close(r));
      }
    },
  );
});

describe('verifySidecarFitness (EI-19314150478401738)', () => {
  const LEGACY = ['GET /healthz', 'POST /embed'];

  it('nothing answered ⇒ unreachable, never silently fit', () => {
    expect(verifySidecarFitness(null, ['POST /embed'], LEGACY)).toEqual({
      fit: false,
      reason: 'unreachable',
      missing: ['POST /embed'],
    });
    expect(verifySidecarFitness(undefined, ['POST /embed'], LEGACY).fit).toBe(false);
    // A non-object body is not a health payload.
    expect(verifySidecarFitness('ok', ['POST /embed'], LEGACY).fit).toBe(false);
  });

  it('a declared list is honoured exactly', () => {
    const health = { capabilities: ['GET /healthz', 'POST /embed', 'POST /rerank'] };
    expect(verifySidecarFitness(health, ['POST /rerank'], LEGACY)).toEqual({ fit: true });
    expect(verifySidecarFitness(health, ['POST /embed', 'POST /rerank'], LEGACY)).toEqual({ fit: true });
    expect(verifySidecarFitness(health, ['POST /summarize'], LEGACY)).toEqual({
      fit: false,
      reason: 'missing-capabilities',
      missing: ['POST /summarize'],
    });
  });

  it('NO declared list ⇒ credited with the legacy floor ONLY — the live 16-day-old sidecar case', () => {
    // Measured live: 200 OK, warm models, no `capabilities` key, and
    // POST /rerank 404s. It must stay usable for /embed and be refused for
    // /rerank — crediting it with either everything or nothing is wrong.
    const stale = { ok: true, pid: 2034810, uptimeMs: 1_401_886_441, models: { 'gemma:document': 'warm' } };
    expect(verifySidecarFitness(stale, ['POST /embed'], LEGACY)).toEqual({ fit: true });
    expect(verifySidecarFitness(stale, ['POST /rerank'], LEGACY)).toEqual({
      fit: false,
      reason: 'stale-build',
      missing: ['POST /rerank'],
    });
  });

  it('requiring nothing is fit against any live payload', () => {
    expect(verifySidecarFitness({ ok: true }, [], LEGACY)).toEqual({ fit: true });
  });

  it('a malformed capabilities value is treated as UNDECLARED, not as empty', () => {
    // `capabilities: 'POST /rerank'` (a string, not an array) must not be
    // string-searched into a false positive, nor collapse the legacy floor.
    expect(verifySidecarFitness({ capabilities: 'POST /rerank' }, ['POST /rerank'], LEGACY).fit).toBe(false);
    expect(verifySidecarFitness({ capabilities: 'nonsense' }, ['POST /embed'], LEGACY)).toEqual({ fit: true });
    // Non-string entries are dropped rather than crashing the compare.
    expect(verifySidecarFitness({ capabilities: [1, null, 'POST /embed'] }, ['POST /embed'], LEGACY)).toEqual({
      fit: true,
    });
  });

  it('an EMPTY declared list is a real answer ("I serve nothing"), not a missing one', () => {
    // Distinct from undeclared: this build DOES advertise, and advertises
    // nothing — so it must not inherit the legacy floor.
    expect(verifySidecarFitness({ capabilities: [] }, ['POST /embed'], LEGACY)).toEqual({
      fit: false,
      reason: 'missing-capabilities',
      missing: ['POST /embed'],
    });
  });
});

describe('resolveSidecarSpawnPlan (WI-3079)', () => {
  it('runs development TypeScript under the explicit Node despite a different PATH interpreter', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sidecar-runtime-boundary-'));
    try {
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      // This models npx's PATH-node dependency without network or npm installs.
      writeFileSync(join(bin, 'npx'), '#!/bin/sh\nshift\nexec node "$@"\n', { mode: 0o755 });
      if (process.env.PAPERCUSP_RUNTIME_TEST_BUN) {
        symlinkSync(process.env.PAPERCUSP_RUNTIME_TEST_BUN, join(bin, 'node'));
      } else writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
      const entry = join(directory, 'child.ts');
      writeFileSync(entry, 'const value: number = 42;\nprocess.stdout.write("INTERPRETER "+JSON.stringify({name:process.versions.bun?"bun":"node",value})+"\\n");\n');
      const plan = resolveSidecarSpawnPlan({ selfPath: '/source/parent.ts', devScriptPath: entry,
        bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE', execPath: process.execPath, spawnerPid: process.pid });
      const child = spawnSync(plan.cmd, plan.args, { cwd: directory, timeout: 15_000, encoding: 'utf8',
        env: { ...process.env, ...plan.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` } });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout.split('\n').find(line => line.startsWith('INTERPRETER '))!.slice(12)))
        .toEqual({ name: 'node', value: 42 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses a nonempty maintained sibling under the same node and parent declaration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spawner-bundle-plan-'));
    try {
      const sibling = join(directory, 'spawner-sidecar.mjs');
      writeFileSync(sibling, 'export {};');
      const plan = resolveSidecarSpawnPlan({
        selfPath: join(directory, 'serve.mjs'), devScriptPath: '/repo/spawner-sidecar.ts',
        bundledScriptName: 'spawner-sidecar.mjs', bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
        execPath: '/opt/app/bin/node', spawnerPid: 4242,
      });
      expect(plan).toEqual({
        cmd: '/opt/app/bin/node', args: [sibling], mode: 'bundled-reexec',
        env: { PAPERCUSP_SPAWNER_SIDECAR_MODE: '1', PAPERCUSP_DESKTOP_PARENT_PID: '4242' },
      });
      // Other sidecar routes do not opt into this artifact.
      expect(resolveSidecarSpawnPlan({
        selfPath: join(directory, 'serve.mjs'), devScriptPath: '/repo/gateway.ts',
        bundledModeEnvVar: 'PAPERCUSP_GATEWAY_SIDECAR_MODE', execPath: '/opt/app/bin/node', spawnerPid: 4242,
      }).args).toEqual([join(directory, 'serve.mjs')]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['absent', 'empty', 'directory'])('keeps the full entry fallback when sibling is %s', (condition) => {
    const directory = mkdtempSync(join(tmpdir(), 'spawner-bundle-fallback-'));
    try {
      const sibling = join(directory, 'spawner-sidecar.mjs');
      if (condition === 'empty') writeFileSync(sibling, '');
      if (condition === 'directory') mkdirSync(sibling);
      const selfPath = join(directory, 'hono-host.mjs');
      expect(resolveSidecarSpawnPlan({
        selfPath, devScriptPath: '/repo/spawner-sidecar.ts', bundledScriptName: 'spawner-sidecar.mjs',
        bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE', execPath: '/usr/bin/node', spawnerPid: 4242,
      })).toEqual({
        cmd: '/usr/bin/node', args: [selfPath], mode: 'bundled-reexec',
        env: { PAPERCUSP_SPAWNER_SIDECAR_MODE: '1', PAPERCUSP_DESKTOP_PARENT_PID: '4242' },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('dev (real .ts on disk) uses the explicit Node with a resolved tsx loader', () => {
    const plan = resolveSidecarSpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts',
      devScriptPath: '/repo/apps/operator/bin/spawner-sidecar.ts',
      bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
      execPath: '/usr/bin/node',
      spawnerPid: 4242,
    });
    expect(plan).toEqual({
      cmd: '/usr/bin/node',
      args: ['--import', expect.stringContaining('tsx'), '/repo/apps/operator/bin/spawner-sidecar.ts'],
      env: { PAPERCUSP_DESKTOP_PARENT_PID: '4242' },
      mode: 'dev-tsx',
    });
  });

  it('packaged (bundled serve.mjs) → re-exec self under the bundled node with the divert env', () => {
    const plan = resolveSidecarSpawnPlan({
      selfPath: '/opt/Papercup/resources/serve.mjs',
      devScriptPath: '/opt/Papercup/resources/apps/operator/bin/spawner-sidecar.ts',
      bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
      execPath: '/opt/Papercup/resources/node',
      spawnerPid: 4242,
    });
    expect(plan).toEqual({
      cmd: '/opt/Papercup/resources/node',
      args: ['/opt/Papercup/resources/serve.mjs'],
      env: { PAPERCUSP_SPAWNER_SIDECAR_MODE: '1', PAPERCUSP_DESKTOP_PARENT_PID: '4242' },
      mode: 'bundled-reexec',
    });
  });

  it('non-ts dev entry (defensive branch — never hit in practice) → direct execPath spawn', () => {
    const plan = resolveSidecarSpawnPlan({
      selfPath: '/repo/lib/x.ts',
      devScriptPath: '/repo/bin/x.js',
      bundledModeEnvVar: 'X_MODE',
      execPath: '/usr/bin/node',
      spawnerPid: 4242,
    });
    expect(plan).toEqual({
      cmd: '/usr/bin/node',
      args: ['/repo/bin/x.js'],
      env: { PAPERCUSP_DESKTOP_PARENT_PID: '4242' },
      mode: 'dev-tsx',
    });
  });
});

/**
 * (EI-20493378309289396) The spawn plan MUST re-declare the spawning process as
 * the child's parent, or an inherited `PAPERCUSP_DESKTOP_PARENT_PID` naming the
 * DESKTOP reaches a child whose real parent is the OPERATOR — and the child's
 * parent-death watch then compares two pids that can never be equal, SIGTERMing
 * itself on every boot forever (1,134 such lines in 3h10m on the macOS rig).
 *
 * The control below is the whole point: `inheritedParentEnvPlan` is the OLD
 * behaviour (leave the var alone and let it be inherited). Every assertion here
 * must FAIL against it — otherwise the test is satisfied by the broken
 * implementation and guards nothing.
 */
describe('sidecar spawn declares its OWN pid as the child parent (EI-20493378309289396)', () => {
  const OPERATOR_PID = 79225; // the live Mac operator
  const DESKTOP_PID = '79217'; // what main.rs put in the operator's env

  const realPlanEnv = (): Record<string, string> =>
    resolveSidecarSpawnPlan({
      selfPath: '/Applications/Papercusp Server.app/Contents/Resources/sidecar/serve.mjs',
      devScriptPath: '/repo/packages/operator-core/lib/inference-gateway/bin.ts',
      bundledModeEnvVar: 'PAPERCUSP_GATEWAY_SIDECAR_MODE',
      execPath: '/Applications/Papercusp Server.app/Contents/Resources/sidecar/bin/node',
      spawnerPid: OPERATOR_PID,
    }).env;

  /** PERMANENT WRONG-IMPLEMENTATION CONTROL — the pre-fix plan env. */
  const inheritedParentEnvPlan = (): Record<string, string> => ({
    PAPERCUSP_GATEWAY_SIDECAR_MODE: '1',
  });

  /** The child's effective env, exactly as every spawner builds it:
   *  `{ ...process.env, ...plan.env }` — plan.env layered LAST. */
  const childEnv = (planEnv: Record<string, string>): Record<string, string> => ({
    PAPERCUSP_DESKTOP: '1',
    PAPERCUSP_DESKTOP_PARENT_PID: DESKTOP_PID, // inherited from the operator
    PAPERCUSP_PARENT_DEATH_WATCH: '1',
    ...planEnv,
  });

  /** serve.ts:244 `isOrphanedFromParent`, restated so the test asserts the
   *  CONSEQUENCE (does the child kill itself?) rather than a string value. */
  const selfTerminatesAtBoot = (planEnv: Record<string, string>): boolean => {
    const declared = Number(childEnv(planEnv).PAPERCUSP_DESKTOP_PARENT_PID);
    return declared > 0 && OPERATOR_PID !== declared;
  };

  it('overrides the INHERITED desktop pid with the spawning operator pid', () => {
    expect(realPlanEnv().PAPERCUSP_DESKTOP_PARENT_PID).toBe(String(OPERATOR_PID));
    expect(childEnv(realPlanEnv()).PAPERCUSP_DESKTOP_PARENT_PID).toBe(String(OPERATOR_PID));
    // CONTROL: the old plan leaves the desktop's pid in place.
    expect(childEnv(inheritedParentEnvPlan()).PAPERCUSP_DESKTOP_PARENT_PID).toBe(DESKTOP_PID);
  });

  it('the child does NOT self-terminate at boot — the actual defect', () => {
    expect(selfTerminatesAtBoot(realPlanEnv())).toBe(false);
    // CONTROL: the pre-fix env self-terminates, which is the 1,134-line storm.
    expect(selfTerminatesAtBoot(inheritedParentEnvPlan())).toBe(true);
  });

  it('keeps the divert var — the parent declaration must not displace it', () => {
    expect(realPlanEnv().PAPERCUSP_GATEWAY_SIDECAR_MODE).toBe('1');
  });

  it('declares the parent in DEV (tsx) too, not only in packaged builds', () => {
    // A desktop `npm run dev` operator also carries PAPERCUSP_DESKTOP_PARENT_PID,
    // so a dev-mode plan that left env empty would reproduce the same bug.
    const devEnv = resolveSidecarSpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts',
      devScriptPath: '/repo/packages/operator-core/lib/inference-gateway/bin.ts',
      bundledModeEnvVar: 'PAPERCUSP_GATEWAY_SIDECAR_MODE',
      execPath: '/usr/bin/node',
      spawnerPid: OPERATOR_PID,
    }).env;
    expect(devEnv.PAPERCUSP_DESKTOP_PARENT_PID).toBe(String(OPERATOR_PID));
    expect(selfTerminatesAtBoot(devEnv)).toBe(false);
  });

  it('CALIBRATION: a genuinely dead parent is still detected (the watch keeps working)', () => {
    // The fix must not make the watch unfalsifiable. If the child is reparented
    // away from the operator that declared itself, it IS orphaned and must fire.
    const declared = Number(realPlanEnv().PAPERCUSP_DESKTOP_PARENT_PID);
    const reparentedToInit = 1;
    expect(declared > 0 && reparentedToInit !== declared).toBe(true);
  });
});

describe('isSidecarEnabledFromEnv (WI-3793)', () => {
  const OPTS = { enableVar: 'PAPERCUSP_SPAWNER_SIDECAR', modeVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE' };

  it('off when the enable var is unset (the default)', () => {
    expect(isSidecarEnabledFromEnv(OPTS, {})).toBe(false);
  });

  it('on when the enable var reads "1"', () => {
    expect(isSidecarEnabledFromEnv(OPTS, { PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(true);
  });

  it('off for any non-"1" enable-var value (no truthy-string coercion)', () => {
    expect(isSidecarEnabledFromEnv(OPTS, { PAPERCUSP_SPAWNER_SIDECAR: 'true' })).toBe(false);
    expect(isSidecarEnabledFromEnv(OPTS, { PAPERCUSP_SPAWNER_SIDECAR: 'yes' })).toBe(false);
  });

  it('the mode var (re-exec divert) ALWAYS wins — never self-enables inside the sidecar child, even with an inherited enable var', () => {
    expect(
      isSidecarEnabledFromEnv(OPTS, {
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      }),
    ).toBe(false);
  });

  it('an explicitVar override forces ON regardless of the enable var', () => {
    const opts = { ...OPTS, explicitVar: 'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR' };
    expect(
      isSidecarEnabledFromEnv(opts, { PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '1' }),
    ).toBe(true);
    expect(
      isSidecarEnabledFromEnv(opts, { PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: 'true' }),
    ).toBe(true);
  });

  it('an explicitVar override forces OFF even when the enable var is on', () => {
    const opts = { ...OPTS, explicitVar: 'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR' };
    expect(
      isSidecarEnabledFromEnv(opts, {
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0',
      }),
    ).toBe(false);
  });

  it('explicitVar unset falls through to the plain enable-var check', () => {
    const opts = { ...OPTS, explicitVar: 'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR' };
    expect(isSidecarEnabledFromEnv(opts, { PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(true);
    expect(isSidecarEnabledFromEnv(opts, {})).toBe(false);
  });

  it('the mode var wins even over an explicitVar override', () => {
    const opts = { ...OPTS, explicitVar: 'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR' };
    expect(
      isSidecarEnabledFromEnv(opts, {
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
        PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '1',
      }),
    ).toBe(false);
  });
});

describe('respawnBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(respawnBackoffMs(1)).toBe(1_000);
    expect(respawnBackoffMs(2)).toBe(2_000);
    expect(respawnBackoffMs(3)).toBe(4_000);
    expect(respawnBackoffMs(4)).toBe(8_000);
    expect(respawnBackoffMs(5)).toBe(16_000);
    expect(respawnBackoffMs(6)).toBe(30_000);
    expect(respawnBackoffMs(10)).toBe(30_000);
  });

  it('honors a custom cap', () => {
    expect(respawnBackoffMs(6, 60_000)).toBe(32_000);
  });

  it('never goes negative for a zero/negative attempt', () => {
    expect(respawnBackoffMs(0)).toBe(1_000);
    expect(respawnBackoffMs(-3)).toBe(1_000);
  });
});

describe('pruneRespawnWindow / respawnBudgetExhausted', () => {
  it('drops attempts older than the window', () => {
    const now = 100_000;
    const attempts = [now - 400_000, now - 100_000, now - 1_000];
    expect(pruneRespawnWindow(attempts, now, 300_000)).toEqual([now - 100_000, now - 1_000]);
  });

  it('trips once attempts reach maxAttempts', () => {
    expect(respawnBudgetExhausted([1, 2, 3, 4], 5)).toBe(false);
    expect(respawnBudgetExhausted([1, 2, 3, 4, 5], 5)).toBe(true);
    expect(respawnBudgetExhausted([], 5)).toBe(false);
  });
});

describe('gracefulStopChild', () => {
  it('resolves on exit without force-killing', async () => {
    const child = new EventEmitter();
    const kill = vi.fn((sig: NodeJS.Signals) => {
      if (sig === 'SIGTERM') queueMicrotask(() => child.emit('exit'));
    });
    await gracefulStopChild(child, { timeoutMs: 5_000, kill });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('force-kills with SIGKILL after the timeout elapses', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const kill = vi.fn();
    const done = gracefulStopChild(child, { timeoutMs: 5_000, kill });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    vi.useRealTimers();
  });

  it('never rejects even if kill() throws synchronously', async () => {
    const child = new EventEmitter();
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    await expect(gracefulStopChild(child, { timeoutMs: 5_000, kill })).resolves.toBeUndefined();
  });
});

describe('registerSidecarShutdownHooks', () => {
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    _resetSidecarShutdownHookRegistryForTests();
  });
  afterEach(() => {
    // Some cases invoke the fatal listener in this Vitest worker. Its exit
    // status belongs to the runner; real process outcomes are asserted below.
    process.exitCode = previousExitCode;
  });

  describe('fatal exception process outcomes (EI-27289258038460227)', () => {
    const run = (mode: 'async' | 'async-with-exit', scenario: string) => spawnSync(
      process.execPath,
      ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '--eval', `
        import { registerSidecarShutdownHooks } from ${JSON.stringify(new URL('./sidecar-spawn-shared.ts', import.meta.url).href)};
        const scenario = ${JSON.stringify(scenario)};
        let stops = 0;
        if (scenario === 'prior-failure') process.exitCode = 7;
        if (scenario === 'string-zero') process.exitCode = '0';
        registerSidecarShutdownHooks({
          label: 'fatal-process-control',
          mode: ${JSON.stringify(mode)},
          isFatalException: (err) => err.code !== 'EPIPE',
          stop: async () => {
            if (++stops > 1) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (scenario === 'stop-failure') throw new Error('PC_STOP_FAILURE_SENTINEL');
            console.log('PC_ASYNC_STOP_COMPLETE');
          },
        });
        process.on('exit', (code) => console.log('PC_PROCESS_EXIT', code, 'STOPS', stops));
        setImmediate(() => {
          const error = new Error('PC_FATAL_HOOK_SENTINEL');
          if (scenario === 'benign') error.code = 'EPIPE';
          throw error;
        });
      `],
      { encoding: 'utf8', timeout: 15_000 },
    );

    for (const mode of ['async', 'async-with-exit'] as const) {
      it.each(['fatal', 'string-zero', 'prior-failure', 'stop-failure'])(`${mode}: preserves fatal error and unsuccessful exit (%s)`, (scenario) => {
        const child = run(mode, scenario);
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(scenario === 'prior-failure' ? 7 : 1);
        expect(child.stderr).toContain('Error: PC_FATAL_HOOK_SENTINEL');
        if (scenario === 'stop-failure') {
          expect(child.stderr).toContain('Error: PC_STOP_FAILURE_SENTINEL');
        } else {
          expect(child.stdout).toContain('PC_ASYNC_STOP_COMPLETE');
        }
      });

      it(`${mode}: benign host error leaves the sidecar and successful exit alone`, () => {
        const child = run(mode, 'benign');
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(0);
        expect(child.stderr).not.toContain('PC_FATAL_HOOK_SENTINEL');
        expect(child.stdout).not.toContain('PC_ASYNC_STOP_COMPLETE');
        // async-with-exit may initiate cleanup at normal exit, but the benign
        // exception itself must never trigger it while the process is alive.
        expect(child.stdout).toContain(`PC_PROCESS_EXIT 0 STOPS ${mode === 'async-with-exit' ? 1 : 0}`);
      });
    }
  });

  it('is idempotent per label — a second call for the same label registers nothing new', () => {
    const before = process.listenerCount('SIGTERM');
    registerSidecarShutdownHooks({ label: 'test-idempotent', stop: () => {} });
    const afterFirst = process.listenerCount('SIGTERM');
    registerSidecarShutdownHooks({ label: 'test-idempotent', stop: () => {} });
    const afterSecond = process.listenerCount('SIGTERM');
    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBe(afterFirst);
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
  });

  it('async mode: SIGTERM handler awaits stop()', async () => {
    let stopped = false;
    registerSidecarShutdownHooks({
      label: 'test-async',
      stop: async () => {
        stopped = true;
      },
    });
    const listeners = process.listeners('SIGTERM');
    const newest = listeners[listeners.length - 1] as (...a: unknown[]) => unknown;
    await newest();
    expect(stopped).toBe(true);
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
  });

  // EI-24863236643374267: a sidecar whose caller arranged a stop at host exit must
  // stay up through the drain — measured on bg-host, stopping it at SIGTERM sent every
  // git call of the ~10 s drain to a 256-512 ms main-thread fork.
  it('deferStopToHostExit=true: SIGTERM and SIGINT leave the sidecar running', async () => {
    let stopped = 0;
    registerSidecarShutdownHooks({
      label: 'test-defer',
      stop: async () => {
        stopped += 1;
      },
      deferStopToHostExit: () => true,
    });
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      const listeners = process.listeners(sig);
      const newest = listeners[listeners.length - 1] as (...a: unknown[]) => unknown;
      await newest();
    }
    expect(stopped).toBe(0);
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
  });

  it('deferStopToHostExit is asked AT SIGNAL TIME — false then still stops at once', async () => {
    let drainArmed = false;
    let stopped = 0;
    registerSidecarShutdownHooks({
      label: 'test-defer-late',
      stop: async () => {
        stopped += 1;
      },
      deferStopToHostExit: () => drainArmed,
    });
    const listeners = process.listeners('SIGTERM');
    const newest = listeners[listeners.length - 1] as (...a: unknown[]) => unknown;
    await newest();
    expect(stopped).toBe(1);
    // The drain is installed AFTER registration in the real host; the predicate must
    // be read when the signal arrives, not captured when the hook was registered.
    drainArmed = true;
    await newest();
    expect(stopped).toBe(1);
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
  });

  it("sync-with-exit mode: registers an 'exit' listener too, fire-and-forget", () => {
    let called = 0;
    registerSidecarShutdownHooks({ label: 'test-sync', stop: () => { called += 1; }, mode: 'sync-with-exit' });
    const listeners = process.listeners('exit');
    expect(listeners.length).toBeGreaterThan(0);
    const newest = listeners[listeners.length - 1] as (...a: unknown[]) => unknown;
    newest();
    expect(called).toBe(1);
    process.removeAllListeners('exit');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  // P-006 (plan p2p-parity-parallel-lanes-2026-07-09): the ~6min sidecar
  // die/respawn churn. Root cause — `uncaughtException` fires process-wide for
  // EVERY exception, not just ones the sidecar cares about, so a healthy
  // sidecar was torn down on a benign `write EPIPE` (a client disconnect) the
  // host's OWN guard already swallowed. `isFatalException` closes that gap.
  describe('uncaughtException gating (isFatalException — P-006)', () => {
    afterEach(() => vi.restoreAllMocks());
    const newestUncaughtExceptionListener = (): ((err: unknown) => unknown) => {
      const listeners = process.listeners('uncaughtException');
      return listeners[listeners.length - 1] as (err: unknown) => unknown;
    };

    it('no isFatalException supplied (default) → stop() runs for any exception (back-compat)', async () => {
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('anything');
      let stopped = false;
      registerSidecarShutdownHooks({
        label: 'test-uncaught-default',
        stop: async () => {
          stopped = true;
        },
      });
      await newestUncaughtExceptionListener()(error);
      expect(stopped).toBe(true);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('uncaught exception'), error);
      expect(process.exitCode).toBe(1);
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
    });

    it('isFatalException returns false (benign, e.g. write EPIPE) → stop() is NOT called', async () => {
      let stopped = false;
      registerSidecarShutdownHooks({
        label: 'test-uncaught-benign',
        stop: async () => {
          stopped = true;
        },
        isFatalException: (err) => (err as { code?: string })?.code !== 'EPIPE',
      });
      await newestUncaughtExceptionListener()(
        Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      );
      expect(stopped).toBe(false);
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
    });

    it('isFatalException returns true (a real bug) → stop() still runs', async () => {
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new TypeError('real bug — not EPIPE');
      let stopped = false;
      registerSidecarShutdownHooks({
        label: 'test-uncaught-fatal',
        stop: async () => {
          stopped = true;
        },
        isFatalException: (err) => (err as { code?: string })?.code !== 'EPIPE',
      });
      await newestUncaughtExceptionListener()(error);
      expect(stopped).toBe(true);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('uncaught exception'), error);
      expect(process.exitCode).toBe(1);
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
    });
  });
});
