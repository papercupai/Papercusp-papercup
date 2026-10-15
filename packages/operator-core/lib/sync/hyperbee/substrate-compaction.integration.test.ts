/**
 * substrate-peer-log-compaction-2026-06-13 P-008 — the $0 LOCAL-PARITY leg of the
 * compaction-under-live-replication proof (design A, D-005). Multi-PROCESS (real
 * substrate peers on a local hyperdht testnet), so the snapshot op genuinely
 * replicates peer→peer through the wire-leg the same way it will cross machines —
 * the from-scratch-process equivalent the in-process snapshot-fold suites can't give.
 *
 * What it proves (single box, real cross-process replication):
 *  1. COMPACTION UNDER LIVE REPLICATION — a writer that auto-compacts MID-STREAM
 *     (its own log crosses SNAPSHOT_COMPACT_EVERY_OPS = 1000 ops → boot.ts appends one
 *     `__snapshot__` op inside the merge pass) does NOT break a CONNECTED reader's
 *     replication stream: the reader keeps folding and converges to ALL the writer's
 *     winners (no lost ops, no stuck fold) despite the large snapshot op landing mid-stream.
 *  2. FRESH-JOINER FOLD FROM THE SNAPSHOT — a peer that joins AFTER the writer has
 *     compacted (flag on → `seedCursorFromSnapshots` positions its merge cursor at the
 *     writer's latest snapshot index) reconstitutes the FULL winner set by folding the
 *     snapshot + the post-snapshot tail — i.e. the snapshot-fold path is correct over a
 *     real replicated log, not just the in-memory fixture. Convergence here is the
 *     regression guard: a buggy snapshot expansion would drop the pre-snapshot keys and
 *     the joiner would never catch up.
 *
 * The flag is enabled per-process via the `PAPERCUSP_FLAG_*` env override (precedence over
 * FLAG_DEFAULTS, no PG needed) — the local children inherit it through `spawnPeerChild`'s
 * `...process.env`, so this needs ZERO production-code change.
 *
 * Real-hardware residual (the literal P-008 `needs-human` gate, NOT covered here): the
 * sparse-fetch BYTE-SKIP — that the joiner downloads only `[snapshotIndex, len)` of the
 * writer's Hypercore over a real WAN — needs download-stat instrumentation + two real
 * machines; this local leg proves the LOGIC (compaction replicates cleanly + folds
 * correctly cross-process), which is the prerequisite for that run.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { spawnPeerChild, type PeerChildHandle } from './perf/child-driver';
import type { PeerChildConfig, PeerChildResult } from './perf/peer-child';
import type { SshSlotSpec } from '../../deployment/p2p-perf-tier3/remote-peer';

const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
const TEN_MIN = 10 * 60_000;
// MUST exceed read-merge's SNAPSHOT_SCAN_LOOKBACK (SNAPSHOT_COMPACT_EVERY_OPS * 4 = 4000) for
// the BYTE-SKIP (proof 3) to manifest: `findLatestSnapshotIndex` floors its backward snapshot
// scan at `max(0, len - 4000)`, so a log SHORTER than the lookback floors at 0 and a fresh
// joiner scans (= downloads) the whole log to find the snapshot — no skip. Above the lookback,
// the floor is > 0 and the joiner touches only the tail `[snapshotIndex, len)`, skipping the
// pre-snapshot prefix. (1000 is also > SNAPSHOT_COMPACT_EVERY_OPS so the writer auto-compacts
// mid-stream regardless — proofs 1/2.)
const COUNT = 4600;

describe('substrate compaction under live replication — $0 local parity (multi-process, local testnet)', () => {
  it(
    'writer auto-compacts mid-stream → connected reader converges + a FRESH joiner folds from the snapshot, zero lost ops',
    async () => {
      process.env[FLAG_ENV] = '1'; // design-A snapshot compaction ON in every child (inherited via process.env)
      const testnet = await createTestnet(3);
      const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
        host: b.host,
        port: b.port,
      }));
      const slug = `sub-compact-${Date.now()}`;
      const dirs: string[] = [];
      const root = (tag: string): string => {
        const d = mkdtempSync(join(tmpdir(), `sub-compact-${tag}-`));
        dirs.push(d);
        return d;
      };
      const cfg = (over: Partial<PeerChildConfig> & Pick<PeerChildConfig, 'role' | 'peerIndex' | 'root'>): PeerChildConfig => ({
        workspaceId: 'p2p-compact',
        harnessSlug: slug,
        bootstrap,
        corpusAuthor: 'a'.repeat(64),
        ...over,
      });
      const handles: PeerChildHandle[] = [];
      try {
        // ── Writer (slot 0): appends COUNT ops as fast as possible; its merge pass
        //    auto-compacts once the own log passes 1000 ops (one additive `__snapshot__`). ──
        const writer = spawnPeerChild(cfg({ role: 'writer', peerIndex: 0, root: root('w'), rate: 0, count: COUNT, seed: 7 }), () => {});
        handles.push(writer);
        const writerReady = await writer.waitFor('ready', TEN_MIN);
        expect(writerReady).toBeTruthy();
        const writerKeyHex = (writerReady as unknown as { keyHex: string }).keyHex;

        // ── Connected reader (slot 1): joins BEFORE the load → replicates THROUGH the compaction. ──
        const reader = spawnPeerChild(
          cfg({ role: 'reader', peerIndex: 1, root: root('r'), expectedWinners: COUNT, mergePollMs: 500, catchUpTimeoutMs: TEN_MIN }),
          () => {},
        );
        handles.push(reader);
        expect(await reader.waitFor('ready', TEN_MIN)).toBeTruthy();
        expect(await reader.waitFor('admitted', TEN_MIN)).toBeTruthy();

        // Run the load. The writer auto-compacts mid-stream (op-count crosses 1000).
        writer.send('go');
        expect(await writer.waitFor('writer-done', TEN_MIN)).toBeTruthy();

        // PROOF 1: the connected reader converged to ALL COUNT winners despite the
        // mid-stream snapshot op — stream not broken, no ops lost.
        expect(await reader.waitFor('caught-up', TEN_MIN)).toBeTruthy();

        // COMPACTION BARRIER (EI-18724820303729937) — the happens-before this test
        // used to ASSUME. The writer appends its `__snapshot__` asynchronously, in a
        // merge pass on the merge-poll cadence; `writer-done` only means the APPENDS
        // finished. Boot the fresh joiner before that op lands and it finds no
        // snapshot, seeds its cursor at 0, and replays the whole history — proof 3
        // then fails with `contiguousLength == full length` (observed: 4601 vs a
        // 2300.5 bound). Which side wins is scheduling luck, so it read as a
        // load-sensitive flake: it fails exactly when the box is busiest, i.e. during
        // a full green-checkpoint run. Wait for the snapshot to EXIST — a bounded
        // poll-until, never a fixed sleep — so the joiner phase is deterministic.
        writer.send('wait-snapshot');
        const snap = await writer.waitFor('snapshot-ready', TEN_MIN);
        expect(snap, 'writer should answer wait-snapshot').toBeTruthy();
        expect(snap!.error, 'the snapshot barrier must report producer/scan failures directly').toBeUndefined();
        expect(
          (snap as unknown as { index: number | null }).index,
          'the writer must have appended its __snapshot__ BEFORE the fresh joiner boots — with no snapshot to seed from there is nothing to skip and the byte-skip proof below is vacuous',
        ).toBeGreaterThan(0);

        // ── Fresh joiner (slot 2): boots AFTER the writer compacted → with the flag on it
        //    seeds its cursor at the writer's snapshot index and folds forward. ──
        const joiner = spawnPeerChild(
          cfg({ role: 'reader', peerIndex: 2, root: root('j'), expectedWinners: COUNT, mergePollMs: 500, catchUpTimeoutMs: TEN_MIN }),
          () => {},
        );
        handles.push(joiner);
        expect(await joiner.waitFor('ready', TEN_MIN)).toBeTruthy();
        expect(await joiner.waitFor('admitted', TEN_MIN)).toBeTruthy();

        // PROOF 2: the fresh joiner reconstitutes the FULL winner set by folding the
        // snapshot + tail (a buggy snapshot-fold would drop the pre-snapshot keys and
        // never converge). This is the new-joiner replay-bound the compaction buys.
        expect(await joiner.waitFor('caught-up', TEN_MIN)).toBeTruthy();

        // PROOF 3 (the load-bearing P-008 claim): the fresh joiner SPARSE-FETCHED — it
        // downloaded only the post-snapshot TAIL of the writer's log, SKIPPING the
        // pre-snapshot prefix, while the from-start reader has the whole log.
        const joinerResult = await joiner.stopAndCollect();
        const readerResult = await reader.stopAndCollect();
        expect(joinerResult).toBeTruthy();
        expect(readerResult).toBeTruthy();
        const joinerW = joinerResult!.admittedStats?.find((s) => s.keyHex === writerKeyHex);
        const readerW = readerResult!.admittedStats?.find((s) => s.keyHex === writerKeyHex);
        expect(joinerW, 'joiner should have admitted the writer log').toBeTruthy();
        expect(readerW, 'reader should have admitted the writer log').toBeTruthy();
        // The fresh joiner SPARSE-FETCHED: it converged (has the tail) yet downloaded almost
        // none of the writer's history — its contiguous-from-0 downloaded prefix is near-zero,
        // vs the from-start reader's FULL-length prefix. That gap IS the new-joiner replay-skip
        // the compaction buys (the reader paid O(total-history); the joiner skips it).
        // (`contiguousLength`, not `has0`, is the signal — Hypercore may fetch block 0 alone for
        //  merkle/bitfield reasons, which is why a snapshot-seeded joiner can show has0=true but
        //  contiguousLength=0; it still skipped the whole middle of the log.)
        expect(joinerW!.hasLast).toBe(true); // converged: has the post-snapshot tail
        expect(readerW!.contiguousLength).toBe(readerW!.length); // control: reader has the FULL log
        expect(joinerW!.contiguousLength).toBeLessThan(readerW!.length / 2); // joiner skipped the history
      } finally {
        for (const h of handles) {
          try {
            h.send('stop');
          } catch {
            /* already gone */
          }
        }
        await new Promise((r) => setTimeout(r, 800));
        for (const h of handles) {
          try {
            h.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        await testnet.destroy().catch(() => {});
        for (const d of dirs) {
          try {
            rmSync(d, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        delete process.env[FLAG_ENV];
      }
    },
    TEN_MIN,
  );
});

