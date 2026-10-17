import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recoverInvocationFriction } from '../../harness/improvements/invocation-friction';

describe('tool failures filed from the ledger', () => {
  it('files a failed invocation without an agent report and marks it delivered', async () => {
    const row = { id: '42', workspace_id: 'ws', harness_slug: 'papercusp', coord_owner_id: 'su-original',
      invoked_at: new Date().toISOString(), tool_name: 'plans:get', status: 'error',
      error_code: 'unexpected_error', error_message: 'reader failed', serving_build_sha: 'abc1234',
      metadata_json: { frictionCapture: 'pending' } };
    const capture = vi.fn(async () => ({ ok: true, created: true, issue: { id: 'EI-filed' } }));
    const unsafe = vi.fn(async (query: string) => {
      if (query.includes('frictionExpiredReason') || query.includes('set_config')) return [];
      if (query.includes('UPDATE harness_shared.tool_invocations')) {
        row.metadata_json.frictionCapture = 'delivered';
        return [];
      }
      if (query.includes('FOR UPDATE SKIP LOCKED')) return row.metadata_json.frictionCapture === 'pending' ? [row] : [];
      return row.metadata_json.frictionCapture === 'pending' ? [{ id: row.id }] : [];
    });
    const sql = { unsafe, begin: (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe }) };
    const deps = { sql, capture } as unknown as NonNullable<Parameters<typeof recoverInvocationFriction>[1]>;
    expect(await recoverInvocationFriction('ws', deps)).toEqual({ delivered: 1, pending: 0, expired: 0 });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ invocationId: '42', ownerId: 'su-original',
      failure: expect.objectContaining({ toolName: 'plans:get', errorCode: 'unexpected_error' }) }));
    expect(await recoverInvocationFriction('ws', deps)).toEqual({ delivered: 0, pending: 0, expired: 0 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('guides agents to use automatic capture for plain failures', () => {
    const source = readFileSync(resolve(process.cwd(), '../../libs/papercusp/packages/harness/blueprints/base/prompts/su.md'), 'utf8');
    expect(source).toContain('Plain tool\n  failures are filed automatically from `tool_invocations`');
    expect(source).toContain('Do not hand-report a plain');
    expect(source).not.toContain('ANY failure, that workaround IS a discovery');
    expect(source).toContain('an unrecorded client/transport failure');
  });
});
