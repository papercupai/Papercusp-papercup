/**
 * The turn-provenance re-derivation pass must classify a LONG paste-wrapped
 * machine turn as agent-injected, not `unenrolled-origin` (WI-6554700010009707).
 *
 * Measured 2026-10-13: the pass read only left(text, CLASSIFY_HEAD_CHARS=240).
 * A PTY-typed injection (fleet-kickoff, wake-pump, self-compaction) arrives as
 * `<pasted_content id="…">\n⟦turn-origin:…⟧…</pasted_content id="…">`, and the
 * whole-paste grammar needs that closing tag at the end, so a turn longer than
 * the head fell to the owner-typed residual and was rewritten `unenrolled-origin`
 * (18,079 Claude rows in 14 days). The consult router admits that verdict, so
 * every Claude judge's kickoff brief out-ranked real expert turns.
 *
 * Real pass, real Postgres:
 *  1. A 2,000-char paste-wrapped fleet-kickoff, stored stale as unenrolled-origin,
 *     re-derives to agent-injected / fleet-kickoff.
 *  2. The same paste followed by owner words is NOT a whole-prompt paste and must
 *     not become agent-injected (the tail must close the SAME paste).
 * Reverting the backfill to head-only fails (1); accepting any tail fails (2).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');

it('re-derivation pass restores a long whole-prompt paste from the turn tail', () => {
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { insertTurns, backfillTurnProvenanceOnce, newProvenanceLap } from './packages/operator-core/lib/search/session-ingest.ts';
    import { MACHINE_SURFACE_CATALOGUE_VERSION, CLASSIFY_HEAD_CHARS } from './packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts';
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    const sql = getOrgPg().sql;
    const stale = MACHINE_SURFACE_CATALOGUE_VERSION - 1;
    const body = 'You are the dedicated grading-integrity auditor for scorecard EI-1. ' + 'Replay the evidence and check the lease. '.repeat(45);
    const paste = '<pasted_content id="f715">\n⟦turn-origin:fleet-kickoff nonce:013ec62794d30cef⟧\n' + body + '\n</pasted_content id="f715">\n';
    assert.ok(paste.length > CLASSIFY_HEAD_CHARS * 4, 'the fixture must exceed the classify head');
    const rows = [
      { id: 'whole', text: paste },
      { id: 'owner-after', text: paste + 'and also please look at the failing gate, thanks' },
    ];
    try {
      await insertTurns(sql, rows.map((r, i) => ({
        workspace_id: workspace, source_kind: 'claude', session_id: 'paste-' + r.id, turn_idx: 0,
        ts: new Date(Date.now() + i).toISOString(), owner: 'synthetic-owner', harness_slug: 'synthetic',
        cwd: null, speaker: 'user', text: r.text, prompt_hash: null,
      })));
      await sql\`UPDATE harness_shared.session_turns
        SET turn_origin_classifier_version = \${stale}, turn_origin_verdict = 'unenrolled-origin', turn_origin = NULL
        WHERE workspace_id = \${workspace}\`;
      const lap = newProvenanceLap();
      for (let i = 0; i < 5; i++) { const r = await backfillTurnProvenanceOnce(sql, 10, lap); if (!r.more) break; }
      const got = await sql\`SELECT session_id, turn_origin, turn_origin_verdict AS verdict
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      const by = Object.fromEntries(got.map((r) => [r.session_id, r]));
      console.log('PASTE_TAIL ' + JSON.stringify(by));
      assert.equal(by['paste-whole'].verdict, 'agent-injected');
      assert.equal(by['paste-whole'].turn_origin, 'fleet-kickoff');
      assert.notEqual(by['paste-owner-after'].verdict, 'agent-injected', 'owner words after a paste must not unwrap it');
      console.log('PASTE_TAIL_RESULT ok');
    } finally {
      await sql.end();
    }
  `.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: probe, encoding: 'utf8', timeout: 10000 });
  expect(syntax.status, syntax.stderr).toBe(0);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env },
  });
  if (result.status !== 0) process.stderr.write(result.stdout.slice(-5000) + '\n' + result.stderr.slice(-2000));
  expect(result.status, result.stdout.slice(-5000) + '\n' + result.stderr.slice(-5000)).toBe(0);
  expect(result.stdout).toContain('PASTE_TAIL_RESULT ok');
}, 200000);
