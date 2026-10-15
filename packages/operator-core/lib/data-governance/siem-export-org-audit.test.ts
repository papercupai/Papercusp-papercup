/**
 * Unit tests for the organization-audit SIEM stream (P-008b, WI-6554700010012184; plan
 * papercusp-enterprise-readiness-roadmap-2026-10-09 D-018/D-019): the column classification is
 * pinned to the hosted customer data map, organization data receipts (P-007c) are projected by
 * declaration rather than copied, the cursor is strict, and an org-audit batch carries its key id
 * and verifies against its own stream's cursor uid scheme.
 */
import { describe, expect, it } from 'vitest';
import { classifyCustomerColumn, customerDataTable } from '../auth/hosted/customer-data-map';
import { ORGANIZATION_DATA_RECEIPT_VERSION, RECEIPT_ACTIONS } from './organization-data-receipts';
import {
  SIEM_WITHHELD_FREE_TEXT,
  buildSiemBatch,
  siemArgsDigest,
  siemClassificationProblems,
  siemCodeValue,
  siemCursorUid,
  siemPseudonym,
  siemStreamId,
  verifySiemBatchJsonl,
} from './siem-export';
import {
  ORG_AUDIT_COLUMNS,
  ORG_AUDIT_CURSOR_START,
  ORG_AUDIT_LOG_NAME,
  codeValue,
  decodeOrgAuditCursor,
  encodeOrgAuditCursor,
  isReceiptEvent,
  orgAuditStreamId,
  projectOrgAuditEvent,
  projectReceiptMetadata,
  type OrgAuditRow,
} from './siem-export-org-audit';

const KEY = 'k'.repeat(32);
const OTHER_KEY = 'q'.repeat(32);
const ORG = '11111111-1111-4111-8111-111111111111';
const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ID2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const OCCURRED = '2026-10-14T00:00:00.000Z';
const RECORDED = '2026-10-14T00:00:01.000Z';

const ACTOR_ID = 'user-canary-42';
const PROVIDER_USER = 'alice.canary@example.com';
const FREE_TEXT_PURPOSE = 'requested by Bob Canary on the phone';
const UNDECLARED_VALUE = 'Alice Canary left a private note';

function deletionReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptVersion: ORGANIZATION_DATA_RECEIPT_VERSION,
    operation: 'deletion',
    workspaceIds: ['ws-1'],
    populationSize: 3,
    stores: [
      {
        store: 'work_items',
        executor: 'org-deletion',
        retention: 'standard',
        outcome: 'deleted',
        rowCount: 3,
        rowsRemaining: 0,
        exportedColumns: [],
        excludedColumns: ['body'],
        reason: 'retention-policy',
      },
    ],
    limitations: ['backups-age-out'],
    codeVersion: 'abc123',
    schemaVersion: '1499',
    revocations: [
      {
        workspaceId: 'ws-1',
        provider: 'google',
        providerUserId: PROVIDER_USER,
        mappingsRevoked: 2,
        readableDocuments: 0,
        denied: true,
      },
    ],
    ...overrides,
  };
}

function row(overrides: Partial<Record<keyof OrgAuditRow, unknown>> = {}): OrgAuditRow {
  return {
    id: ID1,
    organization_id: ORG,
    workspace_id: 'ws-1',
    actor_kind: 'customer_user',
    actor_id: ACTOR_ID,
    action: RECEIPT_ACTIONS.deletion,
    purpose: FREE_TEXT_PURPOSE,
    target_type: 'organization',
    target_id: ORG,
    metadata: deletionReceipt(),
    occurred_at: OCCURRED,
    recorded_at: RECORDED,
    ...overrides,
  };
}

