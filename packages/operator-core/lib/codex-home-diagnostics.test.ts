/**
 * WI-10005188: the CODEX_HOME diagnostics reader runs on operator request paths
 * (coord:orient, the agent dossier, GET /agent-config), so it must never block the
 * main thread on the filesystem. WI-10004754 measured a 10s D-state stall from a
 * single sync open on the same orient path.
 */
import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCodexHomeDiagnostics } from './codex-home-diagnostics';

const savedHomesDir = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-home-diagnostics-'));
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (savedHomesDir === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = savedHomesDir;
});

function home(sessionKey: string): string {
  const dir = join(root, `session-${sessionKey}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('readCodexHomeDiagnostics', () => {
  it('reports every file, the parsed diagnostics, and the NEWEST rollout by mtime', async () => {
    const dir = home('full');
    writeFileSync(join(dir, 'AGENTS.md'), 'A');
    writeFileSync(join(dir, 'config.toml'), '');
    writeFileSync(join(dir, 'hooks.json'), '{}');
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(
      join(dir, 'papercusp-diagnostics.json'),
      JSON.stringify({ lockEnforcement: 'hooks-configured', lockOwnerSid: 'su-x', lockGeneration: 3, junk: 1 }),
    );
    const older = join(dir, 'sessions', '2026', '06', '20');
    const newer = join(dir, 'sessions', '2026', '06', '21');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    const oldFile = join(older, 'rollout-2026-06-20T10-00-00-11111111-1111-1111-1111-111111111111.jsonl');
    const newFile = join(newer, 'rollout-2026-06-21T10-00-00-22222222-2222-2222-2222-222222222222.jsonl');
    writeFileSync(oldFile, '{}\n');
    writeFileSync(newFile, '{}\n');
    writeFileSync(join(newer, 'not-a-rollout.jsonl'), '{}\n');
    utimesSync(oldFile, new Date('2026-06-20T10:00:00Z'), new Date('2026-06-20T10:00:00Z'));
    utimesSync(newFile, new Date('2026-06-21T10:00:00Z'), new Date('2026-06-21T10:00:00Z'));

    const diag = await readCodexHomeDiagnostics('full');
    expect(diag).toMatchObject({
      codexHome: dir,
      exists: true,
      agentsExists: true,
      configExists: true,
      hooksExists: true,
      promptsExists: true,
      authExists: false,
      diagnosticsExists: true,
      latestRolloutId: '22222222-2222-2222-2222-222222222222',
      latestRolloutPath: newFile,
      error: null,
    });
    expect(diag.diagnostics).toEqual({
      lockEnforcement: 'hooks-configured',
      lockOwnerSid: 'su-x',
      lockGeneration: 3,
    });
    expect(diag.resumeCommand).toBe(`CODEX_HOME='${dir}' codex resume --last`);
  });

  it('reads an absent home as all-false with no error', async () => {
    const diag = await readCodexHomeDiagnostics('missing');
    expect(diag).toMatchObject({
      exists: false,
      agentsExists: false,
      hooksExists: false,
      diagnosticsExists: false,
      diagnostics: null,
      latestRolloutId: null,
      error: null,
    });
  });

  it('keeps the event loop turning while a file read is blocked', async () => {
    // A FIFO parks open(2) until a writer arrives: the same wait that kept the
    // operator main thread in D-state for 10s on this orient path (WI-10004754).
    // A synchronous reader never returns control here, so this test hangs instead.
    const dir = home('fifo');
    const fifo = join(dir, 'papercusp-diagnostics.json');
    execFileSync('mkfifo', [fifo]);
    let settled = false;
    const pending = readCodexHomeDiagnostics('fifo').then((d) => {
      settled = true;
      return d;
    });

    let turns = 0;
    await new Promise<void>((resolve) => {
      const spin = () => {
        turns += 1;
        if (turns >= 50) resolve();
        else setImmediate(spin);
      };
      setImmediate(spin);
    });
    expect(turns).toBe(50);
    expect(settled).toBe(false);

    const writer = await fsp.open(fifo, 'w');
    await writer.writeFile(JSON.stringify({ lockEnforcement: 'hooks-configured' }));
    await writer.close();
    const diag = await pending;
    expect(diag.diagnosticsExists).toBe(true);
    expect(diag.diagnostics?.lockEnforcement).toBe('hooks-configured');
  });

  it('has no synchronous filesystem read, and every request-path caller awaits it', () => {
    const reader = source('./codex-home-diagnostics.ts');
    // Asserts on code shape, not on words: the module's comments legitimately name
    // the sync APIs it avoids. A value import from 'node:fs' (only `import type`
    // is allowed) or any `…Sync(` call is the regression.
    expect(reader).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'node:fs'/m);
    expect(reader).not.toMatch(/\b\w+Sync\(/);
    expect(reader).toMatch(/from 'node:fs\/promises'/);

    for (const caller of [
      './agent-tools/coordination/tools/orient.ts',
      './adv-agent-detail.ts',
      './endpoint-route/routes/agent-config/index.ts',
    ]) {
      const text = source(caller);
      const calls = text.match(/[^\n]*\breadCodexHomeDiagnostics\(/g) ?? [];
      expect(calls.length, caller).toBeGreaterThan(0);
      for (const line of calls) expect(line, caller).toMatch(/\bawait readCodexHomeDiagnostics\($/);
    }
  });
});
