import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineerIssue } from '../../issues-engineer';
import type { SystemActionCtx } from './system-actions';
import type { WedgeIssueDeps } from './pty-host-wedge-issue';
import { runPsuPtyHostEventsIngestAction } from './psu-pty-host-events-ingest-action';
import { ingestPsuPtyHostEvents } from './psu-pty-host-events-ingest';

interface PersistedEvent {
  workspace_id: string;
  owner_id: string;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  row_digest: string;
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function eventDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'psu-pty-action-'));
  dirs.push(dir);
  return dir;
}

function line(ownerId: string, payload: Record<string, unknown>, ts = '2026-10-02T05:00:00.000Z'): string {
  return JSON.stringify({ ts, kind: 'host-code-stale', ...payload, ownerId });
}

function memorySql() {
  const persisted: PersistedEvent[] = [];
  const statements: string[] = [];
  const sql = (async (segments: TemplateStringsArray, ...values: unknown[]) => {
    const statement = segments.join(' ? ');
    statements.push(statement);

    if (statement.includes('INSERT INTO harness_shared.psu_pty_host_events')) {
      const [workspaces, owners, timestamps, kinds, payloads, digests] = values as [
        string[], string[], string[], string[], string[], string[],
      ];
      for (let i = 0; i < workspaces.length; i++) {
        persisted.push({
          workspace_id: workspaces[i]!,
          owner_id: owners[i]!,
          ts: timestamps[i]!,
          kind: kinds[i]!,
          payload: JSON.parse(payloads[i]!) as Record<string, unknown>,
          row_digest: digests[i]!,
        });
      }
      return Object.assign([], { count: workspaces.length });
    }

    if (statement.includes('FROM harness_shared.psu_pty_host_events')) {
      const workspaceId = String(values[0]);
      const latestByOwner = new Map<string, PersistedEvent>();
      for (const event of persisted) {
        if (
          event.workspace_id !== workspaceId ||
          event.kind !== 'host-code-stale' ||
          event.payload.notAdoptingReason !== 'interactive-tty' ||
          event.payload.bridgeTty !== true ||
          event.payload.operatorPin !== 'direct-3170'
        ) continue;
        const prior = latestByOwner.get(event.owner_id);
        if (!prior || Date.parse(event.ts) > Date.parse(prior.ts)) latestByOwner.set(event.owner_id, event);
      }
      const all = [...latestByOwner.values()];
      const evidenceDigest = createHash('md5')
        .update([...all].sort((a, b) => a.owner_id.localeCompare(b.owner_id)).map((row) => row.row_digest).join(','))
        .digest('hex');
      const sample = [...all]
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.owner_id.localeCompare(b.owner_id))
        .slice(0, 25);
      const details = sample.map((event) => ({
        total_owners: all.length,
        evidence_digest: evidenceDigest,
        owner_id: event.owner_id,
        ts: new Date(event.ts),
        mode: event.payload.mode ?? null,
        loaded: event.payload.loaded ?? null,
        on_disk: event.payload.onDisk ?? null,
      }));
      return details.length > 0
        ? details
        : [{ total_owners: 0, evidence_digest: evidenceDigest, owner_id: null, ts: null, mode: null, loaded: null, on_disk: null }];
    }

    if (statement.includes('DELETE FROM harness_shared.psu_pty_host_events')) {
      return Object.assign([], { count: 0 });
    }
    throw new Error(`unexpected SQL in action test: ${statement}`);
  }) as unknown as Sql;

  return { sql, persisted, statements };
}

function issueDeps() {
  const calls = { created: [] as Array<Parameters<WedgeIssueDeps['createIssue']>[0]>, comments: [] as string[] };
  const deps: WedgeIssueDeps = {
    listIssues: async () => [],
    createIssue: async (input) => {
      calls.created.push(input);
      return {
        id: 'EI-TEST',
        state: 'open',
        body: input.body,
        payload: null,
        title: input.title,
      } as EngineerIssue;
    },
    commentIssue: async (_id, body) => { calls.comments.push(body); },
    mergeIssuePayload: async () => null,
  };
  return { deps, calls };
}

