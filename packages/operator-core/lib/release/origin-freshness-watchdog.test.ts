/**
 * WI-5791 — coverage tests for `checkOriginFreshness`, the DB/registry WIRING.
 *
 * Why this file exists at all: `origin-freshness.test.ts` already covered the
 * pure verdict functions thoroughly, and every one of those tests passed for the
 * entire time this watchdog was completely blind. The untested half was never
 * "is the verdict right" — it was "does the sweep ever reach an entry to judge".
 * It did not: the sweep loaded ONE hard-coded workspace (`'default'`, which holds
 * only scratch pots) while every real bridged pot lives in another, so it
 * returned `checked: 0` on every pass and reported that as a clean bill of health.
 *
 * So these tests pin the two properties the pure tests structurally cannot:
 *   1. COVERAGE — the sweep reaches bridged entries in NON-default workspaces.
 *   2. SELF-REPORT — a sweep that covers nothing says so, instead of passing
 *      silently. That is the guard for the whole class (see
 *      agent-insights/absorbing-state-guards-and-self-report-detectors).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registries = vi.hoisted(() => ({ byWorkspace: new Map<string, unknown[]>() }));
const gitModes = vi.hoisted(() => ({ byPotHome: new Map<string, string>() }));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => true, // the bare store is always "present" for these tests
}));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: async (workspaceId?: string) => ({
    projects: registries.byWorkspace.get(String(workspaceId)) ?? [],
  }),
}));
vi.mock('../harness/git-sync/hive-git-mode', () => ({
  POT_GIT_MODE_SETTING_KEY: 'hiveGit.mode',
  getPotGitMode: async (_ws: string, potHomeSlug: string) => gitModes.byPotHome.get(potHomeSlug) ?? 'legacy',
}));
vi.mock('../sync/pot-git/repo-identity', () => ({ canonicalRepoKey: () => 'repo-key' }));
vi.mock('../sync/pot-git/github-ingress', () => ({ githubOriginDevicePubkey: () => 'pubkey' }));
vi.mock('../sync/pot-git/github-bridge-tick', () => ({ BRIDGE_CANONICAL_REF: 'refs/hive/staging' }));
/* Stub set derived from the REAL export list, so adding an export to storage.ts
 * cannot silently break this file — see EI-18748959711888135, where an absent
 * export threw inside a caller's try/catch, became a console.warn, and
 * vitest-fail-on-console red-pinned the fleet gate. Inert stubs resolve a promise
 * (storage's exports are mostly async and are often fire-and-forget); the explicit
 * stubs below win, including the SYNC hiveGitRepoPath this file needs. */
vi.mock('../sync/pot-git/storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inert = Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(async () => undefined) : v,
    ]),
  );
  return {
    ...inert,
    hiveGitRepoPath: (potHome: string) => `/fake/${potHome}`,
    readNamespaceRef: async () => null,
    defaultRunGit: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
});
// vitest 4 infers a vi.fn mock's Parameters from its initial implementation —
// a zero-arg arrow made `.mock.calls[N]` the empty tuple `[]`, so indexing
// `[0]` below (the event-payload assertions) failed to typecheck (TS2493)
// even though the real broadcast fns are always called with a payload. Rest
// params keep the mock bodies identical while giving `.mock.calls[N][0]` a
// real (unknown) element type for the existing `as {...}` casts to narrow.
const broadcasts = vi.hoisted(() => ({
  alarm: vi.fn(async (..._args: unknown[]) => true),
  resolved: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: broadcasts.alarm,
  broadcastSevereEventResolvedMany: broadcasts.resolved,
}));
// WI-6643: the alarm path dynamic-imports this. Stubbed so a test that drives a
// real alarm asserts the payload instead of doing owner-notification IO.
const notify = vi.hoisted(() => ({ attention: vi.fn(async (..._args: unknown[]) => undefined) }));
// notifyAttentionOnce: reached transitively (connected-apps/principal.ts imports it since
// 2026-09-30); a factory without it fails collection for the whole file.
vi.mock('../attention-notify', () => ({
  notifyAttention: notify.attention,
  notifyAttentionOnce: vi.fn(async (..._args: unknown[]) => undefined),
}));

