/**
 * G1 Provenance unit tests (P-002 / P-003).
 *
 * Plan: papercusp-user-protection-gate-2026-05-31 P-001..P-004.
 *
 * These tests assert the LOCAL vs REMOTE origin determination path
 * WITHOUT a real PG connection. They inject a capturing `writeToPg` that
 * records what provenance context was passed, and drive `applyOpVia` with
 * different `ownLogKeyHex` + `sourceLogKeyHex` combinations.
 *
 * No Docker required — the PG upsert SQL is not executed here; only the
 * provenance-threading logic (the decision logic that IS the security gate)
 * is exercised. PG integration coverage is in the existing per-writer
 * integration tests which use testcontainers.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyOpVia,
  type TableProjection,
  type ProvenanceContext,
} from '../../projection';
import { rowToFeature } from '../../../../harness-core';
import type { OpEnvelope } from '../../op-envelope-types';

// ── Fixtures ──────────────────────────────────────────────────────────────

const OWN_LOG_KEY = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cc';
const REMOTE_LOG_KEY = '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff1111aaaa2222bbbb33';
const LOCAL_PUBKEY = 'deadbeefdeadbeef';
const REMOTE_PUBKEY = 'cafebabecafebabe';
/**
 * A valid encoded HLC (`encodeHlc({ ms: 1700000000000, count: 0 })`). applyOpVia
 * REJECTS a remote op (sourceLogKeyHex !== ownLogKeyHex) whose `hlc` fails
 * `isValidOpHlc` — every real remote op is HLC-stamped at the SEND seam — so the
 * remote fixtures must carry one to reach the provenance logic under test.
 */
const OP_HLC = '001700000000000:00000';

/** Minimal valid feature row as a decoded value. */
function featureValue(overrides: Record<string, unknown> = {}): unknown {
  return {
    harness_slug: 'sheets',
    feature_id: 'F-001',
    title: 'Test feature',
    summary: null,
    status: 'in_queue',
    attempts: 0,
    claims: null,
    notes: null,
    metadata: null,
    kind: 'feature',
    project_id: null,
    expected_cost_cents: null,
    tags: null,
    needs_human_review: false,
    ts: 1700000000000,
    created_ts: 1700000000000,
    updated_ts: 1700000000000,
    parent_id: null,
    goal_id: null,
    taken_by: null,
    taken_at: null,
    expires_at: null,
    ...overrides,
  };
}

/** Build a capturing projection that records provenance passed to writeToPg. */
function capturingProjection(tableTag = 'features-by-id'): {
  projection: TableProjection<unknown>;
  captured: Array<{ row: unknown; provenance: ProvenanceContext }>;
} {
  const captured: Array<{ row: unknown; provenance: ProvenanceContext }> = [];
  const projection: TableProjection<unknown> = {
    tableTag,
    composeKey: (row: any) => row.feature_id ?? row.issue_id ?? 'key',
    decodeValue: (raw) => (raw && typeof raw === 'object' ? raw : null),
    writeToPg: async (row, provenance) => {
      captured.push({ row, provenance });
    },
    deleteFromPg: async () => {},
  };
  return { projection, captured };
}

