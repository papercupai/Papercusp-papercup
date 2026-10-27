import { lstat, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupReuseFixture, createReuseFixture, trackReuseFixture, REUSE_FIXTURE_RETENTION,
  type ReuseFixtureIdentity, type ReuseFixtureLifecyclePorts } from './reuse-fixture-lifecycle';

const fixtures: ReuseFixtureIdentity[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.evidenceRoot, { recursive: true, force: true });
    await rm(fixture.root + '-moved', { recursive: true, force: true });
  }
});
async function fixture() {
  const owned = await createReuseFixture('fixture-workspace', 'su-fixture'); fixtures.push(owned);
  const harness = { slug: `r-${owned.token.slice(0, 8)}`, path: owned.root,
    registrationOnly: { commitSha: 'a'.repeat(40) } };
  const session = { id: 1, sessionId: `controlled-${owned.token}`, planSlug: 'controlled',
    startedAt: '2026-10-25 20:00:00.123456+00' };
  const claim = { id: 'WI-fixture', harness: harness.slug };
  await trackReuseFixture(owned, { harness });
  await trackReuseFixture(owned, { session });
  await trackReuseFixture(owned, { claim });
  let registered = true, ended = false, released = false;
  const ports: ReuseFixtureLifecyclePorts = {
    readHarness: vi.fn(async () => registered ? harness : null),
    removeHarness: vi.fn(async () => { registered = false; }),
    readSession: vi.fn(async () => ({ ...session, workspaceId: owned.workspaceId,
      owner: owned.owner, root: owned.root, ended })),
    endSession: vi.fn(async () => { ended = true; return true; }),
    readClaim: vi.fn(async () => ({ workspaceId: owned.workspaceId, owner: released ? null : owned.owner,
      harness: harness.slug })),
    releaseClaim: vi.fn(async () => { released = true; return true; }),
  };
  return { owned, ports, harness, session };
}

it('retains proof outside the removed runtime and retries completed cleanup without writes', async () => {
  const { owned, ports } = await fixture();
  await writeFile(join(owned.evidenceRoot, 'client-receipt.json'), '{"actual":"response"}');
  await cleanupReuseFixture(owned, ports);
  await expect(lstat(owned.root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(owned.evidenceRoot, 'client-receipt.json'), 'utf8')).toBe('{"actual":"response"}');
  expect(JSON.parse(await readFile(join(owned.evidenceRoot, 'lifecycle.json'), 'utf8'))).toMatchObject({
    cleaned: true, retention: REUSE_FIXTURE_RETENTION, claims: [{ id: 'WI-fixture' }], sessions: [{ id: 1 }],
  });
  await cleanupReuseFixture(owned, ports);
  expect(ports.endSession).toHaveBeenCalledTimes(1);
  expect(ports.releaseClaim).toHaveBeenCalledTimes(1);
  expect(ports.removeHarness).toHaveBeenCalledTimes(1);
});

it.each(['workspaceId', 'owner', 'token'] as const)('rejects a sibling %s before cleanup mutation', async key => {
  const { owned, ports } = await fixture();
  await expect(cleanupReuseFixture({ ...owned, [key]: 'other' }, ports)).rejects.toThrow('ownership mismatch');
  expect(ports.releaseClaim).not.toHaveBeenCalled();
  expect(ports.endSession).not.toHaveBeenCalled();
  expect(ports.removeHarness).not.toHaveBeenCalled();
  expect((await lstat(owned.root)).isDirectory()).toBe(true);
});

it.each(['harness', 'claim', 'session', 'workspace', 'incarnation'])('preflights changed %s before any writes', async changed => {
  const { owned, ports, harness } = await fixture();
  if (changed === 'harness') vi.mocked(ports.readHarness).mockResolvedValue({ ...harness, path: '/unrelated' });
  if (changed === 'claim') vi.mocked(ports.readClaim).mockResolvedValue({
    workspaceId: owned.workspaceId, owner: 'su-other', harness: harness.slug,
  });
  if (changed === 'session' || changed === 'workspace' || changed === 'incarnation') {
    const real = ports.readSession;
    ports.readSession = async id => ({ ...(await real(id))!,
      ...(changed === 'session' ? { owner: 'su-other' } : changed === 'workspace'
        ? { workspaceId: 'sibling-workspace' } : { startedAt: '2026-10-25 20:00:00.123457+00' }),
    });
  }
  await expect(cleanupReuseFixture(owned, ports)).rejects.toThrow('ownership changed');
  expect(ports.releaseClaim).not.toHaveBeenCalled();
  expect(ports.endSession).not.toHaveBeenCalled();
  expect(ports.removeHarness).not.toHaveBeenCalled();
});

it.each(['releaseClaim', 'endSession', 'removeHarness'] as const)('retries a failure at %s without losing evidence or root ownership', async stage => {
  const { owned, ports } = await fixture();
  vi.mocked(ports[stage]).mockRejectedValueOnce(new Error(`failure at ${stage}`));
  await expect(cleanupReuseFixture(owned, ports)).rejects.toThrow(`failure at ${stage}`);
  expect((await lstat(owned.root)).isDirectory()).toBe(true);
  await cleanupReuseFixture(owned, ports);
  await expect(lstat(owned.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleans a partially prepared root with no registered session, claim or harness', async () => {
  const owned = await createReuseFixture('w', 'o'); fixtures.push(owned);
  const { ports } = await fixture();
  await cleanupReuseFixture(owned, ports);
  expect(ports.readSession).not.toHaveBeenCalled();
  expect(ports.readClaim).not.toHaveBeenCalled();
  expect(ports.removeHarness).not.toHaveBeenCalled();
});

it('rejects a replaced runtime symlink and preserves the sibling directory', async () => {
  const { owned, ports } = await fixture();
  await rename(owned.root, owned.root + '-moved');
  await symlink(owned.root + '-moved', owned.root);
  await expect(cleanupReuseFixture(owned, ports)).rejects.toThrow('runtime root changed');
  expect((await lstat(owned.root + '-moved')).isDirectory()).toBe(true);
  expect(ports.releaseClaim).not.toHaveBeenCalled();
});

it('resumes interrupted filesystem retirement from the retained journal', async () => {
  const owned = await createReuseFixture('w', 'o'); fixtures.push(owned);
  const path = join(owned.evidenceRoot, 'lifecycle.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...journal, retiring: true }));
  await rename(owned.root, join(owned.evidenceRoot, 'retired-runtime'));
  const { ports } = await fixture();
  await cleanupReuseFixture(owned, ports);
  expect(JSON.parse(await readFile(path, 'utf8')).cleaned).toBe(true);
  expect(ports.readSession).not.toHaveBeenCalled();
});
