// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { metaPathFor, socketPathFor, nativeExecutionFromRows } from '../scripts/psu-pty-host.mjs';

const m = vi.hoisted(() => ({ sql: null as any, launch: vi.fn(), ws: 'interrupted-host-journey',
  targets: vi.fn(), claimHeadcount: vi.fn(), replacement: vi.fn(), recordHeadcount: vi.fn(), fleet: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<object>(), getOrgPg: () => ({ sql: m.sql }),
}));
vi.mock('../../../packages/operator-core/lib/workspace-registry', async original => ({
  ...await original<object>(), activeWorkspaceId: () => m.ws,
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<object>(),
  getFlag: async (flag: string) => flag === 'papercusp-fleet-headcount-governor',
}));
vi.mock('../../../packages/operator-core/lib/agent-fleets-store', async original => ({
  ...await original<object>(), listFleetHeadcountTargets: m.targets,
  listExpiredFleetTopUpRules: async () => [], claimFleetHeadcountAttempt: m.claimHeadcount,
  getFleet: m.fleet, recordFleetHeadcountAttempt: m.recordHeadcount,
}));
vi.mock('../../../packages/operator-core/lib/fleet/fleet-roster', async original => ({
  ...await original<object>(), liveFleetMemberIds: async () => [],
}));
vi.mock('../../../packages/operator-core/lib/console-spawn', async original => ({
  ...await original<object>(), spawnHeadless: m.replacement, spawnConsole: m.replacement,
}));
// Only the final native launch is substituted: it opens a real managed PTY with
// a deterministic CLI, avoiding model calls. WAL, ingest, SQL arbitration,
// discovery, classifier, teardown and the replacement host are production code.
vi.mock('../../../packages/operator-core/lib/agent-tools/capability/launch-agent', () => ({
  default: { handler: m.launch }, INTERNAL_INTERRUPTION_RECOVERY: Symbol.for('host-journey'),
}));
import { runSessionInterruptionPass as sweepSessionInterruptions } from '@papercusp/operator-core/lib/harness/routines/session-interruption-runtime';
// These are adapter/native-host scenarios, independent of DBOS controller proof.
// The actual governor's new enqueue seam is drained synchronously in this fixture.
vi.mock('../../../packages/operator-core/lib/dbos/session-interruption-workflow', () => ({
  enqueueSessionInterruption: async () => {
    const { runSessionInterruptionPass } = await import('../../../packages/operator-core/lib/harness/routines/session-interruption-runtime');
    await runSessionInterruptionPass({ workspaceId: m.ws, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null });
    return { workflowId: 'native-adapter-fixture' };
  },
}));
import * as waits from '@papercusp/operator-core/lib/events/await/store';
import { pumpWakeDeliveries, setAutoPumpEnabledForTests } from '@papercusp/operator-core/lib/events/await/engine';
import { closeGate, openOrTouchGate } from '@papercusp/operator-core/lib/attention/gate-store';
import { injectIntoHostWithConfirmation } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';
import { runFleetHeadcountGovernor } from '@papercusp/operator-core/lib/harness/routines/fleet-headcount-action';

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); m.sql = db.adminSql; }, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function eventually<T>(read: () => T | undefined,
  diagnostic: () => string | Promise<string> = () => 'host observation unavailable'): Promise<T> {
  return vi.waitFor(async () => {
    const value = read();
    expect(value, value == null ? await diagnostic() : undefined).toBeDefined();
    return value as T;
  }, { timeout: 15_000, interval: 30 });
}

