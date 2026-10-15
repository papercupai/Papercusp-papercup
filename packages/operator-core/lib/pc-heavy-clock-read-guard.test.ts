import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTextCollector } from './child-output';
import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

/**
 * EI-21894520557549786 — a bounded pc-heavy wait loop went SILENT for its
 * whole timeout under fleet contention: `npm run test:affected` ran for its
 * full 40-minute deadline, emitted only the initial command echo, and was
 * SIGTERMed externally having measured ZERO tasks.
 *
 * Root defect (confirmed by direct bash test, not just reading): every wait
 * loop in pc-heavy.sh read the clock via `$(date +%s)` — a forked external
 * command — on EVERY tick. Under the fork pressure documented alongside the
 * sibling EI-21415546552163181 ("pc-heavy runner exits 254 when host fork
 * returns EAGAIN"), that fork can fail and return empty. An empty `_now`
 * then poisoned BOTH halves of the wait: the heartbeat arithmetic (bash
 * treats "" as 0 in `$(( ))`, so the diff never crosses the threshold) AND
 * the deadline check (`[ "" -ge N ]` errors "integer expression expected" —
 * silently, since this script runs under `set -uo pipefail` with no `-e` —
 * so the surrounding `&&`/`if` guarding `break` never fires). Together: a
 * BOUNDED wait becomes UNBOUNDED and TOTALLY SILENT, exactly the "neither
 * red nor green" shape the bug report calls out as the dangerous one.
 *
 * Fix: read the clock via bash's builtin `$EPOCHSECONDS` (bash 5.0+)
 * instead of forking `date +%s`, at every wait-loop tick. Confirmed via
 * strace that a bare `$EPOCHSECONDS` reference costs ZERO clone/fork
 * syscalls, vs one for `$(date +%s)` — this eliminates the fork-pressure
 * vulnerability at its ROOT (the loop no longer needs `date` to succeed at
 * all) rather than merely defending against its failure. On any bash below
 * 5.0, where EPOCHSECONDS is unset, `${EPOCHSECONDS:-$(date +%s)}` falls
 * back to the original (still fork-vulnerable, but status-quo) behavior —
 * never a new regression.
 *
 * This suite proves both halves: the source now reads the clock this way at
 * every identified site (structural), and a live, contended waiter still
 * heartbeats and honors its timeout correctly EVEN WHEN `date` is entirely
 * unusable on PATH (behavioral) — the exact condition the original bug
 * needed to hang.
 */

// Overridable so falsifiability can be proven against a mutated COPY outside
// the tree (scripts/mutation-probe.sh tier 2) without ever mutating the
// shared checkout — git-sync commits the whole tree on a short cadence, so
// an in-tree mutation can be committed mid-probe even when nothing goes
// wrong. Every reference to the subject goes through this constant.
const PC_HEAVY = process.env.PC_HEAVY_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');
const source = readFileSync(PC_HEAVY, 'utf8');