import {
  checkOriginFreshness,
  integratorBacklogAcrossDevices,
  RECENT_DIVERGENCE_BEHIND_MAX,
} from './origin-freshness-watchdog';

/**
 * A postgres-template-tag stand-in that routes on the statement text. Records
 * every write so a test can assert what the sweep actually persisted.
 */
function makeSql(opts: { workspaceIds: string[]; bridgedPots: number; routineRow?: Record<string, unknown> }) {
  const writes: string[] = [];
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join(' ? ');
    if (/^\s*(UPDATE|INSERT|DELETE)/i.test(text)) {
      writes.push(text.replace(/\s+/g, ' ').trim() + ' :: ' + JSON.stringify(vals));
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    if (/FROM harness_shared\.harness_registry/i.test(text)) {
      return Promise.resolve(opts.workspaceIds.map((workspace_id) => ({ workspace_id })));
    }
    if (/FROM harness_shared\.pot_settings/i.test(text)) {
      return Promise.resolve([{ n: opts.bridgedPots }]);
    }
    if (/FROM harness_shared\.routines/i.test(text)) {
      return Promise.resolve(opts.routineRow ? [opts.routineRow] : []);
    }
    return Promise.resolve([]);
  };
  return { sql: sql as never, writes };
}

const BRIDGED_ENTRY = { slug: 'papercusp', self_repo: true, github_remote: 'git@github.com:x/y.git' };

beforeEach(() => {
  registries.byWorkspace.clear();
  gitModes.byPotHome.clear();
  broadcasts.alarm.mockClear();
  broadcasts.resolved.mockClear();
  notify.attention.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/**
 * The blindness broadcast is edge-triggered off MODULE-level state, so these
 * tests take a FRESH module instance each time — otherwise they'd silently
 * depend on execution order and stop testing the edge at all.
 */
async function freshWatchdog() {
  vi.resetModules();
  return (await import('./origin-freshness-watchdog')).checkOriginFreshness;
}

/**
 * WI-6643 — the WIRING half of "the alarm is named after its cause".
 *
 * origin-freshness.test.ts covers `describeOriginFreshnessAlert` as a pure
 * function. That is exactly the split that let the original bug ship: the pure
 * verdict was right (it said "REFUSED … (secrets)") while the watchdog emitted a
 * hardcoded origin-behind summary next to it. So the property worth pinning here
 * is not "the helper returns good text" — it is "the sweep actually EMITS that
 * text", which no pure test can see.
 */
describe('WI-6643 — a publish refusal reaches the broadcast surface named as a refusal', () => {
  /** A bridged pot whose publish leg has been refusing on `secrets` for a while. */
  const REFUSING_ROW = {
    of_origin_sha: null,
    of_origin_since_ms: null,
    of_alerted: false,
    of_alerted_cause: null,
    of_stall_sweeps: 3, // already past the sustain debounce
    of_publish_refused_sweeps: 5, // already past the 3-sweep refusal threshold
    publish_refused: 'secrets',
    egress_head: null,
  };

  async function sweepRefusing(row: Record<string, unknown> = REFUSING_ROW) {
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql, writes } = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 1,
      routineRow: row,
    });
    const check = await freshWatchdog();
    const out = await check(sql, { workspaceId: 'papercusp-workspace' });
    // PREMISE, asserted rather than assumed: two tests below assert SILENCE, and
    // a sweep that reached no entry is silent for the wrong reason. (This caught
    // a real harness bug while writing these — the sweep was being called with
    // the wrong arg shape, so every assertion passed or failed for no reason.)
    expect(out.checked).toBe(1);
    return { out, writes };
  }

  it('broadcasts the REFUSAL, not "GitHub origin is falling behind"', async () => {
    await sweepRefusing();
    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
    const ev = broadcasts.alarm.mock.calls[0][0] as { summary: string; body: string };
    // The exact regression: this line is all an agent sees in coord:inbox.
    expect(ev.summary).toMatch(/REFUSED/);
    expect(ev.summary).toMatch(/secrets/);
    expect(ev.summary).not.toMatch(/GitHub origin is falling behind/);
    // …and the runbook must not send them to the bridge, which is fine.
    expect(ev.body).toMatch(/pot_git:secrets_exemptions/);
    expect(ev.body).not.toMatch(/metadata\.github_bridge/);
  });

  it('pages the owner with the refusal framing too', async () => {
    await sweepRefusing();
    expect(notify.attention).toHaveBeenCalledTimes(1);
    const page = notify.attention.mock.calls[0][0] as { title: string; data: { cause: string } };
    expect(page.title).toMatch(/REFUSED/);
    expect(page.data.cause).toBe('publish-refused');
  });

  it('records the cause on the latch so a later cause CHANGE can re-alarm', async () => {
    const { writes } = await sweepRefusing();
    // The masking bug: one boolean shared by three signals meant whichever
    // latched first silenced the others for as long as it stayed stale.
    const latch = writes.find((w) => w.includes('of_alerted_cause'));
    expect(latch).toBeDefined();
    expect(latch).toContain('publish-refused');
  });

  it('stays silent when the SAME cause is already latched (one-shot holds)', async () => {
    await sweepRefusing({ ...REFUSING_ROW, of_alerted: true, of_alerted_cause: 'publish-refused' });
    expect(broadcasts.alarm).not.toHaveBeenCalled();
    expect(notify.attention).not.toHaveBeenCalled();
  });

  it('RE-ALARMS when a refusal begins under an already-latched origin-behind alert', async () => {
    // The masking case, stated: an origin-behind alarm latched first, then the
    // publish leg starts refusing. Because a refusal pins state:'stale', the old
    // shared boolean would never clear and the refusal would never be announced.
    await sweepRefusing({ ...REFUSING_ROW, of_alerted: true, of_alerted_cause: 'origin-behind' });
    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
    const ev = broadcasts.alarm.mock.calls[0][0] as { summary: string };
    expect(ev.summary).toMatch(/REFUSED/);
  });
});