function ctx(triggerConfig: Record<string, unknown> = {}): SystemActionCtx {
  return { installSlug: 'papercusp', workspaceId: 'ws-test', triggerConfig, payloadTemplate: null };
}

describe('psu-pty-host-events-ingest P-008 consumer', () => {
  it('ingests the closed direct-pin enum and files one pending issue from the persisted interactive row', async () => {
    const dir = await eventDir();
    await writeFile(
      join(dir, 'su-direct.events.jsonl'),
      line('su-direct', {
        mode: 'recycle',
        loaded: 'a'.repeat(64),
        onDisk: 'b'.repeat(64),
        notAdoptingReason: 'interactive-tty',
        bridgeTty: true,
        operatorPin: 'direct-3170',
      }),
    );
    const store = memorySql();
    const issues = issueDeps();

    await runPsuPtyHostEventsIngestAction(ctx(), {
      sql: store.sql,
      ingest: (options) => ingestPsuPtyHostEvents({ ...options, dir }),
      issueDeps: issues.deps,
    });

    expect(store.persisted).toHaveLength(1);
    expect(store.persisted[0]?.payload.operatorPin).toBe('direct-3170');
    const selection = store.statements.find((statement) => statement.includes('WITH matching AS'));
    expect(selection).toContain("kind = 'host-code-stale'");
    expect(selection).toContain("payload ->> 'notAdoptingReason' = 'interactive-tty'");
    expect(selection).toContain("payload ->> 'bridgeTty' = 'true'");
    expect(selection).toContain("payload ->> 'operatorPin' = 'direct-3170'");
    expect(issues.calls.created).toHaveLength(1);
    expect(issues.calls.created[0]?.admission).toBe('pending');
    expect(issues.calls.created[0]?.body).toContain('su-direct at 2026-10-02T05:00:00.000Z');
    expect(issues.calls.created[0]?.body).not.toContain('PAPERCUSP_OPERATOR_URL');
  });

  it('does not file an issue for a bridged refusal without the direct-3170 pin', async () => {
    const dir = await eventDir();
    await writeFile(
      join(dir, 'su-other.events.jsonl'),
      [
        line('su-other', {
          notAdoptingReason: 'interactive-tty', bridgeTty: true, operatorPin: 'other',
        }),
        line('su-headless', {
          notAdoptingReason: 'no-reexec-code', bridgeTty: false, operatorPin: 'direct-3170',
        }, '2026-10-02T05:01:00.000Z'),
      ].join('\n'),
    );
    const store = memorySql();
    const issues = issueDeps();

    await runPsuPtyHostEventsIngestAction(ctx(), {
      sql: store.sql,
      ingest: (options) => ingestPsuPtyHostEvents({ ...options, dir }),
      issueDeps: issues.deps,
    });

    expect(store.persisted).toHaveLength(2);
    expect(issues.calls.created).toHaveLength(0);
    expect(issues.calls.comments).toHaveLength(0);
  });

  it('keeps dry-run free of Postgres issue selection and issue writes', async () => {
    const dir = await eventDir();
    const path = join(dir, 'su-direct.events.jsonl');
    await writeFile(
      path,
      line('su-direct', {
        notAdoptingReason: 'interactive-tty', bridgeTty: true, operatorPin: 'direct-3170',
      }),
    );
    const store = memorySql();
    const issues = issueDeps();

    await runPsuPtyHostEventsIngestAction(ctx({ dry_run: true }), {
      sql: store.sql,
      ingest: (options) => ingestPsuPtyHostEvents({ ...options, dir }),
      issueDeps: issues.deps,
    });

    expect(store.persisted).toHaveLength(0);
    expect(store.statements.some((statement) => statement.includes('FROM harness_shared.psu_pty_host_events'))).toBe(false);
    expect(issues.calls.created).toHaveLength(0);
    expect(await readdir(dir)).toContain('su-direct.events.jsonl');
  });
});
