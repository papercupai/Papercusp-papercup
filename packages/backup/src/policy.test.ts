import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { diffPolicyIgnores, IGNORE_PATTERNS } from './policy';
import { configureBackup } from './config';
import { BACKUP_RETENTION_PIN, WorkspaceBackup } from './workspace-backup';
import type { Sql } from 'postgres';

/**
 * Covers the ignore-rule diff that applyGlobalPolicy relies on. The
 * unit cases pin the pure logic; the integration case drives the exact
 * `policy show` -> diff -> `policy set --remove-ignore/--add-ignore`
 * sequence applyGlobalPolicy builds, against the real kopia binary, to
 * prove a stale rule actually leaves the repo policy (not just PG).
 */

describe('diffPolicyIgnores (unit)', () => {
  it('marks entries no longer desired for removal', () => {
    const { toRemove } = diffPolicyIgnores(
      ['backups', 'old-excluded-path', 'node_modules'],
      ['backups', 'node_modules'],
    );
    expect(toRemove).toEqual(['old-excluded-path']);
  });

  it('removes nothing when the current policy is a subset of desired', () => {
    const { toRemove } = diffPolicyIgnores(['backups'], ['backups', 'node_modules', '.next']);
    expect(toRemove).toEqual([]);
  });

  it('removes nothing for a fresh repo (empty current policy)', () => {
    const { toAdd, toRemove } = diffPolicyIgnores([], ['backups', 'node_modules']);
    expect(toRemove).toEqual([]);
    expect(toAdd).toEqual(['backups', 'node_modules']);
  });

  it('never marks a still-desired recursion-guard rule for removal', () => {
    // `backups` is always in IGNORE_PATTERNS, hence always in `desired`.
    const { toRemove } = diffPolicyIgnores(['backups', 'stale'], [...IGNORE_PATTERNS]);
    expect(toRemove).toEqual(['stale']);
    expect(toRemove).not.toContain('backups');
  });

  it('toAdd always covers the full desired set (idempotent re-apply)', () => {
    const desired = ['backups', '.restored', 'node_modules'];
    const { toAdd } = diffPolicyIgnores(['backups'], desired);
    expect(toAdd).toEqual(desired);
  });
});

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

