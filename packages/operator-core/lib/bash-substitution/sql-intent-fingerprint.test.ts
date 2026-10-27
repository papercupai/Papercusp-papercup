import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanTextForSecrets } from '../sync/pot-git/secrets-guard';
import { fingerprintSqlIntent, fingerprintSqlIntents, SQL_INTENT_VERSION, type SqlIntentScope } from './sql-intent-fingerprint';

const scope: SqlIntentScope = { workspaceId: 'workspace-a', sourceBoundary: 'sql-invocations', epoch: '2026-10',
  key: new Uint8Array(32).fill(37) };
function supported(sql: string, override: Partial<SqlIntentScope> = {}) {
  const result = fingerprintSqlIntent(sql, { ...scope, ...override });
  expect(result.status).toBe('supported');
  if (result.status !== 'supported') throw new Error(result.reason);
  return result;
}

describe('versioned SQL intent fingerprints', () => {
  it('parameterizes entity/time substitutions and preserves semantic distinctions R1-CONTRACT', () => {
    const first = supported("SELECT id FROM jobs WHERE owner_id='agent-one' AND created_at>'2026-10-01' AND status='open' ORDER BY id DESC LIMIT 5");
    const equivalent = supported("-- formatting only\n select id from jobs where owner_id='agent-two' and created_at>'2026-10-24' and status='open' order by id desc limit 5;");
    expect(first.version).toBe(SQL_INTENT_VERSION);
    expect(first.fingerprint).toBe(equivalent.fingerprint);
    for (const changed of [
      "SELECT name FROM jobs WHERE owner_id='agent-one' AND created_at>'2026-10-01' AND status='open' ORDER BY id DESC LIMIT 5",
      "SELECT id FROM jobs WHERE owner_id='agent-one' AND created_at>'2026-10-01' AND status='closed' ORDER BY id DESC LIMIT 5",
      "SELECT id FROM jobs WHERE owner_id='agent-one' AND created_at>'2026-10-01' AND status='open' ORDER BY id ASC LIMIT 5",
      "SELECT id FROM jobs WHERE owner_id='agent-one' AND created_at>'2026-10-01' AND status='open' ORDER BY id DESC LIMIT 6",
      "SELECT id FROM tasks WHERE owner_id='agent-one' AND created_at>'2026-10-01' AND status='open' ORDER BY id DESC LIMIT 5",
    ]) expect(supported(changed).fingerprint).not.toBe(first.fingerprint);
  });

  it('retains JSON path meaning and separates broad family from exact identity OUTCOME-P-001', () => {
    const left = supported("SELECT payload->>'status' FROM jobs");
    const right = supported("SELECT payload->>'owner' FROM jobs");
    expect(left.fingerprint).not.toBe(right.fingerprint);
    expect(left.features.jsonPaths).not.toEqual(right.features.jsonPaths);
    const open = supported("SELECT id FROM jobs WHERE status='open'");
    const closed = supported("SELECT id FROM jobs WHERE status='closed'");
    expect(open.fingerprint).not.toBe(closed.fingerprint);
    expect(open.suggestedFamily).toBe(closed.suggestedFamily);
    expect(open.suggestedFamily).not.toBe(open.fingerprint);
  });

  it('covers CTEs, aggregates, grouping, joins, operators, quoted identifiers and offsets R1-CONTRACT', () => {
    expect(supported("WITH x AS (SELECT id FROM jobs WHERE owner_id='a') SELECT count(*) FROM x").fingerprint)
      .toBe(supported("WITH x AS (SELECT id FROM jobs WHERE owner_id='b') SELECT count(*) FROM x").fingerprint);
    const grouped = supported('SELECT status,count(*) FROM jobs GROUP BY status ORDER BY status LIMIT 10 OFFSET 0');
    expect(grouped.features).toMatchObject({ grouping: true, ordering: true });
    expect(grouped.features.limits).toEqual(['limit:integer', 'offset:integer']);
    expect(grouped.fingerprint).not.toBe(supported('SELECT status,sum(id) FROM jobs GROUP BY status ORDER BY status LIMIT 10 OFFSET 0').fingerprint);
    expect(grouped.fingerprint).not.toBe(supported('SELECT status,count(*) FROM jobs GROUP BY status ORDER BY status LIMIT 10 OFFSET 1').fingerprint);
    expect(supported('SELECT a.id FROM a LEFT JOIN b ON a.id=b.id').fingerprint)
      .not.toBe(supported('SELECT a.id FROM a INNER JOIN b ON a.id=b.id').fingerprint);
    expect(supported('SELECT "Id" FROM "Jobs"').fingerprint).not.toBe(supported('SELECT id FROM jobs').fingerprint);
    expect(supported("SELECT id FROM jobs WHERE id IN ('a','b')").fingerprint)
      .toBe(supported("SELECT id FROM jobs WHERE id IN ('c','d')").fingerprint);
    expect(supported("SELECT id FROM jobs WHERE id='a' OR owner_id='a'").fingerprint)
      .not.toBe(supported("SELECT id FROM jobs WHERE id='a' OR owner_id='b'").fingerprint);
  });

  it('drops credentials before any fingerprint and retains no private plaintext R1-CONTRACT', () => {
    const a = supported("SELECT payload->>'status' FROM private_jobs WHERE password='opaque-one' AND status='open'");
    const b = supported("SELECT payload->>'status' FROM private_jobs WHERE password='opaque-two' AND status='open'");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.secretValuesDropped).toBe(true);
    // Generate controlled provider-shaped credentials at runtime so no literal
    // credential assignment is published with this redaction fixture.
    const providerFixture = (character: string) => ['sk', character.repeat(32)].join('-');
    const secret = providerFixture('a');
    const c = supported(`SELECT '${secret}' AS data`);
    const d = supported(`SELECT '${providerFixture('b')}' AS data`);
    expect(c.secretValuesDropped).toBe(true);
    expect(d.secretValuesDropped).toBe(true);
    expect(c.fingerprint).toBe(d.fingerprint);
    const serialized = JSON.stringify([a, b, c]);
    for (const value of ['opaque-one', 'opaque-two', secret, 'private_jobs', 'open']) expect(serialized).not.toContain(value);
    expect(a.canonical).not.toContain('status');
    const opaque = 'opaque-credential-with-no-prefix';
    expect(supported(`SELECT '${opaque}'`, { knownSecrets: [opaque] }).secretValuesDropped).toBe(true);
    expect(supported("SELECT 'short'", { knownSecrets: ['short'] }).secretValuesDropped).toBe(true);
    expect(supported('SELECT \'{"password":"short"}\'::jsonb').fingerprint)
      .toBe(supported('SELECT \'{"password":"other"}\'::jsonb').fingerprint);
  });

  it('keeps controlled credential fixtures publishable R1-CONTRACT', () => {
    const file = new URL('./sql-intent-fingerprint.test.ts', import.meta.url);
    expect(scanTextForSecrets(file.pathname, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('domain separates source, workspace, key and epoch without leaking scope identity R1-CONTRACT', () => {
    const query = "SELECT id FROM private_jobs WHERE status='private-enum'";
    const base = supported(query);
    for (const override of [{ workspaceId: 'workspace-b' }, { sourceBoundary: 'native-source' },
      { epoch: '2026-11' }, { key: new Uint8Array(32).fill(38) }]) {
      const other = supported(query, override);
      expect(other.fingerprint).not.toBe(base.fingerprint);
      expect(other.canonical).not.toBe(base.canonical);
    }
    expect(JSON.stringify(base)).not.toContain(scope.workspaceId);
    expect(fingerprintSqlIntent(query, { ...scope, key: new Uint8Array(3) }))
      .toMatchObject({ status: 'unknown', reason: 'invalid-scope' });
  });

  it('records unknown residue rather than guessing equivalence or executing unsupported SQL R1-CONTRACT', () => {
    const inputs = [
      { sql: 'SELECT id FROM jobs' }, { sql: 'SELECT (' }, { sql: 'DELETE FROM jobs' },
      { sql: 'SELECT 1; SELECT 2' }, { sql: 'WITH x AS (DELETE FROM jobs RETURNING id) SELECT * FROM x' },
      { sql: 'SELECT * FROM jobs FOR UPDATE' }, { sql: "SELECT set_config('x','y',false)" },
      { sql: 'SELECT * FROM jobs', coverage: 'truncated' as const },
      { sql: 'SELECT * FROM jobs', coverage: 'unknown' as const },
    ];
    const result = fingerprintSqlIntents(inputs, scope);
    expect(result).toMatchObject({ supported: 1, unknown: 8 });
    expect(result.results.slice(1).every(r => r.status === 'unknown')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('DELETE FROM jobs');
  });
});
