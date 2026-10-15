import { afterEach, describe, expect, it, vi } from 'vitest';
import * as db from '@papercusp/db-org';
import * as locks from './with-plan-lock';
import * as revisions from './revisions';
import * as source from './source';
import * as events from '../coordination/plan-events';
import { hashPlanContent } from './content-hash';
import { historicalShipmentRefusal, restoreHistoricalShipment, type HistoricalShipmentWitness } from './restore-historical-shipment';
import tool from './set-plan-status';

const prior = '---\ntitle: Delivered\nstatus: awaiting-acceptance\n---\n\n## Work\nComplete.\n';
const shipped = prior.replace('status: awaiting-acceptance', 'status: shipped');
const request = {
  slug: 'delivered', harnessSlug: 'papercusp', expectedCurrent: 'awaiting-acceptance', seq: 17,
  contentHash: hashPlanContent(shipped), expectedVersion: 18, expectedContentHash: hashPlanContent(prior),
};
const witness: HistoricalShipmentWitness = {
  version: 18, content: prior, contentHash: hashPlanContent(prior), origin: 'remote', seq: 17,
  shippedBody: shipped, shippedHash: hashPlanContent(shipped), predecessorBody: prior,
  localShipmentCaptured: true, rubricRetiredWithShipment: true,
};

afterEach(() => vi.restoreAllMocks());

function transactionalRig(
  concurrentVersion = request.expectedVersion,
  proof: { outbox: boolean; durable: boolean } = { outbox: true, durable: false },
) {
  const scope = { workspaceId: 'ws', harnessSlug: 'papercusp' };
  const read = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => [{
    version: witness.version, content: witness.content, content_hash: witness.contentHash, origin: witness.origin,
    seq: witness.seq, shipped_body: witness.shippedBody, shipped_hash: witness.shippedHash,
    predecessor_body: witness.predecessorBody, local_shipment_captured: proof.outbox,
    durable_shipment_attested: proof.durable, rubric_retired_with_shipment: true,
  }]);
  vi.spyOn(db, 'withWorkspace').mockImplementation(async (_ws, callback) => callback(read as never));
  vi.spyOn(source, 'resolvePlanScope').mockResolvedValue(scope);
  const receipt = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => []);
  const revision = vi.fn(async () => undefined);
  const emitted = vi.spyOn(events, 'emitPlanEventForCaller').mockResolvedValue(null);
  vi.spyOn(revisions, 'planRevisionCapture').mockReturnValue({
    afterWrite: async () => undefined, inTransaction: revision, recorded: { current: null },
  });
  const writes: string[] = [];
  const lock: typeof locks.withPlanLock = async (_ctx, opts, mutate) => {
    const outcome = await mutate(witness.content, {
      version: concurrentVersion, contentHash: witness.contentHash, opStatus: null, planStatus: null,
      templateData: null, inputSchema: null, outputSchema: null, nowNote: null,
      latestRevision: { seq: witness.seq, body: witness.shippedBody },
    }, scope);
    if (outcome.newBody !== null) {
      await opts.inTransaction?.(receipt as never, outcome.newBody, scope, outcome.value);
      await opts.revisionInTransaction?.(receipt as never, outcome.newBody, scope, null, 19);
      writes.push(outcome.newBody);
    }
    return { kind: 'applied', value: outcome.value, version: writes.length ? 19 : concurrentVersion,
      scope, filePath: 'plan:delivered' };
  };
  vi.spyOn(locks, 'withPlanLock').mockImplementation(lock);
  return { writes, receipt, revision, emitted, read };
}