describe('pc-heavy wait loops read the clock without forking (EI-21894520557549786)', () => {
  it('is syntactically valid bash', () => {
    expect(() =>
      execFileSync('bash', ['-n', PC_HEAVY], { timeout: 10_000, killSignal: 'SIGKILL' }),
    ).not.toThrow();
  });

  // One assertion per confirmed wait-loop site, anchored on the line
  // immediately preceding it so a future edit that reorders unrelated code
  // cannot make this pass by accident. Each site must read via
  // `${EPOCHSECONDS:-$(date +%s)}`, never a bare `$(date +%s)`.
  const sites: Array<{ label: string; anchor: string; read: string }> = [
    {
      label: 'exclusive-writer contention loop (initial anchor)',
      anchor: 'exec {_exclusive_writer_fd}>"$_exclusive_writer_path"',
      read: '_exclusive_writer_started="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'exclusive-writer contention loop (per-tick read)',
      anchor: 'kill -0 "$_exclusive_writer_wait_pid" 2>/dev/null; do',
      read: '_exclusive_writer_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'exclusive slot-drain barrier (initial anchor)',
      anchor: '"$_exclusive_slot_count" -lt 1 ] && _exclusive_slot_count=1',
      read: '_exclusive_started="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'exclusive slot-drain barrier (per-tick read)',
      anchor: '_exclusive_release_partial',
      read: '_exclusive_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'ordinary heavy-slot queue (initial anchor)',
      anchor: 'waiting up to ${_timeout}s" >&2',
      read: '_wait_start="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'ordinary heavy-slot queue (per-tick read)',
      // The sweep body became _try_acquire_slot (WI-10005334); this is the loop's acquire line.
      anchor: 'if _try_acquire_slot; then break; fi',
      read: '_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'retry-intent-clear wait (initial anchor)',
      anchor: 'command -v flock >/dev/null 2>&1 || return 0',
      read: '_intent_started="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'retry-intent-clear wait (heartbeat-branch read)',
      anchor: 'retry still waiting for exclusive materializer intent',
      read: '_intent_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'retry-intent-clear wait (pre-deadline fallback read)',
      anchor: 'exclusive materializer intent cleared; starting retry',
      read: '_intent_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'preempt child-pid wait (deadline initialization)',
      anchor: '[ -n "${_preempt_wait_pid:-}" ] || return 1',
      read: '_deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + 1 ))',
    },
    {
      label: 'preempt child-pid wait (per-tick deadline check)',
      anchor: 'while [ -z "${_preempt_child_pid:-}" ] && kill -0 "${_preempt_wait_pid:-}" 2>/dev/null; do',
      read: '[ "${EPOCHSECONDS:-$(date +%s)}" -ge "$_deadline" ]',
    },
    {
      label: 'preempt group reap (deadline initialization)',
      anchor: 'kill -TERM -- "-${_preempt_child_pid:-}" 2>/dev/null || true',
      read: '_deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + ${_preempt_term_grace:-30} ))',
    },
    {
      label: 'preempt group reap (per-tick deadline check)',
      anchor: '_deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + ${_preempt_term_grace:-30} ))',
      read: 'while _preempt_group_alive && [ "${EPOCHSECONDS:-$(date +%s)}" -lt "$_deadline" ]; do',
    },
    {
      label: 'preempt child-start wait (deadline initialization)',
      anchor: '_preempt_wait_pid=$!',
      read: '_preempt_start_deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + 5 ))',
    },
    {
      label: 'preempt child-start wait (per-tick deadline check)',
      anchor: 'if ! kill -0 "$_preempt_wait_pid" 2>/dev/null; then',
      read: 'if [ "${EPOCHSECONDS:-$(date +%s)}" -ge "$_preempt_start_deadline" ]; then',
    },
    {
      label: 'preempt monitor after-ready lease',
      anchor: 'if _preempt_ready_is_published; then',
      read: '_preempt_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'preempt monitor ordinary-holder grace',
      anchor: '        continue\n      fi\n      _preempt_ready_seen_at=\'\'',
      read: '_preempt_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'preempt monitor grace-clear hysteresis',
      anchor: 'noise, not evidence the materializer left.',
      read: '_preempt_now="${EPOCHSECONDS:-$(date +%s)}"',
    },
    {
      label: 'coalescing leader-liveness fallback',
      anchor: '_lm=$(stat -c %Y "$_c_lockdir" 2>/dev/null || echo 0)',
      read: '[ $(( ${EPOCHSECONDS:-$(date +%s)} - _lm )) -le "$_coalesce_ttl" ]',
    },
    {
      label: 'coalescing wait (deadline initialization)',
      anchor: 'defeating coalescing for exactly the latecomers it exists to help,',
      read: '_c_deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + _c_max_wait ))',
    },
    {
      label: 'coalescing wait (per-tick deadline check)',
      anchor: '# Deliberately fall through to the deadline check + sleep rather than',
      read: '[ "${EPOCHSECONDS:-$(date +%s)}" -ge "$_c_deadline" ]',
    },
  ];

  for (const { label, anchor, read } of sites) {
    it(`${label}: reads via $EPOCHSECONDS, not a bare $(date +%s)`, () => {
      const anchorAt = source.indexOf(anchor);
      expect(anchorAt, `anchor text must exist: ${JSON.stringify(anchor)}`).toBeGreaterThan(-1);
      // Search a bounded window after the anchor for the guarded read — wide
      // enough to span a preceding comment block, narrow enough that it
      // cannot accidentally match a DIFFERENT site's read.
      const window = source.slice(anchorAt, anchorAt + 1500);
      expect(window, `${label}: expected "${read}" within 1500 chars of the anchor`).toContain(read);
    });
  }

  it('never leaves an unguarded bare date read at any identified wait-loop site', () => {
    // Positive control for the assertions above: this exact bare pattern is
    // what the ORIGINAL bug looked like. Its absence here is not vacuous —
    // grep confirms the identified loops' specific variable names no longer appear
    // paired with a bare (unguarded) date call.
    const bareForms = [
      '_exclusive_writer_now=$(date +%s)',
      '_exclusive_now=$(date +%s)',
      '_wait_start=$(date +%s)',
      '_intent_now=$(date +%s)',
      '_intent_started=$(date +%s)',
      '_exclusive_writer_started=$(date +%s)',
      '_exclusive_started=$(date +%s)',
      '_deadline=$(( $(date +%s) + 1 ))',
      '[ "$(date +%s)" -ge "$_deadline" ]',
      '_deadline=$(( $(date +%s) + ${_preempt_term_grace:-30} ))',
      'while _preempt_group_alive && [ "$(date +%s)" -lt "$_deadline" ]; do',
      '_preempt_start_deadline=$(( $(date +%s) + 5 ))',
      'if [ "$(date +%s)" -ge "$_preempt_start_deadline" ]; then',
      '_preempt_now=$(date +%s)',
      '[ $(( $(date +%s) - _lm )) -le "$_coalesce_ttl" ]',
      '_c_deadline=$(( $(date +%s) + _c_max_wait ))',
      '[ "$(date +%s)" -ge "$_c_deadline" ]',
    ];
    for (const bare of bareForms) {
      expect(source, `must not contain the unguarded form: ${bare}`).not.toContain(bare);
    }
  });
});

