import { expect, it } from 'vitest';
import { observeSqlDemand } from '../bash-substitution/sql-intent-corpus';
import { EXAMPLE_LIFETIME_MS, EXAMPLE_PURGE_GRACE_MS, exampleReadable, miningScopeId,
  minimizeSqlObservation, sourcesCurrentlyReadable } from './privacy';
const scope = { workspaceId: 'test', sourceBoundary: 'ledger', epoch: 'one', key: new Uint8Array(32).fill(61) };
it('R14-CONTRACT', () => {
  const observe = (s = scope) => observeSqlDemand({ workspaceId: 'test', harnessSlug: 'h', namespace: 'ledger',
    callId: '1', resultCallId: '1', identityAuthority: 'ledger', provider: 'ledger', actor: 'private-actor',
    verifiedAgent: true, at: '2026-10-24T00:00:00Z', origin: 'agent', status: 'ok', durationMs: 3,
    sql: "SELECT private_field FROM private_relation WHERE password='credential' AND status='tiny-private-enum'",
    sourceComplete: true, copyRef: 'private-copy' }, s);
  const a = observe(), b = observe({ ...scope, sourceBoundary: 'other' }), c = observe({ ...scope, epoch: 'two' });
  expect(a.actorToken).not.toBe(b.actorToken); expect(a.actorToken).not.toBe(c.actorToken);
  expect(miningScopeId(scope, 'h')).not.toBe(miningScopeId({ ...scope, epoch: 'two' }, 'h'));
  const persisted = JSON.stringify(minimizeSqlObservation(a));
  for (const privateText of ['private-actor', 'credential', 'private_field', 'private_relation', 'tiny-private-enum'])
    expect(persisted).not.toContain(privateText);
  expect(minimizeSqlObservation(a).intent).toMatchObject({ canonical: '', secretValuesDropped: true });
});
it('R16-CONTRACT', () => {
  const captured = Date.parse('2026-10-01T00:00:00Z'), expiry = captured + EXAMPLE_LIFETIME_MS;
  expect(exampleReadable(new Date(expiry), expiry - 1)).toBe(true);
  expect(exampleReadable(new Date(expiry), expiry)).toBe(false);
  expect(exampleReadable(new Date(expiry), expiry + 1)).toBe(false);
  expect(exampleReadable('invalid', expiry)).toBe(false);
});
it('R23-DERIVED-ACL', async () => {
  const ids = ['one', 'two'];
  expect(await sourcesCurrentlyReadable(ids, async () => true)).toBe(true);
  expect(await sourcesCurrentlyReadable(ids, async id => id !== 'two')).toBe(false);
  expect(await sourcesCurrentlyReadable(ids, async () => { throw new Error('lookup unavailable'); })).toBe(false);
  expect(await sourcesCurrentlyReadable([], async () => true)).toBe(false);
});
it('R24-PURGE', () => {
  expect(EXAMPLE_PURGE_GRACE_MS).toBe(86400_000);
  expect(exampleReadable(new Date(0), EXAMPLE_LIFETIME_MS + EXAMPLE_PURGE_GRACE_MS)).toBe(false);
});
