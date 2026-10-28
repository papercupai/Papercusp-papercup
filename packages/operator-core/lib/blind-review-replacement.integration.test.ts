import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { declareSessionConfinement } from './capability-envelope/session-confinement-store';
import { BLIND_GAP_REVIEW_ACTOR } from './blind-review-session-bindings';
import { BLIND_REVIEWER_BACKENDS, blindReviewerConfinement } from './blind-reviewer-mint';
import { assertMigrationPassesPreApplyLints } from './migration-preapply-lint';
import { replaceBlindGapReviewer, type BlindReviewReplacementDeps, type BlindReviewReplacementInput } from './blind-review-replacement';
import { blindReviewPostedEventKey } from './blind-review-post-event';

let fx: PlanPgFixture;
let root = '';
let count = 0;
const WS = 'default';
const AUTHOR = 'su-replacement-author';
const sqlRoot = new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url);
const readMigration = (name: string) => readFileSync(new URL(existsSync(new URL(name, sqlRoot)) ? name : name + '.DRAFT', sqlRoot), 'utf8');

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  root = await mkdtemp(path.join(tmpdir(), 'blind-replacement-pg-'));
  await writeFile(path.join(root, 'product.test.ts'), 'maintained product test');
  await writeFile(path.join(root, 'other.test.ts'), 'another existing test');
  const [protocol] = await fx.admin`SELECT 1 FROM information_schema.columns WHERE table_schema = 'harness_shared'
    AND table_name = 'plan_blind_reviews' AND column_name = 'protocol_version'`;
  if (!protocol) await fx.admin.begin(tx => tx.unsafe(readMigration('1564-blind-review-outcomes.sql')));
  const [replacement] = await fx.admin`SELECT 1 FROM information_schema.columns WHERE table_schema = 'harness_shared'
    AND table_name = 'plan_blind_review_sessions' AND column_name = 'replacement_of'`;
  if (!replacement) await fx.admin.begin(tx => tx.unsafe(readMigration('1567-blind-review-replacement-attempts.sql')));
}, 60_000);
afterAll(async () => { await fx?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });

async function seed() {
  const slug = `zzz-replacement-${Date.now()}-${++count}`;
  const harness = slug;
  await seedPlan(fx.admin, WS, harness, slug, `---\ntitle: Replacement fixture\nslug: ${slug}\nstatus: active\n---\n\n## Items\n\n- **P-001** \`done\` Product behaviour.\n`);
  await fx.admin`UPDATE harness_shared.harness_plans SET owner = ${AUTHOR}
    WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND plan_slug = ${slug}`;
  await fx.admin`INSERT INTO harness_shared.plan_audits
    (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation,
     audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
    VALUES (${WS}, ${harness}, ${slug}, 5, ${AUTHOR}, 'activation', '{}', 1, 1, ${'a'.repeat(64)})`;
  const reviewer = `su-replacement-original-${count}`;
  const [native] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent, ended_at, launch_spec, launch_argv)
    VALUES (${WS}, 'omp', ${reviewer}, ${`native-original-${count}`}, 'codex', now(),
      ${fx.admin.json({ launchedBy: BLIND_GAP_REVIEW_ACTOR, headless: true, account: 'auto' } as never)}, '[]') RETURNING id`;
  const [review] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.plan_blind_reviews
    (workspace_id, harness_slug, plan_slug, record_kind, activation_audit_seq, created_by, gaps, outcome, summary)
    VALUES (${WS}, ${harness}, ${slug}, 'review', 5, ${reviewer}, '[]', 'inconclusive', 'INCONCLUSIVE: access blocked') RETURNING id`;
  const confinement = blindReviewerConfinement(slug);
  const [binding] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.plan_blind_review_sessions
    (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
     native_session_id, launch_parent_owner, account_route, confinement_snapshot, status, review_id)
    VALUES (${WS}, ${harness}, ${slug}, 5, ${reviewer}, ${native!.id}, ${`native-original-${count}`},
      ${BLIND_GAP_REVIEW_ACTOR}, 'auto', ${fx.admin.json(confinement as never)}, 'posted', ${review!.id}) RETURNING id`;
  const input: BlindReviewReplacementInput = { workspaceId: WS, harness, slug, activationAuditSeq: 5,
    sourceReviewId: Number(review!.id), requestKey: 'corrected-manifest', productReads: { testFiles: ['product.test.ts'] },
    ctx: { workspaceId: WS, uiClientId: AUTHOR, isSuperuser: true } };
  const brief = { planSlug: slug, activationAuditSeq: 5, ownerTurns: [{ ref: 'owner:1', text: 'Exercise the product.' }], unverifiedTurns: [], excludedRefs: [], text: 'Exercise the product.' };
  const deps: BlindReviewReplacementDeps = { sql: fx.admin as never, repoRoot: async () => root, loadBrief: async () => brief };
  return { input, deps, bindingId: Number(binding!.id), nativeId: Number(native!.id), reviewer, brief };
}

async function nativeLaunch(input: BlindReviewReplacementInput, args: Record<string, unknown>, ctx: unknown, key: symbol) {
  const owner = `su-replacement-new-${input.slug}-${String(args.idempotencyKey).slice(-8)}`;
  const confinement = (ctx as Record<symbol, unknown>)[key];
  const declared = await declareSessionConfinement({ workspaceId: WS, ownerId: owner, confinement: confinement as never });
  expect(declared.ok).toBe(true);
  const [native] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent, launch_spec, launch_argv)
    VALUES (${WS}, 'omp', ${owner}, ${`native-${owner}`}, 'codex',
      ${fx.admin.json({ launchedBy: BLIND_GAP_REVIEW_ACTOR, headless: true, account: 'auto' } as never)}, '[]') RETURNING id`;
  const launch = { opened: 1, partial: false, ownerIds: [owner], tasks: [{ ownerId: owner }],
    freshVerdict: { sessions: [{ ownerId: owner, advSessionId: Number(native!.id), sessionId: `native-${owner}` }] } };
  await fx.admin`INSERT INTO harness_shared.agent_launch_idempotency (workspace_id, idempotency_key, launched_at, launched_by, summary)
    VALUES (${WS}, ${String(args.idempotencyKey)}, ${Date.now()}, ${BLIND_GAP_REVIEW_ACTOR}, ${fx.admin.json(launch as never)})`;
  return { data: { launch } };
}