describe('EI-27020703015857716 — publication health advances its own sweep counters', () => {
  async function sweep(routineRow: Record<string, unknown>) {
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql, writes } = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 1,
      routineRow,
    });
    const check = await freshWatchdog();
    const result = await check(sql, { workspaceId: 'papercusp-workspace' });
    expect(result.checked).toBe(1);
    return writes;
  }

  it('counts a publication refusal from zero even when origin has nothing to push', async () => {
    const writes = await sweep({
      of_origin_sha: null,
      of_origin_since_ms: null,
      of_alerted: false,
      of_alerted_cause: null,
      of_stall_sweeps: 0,
      of_publish_refused_sweeps: 0,
      publish_refused: 'secrets',
      of_publish_backlog_sweeps: 0,
      publish_backlog_remains: 'false',
      egress_head: null,
    });

    expect(
      writes.some((write) => write.includes("of_publish_refused_sweeps") && write.includes('[1,"papercusp"]')),
    ).toBe(true);
  });

  it('counts an undrained publication backlog from zero when origin has no new tip', async () => {
    const writes = await sweep({
      of_origin_sha: null,
      of_origin_since_ms: null,
      of_alerted: false,
      of_alerted_cause: null,
      of_stall_sweeps: 0,
      of_publish_refused_sweeps: 0,
      publish_refused: null,
      of_publish_backlog_sweeps: 0,
      publish_backlog_remains: 'true',
      publish_published_sha: null,
      publish_head_sha: 'd'.repeat(40),
      egress_head: null,
    });

    expect(
      writes.some((write) => write.includes("of_publish_backlog_sweeps") && write.includes('[1,"papercusp"]')),
    ).toBe(true);
  });
});

