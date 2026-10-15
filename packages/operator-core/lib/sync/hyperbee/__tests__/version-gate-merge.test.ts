/**
 * version-gate-merge.test.ts — substrate-internals coverage (A4) for the REAL
 * `versionGatedLog` seam inside the merge driver (boot.ts), not just the
 * `acceptOpVersion` unit (schema-version.ts, unit-tested in schema-version.test.ts
 * + boot.test.ts's onSchemaVersionAlert).
 *
 * D-024: every op carries `schema_version`. The merge driver wraps each admitted
 * log in `versionGatedLog(slug, log)`, whose `get(i)` returns `null` for any op
 * with `schema_version > CURRENT` — so an unknown-NEWER op is DROPPED (never
 * applied to PG) and a single "newer Papercusp available" alert fires per
 * (slug, version).
 *
 * This drives the gate through the genuine path: admit a real remote peer whose
 * log carries one CURRENT op (must apply) and one CURRENT+1 op (must be dropped),
 * then `mergeNow()` and assert (a) only the CURRENT op reached the projection
 * sink and (b) exactly one schema-version alert fired. Uses the bootHarness +
 * Corestore-replicate + openOwnLog rig from boot.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import {
  schemaVersionEvents,
  CURRENT_SCHEMA_VERSION,
  _resetForTests as _resetSchemaVersionForTests,
  type SchemaVersionAlert,
} from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests } from '../boot-history';
import { openOwnLog } from '../peer-log';
import { buildAnnounce } from '../announce';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {}
  }
  _resetSchemaVersionForTests();
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

/** A real device identity + an Ed25519 signer (so the announce verifies). */
function makeDevice(githubLogin: string, githubUserId: number) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  return {
    devicePubkey,
    githubUserId,
    githubLogin,
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

/** Pipe two Corestores' replication streams both ways. */
function replicate(s1: Corestore, s2: Corestore): void {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
}

describe('versionGatedLog merge seam (D-024, A4)', () => {
  it('admits a peer carrying a CURRENT op + a CURRENT+1 op → mergeNow applies ONLY the CURRENT op; one schema-version alert fires', async () => {
    const alerts: SchemaVersionAlert[] = [];
    schemaVersionEvents.on('alert', (a: SchemaVersionAlert) => alerts.push(a));

    const writes: Array<{ id: string }> = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-vgate-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'vgate-1',
      mergePollMs: 0, // drive mergeNow by hand
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op) => {
        if (op.table === 'mb_vgate_table') writes.push(op.value as { id: string });
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // ── A real remote peer P: own store + writable log, replicated into the host.
    const peerStore = new Corestore(tmpDir('mb-vgate-peer-'));
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);
    const P = makeDevice('peer-vgate', 4242);

    // Op #0: CURRENT schema → must apply.
    await peerOwn.append({
      type: 'put', table: 'mb_vgate_table', hbKey: 'OK-1',
      value: { id: 'OK-1' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    // Op #1: CURRENT+1 schema (unknown-newer) → must be DROPPED by the gate.
    await peerOwn.append({
      type: 'put', table: 'mb_vgate_table', hbKey: 'FUTURE-1',
      value: { id: 'FUTURE-1' }, ts: 200, schema_version: CURRENT_SCHEMA_VERSION + 1,
      author_pubkey: P.devicePubkey,
    });
    replicate(peerStore, handle.store);

    // Admit P (valid sig + binding-verified). onAnnounce triggers a merge.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const decision = await handle.onAnnounce(announce);
    expect(decision.admit).toBe(true);

    // Explicit merge pass to be sure both ops were available to the gate.
    await handle.mergeNow();

    // ── A4 assertion: ONLY the CURRENT op applied; the CURRENT+1 op was dropped.
    expect(writes.map((w) => w.id)).toEqual(['OK-1']);

    // Exactly one schema-version alert fired, for the unknown-newer version,
    // scoped to this harness slug.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      harnessSlug: 'vgate-1',
      observed_version: CURRENT_SCHEMA_VERSION + 1,
      known_version: CURRENT_SCHEMA_VERSION,
    });

    // A repeat merge does NOT re-apply the dropped op nor re-fire the alert
    // (the gate's alert is once-per (slug, version)).
    await handle.mergeNow();
    expect(writes.map((w) => w.id)).toEqual(['OK-1']);
    expect(alerts).toHaveLength(1);
  });
});
