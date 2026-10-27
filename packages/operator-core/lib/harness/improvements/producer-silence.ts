/**
 * producer-silence.ts — the zero-output alarm for every ACTIVE learning producer
 * (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-009, WI-10007523).
 *
 * THE GAP: nothing noticed when a learning producer that is switched ON stopped
 * producing. The Gym sat idle from 2026-08-28 for six weeks with its autoloop
 * enabled (WI-10007379: `gym_autoloop_config.budget_usd` NULL, so every 30-min fire
 * was rejected), and Red Queen had a similar silent stretch. The pot-gate module
 * already shipped the predicate such a detector needs (`isDeliberatePause`) but no
 * caller existed.
 *
 * WHAT COUNTS AS ACTIVE (all three must hold — each is an explicit switch someone
 * flipped, so silence behind any of them is deliberate, never a fault):
 *   1. the producer's learning-governor loop row is `enabled`;
 *   2. the pot's learning switch is on (`learning_pot_scope`, absent row = on);
 *   3. the producer's driving routine is not explicitly `active:false`. A routine
 *      with NO row does not exempt: "enabled but nothing drives it" is exactly the
 *      silent class this exists to catch.
 * Producer-specific off-switches (the gym autoloop config) exempt the same way.
 *
 * THE POT SWITCH (P-009's second half): a pot switched OFF with no recorded reason
 * still has its enabled loops silenced, but nobody can tell whether that was meant.
 * `isDeliberatePause` says such a pause should keep being flagged; a deliberate one
 * past its `reviewBy` date is flagged too.
 *
 * SCOPE: the producer set is DERIVED from `LEARNING_PRODUCERS`, and the probe map is
 * typed `Record<LearningProducer, …>`, so a producer added there cannot compile
 * without a probe. Governor loops no probe claims (dream:*, miners, …) are reported
 * as `unprobed` in the tick note rather than silently passed. su-ideate's OUTPUT AGE
 * is out of scope by decision (plan D-007): its passes are demand-driven by the D-015
 * overdue verdict, so a quiet pot correctly produces nothing and a time-based alarm
 * would misfire. Its DEAD PASSES are in scope (plan D-010): a harness whose scheduled
 * passes keep dying without recording opens the scheduler's circuit
 * (`readSuIdeateOpenCircuits`), and an open circuit is raised here as a bug signal —
 * before D-010 it was only a logged scheduler decision that nothing surfaced.
 *
 * READ FAILURES never become "silent": a probe whose read throws is reported
 * `unmeasured` and emits nothing, so a broken table read cannot file a false bug.
 */

import type { Sql } from 'postgres';
import { LEARNING_PRODUCERS, type LearningProducer } from '../../experiment/lifecycle-adapter';
import type { LearningLoopRegistration } from '../../learning-governor/core';
import { isDeliberatePause, pauseReviewOverdue, type PotLearningScope } from '../../learning/pot-gate/core';
import type { WatchdogSignal } from './watchdog';
import { pgTimestampToIsoOrNull } from '../../pg-timestamp';
import type { SuIdeateOpenCircuit } from '../../scout/su-ideate-schedule';

/** Key for a workspace-level producer's single output reading (not per pot). */
export const ANY_POT = '*';

const HOUR_MS = 3_600_000;

export interface ProducerSilenceProbe {
  /** The pot this governor loop drives for this producer, or null when the loop is not this producer's. */
  loopPot: (loopId: string, loopPotSlug: string | null) => string | null;
  /** The routine that drives the producer. perPot: install_slug = pot; else any install (a singleton). */
  routine: { name: string; perPot: boolean };
  /** Default silence threshold, hours — sized to the producer's measured cadence. */
  silenceHours: number;
  /** What counts as output, for the signal body. */
  output: string;
  /** Last-output epoch ms per pot slug (or {@link ANY_POT} for a workspace-level producer). */
  readLastOutput: (sql: Sql, workspaceId: string) => Promise<Map<string, number>>;
  /** A producer-side condition that explains why no output was expected (a gate or no due work). */
  readIntentionalSilence?: (sql: Sql, workspaceId: string, nowMs: number) => Promise<Map<string, string>>;
}

function prefixedLoop(prefix: string) {
  return (loopId: string): string | null => (loopId.startsWith(prefix) && loopId.length > prefix.length ? loopId.slice(prefix.length) : null);
}