describe('WI-5791 — coverage: the sweep must reach every workspace, not just the default', () => {
  it('checks a bridged pot living in a NON-default workspace (the five-day blind spot)', async () => {
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    registries.byWorkspace.set('default', []); // scratch workspace, as in production
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql, writes } = makeSql({
      workspaceIds: ['default', 'papercusp-workspace'],
      bridgedPots: 1,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    const res = await checkOriginFreshness(sql, {});

    expect(res.checked).toBe(1);
    expect(res.blind).toBeUndefined();
    // The watchdog's OWN watermark must actually persist — a detector whose
    // clock never lands can never age a tip, so it could never alarm.
    expect(writes.some((w) => w.includes('of_origin_sha'))).toBe(true);
  });

  it('a single unreadable workspace does not abort the sweep of the others', async () => {
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql } = makeSql({
      workspaceIds: ['broken', 'papercusp-workspace'],
      bridgedPots: 1,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    // 'broken' has no registry entry in the map → resolves to [], the same
    // shape an unreadable workspace degrades to.
    const res = await checkOriginFreshness(sql, {});
    expect(res.checked).toBe(1);
  });

  it('honours an explicit workspaceId (test/caller injection) instead of enumerating', async () => {
    registries.byWorkspace.set('only-this', [BRIDGED_ENTRY]);
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql } = makeSql({
      workspaceIds: ['only-this', 'papercusp-workspace'],
      bridgedPots: 2,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    const res = await checkOriginFreshness(sql, { workspaceId: 'only-this' });
    expect(res.checked).toBe(1); // not 2 — the explicit scope wins
  });
});

describe('WI-5791 — self-report: a sweep that covers nothing must not read as healthy', () => {
  it('flags itself BLIND when it checks zero entries while bridged pots exist', async () => {
    registries.byWorkspace.set('default', []); // exactly the production misconfiguration
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });

    const res = await checkOriginFreshness(sql, {});

    expect(res.checked).toBe(0);
    expect(res.blind).toBe(true);
  });

  it('does NOT flag blind when there are genuinely no bridged pots to watch', async () => {
    registries.byWorkspace.set('default', []);
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 0 });

    const res = await checkOriginFreshness(sql, {});

    expect(res.checked).toBe(0);
    expect(res.blind).toBeUndefined(); // an empty install is not a broken watchdog
  });

  it('flags blind when workspace enumeration itself yields nothing', async () => {
    const { sql } = makeSql({ workspaceIds: [], bridgedPots: 2 });

    const res = await checkOriginFreshness(sql, {});

    expect(res.blind).toBe(true);
  });
});

describe('WI-5791 — the blindness alarm reaches a surface someone reads, without storming', () => {
  it('broadcasts a severe event the first time it goes blind', async () => {
    const check = await freshWatchdog();
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });

    await check(sql, {});

    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
    const ev = broadcasts.alarm.mock.calls[0][0] as { conditionKey: string; summary: string };
    expect(ev.conditionKey).toBe('origin-freshness:watchdog-blind');
    expect(ev.summary).toContain('BLIND');
  });

  it('does NOT re-broadcast on every subsequent blind sweep (15-min storm guard)', async () => {
    const check = await freshWatchdog();
    const { sql } = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });

    // broadcastSevereEvent messages EVERY agent and does not dedupe on
    // conditionKey — so an un-edge-triggered alarm would page the whole fleet
    // every sweep, forever.
    await check(sql, {});
    await check(sql, {});
    await check(sql, {});

    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
  });

  it('retracts the alarm when coverage comes back', async () => {
    const check = await freshWatchdog();
    const blind = makeSql({ workspaceIds: ['default'], bridgedPots: 3 });
    await check(blind.sql, {});
    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);

    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const covered = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 3,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    const res = await check(covered.sql, {});

    expect(res.blind).toBeUndefined();
    expect(broadcasts.resolved).toHaveBeenCalledTimes(1);
    const resolved = broadcasts.resolved.mock.calls[0][0] as { conditionKeys: string[] };
    expect(resolved.conditionKeys).toEqual(['origin-freshness:watchdog-blind']);
  });

  it('never broadcasts on a healthy covering sweep', async () => {
    const check = await freshWatchdog();
    registries.byWorkspace.set('papercusp-workspace', [BRIDGED_ENTRY]);
    gitModes.byPotHome.set('papercusp', 'bridged');
    const { sql } = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 1,
      routineRow: { egress_head: 'a'.repeat(40), of_origin_sha: null, of_origin_since_ms: null, of_alerted: false },
    });

    await check(sql, {});

    expect(broadcasts.alarm).not.toHaveBeenCalled();
    expect(broadcasts.resolved).not.toHaveBeenCalled();
  });
});

