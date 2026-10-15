/**
 * POST /api/desktop/report-problem against a fully migrated Postgres
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048; R-1 slice per D-045):
 *  - the door files the previewed payload through the ONE shared intake, so a
 *    desktop report and an agent's report of the same error land as one bug that
 *    carries both reporter kinds and the captured screen context;
 *  - a ticked log excerpt lands in the consented-attachment store (door 'desktop');
 *  - a payload changed after the preview is refused and files nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { TableProjection } from '../../../sync/hyperbee/projection';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../../../sync/hyperbee/feature-issue-op-keys';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { bootPresencePeer, makeIdentity, makeTestnet, pollUntil, rigAfterEach } from '../../../sync/hyperbee/__tests__/_cross-peer-rig';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, currentBuild: 'abc1234def'.padEnd(40, '0') as string | null }));
vi.mock('../../../attention/intake-promotion', async (orig) => {
  const actual = await orig<typeof import('../../../attention/intake-promotion')>();
  const currentTargetBuild = async () => h.currentBuild;
  return {
    ...actual,
    currentIntakeTargetBuild: currentTargetBuild,
    // Promotion and the execution-time recheck must observe the same fixture
    // checkout. The server wrapper composes its own lexical default adapter.
    verifyAcceptedWorkItemBugReproduction: (item: Parameters<typeof actual.verifyAcceptedWorkItemBugReproduction>[0]) =>
      actual.verifyAcceptedWorkItemBugReproduction(item, {
        currentTargetBuild,
        ledger: actual.defaultReproductionLedgerDeps(),
      }),
  };
});
beforeEach(() => { h.currentBuild = 'abc1234def'.padEnd(40, '0'); });
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('../../../harness/improvements/capture-core');
const { createIssue, claimIssue } = await import('../../../issues-engineer');
const { setWorkItemState } = await import('../../../work-items');
const { runWorkItemAdmissionPromoter } = await import('../../../work-items-admission-promoter');
const { readIssueClaimability } = await import('../../../scheduler/get-next');
const { IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS } = await import('../../../harness/improvements/agent-review-policy');
const { recordIssueOccurrence } = await import('../../../issue-occurrence-ledger');
const { intakeEndUserReport } = await import('../../../harness/improvements/end-user-intake');
const { putReportAttachment } = await import('../../../harness/improvements/report-attachments');
const { buildProblemReport, previewDigest } = await import('../../../harness/improvements/problem-report');
const { handleReportProblem, answerReportFollowUp } = await import('./report-problem');
const { askReporterQuestion, readReporterStatus } = await import('../../../harness/improvements/reporter-status');
const { runWithWorkspace } = await import('../../../workspace-als');
const { contributeUpstream } = await import('../../../pot/contribute-upstream');
const { buildEngineerIssuesProjection } = await import('../../../sync/hyperbee/projections/engineer-issues');
const { errorSignatureOf } = await import('../../../harness/improvements/error-signature');
const { currentIntakeSourceRevision, executeIntakeDecision, defaultIntakePromotionDeps, verifyAcceptedWorkItemBugReproduction } = await import('../../../attention/intake-promotion');
const { parseIntakeDecision } = await import('../../../attention/bulk-dispositions');
const { publishReporterRelease, defaultReporterReleaseDeps } = await import('../../../../../../apps/operator/lib/release/reporter-release');
const { forwardReportAttachment, defaultReportAttachmentRpcDeps, buildReportAttachmentRpcHandler, REPORT_ATTACHMENT_RPC_KIND } = await import('../../../harness/improvements/report-attachment-rpc');
const { HttpPeerRpcTransport } = await import('../../../authority/http-peer-rpc-transport');
const { handleAuthorityRpc } = await import('../../../authority/authority-op-registry');
const { upsertHiveMember, addRevokedHivePubkeys } = await import('../../../hive-membership-store');
const { unsafeFederatedPotScope } = await import('../../../federated-pot-scope');
const { insertHiveIfAbsent, getHiveBySlug } = await import('../../../hive-store');
const attachmentKeys = generateKeyPairSync('ed25519');
const attachmentPubkey = (attachmentKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
type EngineerIssueRow = import('../../../sync/hyperbee/projections/engineer-issues').EngineerIssueRow;
type ReportProblemDeps = import('./report-problem').ReportProblemDeps;

const WORKSPACE = 'papercusp-workspace';
let db: OrgTestDb;
let upstreamDb: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  upstreamDb = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  await upstreamDb?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});
afterEach(rigAfterEach);
afterEach(() => vi.unstubAllEnvs());

// No similarity search: this pins the error-signature fold, which needs no search.
const capture = (input: Parameters<typeof captureImprovement>[0]) =>
  captureImprovement(input, { searchIssues: async () => [], createIssue,
    // The occurrence writer's unit-test safeguard requires an explicit SQL
    // binding. Use the active peer's real database, just like the intake.
    recordIssueOccurrence: (occurrence) => recordIssueOccurrence(occurrence, h.sql),
  });

const notes: string[] = [];
const deps: ReportProblemDeps = {
  intake: (input) => intakeEndUserReport(input, { capture, rememberNote: async (content) => (notes.push(content), ['mem-1']) }),
  putAttachment: (input) => putReportAttachment(input),
  workspaceId: () => WORKSPACE,
};

function suffix(): string {
  return `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
}

async function rowsMentioning(marker: string) {
  return db.adminSql<{ feature_id: string; title: string; payload: Record<string, unknown> }[]>`
    SELECT feature_id, title, payload FROM harness_shared.work_items
     WHERE title ILIKE ${`%${marker}%`} OR payload::text ILIKE ${`%${marker}%`}`;
}

async function reportReproduction(id: string) {
  const [row] = await h.sql<{ item_kind: string; harness_slug: string; payload: unknown }[]>`
    SELECT item_kind, harness_slug, payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
  if (!row) throw new Error(`report ${id} has no canonical row`);
  return verifyAcceptedWorkItemBugReproduction({ kind: row.item_kind, harness: row.harness_slug, payload: row.payload });
}

describe('desktop Report a problem door, end to end', () => {
  it('stores a consented screenshot as exact non-redactable PNG bytes in real Postgres', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';
    const draft = { text: `Export crashes screenshot ${suffix()}`, screenshotDataUrl: png };
    const unchecked = buildProblemReport(draft);
    const local = await handleReportProblem({ payload: unchecked, previewDigest: await previewDigest(unchecked) }, deps);
    expect(local.status).toBe(200);
    if (local.status !== 200) throw new Error('report was not filed');
    expect(local.body.attachments).toEqual([]);
    // This fixture deliberately disables title-search deduplication; use a
    // separate source for the positive control rather than refiling its title.
    const selected = buildProblemReport({ ...draft, text: `${draft.text} selected`, attachScreenshot: true });
    const sent = await handleReportProblem({ payload: selected, previewDigest: await previewDigest(selected) }, deps);
    expect(sent.status).toBe(200);
    if (sent.status !== 200) throw new Error('screenshot report was not filed');
    expect(sent.body.attachments).toEqual([expect.objectContaining({ kind: 'screenshot', ok: true })]);
    const [stored] = await db.adminSql<{ content: Buffer; kind: string; redaction: string; door: string }[]>`
      SELECT content, kind, redaction, door FROM harness_shared.report_attachments WHERE work_item_id = ${sent.body.id!}`;
    expect(stored).toMatchObject({ kind: 'screenshot', redaction: 'not-redactable', door: 'desktop' });
    expect(stored!.content.equals(Buffer.from(png.split(',')[1]!, 'base64'))).toBe(true);
  });
  it('P-015: the captured report crosses real Hyperswarm into a separate upstream database', async () => {
    h.sql = db.adminSql;
    const marker = `swarm-report-${suffix()}`;
    const payload = buildProblemReport({ text: `CSV export crashes ${marker}`, appVersion: '0.9.4', route: '/settings' });
    const receipt = await handleReportProblem({ payload, previewDigest: await previewDigest(payload) }, {
      ...deps,
      contribute: (input) => contributeUpstream({ kind: 'report', confirm: true, workspaceId: WORKSPACE,
        report: { text: input.text, reportContext: input.reportContext },
        hasCanonicalReportMembership: async () => true, intakeReport: deps.intake }),
    });
    expect(receipt.status).toBe(200);
    if (receipt.status !== 200) throw new Error(JSON.stringify(receipt));
    const id = receipt.body.id!;
    const [op] = await db.adminSql<OutboxRow[]>`
      SELECT table_name, op, key, row, ts, op_hlc FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WORKSPACE} AND table_name = 'engineer_issues'
         AND row->>'issue_id' = ${id} ORDER BY id DESC LIMIT 1`;
    expect(op).toBeDefined();
    const wire = outboxRowToLocalWriteOp(op!);
    const [absent] = await upstreamDb.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(absent, 'positive control: target must not already contain the report').toBeUndefined();
    const net = await makeTestnet();
    const sender = makeIdentity('report-install', 41001, 'report-install');
    const receiver = makeIdentity('report-upstream', 41002, 'report-upstream');
    const upstreamProjection = buildEngineerIssuesProjection({ workspaceId: WORKSPACE, harnessSlug: 'papercusp', sql: upstreamDb.adminSql });
    const upstreamDecode = vi.fn(upstreamProjection.decodeValue);
    const upstreamWrite = vi.fn(upstreamProjection.writeToPg);
    upstreamProjection.decodeValue = upstreamDecode;
    upstreamProjection.writeToPg = upstreamWrite;
    expect(Number.isFinite(Number(op!.ts)), 'outbox timestamp must be a wire number').toBe(true);
    expect(upstreamProjection.decodeValue(wire.value), 'mapped wire row must pass the production decoder').not.toBeNull();
    upstreamDecode.mockClear();
    // Reuse the established signed-announce/Noise/Corestore rig. Admission is
    // the rig's offline user-id seam; production membership/revocation is
    // independently exercised by the signed HTTP attachment test below.
    const peerB = await bootPresencePeer({ testnetBootstrap: net.bootstrap, rootPrefix: 'report-upstream-',
      identity: receiver, sql: upstreamDb.adminSql, verify: (uid) => uid === sender.userId ? 'verified' : 'fail',
      extraProjections: [upstreamProjection as TableProjection<unknown>] });
    const peerA = await bootPresencePeer({ testnetBootstrap: net.bootstrap, rootPrefix: 'report-install-',
      identity: sender, sql: db.adminSql, verify: (uid) => uid === receiver.userId ? 'verified' : 'fail',
      extraProjections: [buildEngineerIssuesProjection({ workspaceId: WORKSPACE, harnessSlug: 'papercusp', sql: db.adminSql }) as TableProjection<unknown>] });
    await peerA.handle.append({ ...wire, writerPubkey: sender.devicePubkey });
    const upstream = await pollUntil(async () => {
      await peerA.handle.mergeNow();
      await peerB.handle.mergeNow();
      const [row] = await upstreamDb.adminSql<{ origin: string; author_pubkey: string; title: string; summary: string; payload: Record<string, unknown> }[]>`
        SELECT origin, author_pubkey, title, summary, payload FROM harness_shared.work_items
         WHERE workspace_id = ${WORKSPACE} AND feature_id = ${id}`;
      return row;
    }, { timeoutMs: 30_000, intervalMs: 250 });
    expect(upstream, `real swarm report never reached upstream; admitted A=${peerA.handle.admitted.size} B=${peerB.handle.admitted.size}; own log length=${peerA.handle.ownLog.length}; decoded=${upstreamDecode.mock.calls.length} written=${upstreamWrite.mock.calls.length}; wire key=${wire.hbKey}`).toBeDefined();
    expect(upstream!.origin).toBe('remote');
    expect(upstream!.author_pubkey).toBe(peerA.handle.ownLog.keyHex);
    expect(upstream!.payload.reporter).toMatchObject({ kind: 'end-user' });
    expect(upstream!.title).toContain(marker);
    expect(upstream!.summary).toContain(marker);
    expect(upstream!.payload.reportContext).toMatchObject({ appVersion: '0.9.4', screen: { route: '/settings' } });
    const [local] = await db.adminSql`SELECT origin FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(local!.origin).toBe('local');
  }, 90_000);

  it('P-015: contribution captures once and the existing issue CDC projects report context upstream', async () => {
    const s = suffix();
    // A peer is a separate database, not a second workspace in the SAME DB:
    // work_items' physical primary key is (harness_slug, feature_id).
    const upstreamWorkspace = WORKSPACE;
    const [sourceDatabase] = await db.adminSql<{ name: string }[]>`SELECT current_database() AS name`;
    const [targetDatabase] = await upstreamDb.adminSql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(targetDatabase!.name).not.toBe(sourceDatabase!.name);
    const intake = vi.fn(deps.intake);
    const localFallback = vi.fn(deps.intake);
    const errorMessage = `TypeError: CSV export rows are missing for p015${s}`;
    const agentMessage = `Uncaught ${errorMessage}`;
    // Preflight the instrument: short/generic errors intentionally do not get
    // a dedup key. Never let random suffix length decide fixture eligibility.
    const signature = errorSignatureOf({ source: 'window.error', message: errorMessage });
    expect(signature).not.toBeNull();
    expect(errorSignatureOf({ source: 'renderer', message: agentMessage })?.key).toBe(signature?.key);
    const payload = buildProblemReport({ text: `Export crashes p015-${s}`, appVersion: '0.9.4',
      route: '/harness/papercusp/board', search: '?view=kanban',
      recentErrors: [{ source: 'window.error', message: errorMessage }] });
    const out = await handleReportProblem({ payload, previewDigest: await previewDigest(payload) }, {
      ...deps, intake: localFallback,
      contribute: (input) => contributeUpstream({ kind: 'report', confirm: true, workspaceId: WORKSPACE,
        report: { text: input.text, reportContext: input.reportContext },
        hasCanonicalReportMembership: async () => true, intakeReport: intake }),
    });
    expect(out.status).toBe(200);
    if (out.status !== 200) throw new Error(JSON.stringify(out));
    expect(out.body.delivery).toBe('queued-for-federation');
    expect(intake).toHaveBeenCalledOnce();
    expect(localFallback).not.toHaveBeenCalled();
    const id = out.body.id!;
    // Real capture trigger / outbox row, not a hand-authored substitute payload.
    const [op] = await db.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
      SELECT row, ts FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WORKSPACE} AND table_name = 'engineer_issues'
         AND row->>'issue_id' = ${id} ORDER BY id DESC LIMIT 1`;
    expect(op, 'installed report must enter the existing issue federation outbox').toBeDefined();
    expect(op!.row.harness_slug, JSON.stringify({ harness: op!.row.harness_slug, scope: op!.row.scope, storage: op!.row.storage_harness_slug })).toBe('papercusp');
    const projection = buildEngineerIssuesProjection({ workspaceId: upstreamWorkspace, harnessSlug: 'papercusp', sql: upstreamDb.adminSql });
    await projection.writeToPg(op!.row, { ts: Number(op!.ts), origin: 'remote', authorPubkey: attachmentPubkey });
    const [upstream] = await upstreamDb.adminSql<{ origin: string; title: string; summary: string; payload: Record<string, unknown> }[]>`
      SELECT origin, title, summary, payload FROM harness_shared.work_items
       WHERE workspace_id = ${upstreamWorkspace} AND feature_id = ${id}`;
    expect(upstream?.origin).toBe('remote');
    expect(upstream?.payload.reporter).toMatchObject({ kind: 'end-user' });
    expect(upstream?.payload.watchdogKey).toBe(signature!.key);
    expect(JSON.stringify(upstream?.payload.reportContext)).toContain('0.9.4');
    expect(JSON.stringify(upstream?.payload.reportContext)).toContain('kanban');
    const [source] = await db.adminSql<{ origin: string }[]>`
      SELECT origin FROM harness_shared.work_items WHERE workspace_id = ${WORKSPACE} AND feature_id = ${id}`;
    expect(source?.origin).toBe('local');
    // Actual signed HTTP peer RPC -> the separate upstream database. The
    // Use the production uncached membership and revocation readers as well as
    // report authorship, retention, byte storage and signature verification.
    const attachment = await putReportAttachment({ workspaceId: WORKSPACE, workItemId: id, door: 'desktop',
      kind: 'log', mime: 'text/plain', content: 'Consented export failure log', externalId: `p015:${s}` }, { sql: db.adminSql });
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) throw Error('attachment fixture refused');
    const attachmentHandler = buildReportAttachmentRpcHandler(defaultReportAttachmentRpcDeps(WORKSPACE, upstreamDb.adminSql));
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await handleAuthorityRpc(env, { handlers: { [REPORT_ATTACHMENT_RPC_KIND]: attachmentHandler },
          authorityExemptKinds: new Set([REPORT_ATTACHMENT_RPC_KIND]), verifyIsAuthority: () => false });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result));
      } catch { res.statusCode = 500; res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw Error('missing RPC port');
      const transport = new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${addr.port}`,
        envelopeSigner: { devicePubkey: attachmentPubkey, sign: async bytes => sign(null, bytes, attachmentKeys.privateKey) } });
      const peer = { devicePubkey: 'canonical-fixture', githubUserId: 1, machineLabel: 'upstream' };
      const forwardDeps = { sql: db.adminSql, transport, canonicalPeer: async () => peer };
      expect(await forwardReportAttachment(WORKSPACE, attachment.id, forwardDeps)).toEqual({
        delivered: false, reason: 'upstream-receipt-unconfirmed',
      });
      const membershipScope = unsafeFederatedPotScope('papercusp', 'isolated canonical-owner fixture uses its owner-authored slug');
      await insertHiveIfAbsent({ workspaceId: WORKSPACE, homeSlug: 'papercusp',
        pubkeyBase64: attachmentPubkey, keychainId: 'remote:p015-membership-fixture',
        title: 'P015 canonical membership fixture' }, upstreamDb.adminSql);
      expect((await getHiveBySlug(WORKSPACE, 'papercusp', upstreamDb.adminSql))?.homeSlug).toBe('papercusp');
      await upsertHiveMember({ workspaceId: WORKSPACE, potHomeSlug: membershipScope,
        githubUserId: 9015, githubUsername: 'p015-reporter', bindingStatus: 'verified',
        deviceAttestations: [{ device_pubkey: attachmentPubkey, gist_id: 'fixture', gist_url: 'fixture',
          device_label: 'reporter', created_at: 1, signature_by_device: 'fixture' }],
      }, upstreamDb.adminSql);
      expect(await forwardReportAttachment(WORKSPACE, attachment.id, forwardDeps)).toEqual({ delivered: true });
      expect(await forwardReportAttachment(WORKSPACE, attachment.id, forwardDeps)).toEqual({ delivered: true });
      await addRevokedHivePubkeys(WORKSPACE, membershipScope, 9015, [attachmentPubkey], upstreamDb.adminSql);
      expect(await forwardReportAttachment(WORKSPACE, attachment.id, forwardDeps)).toEqual({
        delivered: false, reason: 'upstream-receipt-unconfirmed',
      });
      const blobs = await upstreamDb.adminSql<{ content: Buffer; redaction: string }[]>`
        SELECT content, redaction FROM harness_shared.report_attachments WHERE work_item_id = ${id}`;
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.content.toString()).toBe('Consented export failure log');
      expect(blobs[0]!.redaction).toBe('redacted');
      const [receipt] = await db.adminSql`SELECT payload -> '_reportAttachmentReceipts' AS receipts FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(receipt!.receipts[attachment.id]).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const [immutable] = await db.adminSql`SELECT bool_or(row::text LIKE '%Consented export failure log%') AS leaked
        FROM harness_shared.substrate_outbox WHERE table_name = 'engineer_issues' AND row ->> 'issue_id' = ${id}`;
      expect(immutable!.leaked).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    // The upstream agent uses the SAME capture intake; no second report type.
    h.sql = upstreamDb.adminSql;
    try {
      const agent = await capture({ title: `Agent export failure p015-${s}`, kind: 'bug',
        scope: 'harness:papercusp', workspaceId: upstreamWorkspace, createdBy: 'su-upstream-reviewer',
        reportContext: { recentErrors: [{ source: 'renderer', message: agentMessage }] } });
      const keys = await upstreamDb.adminSql`
        SELECT feature_id, workspace_id, harness_slug, payload->>'watchdogKey' AS watchdog_key,
               payload->'errorSignature' AS signature, payload->'_ei'->>'signal_origin' AS signal_origin
          FROM harness_shared.work_items WHERE feature_id = ${id} OR payload->>'watchdogKey' = ${signature!.key}`;
      expect(agent.created, `source/agent signature preflight passed; upstream identities: ${JSON.stringify(keys)}`).toBe(false);
      expect(agent.issue?.id ?? agent.coalescedOnto?.id).toBe(id);
      const [folded] = await upstreamDb.adminSql<{ origin: string; title: string; summary: string; payload: Record<string, unknown> }[]>`
        SELECT origin, title, summary, payload FROM harness_shared.work_items WHERE workspace_id = ${upstreamWorkspace} AND feature_id = ${id}`;
      expect(folded?.origin, 'corroboration must not transfer foreign authorship to this peer').toBe('remote');
      expect(folded?.title, 'corroboration preserves the reporting peer’s original title').toBe(upstream?.title);
      expect(folded?.summary, 'corroboration preserves the reporting peer’s original evidence').toBe(upstream?.summary);
      expect(folded?.payload.reporterKinds).toEqual(upstream?.payload.reporterKinds);
      const occurrences = await upstreamDb.adminSql<{ reporter: string }[]>`
        SELECT reporter FROM harness_shared.work_item_occurrences
         WHERE workspace_id = ${upstreamWorkspace} AND canonical_work_item_id = ${id}`;
      expect(occurrences.map((row) => row.reporter)).toContain('su-upstream-reviewer');

      // A foreign row is evidence, not something this upstream peer owns.
      // Existing distinct promotion supplies ONE locally executable canonical
      // item; its source mapping travels back through the same issue CDC.
      const parsed = parseIntakeDecision({ disposition: 'promote', reason: 'CSV failure reproduced upstream',
        reproduction: { kind: 'failing-test', ref: 'report-problem.integration.test.ts CSV reproduction', buildSha: 'abc1234def' },
        acceptance: { problem: 'CSV export crashes', evidence: ['CSV reproduction fails'],
          outcome: 'CSV export completes', scope: 'CSV export on board', completionCheck: 'CSV reproduction passes' } },
      { decidedBy: 'su-upstream-verifier', sourceRevision: await currentIntakeSourceRevision(id) });
      if (!parsed.ok) throw new Error(parsed.error);
      const promoted = await executeIntakeDecision({ sourceId: id, decision: parsed.decision, runId: 'p015-upstream', itemId: `report-${s}` },
        defaultIntakePromotionDeps({ currentTargetBuild: async () => h.currentBuild }));
      expect(promoted, JSON.stringify(promoted)).toMatchObject({ ok: true, mode: 'distinct', created: true });
      if (!promoted.ok || !promoted.workItemId) throw new Error(JSON.stringify(promoted));
      const reproduction = await reportReproduction(promoted.workItemId);
      expect(reproduction, JSON.stringify(reproduction)).toMatchObject({ status: 'attested' });
      expect(await claimIssue(promoted.workItemId, 'su-upstream-fixer')).toMatchObject({ assignee: 'su-upstream-fixer' });
      expect(await askReporterQuestion({ id: promoted.workItemId, harness: 'papercusp', actor: 'su-other', text: 'Which file?' })).toMatchObject({ ok: false });
      const question = await askReporterQuestion({ id: promoted.workItemId, harness: 'papercusp', actor: 'su-upstream-fixer', text: 'Which CSV file triggers it?' });
      expect(question).toMatchObject({ ok: true });
      expect(await askReporterQuestion({ id: promoted.workItemId, harness: 'papercusp', actor: 'su-upstream-fixer', text: 'A second question?' })).toMatchObject({ ok: false, error: 'report-already-has-follow-up-question' });
      const [returnOp] = await upstreamDb.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
        SELECT row, ts FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${upstreamWorkspace} AND table_name = 'engineer_issues'
           AND row->>'issue_id' = ${promoted.workItemId} ORDER BY id DESC LIMIT 1`;
      expect(returnOp).toBeDefined();
      const installedProjection = buildEngineerIssuesProjection({ workspaceId: WORKSPACE, harnessSlug: 'papercusp', sql: db.adminSql });
      await installedProjection.writeToPg(returnOp!.row, { ts: Number(returnOp!.ts), origin: 'remote', authorPubkey: 'p015-canonical-upstream' });
      const [received] = await db.adminSql<{ origin: string; taken_by: string; payload: Record<string, unknown> }[]>`
        SELECT origin, taken_by, payload FROM harness_shared.work_items
         WHERE workspace_id = ${WORKSPACE} AND feature_id = ${promoted.workItemId}`;
      expect(received).toMatchObject({ origin: 'remote', taken_by: 'su-upstream-fixer', payload: {
        intakeSource: { id }, reporterKinds: expect.arrayContaining(['end-user']) } });
      expect(JSON.stringify(received?.payload.reportContext)).toContain('0.9.4');
      const [original] = await db.adminSql<{ origin: string }[]>`
        SELECT origin FROM harness_shared.work_items WHERE workspace_id = ${WORKSPACE} AND feature_id = ${id}`;
      expect(original?.origin).toBe('local');
      const status = await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql);
      expect(status).toMatchObject({ canonicalId: promoted.workItemId, status: 'being-fixed', followUp: { question: { text: 'Which CSV file triggers it?' } } });
      const questionId = status!.followUp!.question.id;
      h.sql = db.adminSql;
      const reply = { operation: 'answer-follow-up', id, harness: 'papercusp', questionId, text: 'The UTF-8 sample from the export panel.' };
      expect(await runWithWorkspace(WORKSPACE, () => answerReportFollowUp(reply))).toMatchObject({ status: 200 });
      expect(await runWithWorkspace(WORKSPACE, () => answerReportFollowUp(reply))).toMatchObject({ status: 409, body: { error: 'question-already-answered' } });
      expect(await runWithWorkspace(WORKSPACE, () => answerReportFollowUp({ ...reply, id: promoted.workItemId }))).toMatchObject({ status: 404 });
      const [answerOp] = await db.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
        SELECT row, ts FROM harness_shared.substrate_outbox WHERE workspace_id = ${WORKSPACE}
          AND table_name = 'engineer_issues' AND row->>'issue_id' = ${id} ORDER BY id DESC LIMIT 1`;
      expect(answerOp?.row.payload).toMatchObject({ reporterAnswer: { questionId, text: reply.text } });
      await projection.writeToPg(answerOp!.row, { ts: Number(answerOp!.ts), origin: 'remote', authorPubkey: attachmentPubkey });
      const [returnedAnswer] = await upstreamDb.adminSql<{ origin: string; answer: unknown }[]>`
        SELECT origin, payload->'reporterAnswer' AS answer FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(returnedAnswer).toMatchObject({ origin: 'remote', answer: { questionId, text: reply.text } });

      // P016 publication contract: the real canonical writer emits a receipt
      // through issue CDC, and the installed source reads the canonical version.
      // Fixture completion is explicit; this is not a release/deploy operation.
      h.sql = upstreamDb.adminSql;
      const fixBlob = 'b'.repeat(40);
      await upstreamDb.adminSql`UPDATE harness_shared.work_items
        SET status = 'done', authority = 'committed', terminal_completion_ref = 'p016-publication-fixture',
            payload = payload || ${JSON.stringify({ _completionEvidence: { settlementManifest: {
              repositoryRoot: '/p016-fixture', contentIdentity: [{ path: 'src/export.ts', headBlobSha: fixBlob, workingTreeBlobSha: fixBlob }],
            } } })}::jsonb
        WHERE workspace_id = ${WORKSPACE} AND feature_id = ${promoted.workItemId}`;
      const release = { version: '0.9.5', channel: 'alpha', cutAt: new Date(), publishedAt: null as Date | null,
        changelogMd: null, workItemIds: [promoted.workItemId], planSlugs: [], artifacts: [],
        gitSha: 'a'.repeat(40), cutBy: null, notes: null };
      const publicationDeps = { ...defaultReporterReleaseDeps(upstreamDb.adminSql, WORKSPACE, release),
        repositoryRoot: '/p016-fixture',
        readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: fixBlob }]]),
      };
      expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [], unconfirmed: [] });
      release.publishedAt = new Date();
      expect(await publishReporterRelease(release, { ...publicationDeps,
        readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: 'c'.repeat(40) }]]),
      })).toEqual({ notified: [], unconfirmed: [promoted.workItemId] });
      expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [promoted.workItemId], unconfirmed: [] });
      expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [], unconfirmed: [] });
      const [releaseOp] = await upstreamDb.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
        SELECT row, ts FROM harness_shared.substrate_outbox WHERE workspace_id = ${WORKSPACE}
          AND table_name = 'engineer_issues' AND row->>'issue_id' = ${promoted.workItemId} ORDER BY id DESC LIMIT 1`;
      expect(releaseOp?.row.payload).toMatchObject({ reporterRelease: { version: '0.9.5', completionRef: 'p016-publication-fixture' } });
      await installedProjection.writeToPg(releaseOp!.row, { ts: Number(releaseOp!.ts), origin: 'remote', authorPubkey: 'p015-canonical-upstream' });
      expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
        .toMatchObject({ canonicalId: promoted.workItemId, status: 'fixed', label: 'Fixed in v0.9.5' });
      const [stillLocal] = await db.adminSql<{ origin: string }[]>`SELECT origin FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(stillLocal?.origin).toBe('local');
    } finally {
      h.sql = db.adminSql;
    }
    // Scope: real PG CDC -> real PG projection. No live swarm delivery claim.
  });

  it('P-023: one desktop, agent and watchdog identity survives verification, claim, completion and publication', async () => {
    // The filing timer has its own scheduler controls. Isolate wall-clock delay
    // here while keeping duplicate admission and verification on their real paths.
    vi.stubEnv('PAPERCUSP_FILING_GRACE_SEC', '0');
    const s = suffix();
    const payload = buildProblemReport({
      text: `Export to CSV does nothing on board ${s}`,
      appVersion: '0.9.3 (abc1234)',
      route: '/harness/papercusp/board',
      search: '?view=kanban&report=true',
      recentErrors: [{ source: 'window.error', message: `TypeError: Cannot read properties of undefined (reading 'csvRows${s}') at 41:17` }],
      attachLog: true,
      logLines: ['2026-10-06T22:00:00Z error export failed', '2026-10-06T22:00:01Z warn retrying'],
    });

    const out = await handleReportProblem({ payload, previewDigest: await previewDigest(payload) }, deps);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.routed).toBe('work-item');
    const id = out.body.id;
    expect(id).toMatch(/^(EI|WI)-/);
    expect(out.body.attachments).toEqual([expect.objectContaining({ kind: 'log', ok: true })]);

    // An agent reports the same error, different position and wrapper.
    const agent = await capture({
      title: `CSV export throws on board (${s})`,
      kind: 'bug',
      scope: 'harness:papercusp',
      workspaceId: WORKSPACE,
      createdBy: 'su-integration-agent',
      reportContext: {
        recentErrors: [{ message: `Uncaught TypeError: Cannot read properties of undefined (reading 'csvRows${s}') at 88:3`, source: 'renderer' }],
      },
    });
    // On a miss, say WHY the two reports did not fold: their tenancy and signature side by side.
    const keys = await db.adminSql`
      SELECT feature_id, workspace_id, harness_slug, payload->>'scope' AS scope,
             payload->>'errorSignature' AS signature, payload->'reporter'->>'kind' AS reporter
        FROM harness_shared.work_items
       WHERE title ILIKE ${`%${s}%`} OR payload::text ILIKE ${`%csvRows${s}%`} ORDER BY feature_id`;
    expect(agent.created, `agent report did not fold onto the desktop report: ${JSON.stringify(keys)}`).toBe(false);
    expect(agent.issue?.id ?? agent.coalescedOnto?.id).toBe(id);

    const watchdog = await capture({
      title: `Watchdog observed CSV export failure (${s})`,
      kind: 'bug',
      scope: 'harness:papercusp',
      workspaceId: WORKSPACE,
      createdBy: 'system:p023-watchdog',
      reporterKind: 'watchdog',
      reportContext: { recentErrors: [{
        source: 'renderer', message: `TypeError: Cannot read properties of undefined (reading 'csvRows${s}') at 92:8`,
      }] },
    });
    expect(watchdog.created).toBe(false);
    expect(watchdog.issue?.id ?? watchdog.coalescedOnto?.id).toBe(id);

    const rows = await rowsMentioning(`csvRows${s}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.feature_id).toBe(id);
    expect(row.title).toContain('Export to CSV does nothing');
    expect(row.payload.reporter).toMatchObject({ kind: 'end-user' });
    expect(row.payload.reporterKinds).toEqual(expect.arrayContaining(['agent', 'end-user', 'watchdog']));
    // The captured screen context rides on the row: the route and the user-meaningful params, not the dialog's own.
    const context = JSON.stringify(row.payload.reportContext ?? row.payload);
    expect(context).toContain('/harness/papercusp/board');
    expect(context).toContain('kanban');
    expect(context).toContain('0.9.3 (abc1234)');
    // Anonymous: nothing identifies the desktop reporter.
    expect(JSON.stringify(row.payload.reporter)).not.toMatch(/user-|@/);

    const atts = await db.adminSql<{ door: string; kind: string; redaction: string }[]>`
      SELECT door, kind, redaction FROM harness_shared.report_attachments WHERE work_item_id = ${id!}`;
    expect(atts).toEqual([{ door: 'desktop', kind: 'log', redaction: 'redacted' }]);

    // Exercise the real scheduler and acceptance writer. Duplicate admission is
    // an independent stage: run its existing no-model routine rather than stamp
    // the database or assume acceptance silently releases a different hold.
    if (!id) throw new Error('desktop intake returned no source identity');
    // D-018 currently retains the legacy rollout exception. Like the canonical
    // intake journey, pin only the creation-date boundary so this fixture tests
    // the enforced contract; this is not evidence that the rollout has shipped.
    await db.adminSql`UPDATE harness_shared.work_items
      SET created_ts = ${IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS + 60_000}
      WHERE feature_id = ${id}`;
    const claimable = () => readIssueClaimability({ field: 'id', op: 'in', value: [id] }, {
      harness: 'papercusp', workspaceId: WORKSPACE, states: ['open'],
      assignee: 'su-p023-fixer', client: db.adminSql,
    }, { limit: 10, sampleLimit: 1 });
    expect((await claimable()).rows).toEqual([]);
    const llmCall = vi.fn(async () => { throw new Error('unexpected duplicate pair in single-report journey'); });
    expect(await runWorkItemAdmissionPromoter({ workspaceId: WORKSPACE, harnessSlug: 'papercusp',
      sql: db.adminSql, runId: `p023-admission-${s}`, targetItemIds: [id],
      noModel: true, llmCall })).toMatchObject({ promoted: 1, held: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    const beforeVerification = await claimable();
    expect(beforeVerification.breakdown.excluded.admissionPending).toBe(0);
    expect(beforeVerification.rows).toEqual([]);
    expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
      .toMatchObject({ sourceId: id, canonicalId: id, status: 'received' });
    const parsed = parseIntakeDecision({ disposition: 'promote', reason: 'CSV export failure independently reproduced',
      reproduction: { kind: 'failing-test', ref: 'report-problem.integration.test.ts CSV reproduction', buildSha: 'abc1234def' },
      acceptance: { problem: 'CSV export crashes', evidence: ['CSV reproduction fails'],
        outcome: 'CSV export completes', scope: 'CSV export on board', completionCheck: 'CSV reproduction passes' } },
    { decidedBy: 'su-p023-verifier', sourceRevision: await currentIntakeSourceRevision(id) });
    if (!parsed.ok) throw new Error(parsed.error);
    const accepted = await executeIntakeDecision({ sourceId: id, decision: parsed.decision,
      runId: `p023-${s}`, itemId: `report-${s}` },
    defaultIntakePromotionDeps({ currentTargetBuild: async () => h.currentBuild }));
    expect(accepted).toMatchObject({ ok: true, mode: 'in-place', workItemId: id });
    const admitted = await claimable();
    const [afterAcceptance] = await db.adminSql`
      SELECT status, item_kind, taken_by, payload->'agentReview' AS review,
             payload->'implementationReadiness' AS readiness
        FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(admitted.rows.map(item => item.id),
      `accepted report excluded: ${JSON.stringify({ breakdown: admitted.breakdown, sample: admitted.sample, afterAcceptance })}`)
      .toEqual([id]);
    expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
      .toMatchObject({ sourceId: id, canonicalId: id, status: 'awaiting-fix' });
    // Acceptance is not a permanent authorization to fix an older build.
    // Exercise the real bottom writer against both stale and unknown targets.
    h.currentBuild = 'd'.repeat(40);
    expect(await reportReproduction(id)).toMatchObject({ status: 'refuted' });
    expect(await claimIssue(id, 'su-p023-fixer')).toBeNull();
    h.currentBuild = null;
    expect(await reportReproduction(id)).toMatchObject({ status: 'unresolved' });
    expect(await claimIssue(id, 'su-p023-fixer')).toBeNull();
    const [unclaimed] = await db.adminSql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(unclaimed?.taken_by).toBeNull();
    h.currentBuild = 'abc1234def'.padEnd(40, '0');
    const reproduction = await reportReproduction(id);
    expect(reproduction, JSON.stringify(reproduction)).toMatchObject({ status: 'attested' });
    expect(await claimIssue(id, 'su-p023-fixer')).toMatchObject({ assignee: 'su-p023-fixer' });
    expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
      .toMatchObject({ sourceId: id, canonicalId: id, status: 'being-fixed' });

    // This is a publication fixture, not a claim that a real release shipped.
    // The completion still goes through the canonical writer, and notification
    // still requires the published artifact's matching content identity.
    const fixBlob = 'b'.repeat(40);
    const completionRef = `p023-completion-${s}`;
    await setWorkItemState(id, 'done', { harness: 'papercusp', by: 'su-p023-fixer',
      completionRef, completionAuthority: 'committed', completionEvidence: {
        verifiedHow: 'integration', testsRun: 'CSV reproduction fixture', testResult: 'passed',
        // A complete generation-1 receipt (the manifest type gained version/generation/
        // evidenceHash/headSha/normalizedPaths); the hash is a fixture value, not derived.
        settlementManifest: { version: 1, generation: 1, evidenceHash: 'e'.repeat(64),
          repositoryRoot: '/p023-fixture', headSha: 'a'.repeat(40), normalizedPaths: ['src/export.ts'],
          contentIdentity: [
            { path: 'src/export.ts', headBlobSha: fixBlob, workingTreeBlobSha: fixBlob },
          ] },
      } });
    expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
      .toMatchObject({ sourceId: id, canonicalId: id, status: 'awaiting-release', release: null });
    const release = { version: '0.9.6', channel: 'alpha', cutAt: new Date(), publishedAt: null as Date | null,
      changelogMd: null, workItemIds: [id], planSlugs: [], artifacts: [],
      gitSha: 'a'.repeat(40), cutBy: null, notes: null };
    const publicationDeps = { ...defaultReporterReleaseDeps(db.adminSql, WORKSPACE, release),
      repositoryRoot: '/p023-fixture',
      readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: fixBlob }]]),
    };
    expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [], unconfirmed: [] });
    release.publishedAt = new Date();
    expect(await publishReporterRelease(release, { ...publicationDeps,
      readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: 'c'.repeat(40) }]]),
    })).toEqual({ notified: [], unconfirmed: [id] });
    expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [id], unconfirmed: [] });
    expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [], unconfirmed: [] });
    expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
      .toMatchObject({ sourceId: id, canonicalId: id, status: 'fixed', label: 'Fixed in v0.9.6' });
    const finalRows = await rowsMentioning(`csvRows${s}`);
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]!.feature_id).toBe(id);
    expect(finalRows[0]!.payload.reporterKinds).toEqual(expect.arrayContaining(['agent', 'end-user', 'watchdog']));
  });

  it('files nothing when the payload was changed after the preview', async () => {
    const s = suffix();
    const shown = buildProblemReport({ text: `Settings page freezes ${s}`, route: '/settings' });
    const digest = await previewDigest(shown);
    const sent = { ...shown, text: `${shown.text} and also something the preview never showed` };

    const out = await handleReportProblem({ payload: sent, previewDigest: digest }, deps);
    expect(out).toMatchObject({ status: 409, body: { error: 'preview-mismatch' } });
    expect(await rowsMentioning(`freezes ${s}`)).toHaveLength(0);
  });
});
