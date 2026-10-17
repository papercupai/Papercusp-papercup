/** D-021's final current-build matrix. Run only after the launcher source wall. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { describe, expect, it } from 'vitest';
import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { executeOperationalRun } from '../agent-tools/testing/record-run';
import { ompAgentHomeForSessionKey } from '../session-transcript-resolvers';
import { pgSessionArchiveStore } from '../session-archive';
import { findCanonicalClaudeLiveJsonl, findCanonicalNativeLiveJsonl, readCanonicalClaudeArchive,
  readCanonicalNativeArchive, readStableLiveJsonl } from './source';
import { adaptNativeSessionJsonl } from './native-adapter';
import { SESSION_PORT_SUPPORTED_PAIRS, type SessionBackend } from './types';

const root = resolve(import.meta.dirname, '../../../..');
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const enabled = Boolean(profilePath && process.env.PAPERCUSP_CBP_FINAL_MATRIX === '1');
const workspace = 'papercusp-workspace';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Session = { id: string; agent: SessionBackend; coord_owner_id: string;
  session_id: string | null; omp_thread_id: string | null; ended_at: string | null };

function verifiedEmptyCleanup(name: string, args: Record<string, unknown>, status: number | null,
  value: Record<string, any> | undefined) {
  const row = value?.results?.[0];
  return name === 'processes:kill' && args.reapTerminalResidue === true && status === 5 &&
    value?.results?.length === 1 && row.taskId === args.taskId && row.error === 'not_live' &&
    typeof row.detail === 'string' && row.detail.includes('holds no live process right now; nothing to reap');
}

function call(name: string, args: Record<string, unknown>, origin: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' };
  delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = spawnSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${origin}`, '--json', '-'], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ name, args: { ...args, payloadTier: 'full' } }),
  });
  let value: Record<string, any> | undefined;
  try { value = JSON.parse(result.stdout); } catch { /* Report the original CLI failure below. */ }
  if (!verifiedEmptyCleanup(name, args, result.status, value) &&
    (result.status !== 0 || !value || value.ok === false)) {
    // stderr starts with connection traces. The actual tool refusal is normally
    // in stdout; retain that receipt before throwing into the operational recorder.
    const diagnostic = { name, status: result.status, signal: result.signal,
      error: result.error?.message, receipt: value ?? result.stdout, stderr: result.stderr };
    console.error('CBP_FINAL_MCP_FAILURE', JSON.stringify(diagnostic));
    throw new Error(`MCP ${name} failed: ${JSON.stringify(value ?? result.stdout)}\n` +
      `exit=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'}\n` +
      result.stderr.slice(-1000));
  }
  if (!value) throw new Error(`MCP ${name} returned no readable receipt`);
  return value;
}

describe('owned matrix cleanup receipt', () => {
  const args = { taskId: 'owned-task', reapTerminalResidue: true };
  const receipt = { ok: false, results: [{ taskId: 'owned-task', error: 'not_live',
    detail: 'state is exited — reap requested but scope owned.service holds no live process right now; nothing to reap' }] };
  it('accepts only a positively verified empty owned scope', () => {
    expect(verifiedEmptyCleanup('processes:kill', args, 5, receipt)).toBe(true);
  });
  it('does not infer cleanup from a terminal ledger row alone', () => {
    expect(verifiedEmptyCleanup('processes:kill', args, 5, { ok: false,
      results: [{ taskId: 'owned-task', error: 'not_live', detail: 'state is exited' }] })).toBe(false);
  });
  it('rejects unknown outcomes and receipts for another task', () => {
    expect(verifiedEmptyCleanup('processes:kill', args, null, receipt)).toBe(false);
    expect(verifiedEmptyCleanup('processes:kill', { ...args, taskId: 'another-task' }, 5, receipt)).toBe(false);
    expect(verifiedEmptyCleanup('processes:kill', { taskId: 'owned-task' }, 5, receipt)).toBe(false);
  });
});

function rows(sql: string, origin: string) {
  return call('dev:pg_query', { sql, maxRows: 10, timeoutMs: 15_000,
    allowUnscoped: false, allowUnboundedJsonSearch: false }, origin).rows as Array<Record<string, any>>;
}