/**
 * EI-20285011147862697 — the publish-health pass covers pots that have NO origin.
 *
 * The origin pass gates on `github_remote` and `mode === 'bridged'`. Both are correct
 * as ORIGIN preconditions, but each `continue`d past the whole body, including the
 * publish-refusal signal — which needs no origin, because it reads the pot's own
 * `own_head_publish` self-report. Measured on 2026-08-12: 3 pots were bridged while 42
 * had a publish leg, so 39 legs were judged by nothing, and the one pot actually wedged
 * (papercusp-desktop, refused:'secrets', ~41h / 189 consecutive refusals) was in the
 * unwatched majority and never got the alarm it earned after 3 sweeps.
 *
 * The entry below is that pot's exact shape: NO github_remote, and mode defaulting to
 * 'legacy'. Note this test is only meaningful because those two facts hold — if a future
 * change makes such a pot reach the origin pass, this stops testing the gap it was
 * written for.
 */
describe('EI-20285011147862697 — a publish refusal on an origin-less pot still alarms', () => {
  /** papercusp-desktop's shape: publishes p2p, has no GitHub mirror, mode is legacy. */
  const ORIGINLESS_ENTRY = { slug: 'papercusp/papercusp-desktop', self_repo: true };

  const REFUSING_PUBLISH_ROW = {
    publish_refused: 'secrets',
    publish_backlog_remains: 'false',
    publish_published_sha: null,
    publish_head_sha: 'd'.repeat(40),
    of_publish_refused_sweeps: 5, // past the 3-sweep threshold
    of_publish_backlog_sweeps: 0,
    of_alerted: false,
    of_alerted_cause: null,
  };

  it('alarms, naming the refusal — and does NOT claim an origin it does not have', async () => {
    const check = await freshWatchdog();
    registries.byWorkspace.set('papercusp-workspace', [ORIGINLESS_ENTRY]);
    // deliberately NOT set to 'bridged' — the mock defaults it to 'legacy'
    const { sql } = makeSql({
      workspaceIds: ['papercusp-workspace'],
      // ZERO bridged pots: the only pot here is legacy/origin-less. This must stay 0 or
      // the WI-5791 blindness alarm correctly fires ("bridged pots exist but the origin
      // pass checked none") and masks what this test is actually asserting. Origin
      // coverage of 0 is CORRECT in this world — that is the whole point of the pass.
      bridgedPots: 0,
      routineRow: REFUSING_PUBLISH_ROW,
    });

    const res = await check(sql, {});

    // The origin pass could not judge it; the publish pass did.
    expect(res.checked).toBe(0);
    expect(res.publishChecked).toBe(1);
    expect(res.alarmed).toContain('papercusp/papercusp-desktop');

    // The alarm names the REFUSAL, not an origin-behind story (the WI-6643 property,
    // which must hold on this pass too or the alarm describes the wrong subsystem).
    expect(broadcasts.alarm).toHaveBeenCalledTimes(1);
    const payload = broadcasts.alarm.mock.calls[0]![0] as { summary: string; body: string };
    expect(`${payload.summary} ${payload.body}`).toMatch(/REFUS/i);
    expect(`${payload.summary} ${payload.body}`).toMatch(/secrets/i);

    // An origin-less pot must never be reported as origin-behind: there is no origin to
    // be behind, and manufacturing one is the exact false reading this file keeps
    // re-learning (the 2026-07-20 wrong-branch wedge).
    const notified = notify.attention.mock.calls[0]![0] as {
      data: { aheadCountStale: boolean; tipAgeStale: boolean; publishRefusalCode: string };
    };
    expect(notified.data.aheadCountStale).toBe(false);
    expect(notified.data.tipAgeStale).toBe(false);
    expect(notified.data.publishRefusalCode).toBe('secrets');
  });

  it('stays silent while the publish leg is healthy (the pass is not just always-on)', async () => {
    const check = await freshWatchdog();
    registries.byWorkspace.set('papercusp-workspace', [ORIGINLESS_ENTRY]);
    const { sql } = makeSql({
      workspaceIds: ['papercusp-workspace'],
      bridgedPots: 0, // see the note above — a legacy-only world has no origin coverage to miss
      routineRow: { ...REFUSING_PUBLISH_ROW, publish_refused: null, of_publish_refused_sweeps: 0 },
    });

    const res = await check(sql, {});

    expect(res.publishChecked).toBe(1); // it WAS judged — this is not silence-by-skipping
    expect(res.alarmed).toHaveLength(0);
    expect(broadcasts.alarm).not.toHaveBeenCalled();
  });
});

