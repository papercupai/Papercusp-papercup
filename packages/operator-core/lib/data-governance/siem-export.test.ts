/**
 * P-008a (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-6554700010011903, D-017): the pure
 * half of the redacted SIEM export. Column classification pinned to the live schema, redaction (keyed
 * pseudonyms, keyed argument digests, free-text and credential withholding), the policy chain in effect
 * at an event's time, the settled-prefix cursor rule, and the tamper chain: continuation, empty
 * segments, edit/drop/reorder/truncation detection and byte-identical replay.
 */
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { generated } from '@papercusp/db-org';
import type { PolicyLayerVersion } from '../governance-policy/store';
import {
  SIEM_READ_COLUMNS,
  SIEM_SOURCE_COLUMNS,
  SIEM_WITHHELD_CREDENTIAL,
  SIEM_CODE_SHAPED,
  SIEM_WITHHELD_FREE_TEXT,
  buildSiemBatch,
  isDeniedInvocation,
  policyAt,
  projectSiemEvent,
  settledPrefix,
  siemArgsDigest,
  siemClassificationProblems,
  siemCodeValue,
  siemPseudonym,
  verifySiemBatchJsonl,
  type SiemBatchEntry,
  type SiemPolicyLayerRef,
  type SiemSourceRow,
} from './siem-export';

const KEY = 'k'.repeat(32);
const OTHER_KEY = 'q'.repeat(32);
const T0 = Date.parse('2026-10-14T00:00:00.000Z');
const at = (min: number): Date => new Date(T0 + min * 60_000);

// Credential-SHAPED canaries, assembled at runtime so no secret-shaped literal ever enters the tree
// (the secrets guard and the publish guard scan file content). They match the scrubber's patterns.
const BEARER_SECRET = 'abcdefghijklmnopqrstuvwxyz0123';
const BEARER = ['Bearer', BEARER_SECRET].join(' ');
const SK_SECRET = 'CANARYABCDEFGHIJ1234';
const SK = ['sk', 'canary', SK_SECRET].join('_');

const CHAIN: SiemPolicyLayerRef[] = [
  { layer_id: 'org-acme', level: 'organization', version: 1, content_hash: 'h-org' },
  { layer_id: 'ws-a', level: 'workspace', version: 3, content_hash: 'h-ws' },
];

function row(id: number, over: SiemSourceRow = {}): SiemSourceRow {
  return {
    id: String(id),
    workspace_id: 'ws-a',
    harness_slug: 'papercusp',
    plugin_name: 'core',
    tool_name: 'work_items:get',
    role: 'operator',
    spawn_id: 'spawn-1',
    window_key: 'w',
    invoked_at: at(id),
    duration_ms: 12,
    status: 'ok',
    error_code: null,
    error_message: null,
    args_json: { id: 'WI-1' },
    metadata_json: null,
    transport: 'mcp',
    principal_kind: 'human',
    principal_auth_method: 'bearer',
    principal_trust: 'owner',
    coord_owner_id: 'admin:alice',
    ...over,
  };
}

const ctx = { key: KEY, policyChain: CHAIN };
const entries = (rows: readonly SiemSourceRow[]): SiemBatchEntry[] =>
  rows.map((r) => ({ id: String(r.id), event: projectSiemEvent(r, ctx) }));

interface Ev {
  status_id: number;
  severity_id: number;
  status_code: unknown;
  status_detail: unknown;
  metadata: { uid: string; correlation_uid: string; tenant_uid: unknown };
  actor: { user: { uid: unknown; type: unknown }; authorizations: Array<Record<string, unknown>> };
  api: { operation: unknown };
  unmapped: { papercusp_source: Record<string, unknown>; papercusp_args: unknown; papercusp_policy_chain: unknown };
}
const ev = (e: unknown): Ev => e as Ev;

function verified(jsonl: string, opts?: Parameters<typeof verifySiemBatchJsonl>[1]) {
  const v = verifySiemBatchJsonl(jsonl, opts);
  if (!v.ok) throw new Error(`expected a verified batch: ${v.reason}`);
  return v;
}