function matrixParentTaskId(env: NodeJS.ProcessEnv = process.env) {
  const id = env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
  if (!id || !/^[0-9a-z]{4,64}$/.test(id)) {
    throw new Error('The final matrix requires a durable parent task before launching API fixtures');
  }
  return id;
}

function matrixParentWorkItemId(parentTaskId: string, tasks: unknown) {
  const matches = Array.isArray(tasks)
    ? tasks.filter(task => task?.taskId === parentTaskId && task?.state === 'running')
    : [];
  const workItemId = matches[0]?.workItemId;
  if (matches.length !== 1 || typeof workItemId !== 'string' || !workItemId.trim()) {
    throw new Error('The final matrix requires exactly one live parent task with a held work item');
  }
  return workItemId;
}

function assertLauncherLogProgress(taskId: string, log: string) {
  if (/JOB END: status=(?:failed|killed|timed_out)|JOB DIED|refusing to launch|session-port target bootstrap\/spawn failed/.test(log)) {
    throw new Error(`Owned matrix launcher failed (${taskId}): ${log.slice(-4000)}`);
  }
}

function assertMatrixCapacity(provider: 'claude' | 'codex', report: Record<string, unknown>) {
  // `serving` is the probe's policy-checked STATE. `ok`, HTTP 200, unknown
  // projections and the `unwalled` DELTA do not establish eligible capacity.
  if (report.provider !== provider || report.dryRun !== true ||
    !Array.isArray(report.serving) || !report.serving.some(id => typeof id === 'string' && id.length > 0)) {
    throw new Error(`Final matrix has no eligible ${provider} capacity from its dry probe: ` +
      JSON.stringify({ provider: report.provider, dryRun: report.dryRun, probed: report.probed,
        serving: report.serving, confirmedWalled: report.confirmedWalled, failed: report.failed }));
  }
}

describe('owned matrix capacity preflight', () => {
  it('accepts measured serving capacity without requiring an unwall correction', () => {
    expect(() => assertMatrixCapacity('claude', { provider: 'claude', dryRun: true,
      probed: 1, serving: ['healthy'], unwalled: [] })).not.toThrow();
  });
  it.each([
    { confirmedWalled: ['weekly-full'], failed: [] },
    { confirmedWalled: [], failed: ['insufficient-credit'] },
    { confirmedWalled: [], failed: [], ok: true, available: true },
  ])('refuses walls, missing readings and success-shaped projections before launching fixtures: %j', detail => {
    expect(() => assertMatrixCapacity('claude', { provider: 'claude', dryRun: true,
      probed: 1, serving: [], ...detail })).toThrow('no eligible claude capacity');
  });
  it('does not substitute another provider or a projection-writing probe', () => {
    expect(() => assertMatrixCapacity('claude', { provider: 'codex', dryRun: true,
      serving: ['healthy-codex'] })).toThrow('no eligible claude capacity');
    expect(() => assertMatrixCapacity('claude', { provider: 'claude', dryRun: false,
      serving: ['healthy'] })).toThrow('dry probe');
  });
});

// expect.poll retries exceptions as assertion failures. A dead launcher is a
// terminal error, so propagate it immediately rather than hiding it for 240s.
async function waitForLauncherObservation(observe: () => boolean | Promise<boolean>, timeout: number,
  interval = 5000) {
  const deadline = Date.now() + timeout;
  while (true) {
    if (await observe()) return;
    if (Date.now() >= deadline) throw new Error(`Owned matrix observation did not converge within ${timeout}ms`);
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
  }
}

function assertSourceAvailable(source: Session, origin: string) {
  const active = rows(`SELECT active.id FROM harness_shared.adv_sessions active
    WHERE active.workspace_id = ${literal(workspace)} AND active.ended_at IS NULL
    AND (active.id = ${Number(source.id)} OR active.coord_owner_id = ${literal(source.coord_owner_id)}
      OR active.id IN (SELECT port.target_adv_session_id FROM harness_shared.session_ports port
        WHERE port.workspace_id = ${literal(workspace)} AND port.source_adv_session_id = ${Number(source.id)}))
    ORDER BY active.id DESC LIMIT 10`, origin);
  expect(active, `Source ${source.id} still has a live fixture; cleanup must finish before another launch`).toEqual([]);
}