describe('$EPOCHSECONDS truly costs zero forks (the mechanism this fix relies on)', () => {
  it('a bare $EPOCHSECONDS reference performs no clone/fork/vfork syscall', () => {
    // strace -c summarizes syscalls; a bare variable expansion assigned to a
    // shell var (no command substitution) should show NO clone/fork line at
    // all for the reference itself. Skips cleanly if strace is unavailable
    // (a bare-container CI image) rather than false-failing on a missing tool.
    // WI-41180: bound every sync spawn in the pure lane — it blocks the shared worker's
    // event loop, so vitest cannot time it out and one hang wedges ~2,740 files.
    const strace = spawnSync('which', ['strace'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    if (strace.status !== 0) return;
    const r = spawnSync(
      'strace',
      ['-f', '-c', '-e', 'trace=clone,fork,vfork', 'bash', '-c', 'x=$EPOCHSECONDS'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    // strace writes its summary to stderr.
    expect(r.stderr).not.toMatch(/\bclone\b|\bfork\b|\bvfork\b/);
  });

  it('POSITIVE CONTROL: $(date +%s) DOES fork — proves the instrument works', () => {
    // WI-41180: bound every sync spawn in the pure lane — it blocks the shared worker's
    // event loop, so vitest cannot time it out and one hang wedges ~2,740 files.
    const strace = spawnSync('which', ['strace'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    if (strace.status !== 0) return;
    const r = spawnSync(
      'strace',
      ['-f', '-c', '-e', 'trace=clone,fork,vfork', 'bash', '-c', 'x=$(date +%s)'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(r.stderr).toMatch(/\bclone\b/);
  });

  it('$EPOCHSECONDS still advances with real wall-clock time (not a stale one-shot value)', async () => {
    const r1 = spawnSync('bash', ['-c', 'echo $EPOCHSECONDS'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    await new Promise((res) => setTimeout(res, 1100));
    const r2 = spawnSync('bash', ['-c', 'echo $EPOCHSECONDS'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(Number(r2.stdout.trim())).toBeGreaterThan(Number(r1.stdout.trim()));
  });

  it('$EPOCHSECONDS matches `date +%s` within 1 second (correctness, not just presence)', () => {
    const r = spawnSync('bash', ['-c', 'echo $EPOCHSECONDS; date +%s'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    const [a, b] = r.stdout.trim().split('\n').map(Number);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });
});

describe('live: a contended waiter still heartbeats and honors its timeout with `date` entirely unusable', () => {
  let dir = '';
  let brokenDateDir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pcheavy-clockguard-'));
    // A `date` binary that ALWAYS fails — simulates the pathological,
    // sustained fork-pressure condition the original bug needed (every
    // single `date +%s` call in the loop failing, not just one). Placed
    // FIRST on PATH so it shadows the real `date`.
    brokenDateDir = mkdtempSync(join(tmpdir(), 'pcheavy-brokendate-'));
    const fakeDate = join(brokenDateDir, 'date');
    writeFileSync(fakeDate, '#!/usr/bin/env bash\nexit 1\n');
    chmodSync(fakeDate, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(brokenDateDir, { recursive: true, force: true });
  });

  function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      // brokenDateDir FIRST so its `date` shadows the real one for every
      // subprocess this test spawns, matching a host where `date` is
      // genuinely unable to fork.
      PATH: `${brokenDateDir}:${process.env.PATH ?? ''}`,
      PC_HEAVY_DIR: dir,
      PC_HEAVY_IONICE: '',
      PAPERCUSP_CHECKPOINT_LOG_DIR: join(dir, 'checkpoint-logs'),
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '0',
      ...extra,
    };
  }

  async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (predicate()) return;
      if (Date.now() - started > timeoutMs) throw new Error(`waitFor(${JSON.stringify(label)}) timed out`);
      await new Promise((res) => setTimeout(res, 20));
    }
  }

  function heldSlotCount(slotsDir: string, slots: number): number {
    let held = 0;
    for (let i = 0; i < slots; i += 1) {
      const probe = spawnSync('flock', ['-n', join(slotsDir, `slot.${i}`), 'true'], {
        stdio: 'ignore',
        // WI-41180: bound every sync spawn in the pure lane — vitest cannot interrupt one.
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      if (probe.status !== 0) held += 1;
    }
    return held;
  }

  function killGroup(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  it('the broken-date fixture itself actually fails (sanity check on the fixture)', () => {
    const r = spawnSync('date', ['+%s'], {
      env: { PATH: `${brokenDateDir}:${process.env.PATH ?? ''}` },
      // WI-41180: bound every sync spawn in the pure lane — vitest cannot interrupt one.
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status).not.toBe(0);
  });

  it('emits periodic "still queued" heartbeats AND honors PC_HEAVY_TIMEOUT_SEC, with `date` unusable throughout', async () => {
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      ...pcHeavyFixtureOptions(dir, baseEnv({ PC_HEAVY_SLOTS: '1' })),
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo got-it'], {
        ...pcHeavyFixtureOptions(
          dir,
          baseEnv({
            PC_HEAVY_SLOTS: '1',
            PC_HEAVY_TIMEOUT_SEC: '20',
            PC_HEAVY_HEARTBEAT_SEC: '1',
          }),
        ),
      });
      // Boundary-safe accumulation (WI-6728): `+= String(chunk)` decodes each
      // chunk independently, so a multi-byte character split across two 'data'
      // events becomes replacement chars. `beats()` polls while the child runs,
      // so it reads via peek() — the non-flushing read — and the assertions
      // below read text() once the child has exited.
      const stderrOut = createTextCollector(waiter.stderr);
      const stdoutOut = createTextCollector(waiter.stdout);
      const exited = new Promise<number>((res) => waiter.on('exit', (c) => res(c ?? -1)));
      const beats = () => (stderrOut.peek().match(/\[pc-heavy\] still queued/g) ?? []).length;

      // With the ORIGINAL `$(date +%s)` pattern and a permanently-broken
      // `date`, this would never happen — the heartbeat arithmetic silently
      // never crosses its threshold because `_now` never advances (stuck at
      // "" -> arithmetic 0). This is the direct behavioral proof the fix
      // works: $EPOCHSECONDS never calls `date` at all, so a broken `date`
      // cannot suppress the heartbeat.
      await waitFor('two "still queued" heartbeats despite date being broken', () => beats() >= 2, 15_000);

      killGroup(holder); // frees the slot; the waiter now proceeds
      const code = await exited;
      expect(stdoutOut.text().trim()).toBe('got-it');
      expect(code).toBe(0);
      expect(beats()).toBeGreaterThanOrEqual(2);
    } finally {
      killGroup(holder);
    }
  }, 30_000);

  // NOTE: a "does the waiter's own deadline fire (REFUSED) rather than
  // needing an external kill" test was deliberately NOT added here with
  // this suite's blanket-broken `date` fixture. That fixture breaks EVERY
  // `date +%s` call for the whole process tree, including the ~10 sites in
  // the `_preempt_*` child-process-group monitor paths covered by the
  // structural assertions above
  // that wrap the holder's own `sleep` command — so it was observed to
  // perturb multiple monitor deadline paths rather than
  // isolating one of the identified wait-loop sites. A narrower deadline
  // test belongs with the follow-up fix for those sites, where the fixture
  // can be scoped to one monitor path if that coverage is needed later.
});
