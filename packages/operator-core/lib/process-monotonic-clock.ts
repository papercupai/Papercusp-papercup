import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

type ProcessMonotonicClock = Readonly<{ id: string; now: () => number }>;

// ESM and CommonJS loaders can evaluate this source as separate module
// instances in one process. Keep their identity in the process global so a
// receipt created by one loader is accepted by the other. Symbol.for is
// process-local: a subprocess/restart still gets a distinct clock domain.
const CLOCK_GLOBAL_KEY = Symbol.for('papercusp.process-monotonic-clock');
const globalClockStore = globalThis as typeof globalThis & Record<symbol, ProcessMonotonicClock | undefined>;

/** One immutable observation clock per Node runtime global. Module copies
 * in that runtime share the exact sampler and identity. A subprocess,
 * restart, or isolated runtime gets another id: those observations must
 * not be subtracted without a separately verified cross-clock mapping.
 * This identity conveys no request, account, billing or admission authority.
 */
export const processMonotonicClock = globalClockStore[CLOCK_GLOBAL_KEY] ??
  (globalClockStore[CLOCK_GLOBAL_KEY] = Object.freeze({
    id: `process-monotonic:${randomUUID()}`,
    now: performance.now.bind(performance),
  }));
