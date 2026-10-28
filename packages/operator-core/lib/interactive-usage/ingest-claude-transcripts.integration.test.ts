import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'cache-efficiency-parser-state';
const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async (original) => ({
  ...(await original<typeof import('../workspace-registry')>()), activeWorkspaceId: () => WS,
}));

const { ingestInteractiveUsage, parseTranscriptChunk, legacyUsageFingerprint, markUnavailableTranscriptUsage, transcriptUsageEventKey } = await import('./ingest-claude-transcripts');
const { replayTranscriptPrefix } = await import('./replay-transcripts');
const { archiveSession, pgSessionArchiveStore } = await import('../session-archive');
const { parseCodexChunk, parseOmpChunk, codexSessionIdForFile } = await import('./ingest-adapters');
let org: OrgTestDb;
let sql: Sql;
let root: string;
let backupId: number;
const roots: string[] = [];
const line = (value: unknown) => JSON.stringify(value) + '\n';
const context = (model: string) => line({ type: 'turn_context', payload: { model } });
const usage = (total: number, input = 1000) => line({ type: 'event_msg', payload: {
  type: 'token_count', info: {
    total_token_usage: { input_tokens: total, cached_input_tokens: total * 0.6, output_tokens: total * 0.04 },
    last_token_usage: { input_tokens: input, cached_input_tokens: 600, cache_write_input_tokens: 250, output_tokens: 40 },
  },
} });
const adapter = (name = 'codex') => [{ name, root, parse: parseCodexChunk, replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }];
const migrationsDir = new URL('../../../../libs/papercusp/libs/db/sql/', import.meta.url);
const readMigration = (name: string) => fs.readFile(new URL(name, migrationsDir), 'utf8')
  .catch(() => fs.readFile(new URL(name + '.DRAFT', migrationsDir), 'utf8'));
