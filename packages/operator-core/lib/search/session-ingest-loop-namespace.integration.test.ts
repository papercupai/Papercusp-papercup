import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const sources = [
  'packages/operator-core/lib/search/session-ingest.ts',
  'packages/operator-core/lib/harness/routines/loop-turn-start-stamp.ts',
];

it('binds scoped enrollment through current-build ingest and both typed completion readers in a private runtime', () => {
  const hashes = Object.fromEntries(sources.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { runWithWorkspace } from './packages/operator-core/lib/workspace-als.ts';
    import { recordAdvSession, recordSuLaunchSpec } from './packages/operator-core/lib/adv-sessions.ts';
    import { insertTurns } from './packages/operator-core/lib/search/session-ingest.ts';
    import { getLoopStatus } from './packages/operator-core/lib/harness/routines/loop.ts';
    import { reconcileLoopRoutines } from './packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts';
    import { tagTurnForInjection, readLedgerRows, appendLedgerRow } from './packages/operator-core/lib/turn-provenance/turn-provenance.ts';
    const hashes = JSON.parse(process.env.LOOP_NAMESPACE_SOURCE_HASHES);
    for (const [path, expected] of Object.entries(hashes))
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected);
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
    assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
    const hostDir = join(process.env.HOME, 'host-global', 'turn-provenance');
    process.env.PAPERCUSP_TURN_PROVENANCE_DIR = hostDir;
    console.log('LOOP_NAMESPACE_RUNTIME ' + JSON.stringify({ home: process.env.HOME, workspace, hashes }));
    const sql = getOrgPg().sql;
    const completed = [], rejected = [];
    async function fixture(label, ws = workspace) {
      const owner = 'su-namespace-' + label, session = 'native-' + label, routine = 'routine-' + label;
      const dir = join(process.env.HOME, ws, label, 'turn-provenance');
      const fire = new Date();
      await sql.unsafe('INSERT INTO harness_shared.routines ' +
        '(id,install_slug,name,trigger_kind,trigger_config,target_role,active,workspace_id,last_fired_at,next_fire_at,reschedule_interval_sec,target_owner_id,metadata) ' +
        "VALUES ($1,'papercusp',$1,'cron','{}','su',true,$2,$3,'infinity',60,$4,$5::jsonb)",
        [routine, ws, fire, owner, JSON.stringify({ fire_count: 3, armed_at: fire.toISOString() })]);
      const launchId = await recordAdvSession({ workspaceId: ws, agent: 'codex', mode: 'omp',
        coordOwnerId: label === 'wrong-owner' ? owner + '-foreign' : owner,
        sessionId: label === 'wrong-session' ? session + '-foreign' : session });
      assert.ok(launchId);
      const spec = { v: 1, agent: 'codex', workspaceId: label === 'wrong-workspace' ? ws + '-foreign' : ws,
        ...(label === 'missing-pin' ? {} : { turnProvenanceDir: label === 'wrong-directory' ? dir + '-foreign' : dir }) };
      assert.equal(await recordSuLaunchSpec(launchId, label === 'wrong-owner' ? owner + '-foreign' : owner, spec), true);
      const tagged = await tagTurnForInjection({ sid: owner, origin: 'loop-fire', text: 'Finish the private namespace fixture.',
        dir, loopFire: { routineId: routine, wakeCount: 3 } });
      assert.equal(tagged.ledgerWritten, true);
      // A valid nonce in the ingest host's unrelated directory must never
      // compensate for an absent or mismatched target launch receipt.
      if (!['valid-a', 'valid-b', 'rollback'].includes(label)) {
        const enrollment = readLedgerRows(owner, { dir })[0];
        assert.ok(enrollment);
        assert.equal(await appendLedgerRow(enrollment, { dir: hostDir }), true);
      }
      const user = { workspace_id: 'default', source_kind: 'codex', session_id: session, turn_idx: 7,
        ts: new Date().toISOString(), owner, harness_slug: null, cwd: '/untrusted/transcript/cwd',
        speaker: 'user', text: tagged.taggedText };
      const reply = { ...user, turn_idx: 8, ts: new Date().toISOString(), speaker: 'assistant', text: 'Private fixture completed.' };
      return { owner, session, routine, user, reply, ws };
    }
    try {
      for (const [label, ws] of [['valid-a', workspace], ['valid-b', workspace + '-b'],
        ...['wrong-owner','wrong-session','wrong-workspace','missing-pin','wrong-directory'].map(label => [label, workspace])]) {
        await runWithWorkspace(ws, async () => {
          const c = await fixture(label, ws);
          assert.equal(await insertTurns(sql, [c.user, c.reply]), 2);
          const stamps = await sql.unsafe('SELECT created_at, workspace_id, detail FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner]);
          const valid = label.startsWith('valid-');
          assert.equal(stamps.length, valid ? 1 : 0, label);
          const status = await getLoopStatus(c.owner, { sql });
          assert.equal(status.lastLoopTurnAt, valid ? c.reply.ts : null, label);
          if (valid) {
            assert.equal(stamps[0].workspace_id, 'default');
            assert.ok(new Date(stamps[0].created_at).getTime() >= Date.parse(c.user.ts));
            assert.deepEqual(stamps[0].detail.loopFire, { routineId: c.routine, wakeCount: 3 });
            assert.deepEqual(stamps[0].detail.indexedTurn, { workspaceId: 'default', sourceKind: 'codex', sessionId: c.session, turnIdx: 7 });
            assert.equal(stamps[0].detail.provenanceWorkspaceId, ws);
            assert.equal(await insertTurns(sql, [c.user, c.reply]), 0);
            assert.equal((await sql.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner])).length, 1);
            const reconciled = await reconcileLoopRoutines({ sql, nowMs: Date.now() + 10000,
              recordFire: async () => {}, readFireState: async () => null,
              countAgentToolCallsInWindow: async () => null });
            const result = reconciled.loops.find(row => row.id === c.routine);
            assert.equal(result.via, 'loop-turn');
            assert.equal(result.completedAt, Date.parse(c.reply.ts));
            completed.push({ label, routineId: c.routine, wakeCount: 3, turnIdx: 7, via: result.via });
          } else rejected.push(label);
        });
      }
      const c = await fixture('rollback');
      await assert.rejects(sql.begin(async tx => {
        await insertTurns(tx, [c.user, c.reply]);
        assert.equal((await tx.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner])).length, 1);
        throw new Error('private namespace rollback');
      }), /private namespace rollback/);
      assert.equal((await sql.unsafe('SELECT turn_idx FROM harness_shared.session_turns WHERE owner=$1', [c.owner])).length, 0);
      assert.equal((await sql.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner])).length, 0);
      for (const [path, expected] of Object.entries(hashes))
        assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected);
      console.log('LOOP_NAMESPACE_RESULT ' + JSON.stringify({ completed, rejected, rollback: true, idempotent: true }));
    } finally { await sql.end(); }
  `;
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LOOP_NAMESPACE_SOURCE_HASHES: JSON.stringify(hashes) },
  });
  const runtimeText = result.stdout.match(/^LOOP_NAMESPACE_RUNTIME (.+)$/m)?.[1];
  expect(runtimeText, result.stdout.slice(-2000) + result.stderr.slice(-2000)).toBeTruthy();
  const runtime = JSON.parse(runtimeText!);
  expect(existsSync(runtime.home)).toBe(false);
  expect(result.status, result.stdout.slice(-5000) + result.stderr.slice(-5000)).toBe(0);
  const evidenceText = result.stdout.match(/^LOOP_NAMESPACE_RESULT (.+)$/m)?.[1];
  expect(evidenceText).toBeTruthy();
  const evidence = JSON.parse(evidenceText!);
  expect(evidence.completed).toHaveLength(2);
  expect(evidence.rejected).toHaveLength(5);
  expect(evidence).toMatchObject({ rollback: true, idempotent: true });
  console.log('LOOP_NAMESPACE_VERIFIED ' + JSON.stringify({ ...evidence, hashes, cleanup: true }));
}, 200000);
