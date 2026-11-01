/**
 * owner-directive-capture-provenance.integration.test.ts — real-PG proof for P-003 of plan
 * `turn-start-memory-two-class-2026-09-21` (migration 1187), and for the store invariant
 * migration 1198 added for D-001 of `owner-directive-delivery-redesign-2026-09-22`.
 *
 * WHY THIS FILE EXISTS. Every owner turn is a directive and lands OPEN (D-001), so a
 * hook-captured row and an agent-recorded row are byte-identical in every lifecycle
 * column. "Was this captured by the hook, or asserted by an agent?" is answerable ONLY
 * through `captured_by_hook` (migration 1187). The load-bearing assertion is the CONTROL:
 * the lifecycle state is provably identical for both rows while the flag still separates
 * them. Derive the flag from any lifecycle column instead and that control fails.
 *
 * The migration-1198 cases pin the trigger that keeps writers still running pre-1198 code
 * (the released `orders:capture-pending` / `orders:resolve-pending`) inside the
 * three-state space: a legacy `pending` insert lands open, and a legacy dismissal becomes
 * a declined disposition that carries its reason instead of silently hiding the row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  dispositionOwnerDirective,
  getOwnerDirective,
  ownerDirectiveState,
  recordOwnerDirective,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive capture provenance (migrations 1187 + 1198)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-capture-provenance-ws';

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  /** A hook-shaped capture: flagged, carrying the turn ref the hook derives. */
  async function captureViaHook(turnRef: string) {
    return recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-hook',
        sourceTurnRef: turnRef,
        verbatimText: 'ship the thing now',
        recordedBy: 'su-hook-caller',
        capturedByHook: true,
      },
      db.adminSql,
    );
  }

  /** An agent-shaped record, never touched by the hook. */
  async function recordViaAgent(turnRef: string) {
    return recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-agent',
        sourceTurnRef: turnRef,
        verbatimText: 'ship the thing now',
        recordedBy: 'su-agent-caller',
      },
      db.adminSql,
    );
  }

  it('a retry with the same sourceTurnRef returns the committed directive id', async () => {
    const sourceTurnRef = 'turn-committed-response-lost-1';
    const committed = await captureViaHook(sourceTurnRef);
    const retry = await captureViaHook(sourceTurnRef);

    expect(retry.id).toBe(committed.id);
    expect(retry.sourceTurnRef).toBe(sourceTurnRef);
  });

  it('concurrent captures with one sourceTurnRef create and return only one directive', async () => {
    const sourceTurnRef = 'turn-concurrent-capture-1';
    const captures = await Promise.all(Array.from({length: 8}, () => captureViaHook(sourceTurnRef)));

    expect(new Set(captures.map((capture) => capture.id))).toEqual(new Set([captures[0]!.id]));
    const [stored] = await db.adminSql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.owner_directives
       WHERE workspace_id = ${workspaceId}
         AND owner_id = 'owner'
         AND source_turn_ref = ${sourceTurnRef}
    `;
    expect(stored!.count).toBe(1);
  });

  it('D-001: a hook capture lands OPEN — there is no pending triage step', async () => {
    const hooked = await captureViaHook('turn-open-1');
    expect(ownerDirectiveState(hooked)).toBe('open');
    expect(hooked.dispositionedAtMs).toBeNull();
  });

  it('flags a hook capture and leaves an agent-recorded row unflagged', async () => {
    const hooked = await captureViaHook('turn-flagged-1');
    const recorded = await recordViaAgent('turn-unflagged-1');

    expect(hooked.capturedByHook).toBe(true);
    // The default must be false, not null/undefined: the column is NOT NULL DEFAULT false
    // so an unflagged row is a positive "not the hook", never an absence of information.
    expect(recorded.capturedByHook).toBe(false);
  });

  it('CONTROL: the lifecycle cannot tell hook from agent, but the flag can', async () => {
    const hooked = await captureViaHook('turn-control-1');
    const recorded = await recordViaAgent('turn-control-2');

    // Identical lifecycle — so any provenance derived from it would be a guess.
    expect(ownerDirectiveState(hooked)).toBe(ownerDirectiveState(recorded));
    const [a, b] = await db.adminSql<{ capture_status: string }[]>`
      SELECT capture_status FROM harness_shared.owner_directives
       WHERE id IN (${hooked.id}, ${recorded.id}) ORDER BY id
    `;
    expect(a!.capture_status).toBe(b!.capture_status);
    // ...while the flag still separates them.
    expect(hooked.capturedByHook).not.toBe(recorded.capturedByHook);
  });

  it('keeps hook provenance on a declined directive, so refusals stay auditable', async () => {
    const hooked = await captureViaHook('turn-declined-1');
    const result = await dispositionOwnerDirective(
      { id: hooked.id, status: 'declined', note: 'out of scope; told the owner', dispositionedBy: 'su-hook-caller' },
      db.adminSql,
    );
    expect(result.ok).toBe(true);
    const after = await getOwnerDirective(hooked.id, db.adminSql);
    expect(ownerDirectiveState(after!)).toBe('declined');
    expect(after!.capturedByHook).toBe(true);
  });

  it('1198 trigger: a legacy PENDING insert lands open', async () => {
    const [row] = await db.adminSql<{ id: number; capture_status: string }[]>`
      INSERT INTO harness_shared.owner_directives
        (workspace_id, owner_id, session_ref, source_turn_ref, verbatim_text, recorded_by, capture_status, captured_by_hook)
      VALUES (${workspaceId}, 'owner', 'session-legacy', 'turn-legacy-pending', 'legacy capture', 'su-legacy', 'pending', true)
      RETURNING id, capture_status
    `;
    expect(row!.capture_status).toBe('open');
    const read = await getOwnerDirective(row!.id, db.adminSql);
    expect(ownerDirectiveState(read!)).toBe('open');
  });

  it('1198 trigger: a legacy DISMISSAL becomes a declined disposition carrying its reason', async () => {
    const hooked = await captureViaHook('turn-legacy-dismiss');
    await db.adminSql`
      UPDATE harness_shared.owner_directives
         SET capture_status = 'dismissed',
             capture_dismissed_at = now(),
             capture_dismissed_by = 'su-legacy-dismisser',
             capture_dismissal_reason = 'owner was musing, not directing'
       WHERE id = ${hooked.id}
    `;
    const after = await getOwnerDirective(hooked.id, db.adminSql);
    // Never hidden: it reads back as a declined directive a human can audit.
    expect(ownerDirectiveState(after!)).toBe('declined');
    expect(after!.dispositionedBy).toBe('su-legacy-dismisser');
    expect(after!.dispositionNote).toContain('owner was musing, not directing');
  });

  it('1198 CHECK: capture_status can hold nothing but open', async () => {
    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.owner_directives WHERE capture_status <> 'open'
    `;
    expect(n).toBe(0);
  });
});
