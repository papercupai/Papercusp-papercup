import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pinModuleState } from '@papercusp/module-singleton';

type ProcessMonotonicClock = Readonly<{ id: string; now: () => number }>;

// ESM and CommonJS loaders can evaluate this source as separate module
// instances in one process. pinModuleState keeps their identity in the
// process realm so a receipt created by one loader is accepted by the other
// (and reports a re-split through listModuleDuplications()). The realm is
// process-local: a subprocess/restart still gets a distinct clock domain.

/** One immutable observation clock per Node runtime global. Module copies
 * in that runtime share the exact sampler and identity. A subprocess,
 * restart, or isolated runtime gets another id: those observations must
 * not be subtracted without a separately verified cross-clock mapping.
 * This identity conveys no request, account, billing or admission authority.
 */
export const processMonotonicClock: ProcessMonotonicClock = pinModuleState(
  'papercusp.process-monotonic-clock',
  () => Object.freeze({
    id: `process-monotonic:${randomUUID()}`,
    now: performance.now.bind(performance),
  }),
);
