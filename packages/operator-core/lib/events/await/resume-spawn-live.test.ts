import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { createResumeSmokeProfile, resumeSmokeChildEnv, verifyResumeSmokeContinuation,
  retainResumeSmokeWitness, resumeSmokeExitCode, resumeSmokeFailureDetail, configureResumeSmokeOmpRoute,
  runResumeSmokeCommand }
  from '../../../../../apps/operator/scripts/resume-spawn-live';

describe('maintained real-client resume smoke isolation', () => {
  it.each(['claude', 'codex', 'omp'] as const)('%s copies private auth and excludes user settings/hooks', (agent) => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'resume-smoke-auth-control-'));
    const relative = agent === 'claude' ? ['.claude', '.credentials.json']
      : agent === 'codex' ? ['.codex', 'auth.json'] : ['.omp', 'agent', 'auth.json'];
    const source = join(sourceHome, ...relative);
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, '{"fixture":"auth-before"}');
    writeFileSync(join(source, '..', 'settings.json'), '{"hooks":"must-not-load"}');
    const profile = createResumeSmokeProfile(agent, sourceHome);
    try {
      const copied = join(profile.home, ...relative);
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(lstatSync(copied).mode & 0o777).toBe(0o600);
      expect(lstatSync(profile.home).mode & 0o777).toBe(0o700);
      expect(readFileSync(copied, 'utf8')).toBe(readFileSync(source, 'utf8'));
      writeFileSync(copied, '{"fixture":"auth-refreshed"}');
      expect(readFileSync(source, 'utf8')).toBe('{"fixture":"auth-before"}');
      expect(() => readFileSync(join(profile.clientHome, 'settings.json'))).toThrow();
      if (agent === 'claude') {
        writeFileSync(join(profile.clientHome, '.credentials.json'), '{"fixture":"client-refresh"}');
        expect(readFileSync(source, 'utf8')).toBe('{"fixture":"auth-before"}');
      }
    } finally {
      profile.cleanup();
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });

  it('does not leak the parent identity, control plane, or native homes into an acceptance child', () => {
    const parent = { PAPERCUSP_SID: 'parent-owner', PAPERCUSP_HARNESS_SLUG: 'parent-harness',
      PAPERCUSP_API_BEARER: 'fixture-parent-bearer', CODEX_HOME: '/parent-codex',
      CLAUDE_CONFIG_DIR: '/parent-claude', PI_CODING_AGENT_DIR: '/parent-omp', PATH: '/safe-bin' };
    const env = resumeSmokeChildEnv(parent, '/fixture-home', { CODEX_HOME: '/fixture-codex', PAPERCUSP_TURN_PROVENANCE_DIR: '/fixture-provenance' });
    expect(env).toMatchObject({ HOME: '/fixture-home', CODEX_HOME: '/fixture-codex', PAPERCUSP_SID: '', PATH: '/safe-bin' });
    expect(env.PAPERCUSP_HARNESS_SLUG).toBeUndefined();
    expect(env.PAPERCUSP_API_BEARER).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(parent.PAPERCUSP_SID).toBe('parent-owner');
  });

  it('requires an existing exact transcript prefix and a new wake record', () => {
    const before = '{"session":"exact"}\n{"text":"launch"}\n';
    const after = before + '{"text":"coord:send wake-rung ping"}\n';
    expect(verifyResumeSmokeContinuation(before, after, 'coord:send wake-rung ping')).toBe(true);
    expect(verifyResumeSmokeContinuation(before, before, 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation(before, '{"session":"wrong"}\n' + after, 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation(before, before + '{"text":"different turn"}\n', 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation('', after, 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation(after, after + '{"text":"other"}\n', 'coord:send wake-rung ping')).toBe(false);
  });

  it('decodes the exact multiline wake from new native records and rejects malformed appended data', () => {
    const before = '{"session":"exact"}\n';
    const wake = 'coord:send wake-rung ping\nReply with "AGAIN".';
    const after = before + JSON.stringify({ payload: { content: [{ text: wake }] } }) + '\n';
    expect(verifyResumeSmokeContinuation(before, after, wake)).toBe(true);
    expect(verifyResumeSmokeContinuation(before, before + wake, wake)).toBe(false);
  });

  it('fails required acceptance for a skipped client or an empty selection', () => {
    expect(resumeSmokeExitCode([{ status: 'pass' }, { status: 'skip' }], true)).toBe(1);
    expect(resumeSmokeExitCode([], true)).toBe(1);
    expect(resumeSmokeExitCode([{ status: 'fail' }], false)).toBe(1);
    expect(resumeSmokeExitCode([{ status: 'pass' }], true)).toBe(0);
  });

  it('reports stdout-only failures and redacts credential-shaped diagnostics', () => {
    expect(resumeSmokeFailureDetail({ stderr: '', stdout: 'provider refused this model' })).toBe('provider refused this model');
    const detail = resumeSmokeFailureDetail({ stderr: 'Bearer fixture-private-token', stdout: 'sk-ant-fixture-secret' });
    expect(detail).not.toContain('fixture-private-token');
    expect(detail).not.toContain('fixture-secret');
  });

  it('preserves a silent client exit separately from deadline termination', () => {
    const options = { cwd: process.cwd(), env: process.env, timeoutMs: 500 };
    const exit = runResumeSmokeCommand(process.execPath, ['-e', 'process.exit(7)'], options);
    expect(exit.code).toBe(7);
    expect(exit.timedOut).toBe(false);
    expect(exit.signal).toBeNull();
    expect(exit.errorCode).not.toBe('ETIMEDOUT');
    expect(resumeSmokeFailureDetail(exit)).toContain('Command failed');

    const timeout = runResumeSmokeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    expect(timeout.code).not.toBe(0);
    expect(timeout.timedOut).toBe(true);
    expect(timeout.errorCode).toBe('ETIMEDOUT');
    expect(timeout.signal).toBe('SIGTERM');
    expect(timeout.elapsedMs).toBeGreaterThanOrEqual(options.timeoutMs);
    expect(resumeSmokeFailureDetail(timeout)).toContain('deadline=500ms');
    expect(resumeSmokeFailureDetail(timeout)).toContain('ETIMEDOUT');
  });

  it('preserves external signal termination without misclassifying it as a timeout', () => {
    const result = runResumeSmokeCommand(process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
    expect(result.signal).toBe('SIGTERM');
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).not.toBe('ETIMEDOUT');
    expect(resumeSmokeFailureDetail(result)).toContain('signal=SIGTERM');
  });

  it('seeds current OMP SQLite credentials without user settings, sessions, or write-through state', () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'resume-smoke-omp-sqlite-'));
    const sourceDir = join(sourceHome, '.omp', 'agent');
    mkdirSync(sourceDir, { recursive: true });
    const source = new DatabaseSync(join(sourceDir, 'agent.db'));
    source.exec("CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, data TEXT); CREATE TABLE settings(secret TEXT); INSERT INTO auth_credentials VALUES(1,'fixture-provider','private-auth'); INSERT INTO settings VALUES('must-not-copy')");
    const profile = createResumeSmokeProfile('omp', sourceHome);
    const copied = new DatabaseSync(join(profile.clientHome, 'agent.db'));
    try {
      expect(copied.prepare('SELECT data FROM auth_credentials').get()?.data).toBe('private-auth');
      expect(copied.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get()).toBeUndefined();
      copied.exec("UPDATE auth_credentials SET data='private-refresh'");
      expect(source.prepare('SELECT data FROM auth_credentials').get()?.data).toBe('private-auth');
      expect(lstatSync(join(profile.clientHome, 'agent.db')).mode & 0o777).toBe(0o600);
    } finally { copied.close(); source.close(); profile.cleanup(); rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it('uses a private production registry for explicit OMP auto routing with only the smoke identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-smoke-omp-route-'));
    try {
      const args = configureResumeSmokeOmpRoute(dir, 'smoke-fixture', 'openai-codex/gpt-5-codex', 'auto');
      expect(args).toEqual(['--model', 'papercusp-gateway/gpt-5-codex']);
      const registry = readFileSync(join(dir, 'models.yml'), 'utf8');
      expect(registry).toContain('smoke-fixture');
      expect(registry).not.toContain('x-papercusp-account:');
      expect(() => configureResumeSmokeOmpRoute(dir, 'smoke-fixture', 'unknown/model', 'auto')).toThrow();
      expect(configureResumeSmokeOmpRoute(dir, 'smoke-fixture')).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains an exact private transcript pair and its wake witness independently of cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-smoke-witness-'));
    try {
      const before = '{"session":"exact"}\n';
      const after = before + '{"text":"unique-wake"}\n';
      const witness = retainResumeSmokeWitness(dir, 'codex', 'fixture-id', before, after, 'unique-wake');
      expect(witness.exactPrefixAndNewWake).toBe(true);
      expect(witness.beforeSha256).not.toBe(witness.afterSha256);
      expect(readFileSync(witness.beforePath, 'utf8')).toBe(before);
      expect(readFileSync(witness.afterPath, 'utf8')).toBe(after);
      expect(lstatSync(witness.afterPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
