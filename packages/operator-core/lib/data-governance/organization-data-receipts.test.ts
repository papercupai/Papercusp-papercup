/**
 * Organization data receipts — the pure half (WI-6554700010011593, enterprise P-007c).
 * The plan must cover the whole declared population, never export a secret-class column,
 * and give each retention class its deletion treatment. The receipt metadata must pass the
 * governance payload guard even though store names such as hosted_cli_tokens look like
 * forbidden keys.
 */
import { describe, expect, it } from 'vitest';
import { assertGovernancePayloadSafe } from '../auth/hosted/governance';
import { HOSTED_CUSTOMER_DATA_TABLES, qualifiedName } from '../auth/hosted/customer-data-map';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { pilotStorePopulation } from './pilot-processing-map';
import {
  ACCESS_SHAPED_COLUMN,
  DATA_SOURCE_DEPENDENTS,
  authorizeDataOperation,
  deletionOrder,
  holdConflicts,
  planOrganizationDataOperation,
  receiptMetadata,
  validateScope,
  type StoreReceipt,
} from './organization-data-receipts';

const ORG = '11111111-1111-4111-8111-111111111111';

describe('shared legal-hold receipt helpers', () => {
  it('exports the helpers required by legal-hold administration and normalizes its scope', async () => {
    // Keep the consumer on the real import graph: a missing ESM export must
    // fail this suite before it can prevent the operator from starting.
    const legalHolds = await import('./legal-holds');
    expect(typeof legalHolds.listOrganizationLegalHolds).toBe('function');
    expect(typeof holdConflicts).toBe('function');
    expect(validateScope({ organizationId: ORG, workspaceIds: ['one', 'one', 'two'] }))
      .toEqual({ organizationId: ORG, workspaceIds: ['one', 'two'] });
    expect(() => validateScope({ organizationId: ORG, workspaceIds: [] }))
      .toThrow('at least one workspaceId');
  });
});

describe('planOrganizationDataOperation', () => {
  const plan = planOrganizationDataOperation();

  it('gives every population store exactly one treatment, in population order', () => {
    expect(plan.map((t) => t.store)).toEqual(pilotStorePopulation().map((p) => p.qualified));
  });

  it('never lists a secret-class hosted column as exportable', () => {
    for (const table of HOSTED_CUSTOMER_DATA_TABLES) {
      const t = plan.find((p) => p.store === qualifiedName(table))!;
      // Every map-secret column is excluded; anything else excluded must be access-shaped
      // (the name backstop), and no exported column is secret or access-shaped.
      for (const secret of table.columns.secret) {
        expect(t.excludedColumns).toContain(secret);
        expect(t.exportColumns).not.toContain(secret);
      }
      for (const excluded of t.excludedColumns) {
        expect(table.columns.secret.includes(excluded) || ACCESS_SHAPED_COLUMN.test(excluded), excluded).toBe(true);
      }
      for (const exported of t.exportColumns ?? []) expect(ACCESS_SHAPED_COLUMN.test(exported), exported).toBe(false);
    }
    const tokens = plan.find((p) => p.store === 'papercusp_auth.hosted_cli_tokens')!;
    expect(tokens.excludedColumns).toContain('token_hash');
  });

  it('excludes the pilot data_sources credential reference and catches access-shaped names', () => {
    const sources = plan.find((p) => p.store === 'harness_shared.data_sources')!;
    expect(sources.executor).toBe('pilot-data-plane');
    expect(sources.excludedColumns).toContain('credential_ref');
    expect(ACCESS_SHAPED_COLUMN.test('credential_ref')).toBe(true);
    expect(ACCESS_SHAPED_COLUMN.test('device_code_hash')).toBe(true);
    expect(ACCESS_SHAPED_COLUMN.test('workspace_id')).toBe(false);
    for (const name of ['token_hash', 'access_token', 'refresh_token', 'api_key', 'password_hash', 'client_secret']) {
      expect(ACCESS_SHAPED_COLUMN.test(name), name).toBe(true);
    }
    const usage = plan.find((p) => p.store === 'papercusp_auth.hosted_usage_receipts')!;
    expect(usage.excludedColumns).toContain('openrouter_credential_ref');
    expect(usage.exportColumns).not.toContain('openrouter_credential_ref');
    // The map itself classes every access-shaped hosted column as secret, so the name backstop
    // above is never the only thing keeping a credential out of an export.
    for (const table of HOSTED_CUSTOMER_DATA_TABLES) {
      for (const cls of ['pii', 'billing', 'operational'] as const) {
        for (const col of table.columns[cls]) {
          expect(ACCESS_SHAPED_COLUMN.test(col), `${qualifiedName(table)}.${col} is ${cls}`).toBe(false);
        }
      }
    }
    // Content and usage columns of pilot stores are not access material and stay exportable.
    for (const name of ['content_hash', 'input_tokens', 'output_tokens', 'source_ref']) {
      expect(ACCESS_SHAPED_COLUMN.test(name), name).toBe(false);
    }
  });

  it('deletes hold-aware chat and document stores unless held, and retains audit and billing records', () => {
    const by = (s: string) => plan.find((p) => p.store === s)!.deletion.action;
    expect(by('harness_shared.chat_messages')).toBe('delete-unless-held');
    expect(by('harness_shared.chat_retrieval_units')).toBe('delete-unless-held');
    expect(by('harness_shared.data_sources')).toBe('delete-unless-held');
    // P-017a (migration 1502): a held document keeps its row, its permission list and the list's members.
    expect(by('harness_shared.documents')).toBe('delete-unless-held');
    expect(by('harness_shared.document_permission_lists')).toBe('delete-unless-held');
    expect(by('harness_shared.document_permission_members')).toBe('delete-unless-held');
    expect(by('harness_shared.data_source_legal_holds')).toBe('retain');
    expect(by('papercusp_auth.organization_audit_events')).toBe('retain');
    expect(by('papercusp_auth.hosted_subscriptions')).toBe('retain');
    expect(by('papercusp_auth.webhook_event_receipts')).toBe('not-attributable');
  });

  it('deletes every data-source dependent through the pilot executor, before its source', () => {
    const order = deletionOrder(plan).map((t) => t.store);
    expect(order).toHaveLength(plan.length);
    expect(new Set(order)).toEqual(new Set(plan.map((t) => t.store)));
    const sources = order.indexOf('harness_shared.data_sources');
    for (const store of DATA_SOURCE_DEPENDENTS) {
      const t = plan.find((p) => p.store === store);
      expect(t, store).toBeDefined();
      expect(t!.executor, store).toBe('pilot-data-plane');
      expect(t!.deletion.action, store).toBe('delete');
      expect(order.indexOf(store), store).toBeLessThan(sources);
    }
    // trigger_runs references both trigger parents ON DELETE RESTRICT, so it goes first — and that
    // holds whatever order the plan lists the stores in.
    for (const input of [plan, [...plan].reverse()]) {
      const dependentsInOrder = deletionOrder(input).map((t) => t.store).filter((s) => DATA_SOURCE_DEPENDENTS.includes(s));
      expect(dependentsInOrder).toEqual([...DATA_SOURCE_DEPENDENTS]);
    }
    expect(order.indexOf('harness_shared.trigger_runs')).toBeLessThan(order.indexOf('harness_shared.trigger_bindings'));
    expect(order.indexOf('harness_shared.trigger_runs')).toBeLessThan(order.indexOf('harness_shared.trigger_deliveries'));
    expect(order.indexOf('harness_shared.document_permission_members'))
      .toBeLessThan(order.indexOf('harness_shared.document_permission_lists'));
    expect(order.at(-1)).toBe('harness_shared.data_sources');
  });

  it('never exports trigger or push secret ciphertext', () => {
    const by = (s: string) => plan.find((p) => p.store === s)!;
    expect(by('harness_shared.trigger_webhook_secrets').excludedColumns).toEqual(['secret_ct', 'previous_secret_ct']);
    expect(by('harness_shared.connector_push_secrets').excludedColumns).toEqual(['secret_ct']);
    for (const name of ['secret_ct', 'previous_secret_ct']) expect(ACCESS_SHAPED_COLUMN.test(name), name).toBe(true);
  });

  it('routes hosted tables to the hosted executor, even when the pilot map names them', () => {
    const audit = plan.find((p) => p.store === 'papercusp_auth.organization_audit_events')!;
    expect(audit.executor).toBe('hosted-control-plane');
    expect(audit.attribution).toEqual({ kind: 'organization-column', column: 'organization_id' });
  });
});