// Migration 1293's guard. Cases that seed rows as the PRE-FIX ingester wrote them drop it first.
const PROVIDER_MESSAGE_KEY_CHECK = 'agent_usage_samples_provider_message_key_ck';
const dropProviderMessageKeyCheck = () =>
  sql.unsafe(`ALTER TABLE harness_shared.agent_usage_samples DROP CONSTRAINT IF EXISTS ${PROVIDER_MESSAGE_KEY_CHECK}`);

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  await sql`ALTER TABLE harness_shared.backup_snapshots ADD COLUMN IF NOT EXISTS db_dump_ok boolean`;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1204-interactive-usage-parser-state-cache-tiers.sql', import.meta.url);
  const body = await fs.readFile(migration, 'utf8').catch(() => fs.readFile(new URL(migration.href + '.DRAFT'), 'utf8'));
  await sql.unsafe(body); // real additive migration, also before the draft is armed
  const provenanceMigration = new URL('../../../../libs/papercusp/libs/db/sql/1205-interactive-usage-request-provenance.sql', import.meta.url);
  await sql.unsafe(await fs.readFile(provenanceMigration, 'utf8').catch(() => fs.readFile(new URL(provenanceMigration.href + '.DRAFT'), 'utf8')));
});
beforeEach(async () => {
  const [backup] = await sql`INSERT INTO harness_shared.backup_snapshots
    (workspace_id,status,trigger_reason,db_dump_ok,kopia_snapshot_id,finished_at)
    VALUES (${WS},'ok','pre_destructive',true,'test-backup',now()) RETURNING id`;
  backupId = Number(backup.id);
  await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.interactive_usage_files WHERE workspace_id = ${WS}`;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-ingest-state-'));
  roots.push(root);
});
afterAll(async () => {
  await org?.cleanup();
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('persistent transcript accounting', () => {
  it('catches up only requested native sessions before applying the file cap', async () => {
    await fs.writeFile(path.join(root, 'a-unrelated.jsonl'), context('gpt-6-sol') + usage(1000));
    await fs.writeFile(path.join(root, 'z-accepted.jsonl'), context('gpt-6-sol') + usage(2000));
    const result = await ingestInteractiveUsage({ adapters: adapter(),
      sessionIds: ['z-accepted'], maxFilesPerTick: 1 });
    expect(result.errors).toEqual([]);
    expect(result.scannedFiles).toBe(1);
    expect(result.samples).toBe(1);
    const samples = await sql`SELECT session_id FROM harness_shared.agent_usage_samples
      WHERE workspace_id = ${WS}`;
    expect(samples.map(row => row.session_id)).toEqual(['z-accepted']);
    expect((await ingestInteractiveUsage({ adapters: adapter(),
      sessionIds: ['z-accepted'], maxFilesPerTick: 1 })).samples).toBe(0);
    expect((await ingestInteractiveUsage({ adapters: adapter(), sessionIds: [] })).scannedFiles).toBe(0);
  });

  it('persists source-start ordinals and compaction generations through incremental ingestion', async () => {
    const file = path.join(root, 'carry-startup.jsonl');
    await fs.writeFile(file, line({ type: 'session_meta', payload: { forked_from_id: 'parent-session' } }) +
      context('gpt-6-sol') + usage(1000));
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    await fs.appendFile(file, usage(1000) + usage(2000)); // repeated cumulative notification is not request 2
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    await fs.appendFile(file, line({ type: 'compacted' }) + usage(3000));
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    const rows = await sql`SELECT usage_provenance FROM harness_shared.agent_usage_samples
      WHERE workspace_id=${WS} ORDER BY (usage_provenance->>'byteOffset')::bigint`;
    expect(rows.map(row => [row.usage_provenance.requestOrdinal, row.usage_provenance.contextGeneration,
      row.usage_provenance.predecessorSessionId])).toEqual([[1, 0, 'parent-session'], [2, 0, 'parent-session'], [3, 1, 'parent-session']]);
  });

  it('marks a confirmed missing source unknown, preserves original evidence, and is idempotent', async () => {
    const file = path.join(root, 'missing-history.jsonl');
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},500)`;
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,input_tokens,cache_read_tokens,cache_creation_tokens,output_tokens,cost_usd)
      VALUES (${WS},123,'interactive','openai','openai:gpt','gpt','missing-history','gpt-5.5',800,1200,0,80,123)`;
    const approval = { filePath: file, byteOffset: 500, backupSnapshotId: backupId,
      legacyFingerprint: await legacyUsageFingerprint(sql, WS, 'missing-history') };
    await expect(markUnavailableTranscriptUsage({ ...approval, legacyFingerprint: '0'.repeat(32) })).rejects.toThrow('ledger changed');
    // Existence is a positive control; no unknown marker may hide a recoverable source.
    await fs.writeFile(file, 'available');
    await expect(markUnavailableTranscriptUsage(approval)).rejects.toThrow('Source exists');
    await fs.unlink(file);
    expect(await markUnavailableTranscriptUsage(approval)).toEqual({ markedRows: 1, alreadyMarked: false });
    const [row] = await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row.model).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.input_tokens).toBeNull();
    expect(row.cache_creation_tokens).toBeNull();
    expect(row.usage_provenance.historicalAvailability.originalRow).toMatchObject({
      model: 'gpt-5.5', input_tokens: 800, cache_read_tokens: 1200, cost_usd: 123, ts: 123,
    });
    expect(await markUnavailableTranscriptUsage(approval)).toEqual({ markedRows: 0, alreadyMarked: true });
    expect(await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).toEqual([row]);
  });

  it('replays a missing live transcript from its verified archive and refuses to mark it unavailable', async () => {
    const sessionId = randomUUID();
    const dir = path.join(root, 'sessions', '2026', '09', '23');
    const file = path.join(dir, `rollout-2026-09-23T00-00-00-${sessionId}.jsonl`);
    const source = context('gpt-6-luna') + usage(1000);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, source);
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(source)})`;
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,input_tokens,cost_usd)
      VALUES (${WS},123,'interactive','openai','legacy','default',${sessionId},'gpt-5.5',800,123)`;
    const approval = { filePath: file, byteOffset: Buffer.byteLength(source), backupSnapshotId: backupId,
      legacyFingerprint: await legacyUsageFingerprint(sql, WS, sessionId) };
    const [original] = await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    const isolatedCodexAdapter = adapter('codex-iso-261')[0];
    const live = await replayTranscriptPrefix({ ...approval, adapter: isolatedCodexAdapter });
    expect((await archiveSession({ sourceKind: 'codex', sessionId, sessionRoot: root }, pgSessionArchiveStore())).ok).toBe(true);
    await fs.unlink(file);
    const archived = await replayTranscriptPrefix({ ...approval, adapter: isolatedCodexAdapter });
    expect(archived).toMatchObject({ ...live, sourceLocation: 'archive' });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' }); // no rematerialization into a live home
    await expect(markUnavailableTranscriptUsage(approval)).rejects.toThrow('archive');
    expect(await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).toEqual([original]);
    if (archived.status !== 'available') throw new Error(archived.reason);
    const historical = { ...approval, sourceSha256: archived.sourceSha256 };
    expect((await ingestInteractiveUsage({ adapters: [isolatedCodexAdapter], historical })).errors).toEqual([]);
    const corrected = await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(corrected).toHaveLength(1);
    expect(corrected[0].model).toBe('gpt-6-luna');
    expect(corrected[0].usage_provenance.reconciliation.sourceLocation).toBe('archive');
    expect(corrected[0].usage_provenance.reconciliation.originalRows[0]).toMatchObject({ model: 'gpt-5.5', cost_usd: 123 });
    expect((await ingestInteractiveUsage({ adapters: [isolatedCodexAdapter], historical })).samples).toBe(0);
    expect(await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).toEqual(corrected);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repairs previously unavailable history from an archive while retaining the nested original evidence', async () => {
    const sessionId = randomUUID();
    const dir = path.join(root, 'sessions', '2026', '09', '23');
    const file = path.join(dir, `rollout-2026-09-23T00-00-00-${sessionId}.jsonl`);
    const source = context('gpt-6-astra') + usage(1000);
    await fs.mkdir(dir, { recursive: true });
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(source)})`;
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,cost_usd)
      VALUES (${WS},123,'interactive','openai','legacy','default',${sessionId},'gpt-5.5',123)`;
    const approval = { filePath: file, byteOffset: Buffer.byteLength(source), backupSnapshotId: backupId,
      legacyFingerprint: await legacyUsageFingerprint(sql, WS, sessionId) };
    expect((await markUnavailableTranscriptUsage(approval)).markedRows).toBe(1);
    const [unknown] = await sql`SELECT to_jsonb(s) AS row FROM harness_shared.agent_usage_samples s WHERE workspace_id=${WS}`;
    expect(unknown.row.model).toBeNull();
    await fs.writeFile(file, source);
    expect((await archiveSession({ sourceKind: 'codex', sessionId, sessionRoot: root }, pgSessionArchiveStore())).ok).toBe(true);
    await fs.unlink(file);
    const replay = await replayTranscriptPrefix({ ...approval, adapter: adapter()[0] });
    if (replay.status !== 'available') throw new Error(replay.reason);
    const historical = { ...approval, sourceSha256: replay.sourceSha256,
      legacyFingerprint: await legacyUsageFingerprint(sql, WS, sessionId) };
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical })).errors).toEqual([]);
    const corrected = await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(corrected[0].model).toBe('gpt-6-astra');
    expect(corrected[0].cost_usd).toBeCloseTo(0.007225, 10);
    expect(corrected[0].usage_provenance.reconciliation.originalRows).toEqual([unknown.row]);
    expect(corrected[0].usage_provenance.reconciliation.originalRows[0].usage_provenance.historicalAvailability.originalRow)
      .toMatchObject({ model: 'gpt-5.5', cost_usd: 123 });
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical })).samples).toBe(0);
    expect(await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).toEqual(corrected);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['wrong-path', 'bad-digest', 'oversized'] as const)(
    'refuses unavailable marking when an archive is %s instead of silently treating it as absent', async (fault) => {
      const sessionId = randomUUID();
      const dir = path.join(root, 'sessions', '2026', '09', '23');
      const file = path.join(dir, `rollout-2026-09-23T00-00-00-${sessionId}.jsonl`);
      const source = context('gpt-6-luna') + usage(1000);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, source);
      await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
        VALUES (${WS},${file},${Buffer.byteLength(source)})`;
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,cost_usd)
        VALUES (${WS},123,'interactive','openai','legacy','default',${sessionId},'gpt-5.5',123)`;
      const approval = { filePath: file, byteOffset: Buffer.byteLength(source), backupSnapshotId: backupId,
        legacyFingerprint: await legacyUsageFingerprint(sql, WS, sessionId) };
      expect((await archiveSession({ sourceKind: 'codex', sessionId, sessionRoot: root }, pgSessionArchiveStore())).ok).toBe(true);
      await fs.unlink(file);
      if (fault === 'wrong-path') await sql`UPDATE harness_shared.session_archives SET session_root=${path.join(root, 'different')}
        WHERE workspace_id='default' AND source_kind='codex' AND session_id=${sessionId}`;
      if (fault === 'bad-digest') await sql`UPDATE harness_shared.session_archive_files SET sha256=${'0'.repeat(64)}
        WHERE workspace_id='default' AND source_kind='codex' AND session_id=${sessionId}`;
      if (fault === 'oversized') await sql`UPDATE harness_shared.session_archives SET bytes_raw=1073741824
        WHERE workspace_id='default' AND source_kind='codex' AND session_id=${sessionId}`;
      await expect(replayTranscriptPrefix({ ...approval, adapter: adapter()[0] })).rejects.toThrow(/[Aa]rchive/);
      await expect(markUnavailableTranscriptUsage(approval)).rejects.toThrow(/[Aa]rchive/);
      const [row] = await sql`SELECT model,cost_usd,usage_provenance FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
      expect(row).toEqual({ model: 'gpt-5.5', cost_usd: 123, usage_provenance: null });
    },
  );

  it('reconciles an approved legacy prefix atomically, retaining originals and replay idempotency', async () => {
    const file = path.join(root, 'legacy-reconcile.jsonl');
    const source = context('gpt-6-luna') + usage(1000) + usage(1000) + usage(2000);
    await fs.writeFile(file, source);
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(source)})`;
    const [old] = await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,input_tokens,cache_read_tokens,cache_creation_tokens,output_tokens,cost_usd)
      VALUES (${WS},123,'interactive','openai','openai:gpt','gpt','legacy-reconcile','gpt-5.5',800,1200,0,80,123)
      RETURNING id`;
    const replay = await replayTranscriptPrefix({ filePath: file, byteOffset: Buffer.byteLength(source), adapter: adapter()[0] });
    if (replay.status !== 'available') throw new Error(replay.reason);
    const historical = { filePath: file, byteOffset: replay.byteOffset, sourceSha256: replay.sourceSha256,
      legacyFingerprint: await legacyUsageFingerprint(sql, WS, 'legacy-reconcile'), backupSnapshotId: backupId };
    // The source and ledger fences fail before deleting anything.
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical: { ...historical, sourceSha256: '0'.repeat(64) } })).errors).toHaveLength(1);
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical: { ...historical, legacyFingerprint: '0'.repeat(32) } })).errors).toHaveLength(1);
    expect((await sql`SELECT id FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).map(r => r.id)).toEqual([old.id]);
    // Force failure AFTER the legacy DELETE and assert rollback restores it.
    await sql`ALTER TABLE harness_shared.agent_usage_samples ADD CONSTRAINT test_replay_failure
      CHECK (model <> 'gpt-6-luna') NOT VALID`;
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical })).errors).toHaveLength(1);
    expect((await sql`SELECT id FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).map(r => r.id)).toEqual([old.id]);
    await sql`ALTER TABLE harness_shared.agent_usage_samples DROP CONSTRAINT test_replay_failure`;
    const first = await ingestInteractiveUsage({ adapters: adapter(), historical });
    expect(first.errors).toEqual([]);
    const rows = await sql`SELECT model,input_tokens,cache_creation_tokens,usage_provenance
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.model)).toEqual(['gpt-6-luna', 'gpt-6-luna']);
    expect(rows.map(r => Number(r.input_tokens))).toEqual([150, 150]);
    expect(rows[0].usage_provenance.reconciliation.originalRows).toHaveLength(1);
    expect(rows[0].usage_provenance.reconciliation.originalRows[0]).toMatchObject({ model: 'gpt-5.5', cost_usd: 123 });
    expect(rows[0].usage_provenance.reconciliation.backupSnapshotId).toBe(backupId);
    const repeated = await ingestInteractiveUsage({ adapters: adapter(), historical });
    expect(repeated.errors).toEqual([]);
    expect(repeated.samples).toBe(0);
    expect(await sql`SELECT model,input_tokens,cache_creation_tokens,usage_provenance
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} ORDER BY id`).toEqual(rows);
    // A normal ingestion tick after backfill uses the restored parser state and
    // cannot count the terminal cumulative notification twice.
    await fs.appendFile(file, usage(2000) + usage(3000));
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    expect((await sql`SELECT id FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`)).toHaveLength(3);
  });

  it.each(['claude-tiers', 'codex-context'] as const)(
    'reconciles historical %s costs per request while preserving the original row exactly once', async (scenario) => {
      const file = path.join(root, `${scenario}.jsonl`);
      const timestamp = '2026-09-23T10:00:00.000Z';
      const isClaude = scenario === 'claude-tiers';
      const source = isClaude
        ? [[1_000_000, 0], [0, 1_000_000], [750_000, 250_000]].map(([fiveMinute, oneHour], i) =>
          line({ type: 'assistant', timestamp, message: { id: `tier-${i}`, model: 'claude-opus-4-8', usage: {
            input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
            cache_creation_input_tokens: fiveMinute + oneHour,
            cache_creation: { ephemeral_5m_input_tokens: fiveMinute, ephemeral_1h_input_tokens: oneHour },
          } } })).join('')
        : context('gpt-6-luna') + [272_000, 272_001].map((input, i) => line({
          type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
            total_token_usage: { input_tokens: i === 0 ? input : 544_001,
              cached_input_tokens: 260_000 * (i + 1), output_tokens: 1000 * (i + 1) },
            last_token_usage: { input_tokens: input, cached_input_tokens: 260_000,
              cache_write_input_tokens: 10_000, output_tokens: 1000 },
          } },
        })).join('');
      // Independent arithmetic, deliberately not costFromTokens/replay output:
      // Claude: 5m = 1.25 * $5/MTok, 1h = 2 * $5/MTok.
      // Luna: the 272000-input request stays short; only 272001 gets 2x input/1.5x output.
      const expectedCosts = isClaude ? [6.25, 10, 7.1875] : [0.00455, 0.0088502];
      const model = isClaude ? 'claude-opus-4-8' : 'gpt-6-luna';
      const selectedAdapter = isClaude ? { name: 'claude', root, parse: parseTranscriptChunk } : adapter()[0];
      await fs.writeFile(file, source);
      await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
        VALUES (${WS},${file},${Buffer.byteLength(source)})`;
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id,ts,source,provider,bucket_key,model_class,session_id,model,input_tokens,cache_read_tokens,cache_creation_tokens,output_tokens,cost_usd)
        VALUES (${WS},123,'interactive',${isClaude ? 'anthropic' : 'openai'},'legacy','default',${scenario},'gpt-5.5',800,1200,0,80,123)`;
      const [before] = await sql`SELECT to_jsonb(s) AS original FROM harness_shared.agent_usage_samples s WHERE workspace_id=${WS}`;
      const replay = await replayTranscriptPrefix({ filePath: file, byteOffset: Buffer.byteLength(source), adapter: selectedAdapter });
      if (replay.status !== 'available') throw new Error(replay.reason);
      const expectedTotal = expectedCosts.reduce((sum, cost) => sum + cost, 0);
      expect(replay.models[model].estimatedUsd).toBeCloseTo(expectedTotal, 10);
      expect(replay.models[model].pricedRequests).toBe(expectedCosts.length);
      expect(await sql`SELECT to_jsonb(s) AS original FROM harness_shared.agent_usage_samples s WHERE workspace_id=${WS}`)
        .toEqual([before]); // the dry run must not rewrite the old estimate
      const historical = { filePath: file, byteOffset: replay.byteOffset, sourceSha256: replay.sourceSha256,
        legacyFingerprint: await legacyUsageFingerprint(sql, WS, scenario), backupSnapshotId: backupId };
      expect((await ingestInteractiveUsage({ adapters: [selectedAdapter], historical })).errors).toEqual([]);
      const rows = await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}
        ORDER BY (usage_provenance->>'byteOffset')::bigint`;
      expect(rows).toHaveLength(expectedCosts.length);
      rows.forEach((row, i) => {
        expect(row.model).toBe(model);
        expect(row.cost_source).toBe('estimated');
        expect(row.cost_usd).toBeCloseTo(expectedCosts[i], 10);
        expect(Number(row.event_ts)).toBe(Date.parse(timestamp));
        expect(row.usage_provenance.reconciliation).toMatchObject({ sourceSha256: replay.sourceSha256,
          byteOffset: Buffer.byteLength(source), backupSnapshotId: backupId, legacyFingerprint: historical.legacyFingerprint });
      });
      if (isClaude) {
        expect(rows.map(row => [Number(row.cache_creation_5m_tokens), Number(row.cache_creation_1h_tokens)]))
          .toEqual([[1_000_000, 0], [0, 1_000_000], [750_000, 250_000]]);
      } else {
        expect(rows.map(row => row.usage_provenance.inputTotalTokens)).toEqual([272_000, 272_001]);
      }
      expect(rows.flatMap(row => row.usage_provenance.reconciliation.originalRows ?? [])).toEqual([before.original]);
      const repeated = await ingestInteractiveUsage({ adapters: [selectedAdapter], historical });
      expect(repeated.errors).toEqual([]);
      expect(repeated.samples).toBe(0);
      expect(await sql`SELECT * FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}
        ORDER BY (usage_provenance->>'byteOffset')::bigint`).toEqual(rows);
    },
  );

  it('refuses historical replacement without a backup receipt, with unread bytes, or with ambiguous source mapping', async () => {
    const file = path.join(root, 'refuse.jsonl');
    const source = context('gpt-6-luna') + usage(1000);
    await fs.writeFile(file, source);
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(source)})`;
    const replay = await replayTranscriptPrefix({ filePath: file, byteOffset: Buffer.byteLength(source), adapter: adapter()[0] });
    if (replay.status !== 'available') throw new Error(replay.reason);
    const historical = { filePath: file, byteOffset: replay.byteOffset, sourceSha256: replay.sourceSha256,
      legacyFingerprint: '0'.repeat(32), backupSnapshotId: 0 };
    await expect(ingestInteractiveUsage({ adapters: adapter(), historical })).rejects.toThrow('backup receipt');
    await sql`UPDATE harness_shared.backup_snapshots SET db_dump_ok = false WHERE id = ${backupId}`;
    await expect(ingestInteractiveUsage({ adapters: adapter(), historical: { ...historical, backupSnapshotId: backupId } }))
      .rejects.toThrow('completed database backup');
    await sql`UPDATE harness_shared.backup_snapshots SET db_dump_ok = true WHERE id = ${backupId}`;
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${path.join(root, 'copy', 'refuse.jsonl')},${Buffer.byteLength(source)})`;
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical: { ...historical, backupSnapshotId: backupId } })).errors[0].error)
      .toContain('ambiguous file-to-ledger mapping');
    await fs.appendFile(file, usage(2000));
    expect((await ingestInteractiveUsage({ adapters: adapter(), historical: { ...historical, backupSnapshotId: backupId } })).errors[0].error)
      .toContain('frontier changed');
  });

  it('replays a legacy prefix within the byte budget without recounting its usage', async () => {
    const file = path.join(root, 'legacy.jsonl');
    const past = context('gpt-6-luna') + usage(1000) + context('gpt-6-sol') + usage(2000);
    await fs.writeFile(file, past + usage(2000) + usage(3000));
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(past)})`;
    const maxBytesPerFile = Buffer.byteLength(usage(1000)) + 5;
    const first = await ingestInteractiveUsage({ adapters: adapter(), maxBytesPerFile });
    expect(first.errors).toEqual([]);
    expect(first.samples).toBe(0);
    expect(first.bootstrapPending).toBe(1);
    const [progress] = await sql`SELECT byte_offset,parser_state FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(Number(progress.byte_offset)).toBe(Buffer.byteLength(past));
    expect(progress.parser_state.bootstrapOffset).toBeGreaterThan(0);
    for (let tick = 0; tick < 8; tick++) {
      expect((await ingestInteractiveUsage({ adapters: adapter(), maxBytesPerFile })).errors).toEqual([]);
    }
    const rows = await sql`SELECT model,turn_count,input_tokens,usage_provenance FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('gpt-6-sol');
    expect(rows[0].turn_count).toBe(1);
    expect(Number(rows[0].input_tokens)).toBe(150);
    expect(rows[0].usage_provenance.parserStateSource).toBe('transcript-prefix');
    const [done] = await sql`SELECT parser_state FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(done.parser_state.initialized).toBe(true);
    expect(done.parser_state.bootstrapOffset).toBeUndefined();
  });

  it('keeps a source with no model unknown after legacy replay and does not restart recovery', async () => {
    const file = path.join(root, 'sparse-legacy.jsonl');
    const past = usage(1000);
    await fs.writeFile(file, past + usage(2000));
    await sql`INSERT INTO harness_shared.interactive_usage_files (workspace_id,file_path,byte_offset)
      VALUES (${WS},${file},${Buffer.byteLength(past)})`;
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    const [row] = await sql`SELECT model FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row.model).toBeNull();
    const [done] = await sql`SELECT parser_state FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(done.parser_state).toMatchObject({ initialized: true, bootstrapSource: 'transcript-prefix' });
  });

  it('resumes the observed model and cumulative identity on a second ingestion call', async () => {
    const file = path.join(root, '00000000-0000-4000-8000-000000000001.jsonl');
    await fs.writeFile(file, context('gpt-6-luna') + usage(1000));
    const first = await ingestInteractiveUsage({ adapters: adapter() });
    expect(first.errors).toEqual([]);
    await fs.appendFile(file, usage(1000) + usage(2000));
    const second = await ingestInteractiveUsage({ adapters: adapter() });
    expect(second.errors).toEqual([]);
    const rows = await sql`SELECT model, sum(input_tokens)::int AS input, sum(cache_read_tokens)::int AS cached,
      sum(cache_creation_tokens)::int AS written, sum(turn_count)::int AS turns
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} GROUP BY model`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ model: 'gpt-6-luna', input: 300, cached: 1200, written: 500, turns: 2 });
    const [wm] = await sql`SELECT parser_state, byte_offset FROM harness_shared.interactive_usage_files WHERE workspace_id=${WS}`;
    expect(wm.parser_state.model).toBe('gpt-6-luna');
    expect(Number(wm.byte_offset)).toBe((await fs.stat(file)).size);
    expect((await ingestInteractiveUsage({ adapters: adapter() })).samples).toBe(0);
  });

  it('does not count the same byte range twice when two ingestion ticks overlap', async () => {
    await fs.writeFile(path.join(root, 'race.jsonl'), context('gpt-6-astra') + usage(1000));
    const results = await Promise.all([
      ingestInteractiveUsage({ adapters: adapter() }), ingestInteractiveUsage({ adapters: adapter() }),
    ]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    const [row] = await sql`SELECT sum(turn_count)::int AS turns, sum(input_tokens)::int AS input
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row).toEqual({ turns: 1, input: 150 });
  });

  it('persists reported one-hour writes and leaves an absent model unknown', async () => {
    const file = path.join(root, 'claude.jsonl');
    await fs.writeFile(file, line({ type: 'assistant', message: { id: 'request-tier', model: 'claude-opus-4-8', usage: {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    } } }));
    expect((await ingestInteractiveUsage({ adapters: [{ name: 'claude', root, parse: parseTranscriptChunk }] })).errors).toEqual([]);
    const [tier] = await sql`SELECT cost_usd, cache_creation_5m_tokens, cache_creation_1h_tokens
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(tier.cost_usd).toBe(10);
    expect(Number(tier.cache_creation_5m_tokens)).toBe(0);
    expect(Number(tier.cache_creation_1h_tokens)).toBe(1_000_000);
    await fs.writeFile(path.join(root, 'unknown.jsonl'), usage(1000));
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    const [unknown] = await sql`SELECT provider, model, cost_usd FROM harness_shared.agent_usage_samples
      WHERE workspace_id=${WS} AND model IS NULL`;
    expect(unknown).toEqual({ provider: 'openai', model: null, cost_usd: null });
  });

  it.each(['claude', 'omp'])('max-merges %s streaming usage across restart boundaries without double-counting turns', async (backend) => {
    const file = path.join(root, 'streamed.jsonl');
    const timestamp = '2026-09-23T10:00:00.000Z';
    const message = (output: number, id = 'same-request') => backend === 'claude'
      ? line({ type: 'assistant', timestamp, message: { id, model: 'claude-opus-4-8', usage: {
        input_tokens: 10, output_tokens: output, cache_read_input_tokens: 200, cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
      } } })
      : line({ type: 'message', id, timestamp, message: { role: 'assistant', model: 'claude-opus-4-8', usage: {
        input: 10, output, cacheRead: 200, cacheWrite: 100,
      } } });
    const adapters = [{ name: backend, root, parse: backend === 'claude' ? parseTranscriptChunk : parseOmpChunk }];
    await fs.writeFile(file, message(20));
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    const [initial] = await sql`SELECT price_table_version FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(initial.price_table_version).toBe(PRICE_TABLE_VERSION);
    // An enrichment must refresh the writer stamp as well as the token counters.
    await sql`UPDATE harness_shared.agent_usage_samples SET price_table_version='prior-price-rules' WHERE workspace_id=${WS}`;
    await fs.appendFile(file, message(20) + message(30));
    const second = await ingestInteractiveUsage({ adapters });
    expect(second.errors).toEqual([]);
    expect(second.totals).toMatchObject({ turns: 0, inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const [row] = await sql`SELECT turn_count, input_tokens, output_tokens, event_ts, ingested_at, ts,
      usage_provenance, account_id, turn_trigger, cost_usd, price_table_version FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row.price_table_version).toBe(PRICE_TABLE_VERSION);
    expect(row.turn_count).toBe(1);
    expect(Number(row.input_tokens)).toBe(10);
    expect(Number(row.output_tokens)).toBe(30);
    expect(Number(row.event_ts)).toBe(Date.parse(timestamp));
    expect(Number(row.ts)).toBe(Date.parse(timestamp));
    expect(Number(row.ingested_at)).toBeGreaterThan(Number(row.event_ts));
    expect(row.usage_provenance).toMatchObject({ parserVersion: 2, adapter: backend, sourceId: 'message:same-request', grain: 'request', accountSource: 'unavailable' });
    expect(row.account_id).toBeNull();
    expect(row.turn_trigger).toBeNull();
    // omp reports a cache write with no TTL split: priced at the 5-minute floor and marked as a
    // lower bound (D-019), not nulled. 10x5 + 30x25 + 200x0.5 + 100x6.25 per million = 0.001525.
    if (backend === 'omp') {
      expect(Number(row.cost_usd)).toBeCloseTo(0.001525, 12);
      expect(row.usage_provenance.costBound).toBe('lower');
    } else {
      expect(row.usage_provenance.costBound).toBeNull();
    }
    await fs.appendFile(file, message(30));
    expect((await ingestInteractiveUsage({ adapters })).samples).toBe(0);
    await fs.appendFile(file, message(30, 'another-request'));
    expect((await ingestInteractiveUsage({ adapters })).totals.turns).toBe(1);
    expect(await sql`SELECT id FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`).toHaveLength(2);
  });

  it('keeps id-less requests distinct across reads and marks missing event times unknown', async () => {
    const file = path.join(root, 'anonymous.jsonl');
    const event = line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } } });
    const adapters = [{ name: 'claude', root, parse: parseTranscriptChunk }];
    await fs.writeFile(file, event);
    await ingestInteractiveUsage({ adapters });
    await fs.appendFile(file, event);
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    const rows = await sql`SELECT usage_event_key, event_ts FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.usage_event_key)).size).toBe(2);
    expect(rows.every((r) => r.event_ts === null)).toBe(true);
  });

  it('counts one provider request once when its transcript is copied into several isolated config dirs (WI-10004637)', async () => {
    // A carried/resumed session's transcript is copied into each successor's isolated
    // CLAUDE_CONFIG_DIR, and each dir is ingested by its own claude-iso-N adapter.
    const request = (id: string, output: number) => line({ type: 'assistant', sessionId: 'shared-session',
      message: { id, model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0 } } });
    const transcript = request('msg_copy_a', 100) + request('msg_copy_b', 200);
    const dirs = await Promise.all(['owner-one', 'owner-two', 'owner-three'].map(async (owner) => {
      const dir = path.join(root, owner, 'projects', 'repo');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'shared-session.jsonl'), transcript);
      return path.join(root, owner);
    }));
    const adapters = dirs.map((dir, i) => ({ name: `claude-iso-${i}`, root: dir, parse: parseTranscriptChunk }));
    const result = await ingestInteractiveUsage({ adapters });
    expect(result.errors).toEqual([]);
    const rows = await sql`SELECT usage_provenance->>'sourceId' AS source_id, output_tokens::int AS output
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} ORDER BY 1`;
    expect(rows.map((r) => [r.source_id, r.output])).toEqual([['message:msg_copy_a', 100], ['message:msg_copy_b', 200]]);
    // A copy that later grows the same request (a streamed message flushed further) still
    // max-merges into the one row instead of adding a second.
    await fs.appendFile(path.join(dirs[2]!, 'projects', 'repo', 'shared-session.jsonl'), request('msg_copy_b', 250));
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    const [after] = await sql`SELECT count(*)::int AS n, sum(output_tokens)::int AS output
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(after).toEqual({ n: 2, output: 350 });
  });

  it('migration 1287 collapses pre-fix transcript copies onto the key the fixed ingester writes (WI-10004637)', async () => {
    await dropProviderMessageKeyCheck(); // the pre-fix rows seeded below predate 1293's constraint
    const migration =new URL('../../../../libs/papercusp/libs/db/sql/1287-dedupe-claude-transcript-usage-copies.sql', import.meta.url);
    const body = await fs.readFile(migration, 'utf8').catch(() => fs.readFile(new URL(migration.href + '.DRAFT'), 'utf8'));
    await sql.unsafe(body);
    const model = 'claude-opus-4-8';
    // Rows exactly as the pre-fix ingester wrote them: one per transcript copy, keyed by file.
    const seed = async (sessionId: string, file: string, sourceId: string, output: number) => {
      const key = createHash('sha256').update(JSON.stringify([file, 0, model, sourceId])).digest('hex');
      const [row] = await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, input_tokens, output_tokens,
         cache_read_tokens, cost_usd, model, cost_source, session_id, usage_event_key, ingested_at, usage_provenance)
        VALUES (${WS}, 1, 'anthropic:opus', 'anthropic', 'opus', 'interactive', 10, ${output}, 0, ${output / 1000},
          ${model}, 'estimated', ${sessionId}, ${key}, 1, ${sql.json({ sourceId, sourceFile: file, adapter: 'claude-iso-0' })})
        RETURNING id`;
      return Number(row!.id);
    };
    const original = await seed('session-original', '/a/s.jsonl', 'message:msg_legacy', 100);
    await seed('session-copy-1', '/b/s.jsonl', 'message:msg_legacy', 100);
    await seed('session-copy-2', '/c/s.jsonl', 'message:msg_legacy', 100);
    // Copies whose numbers differ are never merged away (deleting one would lose data).
    await seed('session-original', '/a/s.jsonl', 'message:msg_diverged', 100);
    await seed('session-copy-1', '/b/s.jsonl', 'message:msg_diverged', 120);
    // Id-less observations have no identity beyond their file and stay as they are.
    await seed('session-original', '/a/s.jsonl', 'line:42', 7);
    await seed('session-copy-1', '/b/s.jsonl', 'line:42', 7);

    const [first] = await sql`SELECT * FROM harness_shared.collapse_transcript_usage_copies()`;
    expect(first).toEqual({ deleted_rows: 2, rekeyed_rows: 1, multi_row_groups: 1 });
    const rows = await sql`SELECT id, session_id, usage_event_key, usage_provenance->>'sourceId' AS source_id
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} ORDER BY id`;
    const legacy = rows.filter((r) => r.source_id === 'message:msg_legacy');
    expect(legacy.map((r) => [Number(r.id), r.session_id])).toEqual([[original, 'session-original']]);
    // Cross-language parity: the SQL key is byte-for-byte the TypeScript key.
    expect(legacy[0]!.usage_event_key).toBe(transcriptUsageEventKey({ file: '/z', fileGeneration: 9, model, sourceId: 'message:msg_legacy' }));
    expect(rows.filter((r) => r.source_id === 'message:msg_diverged')).toHaveLength(2);
    expect(rows.filter((r) => r.source_id === 'line:42')).toHaveLength(2);

    const [again] = await sql`SELECT * FROM harness_shared.collapse_transcript_usage_copies()`;
    expect(again).toEqual({ deleted_rows: 0, rekeyed_rows: 0, multi_row_groups: 1 });

    // A copy of the same transcript ingested after the repair lands on the surviving row.
    const dir = path.join(root, 'late-copy', 'projects', 'repo');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 's.jsonl'), line({ type: 'assistant', sessionId: 's',
      message: { id: 'msg_legacy', model, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0 } } }));
    const result = await ingestInteractiveUsage({ adapters: [{ name: 'claude-iso-late', root: path.join(root, 'late-copy'), parse: parseTranscriptChunk }] });
    expect(result.errors).toEqual([]);
    const [count] = await sql`SELECT count(*)::int AS n FROM harness_shared.agent_usage_samples
      WHERE workspace_id=${WS} AND usage_provenance->>'sourceId' = 'message:msg_legacy'`;
    expect(count!.n).toBe(1);
  });

  it('migration 1292 sweeps copies a still-running pre-fix ingester wrote after 1287 rekeyed the survivors (WI-10004637)', async () => {
    await dropProviderMessageKeyCheck(); // the pre-fix rows seeded below predate 1293's constraint
    const sqlDir = new URL('../../../../libs/papercusp/libs/db/sql/', import.meta.url);
    const readMigration = (name: string) => fs.readFile(new URL(name, sqlDir), 'utf8')
      .catch(() => fs.readFile(new URL(name + '.DRAFT', sqlDir), 'utf8'));
    await sql.unsafe(await readMigration('1287-dedupe-claude-transcript-usage-copies.sql'));
    const model = 'claude-opus-4-8';
    const oldKey = (file: string, sourceId: string) =>
      createHash('sha256').update(JSON.stringify([file, 0, model, sourceId])).digest('hex');
    const newKey = (sourceId: string) => transcriptUsageEventKey({ file: '/any', fileGeneration: 0, model, sourceId });
    const seed = async (sessionId: string, key: string, sourceId: string) => {
      const [row] = await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, input_tokens, output_tokens,
         cache_read_tokens, cost_usd, model, cost_source, session_id, usage_event_key, ingested_at, usage_provenance)
        VALUES (${WS}, 1, 'anthropic:opus', 'anthropic', 'opus', 'interactive', 10, 100, 0, 0.1,
          ${model}, 'estimated', ${sessionId}, ${key}, 1, ${sql.json({ sourceId, adapter: 'claude-iso-0' })})
        RETURNING id`;
      return Number(row!.id);
    };
    // The survivor 1287 already moved onto the file-independent key.
    const survivor = await seed('session-original', newKey('message:msg_rekeyed'), 'message:msg_rekeyed');
    // The pre-fix ingester, still running after 1287, wrote further copies under the old file key.
    await seed('session-copy-1', oldKey('/b/s.jsonl', 'message:msg_rekeyed'), 'message:msg_rekeyed');
    await seed('session-copy-2', oldKey('/c/s.jsonl', 'message:msg_rekeyed'), 'message:msg_rekeyed');
    // It also saw a new message first; once fixed, the ingester read that message again from another copy.
    const firstSeen = await seed('session-window', oldKey('/d/s.jsonl', 'message:msg_window'), 'message:msg_window');
    await seed('session-after-restart', newKey('message:msg_window'), 'message:msg_window');
    // A message only the pre-fix ingester saw keeps its one row, under the new key.
    const lone = await seed('session-lone', oldKey('/e/s.jsonl', 'message:msg_lone'), 'message:msg_lone');

    await sql.unsafe(await readMigration('1292-sweep-claude-transcript-usage-copies.sql'));

    const rows = await sql`SELECT id, session_id, usage_event_key, usage_provenance->>'sourceId' AS source_id
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS} ORDER BY id`;
    expect(rows.map((r) => [Number(r.id), r.session_id, r.source_id, r.usage_event_key])).toEqual([
      [survivor, 'session-original', 'message:msg_rekeyed', newKey('message:msg_rekeyed')],
      [firstSeen, 'session-window', 'message:msg_window', newKey('message:msg_window')],
      [lone, 'session-lone', 'message:msg_lone', newKey('message:msg_lone')],
    ]);
    const [again] = await sql`SELECT * FROM harness_shared.collapse_transcript_usage_copies()`;
    expect(again).toEqual({ deleted_rows: 0, rekeyed_rows: 0, multi_row_groups: 0 });
  });

  it('migration 1293 refuses a provider-message usage row that is not on the file-independent key (WI-10004637)', async () => {
    const model = 'claude-opus-4-8';
    const fileKey = (sourceId: string) =>
      createHash('sha256').update(JSON.stringify(['/a/s.jsonl', 0, model, sourceId])).digest('hex');
    const messageKey = (sourceId: string) => transcriptUsageEventKey({ file: '/a/s.jsonl', fileGeneration: 0, model, sourceId });
    const insert = (key: string, sourceId: string) => sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source, input_tokens, output_tokens,
       cache_read_tokens, cost_usd, model, cost_source, session_id, usage_event_key, ingested_at, usage_provenance)
      VALUES (${WS}, 1, 'anthropic:opus', 'anthropic', 'opus', 'interactive', 10, 100, 0, 0.1,
        ${model}, 'estimated', 'session-guard', ${key}, 1, ${sql.json({ sourceId })})`;
    const validated = async () => {
      const rows = await sql`SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'harness_shared.agent_usage_samples'::regclass AND conname = ${PROVIDER_MESSAGE_KEY_CHECK}`;
      return rows.map((r) => r.convalidated as boolean);
    };

    // An install still holding a row the collapse could not repair (diverged copies keep their
    // old key) must still migrate: the constraint is added NOT VALID and guards new writes.
    await dropProviderMessageKeyCheck();
    await insert(fileKey('message:msg_diverged_legacy'), 'message:msg_diverged_legacy');
    await sql.unsafe(await readMigration('1293-provider-message-usage-key-check.sql'));
    expect(await validated()).toEqual([false]);
    await expect(insert(fileKey('message:msg_after_unvalidated'), 'message:msg_after_unvalidated')).rejects.toMatchObject({ code: '23514' });

    // A clean install validates it, and re-running the migration changes nothing.
    await dropProviderMessageKeyCheck();
    await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
    await sql.unsafe(await readMigration('1293-provider-message-usage-key-check.sql'));
    await sql.unsafe(await readMigration('1293-provider-message-usage-key-check.sql'));
    expect(await validated()).toEqual([true]);
    await expect(insert(fileKey('message:msg_guard'), 'message:msg_guard')).rejects.toMatchObject({ code: '23514' });
    await insert(messageKey('message:msg_guard'), 'message:msg_guard');
    // Id-less observations stay file-scoped and are not constrained.
    await insert(fileKey('line:7'), 'line:7');
    // With the unique (workspace_id, usage_event_key) index, a second row for the same message cannot exist.
    await expect(insert(messageKey('message:msg_guard'), 'message:msg_guard')).rejects.toMatchObject({ code: '23505' });
  });

  it('distinguishes reused byte offsets after transcript truncation', async () => {
    const file = path.join(root, 'rotated.jsonl');
    const event = line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } } });
    const adapters = [{ name: 'claude', root, parse: parseTranscriptChunk }];
    await fs.writeFile(file, event + line({ type: 'user', content: 'make original larger' }));
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    await fs.writeFile(file, event);
    expect((await ingestInteractiveUsage({ adapters })).totals.turns).toBe(1);
    const rows = await sql`SELECT usage_provenance FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.usage_provenance.fileGeneration).sort()).toEqual([0, 1]);
  });

  it('persists missing writes as NULL, then enriches an explicit zero without adding a turn', async () => {
    const file = path.join(root, 'unknown-writes.jsonl');
    const message = (writes?: number) => line({ type: 'assistant', message: { id: 'same', model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 1, ...(writes === undefined ? {} : { cache_creation_input_tokens: writes }) } } });
    const adapters = [{ name: 'claude', root, parse: parseTranscriptChunk }];
    await fs.writeFile(file, message());
    expect((await ingestInteractiveUsage({ adapters })).errors).toEqual([]);
    const [unknown] = await sql`SELECT cache_creation_tokens,cost_usd,usage_provenance,price_table_version FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(unknown.price_table_version).toBe(PRICE_TABLE_VERSION);
    expect(unknown.cache_creation_tokens).toBeNull();
    expect(unknown.cost_usd).toBeNull();
    expect(unknown.usage_provenance.cacheWriteSource).toBe('unreported');
    await fs.appendFile(file, message(0));
    expect((await ingestInteractiveUsage({ adapters })).totals.turns).toBe(0);
    const [known] = await sql`SELECT turn_count,cache_creation_tokens,cost_usd,usage_provenance,price_table_version FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(known.price_table_version).toBe(PRICE_TABLE_VERSION);
    expect(known.turn_count).toBe(1);
    expect(Number(known.cache_creation_tokens)).toBe(0);
    expect(known.cost_usd).toBeGreaterThan(0);
    expect(known.usage_provenance.cacheWriteSource).toBe('reported');
  });

  it('retains inclusive OpenAI input without labeling unknown fresh/write decomposition as measured', async () => {
    const event = JSON.parse(usage(1000));
    delete event.payload.info.last_token_usage.cache_write_input_tokens;
    await fs.writeFile(path.join(root, 'inclusive.jsonl'), context('gpt-6-luna') + line(event));
    expect((await ingestInteractiveUsage({ adapters: adapter() })).errors).toEqual([]);
    const [row] = await sql`SELECT input_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,usage_provenance
      FROM harness_shared.agent_usage_samples WHERE workspace_id=${WS}`;
    expect(row.input_tokens).toBeNull();
    expect(row.cache_creation_tokens).toBeNull();
    expect(Number(row.cache_read_tokens)).toBe(600);
    expect(row.cost_usd).toBeNull();
    expect(row.usage_provenance).toMatchObject({ inputTotalTokens: 1000, uncachedInputSource: 'unknown-decomposition' });
  });
});
