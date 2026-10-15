import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'read-routine-metadata.mjs');

// A fake `pg` resolved through the same createRequire anchor the VM uses. It records the connection
// string and query, and answers from FAKE_PG_ROWS (JSON) or fails with FAKE_PG_FAIL.
const FAKE_PG = `
const fs = require('node:fs');
class Client {
  constructor(o) { this.url = o.connectionString; }
  async connect() { if (process.env.FAKE_PG_FAIL) throw new Error(process.env.FAKE_PG_FAIL); }
  async query(sql, params) {
    fs.writeFileSync(process.env.FAKE_PG_LOG, JSON.stringify({ url: this.url, sql, params }));
    return { rows: JSON.parse(process.env.FAKE_PG_ROWS || '[]') };
  }
  async end() {}
}
module.exports = { Client };
`;

describe('vm/read-routine-metadata.mjs (fake pg)', () => {
  let root: string;
  const anchor = () => path.join(root, 'eps', 'x.js');
  const pgLog = () => JSON.parse(readFileSync(path.join(root, 'pg.log'), 'utf8'));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'read-routine-meta-'));
    mkdirSync(path.join(root, 'eps', 'node_modules', 'pg'), { recursive: true });
    writeFileSync(anchor(), '');
    writeFileSync(path.join(root, 'eps', 'node_modules', 'pg', 'index.js'), FAKE_PG);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', PAPERCUSP_PG_REQUIRE_FROM: anchor(), FAKE_PG_LOG: path.join(root, 'pg.log'), ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("prints the git-sync routine's worktree_divergence by default, on the given port", () => {
    const div = { since: 1, lastSeenAt: 2, localHead: 'a'.repeat(40), hiveSha: 'b'.repeat(40), paths: ['d055-conflict.txt'] };
    const r = run(['41234', 'hello-world-3-pot'], { FAKE_PG_ROWS: JSON.stringify([{ v: div }]) });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(
      `ROUTINE_META slug=hello-world-3-pot routine=git-sync key=worktree_divergence rows=1 value=${JSON.stringify(div)}`,
    );
    const q = pgLog();
    expect(q.url).toBe('postgres://harness_admin:harness_admin_pwd@127.0.0.1:41234/papercusp');
    expect(q.params).toEqual(['hello-world-3-pot', 'git-sync', 'worktree_divergence']);
    expect(q.sql).toMatch(/FROM harness_shared\.routines WHERE install_slug = \$1 AND name = \$2/);
  });

  it('keeps "row exists but key unset" (rows=1 value=null) distinct from "no row" (rows=0)', () => {
    expect(run(['5', 'pot'], { FAKE_PG_ROWS: '[{"v":null}]' }).out).toMatch(/rows=1 value=null$/m);
    expect(run(['5', 'pot'], { FAKE_PG_ROWS: '[]' }).out).toMatch(/rows=0 value=null$/m);
  });

  it('passes an explicit routine and key through', () => {
    const r = run(['5', 'pot', 'embed-backfill', 'last_drain'], { FAKE_PG_ROWS: '[{"v":"x"}]' });
    expect(r.out).toMatch(/routine=embed-backfill key=last_drain rows=1 value="x"/);
    expect(pgLog().params).toEqual(['pot', 'embed-backfill', 'last_drain']);
  });

  it('reports a connection failure as ROUTINE_META_ERROR with exit 1', () => {
    const r = run(['5', 'pot'], { FAKE_PG_FAIL: 'ECONNREFUSED 127.0.0.1:5' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ROUTINE_META_ERROR ECONNREFUSED 127\.0\.0\.1:5$/m);
  });

  it('refuses a missing or non-numeric port and a missing slug (exit 2)', () => {
    expect(run([]).code).toBe(2);
    expect(run(['abc', 'pot']).code).toBe(2);
    expect(run(['5']).code).toBe(2);
  });
});