/**
 * EI-22702954391733746 — signal 5's INPUT, which had no coverage at all.
 *
 * That absence is not incidental to the bug, it IS the bug's survival mechanism: the pure
 * verdict tests in origin-freshness.test.ts all passed for the entire time this signal was
 * structurally incapable of firing, exactly as this file's own header describes for WI-5791.
 * The untested half was never "is the verdict right" — it was "does the signal read anything".
 *
 * It read this MACHINE's device namespace. Measured on papercusp 2026-09-08: bg-host's own
 * namespace stood 945 commits BEHIND canonical (last advanced two days earlier), so
 * `rev-list --count canonical..selfNS` was 0 — reported as "integrated / caught up" — while a
 * DIFFERENT device published 26 commits the frozen integrator never took. Origin sat frozen
 * ~8h and every signal in the module read healthy.
 *
 * The numbers below are that incident's real measurements, so a regression reproduces it.
 */
describe('integratorBacklogAcrossDevices (EI-22702954391733746)', () => {
  const CANONICAL_FROZEN = '00d844e2674033fd41884ac1c4d20d3c71c79596';
  const PUBLISHER_NS = '2353785026cfb9425edfd168f3ace2cdcb10b049'; // 26 ahead, 0 behind
  const SELF_NS = '6a83aa715b5d4b56c0728ed1597a73817ce6532f'; // bg-host's own: 945 BEHIND
  const DIVERGENT_NS = '9d65ef68aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 21 ahead but 32708 behind

  /** A runGit that answers only the two shapes the helper issues, from a declared graph. */
  const fakeGit = (
    namespaceShas: readonly string[],
    /** sha -> [behind, ahead] relative to the canonical under test. */
    graph: Record<string, [number, number]>,
  ) =>
    (async (args: readonly string[]) => {
      if (args[0] === 'for-each-ref') {
        const stdout = namespaceShas
          .map((sha, i) => `${sha} refs/namespaces/${'ab'.repeat(32)}${i}/refs/heads/staging`)
          .join('\n');
        return { code: 0, stdout, stderr: '' };
      }
      if (args[0] === 'rev-list' && args[1] === '--left-right') {
        const spec = args[3] ?? '';
        const sha = spec.slice(spec.indexOf('...') + 3);
        const pair = graph[sha];
        if (!pair) return { code: 1, stdout: '', stderr: 'unknown rev' };
        return { code: 0, stdout: `${pair[0]}\t${pair[1]}`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    }) as unknown as Parameters<typeof integratorBacklogAcrossDevices>[2];

  it('REGRESSION: reports the PUBLISHER device\'s backlog, not this machine\'s stale namespace', async () => {
    const backlog = await integratorBacklogAcrossDevices(
      '/fake/papercusp',
      CANONICAL_FROZEN,
      fakeGit([SELF_NS, PUBLISHER_NS, DIVERGENT_NS], {
        [SELF_NS]: [945, 0], // ancestor of canonical — stale, contributes nothing
        [PUBLISHER_NS]: [0, 26], // the real integrator backlog
        [DIVERGENT_NS]: [32708, 21], // abandoned/divergent — must be excluded
      }),
    );

    // The whole incident in one assertion: the old self-device read returned 0 here.
    expect(backlog).not.toBe(0);
    expect(backlog).toBe(26);
  });

  it('WI-10004251: counts a RECENTLY diverged publisher (2 behind) — the 22h freeze read null', async () => {
    // Real measurement from the 2026-09-29/30 freeze: the only publisher stood 2 commits
    // BEHIND frozen canonical 022775f4 and 397 ahead; every other device was abandoned.
    const RECENT_NS = 'f8b4e96b23aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backlog = await integratorBacklogAcrossDevices(
      '/fake/papercusp',
      CANONICAL_FROZEN,
      fakeGit([SELF_NS, RECENT_NS, DIVERGENT_NS], {
        [SELF_NS]: [945, 0],
        [RECENT_NS]: [2, 397],
        [DIVERGENT_NS]: [32708, 21],
      }),
    );
    expect(backlog).toBe(397);
  });

  it('WI-10004251 boundary: divergence beyond RECENT_DIVERGENCE_BEHIND_MAX stays excluded', async () => {
    const EDGE_NS = 'edge00000000000000000000000000000000000a';
    const read = (behind: number) =>
      integratorBacklogAcrossDevices(
        '/fake/papercusp',
        CANONICAL_FROZEN,
        fakeGit([EDGE_NS], { [EDGE_NS]: [behind, 9] }),
      );
    expect(await read(RECENT_DIVERGENCE_BEHIND_MAX)).toBe(9);
    expect(await read(RECENT_DIVERGENCE_BEHIND_MAX + 1)).toBeNull();
  });

  it('NEGATIVE CONTROL: healthy state reads 0 — the divergent device must not manufacture backlog', async () => {
    // Publisher caught up (ns == canonical). The divergent device is STILL 21 ahead, which is
    // why a naive max-over-all-devices would alarm on a perfectly healthy pot forever.
    const backlog = await integratorBacklogAcrossDevices(
      '/fake/papercusp',
      PUBLISHER_NS,
      fakeGit([SELF_NS, PUBLISHER_NS, DIVERGENT_NS], {
        [SELF_NS]: [945, 0],
        [DIVERGENT_NS]: [32708, 21],
      }),
    );

    expect(backlog).toBe(0);
  });

  it('reports NULL, not 0, when no namespace is integrable — blindness must not read as health', async () => {
    // Every device divergent or stale: we have no reading of the integrator at all. 0 would
    // claim "caught up", which is the exact conflation that hid this outage.
    const backlog = await integratorBacklogAcrossDevices(
      '/fake/papercusp',
      CANONICAL_FROZEN,
      fakeGit([SELF_NS, DIVERGENT_NS], {
        [SELF_NS]: [945, 0],
        [DIVERGENT_NS]: [32708, 21],
      }),
    );

    expect(backlog).toBeNull();
  });

  it('reports NULL when the store has no device namespaces at all', async () => {
    const backlog = await integratorBacklogAcrossDevices('/fake/papercusp', CANONICAL_FROZEN, fakeGit([], {}));
    expect(backlog).toBeNull();
  });

  it('reads every device namespace in ONE for-each-ref spawn', async () => {
    // bg-host runs at ~4.2GB RSS where each spawn blocks the event loop ~165ms, so a
    // per-device read loop is the shape readNamespaceRefForDevices exists to prevent.
    const calls: string[][] = [];
    const counting = (async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'for-each-ref') {
        return { code: 0, stdout: `${PUBLISHER_NS} refs/namespaces/aa/refs/heads/staging`, stderr: '' };
      }
      return { code: 0, stdout: '0\t3', stderr: '' };
    }) as unknown as Parameters<typeof integratorBacklogAcrossDevices>[2];

    await integratorBacklogAcrossDevices('/fake/papercusp', CANONICAL_FROZEN, counting);

    expect(calls.filter((c) => c[0] === 'for-each-ref')).toHaveLength(1);
  });
});