// ── CRED-GATED: real ≥2-machine Hetzner compaction-under-replication (the literal P-008 deliverable) ──
const NINETY_MIN = 90 * 60_000;
const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) && !!hetznerSshKeyId && !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  'substrate compaction under live replication — REAL Hetzner frames (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      'writer compacts mid-stream over the real wire → connected reader converges + a FRESH joiner SPARSE-FETCHES (skips the history); DESTROYS always',
      async () => {
        const { provisionBenchFleet } = await import('../../deployment/p2p-perf-tier3/bench-frames');
        const { sshPeerLauncher } = await import('../../deployment/p2p-perf-tier3/remote-peer');
        const { HetznerDriver } = await import('../../deployment/hetzner/hetzner-driver');
        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const size = process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31';
        const locations = (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash').split(',').map((s) => s.trim());
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        // 2 distinct VMs: the WRITER alone on frame 0; the connected READER + the fresh JOINER on
        // frame 1 — so the joiner sparse-fetches the writer's log ACROSS a real machine boundary.
        const needsIndexSuffix = new Set(locations.slice(0, 2)).size < 2;

        const fleet = await provisionBenchFleet({
          driver: HetznerDriver,
          repoRoot,
          sshIdentityFile: hetznerIdentity!,
          providerDefaults: { sshKeys: [sshKeyId], sshIdentityFile: hetznerIdentity! },
          specs: Array.from({ length: 2 }, (_, i) => ({
            label: locations[i % locations.length] + (needsIndexSuffix ? `-${i}` : ''),
            region: locations[i % locations.length],
            size,
            kind: 'vm' as const,
            firewall: false, // direct WAN — the byte-skip just needs real cross-machine replication
          })),
          log: (lvl, m) => console.log(`[compact-xm ${lvl}] ${m}`),
        });

        try {
          const slug = `sub-compact-xm-${Date.now()}`;
          const flagEnv = { [FLAG_ENV]: '1' };
          // 3 logical peers over the 2 frames: writer→frame0, reader+joiner→frame1.
          const slotSpecs: SshSlotSpec[] = [
            { label: `${fleet.frames[0].spec.label}-writer`, target: fleet.frames[0].target, extraEnv: flagEnv },
            { label: `${fleet.frames[1].spec.label}-reader`, target: fleet.frames[1].target, extraEnv: flagEnv },
            { label: `${fleet.frames[1].spec.label}-joiner`, target: fleet.frames[1].target, extraEnv: flagEnv },
          ];
          const launcher = sshPeerLauncher({ frames: slotSpecs, log: (l) => console.log(`[compact-xm] ${l}`) });
          const [wSlot, rSlot, jSlot] = launcher.slots;
          const base = (over: Partial<PeerChildConfig> & Pick<PeerChildConfig, 'role' | 'peerIndex'>): PeerChildConfig => ({
            workspaceId: 'p2p-compact',
            harnessSlug: slug,
            root: '', // sshPeerLauncher sets the remote /tmp root
            corpusAuthor: 'a'.repeat(64),
            ...over,
          });

          // Writer compacts mid-stream (COUNT > SNAPSHOT_SCAN_LOOKBACK so the joiner can skip the prefix).
          const writer = wSlot.launch(base({ role: 'writer', peerIndex: 0, rate: 0, count: COUNT, seed: 7 }));
          const writerReady = await writer.waitFor('ready', NINETY_MIN);
          expect(writerReady).toBeTruthy();
          const writerKeyHex = (writerReady as unknown as { keyHex: string }).keyHex;

          const reader = rSlot.launch(base({ role: 'reader', peerIndex: 1, expectedWinners: COUNT, mergePollMs: 1000, catchUpTimeoutMs: NINETY_MIN }));
          expect(await reader.waitFor('ready', NINETY_MIN)).toBeTruthy();
          expect(await reader.waitFor('admitted', NINETY_MIN)).toBeTruthy();

          writer.send('go');
          expect(await writer.waitFor('writer-done', NINETY_MIN)).toBeTruthy();
          expect(await reader.waitFor('caught-up', NINETY_MIN)).toBeTruthy(); // converged THROUGH the compaction

          // Fresh joiner — across the machine boundary from the writer — folds from the snapshot.
          const joiner = jSlot.launch(base({ role: 'reader', peerIndex: 2, expectedWinners: COUNT, mergePollMs: 1000, catchUpTimeoutMs: NINETY_MIN }));
          expect(await joiner.waitFor('ready', NINETY_MIN)).toBeTruthy();
          expect(await joiner.waitFor('admitted', NINETY_MIN)).toBeTruthy();
          expect(await joiner.waitFor('caught-up', NINETY_MIN)).toBeTruthy();

          const joinerResult: PeerChildResult | null = await joiner.stopAndCollect();
          const readerResult: PeerChildResult | null = await reader.stopAndCollect();
          const joinerW = joinerResult?.admittedStats?.find((s) => s.keyHex === writerKeyHex);
          const readerW = readerResult?.admittedStats?.find((s) => s.keyHex === writerKeyHex);
          console.log('[compact-xm byte-skip]', JSON.stringify({ joiner: joinerW, reader: readerW }));
          expect(joinerW).toBeTruthy();
          expect(readerW).toBeTruthy();
          // THE P-008 PROOF over a real wire: the fresh joiner sparse-fetched — it converged (tail
          // present) but downloaded almost none of the writer's history vs the from-start reader.
          expect(joinerW!.hasLast).toBe(true);
          expect(readerW!.contiguousLength).toBe(readerW!.length);
          expect(joinerW!.contiguousLength).toBeLessThan(readerW!.length / 2);
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);
