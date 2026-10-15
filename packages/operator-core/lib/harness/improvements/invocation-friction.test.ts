import { describe, expect, it, vi } from 'vitest';
import { captureInvocationFriction, recoverInvocationFriction } from './invocation-friction';
import { currentRequestWorkspaceId } from '../../workspace-als';

function fixture(count = 1) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1), workspace_id: 'ws-a', harness_slug: 'papercusp', coord_owner_id: 'su-a',
    invoked_at: new Date().toISOString(), tool_name: 'coord:send', status: 'invalid-input',
    error_code: 'invalid_input', error_message: 'body: must be an array', serving_build_sha: 'loaded-build',
    metadata_json: { frictionCapture: 'pending', invalidInput: { source: 'projected-tool-registry',
      toolName: 'coord:send', registryRevision: 'schema-v1' } } as Record<string, unknown>,
  }));
  const locked = new Set<string>();
  const reads: string[] = [];
  const unsafe = vi.fn(async (query: string, params: string[]) => {
    reads.push(query);
    if (query.includes('frictionExpiredReason') && query.includes('UPDATE')) {
      const staleBefore = Date.parse(String(params[1]));
      const expired = rows.filter(row => row.workspace_id === params[0] &&
        row.metadata_json.frictionCapture === 'pending' && Date.parse(row.invoked_at) < staleBefore &&
        !locked.has(row.id)).sort((a, b) => a.invoked_at.localeCompare(b.invoked_at)).slice(0, 100);
      for (const row of expired) {
        row.metadata_json.frictionCapture = 'expired';
        row.metadata_json.frictionExpiredReason = 'older-than-24-hours';
      }
      return expired.map(row => ({ id: row.id }));
    }
    if (query.includes('frictionAttemptAt') && query.includes('UPDATE')) {
      const row = rows.find(row => row.workspace_id === params[0] && row.id === params[1]);
      if (row) {
        row.metadata_json.frictionAttemptAt = params[2];
        row.metadata_json.frictionFailureClass = params[3];
        row.metadata_json.frictionFailureCode = params[4] ?? null;
      }
      return [];
    }
    return rows.filter(row => row.workspace_id === params[0] && row.metadata_json.frictionCapture === 'pending')
      .sort((a, b) => String(a.metadata_json.frictionAttemptAt ?? '').localeCompare(String(b.metadata_json.frictionAttemptAt ?? '')))
      .slice(0, 100).map(row => ({ id: row.id }));
  });
  const sql = { unsafe, begin: async (callback: (tx: unknown) => Promise<unknown>) => {
    let held: string | undefined;
    let mark: (typeof rows)[number] | undefined;
    try {
      const result = await callback({ unsafe: async (query: string, params: string[]) => {
        reads.push(query);
        if (query.includes('set_config')) return [];
        const row = rows.find(row => row.workspace_id === params[0] && row.id === params[1]);
        if (query.includes('FOR UPDATE SKIP LOCKED')) {
          if (!row || locked.has(row.id) || row.metadata_json.frictionCapture !== 'pending') return [];
          held = row.id; locked.add(row.id); return [structuredClone(row)];
        }
        if (query.includes('UPDATE harness_shared.tool_invocations')) { mark = row; return []; }
        throw new Error('Unexpected fixture SQL');
      } });
      if (mark) {
        mark.metadata_json.frictionCapture = 'delivered';
        delete mark.metadata_json.frictionFailureClass;
        delete mark.metadata_json.frictionFailureCode;
      }
      return result;
    } finally { if (held) locked.delete(held); }
  } } as unknown as NonNullable<Parameters<typeof captureInvocationFriction>[1]>['sql'];
  const capture = vi.fn(async () => ({ ok: true, created: true, issue: { id: 'EI-one' } })) as unknown as
    ReturnType<typeof vi.fn> & NonNullable<Parameters<typeof captureInvocationFriction>[1]>['capture'];
  return { rows, locked, reads, sql, capture };
}

