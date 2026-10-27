import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshTestDb } from '@papercusp/test-config/pg';
import type { ScopedContentError } from './run-git-sync';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
import { gitSyncContentEscalationBody, gitSyncContentSignature, persistGitSyncContentReport } from './git-sync-content-report';

let db: Awaited<ReturnType<typeof createFreshTestDb>>;
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'git_content_report' });
  h.sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await h.sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.harness_text_artifacts (
      harness_slug text NOT NULL, rel_path text NOT NULL, content text NOT NULL,
      updated_at bigint NOT NULL, workspace_id text NOT NULL, PRIMARY KEY (harness_slug, rel_path));
    CREATE TABLE harness_shared.harness_escalations (
      harness_slug text NOT NULL, phase text NOT NULL, escalation text, supervisor_notes text,
      body_tsv tsvector, workspace_id text NOT NULL, PRIMARY KEY (harness_slug, phase));`);
  // Execute the canonical trigger function rather than a reimplementation.
  const baseline = await readFile(new URL('../../../../../libs/papercusp/libs/db/sql/000-baseline.sql', import.meta.url), 'utf8');
  const trigger = baseline.match(/CREATE OR REPLACE FUNCTION harness_shared\.harness_escalations_tsv_update\(\)[\s\S]*?\n\$\$;/)?.[0];
  expect(trigger).toBeTruthy();
  await h.sql.unsafe(trigger!);
  await h.sql.unsafe(`CREATE TRIGGER harness_escalations_tsv_update
    BEFORE INSERT OR UPDATE ON harness_shared.harness_escalations
    FOR EACH ROW EXECUTE FUNCTION harness_shared.harness_escalations_tsv_update()`);
}, 90_000);

afterAll(async () => {
  await h.sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('git-sync complete quarantine evidence and indexed previews', () => {
  it('avoids 54000 in the actual escalation trigger while retaining every exact blocker', async () => {
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    const errors: ScopedContentError[] = Array.from({ length: 8169 }, (_, i) => ({
      scope: 'superproject', file: `src/${hash('directory' + i)}/${hash('filename' + i)}.ts`,
      detectorKey: 'quarantined-importer', error: `${hash('error' + i)} ${hash('detail' + i)}`,
      fixerRole: 'content-fixer', excludedRoot: `root/${i}.ts`,
      excludedRootReason: `held by su-peer for WI-${i} — turn-scoped hold`,
      contentHash: hash('content' + i), detectorResultHash: hash('verdict' + i),
    }));
    const legacy = JSON.stringify({ kind: 'git-sync-content-error', files: errors });
    // Same insert target/trigger, same full data: the old indexed payload fails.
    await expect(h.sql`INSERT INTO harness_shared.harness_escalations
      (harness_slug, phase, escalation, workspace_id)
      VALUES ('report-fixture', 'legacy', ${legacy}, 'ws-report')`).rejects.toMatchObject({ code: '54000' });

    const path = await persistGitSyncContentReport('report-fixture', 'ws-report', errors);
    const body = gitSyncContentEscalationBody('report-fixture', errors, 5, true, path);
    await h.sql`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, workspace_id)
      VALUES ('report-fixture', 'git-sync-content', ${body}, 'ws-report')`;
    const [stored] = await h.sql`SELECT escalation::jsonb AS body, body_tsv IS NOT NULL AS indexed
      FROM harness_shared.harness_escalations WHERE harness_slug='report-fixture' AND phase='git-sync-content'`;
    expect(stored!.indexed).toBe(true);
    expect(stored!.body).toMatchObject({ file_count: 8169, files_omitted: 8149, needs_human: true, evidence_artifact: path });
    expect(stored!.body.files).toHaveLength(20);
    expect(stored!.body.files[0]).toMatchObject({ excludedRoot: errors[0]!.excludedRoot, excludedRootReason: errors[0]!.excludedRootReason });
    const [artifact] = await h.sql`SELECT content, workspace_id FROM harness_shared.harness_text_artifacts
      WHERE harness_slug='report-fixture' AND rel_path=${path!}`;
    expect(artifact!.workspace_id).toBe('ws-report');
    expect(JSON.parse(artifact!.content).files).toEqual(errors);
    expect(await persistGitSyncContentReport('report-fixture', 'ws-report', errors)).toBe(path);
    expect(await h.sql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='report-fixture'`).toHaveLength(1);
  }, 30_000);

  it('keeps the offender set identity bounded, ordered and message-independent', () => {
    const a: ScopedContentError = { scope: 'superproject', file: 'a.ts', detectorKey: 'mdx', error: 'first', fixerRole: 'content-fixer' };
    const b = { ...a, file: 'b.ts' };
    expect(gitSyncContentSignature([a, b])).toHaveLength(71);
    expect(gitSyncContentSignature([a, b])).toBe(gitSyncContentSignature([b, { ...a, error: 'different' }, a]));
    expect(gitSyncContentSignature([a])).not.toBe(gitSyncContentSignature([b]));
  });
});