describe('owned matrix lifetime and progress', () => {
  it('requires the real managed parent marker', () => {
    expect(matrixParentTaskId({ PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'parent123' })).toBe('parent123');
    expect(() => matrixParentTaskId({})).toThrow('durable parent task');
    expect(() => matrixParentTaskId({ PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '../bad' })).toThrow();
  });
  it('uses the live parent task work item for nested fixture launches', () => {
    expect(matrixParentWorkItemId('parent123', [
      { taskId: 'other', state: 'running', workItemId: 'WI-legacy' },
      { taskId: 'parent123', state: 'running', workItemId: 'EI-current' },
    ])).toBe('EI-current');
    expect(() => matrixParentWorkItemId('parent123', [
      { taskId: 'parent123', state: 'exited', workItemId: 'EI-current' },
    ])).toThrow('live parent task');
    expect(() => matrixParentWorkItemId('parent123', [
      { taskId: 'parent123', state: 'running' },
    ])).toThrow('held work item');
  });
  it.each(['failed', 'killed', 'timed_out'])('stops immediately when the launcher is %s', async status => {
    let observations = 0;
    await expect(waitForLauncherObservation(() => {
      observations++;
      assertLauncherLogProgress('fixture123', `[capability:bash] JOB END: status=${status} exit=1`);
      return false;
    }, 240_000)).rejects.toThrow('Owned matrix launcher failed');
    expect(observations).toBe(1);
  });
  it('waits for a pending observation and accepts a clean launcher exit', async () => {
    let observations = 0;
    await waitForLauncherObservation(() => {
      assertLauncherLogProgress('fixture123', '[capability:bash] JOB END: status=completed exit=0');
      return ++observations === 3;
    }, 1000, 0);
    expect(observations).toBe(3);
  });
});

async function native(session: Session, archivedSource = false) {
  const id = session.agent === 'omp' ? session.omp_thread_id ?? session.session_id : session.session_id;
  if (!id) return undefined;
  const path = await (session.agent === 'claude'
    ? findCanonicalClaudeLiveJsonl(sessionClaudeConfigDir(session.coord_owner_id), id)
    : findCanonicalNativeLiveJsonl(join(session.agent === 'codex'
      ? codexHomeForSessionKey(Number(session.id)) : ompAgentHomeForSessionKey(Number(session.id)), 'sessions'), session.agent, id))
    .catch(error => { if (!archivedSource) throw error; return null; });
  // Ended fixtures are archived and removed from disk by the normal lifecycle.
  // Read their exact native archive with the production manifest/hash guards.
  // A fresh cross-backend target must still prove its physical live transcript.
  if (!path && !archivedSource) return undefined;
  const snapshot = path ? await readStableLiveJsonl(path) : session.agent === 'claude'
    ? await readCanonicalClaudeArchive({ sessionId: id }, pgSessionArchiveStore())
    : await readCanonicalNativeArchive({ backend: session.agent, sessionId: id }, pgSessionArchiveStore());
  const text = adaptNativeSessionJsonl(session.agent, snapshot.bytes.toString('utf8'), id)
    .turns.flatMap(turn => turn.blocks.flatMap(block => 'text' in block ? [String(block.text)] : [])).join('\n');
  return { id, path, sha256: snapshot.sha256, text };
}