describe('column classification', () => {
  it('classifies exactly the live tool_invocations columns (pinned to the drizzle schema)', () => {
    const live = getTableConfig(generated.toolInvocationsInHarnessShared)
      .columns.map((c) => c.name)
      .sort();
    expect(Object.keys(SIEM_SOURCE_COLUMNS).sort()).toEqual(live);
  });

  it('is sound, and the read never selects free text or credential-bearing columns', () => {
    expect(siemClassificationProblems()).toEqual([]);
    for (const c of ['error_message', 'metadata_json', 'window_key', 'output_ref', 'output_size', 'event_count']) {
      expect(SIEM_READ_COLUMNS).not.toContain(c);
    }
    expect(SIEM_READ_COLUMNS[0]).toBe('id');
    expect(SIEM_READ_COLUMNS).toContain('args_json');
    expect(SIEM_READ_COLUMNS).toContain('coord_owner_id');
  });

  it('flags an unsound classification', () => {
    const problems = siemClassificationProblems({
      email: { dataClass: 'pii', treatment: 'emit', why: 'x' },
      token: { dataClass: 'secret', treatment: 'pseudonymize', why: 'x' },
      invoice: { dataClass: 'billing', treatment: 'digest-keys', why: 'x' },
      'bad name': { dataClass: 'operational', treatment: 'emit', why: 'x' },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'email: pii data must not be emitted raw',
        'token: secret data must be withheld or digested',
        'invoice: billing data is withheld',
        'bad name: not a plain column identifier',
      ]),
    );
  });
});

describe('identity and authorization outcome', () => {
  it('detects identity and authorization refusals, not tool failures', () => {
    expect(isDeniedInvocation({ status: 'error', error_code: 'authorization_denied' })).toBe(true);
    expect(isDeniedInvocation({ status: 'error', error_code: 'missing_capability' })).toBe(true);
    expect(isDeniedInvocation({ status: 'role-not-allowed', error_code: null })).toBe(true);
    expect(isDeniedInvocation({ status: 'mcp_auth_failed' })).toBe(true);
    expect(isDeniedInvocation({ status: 'error', error_code: 'tool_failed' })).toBe(false);
    expect(isDeniedInvocation({ status: 'ok', error_code: null })).toBe(false);
  });

  it('projects accepted, denied and failed invocations as distinct OCSF outcomes', () => {
    const accepted = ev(projectSiemEvent(row(1), ctx));
    expect(accepted).toMatchObject({
      status_id: 1,
      severity_id: 1,
      status_code: 'ok',
      metadata: { uid: 'ti:1', correlation_uid: 'ti:1', tenant_uid: 'ws-a' },
      actor: { authorizations: [{ decision: 'Allowed', policy: { uid: 'ws-a', version: '3', name: 'workspace' } }] },
      api: { operation: 'work_items:get' },
      unmapped: { papercusp_policy_chain: CHAIN },
    });
    expect(accepted).toMatchObject({ class_uid: 6003, category_uid: 6, type_uid: 600399 });

    const denied = ev(projectSiemEvent(row(2, { status: 'error', error_code: 'authorization_denied', principal_kind: 'service' }), ctx));
    expect(denied).toMatchObject({
      status_id: 2,
      severity_id: 3,
      status_detail: 'authorization_denied',
      actor: { user: { type: 'service' }, authorizations: [{ decision: 'Denied' }] },
    });

    const failed = ev(projectSiemEvent(row(3, { status: 'error', error_code: 'tool_failed' }), ctx));
    expect(failed).toMatchObject({ status_id: 2, severity_id: 1, actor: { authorizations: [{ decision: 'Allowed' }] } });

    expect(ev(projectSiemEvent(row(4, { status: 'replayed' }), ctx)).status_id).toBe(1);
  });

  it('omits the policy reference when no chain was in effect, and refuses a non-bigint cursor', () => {
    const e = ev(projectSiemEvent(row(1), { key: KEY, policyChain: [] }));
    expect(e.actor.authorizations).toEqual([{ decision: 'Allowed' }]);
    expect(() => projectSiemEvent(row(1, { id: 'abc' }), ctx)).toThrow(/bigint cursor/);
    expect(() => projectSiemEvent(row(1, { invoked_at: 'not a time' }), ctx)).toThrow(/invalid invoked_at/);
  });
});