function namedLoop(id: string) {
  return (loopId: string, loopPotSlug: string | null): string | null => (loopId === id ? loopPotSlug ?? ANY_POT : null);
}

/**
 * A probe's `max(<timestamptz>)` to epoch ms. The SQL transport can return the timestamp as a
 * `Date` OR as Postgres text ("2026-10-08 12:00:00.123-04"); `Number()` of the text is NaN, which
 * read every real output as "never produced" and fired a false silence alarm for all five
 * producers on live data (2026-10-08). Text goes through the shared pg-timestamp normaliser.
 */
export function msOf(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const text = String(v).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const iso = pgTimestampToIsoOrNull(text);
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function perPotMax(rows: Array<{ pot: string | null; last: unknown }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const ms = msOf(r.last);
    if (r.pot && ms !== null) out.set(r.pot, ms);
  }
  return out;
}

function singleMax(rows: Array<{ last: unknown }>): Map<string, number> {
  const ms = msOf(rows[0]?.last);
  return ms === null ? new Map() : new Map([[ANY_POT, ms]]);
}

/**
 * One probe per learning producer. Cadences measured 2026-10-08 on papercusp-workspace
 * (7-day output counts): scout 212 ran ticks, red-queen 21 drills, regret 3 findings,
 * calibration 2 predictions, transfer 1 lesson; gym 0 (silent since 2026-08-28).
 */