describe.skipIf(!enabled)('final live session resume matrix', () => {
  it('delivers six cross-backend ports and three original-backend PUI-shaped resumes', async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    const origin = profile.origin as string;
    const recordContext = { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root };
    expect(resolveAgentWorkspaceRoot(recordContext), 'Recorder must measure this committed test tree').toBe(root);
    const owner = call('coord:whoami', {}, origin).ownerId as string;
    expect(owner).toBe(process.env.PAPERCUSP_SID);
    const parentTaskId = matrixParentTaskId();
    const parentWorkItemId = matrixParentWorkItemId(parentTaskId,
      call('processes:list', { taskId: parentTaskId }, origin).tasks);
    // Both target backends, and Claude maintenance summarization, are required
    // by the unchanged matrix profile. Refuse known capacity walls before any
    // fixture is launched; dry probes neither unwall nor readmit accounts.
    for (const provider of ['claude', 'codex'] as const) {
      const capacity = call('accounts:probe-capacity', { provider, apply: false }, origin);
      console.info('CBP_FINAL_CAPACITY_PREFLIGHT', JSON.stringify({ provider,
        dryRun: capacity.dryRun, probed: capacity.probed, serving: capacity.serving,
        confirmedWalled: capacity.confirmedWalled, failed: capacity.failed }));
      assertMatrixCapacity(provider, capacity);
    }
    const ids = profile.resumeMatrix.sourceAdvSessionIds as number[];
    expect(ids).toHaveLength(3);
    expect(ids.every(id => Number.isSafeInteger(id) && id > 0)).toBe(true);
    const sessions = rows(`SELECT id, agent, coord_owner_id, session_id, omp_thread_id, ended_at
      FROM harness_shared.adv_sessions WHERE workspace_id = ${literal(workspace)}
      AND id IN (${ids.join(',')}) ORDER BY id LIMIT 3`, origin) as Session[];
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map(session => session.agent))).toEqual(new Set(['claude', 'codex', 'omp']));
    for (const source of sessions) {
      expect(source.ended_at, `Source ${source.id} must be an ended plan fixture`).toBeTruthy();
      assertSourceAvailable(source, origin);
      const snapshot = await native(source, true);
      expect(snapshot?.text).toContain('MATRIX-SRC');
    }
    // Fresh managed hosts below use the canonical launcher, whose bytes must
    // match this committed test tree. No existing peer host is restarted.
    const canonical = process.env.PAPERCUSP_CANONICAL_TREE || process.env.PAPERCUSP_INTEGRATION_ROOT;
    if (!canonical) throw new Error('The final matrix requires the maintained canonical tree selector');
    const sourceHashes: Record<string, string> = {};
    for (const path of ['apps/operator/scripts/psu-launcher.mjs', 'apps/operator/scripts/psu-pty-host.mjs']) {
      const hash = (base: string) => createHash('sha256').update(readFileSync(resolve(base, path))).digest('hex');
      sourceHashes[path] = hash(root);
      expect(hash(canonical), `Canonical ${path} changed after preparation`).toBe(sourceHashes[path]);
    }
    const observations: Array<Record<string, unknown>> = [];
    const attemptId = randomUUID();
    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/session-port/resume.live.e2e.test.ts',
      name: 'D-021 six ordered session ports and original-backend PUI resume shapes', framework: 'operational',
      command: ['npm', 'run', 'test:file', '--', 'packages/operator-core/lib/session-port/resume.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const launch = async (source: Session, target?: SessionBackend) => {
          assertSourceAvailable(source, origin);
          const startedAt = new Date().toISOString();
          const args = ['--no-picker', '--headless', `--workspace=${workspace}`, '--harness=papercusp',
            '--no-plan', '--context-size=trimmed', '--account=auto', `--launched-by=${owner}`,
            `--resume=${source.id}`, `--label=cbp-final-${source.agent}-${target ?? 'same'}`];
          // A completed semantic request is intentionally idempotent. This
          // validation is a new request, so bind its actual instruction to this
          // attempt rather than accidentally reopening yesterday's target.
          const instruction = `Resume validation ${attemptId}, ${source.agent} to ${target ?? source.agent}. ` +
            'Report the fixture marker already present in the carried user history. Do not call tools or start other work.';
          args.push(`--kickoff=${instruction}`);
          if (target) {
            args.push(`--agent=${target}`);
            // Preserve the established matrix's compatible backend profiles.
            if (target === 'codex') args.push('--model=gpt-6.1-sol:xhigh', '--model-source=explicit');
            if (target === 'claude') args.push('--model=fable[1m]');
          }
          const command = ['env', '-u', 'PAPERCUSP_SID', '-u', 'PAPERCUSP_CAPABILITY_BASH_FOREGROUND',
            `PAPERCUSP_PSU_LAUNCHER=${canonical}/apps/operator/scripts/psu-launcher.mjs`,
            `PAPERCUSP_OPERATOR_URL=${origin}`, process.execPath,
            `${canonical}/apps/operator/scripts/psu-launcher.mjs`, ...args].map(shellQuote).join(' ');
          const task = call('capability:bash', { command, cwd: canonical, timeout: 900_000,
            run_in_background: true, work_item_id: parentWorkItemId,
            parent_task_id: parentTaskId,
            description: `Final matrix ${source.agent} to ${target ?? 'original backend'}` }, origin);
          expect(task.task_id).toBeTruthy();
          expect(task.log_path).toBeTruthy();
          console.info('CBP_FINAL_RESUME_TASK', JSON.stringify(task));
          const assertLauncherProgress = () => {
            let log = '';
            try { log = readFileSync(task.log_path, 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            assertLauncherLogProgress(task.task_id, log);
          };
          let primaryError: unknown;
          try {
            let resumed!: Session;
            let port: Record<string, any> | undefined;
            await waitForLauncherObservation(() => {
              assertLauncherProgress();
              const candidates = rows(`SELECT id, agent, coord_owner_id, session_id, omp_thread_id, ended_at,
                port_id FROM harness_shared.adv_sessions WHERE workspace_id = ${literal(workspace)}
                AND ${target ? `label = ${literal(`cbp-final-${source.agent}-${target}`)}
                  AND started_at >= ${literal(startedAt)}::timestamptz` : `id = ${Number(source.id)} AND ended_at IS NULL`}
                ORDER BY id DESC LIMIT 1`, origin);
              if (!candidates[0]) return false;
              resumed = candidates[0] as Session;
              if (resumed.agent !== (target ?? source.agent)) return false;
              if (!target) return Boolean(resumed.session_id || resumed.omp_thread_id);
              port = rows(`SELECT id, status, source_adv_session_id, target_adv_session_id, metadata
                FROM harness_shared.session_ports WHERE workspace_id = ${literal(workspace)}
                AND source_adv_session_id = ${Number(source.id)}
                AND prepared_at >= ${literal(startedAt)}::timestamptz
                AND target_adv_session_id = ${Number(resumed.id)} ORDER BY prepared_at DESC LIMIT 1`, origin)[0];
              return port?.status === 'delivered';
            }, 240_000);
            let snapshot: Awaited<ReturnType<typeof native>>;
            await waitForLauncherObservation(async () => {
              assertLauncherProgress();
              snapshot = await native(resumed);
              return Boolean(snapshot?.text.includes(target ? `port-id: ${port!.id}` : 'MATRIX-SRC'));
            }, 120_000);
            if (!target) expect(snapshot!.id).toBe(source.agent === 'omp'
              ? source.omp_thread_id ?? source.session_id : source.session_id);
            else {
              expect(Number(port!.source_adv_session_id)).toBe(Number(source.id));
              expect(port!.metadata.persistenceProof).toBeTruthy();
            }
            observations.push({ source: source.agent, target: target ?? source.agent,
              attemptId,
              sourceAdvSessionId: source.id, targetAdvSessionId: resumed.id,
              port, nativePath: snapshot!.path, nativeSha256: snapshot!.sha256, nativeSessionId: snapshot!.id });
            console.info('CBP_FINAL_RESUME_OBSERVATION', JSON.stringify(observations.at(-1)));
          } catch (error) {
            primaryError = error;
            throw error;
          } finally {
            // This task was created by this test; stop its managed subtree only.
            try {
              const cleanup = call('processes:kill', { taskId: task.task_id,
                includeSubtree: true, escalateAfterMs: 5000, reapTerminalResidue: true }, origin);
              console.info('CBP_FINAL_RESUME_CLEANUP', JSON.stringify({ taskId: task.task_id, receipt: cleanup }));
            } catch (cleanupError) {
              // A finally failure must not erase the observation that failed first.
              throw new Error(`Owned matrix cleanup failed (${task.task_id}): ${String(cleanupError)}\n` +
                `Primary observation failure: ${primaryError === undefined ? 'none' : String(primaryError)}`);
            }
          }
        };
        for (const pair of SESSION_PORT_SUPPORTED_PAIRS) {
          await launch(sessions.find(session => session.agent === pair.source)!, pair.target);
        }
        for (const source of sessions) await launch(source);
        expect(observations).toHaveLength(9);
        for (const [path, sha256] of Object.entries(sourceHashes)) {
          expect(createHash('sha256').update(readFileSync(resolve(canonical, path))).digest('hex')).toBe(sha256);
        }
        return { exitCode: 0, summary: 'Six fresh delivered ports and three PUI-shaped original-backend native resumes',
          assertions: observations.map((observation, index) => ({
            id: `resume-${index}-${observation.source}-${observation.target}`, passed: true,
            evidence: JSON.stringify(observation).slice(0, 2000),
          })) };
      },
    }, recordContext);
    console.info('CBP_FINAL_RESUME_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
  }, 3_600_000);
});