/** Minimal put op envelope. */
function putOp(overrides: Partial<OpEnvelope> = {}): OpEnvelope {
  return {
    type: 'put',
    table: 'features-by-id',
    hbKey: 'F-001',
    value: featureValue(),
    ts: 1700000000000,
    hlc: OP_HLC,
    schema_version: 1,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('G1 Provenance — applyOpVia origin determination', () => {
  it('always supplies an explicit local context for a legacy op with no provenance fields', async () => {
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    await applyOpVia(lookup, putOp({ writerPubkey: undefined, sourceLogKeyHex: undefined, ts: undefined, hlc: undefined }));

    expect(captured).toEqual([
      {
        row: featureValue(),
        provenance: {
          authorPubkey: '',
          origin: 'local',
          ts: undefined,
          fedHlc: undefined,
          sourceLogKeyHex: undefined,
          // resolveOpProvenance threads the op's key through for writers that
          // need it (projection.ts resolveOpProvenance).
          hbKey: 'F-001',
        },
      },
    ]);
  });

  it('local op (sourceLogKeyHex === ownLogKeyHex) → origin=local + author_pubkey stamped', async () => {
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op = putOp({
      writerPubkey: LOCAL_PUBKEY,
      sourceLogKeyHex: OWN_LOG_KEY,
    });

    const applied = await applyOpVia(lookup, op, { ownLogKeyHex: OWN_LOG_KEY });
    expect(applied).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].provenance?.origin).toBe('local');
    expect(captured[0].provenance?.authorPubkey).toBe(LOCAL_PUBKEY);
  });

  it('remote op (sourceLogKeyHex !== ownLogKeyHex) → origin=remote + UNFORGEABLE source-log key stamped', async () => {
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op = putOp({
      writerPubkey: REMOTE_PUBKEY,
      sourceLogKeyHex: REMOTE_LOG_KEY,
    });

    const applied = await applyOpVia(lookup, op, { ownLogKeyHex: OWN_LOG_KEY });
    expect(applied).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].provenance?.origin).toBe('remote');
    // P-002/D-004: remote attribution is the receiver-stamped, unforgeable
    // sourceLogKeyHex — NOT the self-declared writerPubkey.
    expect(captured[0].provenance?.authorPubkey).toBe(REMOTE_LOG_KEY);
  });

  it('op with no sourceLogKeyHex but ownLogKeyHex present → treated as remote (unknown source)', async () => {
    // An op without sourceLogKeyHex cannot be confirmed as from the own log →
    // conservative: treat as remote. This covers synthetic ops that didn't come
    // through the merge path (e.g. direct calls without toEnvelope).
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op = putOp({
      writerPubkey: REMOTE_PUBKEY,
      // sourceLogKeyHex intentionally absent
    });

    await applyOpVia(lookup, op, { ownLogKeyHex: OWN_LOG_KEY });
    expect(captured[0].provenance?.origin).toBe('remote');
  });

  it('op with sourceLogKeyHex set to own log but no ownLogKeyHex in opts → defaults to local (legacy path)', async () => {
    // When ownLogKeyHex is absent (global-registry / legacy single-peer path),
    // origin defaults to 'local' (safe default — no remote peers exist on that path).
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op = putOp({
      writerPubkey: LOCAL_PUBKEY,
      sourceLogKeyHex: OWN_LOG_KEY,
    });

    // No ownLogKeyHex in opts — defaults to local.
    await applyOpVia(lookup, op, {});
    expect(captured[0].provenance?.origin).toBe('local');
  });

  it('del op does NOT call writeToPg (no provenance context needed)', async () => {
    const { projection, captured } = capturingProjection();
    const deletedKeys: string[] = [];
    projection.deleteFromPg = async (key) => { deletedKeys.push(key); };
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op: OpEnvelope = {
      type: 'del',
      table: 'features-by-id',
      hbKey: 'F-001',
      hlc: OP_HLC,
      writerPubkey: REMOTE_PUBKEY,
      sourceLogKeyHex: REMOTE_LOG_KEY,
    };

    const applied = await applyOpVia(lookup, op, { ownLogKeyHex: OWN_LOG_KEY });
    expect(applied).toBe(true);
    expect(captured).toHaveLength(0); // writeToPg not called on del
    expect(deletedKeys).toEqual(['F-001']);
  });

  it('forged author pubkey matching own identity affects neither origin nor stored attribution', async () => {
    // D-006: a remote op whose writerPubkey is forged to look like the local
    // device's pubkey MUST still be detected as remote via sourceLogKeyHex.
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op = putOp({
      // Attacker forges the local pubkey in writerPubkey (the payload field):
      writerPubkey: LOCAL_PUBKEY,
      // But the source log key is the remote's log (the unforgeable signal):
      sourceLogKeyHex: REMOTE_LOG_KEY,
    });

    await applyOpVia(lookup, op, { ownLogKeyHex: OWN_LOG_KEY });
    // The log-source wins: sourceLogKeyHex !== ownLogKeyHex → remote.
    expect(captured[0].provenance?.origin).toBe('remote');
    // P-002/D-004: stored attribution is the UNFORGEABLE sourceLogKeyHex, so the
    // forged writerPubkey does NOT land in author_pubkey (it would deceive an
    // auditor). The op is still applied — provenance is attribution, not
    // rejection — but the recorded author is the real, unforgeable source.
    expect(captured[0].provenance?.authorPubkey).toBe(REMOTE_LOG_KEY);
  });

  it('empty writerPubkey results in empty string authorPubkey, not null', async () => {
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    const op = putOp({
      writerPubkey: '',
      sourceLogKeyHex: OWN_LOG_KEY,
    });

    await applyOpVia(lookup, op, { ownLogKeyHex: OWN_LOG_KEY });
    expect(captured[0].provenance?.authorPubkey).toBe('');
    expect(captured[0].provenance?.origin).toBe('local');
  });
});

