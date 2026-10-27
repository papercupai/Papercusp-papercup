import { expect, it, vi } from 'vitest';
import { forkBootstrapBody, launchTrackedFork, supportsTrackedFork } from '../scripts/psu-launcher.mjs';

const source = { agent: 'codex', id: 17, sessionId: 'parent-native', coordOwnerId: 'su-parent',
  cwd: '/project', workspaceId: 'workspace', planSlug: 'plan', pid: 1234, portId: 'parent-port',
  codexHome: '/parent-home', configDir: '/parent-config', ompThreadId: 'parent-omp' };
function bootstrap() {
  return { status: 'ok', agent: 'codex', sessionId: 18, nativeSessionId: 'child-native',
    codexHome: '/child-home', cwd: source.cwd, workspaceId: source.workspaceId, planSlug: source.planSlug,
    nativeFork: { advSessionId: source.id, nativeSessionId: source.sessionId, ownerId: source.coordOwnerId },
    envelopeEnv: { PAPERCUSP_SID: 'su-child', CODEX_HOME: '/child-home' } };
}

it('requests the recorded Codex parent under a fresh tracked child bootstrap', () => {
  expect(supportsTrackedFork(source)).toBe(true);
  const body = forkBootstrapBody(source, 'auto', null, 'su-child', { headless: true });
  expect(body).toMatchObject({ agent: 'codex', owner_id: 'su-child', account: 'auto',
    native_fork_source: { advSessionId: 17, nativeSessionId: 'parent-native' } });
  expect(body.launch_argv).toContain('--agent=codex');
  expect(body.launch_argv).toContain('--resume=parent-native');
});

it('resumes only the registered child and carries no parent runtime fields', async () => {
  const api = vi.fn().mockResolvedValue(bootstrap()), launchResume = vi.fn();
  await launchTrackedFork(source, { ownerId: 'su-child', headless: true }, undefined, null, { api, launchResume });
  const [child, options] = launchResume.mock.calls[0]!;
  expect(child).toMatchObject({ id: 18, sessionId: 'child-native', coordOwnerId: 'su-child', codexHome: '/child-home' });
  expect(options).toMatchObject({ fork: false, ownerId: 'su-child', headless: true });
  for (const field of ['pid', 'portId', 'configDir', 'ompThreadId']) expect(child).not.toHaveProperty(field);
  expect(source.sessionId).toBe('parent-native');
  expect(JSON.parse(api.mock.calls[0]![1].body).native_fork_source.advSessionId).toBe(17);
});

it.each(['missing-native', 'same-native', 'same-owner', 'wrong-parent', 'missing-home'])(
  'refuses %s bootstrap evidence without untracked fallback or process launch', async failure => {
    const res = bootstrap();
    if (failure === 'missing-native') res.nativeSessionId = '';
    if (failure === 'same-native') res.nativeSessionId = source.sessionId;
    if (failure === 'same-owner') res.envelopeEnv.PAPERCUSP_SID = source.coordOwnerId;
    if (failure === 'wrong-parent') res.nativeFork.advSessionId = 99;
    if (failure === 'missing-home') res.codexHome = '';
    const launchResume = vi.fn();
    await expect(launchTrackedFork(source, {}, undefined, null,
      { api: vi.fn().mockResolvedValue(res), launchResume })).rejects.toThrow('registered child identity / lineage');
    expect(launchResume).not.toHaveBeenCalled();
  });

it('fails closed on bootstrap failure even without a pre-pinned child', async () => {
  const launchResume = vi.fn();
  await expect(launchTrackedFork(source, {}, undefined, null,
    { api: vi.fn().mockRejectedValue(new Error('registration failed')), launchResume }))
    .rejects.toThrow('Tracked Codex fork bootstrap failed');
  expect(launchResume).not.toHaveBeenCalled();
});