describe('redaction', () => {
  it('pseudonymizes the actor with a stable, keyed token', () => {
    const a = siemPseudonym(KEY, 'admin:alice');
    expect(a).toMatch(/^psn:[0-9a-f]{32}$/);
    expect(siemPseudonym(KEY, 'admin:alice')).toBe(a);
    expect(siemPseudonym(OTHER_KEY, 'admin:alice')).not.toBe(a);
    expect(siemPseudonym(KEY, 'admin:bob')).not.toBe(a);
    expect(ev(projectSiemEvent(row(1), ctx)).actor.user.uid).toBe(a);
    expect(ev(projectSiemEvent(row(1, { coord_owner_id: '' }), ctx)).actor.user.uid).toBeNull();
    expect(() => siemPseudonym('too-short', 'x')).toThrow(/at least 32 bytes/);
  });

  it('reduces arguments to identifier key names plus a keyed, order-independent digest', () => {
    const d = siemArgsDigest(KEY, { b: 1, a: 'x', 'not a key': 2 })!;
    expect(d.keys).toEqual(['a', 'b']);
    expect(d.omittedKeys).toBe(1);
    expect(d.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(siemArgsDigest(KEY, { 'not a key': 2, a: 'x', b: 1 })!.hmac).toBe(d.hmac);
    expect(siemArgsDigest(KEY, JSON.stringify({ b: 1, a: 'x', 'not a key': 2 }))!.hmac).toBe(d.hmac);
    expect(siemArgsDigest(OTHER_KEY, { b: 1, a: 'x', 'not a key': 2 })!.hmac).not.toBe(d.hmac);
    expect(siemArgsDigest(KEY, { b: 2, a: 'x', 'not a key': 2 })!.hmac).not.toBe(d.hmac);
    expect(siemArgsDigest(KEY, null)).toBeNull();
    expect(siemArgsDigest(KEY, [1, 2])).toMatchObject({ keys: [], omittedKeys: 0 });

    const e = ev(projectSiemEvent(row(1, { args_json: { b: 1, a: 'x', 'not a key': 2 } }), ctx));
    expect(e.unmapped.papercusp_args).toEqual(d);
    expect(e.unmapped.papercusp_source.args_json).toEqual({ hmac: d.hmac });
  });

  it('emits code-shaped outcome values and withholds free text (measured: error_code carries raw DB errors)', () => {
    const freeText = ev(projectSiemEvent(row(1, { status: 'error', error_code: 'column "passed" does not exist' }), ctx));
    expect(freeText.status_detail).toBe(SIEM_WITHHELD_FREE_TEXT);
    expect(JSON.stringify(freeText)).not.toContain('does not exist');
    expect(ev(projectSiemEvent(row(2, { status: 'error', error_code: 'authorization_denied' }), ctx)).status_detail).toBe(
      'authorization_denied',
    );
  });

  // WI-6554700010012363: ONE emit-code shape for both streams (D-017 tool invocations, D-018
  // organization audit). Uuid-shaped ids pass as codes; a uuid ACTOR is still pseudonymized,
  // because the actor column's treatment is pseudonymize, never emit-code.
  it('uses one emit-code shape for both streams: codes and uuids pass, free text and overlong values do not', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(siemCodeValue(uuid)).toBe(uuid);
    expect(siemCodeValue('23505')).toBe('23505');
    expect(siemCodeValue('authorization_denied')).toBe('authorization_denied');
    expect(siemCodeValue('a'.repeat(128))).toBe('a'.repeat(128));
    expect(siemCodeValue('a'.repeat(129))).toBe(SIEM_WITHHELD_FREE_TEXT);
    expect(siemCodeValue('-leading-dash')).toBe(SIEM_WITHHELD_FREE_TEXT);
    expect(siemCodeValue('two words')).toBe(SIEM_WITHHELD_FREE_TEXT);
    expect(siemCodeValue(null)).toBeNull();
    expect(SIEM_CODE_SHAPED.test(uuid)).toBe(true);

    const e = ev(projectSiemEvent(row(3, { status: 'error', error_code: uuid, coord_owner_id: uuid }), ctx));
    expect(e.status_detail).toBe(uuid);
    expect(e.actor.user.uid).toBe(siemPseudonym(KEY, uuid));
    expect(JSON.stringify(e.actor)).not.toContain(uuid);
  });

  it('secret canary: no credential, raw actor or free text reaches the exported bytes', () => {
    const canary = row(5, {
      status: 'error',
      error_code: SK,
      error_message: `request failed: ${BEARER}`,
      args_json: { authorization: BEARER, [SK]: 'value', 'Bearer header': 1, note: `token=${SK}` },
      metadata_json: { auth: BEARER },
      coord_owner_id: 'admin:canary-owner',
    });
    const batch = buildSiemBatch({ workspaceId: 'ws-a', prevHead: null, cursorFrom: '4', entries: entries([canary]) });
    for (const leaked of [BEARER_SECRET, SK_SECRET, 'canary-owner', 'request failed', 'token=']) {
      expect(batch.jsonl).not.toContain(leaked);
    }
    const e = ev(verified(batch.jsonl).events[0]);
    expect(e.status_detail).toBe(SIEM_WITHHELD_CREDENTIAL);
    // A secret-shaped KEY NAME is identifier-shaped, so it is listed, and then scrubbed as a value.
    expect(e.unmapped.papercusp_args).toMatchObject({ keys: ['authorization', 'note', SIEM_WITHHELD_CREDENTIAL], omittedKeys: 1 });
  });
});