describe('transactional historical shipment recovery', () => {
  it('writes exact historical bytes and couples its receipt and revision before emitting', async () => {
    const rig = transactionalRig();
    expect(await restoreHistoricalShipment({}, request)).toMatchObject({
      ok: true, restoredShippedRevision: 17, restoredContentHash: request.contentHash, version: 19,
    });
    expect(rig.writes).toEqual([shipped]);
    expect(rig.receipt).toHaveBeenCalledOnce();
    expect(rig.receipt.mock.calls[0]?.[0].join('')).toContain('plan_shipment_acceptance_gate_receipt');
    expect(rig.revision).toHaveBeenCalledOnce();
    expect(rig.emitted).toHaveBeenCalledOnce();
  });

  it('writes no bytes, receipt, revision or event after a concurrent version change', async () => {
    const rig = transactionalRig(19);
    expect(await restoreHistoricalShipment({}, request)).toMatchObject({ ok: false, code: 'historical_shipment_stale' });
    expect(rig.writes).toEqual([]);
    expect(rig.receipt).not.toHaveBeenCalled();
    expect(rig.revision).not.toHaveBeenCalled();
    expect(rig.emitted).not.toHaveBeenCalled();
  });

  // WI-10006248: substrate_outbox is pruned within hours, so a rollback noticed days
  // later has no outbox capture. The durable attributed-revision + local-event pair
  // must carry the proof on its own, and neither proof may be optional.
  it('restores on the durable shipment attestation once the outbox capture has been pruned', async () => {
    const rig = transactionalRig(request.expectedVersion, { outbox: false, durable: true });
    expect(await restoreHistoricalShipment({}, request)).toMatchObject({ ok: true, restoredShippedRevision: 17 });
    expect(rig.writes).toEqual([shipped]);
    expect(rig.emitted).toHaveBeenCalledOnce();
  });

  it('refuses with no outbox capture and no durable attestation, writing nothing', async () => {
    const rig = transactionalRig(request.expectedVersion, { outbox: false, durable: false });
    expect(await restoreHistoricalShipment({}, request))
      .toMatchObject({ ok: false, code: 'historical_shipment_proof_missing' });
    expect(rig.writes).toEqual([]);
    expect(rig.receipt).not.toHaveBeenCalled();
    expect(rig.emitted).not.toHaveBeenCalled();
  });

  it('binds the durable attestation to the head revision author and a local shipped event', async () => {
    const rig = transactionalRig();
    await restoreHistoricalShipment({}, request);
    const sql = (rig.read.mock.calls[0]?.[0] ?? []).join('?').replace(/\s+/g, ' ');
    expect(sql).toContain('AS durable_shipment_attested');
    expect(sql).toContain("e.origin = 'local' AND e.writer_key = head.author_id");
    expect(sql).toContain('to_timestamp(head.created_at / 1000.0)');
    expect(sql).toContain("e.body->>'after' = 'shipped'");
    expect(sql).toContain("o.row->>'origin' = 'local'");
  });

  it('propagates a failed strict revision without publishing a success event', async () => {
    const rig = transactionalRig();
    rig.revision.mockRejectedValueOnce(new Error('revision persistence failed'));
    await expect(restoreHistoricalShipment({}, request)).rejects.toThrow('revision persistence failed');
    expect(rig.writes).toEqual([]);
    expect(rig.emitted).not.toHaveBeenCalled();
  });
});

describe('historical shipment recovery admission', () => {
  it('admits the exact recorded shipment after remote replay of its predecessor', () => {
    expect(historicalShipmentRefusal(witness, request)).toBeNull();
  });

  it('refuses an authored reopening even with the historical acceptance proof', () => {
    expect(historicalShipmentRefusal({ ...witness, seq: 18, shippedBody: prior, shippedHash: hashPlanContent(prior) }, request))
      .toBe('historical_shipment_head_changed');
    expect(historicalShipmentRefusal({ ...witness, origin: 'local' }, request))
      .toBe('historical_shipment_not_remote_rollback');
  });

  it('refuses changed work even when its current hash/version are supplied honestly', () => {
    const changed = prior.replace('Complete.', 'New work.');
    expect(historicalShipmentRefusal({ ...witness, content: changed, contentHash: hashPlanContent(changed) }, {
      ...request, expectedContentHash: hashPlanContent(changed),
    })).toBe('historical_shipment_not_remote_rollback');
  });

  it.each(['localShipmentCaptured', 'rubricRetiredWithShipment'] as const)('requires %s', (key) => {
    expect(historicalShipmentRefusal({ ...witness, [key]: false }, request))
      .toBe('historical_shipment_proof_missing');
  });

  it('requires exact version, current hash and historical hash, including body integrity', () => {
    expect(historicalShipmentRefusal({ ...witness, version: 19 }, request)).toBe('historical_shipment_stale');
    expect(historicalShipmentRefusal({ ...witness, content: prior + 'changed' }, request)).toBe('historical_shipment_stale');
    expect(historicalShipmentRefusal({ ...witness, shippedBody: shipped + 'changed' }, request)).toBe('historical_shipment_head_changed');
    expect(historicalShipmentRefusal(null, request)).toBe('historical_shipment_not_found');
  });

  it('refuses a non-shipped head with internally consistent hashes', () => {
    expect(historicalShipmentRefusal({ ...witness, shippedBody: prior, shippedHash: hashPlanContent(prior) }, {
      ...request, contentHash: hashPlanContent(prior),
    })).toBe('historical_shipment_not_validated');
  });
});

describe('lifecycle recovery schema', () => {
  it('requires an explicit single-plan shipped target and current-status guard', () => {
    const proof = { seq: request.seq, contentHash: request.contentHash,
      expectedVersion: request.expectedVersion, expectedContentHash: request.expectedContentHash };
    const args = { slug: 'delivered', status: 'shipped', expectedCurrent: 'awaiting-acceptance', restoreShippedRevision: proof };
    expect(tool.args.safeParse(args).success).toBe(true);
    expect(tool.args.safeParse({ ...args, expectedCurrent: undefined }).success).toBe(false);
    expect(tool.args.safeParse({ ...args, status: 'ready' }).success).toBe(false);
    expect(tool.args.safeParse({ ...args, slugs: ['delivered'] }).success).toBe(false);
    expect(tool.args.safeParse({ ...args, force: { reason: 'bypass' } }).success).toBe(false);
  });
});