describe('receipt metadata', () => {
  it('passes the governance payload guard for the full population', () => {
    const stores: StoreReceipt[] = planOrganizationDataOperation().map((t) => ({
      store: t.store, executor: t.executor, retention: t.retention, outcome: 'deferred', rowCount: null,
      rowsRemaining: null, exportedColumns: t.exportColumns, excludedColumns: t.excludedColumns, reason: t.deletion.reason,
    }));
    const meta = receiptMetadata({
      operation: 'export', scope: { organizationId: ORG, workspaceIds: ['ws-a'] }, purpose: 'test', stores,
      limitations: ['none'], schemaVersion: null,
    }, 'abc1234');
    expect(() => assertGovernancePayloadSafe(meta)).not.toThrow();
    expect(JSON.stringify(meta)).toContain('papercusp_auth.hosted_cli_tokens');
  });
});

describe('authorizeDataOperation', () => {
  const principal = (permissions: string[], org = ORG) => createHostedPrincipal({
    workspaceId: 'control', userId: '22222222-2222-4222-8222-222222222222', activeOrganizationId: org,
    sessionId: 'session', sessionVersion: 1, permissions: permissions as never,
  });

  it('lets an administrator export and delete', () => {
    const p = principal(['members:manage', 'workspace:destroy']);
    expect(authorizeDataOperation('export', ORG, { kind: 'customer_user', principal: p }).actorKind).toBe('customer_user');
    expect(authorizeDataOperation('deletion', ORG, { kind: 'customer_user', principal: p }).actorId).toBe(p.userId);
  });

  it('permits a member to export only their own user scope, without granting organization export or deletion', () => {
    const p = principal(['workspace:view']);
    const actor = { kind: 'customer_user' as const, principal: p };
    expect(authorizeDataOperation('export', ORG, actor, p.userId).actorId).toBe(p.userId);
    expect(() => authorizeDataOperation('export', ORG, actor, '33333333-3333-4333-8333-333333333333'))
      .toThrow('requires members:manage');
    expect(() => authorizeDataOperation('deletion', ORG, actor, p.userId)).toThrow('requires workspace:destroy');
  });

  it('refuses a member without the permission, and a principal of another organization', () => {
    expect(() => authorizeDataOperation('export', ORG, { kind: 'customer_user', principal: principal(['workspace:view']) }))
      .toThrow(/requires members:manage/);
    expect(() => authorizeDataOperation('deletion', ORG, {
      kind: 'customer_user', principal: principal(['workspace:destroy'], '33333333-3333-4333-8333-333333333333'),
    })).toThrow(/not acting in this organization/);
  });
});
