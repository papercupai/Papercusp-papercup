import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adv: null as Record<string, unknown> | null,
  binding: null as Record<string, unknown> | null,
}));
const sqlMock = vi.hoisted(() => {
  const mock = vi.fn();
  Object.assign(mock, {
    json: (value: unknown) => value,
    unsafe: (value: string) => value,
    begin: async (run: (tx: unknown) => unknown) => run(mock),
  });
  return mock;
});
const readConfinementMock = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('./capability-envelope/session-confinement-store', () => ({
  readSessionConfinement: (...args: unknown[]) => readConfinementMock(...args),
}));

import {
  BLIND_GAP_REVIEW_ACTOR,
  acquireBlindReviewSessionResume,
  createBlindReviewSessionBinding,
  findBlindReviewSessionBinding,
  recordBlindReviewSessionPost,
  releaseBlindReviewSessionResume,
  verifyBlindReviewSessionBinding,
} from './blind-review-session-bindings';
import type { SessionToolConfinement } from './capability-envelope/session-confinement';

const CONFINEMENT: SessionToolConfinement = {
  denyTools: [],
  denyOutside: ['plans:blind-review', 'capability:bash', 'dev:service_health'],
  denyAmbientContext: true,
  imposedBy: BLIND_GAP_REVIEW_ACTOR,
  reason: 'blind reviewer ceiling',
};

function bindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    workspace_id: 'ws-1',
    harness_slug: 'papercusp',
    plan_slug: 'reviewed-plan',
    activation_audit_seq: 4,
    reviewer_owner_id: 'su-reviewer',
    adv_session_id: 42,
    native_session_id: 'native-review-1',
    launch_parent_owner: BLIND_GAP_REVIEW_ACTOR,
    account_route: 'auto',
    model_spec: null,
    confinement_snapshot: CONFINEMENT,
    status: 'ready',
    resume_lease_id: null,
    resume_lease_expires_at: null,
    review_id: null,
    ...overrides,
  };
}

function configureSql() {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ').replace(/\s+/g, ' ').toLowerCase();
    if (query.includes('from harness_shared.adv_sessions')) return state.adv ? [state.adv] : [];
    if (query.includes('insert into harness_shared.plan_blind_review_sessions')) {
      if (state.binding) return [];
      const [workspaceId, harnessSlug, planSlug, activationAuditSeq, reviewerOwnerId,
        advSessionId, nativeSessionId, launchParentOwner, accountRoute, modelSpec, confinement] = values;
      state.binding = bindingRow({ workspace_id: workspaceId, harness_slug: harnessSlug, plan_slug: planSlug,
        activation_audit_seq: activationAuditSeq, reviewer_owner_id: reviewerOwnerId, adv_session_id: advSessionId,
        native_session_id: nativeSessionId, launch_parent_owner: launchParentOwner, account_route: accountRoute,
        model_spec: modelSpec, confinement_snapshot: confinement });
      return [state.binding];
    }
    if (query.includes('from harness_shared.plan_blind_review_sessions')) {
      const workspaceIndex = values[1] === 'ws-1' ? 1 : 2;
      const workspaceId = values[workspaceIndex];
      if (!state.binding || state.binding.workspace_id !== workspaceId) return [];
      if (query.includes('plan_slug =')) {
        return state.binding.plan_slug === values[workspaceIndex + 1] &&
          Number(state.binding.activation_audit_seq) === Number(values[workspaceIndex + 2]) ? [state.binding] : [];
      }
      return Number(state.binding.adv_session_id) === Number(values[workspaceIndex + 1]) ? [state.binding] : [];
    }
    if (query.includes('update harness_shared.plan_blind_review_sessions')) {
      if (!state.binding) return [];
      if (query.includes("set status = 'resuming'")) {
        const [leaseId, _leaseSec, workspaceId, planSlug, activationSeq] = values;
        const expired = state.binding.status === 'resuming' &&
          Date.parse(String(state.binding.resume_lease_expires_at)) <= Date.now();
        if (state.binding.workspace_id !== workspaceId || state.binding.plan_slug !== planSlug ||
            Number(state.binding.activation_audit_seq) !== Number(activationSeq) ||
            !(state.binding.status === 'ready' || expired)) return [];
        state.binding.status = 'resuming';
        state.binding.resume_lease_id = leaseId;
        state.binding.resume_lease_expires_at = new Date(Date.now() + Number(_leaseSec) * 1000).toISOString();
        return [state.binding];
      }
      if (query.includes("set status = 'ready'")) {
        const [id, leaseId] = values;
        if (Number(state.binding.id) !== Number(id) || state.binding.status !== 'resuming' ||
            state.binding.resume_lease_id !== leaseId) return [];
        state.binding.status = 'ready';
        state.binding.resume_lease_id = null;
        state.binding.resume_lease_expires_at = null;
        return [{ id }];
      }
      if (query.includes("set status = 'posted'")) {
        const [reviewId, workspaceId, planSlug, activationSeq, reviewerOwnerId] = values;
        if (state.binding.workspace_id !== workspaceId || state.binding.plan_slug !== planSlug ||
            Number(state.binding.activation_audit_seq) !== Number(activationSeq) ||
            state.binding.reviewer_owner_id !== reviewerOwnerId ||
            !(state.binding.status === 'ready' || state.binding.status === 'resuming' ||
              state.binding.status === 'posted' && Number(state.binding.review_id) === Number(reviewId))) return [];
        state.binding.status = 'posted';
        state.binding.review_id = reviewId;
        state.binding.resume_lease_id = null;
        state.binding.resume_lease_expires_at = null;
        return [{ id: state.binding.id }];
      }
    }
    throw new Error(`unexpected query: ${query}`);
  });
}