describe('policy in effect at the event time', () => {
  const v = (layerId: string, level: PolicyLayerVersion['level'], version: number, min: number): PolicyLayerVersion => ({
    layerId,
    version,
    level,
    scopeRef: layerId,
    parentLayerId: null,
    rules: {},
    exceptions: [],
    contentHash: `${layerId}@${version}`,
    actor: 'admin:root',
    reason: 'test',
    recordedAt: at(min).toISOString(),
  });
  const org = [v('org-acme', 'organization', 1, 0), v('org-acme', 'organization', 2, 10)];
  const ws = [v('ws-a', 'workspace', 1, 5)];
  const ids = (refs: SiemPolicyLayerRef[]) => refs.map((r) => `${r.layer_id}@${r.version}:${r.content_hash}`);

  it('picks, per layer, the latest version recorded at or before the event', () => {
    expect(policyAt([org, ws], at(-1))).toEqual([]);
    expect(ids(policyAt([org, ws], at(3)))).toEqual(['org-acme@1:org-acme@1']);
    expect(ids(policyAt([org, ws], at(9)))).toEqual(['org-acme@1:org-acme@1', 'ws-a@1:ws-a@1']);
    expect(ids(policyAt([org, ws], at(10)))).toEqual(['org-acme@2:org-acme@2', 'ws-a@1:ws-a@1']);
    expect(ids(policyAt([[...org].reverse(), ws], at(10)))).toEqual(ids(policyAt([org, ws], at(10))));
  });
});

describe('settled prefix', () => {
  it('stops at the first unsettled row so the cursor never skips an id that may still be committing', () => {
    const rows = [row(1), row(2), row(3, { invoked_at: at(9) }), row(4, { invoked_at: at(3) })];
    expect(settledPrefix(rows, at(5)).map((r) => r.id)).toEqual(['1', '2']);
    expect(settledPrefix(rows, at(9)).map((r) => r.id)).toEqual(['1', '2', '3', '4']);
    expect(settledPrefix([], at(9))).toEqual([]);
  });
});