describe('organization audit column classification', () => {
  const qualified = 'papercusp_auth.organization_audit_events';

  it('classifies exactly the columns the hosted customer data map declares for the table', () => {
    const declared = customerDataTable(qualified);
    expect(declared).toBeDefined();
    const live = Object.values(declared!.columns).flat().sort();
    expect(Object.keys(ORG_AUDIT_COLUMNS).sort()).toEqual(live);
  });

  /**
   * Columns the SIEM projection deliberately treats MORE strictly than the hosted data map. The
   * data map calls actor_id operational (an opaque account id inside our own store); once it
   * leaves for a customer's third-party SIEM it identifies the acting person, so it is pseudonymized.
   */
  const STRICTER_THAN_DATA_MAP: Readonly<Record<string, string>> = { actor_id: 'pii' };

  it('is never laxer than the data map, and every stricter column is declared', () => {
    const actual: Record<string, string> = {};
    for (const [column, c] of Object.entries(ORG_AUDIT_COLUMNS)) {
      const mapped = classifyCustomerColumn(qualified, column);
      if (c.dataClass !== mapped) actual[column] = c.dataClass;
      if (mapped !== 'operational') expect({ column, dataClass: c.dataClass }).toEqual({ column, dataClass: mapped });
    }
    expect(actual).toEqual(STRICTER_THAN_DATA_MAP);
    expect(siemClassificationProblems(ORG_AUDIT_COLUMNS)).toEqual([]);
  });
});

describe('organization audit cursor', () => {
  const cursor = { recordedAt: '2026-10-14T00:00:01.123456Z', id: ID1 };

  it('round-trips a microsecond cursor and treats the start sentinel as no position', () => {
    expect(decodeOrgAuditCursor(encodeOrgAuditCursor(cursor))).toEqual(cursor);
    expect(decodeOrgAuditCursor(ORG_AUDIT_CURSOR_START)).toBeNull();
  });

  it('refuses millisecond times, non-uuid ids and extra segments', () => {
    expect(() => encodeOrgAuditCursor({ recordedAt: '2026-10-14T00:00:01.123Z', id: ID1 })).toThrow(/invalid cursor/);
    expect(() => encodeOrgAuditCursor({ recordedAt: cursor.recordedAt, id: 'not-a-uuid' })).toThrow(/invalid cursor/);
    expect(() => decodeOrgAuditCursor(`${cursor.recordedAt}|${ID1}|extra`)).toThrow(/is not/);
    expect(() => decodeOrgAuditCursor('42')).toThrow(/is not/);
  });

  it('maps each stream cursor to the event uid scheme the verifier checks', () => {
    expect(siemCursorUid(orgAuditStreamId(ORG), encodeOrgAuditCursor(cursor))).toBe(`oae:${ID1}`);
    expect(siemCursorUid(siemStreamId('ws-1'), '42')).toBe('ti:42');
  });
});

describe('codeValue and receipt detection', () => {
  it('passes code-shaped values and withholds free text', () => {
    expect(codeValue('organization.data.export')).toBe('organization.data.export');
    expect(codeValue(5)).toBe('5');
    expect(codeValue(null)).toBeNull();
    expect(codeValue(FREE_TEXT_PURPOSE)).toBe(SIEM_WITHHELD_FREE_TEXT);
    // D-018 item 4: target_id is emit-code, and an organization target is a uuid.
    expect(codeValue(ORG)).toBe(ORG);
  });

  it('shares the tool-invocation stream emit-code predicate (WI-6554700010012363)', () => {
    expect(codeValue).toBe(siemCodeValue);
  });

  it('trusts the declared projection only for a receipt action carrying the current receipt version', () => {
    expect(isReceiptEvent(RECEIPT_ACTIONS.export, deletionReceipt())).toBe(true);
    expect(isReceiptEvent('organization.member.invited', deletionReceipt())).toBe(false);
    expect(isReceiptEvent(RECEIPT_ACTIONS.export, deletionReceipt({ receiptVersion: 'organization-data-receipt-v0' }))).toBe(false);
    expect(isReceiptEvent(RECEIPT_ACTIONS.export, [deletionReceipt()])).toBe(false);
    expect(isReceiptEvent(RECEIPT_ACTIONS.export, null)).toBe(false);
  });
});

