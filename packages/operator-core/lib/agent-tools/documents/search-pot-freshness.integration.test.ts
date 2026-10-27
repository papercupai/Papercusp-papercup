/** P001: actual pot dispatch, stored fields and server-owned presence transitions.
 * This fixture observes stored tuples; provider/index currentness stays unknown.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { upsertPrivacyRule } from '../../personal-vault/disclosure-ledger';
import './search';

const WS = 'p001-pot-dispatch-fixture';
const AGENT = 'su-p001-pot-dispatch-fixture';
const POT = 'p001-pot-eligible';
const FOREIGN = 'p001-pot-foreign';
const FIELDS = ['title', 'snippet', 'occurredAt', 'privacy'] as const;
const CASES = ['projected-fields', 'content-update', 'presence-transition', 'privacy-transition'] as const;
const protocolBytes = readFileSync(new URL('../../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-documents-freshness-protocol-20261025.json', import.meta.url));
const protocol = JSON.parse(protocolBytes.toString()) as {
  fields: Array<{ id: string; policy: SearchFieldFreshnessPolicy }>;
  sourcePins: Array<{ path: string; sha256: string }>;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => sha(JSON.stringify({ present: value !== undefined, value }));
const receipts: unknown[] = [];
const executed = new Set<string>();
let org: OrgTestDb;
let user: string;
let pins: Array<{ path: string; sha256: string }> = [];
const projected = lookupByMcpName('documents:search');
if (!projected) throw new Error('documents:search must be registered');

function context(): UnifiedToolContext {
  return { log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
    role: 'operator', runId: 'p001-pot-dispatch', workspaceId: WS, uiClientId: AGENT,
    isSuperuser: true, tx: org.adminSql, transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    principal: { kind: 'user', trust: 'verified', slug: user, workspaceId: WS, capabilities: new Set(['search:read']) } };
}

/** Fixture-only stored rows: this does not exercise production ingestion. */
async function seed(pot: string, version: number) {
  await org.adminSql`INSERT INTO harness_shared.documents
    (workspace_id, user_id, scope, pot_slug, source, kind, external_id, dedupe_key, title, text, occurred_at, participants)
    VALUES (${WS}, NULL, 'pot', ${pot}, 'chat', 'message', ${pot}, ${pot},
      ${`Cobalt pot version ${version}`}, ${`Cobalt pot body ${version}. ${'Cobalt pot sentence. '.repeat(pot === FOREIGN ? 100 : 40)}`},
      ${`2026-10-0${version}T12:00:00Z`}, ${['alice@example.test']}::text[])
    ON CONFLICT (workspace_id, pot_slug, source, dedupe_key) WHERE scope = 'pot'
    DO UPDATE SET title = EXCLUDED.title, text = EXCLUDED.text, occurred_at = EXCLUDED.occurred_at, updated_at = now()`;
}

async function canonical(pot: string) {
  const [row] = await org.adminSql<Array<{
    id: string; title: string; snippet: string; occurredAt: string; sourceRevision: string;
    authority: { presence: Array<{ pot_slug: string | null }>; rules: Array<{ level: string }> };
  }>>`SELECT d.id::text, d.title, left(d.text, 600) AS snippet, d.occurred_at::text AS "occurredAt",
    d.xmin::text AS "sourceRevision", jsonb_build_object(
      'presence', (SELECT coalesce(jsonb_agg(jsonb_build_object('pot_slug', p.pot_slug)), '[]'::jsonb)
        FROM harness_shared.coord_presence p WHERE p.workspace_id = ${WS} AND p.owner_id = ${AGENT}),
      'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
        FROM harness_shared.personal_privacy_rules r WHERE r.workspace_id = ${WS} AND r.user_id = ${user}::uuid)
    ) AS authority FROM harness_shared.documents d
    WHERE d.workspace_id = ${WS} AND d.scope = 'pot' AND d.pot_slug = ${pot}`;
  if (!row) throw new Error('canonical pot fixture missing');
  expect(row.authority.rules.length).toBeLessThanOrEqual(1);
  if (row.authority.rules.length) expect(row.authority.rules[0]!.level).toBe('participants');
  return { ...row, privacy: row.authority.rules.length ? { level: 'participants', readerSet: ['alice@example.test'] } : null,
    authorityEpoch: fingerprint({ workspace: WS, principal: user, agent: AGENT, authority: row.authority }), readAtMs: Date.now() };
}

async function capture(caseId: string, pot = POT, allowed = true) {
  const requestStartedAtMs = Date.now();
  const before = await canonical(pot);
  const result = await dispatchProjectedTool(projected!, 'documents:search',
    { query: 'cobalt pot', legs: ['pot'], limit: 10 }, context(), {});
  const responseAtMs = Date.now();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  const response = result.result?.structuredContent as {
    legs: { pot: { allowed: boolean; potSlug?: string; refusal?: string; results?: number } };
    results: Array<Record<string, unknown>>; restrictedResults?: number;
  };
  expect(response.legs.pot.allowed).toBe(allowed);
  const after = await canonical(pot);
  if (allowed) {
    expect(response.legs.pot.potSlug).toBe(pot);
    expect(response.legs.pot.results).toBe(1);
    expect(response.results.map(r => r.id)).toEqual([after.id]);
  } else {
    expect(response.legs.pot.refusal).toBe('no_pot_in_presence');
    expect(response.results).toEqual([]);
  }
  const fields = response.results.flatMap(returned => FIELDS.map(fieldPath => {
    expect(returned.scope).toBe('pot');
    expect(returned.potSlug).toBe(pot);
    const policy = protocol.fields.find(f => f.id === `papercusp/documents:search/pot/${fieldPath}`)!.policy;
    const input = { returned: { entityRef: String(returned.id), fieldPath, valueFingerprint: fingerprint(returned[fieldPath]) },
      indexed: null, canonical: { entityRef: after.id, fieldPath, valueFingerprint: fingerprint(after[fieldPath]),
        sourceRevision: after.sourceRevision, authority: policy.authority, authorityEpoch: after.authorityEpoch, readAtMs: after.readAtMs },
      requestStartedAtMs, responseAtMs };
    expect(input.returned.valueFingerprint).toBe(input.canonical.valueFingerprint);
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
    expect(oracle.reasons).toContain('index witness unavailable');
    return { fieldPath, input, oracle };
  }));
  const receipt = { caseId, requestStartedAtMs, responseAtMs, canonicalBefore: before, canonicalAfter: after, response, fields };
  receipts.push(receipt);
  return receipt;
}

