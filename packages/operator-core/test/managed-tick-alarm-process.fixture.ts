/** Fresh-process control for P005: real shared alarm rail, no durable executor. */
import { configureScheduledRegistry, managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { installManagedTickAlarm } from '../lib/dbos/managed-tick-alarm';
import { reconcileManagedTickAlarms } from '../lib/dbos/managed-tick-alarm-recovery';

async function main(): Promise<void> {
  if (process.argv[2] === 'idle-watch') {
    const recovery = (await import('../lib/dbos/managed-tick-alarm-recovery')).startManagedTickAlarmRecovery();
    process.on('message', () => {});
    await recovery.ready;
    process.send?.({ kind: 'started', pid: process.pid });
    return;
  }
  if (process.argv[2] === 'restart') {
    // Exercise the real fireOnArm startup watcher, not a direct helper call.
    installManagedTickAlarm();
    process.on('message', () => {});
    process.send?.({ kind: 'started', pid: process.pid });
    return;
  }
  if (process.argv[2] === 'raise') {
    let now = 0;
    const callbacks: Array<() => void> = [];
    configureScheduledRegistry({ now: () => now,
      setIntervalImpl: callback => { callbacks.push(callback); return { unref() {} }; },
      clearIntervalImpl: () => {},
    });
    installManagedTickAlarm({ recentlyEscalated: async () => false,
      notify: async input => { process.send?.({ kind: 'raised', data: input.data, pid: process.pid }); },
    });
    managedSetInterval('fresh-process-held', Number(process.argv[3] ?? 60_000), () => new Promise<void>(() => {}), {
      category: 'global-sweep', allowInTest: true,
      activity: { kind: 'required-control', reason: 'P005 fresh-process control.' },
    });
    callbacks[1]!();
    now = 600_001;
    callbacks[2]!();
    // Keep the producing incarnation alive until the test terminates it.
    process.on('message', () => {});
    return;
  }
  const result = await reconcileManagedTickAlarms();
  await _resetForTests();
  process.send?.({ kind: 'reconciled', result }, () => process.exit(0));
}

void main().catch(async error => {
  // Never put a connection string in a retained fixture error.
  process.send?.({ kind: 'failed', name: error instanceof Error ? error.name : 'unknown' });
  await getOrgPg().sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
});