describe('same-activation replacement on private PostgreSQL', () => {
  it('passes the maintained migration safety gate and preserves legacy targetless insert retries', async () => {
    expect(() => assertMigrationPassesPreApplyLints({
      filename: '1567-blind-review-replacement-attempts.sql',
      sqlText: readMigration('1567-blind-review-replacement-attempts.sql'),
      sqlDir: sqlRoot.pathname,
    })).not.toThrow();
    const s = await seed();
    const [legacy] = await fx.admin<Array<{ id: number; attempt_seq: number; replacement_of: number | null }>>`
      WITH original AS (DELETE FROM harness_shared.plan_blind_review_sessions WHERE id = ${s.bindingId} RETURNING *)
      INSERT INTO harness_shared.plan_blind_review_sessions
        (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
         native_session_id, launch_parent_owner, account_route, confinement_snapshot, status, review_id)
      SELECT workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
             native_session_id, launch_parent_owner, account_route, confinement_snapshot, status, review_id FROM original
      ON CONFLICT DO NOTHING RETURNING id, attempt_seq, replacement_of`;
    expect(legacy).toMatchObject({ attempt_seq: 0, replacement_of: null });
    const repeated = await fx.admin`
      INSERT INTO harness_shared.plan_blind_review_sessions
        (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
         native_session_id, launch_parent_owner, account_route, confinement_snapshot, status, review_id)
      SELECT workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id, adv_session_id,
             native_session_id, launch_parent_owner, account_route, confinement_snapshot, status, review_id
        FROM harness_shared.plan_blind_review_sessions WHERE id = ${legacy!.id}
      ON CONFLICT DO NOTHING RETURNING id`;
    expect(repeated).toHaveLength(0);
  });

  it('serializes concurrent equivalent requests, launches once, and preserves the complete original receipt', async () => {
    const s = await seed();
    const before = await fx.admin`SELECT * FROM harness_shared.plan_blind_reviews WHERE id = ${s.input.sourceReviewId}`;
    const originalBinding = await fx.admin`SELECT * FROM harness_shared.plan_blind_review_sessions WHERE id = ${s.bindingId}`;
    const key = Symbol('confinement');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const launch = vi.fn(async (args, ctx) => { entered(); await gate; return nativeLaunch(s.input, args, ctx, key); });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    const first = replaceBlindGapReviewer(s.input, s.deps);
    // A refusal before launch must fail its assertion, rather than waiting on
    // a launcher barrier that can no longer open.
    await Promise.race([
      started,
      first.then(result => expect(result).toMatchObject({ ok: true })),
    ]);
    const second = await replaceBlindGapReviewer({ ...s.input }, s.deps);
    expect(second).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1, status: 'launching' } });
    release();
    const complete = await first;
    expect(complete).toMatchObject({ ok: true, attempt: { attemptSeq: 1, status: 'ready' } });
    expect((complete.attempt as { id: number }).id).toBe((second.attempt as { id: number }).id);
    // awaitable-review-post-events-2026-10-27 R-2: the reservation row is the replacement's
    // binding, so the launching and the completed reply hand out the same post key.
    const attemptId = (complete.attempt as { id: number }).id;
    expect(complete).toMatchObject({ bindingId: attemptId, awaitKey: blindReviewPostedEventKey(s.input.slug, attemptId) });
    expect(second.awaitKey).toBe(complete.awaitKey);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await fx.admin`SELECT * FROM harness_shared.plan_blind_reviews WHERE id = ${s.input.sourceReviewId}`).toEqual(before);
    expect(await fx.admin`SELECT * FROM harness_shared.plan_blind_review_sessions WHERE id = ${s.bindingId}`).toEqual(originalBinding);
    expect(await replaceBlindGapReviewer({ ...s.input, productReads: { testFiles: ['other.test.ts'] } }, s.deps))
      .toMatchObject({ ok: false, error: 'request_conflict' });
  });

  it('retains failed attempts and admits a new ordered request only after a definite no-process receipt', async () => {
    const s = await seed();
    const launch = vi.fn(async () => ({ isError: true, data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } }));
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    const failedAttempt = await replaceBlindGapReviewer(s.input, s.deps);
    expect(failedAttempt).toMatchObject({ ok: true, attempt: { attemptSeq: 1, status: 'failed' } });
    // A confirmed-inactive attempt never posts, so it hands out no key to sleep on.
    expect(failedAttempt).not.toHaveProperty('awaitKey');
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1 } });
    const next = await replaceBlindGapReviewer({ ...s.input, requestKey: 'retry-after-refusal' }, s.deps);
    expect(next).toMatchObject({ ok: true, attempt: { attemptSeq: 2, status: 'failed' },
      attempts: [{ attemptSeq: 1, requestKey: 'corrected-manifest' }, { attemptSeq: 2, requestKey: 'retry-after-refusal' }] });
    // Each launching request walks the whole backend ladder (EI-27127088253419654): a proven
    // pre-spawn refusal falls through, in order, reusing the reservation's launch key.
    expect(launch).toHaveBeenCalledTimes(2 * BLIND_REVIEWER_BACKENDS.length);
    const firstRequest = (launch.mock.calls as unknown as Array<[Record<string, unknown>]>)
      .slice(0, BLIND_REVIEWER_BACKENDS.length).map(([args]) => args);
    expect(firstRequest.map(a => [a.agent, a.model, a.effort]))
      .toEqual(BLIND_REVIEWER_BACKENDS.map(b => [b.agent, b.model, b.effort]));
    expect(new Set(firstRequest.map(a => a.idempotencyKey)).size).toBe(1);
  });

  it('never repeats an uncertain launch, and reconciles a lost reply using the original native ledger receipt', async () => {
    const s = await seed();
    const key = Symbol('confinement');
    const launch = vi.fn(async (args, ctx) => { await nativeLaunch(s.input, args, ctx, key); throw new Error('reply lost after spawn'); });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, attempt: { status: 'uncertain' } });
    expect(await replaceBlindGapReviewer({ ...s.input, requestKey: 'another-equivalent-request' }, s.deps))
      .toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1, status: 'ready' } });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('binds the original reviewer when its native id arrives after the immutable launch receipt', async () => {
    const s = await seed();
    const key = Symbol('confinement');
    let delayed: { ownerId: string; advSessionId: number; sessionId: string } | undefined;
    const launch = vi.fn(async (args, ctx) => {
      const result = await nativeLaunch(s.input, args, ctx, key);
      delayed = result.data.launch.freshVerdict.sessions[0]!;
      await fx.admin`UPDATE harness_shared.adv_sessions SET session_id = NULL WHERE id = ${delayed.advSessionId}`;
      const summary = { ...result.data.launch,
        freshVerdict: { sessions: [{ ...delayed, sessionId: null }] } };
      await fx.admin`UPDATE harness_shared.agent_launch_idempotency SET summary = ${fx.admin.json(summary as never)}
        WHERE workspace_id = ${WS} AND idempotency_key = ${String(args.idempotencyKey)}`;
      return { data: { launch: summary } };
    });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    const pending = await replaceBlindGapReviewer(s.input, s.deps);
    expect(pending).toMatchObject({ ok: true, attempt: { status: 'uncertain' } });
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, deduped: true,
      attempt: { status: 'uncertain' } });
    expect(delayed).toBeDefined();
    await fx.admin`UPDATE harness_shared.adv_sessions SET session_id = ${delayed!.sessionId} WHERE id = ${delayed!.advSessionId}`;
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, deduped: true,
      attempt: { status: 'ready', reviewerOwnerId: delayed!.ownerId, advSessionId: delayed!.advSessionId,
        nativeSessionId: delayed!.sessionId } });
    const [attempt] = await fx.admin`SELECT launch_result FROM harness_shared.plan_blind_review_sessions
      WHERE id = ${Number((pending.attempt as { id: number }).id)}`;
    expect(attempt!.launch_result.data.launch.freshVerdict.sessions[0].sessionId).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('permits recovery after a confirmed failed start, preserving the ended native identity in ordered history', async () => {
    const s = await seed();
    const key = Symbol('confinement');
    const launch = vi.fn(async (args, ctx) => {
      const result = await nativeLaunch(s.input, args, ctx, key);
      if (launch.mock.calls.length === 1) {
        const receipt = result.data.launch.freshVerdict.sessions[0];
        await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = now() WHERE id = ${receipt.advSessionId}`;
        return { ...result, isError: true, data: { launch: { ...result.data.launch, agentStarted: false } } };
      }
      return result;
    });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    const failed = await replaceBlindGapReviewer(s.input, s.deps);
    expect(failed).toMatchObject({ ok: true, attempt: { status: 'failed', attemptSeq: 1 } });
    expect((failed.attempt as { nativeSessionId: string }).nativeSessionId).toBeTruthy();
    const recovered = await replaceBlindGapReviewer({ ...s.input, requestKey: 'new-after-confirmed-exit' }, s.deps);
    expect(recovered).toMatchObject({ ok: true, attempt: { status: 'ready', attemptSeq: 2 },
      attempts: [{ status: 'failed', attemptSeq: 1 }, { status: 'ready', attemptSeq: 2 }] });
    expect((recovered.attempts as unknown[])[0]).toEqual(failed.attempt);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('does not release a failed-start receipt while its exact native writer is still live', async () => {
    const s = await seed();
    const key = Symbol('confinement');
    const launch = vi.fn(async (args, ctx) => {
      const result = await nativeLaunch(s.input, args, ctx, key);
      return { ...result, isError: true, data: { launch: { ...result.data.launch, agentStarted: false } } };
    });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: true, attempt: { status: 'ready', attemptSeq: 1 } });
    expect(await replaceBlindGapReviewer({ ...s.input, requestKey: 'duplicate' }, s.deps))
      .toMatchObject({ ok: true, deduped: true, attempt: { status: 'ready', attemptSeq: 1 } });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('keeps a no-receipt timeout reserved across retries with different request keys', async () => {
    const s = await seed();
    const launch = vi.fn(async () => { throw new Error('unknown spawn outcome'); });
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    await replaceBlindGapReviewer(s.input, s.deps);
    const repeated = await replaceBlindGapReviewer({ ...s.input, requestKey: 'retry' }, s.deps);
    expect(repeated).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1, status: 'uncertain' } });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('refuses to admit a related native reviewer and keeps its uncertain attempt protected', async () => {
    const s = await seed();
    const key = Symbol('confinement');
    const launch = vi.fn((args, ctx) => nativeLaunch(s.input, args, ctx, key));
    s.deps.launcher = async () => ({ handler: launch, confinementKey: key });
    s.deps.lineageRelated = async () => true;
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: false, error: 'reviewer_not_independent' });
    const [attempt] = await fx.admin`SELECT status, reviewer_owner_id FROM harness_shared.plan_blind_review_sessions
      WHERE replacement_of = ${s.bindingId}`;
    expect(attempt).toMatchObject({ status: 'uncertain', reviewer_owner_id: null });
    expect(await replaceBlindGapReviewer({ ...s.input, requestKey: 'must-not-relaunch' }, s.deps))
      .toMatchObject({ ok: false, error: 'reviewer_not_independent' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('refuses unauthorized, forged-owner, stale-activation, missing-source and missing-path requests before launch', async () => {
    const s = await seed();
    const launch = vi.fn();
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    const stranger = { workspaceId: WS, principal: { kind: 'agent', slug: 'su-stranger', workspaceId: WS }, ownerId: AUTHOR };
    expect(await replaceBlindGapReviewer({ ...s.input, ctx: stranger }, s.deps)).toMatchObject({ ok: false, error: 'recruiter_only' });
    expect(await replaceBlindGapReviewer({ ...s.input, activationAuditSeq: 4 }, s.deps)).toMatchObject({ ok: false, error: 'activation_audit_mismatch' });
    expect(await replaceBlindGapReviewer({ ...s.input, sourceReviewId: 123456789 }, s.deps)).toMatchObject({ ok: false, error: 'source_review_mismatch' });
    expect(await replaceBlindGapReviewer({ ...s.input, productReads: { testFiles: ['missing.test.ts'] } }, s.deps)).toMatchObject({ ok: false, error: 'invalid_product_reads' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['live', 'resuming', 'conclusive'])('rechecks %s protection at the transaction boundary', async kind => {
    const s = await seed();
    const launch = vi.fn();
    s.deps.launcher = async () => ({ handler: launch, confinementKey: Symbol() });
    s.deps.loadBrief = async () => {
      if (kind === 'live') await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE id = ${s.nativeId}`;
      if (kind === 'resuming') await fx.admin`UPDATE harness_shared.adv_sessions SET resume_claim_key = 'active' WHERE id = ${s.nativeId}`;
      if (kind === 'conclusive') {
        // Material is append-only: swap the source binding to a separately posted
        // conclusive receipt rather than editing any old review.
        const [review] = await fx.admin<Array<{ id: number }>>`INSERT INTO harness_shared.plan_blind_reviews
          (workspace_id, harness_slug, plan_slug, record_kind, activation_audit_seq, created_by, outcome)
          VALUES (${WS}, ${s.input.harness}, ${s.input.slug}, 'review', 5, ${s.reviewer}, 'conclusive') RETURNING id`;
        s.input.sourceReviewId = Number(review!.id);
        await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET review_id = ${s.input.sourceReviewId} WHERE id = ${s.bindingId}`;
      }
      return s.brief;
    };
    expect(await replaceBlindGapReviewer(s.input, s.deps)).toMatchObject({ ok: false, error: 'review_protected' });
    expect(launch).not.toHaveBeenCalled();
  });
});
