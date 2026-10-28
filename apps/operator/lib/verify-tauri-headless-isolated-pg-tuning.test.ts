/**
 * verify-tauri-headless-isolated-pg-tuning.test.ts — the RECURRENCE GUARD for WI-10004558.
 *
 * The bug: VERIFY_TAURI_ISOLATED_DB=1 booted its throwaway Postgres with no
 * extraPostgresSettings, so it ran on stock max_connections=100. The operator it
 * served sizes its org pools from the host-derived ceiling (connection.ts
 * boundedOrgPoolMax over resource-profile's maxConnections, 512 on the dev box),
 * which is also what the shipped desktop passes to ITS embedded Postgres
 * (apps/operator/bin/serve.ts). So the rig alone was undersized: one operator
 * restart with background workers on held 106/100 connections and every
 * blueprint call through the rig answered -32603 "remaining connection slots are
 * reserved" (P-014 c1 run 16), a failure the product cannot have.
 *
 * The fix: the boot script mirrors the product's CONNECTION knobs from the same
 * resource-profile derivation. This test RUNS the real generated boot script
 * (extracted from the shell heredoc) against a stub embedded-postgres-server that
 * records the options it receives, so it measures what the rig actually passes,
 * not how the source is spelled.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

const REPO = resolve(__dirname, '../../..');
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this guard at a historical copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? join(REPO, 'scripts/verify-tauri-headless.sh');
const RESOURCE_PROFILE_DIR = join(REPO, 'libs/generic/resource-profile');

/** The quoted `<<'PGBOOT'` heredoc the shell writes to $WORK/boot-isolated-pg.mjs. */
function extractBootScript(): string {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes("<<'PGBOOT'"));
  const end = lines.findIndex((l, i) => i > start && l === 'PGBOOT');
  if (start < 0 || end < 0) throw new Error('PGBOOT heredoc not found in verify-tauri-headless.sh');
  return lines.slice(start + 1, end).join('\n');
}

const STUB_SERVER = `
import { writeFileSync } from 'node:fs';
export async function startEmbeddedPostgresServer(opts) {
  const { onLog, ...rest } = opts;
  writeFileSync(process.env.STUB_PG_OPTS_OUT, JSON.stringify(rest));
  return { urls: { admin: 'postgres://stub-admin', app: 'postgres://stub-app' }, async stop() {} };
}
`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  opts: Record<string, unknown> | null;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the extracted boot script with a fake repo dir; SIGTERM it once it reports PG_READY. */
async function runBootScript(opts: { withResourceProfile: boolean }): Promise<RunResult> {
  const work = mkdtempSync(join(tmpdir(), 'vth-pg-tuning-'));
  tempDirs.push(work);
  const fakeRepo = join(work, 'repo');
  const serverDir = join(fakeRepo, 'libs/papercusp/packages/embedded-postgres-server/src');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(serverDir, 'index.js'), STUB_SERVER);
  writeFileSync(join(serverDir, 'package.json'), '{"type":"module"}');
  if (opts.withResourceProfile) {
    mkdirSync(join(fakeRepo, 'libs/generic'), { recursive: true });
    symlinkSync(RESOURCE_PROFILE_DIR, join(fakeRepo, 'libs/generic/resource-profile'));
  }
  const bootPath = join(work, 'boot-isolated-pg.mjs');
  writeFileSync(bootPath, extractBootScript());
  const optsOut = join(work, 'opts.json');

  const child = spawn(process.execPath, [bootPath], {
    env: {
      ...hermeticSpawnEnv(),
      ISOLATED_PG_REPO_DIR: fakeRepo,
      ISOLATED_PG_DATA_DIR: join(work, 'data'),
      ISOLATED_PG_SQL_DIR: join(work, 'sql'),
      STUB_PG_OPTS_OUT: optsOut,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutText = createTextCollector(child.stdout);
  const stderrText = createTextCollector(child.stderr);
  child.stdout.on('data', () => {
    if (stdoutText.peek().includes('PG_READY')) child.kill('SIGTERM');
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise<number | null>((res) => child.on('close', (c) => res(c)));
  clearTimeout(killer);
  let recorded: Record<string, unknown> | null = null;
  try {
    recorded = JSON.parse(readFileSync(optsOut, 'utf8'));
  } catch {
    recorded = null;
  }
  return { code, stdout: stdoutText.text(), stderr: stderrText.text(), opts: recorded };
}

async function productConnectionSettings(): Promise<Record<string, string>> {
  const profile = await import(pathToFileURL(join(RESOURCE_PROFILE_DIR, 'src/index.ts')).href);
  return profile.databaseTuningToSettings(
    profile.deriveDatabaseTuning(profile.detectResourceSignals({ embeddedPg: true })),
  );
}

describe('WI-10004558 — the isolated rig Postgres gets the product connection ceiling', () => {
  it('passes the same max_connections and superuser_reserved_connections the desktop derives', async () => {
    const run = await runBootScript({ withResourceProfile: true });
    expect(run.stderr).not.toContain('PG_FAILED');
    expect(run.stdout).toContain('PG_READY');
    const product = await productConnectionSettings();
    expect(run.opts?.extraPostgresSettings).toEqual({
      max_connections: product.max_connections,
      superuser_reserved_connections: product.superuser_reserved_connections,
    });
    expect(run.stdout).toContain(`PG_TUNING max_connections=${product.max_connections}`);
  }, 30_000);

  it('never sizes the rig below stock Postgres and never mirrors host-wide memory knobs', async () => {
    const run = await runBootScript({ withResourceProfile: true });
    const settings = run.opts?.extraPostgresSettings as Record<string, string> | undefined;
    expect(Number(settings?.max_connections)).toBeGreaterThanOrEqual(100);
    expect(settings).not.toHaveProperty('shared_buffers');
    expect(settings).not.toHaveProperty('effective_cache_size');
  }, 30_000);

  it('refuses to boot (not silently fall back to stock 100) when the derivation is unavailable', async () => {
    const run = await runBootScript({ withResourceProfile: false });
    expect(run.code).not.toBe(0);
    expect(run.stdout).not.toContain('PG_READY');
    expect(run.opts).toBeNull();
  }, 30_000);
});