export const PRODUCER_SILENCE_PROBES: Record<LearningProducer, ProducerSilenceProbe> = {
  scout: {
    loopPot: prefixedLoop('blender:'),
    routine: { name: 'bp-singleton-scout-0', perPot: false },
    silenceHours: 24,
    output: "a scout_ticks row with status 'ran' and origin scout",
    readLastOutput: async (sql, ws) =>
      perPotMax(await sql<Array<{ pot: string | null; last: unknown }>>`
        SELECT pot_slug AS pot, max(tick_at) AS last FROM harness_shared.scout_ticks
         WHERE workspace_id = ${ws} AND status = 'ran' AND coalesce(origin, 'scout') = 'scout'
         GROUP BY pot_slug`),
    // Scout's generation-preflight records deliberate no-output cycles as gated ticks.
    // When every scoped tick for the whole silence window is the deep-admission gate,
    // the output gap is explained by backpressure rather than a wedged producer.
    readIntentionalSilence: async (sql, ws, nowMs) => {
      const since = new Date(nowMs - 24 * HOUR_MS);
      const rows = await sql<Array<{
        pot: string | null;
        ticks: number | string;
        latest: unknown;
        all_deep_gated: boolean;
      }>>`
        SELECT pot_slug AS pot,
               count(*)::int AS ticks,
               max(tick_at) AS latest,
               bool_and(status = 'gated' AND detail->>'reason' = 'admission-throttle-deep') AS all_deep_gated
          FROM harness_shared.scout_ticks
         WHERE workspace_id = ${ws}
           AND coalesce(origin, 'scout') = 'scout'
           AND tick_at >= ${since}::timestamptz
         GROUP BY pot_slug`;
      const suppressed = new Map<string, string>();
      for (const row of rows) {
        if (!row.pot || row.all_deep_gated !== true) continue;
        const latestMs = msOf(row.latest);
        if (latestMs === null) continue;
        suppressed.set(
          row.pot,
          `all ${Number(row.ticks)} Scout ticks in the 24h window were gated by deep admission throttle; latest ${new Date(latestMs).toISOString()}`,
        );
      }
      return suppressed;
    },
  },
  gym: {
    loopPot: prefixedLoop('gym:'),
    routine: { name: 'gym-cycle', perPot: true },
    silenceHours: 48,
    output: 'a gym_proposals row',
    readLastOutput: async (sql, ws) =>
      perPotMax(await sql<Array<{ pot: string | null; last: unknown }>>`
        SELECT harness_slug AS pot, max(created_at) AS last FROM harness_shared.gym_proposals
         WHERE workspace_id = ${ws} GROUP BY harness_slug`),
  },
  'red-queen': {
    loopPot: namedLoop('red-queen'),
    routine: { name: 'bp-singleton-red-queen-0', perPot: false },
    silenceHours: 72,
    output: 'a red_queen_drills row',
    // Drills are planted in the red-queen SANDBOX workspace, not the governing one,
    // so this read is deliberately not workspace-filtered.
    readLastOutput: async (sql) =>
      singleMax(await sql<Array<{ last: unknown }>>`SELECT max(created_at) AS last FROM harness_shared.red_queen_drills`),
  },
  regret: {
    loopPot: namedLoop('regret-mining'),
    routine: { name: 'bp-singleton-regret-0', perPot: false },
    silenceHours: 14 * 24,
    output: 'a regret_findings row (mined_at)',
    readLastOutput: async (sql, ws) =>
      singleMax(await sql<Array<{ last: unknown }>>`
        SELECT max(mined_at) AS last FROM harness_shared.regret_findings WHERE workspace_id = ${ws}`),
  },
  calibration: {
    loopPot: namedLoop('calibration-markets'),
    routine: { name: 'bp-singleton-calibration-0', perPot: false },
    silenceHours: 7 * 24,
    output: 'a calibration prediction created or resolved by the maturity sweep',
    readLastOutput: async (sql, ws) =>
      singleMax(await sql<Array<{ last: unknown }>>`
        SELECT greatest(max(created_at), max(resolved_at)) AS last
          FROM harness_shared.calibration_predictions WHERE workspace_id = ${ws}`),
    readIntentionalSilence: async (sql, ws, nowMs) => {
      const nowIso = new Date(nowMs).toISOString();
      const rows = await sql<Array<{ has_due: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.calibration_predictions
           WHERE workspace_id = ${ws} AND resolved_at IS NULL AND horizon_ts <= ${nowIso}::timestamptz
        ) AS has_due`;
      return rows[0]?.has_due === false
        ? new Map([[ANY_POT, 'no matured unresolved calibration predictions are due']])
        : new Map();
    },
  },
  transfer: {
    loopPot: namedLoop('frontier:transfer-harness'),
    routine: { name: 'bp-singleton-transfer-0', perPot: false },
    silenceHours: 14 * 24,
    output: 'a transfer_lessons row',
    readLastOutput: async (sql, ws) =>
      singleMax(await sql<Array<{ last: unknown }>>`
        SELECT max(created_at) AS last FROM harness_shared.transfer_lessons WHERE workspace_id = ${ws}`),
  },
};

export interface ProducerSilenceOptions {
  /** Per-producer threshold overrides, hours. */
  producerSilenceHours?: Partial<Record<LearningProducer, number>>;
}

/** Everything the verdict is computed from — read once per tick by {@link readProducerSilenceFacts}. */
export interface ProducerSilenceFacts {
  nowMs: number;
  loops: ReadonlyArray<Pick<LearningLoopRegistration, 'loopId' | 'potSlug' | 'enabled'>>;
  potScopes: ReadonlyArray<Pick<PotLearningScope, 'potSlug' | 'enabled' | 'pauseReason' | 'ownerDirected' | 'reviewBy'>>;
  routines: ReadonlyArray<{ name: string; installSlug: string; active: boolean }>;
  /** Last-output epoch ms keyed `${producer}:${pot}` (or `${producer}:*`). Absent = never produced. */
  lastOutputMs: ReadonlyMap<string, number>;
  /** Producer-side conditions that make no output expected, including explicit gates or no due work. */
  intentionalSilence?: ReadonlyMap<string, string>;
  /** Producer-specific off-switches keyed `${producer}:${pot}` → why it is off. */
  switchedOff?: ReadonlyMap<string, string>;
  /** Likely-cause hints keyed `${producer}:${pot}`, folded into a silence signal's body. */
  hints?: ReadonlyMap<string, string>;
  /** Producers whose output read failed this tick — never judged silent. */
  unmeasured?: ReadonlySet<LearningProducer>;
  /**
   * su-ideate scheduler circuits (plan D-010). `'unmeasured'` = the read failed (never
   * judged quiet); absent = not read (callers that predate D-010).
   */
  suIdeateCircuits?: { harnessesChecked: number; open: ReadonlyArray<SuIdeateOpenCircuit> } | 'unmeasured';
}

export type ProducerCheckDisposition =
  | 'producing'
  | 'intentionally-gated'
  | 'silent'
  | 'pot-paused'
  | 'routine-inactive'
  | 'switched-off'
  | 'unmeasured';

export interface ProducerSilenceVerdict {
  signals: WatchdogSignal[];
  /** One row per (producer, pot) the census matched, with how it was judged. */
  checked: Array<{ producer: LearningProducer; pot: string; loopId: string; disposition: ProducerCheckDisposition }>;
  /** Enabled governor loops no probe claims — reported, never silently passed. */
  unprobedLoops: string[];
  /** su-ideate circuit coverage (plan D-010); absent when the facts carried none. */
  suIdeate?: { harnessesChecked: number; openCircuits: string[] } | 'unmeasured';
}

function fmtAge(ms: number): string {
  const h = ms / HOUR_MS;
  return h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

/**
 * Pure verdict. Order per enabled loop: pot switch → routine switch → producer
 * switch → output age. The first switch found off decides; only a fully-active
 * producer can be judged silent.
 */
export function producerSilenceVerdict(facts: ProducerSilenceFacts, opts: ProducerSilenceOptions = {}): ProducerSilenceVerdict {
  const signals: WatchdogSignal[] = [];
  const checked: ProducerSilenceVerdict['checked'] = [];
  const unprobedLoops: string[] = [];
  const scopeByPot = new Map(facts.potScopes.map((s) => [s.potSlug, s]));
  const potsSignalled = new Set<string>();

  const potSwitch = (pot: string, loopId: string): boolean => {
    const scope = pot === ANY_POT ? undefined : scopeByPot.get(pot);
    if (!scope || scope.enabled !== false) return false;
    if (!potsSignalled.has(pot)) {
      potsSignalled.add(pot);
      if (!isDeliberatePause(scope)) {
        signals.push({
          source: 'producer-silence',
          key: `producer-silence:pot-switch:${pot}`,
          title: `Learning is switched off on pot ${pot} with no recorded reason`,
          body:
            `Watchdog signal (producer-silence): pot "${pot}" has its learning switch OFF (learning_pot_scope.enabled=false) ` +
            `with no pause_reason and not owner-directed, yet enabled learning loops still target it (first: ${loopId}). ` +
            `Every learning producer for this pot is silenced and nothing records whether that was meant. Either record ` +
            `why with learning:set-pot-scope { reason } (cite the directive) or switch the pot back on.`,
          severity: 'minor',
          kind: 'change',
          scope: `harness:${pot}`,
          findingClass: 'learning-slo:producer-silence',
        });
      } else if (pauseReviewOverdue(scope, facts.nowMs)) {
        signals.push({
          source: 'producer-silence',
          key: `producer-silence:pot-review:${pot}`,
          title: `Learning pause on pot ${pot} is past its review date`,
          body:
            `Watchdog signal (producer-silence): pot "${pot}" is deliberately paused (${scope.pauseReason ?? 'owner-directed'}) ` +
            `but its review date ${new Date(scope.reviewBy ?? 0).toISOString()} has passed. Re-examine the pause: ` +
            `extend reviewBy, or switch the pot back on.`,
          severity: 'minor',
          kind: 'change',
          scope: `harness:${pot}`,
          findingClass: 'learning-slo:producer-silence',
        });
      }
    }
    return true;
  };

  for (const loop of facts.loops) {
    if (!loop.enabled) continue;
    let matched = false;
    for (const producer of LEARNING_PRODUCERS) {
      const probe = PRODUCER_SILENCE_PROBES[producer];
      const pot = probe.loopPot(loop.loopId, loop.potSlug);
      if (pot === null) continue;
      matched = true;
      const key = `${producer}:${pot}`;
      const record = (disposition: ProducerCheckDisposition) => checked.push({ producer, pot, loopId: loop.loopId, disposition });

      if (potSwitch(pot, loop.loopId)) { record('pot-paused'); continue; }
      const routineRows = facts.routines.filter(
        (r) => r.name === probe.routine.name && (!probe.routine.perPot || r.installSlug === pot),
      );
      if (routineRows.length > 0 && !routineRows.some((r) => r.active)) { record('routine-inactive'); continue; }
      if (facts.switchedOff?.has(key)) { record('switched-off'); continue; }
      if (facts.unmeasured?.has(producer)) { record('unmeasured'); continue; }

      const hours = opts.producerSilenceHours?.[producer] ?? probe.silenceHours;
      const last = facts.lastOutputMs.get(key) ?? facts.lastOutputMs.get(`${producer}:${ANY_POT}`) ?? null;
      if (last !== null && facts.nowMs - last <= hours * HOUR_MS) { record('producing'); continue; }
      if (facts.intentionalSilence?.has(key) || facts.intentionalSilence?.has(producer + ':' + ANY_POT)) {
        record('intentionally-gated');
        continue;
      }

      record('silent');
      const since = last === null ? 'has never produced' : `last produced ${fmtAge(facts.nowMs - last)} ago (${new Date(last).toISOString()})`;
      const routineState = routineRows.length === 0
        ? `no '${probe.routine.name}' routine row exists, so nothing visibly drives it`
        : `its '${probe.routine.name}' routine is active`;
      const hint = facts.hints?.get(key);
      signals.push({
        source: 'producer-silence',
        key: `producer-silence:${producer}:${pot}`,
        title: `Learning producer ${producer} has gone silent on pot ${pot}`,
        body:
          `Watchdog signal (producer-silence): learning producer "${producer}" is switched on for pot "${pot}" ` +
          `(governor loop ${loop.loopId} enabled, pot learning on; ${routineState}) but ${since} — ` +
          `past its ${hours}h silence threshold. Output = ${probe.output}. ` +
          (hint ? `Likely cause: ${hint}. ` : '') +
          `An enabled producer must produce or be switched off on purpose; find why its runs yield nothing.`,
        severity: 'major',
        kind: 'bug',
        scope: pot === ANY_POT ? undefined : `harness:${pot}`,
        findingClass: 'learning-slo:producer-silence',
      });
    }
    if (!matched) {
      unprobedLoops.push(loop.loopId);
      if (loop.potSlug) potSwitch(loop.potSlug, loop.loopId);
    }
  }

  // su-ideate dead passes (plan D-010). The reader already dropped harnesses whose pot
  // learning switch is off and circuits whose last attempt may still record.
  let suIdeate: ProducerSilenceVerdict['suIdeate'];
  const circuits = facts.suIdeateCircuits;
  if (circuits === 'unmeasured') suIdeate = 'unmeasured';
  else if (circuits) {
    suIdeate = { harnessesChecked: circuits.harnessesChecked, openCircuits: circuits.open.map((c) => c.harnessSlug) };
    for (const c of circuits.open) {
      const since = c.lastPassMs === null
        ? 'it has never recorded a pass'
        : `its last recorded pass was ${fmtAge(facts.nowMs - c.lastPassMs)} ago (${new Date(c.lastPassMs).toISOString()})`;
      signals.push({
        source: 'producer-silence',
        key: `producer-silence:su-ideate-circuit:${c.harnessSlug}`,
        title: `su-ideate passes for harness ${c.harnessSlug} keep dying without recording (circuit open)`,
        body:
          `Watchdog signal (producer-silence): the su-ideate scheduler launched ${c.attempts} pass(es) for harness ` +
          `"${c.harnessSlug}" since its last pass and none recorded one; ${since}, newest launch ` +
          `${new Date(c.lastLaunchMs).toISOString()}. The circuit is open, so the scheduler launches nothing more for ` +
          `this harness until a pass records (plan D-006 §4) — its ideation has stopped. Read the dead launches ` +
          `(processes:list { launchedBy:'system:su-ideate-schedule', includeEnded:true }, label su-ideate-pass:${c.harnessSlug}:…) ` +
          `and fix why a pass dies before blender:ideate-pass-record.`,
        severity: 'major',
        kind: 'bug',
        scope: `harness:${c.harnessSlug}`,
        findingClass: 'learning-slo:producer-silence',
      });
    }
  }
  return { signals, checked, unprobedLoops, ...(suIdeate === undefined ? {} : { suIdeate }) };
}

/** Read every fact for one workspace. Each producer's output read fails independently to `unmeasured`. */
export async function readProducerSilenceFacts(sql: Sql, workspaceId: string, nowMs = Date.now()): Promise<ProducerSilenceFacts> {
  const [{ listLearningLoops }, { listPotLearningScope }] = await Promise.all([
    import('../../learning-governor/store'),
    import('../../learning/pot-gate/store'),
  ]);
  const routineNames = LEARNING_PRODUCERS.map((p) => PRODUCER_SILENCE_PROBES[p].routine.name);
  const [loops, potScopes, routineRows, gymRows] = await Promise.all([
    listLearningLoops(sql, { workspaceId }),
    listPotLearningScope(sql, { workspaceId }),
    sql<Array<{ name: string; install_slug: string; active: boolean | null }>>`
      SELECT name, install_slug, active FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND name = ANY(${routineNames}::text[])`,
    sql<Array<{ harness_slug: string; enabled: boolean | null; budget_usd: number | string | null }>>`
      SELECT harness_slug, enabled, budget_usd FROM harness_shared.gym_autoloop_config WHERE workspace_id = ${workspaceId}`,
  ]);

  const lastOutputMs = new Map<string, number>();
  const intentionalSilence = new Map<string, string>();
  const unmeasured = new Set<LearningProducer>();
  await Promise.all(
    LEARNING_PRODUCERS.map(async (producer) => {
      try {
        const byPot = await PRODUCER_SILENCE_PROBES[producer].readLastOutput(sql, workspaceId);
        for (const [pot, ms] of byPot) lastOutputMs.set(`${producer}:${pot}`, ms);
      } catch (err) {
        unmeasured.add(producer);
        console.warn(`[producer-silence] ${producer} output read failed — reported unmeasured:`, err instanceof Error ? err.message : err);
      }
    }),
  );

  await Promise.all(
    LEARNING_PRODUCERS.map(async (producer) => {
      const readIntentionalSilence = PRODUCER_SILENCE_PROBES[producer].readIntentionalSilence;
      if (!readIntentionalSilence) return;
      try {
        const byPot = await readIntentionalSilence(sql, workspaceId, nowMs);
        for (const [pot, reason] of byPot) intentionalSilence.set(`${producer}:${pot}`, reason);
      } catch (err) {
        // A missing optional explanation must not suppress a real silence signal.
        console.warn(`[producer-silence] ${producer} intentional-silence read failed — normal output check retained:`, err instanceof Error ? err.message : err);
      }
    }),
  );

  let suIdeateCircuits: ProducerSilenceFacts['suIdeateCircuits'];
  try {
    const { readSuIdeateOpenCircuits } = await import('../../scout/su-ideate-schedule');
    suIdeateCircuits = await readSuIdeateOpenCircuits(workspaceId, nowMs);
  } catch (err) {
    suIdeateCircuits = 'unmeasured';
    console.warn('[producer-silence] su-ideate circuit read failed — reported unmeasured:', err instanceof Error ? err.message : err);
  }

  const switchedOff = new Map<string, string>();
  const hints = new Map<string, string>();
  for (const g of gymRows) {
    if (g.enabled !== true) switchedOff.set(`gym:${g.harness_slug}`, 'gym_autoloop_config.enabled is false');
    else if (g.budget_usd == null) {
      hints.set(`gym:${g.harness_slug}`, 'gym_autoloop_config.budget_usd is NULL, so isEligibleAutoloop() rejects every fire (WI-10007379)');
    }
  }

  return {
    nowMs,
    loops,
    potScopes,
    routines: routineRows.map((r) => ({ name: r.name, installSlug: r.install_slug, active: r.active === true })),
    lastOutputMs,
    intentionalSilence,
    switchedOff,
    hints,
    unmeasured,
    suIdeateCircuits,
  };
}

/** Tick note: the coverage a quiet tick rests on, so "no signals" is never read as "nothing checked". */
export function producerSilenceNote(v: ProducerSilenceVerdict): string {
  const counts = new Map<string, number>();
  for (const c of v.checked) counts.set(c.disposition, (counts.get(c.disposition) ?? 0) + 1);
  const parts = [...counts].map(([d, n]) => `${d}=${n}`);
  const base = `checked ${v.checked.length} producer×pot (${parts.join(', ') || 'none'}); unprobed loops ${v.unprobedLoops.length}`;
  if (v.suIdeate === undefined) return base;
  if (v.suIdeate === 'unmeasured') return `${base}; su-ideate circuits unmeasured`;
  return `${base}; su-ideate circuits open ${v.suIdeate.openCircuits.length} of ${v.suIdeate.harnessesChecked} launched harness(es)`;
}
