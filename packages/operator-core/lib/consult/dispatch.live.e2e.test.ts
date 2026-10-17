/** Fresh production-router evidence for consult-backed-parking P-001/P-002.
 * Uses the maintained authenticated CLI and native e2e/runtime reporter. The
 * profile supplies questions and runtime selectors, never outcomes or pins.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAdvSessionInWorkspace } from '../adv-sessions';
import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { executeOperationalRun } from '../agent-tools/testing/record-run';
import { acquireTrackedSessionSource } from '../session-port/service';
import { adaptNativeSessionJsonl } from '../session-port/native-adapter';
import type { SessionBackend } from '../session-port/types';

const root = resolve(import.meta.dirname, '../../../..');
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
type Profile = { origin: string; runtimeUnits: string[];
  consultBrief: { questions: string[]; existingConversationId?: string } };

function call(name: string, args: Record<string, unknown>, origin: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' };
  // CLI scratch belongs to the serving operator, outside Vitest's private scratch.
  delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = spawnSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${origin}`, '--json', '-'], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ name, args: { ...args, payloadTier: 'full' } }),
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value.ok, JSON.stringify(value)).not.toBe(false);
  return value;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function rows(sql: string, origin: string) {
  return call('dev:pg_query', { sql, maxRows: 20, timeoutMs: 15_000,
    allowUnscoped: false, allowUnboundedJsonSearch: false }, origin).rows as Array<Record<string, unknown>>;
}

async function nativeBrief(owner: string, origin: string) {
  const [session] = rows(`SELECT id, agent, session_id, omp_thread_id FROM harness_shared.adv_sessions
    WHERE workspace_id = 'papercusp-workspace' AND coord_owner_id = ${literal(owner)}
    ORDER BY id DESC LIMIT 1`, origin);
  if (!session) return undefined;
  const source = await getAdvSessionInWorkspace(Number(session.id), 'papercusp-workspace');
  if (!source) return undefined;
  expect(source.coordOwnerId, 'native evidence must belong to this answering session').toBe(owner);
  expect(source.agent).toBe(session.agent);
  const backend = source.agent as SessionBackend;
  const nativeSession = String(backend === 'omp' ? source.ompThreadId ?? source.sessionId : source.sessionId);
  // Answering sessions can finish and archive before acceptance is refreshed.
  // Reuse the production reader's exact-incarnation and archive-integrity checks.
  const snapshot = await acquireTrackedSessionSource(source);
  const first = adaptNativeSessionJsonl(backend, snapshot.bytes.toString('utf8'), nativeSession)
    .turns.find(turn => turn.role === 'user');
  const text = first?.blocks.flatMap(block => 'text' in block ? [String(block.text)] : []).join('\n') ?? '';
  return { nativeSession, path: snapshot.fileIdentity?.path ?? null,
    source: snapshot.source, archiveRelpath: snapshot.relpath, sha256: snapshot.sha256, text };
}

describe.skipIf(!profilePath)('consult dispatch through the current production router', () => {
  it('records an organic dispatch and a fresh brief containing the selected expert turns', async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8')) as Profile;
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toContain('hono-host:3170');
    expect(profile.consultBrief.existingConversationId || profile.consultBrief.questions.length).toBeTruthy();
    expect(profile.consultBrief.questions.length).toBeLessThanOrEqual(2);
    expect(process.env.PAPERCUSP_SID, 'preserve the authenticated session identity').toBeTruthy();
    const recordContext = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: root };
    expect(resolveAgentWorkspaceRoot(recordContext), 'Recorder must measure this committed test tree').toBe(root);
    const route = call('dev:pipeline_position', {
      path: 'packages/operator-core/lib/consult/consult-dispatch.ts', testClass: 'operator-api',
      expectedSourceSha256: createHash('sha256').update(readFileSync(
        resolve(root, 'packages/operator-core/lib/consult/consult-dispatch.ts'))).digest('hex'),
      projection: { pick: ['currentBuildTestRoute', 'acceptedSource'] },
    }, profile.origin);
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.acceptedSource.matches).toBe(true);
    expect(route.acceptedSource.runtimeContainment['staging-operator']).toBe(true);

    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/consult/dispatch.live.e2e.test.ts',
      name: 'Fresh organic consult dispatch and cited-turn brief on staging', framework: 'operational',
      command: ['npm', 'run', 'test:file', '--', 'packages/operator-core/lib/consult/dispatch.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const observations: Array<Record<string, unknown>> = [];
        let proof: { conversationId: string; sourceOwner: string; answeringOwner: string; nativeSession: string } | undefined;
        const attempts = profile.consultBrief.existingConversationId ? [''] : profile.consultBrief.questions;
        for (const question of attempts) {
          const consult = profile.consultBrief.existingConversationId
            ? { conversation_id: profile.consultBrief.existingConversationId }
            : call('consult:get_feedback', { question, archive_floor: 2, allow_dispatch: true,
            request_key: `cbp-live-brief-${randomUUID()}`, harness: 'papercusp',
            origin_task_ref: 'WI-6554700010009934' }, profile.origin);
          const id = consult.conversation_id as string;
          expect(id, JSON.stringify(consult)).toBeTruthy();
          try {
            // Acceptance is asynchronous: wait for both the durable routing
            // result and its dispatch walk before inspecting or closing it.
            let read!: ReturnType<typeof call>;
            await expect.poll(() => {
              read = call('conversations:get', { id }, profile.origin).results[0];
              return read.ok && read.consult?.result?.verdict === 'routed'
                && read.consult.dispatch?.recent?.some((walk: { dispatched: boolean }) => walk.dispatched);
            }, { timeout: 240_000, interval: 5000 }).toBe(true);
            expect(read.ok).toBe(true);
            const walks = read.consult.dispatch.recent as Array<{ attempts: Array<{
              rank: number; outcome: string; operation: string | null; reason?: string }>; dispatched: boolean }>;
            const walk = walks.find(entry => entry.dispatched);
            expect(walk, JSON.stringify(read.consult.dispatch)).toBeDefined();
            expect(walk!.attempts.length).toBeGreaterThan(0);
            for (const attempt of walk!.attempts) {
              expect(attempt.rank).toBeGreaterThan(0);
              if (attempt.outcome !== 'dispatched') expect(attempt.reason).toBeTruthy();
            }
            const routed = read.consult.result;
            const dispatch = routed.dispatch;
            observations.push({ conversationId: id, operation: dispatch?.operation,
              attempts: walk!.attempts.map(({ rank, operation, outcome, reason }) => ({ rank, operation, outcome, reason })) });
            if (dispatch?.operation !== 'brief') continue;
            expect(dispatch.verified).toBe(true);
            const sourceOwner = dispatch.sourceOwnerId as string;
            const answeringOwner = dispatch.answeringOwnerId as string;
            expect(answeringOwner).toBeTruthy();
            expect(answeringOwner).not.toBe(sourceOwner);
            const source = rows(`SELECT agent, role FROM harness_shared.adv_sessions
              WHERE workspace_id = 'papercusp-workspace' AND coord_owner_id = ${literal(sourceOwner)}
              ORDER BY id DESC LIMIT 1`, profile.origin);
            expect(source).toHaveLength(1);
            expect(source[0]!.role, 'organic routing must reach an expert session that cannot be forked').toBeTypeOf('string');
            const refs = routed.responder.evidence as Array<{ session_id: string; turn_idx: number }>;
            expect(refs.length).toBeGreaterThan(0);
            const excerpts = refs.flatMap(ref => rows(`SELECT substring(text FROM 1 FOR 1000) AS text
              FROM harness_shared.session_turns WHERE workspace_id IN ('papercusp-workspace', 'default')
              AND owner = ${literal(sourceOwner)} AND session_id = ${literal(ref.session_id)}
              AND turn_idx = ${Number(ref.turn_idx)} LIMIT 1`, profile.origin))
              .map(row => String(row.text).slice(0, 60)).filter(text => text.length >= 30);
            expect(excerpts.length).toBeGreaterThan(0);
            let native: Awaited<ReturnType<typeof nativeBrief>>;
            await expect.poll(async () => {
              native = await nativeBrief(answeringOwner, profile.origin);
              return Boolean(native?.text.includes('FRESH answering session')
                && native.text.includes(sourceOwner)
                && excerpts.some(text => native!.text.includes(text)));
            }, { timeout: 120_000, interval: 5000 }).toBe(true);
            proof = { conversationId: id, sourceOwner, answeringOwner, nativeSession: native!.nativeSession };
            observations.push({ nativeTranscriptPath: native!.path, nativeSnapshotSha256: native!.sha256,
              nativeSource: native!.source, nativeArchiveRelpath: native!.archiveRelpath });
            break;
          } catch (error) {
            console.info('CBP_LIVE_DISPATCH_EXCEPTION', id,
              error instanceof Error ? error.stack : String(error));
            throw error;
          } finally {
            if (!profile.consultBrief.existingConversationId) call('consult:close', { conversation_id: id, outcome: 'cant_help',
              reason: 'Owned acceptance fixture captured its dispatch; stop the review cascade.' }, profile.origin);
          }
        }
        console.info('CBP_LIVE_DISPATCH_PROOF', JSON.stringify({ observations, proof }));
        expect(proof, 'Both organic questions must not miss the non-forkable brief path (D-019/D-020)').toBeDefined();
        return { exitCode: 0, summary: JSON.stringify({ observations, proof }).slice(0, 3000), assertions: [
          { id: 'organic-dispatch-attempts-recorded', passed: true, evidence: JSON.stringify(observations).slice(0, 2000) },
          { id: 'fresh-cited-turn-brief-launched', passed: true, evidence: JSON.stringify(proof) },
        ] };
      },
    }, recordContext);
    console.info('CBP_LIVE_DISPATCH_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
    if (!measured.ok) throw new Error(JSON.stringify(measured));
    expect(measured.testRunIds).toHaveLength(1);
  }, 720_000);
});