describe('G1 Provenance — buildHarnessProjectionApply with ownLogKeyHex', () => {
  it('scoped apply stamps local when sourceLogKeyHex matches ownLogKeyHex', async () => {
    // Use a capturing projection instead of calling the real buildHarnessProjectionApply
    // (which would build real PG projections). Test the origin logic via applyOpVia directly
    // with a capturing projection — the real scoped apply just calls applyOpVia with the
    // same applyOpts, so this covers the logic without touching PG.
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    await applyOpVia(lookup, putOp({ sourceLogKeyHex: OWN_LOG_KEY, writerPubkey: LOCAL_PUBKEY }), {
      ownLogKeyHex: OWN_LOG_KEY,
    });
    expect(captured[0].provenance?.origin).toBe('local');
  });

  it('scoped apply stamps remote when sourceLogKeyHex differs from ownLogKeyHex', async () => {
    const { projection, captured } = capturingProjection();
    const lookup = (tag: string) => (tag === projection.tableTag ? projection : null);

    await applyOpVia(
      lookup,
      putOp({ sourceLogKeyHex: REMOTE_LOG_KEY, writerPubkey: REMOTE_PUBKEY }),
      { ownLogKeyHex: OWN_LOG_KEY },
    );
    expect(captured[0].provenance?.origin).toBe('remote');
    // P-002/D-004: unforgeable source-log key, not the self-declared writerPubkey.
    expect(captured[0].provenance?.authorPubkey).toBe(REMOTE_LOG_KEY);
  });
});

describe('G1 Provenance — rowToFeature exposes origin + author_pubkey (P-004)', () => {
  it('rowToFeature with origin=local returns origin=local', () => {
    const row = {
      feature_id: 'F-001',
      title: 'Test',
      status: 'in_queue',
      attempts: 0,
      origin: 'local',
      author_pubkey: 'aabbcc',
    };
    const feature = rowToFeature(row);
    expect(feature.origin).toBe('local');
    expect(feature.author_pubkey).toBe('aabbcc');
  });

  it('rowToFeature with origin=remote returns origin=remote + peer pubkey', () => {
    const row = {
      feature_id: 'F-002',
      title: 'Remote Feature',
      status: 'in_queue',
      attempts: 0,
      origin: 'remote',
      author_pubkey: REMOTE_PUBKEY,
    };
    const feature = rowToFeature(row);
    expect(feature.origin).toBe('remote');
    expect(feature.author_pubkey).toBe(REMOTE_PUBKEY);
  });

  it('rowToFeature with no origin column (legacy row) defaults to local', () => {
    const row = {
      feature_id: 'F-003',
      title: 'Legacy Feature',
      status: 'in_queue',
      attempts: 0,
      // origin is absent — pre-migration row
    };
    const feature = rowToFeature(row);
    expect(feature.origin).toBe('local');
    expect(feature.author_pubkey).toBeNull();
  });

  it('rowToFeature with null author_pubkey returns null', () => {
    const row = {
      feature_id: 'F-004',
      title: 'No pubkey',
      status: 'in_queue',
      attempts: 0,
      origin: 'local',
      author_pubkey: null,
    };
    const feature = rowToFeature(row);
    expect(feature.author_pubkey).toBeNull();
  });
});