describe('projectReceiptMetadata', () => {
  it('copies declared keys, pseudonymizes revoked provider users and digests undeclared keys', () => {
    const meta = deletionReceipt({ privateNote: UNDECLARED_VALUE });
    const out = projectReceiptMetadata(meta, KEY);
    expect(out.operation).toBe('deletion');
    expect(out.populationSize).toBe(3);
    expect(out.workspaceIds).toEqual(['ws-1']);
    expect(out.revocations).toEqual([
      {
        workspaceId: 'ws-1',
        provider: 'google',
        providerUserId: siemPseudonym(KEY, PROVIDER_USER),
        mappingsRevoked: 2,
        readableDocuments: 0,
        denied: true,
      },
    ]);
    expect(out.undeclared).toEqual(siemArgsDigest(KEY, { privateNote: UNDECLARED_VALUE }));
    const text = JSON.stringify(out);
    expect(text).not.toContain(PROVIDER_USER);
    expect(text).not.toContain(UNDECLARED_VALUE);
  });

  it('drops the reason of a failed store and omits absent optional sections', () => {
    const failed = deletionReceipt({
      stores: [{ store: 'work_items', outcome: 'failed', reason: 'error near secret value XYZ', rowCount: 1 }],
      revocations: undefined,
    });
    delete failed.revocations;
    const out = projectReceiptMetadata(failed, KEY);
    expect((out.stores as { reason: unknown }[])[0]!.reason).toBeNull();
    expect('revocations' in out).toBe(false);
    expect('holdConflicts' in out).toBe(false);
    expect('undeclared' in out).toBe(false);
  });
});

describe('projectOrgAuditEvent', () => {
  it('projects a receipt event with keyed pseudonyms and no raw personal or free text', () => {
    const event = projectOrgAuditEvent(row(), KEY) as Record<string, any>;
    expect(event.metadata.uid).toBe(`oae:${ID1}`);
    expect(event.metadata.log_name).toBe(ORG_AUDIT_LOG_NAME);
    expect(event.metadata.tenant_uid).toBe(ORG);
    expect(event.time).toBe(Date.parse(OCCURRED));
    expect(event.metadata.logged_time).toBe(Date.parse(RECORDED));
    expect(event.status_id).toBe(1);
    expect(event.actor.user.uid).toBe(siemPseudonym(KEY, ACTOR_ID));
    expect(event.unmapped.papercusp_source.purpose).toBe(SIEM_WITHHELD_FREE_TEXT);
    expect(event.unmapped.papercusp_metadata.kind).toBe('receipt');
    expect(event.resources).toEqual([{ type: 'organization', uid: ORG }]);
    const text = JSON.stringify(event);
    for (const raw of [ACTOR_ID, PROVIDER_USER, FREE_TEXT_PURPOSE]) expect(text).not.toContain(raw);
  });

  it('marks a receipt with a failed store as a failure', () => {
    const failed = deletionReceipt({ stores: [{ store: 'work_items', outcome: 'failed', rowCount: 1 }] });
    expect((projectOrgAuditEvent(row({ metadata: failed }), KEY) as Record<string, any>).status_id).toBe(2);
  });

  it('reduces non-receipt metadata to a keyed digest, including a stored JSON string', () => {
    const meta = { invitedEmail: PROVIDER_USER, role: 'admin' };
    const plain = projectOrgAuditEvent(row({ action: 'organization.member.invited', metadata: meta }), KEY) as Record<string, any>;
    const stringy = projectOrgAuditEvent(
      row({ action: 'organization.member.invited', metadata: JSON.stringify(meta) }),
      KEY,
    ) as Record<string, any>;
    expect(plain.unmapped.papercusp_metadata).toEqual({ kind: 'digest', digest: siemArgsDigest(KEY, meta) });
    expect(stringy.unmapped.papercusp_metadata).toEqual(plain.unmapped.papercusp_metadata);
    expect(JSON.stringify(plain)).not.toContain(PROVIDER_USER);
  });

  it('does not trust a receipt-shaped payload under a foreign receipt version', () => {
    const forged = deletionReceipt({ receiptVersion: 'organization-data-receipt-v0' });
    const event = projectOrgAuditEvent(row({ metadata: forged }), KEY) as Record<string, any>;
    expect(event.unmapped.papercusp_metadata.kind).toBe('digest');
  });

  it('uses the key: a different export key yields different pseudonyms', () => {
    const a = projectOrgAuditEvent(row(), KEY) as Record<string, any>;
    const b = projectOrgAuditEvent(row(), OTHER_KEY) as Record<string, any>;
    expect(a.actor.user.uid).not.toBe(b.actor.user.uid);
  });

  it('refuses a row without a uuid id or with an unparseable time', () => {
    expect(() => projectOrgAuditEvent(row({ id: '42' }), KEY)).toThrow(/not a uuid/);
    expect(() => projectOrgAuditEvent(row({ recorded_at: 'yesterday' }), KEY)).toThrow(/invalid occurred_at/);
  });
});

