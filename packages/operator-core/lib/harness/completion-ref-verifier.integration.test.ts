import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const fixture = vi.hoisted(() => ({ getPg: (): unknown => { throw new Error('PG fixture not ready'); } }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => fixture.getPg(),
}));

import {
  runCompletionRefVerifierOnce, verifyHarnessFeatures,
  type CompletionRef, type GitLsRemoteResult, type RunGitLsRemote,
} from './completion-ref-verifier';

let db: FreshPgDb;
let harness: string;
const original: CompletionRef = { remote: 'fixture://old', branch: 'main', commit_sha: 'a'.repeat(40) };
const outcomes: GitLsRemoteResult[] = [
  { kind: 'found', sha: original.commit_sha }, { kind: 'not_found' }, { kind: 'error', reason: 'fixture network error' },
];
const replacements = [
  { name: 'commit', ref: { ...original, commit_sha: 'b'.repeat(40) } },
  { name: 'remote with the same commit', ref: { ...original, remote: 'fixture://replacement' } },
  { name: 'branch with the same commit', ref: { ...original, branch: 'replacement' } },
  { name: 'removed ref', ref: null },
];

beforeAll(async () => {
  db = await createFreshPgDb('completion_ref_generation');
  fixture.getPg = () => ({ sql: db.sql });
  await db.sql.unsafe(`CREATE TABLE harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, status text NOT NULL,
    completion_ref jsonb, updated_ts bigint, verified_done_at_remote_ts timestamptz,
    verifier_last_error text, verifier_last_checked_at timestamptz,
    PRIMARY KEY (harness_slug, feature_id)
  )`);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.harness_features_consolidated`;
  harness = `ref-${randomUUID()}`;
  await db.sql`INSERT INTO harness_shared.harness_features_consolidated
    (harness_slug, feature_id, status, completion_ref)
    VALUES (${harness}, 'F-1', 'pending_done', ${db.sql.json(original)})`;
});

async function row() {
  return (await db.sql`SELECT completion_ref, verified_done_at_remote_ts,
    verifier_last_error, verifier_last_checked_at
    FROM harness_shared.harness_features_consolidated WHERE harness_slug=${harness}`)[0];
}

for (const caller of ['one-shot', 'periodic'] as const) {
  const run = (runner: RunGitLsRemote) => caller === 'one-shot'
    ? verifyHarnessFeatures(harness, { runGitLsRemote: runner })
    : runCompletionRefVerifierOnce(runner);

  describe(`${caller} completion-ref generation fencing`, () => {
    for (const outcome of outcomes) {
      it.each(replacements)(`does not apply ${outcome.kind} to $name`, async replacement => {
        let entered!: () => void;
        let release!: () => void;
        const pendingRemote = new Promise<void>(resolve => { entered = resolve; });
        const remoteReply = new Promise<void>(resolve => { release = resolve; });
        const runner: RunGitLsRemote = async (remote, sha) => {
          expect([remote, sha]).toEqual([original.remote, original.commit_sha]);
          entered();
          await remoteReply;
          return outcome;
        };
        const pending = run(runner);
        try {
          await pendingRemote;
          await db.sql`UPDATE harness_shared.harness_features_consolidated
            SET completion_ref=${replacement.ref ? db.sql.json(replacement.ref) : null},
                verifier_last_error='replacement-marker',
                verifier_last_checked_at='2020-01-01T00:00:00Z'
            WHERE harness_slug=${harness} AND feature_id='F-1'`;
        } finally { release(); }
        const result = await pending;
        expect(await row()).toEqual({
          completion_ref: replacement.ref, verified_done_at_remote_ts: null,
          verifier_last_error: 'replacement-marker',
          verifier_last_checked_at: new Date('2020-01-01T00:00:00Z'),
        });
        if (result) expect(result).toMatchObject({ checked: 1, verified: 0, divergent: 0, errors: 0 });
      });

      it(`applies ${outcome.kind} when the observed ref is unchanged`, async () => {
        await run(async () => outcome);
        const observed = await row();
        expect(observed.verifier_last_checked_at).toBeInstanceOf(Date);
        expect(observed.verifier_last_error).toBe(outcome.kind === 'not_found' ? 'sha_not_found' : null);
        expect(observed.verified_done_at_remote_ts instanceof Date).toBe(outcome.kind === 'found');
      });
    }
  });
}