describe('R7 durable invocation capture', () => {
  it('recovers two invalid calls without miner thresholds and does not redeliver completed rows', async () => {
    const f = fixture(2);
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 2, pending: 0, expired: 0 });
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 0, pending: 0, expired: 0 });
    expect(f.capture).toHaveBeenCalledTimes(2);
  });

  it('recovers a failed capture on the next tick and reports the failed tick truthfully', async () => {
    const f = fixture(2);
    f.capture.mockRejectedValueOnce(new Error('store unavailable'));
    await expect(recoverInvocationFriction('ws-a', f)).rejects.toThrow('1 failed, 1 delivered, 0 expired');
    expect(f.rows.map(row => row.metadata_json.frictionCapture)).toEqual(['pending', 'delivered']);
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 1, pending: 0, expired: 0 });
  });

  it('expires stale pending rows without blocking recovery of recent failures', async () => {
    const f = fixture(2);
    f.rows[0].invoked_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 1, pending: 0, expired: 1 });
    expect(f.rows.map(row => row.metadata_json.frictionCapture)).toEqual(['expired', 'delivered']);
    expect(f.rows[0].metadata_json.frictionExpiredReason).toBe('older-than-24-hours');
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 0, pending: 0, expired: 0 });
  });

  it('does not mark a refused or unpersisted capture delivered', async () => {
    const f = fixture();
    f.capture.mockResolvedValueOnce({ ok: false, created: false });
    await expect(captureInvocationFriction({ id: '1', workspaceId: 'ws-a' }, f)).rejects.toThrow('did not accept');
    expect(f.rows[0].metadata_json.frictionCapture).toBe('pending');
  });

  it('marks an accepted coalesced occurrence delivered when no canonical issue is returned', async () => {
    const f = fixture();
    f.capture.mockResolvedValueOnce({ ok: true, created: false, reason: 'coalesced', possibleDuplicates: [] });
    expect(await captureInvocationFriction({ id: '1', workspaceId: 'ws-a' }, f)).toBe(true);
    expect(f.rows[0].metadata_json.frictionCapture).toBe('delivered');
    expect(f.capture).toHaveBeenCalledTimes(1);
  });

  it('uses original scope/reporter/contract/build and strips unmeasured direct evidence', async () => {
    const f = fixture();
    f.rows[0].metadata_json.toolFailure = { reproduced: true, hardInternal: true };
    let captureWorkspace: ReturnType<typeof currentRequestWorkspaceId> | undefined;
    f.capture.mockImplementationOnce(async () => {
      captureWorkspace = currentRequestWorkspaceId();
      return { ok: true, issue: { id: 'EI-one' } };
    });
    expect(await recoverInvocationFriction('ws-b', f)).toEqual({ delivered: 0, pending: 0, expired: 0 });
    await recoverInvocationFriction('ws-a', f);
    expect(f.capture).toHaveBeenCalledTimes(1);
    // Assert after recovery so its sanitized callback-error handling cannot hide
    // the actual provenance difference from this test's failure output.
    expect(captureWorkspace).toBe('ws-a');
    expect(f.capture.mock.calls[0][0]).toEqual({ workspaceId: 'ws-a', harnessSlug: 'papercusp', ownerId: 'su-a',
      invocationId: '1', servingBuildSha: 'loaded-build',
      invokedAt: new Date(f.rows[0].invoked_at).toISOString(), failure: { toolName: 'coord:send', status: 'invalid-input',
        errorCode: 'invalid_input', message: 'body: must be an array', schemaRevision: 'schema-v1', runtimeVersion: 'loaded-build' } });
  });

  it('leaves missing or untrusted contract provenance unknown', async () => {
    const f = fixture();
    f.rows[0].metadata_json.invalidInput = { source: 'handler', registryRevision: 'invented' };
    await recoverInvocationFriction('ws-a', f);
    expect(f.capture.mock.calls[0][0].failure.schemaRevision).toBeUndefined();
  });

  it('skips a concurrently locked fast-path row and recovers it after release', async () => {
    const f = fixture();
    f.locked.add('1');
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 0, pending: 1, expired: 0 });
    expect(f.capture).not.toHaveBeenCalled();
    f.locked.delete('1');
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 1, pending: 0, expired: 0 });
  });

  it('drains a bounded batch and continues the remainder next tick', async () => {
    const f = fixture(101);
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 100, pending: 0, expired: 0 });
    expect(await recoverInvocationFriction('ws-a', f)).toEqual({ delivered: 1, pending: 0, expired: 0 });
    expect(f.reads[0]).toContain('LIMIT 100');
  });

  it('rotates a permanently failed first batch so later reports are not starved', async () => {
    const f = fixture(101);
    f.capture.mockRejectedValue(new Error('fixture failure'));
    await expect(recoverInvocationFriction('ws-a', f)).rejects.toThrow('100 failed');
    expect(f.rows[100].metadata_json.frictionAttemptAt).toBeUndefined();
    expect(f.rows[0].metadata_json).toMatchObject({frictionFailureClass:'Error',frictionFailureCode:null});
    await expect(recoverInvocationFriction('ws-a', f)).rejects.toThrow('100 failed');
    expect(f.rows[100].metadata_json.frictionAttemptAt).toBeTypeOf('string');
  });

  it('reports only an allowlisted error class and code, never the exception message', async () => {
    const f = fixture();
    f.capture.mockRejectedValueOnce(Object.assign(new Error('sensitive invocation detail'), {code:'23505'}));
    const error = (await recoverInvocationFriction('ws-a', f).catch((value: unknown) => value)) as Error;
    expect(error.message).toContain('failure classes: Error/23505=1');
    expect(error.message).not.toContain('sensitive invocation detail');
    expect(f.rows[0].metadata_json).toMatchObject({
      frictionCapture:'pending', frictionFailureClass:'Error', frictionFailureCode:'23505',
    });
    expect(JSON.stringify(f.rows[0].metadata_json)).not.toContain('sensitive invocation detail');
  });
});
