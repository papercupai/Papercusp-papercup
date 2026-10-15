/**
 * Real libpq/Postgres TLS boundary for SPEC-P-004. The Cloud SQL observation in
 * docs/evidence/p004-tls-probe-2026-10-14T0906Z.json calibrates this local cluster's
 * pg_hba refusal and password-authentication control. This suite proves the
 * instrument's integration path; the separately bound live probe proves production.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNativePgBinDir, startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { judgeTlsProbe, TLS_PROBE_DONE } from './provision-cloud-sql';

const run = promisify(execFile);
const password = randomBytes(24).toString('hex');
let pg: DedicatedNativePg;
let admin: Sql;
let certificates: string;
let originalHba: string;

beforeAll(async () => {
  certificates = await mkdtemp(join(tmpdir(), 'cloud-prod-tls-'));
  const key = join(certificates, 'server.key');
  const cert = join(certificates, 'server.crt');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert]);
  await chmod(key, 0o600);
  pg = await startDedicatedNativePg({ settings: {
    ssl: 'on', ssl_cert_file: cert, ssl_key_file: key,
    fsync: 'off', synchronous_commit: 'off', full_page_writes: 'off',
  } });
  admin = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE ROLE portal_owner LOGIN PASSWORD '${password}'`);
  await admin.unsafe('CREATE DATABASE portal OWNER portal_owner');
  originalHba = await readFile(join(pg.dataDir, 'pg_hba.conf'), 'utf8');
}, 120_000);

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await pg?.stop();
  if (certificates) await rm(certificates, { recursive: true, force: true });
});

async function connect(mode: 'disable' | 'require', suppliedPassword: string) {
  try {
    const { stdout } = await run(join(resolveNativePgBinDir(), 'psql'), [
      `host=127.0.0.1 port=${pg.port} dbname=portal user=portal_owner sslmode=${mode} connect_timeout=3`,
      '-X', '-tAc', 'SELECT 1',
    ], { timeout: 10_000, env: { ...process.env, PGPASSWORD: suppliedPassword } });
    return { rc: 0, msg: stdout.trim() };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { rc: failure.code, msg: failure.stderr.trim().replace(/\s*\n\s*/g, ' ') };
  }
}

async function setPlaintextPolicy(reject: boolean) {
  await writeFile(join(pg.dataDir, 'pg_hba.conf'), [
    `hostnossl portal portal_owner 127.0.0.1/32 ${reject ? 'reject' : 'scram-sha-256'}`,
    'hostssl portal portal_owner 127.0.0.1/32 scram-sha-256',
    originalHba,
  ].join('\n'));
  await admin`SELECT pg_reload_conf()`;
  // Reload is asynchronous. Observe the connection policy before judging it.
  for (let attempt = 0; attempt < 50; attempt++) {
    const plain = await connect('disable', password);
    if (reject ? /pg_hba.conf rejects connection/.test(plain.msg) : plain.rc === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Postgres did not load plaintext policy reject=${reject}`);
}

async function observe(suppliedPassword: string) {
  const plain = await connect('disable', suppliedPassword);
  const tls = await connect('require', 'deliberately-wrong-password');
  const serial = [
    `PCPROBE disable rc=${plain.rc} msg=${plain.msg}`,
    `PCPROBE require rc=${tls.rc} msg=${tls.msg}`,
    TLS_PROBE_DONE,
  ].join('\n');
  return { plain, tls, verdict: judgeTlsProbe(serial) };
}

describe('TLS boundary against real Postgres (SPEC-P-004)', () => {
  it('refuses plaintext before authentication while TLS reaches password authentication', async () => {
    await setPlaintextPolicy(true);
    const observation = await observe('deliberately-wrong-password');
    expect(observation.plain).toMatchObject({ rc: 2 });
    expect(observation.plain.msg).toMatch(/pg_hba.conf rejects connection.*no encryption/);
    expect(observation.tls.msg).toMatch(/password authentication failed/);
    expect(observation.verdict).toMatchObject({ ok: true, reasons: [] });
  });

  it('detects the counterexample when plaintext authenticates and executes a query', async () => {
    await setPlaintextPolicy(false);
    const observation = await observe(password);
    expect(observation.plain).toEqual({ rc: 0, msg: '1' });
    expect(observation.tls.msg).toMatch(/password authentication failed/);
    expect(observation.verdict.ok).toBe(false);
    expect(observation.verdict.reasons).toContain('a plaintext connection ran a query: 1');
  });
});
