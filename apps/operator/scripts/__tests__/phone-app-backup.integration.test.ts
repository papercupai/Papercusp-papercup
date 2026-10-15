import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import postgres from 'postgres';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';

const execFileAsync = promisify(execFile);
const script = resolve(import.meta.dirname, '../../../../infra/phone-app/phone-db-backup.mjs');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no fixture port')); return; }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

it('backs up Phone rows and restores them in an isolated database without replacing the recovery point', async () => {
  const work = await mkdtemp(join(tmpdir(), 'phone-db-backup-test-'));
  const server = await startEmbeddedPostgresServer({ dataDir: join(work, 'source-pg'),
    dbName: 'phone', port: await freePort(), onLog: () => {} });
  const sql = postgres(server.urls.admin, { max: 1, onnotice: () => {} });
  const archive = join(work, 'backup', 'phone.dump');
  const env = { ...process.env, PHONE_APP_DATABASE_URL: server.urls.admin,
    PHONE_DATABASE_URL: '', DATABASE_URL: '', PHONE_HOME: join(work, 'unused-home') };
  const run = (args: string[]) => execFileAsync(process.execPath, [script, ...args],
    { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
  try {
    await sql.unsafe('CREATE TABLE public.phone_calls (id text PRIMARY KEY, note text NOT NULL)');
    await sql.unsafe("INSERT INTO public.phone_calls VALUES ('call-1', 'restorable-row')");
    const backup = await run(['backup', '--out', archive]);
    expect(JSON.parse(backup.stdout)).toMatchObject({ ok: true, action: 'backup', archive });
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect((await stat(`${archive}.sha256`)).mode & 0o777).toBe(0o600);
    const original = await readFile(archive);
    const backupStatus = () => run(['backup-status', '--archive', archive, '--max-age-hours', '24']);
    expect(JSON.parse((await backupStatus()).stdout)).toMatchObject({
      ok: true, action: 'backup-status', alerts: [],
      scope: 'local-backup-integrity-and-freshness-only', restoreVerified: false,
    });
    await utimes(archive, new Date(Date.now() - 26 * 3_600_000), new Date(Date.now() - 26 * 3_600_000));
    await expect(backupStatus()).rejects.toMatchObject({
      stdout: expect.stringContaining('"condition":"backup-stale"'),
    });
    await utimes(archive, new Date(), new Date());
    expect(JSON.parse((await backupStatus()).stdout).ok).toBe(true);
    await chmod(archive, 0o644);
    await expect(backupStatus()).rejects.toMatchObject({
      stdout: expect.stringContaining('"condition":"backup-integrity-unavailable"'),
    });
    await chmod(archive, 0o600);
    await expect(run(['backup-status', '--archive', join(work, 'missing.dump'), '--max-age-hours', '24']))
      .rejects.toMatchObject({ stdout: expect.stringContaining('"condition":"backup-integrity-unavailable"') });
    await expect(run(['backup-status', '--archive', archive, '--max-age-hours', '0'])).rejects.toThrow();
    await expect(run(['backup', '--out', archive])).rejects.toThrow();
    expect(await readFile(archive)).toEqual(original);

    // The daily timer refreshes ONE fixed path (WI-10006587). Without --replace its
    // second run failed EEXIST forever and the archive aged into backup-stale.
    await sql.unsafe("INSERT INTO public.phone_calls VALUES ('call-2', 'second-backup')");
    const replaced = await run(['backup', '--out', archive, '--replace']);
    expect(JSON.parse(replaced.stdout)).toMatchObject({ ok: true, action: 'backup', archive, replaced: true });
    expect(await readFile(`${archive}.prev`)).toEqual(original);
    expect(await readFile(archive)).not.toEqual(original);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await backupStatus()).stdout).ok).toBe(true);
    const again = await run(['backup', '--out', archive, '--replace']);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, replaced: true });
    await expect(run(['backup', '--out', archive, '--bogus'])).rejects.toThrow();

    const drill = await run(['restore-drill', '--archive', archive]);
    expect(drill.stdout, `restore drill must emit its verification result; ${drill.stderr}`).not.toBe('');
    expect(JSON.parse(drill.stdout)).toMatchObject({ ok: true, action: 'restore-drill',
      tablesVerified: 1, nonEmptyTables: ['phone_calls'] });
    expect(backup.stdout + backup.stderr + drill.stdout + drill.stderr).not.toContain(new URL(server.urls.admin).password);

    await writeFile(archive, Buffer.concat([original, Buffer.from('tamper')]));
    await expect(backupStatus()).rejects.toMatchObject({
      stdout: expect.stringContaining('"condition":"backup-integrity-unavailable"'),
    });
    await expect(run(['restore-drill', '--archive', archive])).rejects.toThrow('digest mismatch');

    await sql.unsafe('DROP TABLE public.phone_calls');
    await expect(run(['backup', '--out', join(work, 'backup', 'wrong-db.dump')]))
      .rejects.toThrow('no Phone call ledger');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await server.stop().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);

