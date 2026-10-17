/**
 * resource-command-match — fast UNIT coverage for the PURE matcher
 * matchCommandToResources (the raw-Bash resource gate, P-026 / D-012 / D-013).
 *
 * The matcher decides whether a destructive shell command (a restart / migrate)
 * touches a registered resource, so the PreToolUse Bash hook can gate it. A wrong
 * or THROWING match would gate the wrong commands or crash the gate on bad data.
 * The pure-matcher cases previously lived only in resource-command-match.integration.test.ts
 * (behind the live-PG checkBashCommand suite, so they never ran on `test:affected`);
 * this file is the fast unit tier + the genuinely-uncovered branches (malformed
 * regex no-throw, multi-resource match, non-first pattern, null patterns).
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(),
  listResources: vi.fn(),
  readResourceQueue: vi.fn(),
}));

import { checkBashCommand, matchCommandToResources } from './resource-command-match';
import { listResources, readResourceQueue } from './su-lock-store';
import type { ResourceRegistryRow } from './su-lock-store';

const listResourcesM = vi.mocked(listResources);
const readResourceQueueM = vi.mocked(readResourceQueue);

const reg = (resource: string, patterns: string[] | null): ResourceRegistryRow => ({
  resource,
  description: '',
  rule_text: '',
  enforcement: 'checked',
  match_patterns: patterns as string[],
  max_holders: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matchCommandToResources — pure matcher (unit tier)', () => {
  const registry = [
    reg('dev-server', ['systemctl.*restart.*papercup', 'overmind.*restart']),
    reg('db-schema', ['psql.*-f']),
  ];

  it('matches a registered destructive command to its resource', () => {
    expect(
      matchCommandToResources('systemctl --user restart papercup-dev-api.service', registry).map((r) => r.resource),
    ).toEqual(['dev-server']);
    expect(matchCommandToResources('psql "$DATABASE_URL" -f 107.sql', registry).map((r) => r.resource)).toEqual([
      'db-schema',
    ]);
  });

  it('matches via a NON-FIRST pattern on a resource (every pattern is tried, not just [0])', () => {
    // dev-server's SECOND pattern (overmind.*restart) must still match.
    expect(matchCommandToResources('overmind restart web', registry).map((r) => r.resource)).toEqual(['dev-server']);
  });

  it('returns an unrelated command as no match', () => {
    expect(matchCommandToResources('ls -la && grep foo bar.txt', registry)).toEqual([]);
  });

  it('returns EVERY resource a command matches, in registry order (not just the first)', () => {
    const both = matchCommandToResources('psql -f x.sql; systemctl restart papercup', registry);
    expect(both.map((r) => r.resource)).toEqual(['dev-server', 'db-schema']);
  });

  it('a MALFORMED regex pattern never matches and never throws (corrupt registry data is inert)', () => {
    // '(' / '[unterminated' are invalid regex — new RegExp(...) throws; the matcher must swallow it,
    // so bad registry data can neither crash the Bash gate nor spuriously gate a command.
    const broken = reg('broken', ['(', '[unterminated']);
    expect(() => matchCommandToResources('anything at all', [broken])).not.toThrow();
    expect(matchCommandToResources('anything at all', [broken])).toEqual([]);
    // A resource with one BAD + one GOOD pattern still matches via the good one.
    const mixed = reg('mixed', ['(', 'deploy-cli']);
    expect(matchCommandToResources('npx tsx deploy-cli.ts --execute', [mixed]).map((r) => r.resource)).toEqual([
      'mixed',
    ]);
  });

  it('skips resources with empty or missing match_patterns', () => {
    expect(matchCommandToResources('anything', [reg('empty', [])])).toEqual([]);
    expect(matchCommandToResources('anything', [reg('nullish', null)])).toEqual([]);
  });
});

describe('checkBashCommand — transient Postgres connection resilience', () => {
  it('retries CONNECT_TIMEOUT on both registry and queue reads before returning a verdict', async () => {
    const registry = [reg('dev-server', ['systemctl.*restart.*papercup'])];
    const connectTimeout = () =>
      Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), { code: 'CONNECT_TIMEOUT' });

    listResourcesM
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(registry);
    readResourceQueueM
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce({ holders: [], draining: false });

    await expect(
      checkBashCommand({
        command: 'systemctl --user restart papercup-dev-api.service',
        coordinationDomain: 'dom',
        ownerId: 'me',
      }),
    ).resolves.toEqual({
      decision: 'allow',
      matched: [
        {
          resource: 'dev-server',
          enforcement: 'checked',
          exclusiveActive: false,
          exclusiveByOther: false,
          draining: false,
        },
      ],
    });
    expect(listResourcesM).toHaveBeenCalledTimes(2);
    expect(readResourceQueueM).toHaveBeenCalledTimes(2);
  });
});
