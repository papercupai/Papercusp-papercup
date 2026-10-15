import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import postgres from 'postgres';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';
import { runPhoneOpsAlert } from '../../../../infra/phone-app/phone-ops-alert.mjs';

const execFileAsync = promisify(execFile);
const backupCli = resolve(import.meta.dirname, '../../../../infra/phone-app/phone-db-backup.mjs');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no fixture port'));
        return;
      }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

it('reports and clears real Phone usage and backup faults across CLI and PostgreSQL boundaries', async () => {
  const work = await mkdtemp(join(tmpdir(), 'phone-ops-e2e-'));
  const server = await startEmbeddedPostgresServer({ dataDir: join(work, 'pg'),
    dbName: 'phone', port: await freePort(), onLog: () => {} });
  const sql = postgres(server.urls.admin, { max: 1, onnotice: () => {} });
  const archive = join(work, 'phone.dump');
  const env = { ...process.env, PHONE_APP_DATABASE_URL: server.urls.admin,
    PHONE_DATABASE_URL: '', DATABASE_URL: '', PHONE_CONFIG_DIR: work,
    PHONE_BACKUP_ARCHIVE: archive, PHONE_BACKUP_MAX_AGE_HOURS: '24' };
  const notices: Array<Record<string, string>> = [];
  const run = async (command: string, args: string[]) => {
    // The systemd readiness boundary is covered by the installer integration
    // suite. Exercise the usage and backup subprocesses against real PG here.
    if (args.includes('--status')) return { code: 0, stdout: JSON.stringify({ ok: true, alerts: [] }) };
    try {
      const result = await execFileAsync(command, args, { env, timeout: 30_000 });
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string };
      return { code: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '' };
    }
  };
  const notify = async (notice: Record<string, string>) => {
    notices.push(notice);
  };
  const check = (minute: number) => runPhoneOpsAlert({ env, run, notify,
    now: new Date(Date.UTC(2026, 9, 2, 10, minute)) });
  const now = Date.now();
  const policy = {
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 3_600_000).toISOString(),
    approvedBy: 'fixture-approver', approvalRef: 'fixture-approval',
    status: 'active', hardCapMicros: 1_000_000,
    rateSheet: { id: 'fixture-rates', currency: 'USD', sourceRefs: ['fixture-reference'],
      effectiveAt: new Date(now - 60_000).toISOString(), capturedAt: new Date(now - 60_000).toISOString() },
  };
  const account = { policy, spentMicros: 100_000, reservedMicros: 100_000 };
  try {
    await sql.unsafe('CREATE TABLE public.phone_calls (id text PRIMARY KEY, note text NOT NULL)');
    await sql.unsafe("INSERT INTO public.phone_calls VALUES ('call-1', 'restorable-row')");
    await sql.unsafe('CREATE TABLE public.phone_usage_accounts (owner_id text PRIMARY KEY, state jsonb NOT NULL)');
    await sql`INSERT INTO phone_usage_accounts (owner_id, state) VALUES (${'private-owner-id'}, ${sql.json(account)})`;
    await execFileAsync(process.execPath, [backupCli, 'backup', '--out', archive], { env, timeout: 60_000 });
    const original = await readFile(archive);
    expect(await check(0)).toMatchObject({ ok: true, conditions: [],
      publicPhoneVerified: false, liveProviderSpendVerified: false });
    expect(notices).toEqual([]);

    await sql`UPDATE phone_usage_accounts SET state = ${sql.json({ ...account, spentMicros: 950_000 })}`;
    const exhausted = await check(15);
    expect(exhausted).toMatchObject({ ok: false, conditions: ['usage:exhausted'], notificationsSent: 1 });
    expect(notices[0].title).toBe('Phone operations: usage exhausted');
    await writeFile(archive, Buffer.concat([original, Buffer.from('tamper')]));
    const corrupted = await check(30);
    expect(corrupted.conditions).toEqual(['backup:backup-integrity-unavailable', 'usage:exhausted']);
    expect(notices[1].title).toBe('Phone operations: backup backup-integrity-unavailable');
    expect(notices.map(notice => notice.body).join('\n')).not.toContain('private-owner-id');
    expect(notices.map(notice => notice.body).join('\n')).not.toContain(new URL(server.urls.admin).password);

    await writeFile(archive, original);
    await sql`UPDATE phone_usage_accounts SET state = ${sql.json(account)}`;
    const recovered = await check(45);
    expect(recovered).toMatchObject({ ok: true, conditions: [], notificationsSent: 2 });
    expect(notices.slice(2).map(notice => notice.title)).toEqual([
      'Phone operations: usage:exhausted recovered',
      'Phone operations: backup:backup-integrity-unavailable recovered',
    ]);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await server.stop().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);
