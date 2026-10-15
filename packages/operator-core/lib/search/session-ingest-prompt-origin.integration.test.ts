import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { classifyRecordedTurn } from '../turn-provenance/turn-ref';

const root = resolve(__dirname, '../../../..');
const source = resolve(root, 'packages/operator-core/lib/search/session-ingest.ts');

it('persists exact authenticated source stamps through the real ingest SQL without promoting mismatches', () => {
  // Check the negative control against the actual catalogue before starting PG.
  const machineText = '[SYSTEM NOTIFICATION: NOT USER INPUT]\nMachine-authored status';
  expect(classifyRecordedTurn(machineText).verdict).toBe('machine-surface');
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync, existsSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { insertTurns, promptOriginHash, parseClaudeLine, parseCodexLine, parseOmpLine, backfillTurnProvenanceOnce, recorrelatePromptOriginStampsOnce, ingestFileNow } from './packages/operator-core/lib/search/session-ingest.ts';
    import { mkdir, writeFile, appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { MACHINE_SURFACE_CATALOGUE_VERSION } from './packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts';
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
    assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
    const sourceHash = createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex');
    assert.equal(sourceHash, process.env.TEST_PROMPT_ORIGIN_SOURCE_HASH);
    console.log('PROMPT_ORIGIN_RUNTIME ' + JSON.stringify({ home: process.env.HOME, sourceHash }));
    const sql = getOrgPg().sql;
    const migration = 'libs/papercusp/libs/db/sql/1439-session-ingest-short-user-turn-cutover.sql';
    // Exercise the reserved draft before arming; the normal migrated runtime
    // already has this idempotent additive column after the change ships.
    await sql.unsafe(readFileSync(existsSync(migration) ? migration : migration + '.DRAFT', 'utf8'));
    const now = new Date(), cases = [];
    function candidate(label, sourceKind = 'codex', overrides = {}) {
      const text = overrides.text ?? 'measure the unchanged frozen cohort\r\n' + 'original prompt bytes '.repeat(500);
      const at = overrides.at ?? now;
      const line = overrides.history
        ? { session_id: 'origin-' + label, ts: at.getTime() / 1000, text }
        : sourceKind === 'codex'
          ? { timestamp: at.toISOString(), type: 'response_item', payload: {
              type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
          : { timestamp: at.toISOString(), type: sourceKind === 'omp' ? 'message' : 'user',
              message: { role: 'user', content: [{ type: 'text', text }] } };
      const parser = sourceKind === 'claude' ? parseClaudeLine : sourceKind === 'omp' ? parseOmpLine : parseCodexLine;
      const parsed = parser(JSON.stringify(line));
      assert.ok(parsed);
      const row = { workspace_id: workspace, source_kind: sourceKind, session_id: 'origin-' + label,
        turn_idx: 0, ts: parsed.ts.toISOString(), owner: 'synthetic-owner', harness_slug: 'synthetic', cwd: null,
        speaker: parsed.speaker, text: parsed.text, prompt_hash: parsed.promptHash ?? null };
      cases.push({ label, row, rawPromptHash: promptOriginHash(text) });
      return row;
    }
    async function stamp(row, overrides = {}) {
      const s = { source_kind: row.source_kind, session_id: row.session_id,
        prompt_hash: cases.find(c => c.row === row).rawPromptHash,
        submitted_at: now, expires_at: new Date(now.getTime() + 600000), ...overrides };
      await sql\`INSERT INTO harness_shared.session_prompt_origin_stamps
        (workspace_id, source_kind, session_id, prompt_hash, submitted_at, expires_at)
        VALUES (\${workspace}, \${s.source_kind}, \${s.session_id}, \${s.prompt_hash}, \${s.submitted_at}, \${s.expires_at})\`;
    }
    try {
      // Fixture rows stand in for already authenticated hook receipts; the
      // model-facing hook writer is never called or impersonated by this test.
      for (const kind of ['claude', 'codex', 'omp']) await stamp(candidate(kind, kind));
      for (const kind of ['claude', 'codex', 'omp']) await stamp(candidate('short-' + kind, kind, { text: 'A' }));
      candidate('short-unstamped', 'codex', { text: 'B' });
      await stamp(candidate('codex-history', 'codex', { history: true }));
      await stamp(candidate('wrong-source'), { source_kind: 'claude' });
      await stamp(candidate('wrong-session'), { session_id: 'other-session' });
      await stamp(candidate('wrong-hash'), { prompt_hash: promptOriginHash('different directive') });
      await stamp(candidate('outside-window'), { submitted_at: new Date(now.getTime() - 120001) });
      await stamp(candidate('expired'), { expires_at: new Date(now.getTime() - 1) });
      await stamp(candidate('injected', 'codex', { text: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\nkeep going' }));
      await stamp(candidate('torn-wake', 'codex', { text: '0d55a713f50015a⟧\n[await-event] coord:inbox-wake:su-a20d fired — continue the work' }));
      // WI-10006568: ingest that runs after the stamp's TTL. The turn was typed
      // 15 min ago while its stamp was valid; it expired 5 min ago, before this
      // insert. Expiry is judged against the TURN, so this must still promote.
      const typedAt = new Date(now.getTime() - 15 * 60000);
      await stamp(candidate('late-ingest', 'claude', { at: typedAt }),
        { submitted_at: typedAt, expires_at: new Date(typedAt.getTime() + 600000) });
      // Stamp lands only AFTER the row is stored. CRLF and edge whitespace check
      // that the re-correlation prefilter normalises exactly like promptOriginHash.
      const lateStampRow = candidate('late-stamp', 'claude', { text: '  fix the stamp race\r\nplease  ' });
      candidate('legacy-residual');
      candidate('new-machine-rule', 'codex', { text: process.env.TEST_PROMPT_ORIGIN_MACHINE_TEXT });
      candidate('assistant');
      await insertTurns(sql, cases.map(c => c.row));
      const rows = await sql\`SELECT source_kind, session_id, turn_origin_verdict
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      console.log('PROMPT_ORIGIN_RESULT ' + JSON.stringify(rows));
      assert.equal(rows.length, cases.length);
      for (const c of cases) {
        const stored = rows.find(row => row.session_id === c.row.session_id);
        const expected = ['claude', 'codex', 'omp', 'short-claude', 'short-codex', 'short-omp', 'codex-history', 'late-ingest'].includes(c.label) ? 'owner-typed'
          : c.label === 'injected' ? 'agent-injected'
          : ['new-machine-rule', 'torn-wake'].includes(c.label) ? 'machine-surface' : 'unenrolled-origin';
        assert.equal(stored.turn_origin_verdict, expected, c.label);
      }
      // Re-correlation of already-stored rows: no stamp existed at insert, so
      // late-stamp is unenrolled above; its stamp now lands and the sweep must
      // upgrade exactly that row. It must not touch the negative controls: the
      // expired stamp fails per-row expiry, and wrong-hash, outside-window,
      // wrong-session and wrong-source never pair.
      await stamp(lateStampRow);
      const recorrelated = await recorrelatePromptOriginStampsOnce(sql, 100);
      console.log('PROMPT_ORIGIN_RECORRELATE ' + JSON.stringify(recorrelated));
      assert.equal(recorrelated.promoted, 1);
      const swept = await sql\`SELECT session_id, turn_origin, turn_origin_verdict
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace}\`;
      const sweptBy = (label) => swept.find(row => row.session_id === 'origin-' + label);
      assert.equal(sweptBy('late-stamp').turn_origin_verdict, 'owner-typed');
      assert.equal(sweptBy('late-stamp').turn_origin, 'hook-authenticated-prompt');
      for (const label of ['expired', 'wrong-hash', 'outside-window', 'wrong-session', 'wrong-source', 'legacy-residual']) {
        assert.equal(sweptBy(label).turn_origin_verdict, 'unenrolled-origin', 'recorrelate must not promote ' + label);
      }
      assert.equal((await recorrelatePromptOriginStampsOnce(sql, 100)).promoted, 0);
      // A classifier upgrade outlives the ephemeral receipt. Re-derive the
      // actual stored rows after removing it, rather than trusting a mock.
      await sql\`DELETE FROM harness_shared.session_prompt_origin_stamps WHERE workspace_id = \${workspace}\`;
      await sql\`UPDATE harness_shared.session_turns
        SET turn_origin_classifier_version = \${MACHINE_SURFACE_CATALOGUE_VERSION - 1}
        WHERE workspace_id = \${workspace}\`;
      // Old text-only owner residuals have no authenticated tag. A formerly
      // positive tag must also lose to a current machine/speaker veto.
      await sql\`UPDATE harness_shared.session_turns SET turn_origin_verdict = 'owner-typed'
        WHERE workspace_id = \${workspace} AND session_id = 'origin-legacy-residual'\`;
      await sql\`UPDATE harness_shared.session_turns
        SET turn_origin = 'hook-authenticated-prompt', turn_origin_verdict = 'owner-typed'
        WHERE workspace_id = \${workspace} AND session_id IN ('origin-new-machine-rule', 'origin-assistant', 'origin-torn-wake')\`;
      await sql\`UPDATE harness_shared.session_turns SET speaker = 'assistant'
        WHERE workspace_id = \${workspace} AND session_id = 'origin-assistant'\`;
      const before = await sql\`SELECT session_id, turn_origin, turn_origin_verdict
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      const repaired = await backfillTurnProvenanceOnce(sql, 100);
      assert.equal(repaired.scanned, cases.length);
      const after = await sql\`SELECT session_id, turn_origin, turn_origin_verdict, turn_origin_classifier_version
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      console.log('PROMPT_ORIGIN_BACKFILL_RESULT ' + JSON.stringify(after));
      // WI-10006788: only rows whose verdict or origin CHANGED are rewritten
      // (and stamped with the current version); the rest keep V-1 untouched.
      const changedIds = new Set(after.filter((row) => {
        const prior = before.find((b) => b.session_id === row.session_id);
        return prior.turn_origin !== row.turn_origin || prior.turn_origin_verdict !== row.turn_origin_verdict;
      }).map((row) => row.session_id));
      for (const label of ['legacy-residual', 'new-machine-rule', 'assistant', 'torn-wake']) {
        assert.ok(changedIds.has('origin-' + label), 'the corrupted row must be rewritten: ' + label);
      }
      assert.equal(repaired.updated, changedIds.size);
      for (const c of cases) {
        const stored = after.find(row => row.session_id === c.row.session_id);
        const positive = ['claude', 'codex', 'omp', 'short-claude', 'short-codex', 'short-omp', 'codex-history', 'late-ingest', 'late-stamp'].includes(c.label);
        const expected = positive ? 'owner-typed' : c.label === 'injected' ? 'agent-injected'
          : ['new-machine-rule', 'torn-wake'].includes(c.label) ? 'machine-surface'
          : c.label === 'assistant' ? 'not-user-turn' : 'unenrolled-origin';
        assert.equal(stored.turn_origin_verdict, expected, c.label);
        assert.equal(stored.turn_origin_classifier_version,
          changedIds.has(c.row.session_id) ? MACHINE_SURFACE_CATALOGUE_VERSION : MACHINE_SURFACE_CATALOGUE_VERSION - 1,
          c.label);
        if (positive) assert.equal(stored.turn_origin, 'hook-authenticated-prompt', c.label);
      }
      // The next lap re-classifies the unchanged rows and writes nothing; the
      // one after that finds the table clean.
      assert.equal((await backfillTurnProvenanceOnce(sql, 100)).updated, 0);
      assert.equal((await backfillTurnProvenanceOnce(sql, 100)).more, false);
      // Existing accepted indexes stay fixed; only the new tail retains micro decisions.
      const nativeId = '77777777-1111-2222-3333-444444444444';
      const nativeDir = join(process.env.HOME, '.codex', 'sessions', '2026', '10', '08');
      await mkdir(nativeDir, { recursive: true });
      const nativePath = join(nativeDir, 'rollout-' + nativeId + '.jsonl');
      const message = text => JSON.stringify({ type: 'response_item', timestamp: now.toISOString(),
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
      const prefix = message('original request é') + message('A');
      await writeFile(nativePath, prefix + message('B'));
      await insertTurns(sql, [{ workspace_id: 'default', source_kind: 'codex', session_id: nativeId,
        turn_idx: 0, ts: now.toISOString(), owner: 'synthetic-owner', harness_slug: null, cwd: null,
        speaker: 'user', text: 'original request é', prompt_hash: promptOriginHash('original request é') }]);
      await sql\`INSERT INTO harness_shared.session_ingest_state
        (source_kind, file_path, byte_offset, turn_count, session_id)
        VALUES ('codex', \${nativePath}, \${Buffer.byteLength(prefix)}, 1, \${nativeId})\`;
      assert.equal((await ingestFileNow(nativePath)).inserted, 1);
      await appendFile(nativePath, message('no'));
      assert.equal((await ingestFileNow(nativePath)).inserted, 1);
      assert.equal((await ingestFileNow(nativePath)).inserted, 0);
      const saved = await sql\`SELECT short_user_turns_offset, turn_count FROM harness_shared.session_ingest_state
        WHERE source_kind='codex' AND file_path=\${nativePath}\`;
      assert.equal(Number(saved[0].short_user_turns_offset), Buffer.byteLength(prefix));
      assert.equal(saved[0].turn_count, 3);
      const tail = await sql\`SELECT turn_idx, text, turn_origin_verdict FROM harness_shared.session_turns
        WHERE workspace_id='default' AND source_kind='codex' AND session_id=\${nativeId} ORDER BY turn_idx\`;
      assert.deepEqual(tail.map(t => [t.turn_idx, t.text, t.turn_origin_verdict]),
        [[0, 'original request é', 'unenrolled-origin'], [1, 'B', 'unenrolled-origin'], [2, 'no', 'unenrolled-origin']]);
      assert.equal(sourceHash, createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex'));
    } finally { await sql.end(); }
  `.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: probe, encoding: 'utf8', timeout: 10000 });
  expect(syntax.status, syntax.stderr).toBe(0);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, TEST_PROMPT_ORIGIN_SOURCE_HASH: sourceHash, TEST_PROMPT_ORIGIN_MACHINE_TEXT: machineText },
  });
  const environment = result.stdout.match(/^PROMPT_ORIGIN_RUNTIME (.+)$/m)?.[1];
  if (result.status !== 0) process.stderr.write(result.stdout.slice(-5000) + '\n' + result.stderr.slice(-2000));
  expect(environment, result.stdout.slice(-2000)).toBeTruthy();
  expect(existsSync(JSON.parse(environment!).home)).toBe(false);
  expect(result.status, result.stdout.slice(-5000) + '\n' + result.stderr.slice(-5000)).toBe(0);
  expect(result.stdout).toContain('PROMPT_ORIGIN_RESULT');
}, 200000);