beforeEach(() => {
  state.adv = {
    id: 42,
    workspace_id: 'ws-1',
    coord_owner_id: 'su-reviewer',
    session_id: null,
    agent: 'codex',
    launch_spec: { launchedBy: BLIND_GAP_REVIEW_ACTOR, model: null },
    launch_argv: ['psu', '--headless', '--account=auto'],
  };
  state.binding = null;
  readConfinementMock.mockReset().mockResolvedValue(CONFINEMENT);
  sqlMock.mockReset();
  Object.assign(sqlMock, {
    json: (value: unknown) => value,
    unsafe: (value: string) => value,
    begin: async (run: (tx: unknown) => unknown) => run(sqlMock),
  });
  configureSql();
});

const input = {
  workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'reviewed-plan', activationAuditSeq: 4,
  reviewerOwnerId: 'su-reviewer', advSessionId: 42, nativeSessionId: 'native-review-1',
  launchParentOwner: BLIND_GAP_REVIEW_ACTOR, confinement: CONFINEMENT,
};

describe('typed blind-review session bindings', () => {
  it('stores the verified native ADV row, saved launch profile, parent and confinement snapshot', async () => {
    const result = await createBlindReviewSessionBinding(input);
    expect(result).toMatchObject({ ok: true, created: true, binding: {
      advSessionId: 42, nativeSessionId: 'native-review-1', reviewerOwnerId: 'su-reviewer',
      launchParentOwner: BLIND_GAP_REVIEW_ACTOR, accountRoute: 'auto', modelSpec: null,
      confinementSnapshot: CONFINEMENT,
    } });
    expect(readConfinementMock).toHaveBeenCalledWith('su-reviewer', 'ws-1');
  });

  it('refuses a changed owner, account profile, recruiter lineage or confinement', async () => {
    state.adv = { ...state.adv, coord_owner_id: 'su-other' };
    expect(await createBlindReviewSessionBinding(input)).toMatchObject({ ok: false, code: 'adv_session_mismatch' });
    state.adv = { ...state.adv, coord_owner_id: 'su-reviewer', launch_argv: ['psu', '--headless', '--account=default'] };
    expect(await createBlindReviewSessionBinding(input)).toMatchObject({ ok: false, code: 'launch_profile_mismatch' });
    state.adv = { ...state.adv, launch_argv: ['psu', '--headless', '--account=auto'], launch_spec: { launchedBy: 'su-author' } };
    expect(await createBlindReviewSessionBinding(input)).toMatchObject({ ok: false, code: 'launch_profile_mismatch' });
    state.adv = { ...state.adv, launch_spec: { launchedBy: BLIND_GAP_REVIEW_ACTOR, model: null } };
    readConfinementMock.mockResolvedValueOnce({ ...CONFINEMENT, denyOutside: [] });
    expect(await createBlindReviewSessionBinding(input)).toMatchObject({ ok: false, code: 'confinement_mismatch' });
  });

  it('returns the same binding for an idempotent insert and verifies the current ADV/profile snapshot', async () => {
    const first = await createBlindReviewSessionBinding(input);
    if (!first.ok) throw new Error(first.message);
    const retry = await createBlindReviewSessionBinding(input);
    expect(retry).toMatchObject({ ok: true, created: false, binding: { id: first.binding.id } });
    expect(await verifyBlindReviewSessionBinding(first.binding)).toEqual({ ok: true });
    state.adv = { ...state.adv, launch_argv: ['psu', '--account=default'] };
    expect(await verifyBlindReviewSessionBinding(first.binding)).toMatchObject({ ok: false, code: 'launch_profile_mismatch' });
  });

  it('grants one atomic resume lease, releases only its holder, and records one idempotent post receipt', async () => {
    const created = await createBlindReviewSessionBinding(input);
    if (!created.ok) throw new Error(created.message);
    const [first, second] = await Promise.all([
      acquireBlindReviewSessionResume({ workspaceId: 'ws-1', planSlug: 'reviewed-plan', activationAuditSeq: 4 }),
      acquireBlindReviewSessionResume({ workspaceId: 'ws-1', planSlug: 'reviewed-plan', activationAuditSeq: 4 }),
    ]);
    const lease = first.ok ? first : second;
    const denied = first.ok ? second : first;
    expect(lease.ok).toBe(true);
    expect(denied).toMatchObject({ ok: false, code: 'resume_busy' });
    if (!lease.ok) throw new Error('expected a resume lease');
    expect(await releaseBlindReviewSessionResume(lease.binding.id, '00000000-0000-4000-8000-000000000099')).toBe(false);
    expect(await recordBlindReviewSessionPost({ workspaceId: 'ws-1', planSlug: 'reviewed-plan',
      activationAuditSeq: 4, reviewerOwnerId: 'su-reviewer', reviewId: 91 })).toBe(true);
    expect(await recordBlindReviewSessionPost({ workspaceId: 'ws-1', planSlug: 'reviewed-plan',
      activationAuditSeq: 4, reviewerOwnerId: 'su-reviewer', reviewId: 91 })).toBe(true);
    expect(await recordBlindReviewSessionPost({ workspaceId: 'ws-1', planSlug: 'reviewed-plan',
      activationAuditSeq: 4, reviewerOwnerId: 'su-reviewer', reviewId: 92 })).toBe(false);
    const posted = await findBlindReviewSessionBinding({ workspaceId: 'ws-1', planSlug: 'reviewed-plan', activationAuditSeq: 4 });
    expect(posted).toMatchObject({ status: 'posted', reviewId: 91, resumeLeaseId: null });
    expect(await releaseBlindReviewSessionResume(lease.binding.id, lease.leaseId)).toBe(false);
  });
});