// Module-load probe: the round-trip describe drives the REAL kopia binary,
// which CI runners don't ship (WI-123: `spawn kopia ENOENT`). Genuinely skip
// there; run wherever kopia is installed (dev boxes, the local gate).
const kopiaAvailable = (() => {
  try {
    return spawnSync(KOPIA_BIN, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

function kopia(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(KOPIA_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => resolve({
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      code: code ?? -1,
    }));
  });
}

async function kopiaOk(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const r = await kopia(args, env);
  if (r.code !== 0) throw new Error(`kopia ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  return r.stdout;
}

async function readIgnores(env: NodeJS.ProcessEnv): Promise<string[]> {
  const raw = await kopiaOk(['policy', 'show', '--global', '--json'], env);
  const parsed = JSON.parse(raw) as { files?: { ignore?: string[] } };
  return parsed.files?.ignore ?? [];
}

/** Mirror applyGlobalPolicy's policy-set call: diff, then one `policy set`. */
async function applyIgnores(env: NodeJS.ProcessEnv, desired: string[]): Promise<void> {
  const { toAdd, toRemove } = diffPolicyIgnores(await readIgnores(env), desired);
  await kopiaOk(
    ['policy', 'set', '--global',
      ...toRemove.map((p) => `--remove-ignore=${p}`),
      ...toAdd.map((p) => `--add-ignore=${p}`)],
    env,
  );
}

describe.skipIf(!kopiaAvailable)('applyGlobalPolicy ignore round-trip (real kopia)', () => {
  let workspaceRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'backup-policy-'));
    const repoPath = join(workspaceRoot, 'backups', 'kopia-repo');
    await mkdir(repoPath, { recursive: true });
    env = {
      ...process.env,
      KOPIA_PASSWORD: 'policy-test-password',
      KOPIA_CONFIG_PATH: join(workspaceRoot, 'backups', 'repository.config'),
      KOPIA_LOG_DIR: join(workspaceRoot, 'backups', 'logs'),
      KOPIA_CACHE_DIRECTORY: join(workspaceRoot, 'backups', 'cache'),
    };
    await kopiaOk(['repository', 'create', 'filesystem', '--path', repoPath], env);
  }, 60_000);

  afterAll(async () => {
    try { await kopia(['repository', 'disconnect'], env); } catch { /* best effort */ }
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('keeps historical held bytes through aggressive expiry and permits expiry only after release', async () => {
    let holds = ['hold-on-a-different-workspace-in-the-dump'];
    configureBackup({ getSql: () => (() => Promise.resolve([])) as unknown as Sql,
      workspacesRoot: () => workspaceRoot, ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://test', source: 'test' }),
      withRetentionLease: async (fn) => fn(holds) });
    const backup = new WorkspaceBackup({ workspaceId: 'retention-test', workspaceRoot });
    await kopiaOk(['policy', 'set', '--global', '--keep-latest=1', '--keep-hourly=0', '--keep-daily=0',
      '--keep-weekly=0', '--keep-monthly=0', '--keep-annual=0', '--ignore-identical-snapshots=false'], env);
    const data = join(workspaceRoot, 'held-data');
    await mkdir(data);
    await writeFile(join(data, 'held.txt'), 'historical held body');
    const first = JSON.parse(await kopiaOk(['snapshot', 'create', data, '--json'], env)).rootEntry.obj as string;
    await kopiaOk(['snapshot', 'pin', '--add=operator-preserve', first], env);
    await (backup as any).pinForRetention(env);
    await writeFile(join(data, 'held.txt'), 'current body');
    const second = JSON.parse(await kopiaOk(['snapshot', 'create', `--pin=${BACKUP_RETENTION_PIN}`, data, '--json'], env)).rootEntry.obj as string;
    await (backup as any).expireWithRetentionLease(env);
    await kopiaOk(['snapshot', 'expire', '--all', '--delete'], env);
    const kept = JSON.parse(await kopiaOk(['snapshot', 'list', '--all', '--json'], env));
    expect(kept.map((r: { rootEntry: { obj: string } }) => r.rootEntry.obj)).toEqual(expect.arrayContaining([first, second]));
    const restored = join(workspaceRoot, 'held-restore');
    await kopiaOk(['snapshot', 'restore', first, restored], env);
    expect(await readFile(join(restored, 'held.txt'), 'utf8')).toBe('historical held body');
    // Release removes only Papercusp's pin, never an operator's independent pin.
    holds = [];
    await (backup as any).expireWithRetentionLease(env);
    expect(JSON.parse(await kopiaOk(['snapshot', 'list', '--all', '--json'], env)).map((r: { rootEntry: { obj: string } }) => r.rootEntry.obj))
      .toContain(first);
    await kopiaOk(['snapshot', 'pin', '--remove=operator-preserve', first], env);
    await kopiaOk(['snapshot', 'expire', '--all', '--delete'], env);
    const released = JSON.parse(await kopiaOk(['snapshot', 'list', '--all', '--json'], env));
    expect(released.map((r: { rootEntry: { obj: string } }) => r.rootEntry.obj)).not.toContain(first);
    expect(released.map((r: { rootEntry: { obj: string } }) => r.rootEntry.obj)).toContain(second);
  }, 60_000);

  it('adds the desired set, then drops a stale entry on the next apply', async () => {
    // First apply — simulate a user-added excludedPath 'stale-path'.
    const firstDesired = ['backups', 'node_modules', 'stale-path'];
    await applyIgnores(env, firstDesired);
    expect(await readIgnores(env)).toEqual(expect.arrayContaining(firstDesired));

    // Second apply — user removed 'stale-path'. It must actually leave
    // the kopia policy, not just the PG row. This is the regression the
    // add-only applyGlobalPolicy silently failed to make.
    const current = await readIgnores(env);
    expect(diffPolicyIgnores(current, ['backups', 'node_modules']).toRemove).toContain('stale-path');
    await applyIgnores(env, ['backups', 'node_modules']);

    const final = await readIgnores(env);
    expect(final).not.toContain('stale-path');
    expect(final).toContain('backups');
    expect(final).toContain('node_modules');
  }, 60_000);
});
