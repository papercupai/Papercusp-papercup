/** P001 contributing evidence through the registered coordination-message reader.
 * Controlled private rows do not establish production delivery, authorization or sync.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import type { SearchSourceParams } from '@papercusp/search';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES } from './sources';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';

const query = 'zephyrcoordwitness';
const workspace = 'p001-coord-workspace';
const harness = 'p001-coord-harness';
const entityRef = 'coord_message:target';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const population = ['coord_message/lexical'];
const completed: string[] = [];
const receipts: unknown[] = [];
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('coord-message-source-freshness');
  await db.sql.unsafe(`CREATE TABLE harness_shared.coord_event_log (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, surface text NOT NULL,
    msg_id text NOT NULL, body jsonb NOT NULL, ts timestamptz NOT NULL,
    harness_slug text
  )`);
}, 60_000);

describe('P001 — coordination-message fields and changing reader scope', () => {
  it('binds canonical fields and tests candidate, partition, owner and time fences', async () => {
    const source = SEARCH_SOURCES.find(row => row.name === 'coord_message');
    expect(source).toBeDefined();
    expect(source!.embedding).toBeUndefined();
    const params = (filters: SearchSourceParams['filters'] = {}, scopeFilter: string | null = harness) => ({
      sql: db.sql, workspaceId: workspace, scopeFilter, query, limit: 20, filters,
    });
    const run = (filters: SearchSourceParams['filters'] = {}, scopeFilter: string | null = harness) =>
      source!.lexical(params(filters, scopeFilter));
    const seed = async (id: string, ws = workspace, h: string | null = harness, surface = 'messages') => {
      await db.sql`INSERT INTO harness_shared.coord_event_log
        (workspace_id,harness_slug,surface,msg_id,body,ts)
        VALUES (${ws},${h},${surface},${id},${db.sql.json({ from: 'author-A', kind: 'notify',
          summary: `${query} original summary`, body: 'original canonical body' })},
          '2026-01-15T12:00:00Z'::timestamptz)`;
    };
    await seed('target');
    await seed('foreign-workspace', `${workspace}-other`);
    await seed('other-harness', workspace, `${harness}-other`);
    await seed('other-surface', workspace, harness, 'intents');
    // Host-global default rows are intentionally eligible in the actual reader.
    await seed('host-global', 'default');
    await seed('unscoped', workspace, null);
    const canonical = async (filters: SearchSourceParams['filters'] = {}, scopeFilter: string | null = harness) => {
      const [raw] = await db.sql`SELECT *,xmin::text AS revision FROM harness_shared.coord_event_log
        WHERE workspace_id=${workspace} AND msg_id='target'`;
      const corpus = await db.sql`SELECT workspace_id,harness_slug,surface,msg_id,body,ts,xmin::text AS revision
        FROM harness_shared.coord_event_log ORDER BY msg_id`;
      return { raw,corpus,readAtMs: Date.now(),
        epoch: fingerprint({ workspace,harness: scopeFilter,filters }) };
    };
    async function capture(phase: string, expectedIds: string[], filters: SearchSourceParams['filters'] = {},
      scopeFilter: string | null = harness) {
      const requestStartedAtMs = Date.now();
      const before = await canonical(filters,scopeFilter);
      const rows = await run(filters,scopeFilter);
      const responseAtMs = Date.now();
      const after = await canonical(filters,scopeFilter);
      expect(after.corpus).toEqual(before.corpus);
      expect(after.epoch).toBe(before.epoch);
      expect(rows.map(row => row.row.source_id).sort()).toEqual([...expectedIds].sort());
      const returned = rows.find(row => row.row.source_id === 'target')?.row;
      const message = `${after.raw.body.summary} ${after.raw.body.body}`;
      const values = {
        excerpt: `[${after.raw.body.kind} from ${after.raw.body.from} ${after.raw.ts}] ${message}`,
        highlight: message.replace(query, `<mark>${query}</mark>`),
      };
      const observations = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(row => row.source === 'coord_message')
        .map(boundary => {
          const field = boundary.policy.fieldPath as keyof typeof values;
          const input = { returned: { entityRef,fieldPath: field,valueFingerprint: fingerprint(returned?.[field] ?? null) },
            indexed: null, canonical: { entityRef,fieldPath: field,valueFingerprint: fingerprint(values[field]),
              authority: boundary.policy.authority,authorityEpoch: after.epoch,
              sourceRevision: String(after.raw.revision),readAtMs: after.readAtMs },requestStartedAtMs,responseAtMs };
          const oracle = returned ? assertSearchFieldFreshness(boundary.policy,input) : null;
          if (oracle) {
            expect(returned![field], `${phase}/${field}`).toBe(values[field]);
            expect(oracle.status).toBe('unknown');
            expect(oracle.action).toBe('degrade');
            expect(oracle.reasons).toContain('index witness unavailable');
          }
          return { field,input,oracle };
        });
      expect(observations.map(row => row.field).sort()).toEqual(['excerpt','highlight']);
      receipts.push({ caseId: population[0],phase,before,after,rows,expectedIds,observations });
      return { after,rows,observations };
    }
    const initial = await capture('stored-fields-and-host-global-policy',['target','host-global']);
    await db.sql`UPDATE harness_shared.coord_event_log SET body=${db.sql.json({ from: 'author-A',kind: 'notify',
      summary: `${query} replacement summary`,body: 'replacement canonical body' })}
      WHERE workspace_id=${workspace} AND msg_id='target'`;
    const updated = await capture('body-changed-event-time-unchanged',['target','host-global']);
    expect(updated.after.raw.ts).toEqual(initial.after.raw.ts);
    expect(updated.after.raw.revision).not.toBe(initial.after.raw.revision);
    // A newly sampled envelope cannot make the previously returned value current.
    for (const observation of updated.observations) {
      const previous = initial.observations.find(row => row.field === observation.field)!;
      const input = { ...observation.input,returned: previous.input.returned };
      const boundary = PROSE_FIELD_FRESHNESS_BOUNDARIES.find(row => row.source === 'coord_message'
        && row.policy.fieldPath === observation.field)!;
      const oracle = assertSearchFieldFreshness(boundary.policy,input);
      expect(oracle.status).toBe('stale');
      expect(oracle.reasons).toContain('canonical: returned value differs');
      receipts.push({ caseId: population[0],phase: 'old-field-fresh-envelope-refused',field: observation.field,input,oracle });
    }
    await seed('added');
    await capture('candidate-added',['target','host-global','added']);
    await db.sql`DELETE FROM harness_shared.coord_event_log WHERE workspace_id=${workspace} AND msg_id='added'`;
    await capture('candidate-deleted',['target','host-global']);
    await capture('scope-filter-absent',['target','host-global','other-harness','unscoped'],{},null);
    await capture('different-harness',['other-harness'],{},`${harness}-other`);
    const ownerBefore = await capture('owner-A-visible',['target','host-global'],{ owners: ['author-A'] });
    await db.sql`UPDATE harness_shared.coord_event_log SET body=jsonb_set(body,'{from}','"author-B"'::jsonb)
      WHERE workspace_id=${workspace} AND msg_id='target'`;
    await capture('owner-A-after-change',['host-global'],{ owners: ['author-A'] });
    const ownerAfter = await capture('owner-B-after-change',['target'],{ owners: ['author-B'] });
    expect(ownerAfter.after.epoch).not.toBe(ownerBefore.after.epoch);
    await capture('since-inclusive',['target','host-global'],{ since: '2026-01-15T12:00:00Z' });
    await capture('since-after-event',[],{ since: '2026-01-15T12:00:00.001Z' });
    await capture('until-exclusive',[],{ until: '2026-01-15T12:00:00Z' });
    await capture('until-after-event',['target','host-global'],{ until: '2026-01-15T12:00:00.001Z' });
    await capture('explicit-session-refusal',[],{ sessionId: 'a-transcript-session' });
    completed.push(population[0]);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_COORD_MESSAGE_SOURCE_WITNESS_FILE) {
      const paths = ['packages/operator-core/lib/agent-tools/search/coord-message-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/sources.ts','packages/operator-core/lib/search/surface-registry.ts'];
      const pins = paths.map(path => ({ path,sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`,import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_COORD_MESSAGE_SOURCE_WITNESS_FILE,JSON.stringify({ schemaVersion: 1,
        population,completed,pins,receipts,limits: [
          'Minimal private PostgreSQL schema and controlled canonical changes; actual registered lexical SQL reader.',
          'Default-workspace messages are deliberately host-global; foreign non-default workspaces remain excluded.',
          'No production coordination authoring/delivery/sync, authentication, candidate completeness or index-version witness.',
          'Reader scope epoch is controlled fixture input, not a measured production authorization epoch.',
          'Matching values remain unknown without index evidence; copied old values fail canonical comparison.',
          'Other adapters, quality, budgets, runtime acceptance and shipment remain open.',
        ] },null,2));
    }
    expect([...completed].sort()).toEqual([...population].sort());
  } finally { await db?.cleanup(); }
});