describe('batches: tamper evidence, continuation and replay', () => {
  const rows = [1, 2, 3, 4].map((i) => row(i));
  const b1 = buildSiemBatch({ workspaceId: 'ws-a', prevHead: null, cursorFrom: '0', entries: entries(rows.slice(0, 2)) });
  const b2 = buildSiemBatch({ workspaceId: 'ws-a', prevHead: b1.head, cursorFrom: b1.manifest.cursorTo, entries: entries(rows.slice(2)) });
  const lines = (text: string) => text.trimEnd().split('\n');
  const join = (ls: string[]) => `${ls.join('\n')}\n`;

  it('round-trips a batch behind its manifest', () => {
    expect(b1.manifest).toMatchObject({ cursorFrom: '0', cursorTo: '2', length: 2, startAfter: null, streamId: 'papercusp.siem-export:ws-a' });
    expect(lines(b1.jsonl)).toHaveLength(3);
    const v = verified(b1.jsonl);
    expect(v.events.map((e) => ev(e).metadata.uid)).toEqual(['ti:1', 'ti:2']);
  });

  it('continues the stream: a second batch verifies on its own after the delivered head', () => {
    expect(b2.manifest.startAfter).toEqual(b1.manifest.head);
    expect(verified(b2.jsonl, { startAfter: b1.manifest.head }).events).toHaveLength(2);
    expect(verifySiemBatchJsonl(b2.jsonl, { startAfter: null }).ok).toBe(false);
    expect(verifySiemBatchJsonl(b2.jsonl, { startAfter: { seq: b1.manifest.head!.seq, entryHash: '0'.repeat(64) } }).ok).toBe(false);
  });

  it('detects an edited, dropped or reordered event', () => {
    const ls = lines(b1.jsonl);
    const edited = verifySiemBatchJsonl(join([ls[0]!, ls[1]!.replace('work_items:get', 'work_items:del'), ls[2]!]));
    expect(edited).toMatchObject({ ok: false, reason: expect.stringContaining('chain break') });
    expect(verifySiemBatchJsonl(join([ls[0]!, ls[2]!]))).toMatchObject({ ok: false, reason: expect.stringContaining('manifest declares 2') });

    const forged = JSON.parse(ls[0]!) as { manifest: Record<string, unknown> };
    forged.manifest.length = 1;
    expect(verifySiemBatchJsonl(join([JSON.stringify(forged), ls[2]!])).ok).toBe(false);
    expect(verifySiemBatchJsonl(join([ls[0]!, ls[2]!, ls[1]!])).ok).toBe(false);
    expect(verifySiemBatchJsonl('{"x":1}\n')).toMatchObject({ ok: false, reason: 'missing or foreign manifest' });
    expect(verifySiemBatchJsonl('not json\n')).toMatchObject({ ok: false, reason: expect.stringContaining('unparseable') });
  });

  it('a truncated delivery is caught by the next batch even when its manifest was rewritten to match', () => {
    const ls = lines(b1.jsonl);
    const first = JSON.parse(ls[1]!) as { link: { seq: number; entryHash: string } };
    const forged = JSON.parse(ls[0]!) as { manifest: Record<string, unknown> };
    Object.assign(forged.manifest, { length: 1, cursorTo: '1', head: { seq: first.link.seq, entryHash: first.link.entryHash } });
    const truncated = verified(join([JSON.stringify(forged), ls[1]!]));
    expect(verifySiemBatchJsonl(b2.jsonl, { startAfter: truncated.manifest.head }).ok).toBe(false);
  });

  it('an empty batch keeps the head and verifies after it', () => {
    const empty = buildSiemBatch({ workspaceId: 'ws-a', prevHead: b2.head, cursorFrom: b2.manifest.cursorTo, entries: [] });
    expect(empty.manifest).toMatchObject({ length: 0, cursorFrom: '4', cursorTo: '4' });
    expect(empty.manifest.head).toEqual(b2.manifest.head);
    expect(empty.head).toEqual(b2.head);
    expect(verified(empty.jsonl, { startAfter: b2.manifest.head }).events).toEqual([]);
  });

  it('replays byte-identically with the same idempotency key, and keys differ across ranges', () => {
    const again = buildSiemBatch({ workspaceId: 'ws-a', prevHead: null, cursorFrom: '0', entries: entries(rows.slice(0, 2)) });
    expect(again.jsonl).toBe(b1.jsonl);
    expect(again.manifest.idempotencyKey).toBe(b1.manifest.idempotencyKey);
    expect(b2.manifest.idempotencyKey).not.toBe(b1.manifest.idempotencyKey);
    const shifted = buildSiemBatch({ workspaceId: 'ws-a', prevHead: null, cursorFrom: '1', entries: entries(rows.slice(1, 2)) });
    expect(shifted.manifest.idempotencyKey).not.toBe(b1.manifest.idempotencyKey);
  });

  it('refuses to continue another workspace stream', () => {
    expect(() => buildSiemBatch({ workspaceId: 'ws-b', prevHead: b1.head, cursorFrom: '2', entries: [] })).toThrow(/belongs to stream/);
  });
});