describe('org-audit batches', () => {
  const streamId = orgAuditStreamId(ORG);
  const cursor1 = encodeOrgAuditCursor({ recordedAt: '2026-10-14T00:00:01.000000Z', id: ID1 });
  const event1 = projectOrgAuditEvent(row(), KEY);

  it('stamps the key id into the manifest and the idempotency key', () => {
    const base = { streamId, prevHead: null, cursorFrom: ORG_AUDIT_CURSOR_START, entries: [{ id: cursor1, event: event1 }] };
    const k1 = buildSiemBatch({ ...base, keyId: 'kid-1' });
    const k2 = buildSiemBatch({ ...base, keyId: 'kid-2' });
    const none = buildSiemBatch(base);
    expect(k1.manifest.keyId).toBe('kid-1');
    expect('keyId' in none.manifest).toBe(false);
    expect(new Set([k1.manifest.idempotencyKey, k2.manifest.idempotencyKey, none.manifest.idempotencyKey]).size).toBe(3);
    expect(buildSiemBatch({ ...base, keyId: 'kid-1' }).manifest.idempotencyKey).toBe(k1.manifest.idempotencyKey);
  });

  it('verifies against the org-audit cursor uid scheme and rejects a mismatched cursor', () => {
    const good = buildSiemBatch({ streamId, prevHead: null, cursorFrom: ORG_AUDIT_CURSOR_START, entries: [{ id: cursor1, event: event1 }], keyId: 'kid-1' });
    const verdict = verifySiemBatchJsonl(good.jsonl);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.events).toEqual([event1]);

    const wrongCursor = encodeOrgAuditCursor({ recordedAt: '2026-10-14T00:00:01.000000Z', id: ID2 });
    const bad = buildSiemBatch({ streamId, prevHead: null, cursorFrom: ORG_AUDIT_CURSOR_START, entries: [{ id: wrongCursor, event: event1 }] });
    const refused = verifySiemBatchJsonl(bad.jsonl);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/does not match the last event/);
  });

  it('refuses to chain a batch onto another stream head', () => {
    const tiHead = buildSiemBatch({ workspaceId: 'ws-1', prevHead: null, cursorFrom: '0', entries: [] }).head;
    const otherOrg = buildSiemBatch({
      streamId: orgAuditStreamId('22222222-2222-4222-8222-222222222222'),
      prevHead: null,
      cursorFrom: ORG_AUDIT_CURSOR_START,
      entries: [{ id: cursor1, event: event1 }],
    });
    expect(tiHead).toBeNull();
    expect(() =>
      buildSiemBatch({ streamId, prevHead: otherOrg.head, cursorFrom: cursor1, entries: [] }),
    ).toThrow(/belongs to stream/);
  });
});
