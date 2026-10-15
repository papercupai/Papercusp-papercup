/**
 * restore-historical-shipment.integration.test.ts — the historical-shipment witness
 * read (readHistoricalShipmentWitness) against the real migrated baseline schema.
 *
 * WI-10006248: the unit suite mocks the tagged-template SQL entirely, so it asserted
 * the durable-attestation predicate's TEXT while the `head` LATERAL never projected
 * the author_id / author_kind / created_at columns the predicate reads. Every live
 * call failed with `column head.author_id does not exist`, and the mocked tests stayed
 * green. This suite runs the production query, so a projection/predicate mismatch
 * fails here instead of on the operator.
 *
 * Proves: with substrate_outbox empty (pruned), the head revision plus its
 * author's local-origin status_changed->shipped plan event attests the shipment; a
 * different writer, a remote-origin event, or an event outside the head revision's
 * time window does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPlanContent } from './content-hash';
import { historicalShipmentRefusal, readHistoricalShipmentWitness } from './restore-historical-shipment';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-restore-ship-${RUN}`;
const MSG_PREFIX = `restore-ship-${RUN}-`;
const AUTHOR = `su-restore-author-${RUN}`;
const SHIPPED_AT_MS = Date.UTC(2026, 9, 3, 2, 39, 15);

const prior = '---\ntitle: Delivered\nstatus: awaiting-acceptance\n---\n\n## Work\nComplete.\n';
const shipped = prior.replace('status: awaiting-acceptance', 'status: shipped');

let fx: PlanPgFixture;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
}, 120_000);

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.coord_event_log WHERE msg_id LIKE ${MSG_PREFIX + '%'}`;
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await fx.dispose();
});

interface Seed {
  slug: string;
  event?: { writer: string; origin: 'local' | 'remote'; offsetMs?: number } | null;
}

async function seedRolledBackShipment({ slug, event = { writer: AUTHOR, origin: 'local' } }: Seed) {
  const { admin, workspaceId } = fx;
  await seedPlan(admin, workspaceId, HARNESS, slug, prior);
  // The rollback: a write restored the predecessor body with no revision row. (origin is
  // re-stamped by the federation write trigger on an admin write, so it is not seeded here.)
  await admin`
    UPDATE harness_shared.harness_plans SET version = 3, content_hash = ${hashPlanContent(prior)}
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  await admin`
    INSERT INTO harness_shared.plan_revisions
      (workspace_id, harness_slug, plan_slug, seq, content_snapshot, content_hash,
       author_kind, author_id, session_id, created_at)
    VALUES (${workspaceId}, ${HARNESS}, ${slug}, 1, ${prior}, ${hashPlanContent(prior)},
            'agent', ${AUTHOR}, ${'session-' + RUN}, ${SHIPPED_AT_MS - 60_000})`;
  await admin`
    INSERT INTO harness_shared.plan_revisions
      (workspace_id, harness_slug, plan_slug, seq, content_snapshot, content_hash,
       author_kind, author_id, session_id, created_at)
    VALUES (${workspaceId}, ${HARNESS}, ${slug}, 2, ${shipped}, ${hashPlanContent(shipped)},
            'agent', ${AUTHOR}, ${'session-' + RUN}, ${SHIPPED_AT_MS})`;
  if (event) {
    const body = {
      kind: 'plan_event', event: 'status_changed', before: 'awaiting-acceptance', after: 'shipped',
      plan_slug: slug, from: event.writer,
    };
    await admin`
      INSERT INTO harness_shared.coord_event_log
        (surface, writer_key, msg_id, body, ts, workspace_id, harness_slug, origin)
      VALUES ('plan-events', ${event.writer}, ${MSG_PREFIX + slug}, ${admin.json(body)},
              ${new Date(SHIPPED_AT_MS + (event.offsetMs ?? 400))}, ${workspaceId}, NULL, ${event.origin})`;
  }
}

const scope = () => ({ workspaceId: fx.workspaceId, harnessSlug: HARNESS });

describe('readHistoricalShipmentWitness (PG)', () => {
  it('attests a pruned-outbox shipment from the attributed head revision and its local shipped event', async () => {
    await seedRolledBackShipment({ slug: 'durable-pair' });
    const witness = await readHistoricalShipmentWitness(scope(), 'durable-pair');
    expect(witness).toMatchObject({
      version: 3, seq: 2, contentHash: hashPlanContent(prior),
      shippedHash: hashPlanContent(shipped), shippedBody: shipped, predecessorBody: prior,
      localShipmentCaptured: true,
    });
  });

  it('does not attest when the shipped event was written by someone other than the head author', async () => {
    await seedRolledBackShipment({ slug: 'other-writer', event: { writer: `su-someone-else-${RUN}`, origin: 'local' } });
    expect(await readHistoricalShipmentWitness(scope(), 'other-writer')).toMatchObject({ localShipmentCaptured: false });
  });

  it('does not attest from a remote-origin shipped event', async () => {
    await seedRolledBackShipment({ slug: 'remote-event', event: { writer: AUTHOR, origin: 'remote' } });
    expect(await readHistoricalShipmentWitness(scope(), 'remote-event')).toMatchObject({ localShipmentCaptured: false });
  });

  it('does not attest from the head author shipping event of a different moment (outside the revision window)', async () => {
    await seedRolledBackShipment({ slug: 'other-moment', event: { writer: AUTHOR, origin: 'local', offsetMs: -3 * 86_400_000 } });
    expect(await readHistoricalShipmentWitness(scope(), 'other-moment')).toMatchObject({ localShipmentCaptured: false });
  });

  // WI-10006328: a plan already restored once has head = the restore revision, which
  // duplicates the shipped body. A REPEAT rollback reinstates the pre-shipment body, so the
  // predecessor must be the last revision whose hash differs from the head — not head.seq - 1
  // (itself shipped), which made historicalShipmentRefusal answer not_remote_rollback forever.
  async function seedRepeatRollback(slug: string, intermediate?: string) {
    const { admin, workspaceId } = fx;
    await seedRolledBackShipment({ slug });
    const RESTORED_AT_MS = SHIPPED_AT_MS + 2 * 3_600_000;
    let seq = 3;
    if (intermediate) {
      await admin`
        INSERT INTO harness_shared.plan_revisions
          (workspace_id, harness_slug, plan_slug, seq, content_snapshot, content_hash,
           author_kind, author_id, session_id, created_at)
        VALUES (${workspaceId}, ${HARNESS}, ${slug}, ${seq++}, ${intermediate}, ${hashPlanContent(intermediate)},
                'agent', ${AUTHOR}, ${'session-' + RUN}, ${RESTORED_AT_MS - 60_000})`;
    }
    await admin`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, content_snapshot, content_hash,
         author_kind, author_id, session_id, created_at)
      VALUES (${workspaceId}, ${HARNESS}, ${slug}, ${seq}, ${shipped}, ${hashPlanContent(shipped)},
              'agent', ${AUTHOR}, ${'session-' + RUN}, ${RESTORED_AT_MS})`;
    const body = {
      kind: 'plan_event', event: 'status_changed', before: 'awaiting-acceptance', after: 'shipped',
      plan_slug: slug, from: AUTHOR,
    };
    await admin`
      INSERT INTO harness_shared.coord_event_log
        (surface, writer_key, msg_id, body, ts, workspace_id, harness_slug, origin)
      VALUES ('plan-events', ${AUTHOR}, ${MSG_PREFIX + slug + '-restore'}, ${admin.json(body)},
              ${new Date(RESTORED_AT_MS + 400)}, ${workspaceId}, NULL, 'local')`;
    return seq;
  }

  it('reads the pre-shipment body as the predecessor after a repeat rollback of a restored shipment', async () => {
    const headSeq = await seedRepeatRollback('repeat-rollback');
    const witness = await readHistoricalShipmentWitness(scope(), 'repeat-rollback');
    expect(witness).toMatchObject({
      seq: headSeq, contentHash: hashPlanContent(prior), shippedBody: shipped,
      predecessorBody: prior, localShipmentCaptured: true,
    });
    expect(witness!.predecessorBody).not.toBe(witness!.shippedBody);
    // origin is re-stamped local on an admin write (see seedRolledBackShipment), and the
    // rubric row is not seeded here: supply those two so the verdict isolates the predecessor.
    expect(historicalShipmentRefusal({ ...witness!, origin: 'remote', rubricRetiredWithShipment: true }, {
      slug: 'repeat-rollback', expectedCurrent: 'awaiting-acceptance', seq: headSeq,
      contentHash: hashPlanContent(shipped), expectedVersion: 3, expectedContentHash: hashPlanContent(prior),
    })).toBeNull();
  });

  it('still refuses when the current body is not the last pre-shipment body', async () => {
    // An authored intermediate revision sits between the original shipment and the restore,
    // so the reinstated `prior` body is NOT the last pre-shipment body and is not a rollback
    // of the head's shipment.
    const intermediate = prior.replace('Complete.', 'Complete, with a later authored edit.');
    await seedRepeatRollback('repeat-rollback-stale-body', intermediate);
    const witness = await readHistoricalShipmentWitness(scope(), 'repeat-rollback-stale-body');
    expect(witness).toMatchObject({ contentHash: hashPlanContent(prior), predecessorBody: intermediate });
    expect(witness!.content).not.toBe(witness!.predecessorBody);
    expect(historicalShipmentRefusal({ ...witness!, origin: 'remote', rubricRetiredWithShipment: true }, {
      slug: 'repeat-rollback-stale-body', expectedCurrent: 'awaiting-acceptance', seq: witness!.seq,
      contentHash: hashPlanContent(shipped), expectedVersion: 3, expectedContentHash: hashPlanContent(prior),
    })).toBe('historical_shipment_not_remote_rollback');
  });
});