it('emits actionable cost alerts from existing usage accounts without disclosing tenant or database credentials', async () => {
  const work = await mkdtemp(join(tmpdir(), 'phone-usage-status-test-'));
  const server = await startEmbeddedPostgresServer({ dataDir: join(work, 'source-pg'),
    dbName: 'phone', port: await freePort(), onLog: () => {} });
  const sql = postgres(server.urls.admin, { max: 1, onnotice: () => {} });
  const env = { ...process.env, PHONE_APP_DATABASE_URL: server.urls.admin,
    PHONE_DATABASE_URL: '', DATABASE_URL: '' };
  const check = async () => execFileAsync(process.execPath, [script, 'usage-status'], {
    env, timeout: 20_000,
  }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    error => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }));
  const now = Date.now();
  const policy = {
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 3_600_000).toISOString(),
    approvedBy: 'fixture-approver', approvalRef: 'fixture-approval',
    status: 'active', hardCapMicros: 1_000_000,
    rateSheet: { id: 'fixture-rates', currency: 'USD', sourceRefs: ['fixture-reference'],
      effectiveAt: new Date(now - 60_000).toISOString(), capturedAt: new Date(now - 60_000).toISOString() },
  };
  const account = { policy, spentMicros: 100_000, reservedMicros: 200_000 };
  try {
    const missingLedger = await check();
    expect(missingLedger.code).not.toBe(0);
    expect(JSON.parse(missingLedger.stdout).alerts[0].condition).toBe('usage-telemetry-unavailable');
    await sql.unsafe('CREATE TABLE public.phone_usage_accounts (owner_id text PRIMARY KEY, state jsonb NOT NULL)');
    await sql`INSERT INTO phone_usage_accounts (owner_id, state)
      VALUES (${'private-owner-id'}, ${sql.json(account)})`;
    const healthy = await check();
    expect(healthy.code, healthy.stdout + healthy.stderr).toBe(0);
    expect(JSON.parse(healthy.stdout)).toMatchObject({
      ok: true, action: 'usage-status', accountsChecked: 1,
      alerts: [], liveProviderSpendVerified: false,
    });
    for (const [state, expected] of [
      [{ ...account, policy: { ...policy, status: 'suspended' } }, 'suspended'],
      [{ ...account, spentMicros: 900_000 }, 'exhausted'],
      [{ ...account, policy: { ...policy, periodEnd: new Date(now - 1_000).toISOString() } }, 'expired'],
      [{ ...account, policy: null }, 'missingPolicy'],
      [{ ...account, spentMicros: 'invalid' }, 'malformed'],
      [{ ...account, policy: { ...policy, approvedBy: {} } }, 'malformed'],
      [{ ...account, policy: { ...policy, approvalRef: {} } }, 'malformed'],
      [{ ...account, policy: { ...policy, rateSheet: { ...policy.rateSheet, sourceRefs: 'x' } } }, 'malformed'],
      [{ ...account, policy: { ...policy, rateSheet: { ...policy.rateSheet, sourceRefs: [{}] } } }, 'malformed'],
      [{ ...account, policy: { ...policy, rateSheet: { ...policy.rateSheet, id: [] } } }, 'malformed'],
    ] as const) {
      await sql`UPDATE phone_usage_accounts SET state = ${sql.json(state)}`;
      const report = await check();
      expect(report.code, report.stdout).not.toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({
        ok: false, alerts: expect.arrayContaining([{
          condition: expected, count: 1, owner: 'phone-operations',
          action: expect.any(String),
        }]),
      });
      expect(report.stdout + report.stderr).not.toContain('private-owner-id');
      expect(report.stdout + report.stderr).not.toContain(new URL(server.urls.admin).password);
    }
    // A readable ledger with no account still fails closed, but must not claim
    // telemetry loss (WI-10006811): the table exists and was read.
    await sql.unsafe('DELETE FROM phone_usage_accounts');
    const emptyLedger = await check();
    expect(emptyLedger.code).not.toBe(0);
    expect(JSON.parse(emptyLedger.stdout)).toMatchObject({
      ok: false, accountsChecked: 0,
      alerts: [{ condition: 'usage-account-missing', owner: 'phone-operations', action: expect.any(String) }],
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await server.stop().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