describe('lost host to restored native conversation', () => {
  it.each<{
    headless: boolean; waiting: boolean; stopped: boolean; negative: string | null;
    boundary?: 'event' | 'deadline' | 'human'; duringDowntime?: boolean;
    fleetFirst?: boolean;
    productionGuarded?: boolean;
  }>([
    { headless: true, waiting: false, stopped: false, negative: null, productionGuarded: true },
    { headless: true, waiting: false, stopped: false, negative: null },
    ...[true, false].map(fleetFirst => ({ headless: fleetFirst, waiting: false,
      stopped: false, negative: null, fleetFirst })),
    ...(['event', 'deadline', 'human'] as const).flatMap(boundary => [false, true].map(duringDowntime => ({
      headless: duringDowntime, waiting: true, stopped: false, negative: null, boundary, duringDowntime,
    }))),
    { headless: true, waiting: false, stopped: true, negative: null },
    { headless: true, waiting: false, stopped: false, negative: 'completed' },
    { headless: true, waiting: false, stopped: false, negative: 'unknown' },
    { headless: true, waiting: false, stopped: false, negative: 'stale' },
  ])('preserves placement=$headless wait=$waiting stop=$stopped negative=$negative boundary=$boundary downtime=$duringDowntime fleetFirst=$fleetFirst production=$productionGuarded', async scenario => {
    const root = mkdtempSync(join(tmpdir(), 'interrupted-host-journey-'));
    const owner = `ih-${process.pid}-${Date.now()}`;
    const ws = m.ws;
    const boundaryMarker = `RECOVERY_BOUNDARY_${owner}`;
    const fleetSlug = `journey-fleet-${owner}`;
    const eventKey = `dependency:journey-ready:${owner}`;
    let originalAwaitId: number | undefined;
    const originalAutoPump = setAutoPumpEnabledForTests(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.targets.mockResolvedValue([]); m.replacement.mockReset();
    m.replacement.mockResolvedValue({ status: 'error', error: 'unexpected replacement' });
    m.claimHeadcount.mockResolvedValue({ workspaceId: ws, fleetSlug, target: 1,
      config: { supervise: true, harness: 'papercusp', headless: scenario.headless } });
    m.fleet.mockResolvedValue({ lastLaunchTransaction: null, leaderOwnerId: 'journey-leader' });
    m.recordHeadcount.mockResolvedValue(undefined);
    const native = '30c49db4-e1e3-4ac7-9bec-960c500b46ea';
    const config = join(root, 'codex');
    mkdirSync(join(config, 'sessions'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    const nativeCli = join(root, 'bin', 'codex');
    writeFileSync(join(config, 'config.toml'), '');
    const transcript = join(config, 'sessions', `rollout-${native}.jsonl`);
    writeFileSync(transcript, '');
    const [adv] = await db.adminSql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, launch_spec, cwd, launch_argv)
      VALUES (${ws}, 'codex', 'console', ${owner}, ${native}, now(),
        ${JSON.stringify({ v: 1, agent: 'codex', workspaceId: ws, harnessSlug: 'papercusp',
          headless: scenario.headless })}::jsonb, ${root},
        ${JSON.stringify(['psu', '--no-picker', '--agent=codex', '--harness=papercusp',
          '--account=default', '--carry=warm', '--role=su', ...(scenario.headless ? ['--headless'] : [])])}::jsonb)
      RETURNING id`;
    const children: ChildProcess[] = [];
    let nativeOutput = '';
    const hostModule = fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url));
    const readMeta = () => {
      try { return JSON.parse(readFileSync(metaPathFor(owner), 'utf8')); } catch { return undefined; }
    };
    const start = async (work: boolean) => {
      const startedPayload = { type: 'task_started', turn_id: 'journey-original' };
      const completedPayload = { type: 'task_complete', turn_id: 'journey-original' };
      const completes = (work && (scenario.negative === 'completed' || scenario.waiting)) ||
        (scenario.productionGuarded && children.length > 0 && !scenario.waiting);
      // Reject malformed fixture events before paying for a native process.
      const at = Date.now();
      const fixtureRows = [startedPayload, ...(completes ? [completedPayload] : [])]
        .map(payload => ({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload }));
      expect(nativeExecutionFromRows(fixtureRows, { agent: 'codex', nowMs: at }).phase)
        .toBe(completes ? 'settled' : 'running');
      const nativeCode = `const fs=require('node:fs');
        process.on('SIGINT',()=>{});
        let input=''; process.stdin.on('data',chunk=>{input+=chunk;
          while(input.includes(${JSON.stringify(boundaryMarker)})) {
            const submitted=input;
            input=input.slice(input.indexOf(${JSON.stringify(boundaryMarker)})+${boundaryMarker.length});
            const at=new Date().toISOString();
            fs.appendFileSync(${JSON.stringify(transcript)},JSON.stringify({type:'response_item',timestamp:at,
              payload:{type:'message',role:'user',content:[{type:'input_text',text:submitted}]}})+String.fromCharCode(10));
            fs.appendFileSync(${JSON.stringify(transcript)},JSON.stringify({type:'event_msg',timestamp:at,
              payload:{type:'task_started',turn_id:'original-wait-boundary'}})+String.fromCharCode(10));
            fs.appendFileSync(${JSON.stringify(transcript)},JSON.stringify({type:'event_msg',timestamp:at,
              payload:{type:'task_complete',turn_id:'original-wait-boundary'}})+String.fromCharCode(10));
          }}); process.stdin.resume();
        setTimeout(()=>{if (${work}) fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({type:'event_msg',
          timestamp:new Date().toISOString(),payload:${JSON.stringify(startedPayload)}})+String.fromCharCode(10));},100);
        ${completes ? `setTimeout(()=>fs.appendFileSync(${JSON.stringify(transcript)},
          JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:${JSON.stringify(completedPayload)}})+String.fromCharCode(10)),200);` : ''}
        process.stdout.write('\x1b[6nmodel: GPT-6.1-Sol xhigh'+String.fromCharCode(10)+
          'Ready · GPT-6.1-Sol xhigh · Context 100% left'+String.fromCharCode(10));`;
      // The managed host adds Codex startup configuration to argv. Execute a
      // real script that accepts those arguments rather than passing them to
      // Node's own option parser through a symlink.
      writeFileSync(nativeCli, `#!${process.execPath}\n${nativeCode}`, { mode: 0o700 });
      const hostCode = `import {hostThroughPty} from ${JSON.stringify(hostModule)};
        import {EventEmitter} from 'node:events';
        const stdin=Object.assign(new EventEmitter(),{isTTY:false,resume(){},pause(){}});
        const signalSource=new EventEmitter();
        const done=hostThroughPty({command:${JSON.stringify(nativeCli)},args:[],
          cwd:${JSON.stringify(root)},ownerId:${JSON.stringify(owner)},advSessionId:${JSON.stringify(String(adv.id))},
          env:process.env,bridgeTty:${scenario.stopped},activityPersistMs:25,
          resolveRespawnNativeId:()=>${JSON.stringify(native)},
          io:{stdin,stdout:{isTTY:false,write(data){process.stdout.write(data);return true;}}},signalSource,onExit(){}});
        ${scenario.stopped && work ? "setTimeout(()=>stdin.emit('data',Buffer.from([3])),500);" : ''}
        process.on('SIGTERM',()=>signalSource.emit('SIGTERM')); await done;`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', hostCode], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: hermeticEnv({ CODEX_HOME: config, PAPERCUSP_SID: owner,
          PAPERCUSP_AGENT: 'codex', PAPERCUSP_WORKSPACE_ID: ws,
          PAPERCUSP_PSU_HEADLESS: scenario.headless ? '1' : '0' }),
      });
      children.push(child);
      let stderr = '';
      child.stdout?.on('data', chunk => { nativeOutput += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      return eventually(() => {
        if (child.exitCode != null) throw new Error(`fixture host exited: ${stderr}`);
        const meta = readMeta();
        if (meta && meta.execution?.nativeSessionId == null) {
          throw new Error(`native identity absent: ${JSON.stringify(meta.execution)}; stderr=${stderr}`);
        }
        return meta?.pid === child.pid && meta.execution?.nativeSessionId === native ? meta : undefined;
      }, () => JSON.stringify({ stage: 'host-start', meta: readMeta(), stderr }));
    };
    try {
      if (scenario.productionGuarded) {
        // Exercise the real envelope/resume path against the private registry.
        // Validate its prerequisites before opening either native process.
        const { writeOperatorState } = await import('../../../packages/operator-core/lib/operator-state-pg');
        await writeOperatorState('harness_registry', {
          projects: [{ slug: 'papercusp', path: root }],
        }, ws);
        const { buildConsoleEnvelope } = await import('../../../packages/operator-core/lib/console-launcher');
        expect((await buildConsoleEnvelope({ workspaceId: ws, slug: 'papercusp',
          operatorBaseUrl: 'http://127.0.0.1:3170' })).cwd).toBe(root);
        await vi.importActual('../../../packages/operator-core/lib/agent-tools/capability/launch-agent');
      }
      const original = await start(true);
      await eventually(() => {
        const meta = readMeta();
        return meta?.execution?.phase === (scenario.negative === 'completed' || scenario.waiting ? 'settled' : 'running') &&
          (!scenario.stopped || meta.execution.ownerStopRequested) ? meta : undefined;
      }, () => JSON.stringify({ stage: 'native-execution', meta: readMeta(), nativeOutput,
        exitCode: children.at(-1)?.exitCode, signalCode: children.at(-1)?.signalCode,
        transcript: readFileSync(transcript, 'utf8') }));
      if (scenario.waiting) {
        const wait = await waits.registerAwait({ subscriberId: owner, eventKey, policy: 'wake',
          timeoutSec: 3600, timeoutBehavior: 'wake',
          wakeHandle: { kind: 'adv-session', advSessionId: Number(adv.id), agent: 'codex',
            sessionId: native, ompThreadId: null, cwd: root, pid: original.pid } });
        originalAwaitId = wait.id;
        if (scenario.boundary === 'human') await openOrTouchGate({ workspaceId: ws,
          sessionId: native, client: 'codex', kind: 'ask', refId: eventKey, ownerId: owner, source: 'hook' });
      }
      await db.adminSql`UPDATE harness_shared.adv_sessions SET pid = ${original.pid}
        WHERE id = ${adv.id}`;
      const first = children[0]!;
      const exited = new Promise(resolve => first.once('exit', resolve));
      process.kill(-first.pid!, 'SIGKILL');
      await exited;
      if (scenario.fleetFirst != null) {
        await db.adminSql`INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, fleet_slug, fleet_role)
          VALUES (${owner}, ${ws}, ${fleetSlug}, 'member')`;
        m.targets.mockResolvedValue([{ workspaceId: ws, fleetSlug, target: 1,
          config: { supervise: true, harness: 'papercusp', headless: scenario.headless } }]);
      }
      const fireBoundary = async () => {
        if (scenario.boundary === 'human') await closeGate({ workspaceId: ws,
          sessionId: native, refId: eventKey, reason: 'tool_result_observed' });
        if (scenario.boundary === 'deadline') await db.adminSql`UPDATE harness_shared.event_awaits
          SET expires_ts = now() - interval '1 second' WHERE id = ${originalAwaitId!}`;
        const fired = scenario.boundary === 'deadline'
          ? await waits.fireTimedOutAwaits() : await waits.fireAwaitsForKey({ eventKey });
        await waits.insertDeliveries({ awaits: fired, summary: boundaryMarker, urgent: true });
        return fired;
      };
      if (scenario.duringDowntime) {
        expect(await fireBoundary()).toHaveLength(1);
        const queued = await waits.listRecentDeliveries(owner);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ awaitId: originalAwaitId, status: 'pending' });
      }
      if (scenario.negative === 'unknown') await db.adminSql`UPDATE harness_shared.adv_sessions
        SET launch_spec = NULL WHERE id = ${adv.id}`;
      if (scenario.negative === 'stale') await db.adminSql`UPDATE harness_shared.adv_sessions
        SET session_id = 'superseding-native' WHERE id = ${adv.id}`;
      const transcriptBeforeRecovery = readFileSync(transcript, 'utf8');
      let entered!: () => void;
      let release!: () => void;
      const launchEntered = new Promise<void>(resolve => { entered = resolve; });
      const launchReleased = new Promise<void>(resolve => { release = resolve; });
      m.launch.mockReset().mockImplementation(async (args: any, launchContext: any) => {
        expect(args).toMatchObject({ resume: { agentId: owner }, fork: false, headless: scenario.headless });
        expect(args[Symbol.for('host-journey')]).toMatchObject({ ownerId: owner,
          nativeSessionId: native, wait: scenario.waiting });
        expect(Boolean(args.brief)).toBe(!scenario.waiting);
        // A wait-only restore must not manufacture native progress.
        const before = readFileSync(transcript, 'utf8');
        entered();
        if (scenario.fleetFirst != null) await launchReleased;
        if (scenario.productionGuarded) {
          const production = await vi.importActual<typeof import('../../../packages/operator-core/lib/agent-tools/capability/launch-agent')>(
            '../../../packages/operator-core/lib/agent-tools/capability/launch-agent');
          // Preserve the real handler, resume resolver, safety callbacks and
          // verification. Only the last OS spawn is a deterministic native CLI.
          m.replacement.mockImplementation(async (options: any) => {
            expect(options.coordOwnerId).toBe(owner);
            expect(options.envelope.cwd).toBe(root);
            expect(options.envelope.greetingCmd).toContain(native);
            const replacement = await start(false);
            const { nativeSessionIdFromHost } = await import('../../../packages/operator-core/lib/agent-launch-core');
            expect(nativeSessionIdFromHost(replacement)).toBe(native);
            // The deterministic native child owns this transcript. Observe the
            // actual submitted kickoff before returning the spawner's receipt.
            const kickoff = options.envelope.env.PAPERCUSP_KICKOFF_PROMPT;
            let kickoffProof;
            if (kickoff) {
              await eventually(() => readMeta()?.execution?.phase === 'settled' ? true : undefined,
                () => JSON.stringify({ stage: 'replacement-ready', execution: readMeta()?.execution }));
              const delivery = await injectIntoHostWithConfirmation(socketPathFor(owner), { mode: 'turn',
                data: `${kickoff}\n${boundaryMarker}`, deliveryId: `kickoff:${owner}` });
              const witnessed = await eventually(() => {
                const rows = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(row => JSON.parse(row));
                return rows.some(row => row.type === 'response_item' && row.payload?.role === 'user' &&
                  row.payload.content?.some((part: any) => part.text?.includes(kickoff))) ? true : undefined;
              }, () => JSON.stringify({ stage: 'kickoff-native-witness', delivery,
                execution: readMeta()?.execution, transcript: readFileSync(transcript, 'utf8') }));
              kickoffProof = { persisted: witnessed, nativeRef: transcript, reason: null };
            }
            return { status: 'ok', pid: replacement.pid, terminal: 'headless',
              child: children.at(-1), display: null, desktopEnvResolvedVia: null, kickoffProof };
          });
          const response = await production.default.handler({ ...args,
            [production.INTERNAL_INTERRUPTION_RECOVERY]: args[Symbol.for('host-journey')],
          }, launchContext);
          expect('isError' in response && response.isError, JSON.stringify(response)).not.toBe(true);
          expect(m.replacement).toHaveBeenCalledTimes(1);
          return response;
        }
        await args[Symbol.for('host-journey')].beforeNativeCreate();
        const replacement = await start(!scenario.waiting);
        expect(replacement.execution.nativeSessionId).toBe(native);
        if (scenario.waiting) expect(readFileSync(transcript, 'utf8')).toBe(before);
        return { data: { launch: { resumeVerified: true } } };
      });
      const context = { workspaceId: ws, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
      let result: Awaited<ReturnType<typeof sweepSessionInterruptions>>;
      if (scenario.fleetFirst != null) {
        const first = scenario.fleetFirst ? runFleetHeadcountGovernor(context) : sweepSessionInterruptions(context);
        try {
          await vi.waitFor(() => expect(m.launch).toHaveBeenCalledTimes(1), { timeout: 15_000 });
          await launchEntered;
          const second = scenario.fleetFirst ? await sweepSessionInterruptions(context)
            : await runFleetHeadcountGovernor(context);
          expect(m.replacement).not.toHaveBeenCalled();
          release();
          const firstResult = await first;
          result = (scenario.fleetFirst ? second : firstResult) as Awaited<ReturnType<typeof sweepSessionInterruptions>>;
          // The winning actor's durable receipt is independent of its return value.
          const [marker] = await db.adminSql`SELECT control_state #> '{lifecycle,interruption}' AS receipt
            FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
          expect(marker.receipt).toMatchObject({ attempts: 1, state: 'restored', nativeSessionId: native });
          await runFleetHeadcountGovernor(context);
          expect(m.replacement).not.toHaveBeenCalled();
          expect(children).toHaveLength(2);
          expect(readMeta().execution.nativeSessionId).toBe(native);
        } finally { release(); await first; }
      } else result = await sweepSessionInterruptions(context);
      if (scenario.boundary === 'human' && !scenario.duringDowntime) {
        expect(result.held[owner]).toBe('human-decision-pending');
        expect(m.launch).not.toHaveBeenCalled();
        expect(readFileSync(transcript, 'utf8')).toBe(transcriptBeforeRecovery);
        expect(await fireBoundary()).toHaveLength(1);
        result = await sweepSessionInterruptions({ workspaceId: ws,
          installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null });
      }
      if (scenario.stopped || scenario.negative) {
        expect(m.launch).not.toHaveBeenCalled();
        if (scenario.stopped) expect(result.held[owner]).toBe('owner-stop');
        if (scenario.negative === 'completed') expect(result.held[owner]).toBe('completed-or-idle');
        if (scenario.negative === 'unknown') expect(result.held[owner]).toBe('launch-recipe-unknown');
        if (scenario.negative === 'stale') expect(result.checked).toBe(0);
        await sweepSessionInterruptions({ workspaceId: ws, installSlug: 'papercusp',
          triggerConfig: {}, payloadTemplate: null });
        expect(m.launch).not.toHaveBeenCalled();
        expect(children).toHaveLength(1);
        expect(readFileSync(transcript, 'utf8')).toBe(transcriptBeforeRecovery);
      } else {
        const [settlement] = await db.adminSql`SELECT control_state #> '{lifecycle,interruption}' AS receipt
          FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
        if (scenario.fleetFirst == null) expect(result.restored,
          JSON.stringify({ result, settlement: settlement?.receipt })).toContain(owner);
        expect(m.launch).toHaveBeenCalledTimes(1);
        await sweepSessionInterruptions({ workspaceId: ws, installSlug: 'papercusp',
          triggerConfig: {}, payloadTemplate: null });
        expect(m.launch).toHaveBeenCalledTimes(1);
        expect(existsSync(socketPathFor(owner))).toBe(true);
        if (scenario.waiting) {
          expect(readFileSync(transcript, 'utf8')).toBe(transcriptBeforeRecovery);
          if (!scenario.duringDowntime && scenario.boundary !== 'human') {
            expect(await waits.listRecentDeliveries(owner)).toHaveLength(0);
            expect(await fireBoundary()).toHaveLength(1);
          }
          const pumped = await pumpWakeDeliveries(ws);
          const starts = () => readFileSync(transcript, 'utf8').split('\n').filter(line => line &&
            JSON.parse(line).payload?.type === 'task_started' &&
            JSON.parse(line).payload?.turn_id === 'original-wait-boundary').length;
          await eventually(() => starts() === 1 ? true : undefined,
            async () => JSON.stringify({ pumped,
              deliveries: (await waits.listRecentDeliveries(owner)).map(row => ({
                id: row.id, status: row.status, channel: row.channel, lastError: row.lastError })),
              execution: readMeta()?.execution, transcript: readFileSync(transcript, 'utf8') }));
          // Acceptance and native-turn confirmation are separate phases. The
          // first pump can park while the host observes the original turn; the
          // retry must reconcile that same delivery, never create another turn.
          const deliveries = await vi.waitFor(async () => {
            // Drive the private row across the production 45s park boundary;
            // wall-clock waiting is not the behavior this scenario exercises.
            await db.adminSql`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now()
              WHERE subscriber_id = ${owner} AND await_id = ${originalAwaitId!} AND status = 'parked'`;
            await pumpWakeDeliveries(ws);
            const current = await waits.listRecentDeliveries(owner);
            expect(current).toHaveLength(1);
            expect(current[0]).toMatchObject({ awaitId: originalAwaitId, status: 'delivered' });
            return current;
          }, { timeout: 15_000, interval: 100 });
          expect(await fireBoundary()).toHaveLength(0);
          await pumpWakeDeliveries(ws);
          await sweepSessionInterruptions({ workspaceId: ws, installSlug: 'papercusp',
            triggerConfig: {}, payloadTemplate: null });
          await injectIntoHostWithConfirmation(socketPathFor(owner), { mode: 'turn',
            data: boundaryMarker, deliveryId: String(deliveries[0].id) });
          expect(starts()).toBe(1);
          expect(children).toHaveLength(2);
        }
      }
    } finally {
      setAutoPumpEnabledForTests(originalAutoPump);
      for (const child of children) {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already stopped */ }
      }
      await Promise.all(children.map(child => child.exitCode != null || child.signalCode != null
        ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
      await db.adminSql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.event_wake_deliveries WHERE subscriber_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.session_pending_gates WHERE session_id = ${native}`;
      await db.adminSql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.psu_pty_host_events WHERE owner_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.adv_sessions WHERE id = ${adv.id}`;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
