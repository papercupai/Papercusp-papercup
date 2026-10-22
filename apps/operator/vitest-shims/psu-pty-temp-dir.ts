/**
 * Integration-test isolation for the managed-pty host/discovery seam.
 *
 * Real hostThroughPty tests intentionally emit lifecycle rows, sockets, and
 * discovery metadata. Redirect both writer and reader before their modules are
 * evaluated so those rows cannot masquerade as live fleet evidence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Shared fake-child environment; tests opt into backend and launch behavior.
 * Discovery isolation alone does not isolate a caller's native transcripts,
 * kickoff receipt, normalized log, identity, or timing overrides. Keep those
 * out of fake hosts while leaving the test runner's own attribution untouched.
 */
export function hermeticEnv(
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nativeOrCredentialKeys = new Set([
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID',
    'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    // Backend-specific compaction switches must be opted into by each fixture.
    // A caller launched through Claude can otherwise contaminate Codex handoffs.
    'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT',
    // These children execute inline fixture programs. A caller's Node preload
    // would run unrelated code before their readiness banner and spend the
    // fixture's startup deadline. Explicit fixture overrides still win below.
    'NODE_OPTIONS', 'NODE_PATH',
  ]);
  const rest = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('PAPERCUSP_') && !nativeOrCredentialKeys.has(key)));
  const dir = source.PAPERCUSP_PSU_PTY_DIR ?? process.env.PAPERCUSP_PSU_PTY_DIR;
  if (!dir) throw new Error('PTY fixtures require an isolated discovery directory');
  return {
    ...rest,
    PAPERCUSP_PSU_PTY_DIR: dir,
    CODEX_HOME: join(dir, 'codex-home'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
    ...extra,
  };
}

if (!process.env.PAPERCUSP_PSU_PTY_DIR) {
  process.env.PAPERCUSP_PSU_PTY_DIR = mkdtempSync(join(tmpdir(), 'papercusp-psu-pty-itest-'));
  process.env.PAPERCUSP_PSU_PTY_DIR_AUTOCLEAN = '1';
}

if (process.env.PAPERCUSP_PSU_PTY_DIR_AUTOCLEAN === '1') {
  const isolatedDir = process.env.PAPERCUSP_PSU_PTY_DIR;
  afterAll(() => rmSync(isolatedDir, { recursive: true, force: true }));
}