beforeAll(async () => {
  expect(sha(protocolBytes)).toBe('675e29f75f2fe8325af2dd79b20adc6f6ec87d8def5ec8dfa646df4e32b81f57');
  const paths = [...protocol.sourcePins.map(p => p.path), 'libs/generic/tooldef/src/dispatch-projected.ts',
    'libs/generic/tooldef/src/dispatch-stack.ts', 'libs/generic/tooldef/src/define-tool.ts'];
  pins = paths.map(path => ({ path, sha256: sha(readFileSync(new URL(`../../../../../${path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_POT_FRESHNESS_WITNESS_FILE) {
    for (const pin of protocol.sourcePins) expect(pins.find(p => p.path === pin.path)!.sha256, pin.path).toBe(pin.sha256);
  }
  org = await createOrgTestDb();
  const [created] = await org.adminSql<Array<{ id: string }>>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'p001-pot-' + org.dbName}, 'P001 pot fixture') RETURNING id::text`;
  user = created!.id;
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
  await org.adminSql`INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, pot_slug) VALUES (${AGENT}, ${WS}, ${POT})`;
  await seed(POT, 1);
  await seed(FOREIGN, 2);
});

afterAll(async () => {
  const cleanup = await org?.cleanupWithResult();
  for (const pin of pins) expect(sha(readFileSync(new URL(`../../../../../${pin.path}`, import.meta.url))), pin.path).toBe(pin.sha256);
  if (process.env.PAPERCUSP_POT_FRESHNESS_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_POT_FRESHNESS_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, scope: 'isolated actual pot dispatch and stored reader', protocolSha256: sha(protocolBytes),
      testSha256: sha(readFileSync(new URL(import.meta.url))), sourcePins: pins, database: org?.dbName, cleanup,
      declared: CASES, executed: [...executed], unexecuted: CASES.filter(c => !executed.has(c)), qualifiedFieldClaims: 0,
      receipts, limits: ['fixture-only ingestion', 'candidate/provider revisions absent', 'lexical engine tracing unmeasured',
        'admin client injected: host authentication, RLS and full authority/runtime closure unmeasured',
        'sealed and other document legs unmeasured', 'oracle-input replay is not an enforcement bypass'] }, null, 2));
});

describe('P001 actual documents:search pot field projection', () => {
  it('compares projected pot fields against canonical SQL and excludes a competing foreign pot', async () => {
    await capture('projected-fields');
    executed.add('projected-fields');
  });
  it('observes an in-place pot update and rejects a retained old projected title in the oracle', async () => {
    const before = await capture('content-update-before');
    await seed(POT, 2);
    const after = await capture('content-update-after');
    expect(after.canonicalAfter.id).toBe(before.canonicalAfter.id);
    expect(after.canonicalAfter.sourceRevision).not.toBe(before.canonicalAfter.sourceRevision);
    const title = after.fields.find(f => f.fieldPath === 'title')!;
    const input = { ...title.input, returned: before.fields.find(f => f.fieldPath === 'title')!.input.returned };
    const policy = protocol.fields.find(f => f.id === 'papercusp/documents:search/pot/title')!.policy;
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'stale', action: 'degrade' });
    expect(oracle.reasons).toContain('canonical: returned value differs');
    receipts.push({ caseId: 'old-title-oracle-replay', input, oracle });
    executed.add('content-update');
  });
  it('switches results with server-owned presence and refuses the leg after presence removal', async () => {
    const before = await capture('presence-before');
    await org.adminSql`UPDATE harness_shared.coord_presence SET pot_slug = ${FOREIGN} WHERE owner_id = ${AGENT} AND workspace_id = ${WS}`;
    const switched = await capture('presence-switched', FOREIGN);
    expect(switched.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    expect((await canonical(POT)).sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    await org.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${AGENT} AND workspace_id = ${WS}`;
    const removed = await capture('presence-removed', POT, false);
    expect(removed.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(removed.canonicalAfter.authorityEpoch).not.toBe(switched.canonicalAfter.authorityEpoch);
    executed.add('presence-transition');
  });
  it('projects changed privacy without changing the stored pot document revision', async () => {
    const before = await capture('privacy-before');
    await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: 'chat',
      level: 'participants', actor: 'fixture-owner', authorityRef: null });
    const after = await capture('privacy-after');
    expect(after.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(after.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    expect(after.response.restrictedResults).toBe(1);
    executed.add('privacy-transition');
  });
});
