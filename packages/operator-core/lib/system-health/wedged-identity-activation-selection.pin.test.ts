/**
 * WI-10002060 — pins the wedged-identity sweep's launch-record selection to the
 * KERNEL's.
 *
 * WHY A PIN AND NOT A SHARED CONSTANT. `adv_sessions` fans out: one owner can
 * hold several rows, and the measured wedge had TWO open ones — an earlier row
 * whose launch_spec reconciled, and a later row carrying no specificationRevision
 * at all. Which row you read decides the answer, so the sweep is only meaningful
 * if it reads the row the GATE reads. Sharing one constant would mean threading
 * it through postgres.js tagged SQL with `sql.unsafe` inside the identity hot
 * path; this test buys the same anti-drift guarantee without touching that path.
 *
 * If this fails, do not "fix" it by editing the expected string — the two
 * queries have genuinely diverged, and the sweep is now answering about a
 * different row than the kernel authorises against.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LAUNCH_RECORD_SELECTION_ORDER } from './wedged-identity-activation-watchdog';

/**
 * Overridable so falsifiability can be proven against a COPY, never by mutating
 * the shared tree (scripts/mutation-probe.sh tier 2). git-sync sweeps the whole
 * working tree on a cadence, so an in-tree mutation can be committed even when
 * nothing goes wrong and no handler fails — this one line is what makes the
 * safe tier available at all.
 */
const KERNEL_SOURCE = process.env.WEDGED_IDENTITY_PIN_SUBJECT
  ? new URL(`file://${process.env.WEDGED_IDENTITY_PIN_SUBJECT}`)
  : new URL('../projected-tool-deps.ts', import.meta.url);

/** The ORDER BY of the adv_sessions subquery inside the kernel's state read. */
function kernelSelectionOrder(source: string): string | null {
  const advSessions = source.indexOf('harness_shared.adv_sessions s');
  if (advSessions === -1) return null;
  const orderBy = source.indexOf('ORDER BY', advSessions);
  if (orderBy === -1) return null;
  const limit = source.indexOf('LIMIT', orderBy);
  if (limit === -1) return null;
  return source.slice(orderBy + 'ORDER BY'.length, limit).replace(/\s+/g, ' ').trim();
}

describe('wedged-identity sweep selects the kernel’s launch record', () => {
  const source = readFileSync(KERNEL_SOURCE, 'utf8');

  // POSITIVE CONTROL. A regex that silently matched nothing would make the
  // comparison below vacuous, and an empty-vs-empty pass reads exactly like a
  // real one. Prove the extractor found the real clause first.
  it('extracts a real ORDER BY from the kernel source', () => {
    const order = kernelSelectionOrder(source);
    expect(order).toBeTruthy();
    expect(order).toBe('s.id DESC');
  });

  it('uses byte-identical ordering to projected-tool-deps', () => {
    expect(kernelSelectionOrder(source)).toBe(LAUNCH_RECORD_SELECTION_ORDER);
  });
});

/**
 * EI-23703586803892464 — the SECOND reader of the same row. Every writer of
 * `activation.applied` in control-anchor.ts vets against readGateSelectedLaunchSpec;
 * if its selection drifted, a writer would again vet one row while the gate judges
 * another — the exact sibling-record wedge it exists to prevent. Overridable like
 * the kernel subject, for the same copy-out reason.
 */
const ACK_SOURCE = process.env.WEDGED_IDENTITY_ACK_PIN_SUBJECT
  ? new URL(`file://${process.env.WEDGED_IDENTITY_ACK_PIN_SUBJECT}`)
  : new URL('../agent-tools/coordination/control-anchor.ts', import.meta.url);

describe('the applied-writers’ launch-record read selects the kernel’s row', () => {
  const full = readFileSync(ACK_SOURCE, 'utf8');
  const start = full.indexOf('async function readGateSelectedLaunchSpec');
  const ack = start === -1 ? '' : full.slice(start);

  it('extracts a real ORDER BY from readGateSelectedLaunchSpec', () => {
    const order = kernelSelectionOrder(ack);
    expect(order).toBeTruthy();
    expect(order).toBe('s.id DESC');
  });

  it('uses byte-identical ordering to the kernel', () => {
    expect(kernelSelectionOrder(ack)).toBe(LAUNCH_RECORD_SELECTION_ORDER);
  });
});
