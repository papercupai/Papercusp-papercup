/**
 * routine-starvation signal mapper (WI-6554700010029793). The SQL predicate that selects a
 * starved routine is pinned against real Postgres in routine-starvation.integration.test.ts;
 * this file pins the pure row → signal mapping that the watchdog files and auto-closes on.
 */
import { describe, expect, it } from 'vitest';
import { routineStarvationSignalsFromRows, type RoutineStarvationRow } from './watchdog';
import { AUTO_CLOSE_ELIGIBLE_SOURCES } from './auto-close-sources';
import { INFRA_SIGNAL_SOURCES } from './policy';
import { METRIC_SOURCES } from './signal-lane';

function row(over: Partial<RoutineStarvationRow> = {}): RoutineStarvationRow {
  return {
    install_slug: 'papercusp-pr-drill-20261014',
    name: 'green-checkpoint',
    target_role: 'system:green-checkpoint',
    overdue_secs: 100 * 60,
    interval_sec: null,
    shed_since_due: 0,
    ...over,
  };
}

describe('routineStarvationSignalsFromRows', () => {
  it('emits one signal per starved routine, keyed and scoped by its install', () => {
    const [sig] = routineStarvationSignalsFromRows([row()]);
    expect(sig.source).toBe('routine-starvation');
    expect(sig.key).toBe('routine-starvation:papercusp-pr-drill-20261014:green-checkpoint');
    expect(sig.scope).toBe('harness:papercusp-pr-drill-20261014');
    expect(sig.severity).toBe('major');
    expect(sig.kind).toBe('bug');
    expect(sig.title).toContain('~100min overdue');
  });

  it('keeps two routines with the same name in different installs on separate keys', () => {
    const sigs = routineStarvationSignalsFromRows([row(), row({ install_slug: 'papercusp' })]);
    expect(new Set(sigs.map((s) => s.key)).size).toBe(2);
  });

  it('names the pool-shed floor as first suspect only when shed events were recorded', () => {
    const [shed] = routineStarvationSignalsFromRows([row({ shed_since_due: 17 })]);
    expect(shed.body).toContain('recorded 17 shed routine fire(s)');
    const [quiet] = routineStarvationSignalsFromRows([row({ shed_since_due: 0 })]);
    expect(quiet.body).toContain('No pool-shed events');
    expect(quiet.body).not.toContain('first suspect');
  });

  it('describes the cadence for loop and cron routines', () => {
    const [loop] = routineStarvationSignalsFromRows([row({ interval_sec: 600 })]);
    expect(loop.body).toContain('loop interval 600s');
    const [cron] = routineStarvationSignalsFromRows([row({ interval_sec: null })]);
    expect(cron.body).toContain('cron/interval trigger');
  });

  it('returns nothing for no rows', () => {
    expect(routineStarvationSignalsFromRows([])).toEqual([]);
  });
});

describe('routine-starvation source classification', () => {
  it('is an infra metric source that auto-closes on sustained absence', () => {
    expect(METRIC_SOURCES).toContain('routine-starvation');
    expect(INFRA_SIGNAL_SOURCES).toContain('routine-starvation');
    expect(AUTO_CLOSE_ELIGIBLE_SOURCES.has('routine-starvation')).toBe(true);
  });
});
