import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { classifyRecordedTurn } from '../turn-provenance/turn-ref';

const root = resolve(__dirname, '../../../..');

/**
 * WI-10008182: an `unenrolled-origin` row whose stored classifier version is
 * OLDER than the current catalogue must still be recorrelated with its hook
 * stamp.
 *
 * The provenance backfill deliberately leaves a row's version alone when a
 * newer catalogue re-derives the same verdict (WI-10006788: rewriting the
 * other 99.8% cost a full-index row rewrite each). So an owner turn stored as
 * `unenrolled-origin` at version N-1 stays at N-1 for good. Recorrelation used
 * to require version == current, so such a turn could never be matched to its
 * stamp: measured 2026-10-10, owner directive #1594 (session_turn
 * a352e0e1:11, v6) failed plans:audit's owner-provenance check while the
 * prompt hook had recorded it as owner-typed.
 *
 * The fix re-derives a stale row with the CURRENT catalogue before correlating
 * it. The controls pin the two ways that could go wrong: a row the current
 * catalogue now calls machine-surface must not be promoted, and a row stored
 * by a NEWER catalogue than this build's is not re-judged by it.
 */
it('recorrelates older-version unenrolled rows with their hook stamp, re-derived by the current catalogue', () => {
  const machineText = '[SYSTEM NOTIFICATION: NOT USER INPUT]\nMachine-authored status';
  expect(classifyRecordedTurn(machineText).verdict).toBe('machine-surface');
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { insertTurns, promptOriginHash, recorrelatePromptOriginStampsOnce } from './packages/operator-core/lib/search/session-ingest.ts';
    import { MACHINE_SURFACE_CATALOGUE_VERSION as V } from './packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts';
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    console.log('STALE_ORIGIN_RUNTIME ' + JSON.stringify({ home: process.env.HOME }));
    const sql = getOrgPg().sql;
    const now = new Date();
    const owner = 'You add them to the plan and take over the implementation from them';
    function turn(label, text) {
      return { workspace_id: workspace, source_kind: 'claude', session_id: 'stale-' + label, turn_idx: 0,
        ts: now.toISOString(), owner: 'synthetic-owner', harness_slug: 'synthetic', cwd: null,
        speaker: 'user', text, prompt_hash: promptOriginHash(text) };
    }
    const turns = [
      turn('current', owner + ' (current)'),
      turn('older', owner),
      turn('oldest', owner + ' (oldest)'),
      turn('machine', process.env.TEST_STALE_ORIGIN_MACHINE_TEXT),
      turn('newer', owner + ' (newer)'),
    ];
    try {
    // Stored with no stamp yet: owner text is unenrolled, machine text is machine-surface.
    await insertTurns(sql, turns);
    // Re-create verdicts as older/newer catalogues left them. 'machine' stands
    // for a pattern an older catalogue did not know yet.
    const storeAs = (label, version) => sql\`UPDATE harness_shared.session_turns
      SET turn_origin = NULL, turn_origin_verdict = 'unenrolled-origin', turn_origin_classifier_version = \${version}
      WHERE workspace_id = \${workspace} AND session_id = \${'stale-' + label}\`;
    await storeAs('older', V - 1);
    await storeAs('oldest', V - 2);
    await storeAs('machine', V - 1);
    await storeAs('newer', V + 1);
    for (const t of turns) {
      await sql\`INSERT INTO harness_shared.session_prompt_origin_stamps
        (workspace_id, source_kind, session_id, prompt_hash, submitted_at, expires_at)
        VALUES (\${workspace}, \${t.source_kind}, \${t.session_id}, \${t.prompt_hash}, \${now},
                \${new Date(now.getTime() + 600000)})\`;
    }
      const result = await recorrelatePromptOriginStampsOnce(sql, 100);
      console.log('STALE_ORIGIN_RECORRELATE ' + JSON.stringify(result));
      const stored = await sql\`SELECT session_id, turn_origin, turn_origin_verdict, turn_origin_classifier_version
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      console.log('STALE_ORIGIN_RESULT ' + JSON.stringify(stored));
      const by = (label) => stored.find((row) => row.session_id === 'stale-' + label);
      for (const label of ['current', 'older', 'oldest']) {
        assert.equal(by(label).turn_origin_verdict, 'owner-typed', label);
        assert.equal(by(label).turn_origin, 'hook-authenticated-prompt', label);
        // The promotion is a verdict written by THIS catalogue.
        assert.equal(by(label).turn_origin_classifier_version, V, label);
      }
      assert.notEqual(by('machine').turn_origin_verdict, 'owner-typed', 'a current machine verdict must win over a stamp');
      assert.equal(by('newer').turn_origin_verdict, 'unenrolled-origin', 'an older build must not re-judge a newer catalogue row');
      assert.equal(by('newer').turn_origin_classifier_version, V + 1);
      assert.equal(result.promoted, 3);
      // Spent stamps stay spent.
      assert.equal((await recorrelatePromptOriginStampsOnce(sql, 100)).promoted, 0);

      // WI-10008183: a stamp is spent only by the promoted row it belongs to.
      // Turns go in before any stamp, so insert-time correlation stays out of it.
      const repeatText = 'continue where you left off';
      const at = (ms) => new Date(now.getTime() + ms);
      const clusterTurn = (session, idx, ms) => ({ workspace_id: workspace, source_kind: 'claude',
        session_id: session, turn_idx: idx, ts: at(ms).toISOString(), owner: 'synthetic-owner',
        harness_slug: 'synthetic', cwd: null, speaker: 'user', text: repeatText, prompt_hash: promptOriginHash(repeatText) });
      // repeat: the owner sent the same prompt twice, 110 s apart; each submit has its own stamp.
      // dup:    two identical turns but ONE stamp, which the promoted turn consumed.
      // over:   two promoted turns already hold both stamps; a third turn near stamp 2 gets none.
      const layout = { 'cluster-repeat': [[-110000, true], [0, false]], 'cluster-dup': [[-37000, false], [0, true]],
        'cluster-over': [[0, true], [36000, true], [160000, false]] };
      const stampsAt = { 'cluster-repeat': [-109950, 50], 'cluster-dup': [50], 'cluster-over': [30000, 150000] };
      for (const [session, turnsAt] of Object.entries(layout)) {
        await insertTurns(sql, turnsAt.map(([ms], idx) => clusterTurn(session, idx, ms)));
        for (const [idx, [, promoted]] of turnsAt.entries()) {
          if (!promoted) continue;
          await sql\`UPDATE harness_shared.session_turns
            SET turn_origin = 'hook-authenticated-prompt', turn_origin_verdict = 'owner-typed'
            WHERE workspace_id = \${workspace} AND session_id = \${session} AND turn_idx = \${idx}\`;
        }
        for (const ms of stampsAt[session]) {
          await sql\`INSERT INTO harness_shared.session_prompt_origin_stamps
            (workspace_id, source_kind, session_id, prompt_hash, submitted_at, expires_at)
            VALUES (\${workspace}, 'claude', \${session}, \${promptOriginHash(repeatText)}, \${at(ms)}, \${at(ms + 600000)})\`;
        }
      }
      const clustered = await recorrelatePromptOriginStampsOnce(sql, 100);
      const clusterRows = await sql\`SELECT session_id, turn_idx, turn_origin_verdict FROM harness_shared.session_turns
        WHERE workspace_id = \${workspace} AND session_id LIKE 'cluster-%' ORDER BY session_id, turn_idx\`;
      console.log('STALE_ORIGIN_RESULT cluster ' + JSON.stringify({ clustered, clusterRows }));
      const verdictOf = (session, idx) => clusterRows.find((r) => r.session_id === session && r.turn_idx === idx).turn_origin_verdict;
      assert.equal(verdictOf('cluster-repeat', 1), 'owner-typed', 'a repeated prompt with its own stamp is promoted');
      assert.equal(verdictOf('cluster-dup', 0), 'unenrolled-origin', 'one stamp never promotes two turns');
      assert.equal(verdictOf('cluster-over', 2), 'unenrolled-origin', 'stamps held by promoted turns are not reused');
      assert.equal(clustered.promoted, 1);
    } finally { await sql.end(); }
  `.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: probe, encoding: 'utf8', timeout: 10000 });
  expect(syntax.status, syntax.stderr).toBe(0);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, TEST_STALE_ORIGIN_MACHINE_TEXT: machineText },
  });
  // with-test-pg's cleanup log fills the tail, so lead a failure with the
  // probe's own output and the assertion that stopped it.
  const diagnosis = `${result.stdout}\n${result.stderr}`.split('\n')
    .filter((line) => /^STALE_ORIGIN_(RECORRELATE|RESULT)|AssertionError|^\s+(actual|expected|operator):|^\w*Error\b/.test(line))
    .slice(0, 40).join('\n');
  const environment = result.stdout.match(/^STALE_ORIGIN_RUNTIME (.+)$/m)?.[1];
  expect(environment, diagnosis || result.stderr.slice(-2000)).toBeTruthy();
  expect(existsSync(JSON.parse(environment!).home)).toBe(false);
  expect(result.status, diagnosis || result.stderr.slice(-5000)).toBe(0);
  expect(result.stdout).toContain('STALE_ORIGIN_RESULT');
}, 200000);
