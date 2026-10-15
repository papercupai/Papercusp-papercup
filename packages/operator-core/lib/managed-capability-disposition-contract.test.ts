import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MANAGED_CAPABILITY_CONTRACT_VERSION,
  MANAGED_CAPABILITY_CUTOVER_READY,
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  managedCapabilityContractViolations,
  managedCapabilityDisposition,
} from '@papercusp/orchestrator';
import {
  MANAGED_CAPABILITY_CUTOVER_READY as SUBPATH_CUTOVER_READY,
  MANAGED_CAPABILITY_DISPOSITIONS as SUBPATH_DISPOSITIONS,
} from '@papercusp/orchestrator/managed-capability-contract';

const ROOT = resolve(import.meta.dirname, '../../..');

const EXACT_R1_FAMILIES = [
  'shell-ssh-interpreters',
  'jobs-output-stop-pty',
  'script-orchestration-kernels',
  'reads-list-search-lsp',
  'edit-write-patch-notebook',
  'http-search-browser-computer',
  'delegation',
  'schedules-monitors-wakes',
  'tasks-plans-goals',
  'memory-checkpoint-resume-rewind',
  'questions-approvals',
  'images-artifacts-skills-discovery',
  'pure-tui-presentation',
] as const;

const ALLOWED_DISPOSITIONS = new Set([
  'managed-execution',
  'managed-backed-native-interface',
  'deliberately-retained-interface',
  'unsupported-gap',
]);

describe('managed capability disposition contract (P-001 / R-1)', () => {
  it('publishes the same versioned contract from the package barrel and explicit subpath', () => {
    expect(MANAGED_CAPABILITY_CONTRACT_VERSION).toBe(1);
    expect(SUBPATH_DISPOSITIONS).toBe(MANAGED_CAPABILITY_DISPOSITIONS);
    expect(SUBPATH_CUTOVER_READY).toBe(MANAGED_CAPABILITY_CUTOVER_READY);
  });

  it('contains exactly the thirteen R-1 families once, each with exactly one allowed disposition', () => {
    expect(MANAGED_CAPABILITY_FAMILY_IDS).toEqual(EXACT_R1_FAMILIES);
    expect(MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => entry.family)).toEqual(EXACT_R1_FAMILIES);
    expect(new Set(MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => entry.family)).size).toBe(EXACT_R1_FAMILIES.length);

    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(typeof entry.disposition).toBe('string');
      expect(ALLOWED_DISPOSITIONS.has(entry.disposition)).toBe(true);
      expect(managedCapabilityDisposition(entry.family)).toBe(entry);
    }
  });

  it('keeps every family and the root gate unready while recording precise, owned gaps', () => {
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);

    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(entry.cutoverReady, entry.family).toBe(false);
      expect(entry.cutoverReason.length, entry.family).toBeGreaterThan(20);
      expect(entry.boundary.length, entry.family).toBeGreaterThan(40);
      expect(entry.managedAuthorities.length, entry.family).toBeGreaterThan(0);
      expect(entry.gaps.length, entry.family).toBeGreaterThan(0);

      for (const gap of entry.gaps) {
        expect(gap.id, entry.family).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)+$/);
        expect(gap.description.length, gap.id).toBeGreaterThan(30);
        expect(gap.falsifier.length, gap.id).toBeGreaterThan(30);
        expect(gap.owningPlanItems.length, gap.id).toBeGreaterThan(0);
        expect(gap.owningPlanItems, gap.id).not.toContain('P-001');
        for (const item of gap.owningPlanItems) expect(item).toMatch(/^P-(?:015|016|017|018|019|020)$/);
      }
    }
  });

  it('has executable red controls for missing, duplicate, uncited, and prematurely enabled entries', () => {
    expect(managedCapabilityContractViolations(MANAGED_CAPABILITY_DISPOSITIONS)).toEqual([]);

    expect(managedCapabilityContractViolations(MANAGED_CAPABILITY_DISPOSITIONS.slice(1))).toContain(
      'missing-family:shell-ssh-interpreters',
    );
    expect(
      managedCapabilityContractViolations([MANAGED_CAPABILITY_DISPOSITIONS[0], ...MANAGED_CAPABILITY_DISPOSITIONS]),
    ).toContain('duplicate-family:shell-ssh-interpreters');
    expect(
      managedCapabilityContractViolations([
        { ...MANAGED_CAPABILITY_DISPOSITIONS[0], evidence: { path: '', anchors: [] } },
        ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
      ]),
    ).toContain('missing-evidence:shell-ssh-interpreters');
    expect(
      managedCapabilityContractViolations([
        { ...MANAGED_CAPABILITY_DISPOSITIONS[0], cutoverReady: true },
        ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
      ]),
    ).toContain('cutover-with-open-gaps:shell-ssh-interpreters');
  });

  it('allows an explicitly closed replacement gap ledger without changing shipped readiness', () => {
    const provenShell = { ...MANAGED_CAPABILITY_DISPOSITIONS[0], gaps: [], cutoverReady: true };
    expect(managedCapabilityContractViolations([
      provenShell,
      ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
    ])).toEqual([]);

    // A completed candidate must not mutate the published contract or activate rollout.
    expect(managedCapabilityDisposition('shell-ssh-interpreters').cutoverReady).toBe(false);
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);

    expect(managedCapabilityContractViolations([
      { ...provenShell, cutoverReady: false },
      ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
    ])).toContain('missing-gap:shell-ssh-interpreters');
    expect(managedCapabilityContractViolations([
      { ...provenShell, cutoverReady: undefined },
      ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
    ])).toContain('invalid-cutover-readiness:shell-ssh-interpreters');
  });

  it('rejects a cutover claim for an unsupported or intentionally retained interface', () => {
    for (const disposition of ['unsupported-gap', 'deliberately-retained-interface'] as const) {
      expect(managedCapabilityContractViolations([
        { ...MANAGED_CAPABILITY_DISPOSITIONS[0], disposition, gaps: [], cutoverReady: true },
        ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
      ])).toContain('non-replacement-cutover:shell-ssh-interpreters');
    }
  });

  it('gives every family one primary evidence citation and verifies every cited source anchor', () => {
    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(entry.evidence.path, entry.family).toBeTruthy();
      expect(entry.evidence.anchors.length, entry.family).toBeGreaterThan(0);
      expect(entry.reuseSites.length, entry.family).toBeGreaterThan(0);

      for (const citation of [entry.evidence, ...entry.reuseSites]) {
        const source = readFileSync(resolve(ROOT, citation.path), 'utf8');
        for (const anchor of citation.anchors) {
          expect(source, `${entry.family}: ${citation.path} must contain ${JSON.stringify(anchor)}`).toContain(anchor);
        }
        for (const absent of 'absentAnchors' in citation ? (citation.absentAnchors ?? []) : []) {
          expect(source, `${entry.family}: ${citation.path} must not contain ${JSON.stringify(absent)}`).not.toContain(
            absent,
          );
        }
      }
    }
  });

  it('records P-002 start-once response yield as implemented without opening the cutover gate', () => {
    const shell = managedCapabilityDisposition('shell-ssh-interpreters');
    const jobs = managedCapabilityDisposition('jobs-output-stop-pty');
    const remainingGapIds = [...shell.gaps, ...jobs.gaps].map((gap) => gap.id);

    expect(remainingGapIds).not.toContain('shell-start-once-response-yield');
    expect(remainingGapIds).not.toContain('job-response-deadline-continuity');
    expect(shell.reuseSites.flatMap((site) => site.anchors)).toContain('waitForJobResponse');
    expect(jobs.boundary).toContain('start-once response yield');
    expect(shell.cutoverReady).toBe(false);
    expect(jobs.cutoverReady).toBe(false);
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);
  });

  it('records the P-003 PTY/script lifecycle closure without claiming persistent-kernel or client cutover parity', () => {
    const jobs = managedCapabilityDisposition('jobs-output-stop-pty');
    const scripts = managedCapabilityDisposition('script-orchestration-kernels');

    expect(jobs.evidence.anchors).toContain("name: 'capability:pty_resize'");
    expect(jobs.boundary).toContain('emit task-terminal wakes');
    expect(jobs.gaps.map((gap) => gap.id)).not.toContain('pty-resize-completion-reattach');
    expect(jobs.gaps).toContainEqual(expect.objectContaining({
      id: 'pty-real-client-restart-acceptance',
      owningPlanItems: ['P-019', 'P-020', 'P-015'],
    }));

    expect(scripts.boundary).toContain('explicit replay state');
    expect(scripts.boundary).toContain('uncertain-write reporting');
    expect(scripts.boundary).toContain('JavaScript worker/VM open/run/status/close');
    expect(scripts.boundary).toContain('Cross-worker routing and current-client acceptance remain open');
    expect(scripts.gaps[0].description).not.toContain('not implemented');
    expect(scripts.gaps).toContainEqual(expect.objectContaining({
      id: 'persistent-kernel-lifecycle',
      owningPlanItems: ['P-017', 'P-020', 'P-015'],
    }));
    expect([...jobs.gaps, ...scripts.gaps].flatMap((gap) => gap.owningPlanItems)).not.toContain('P-003');
    expect(jobs.cutoverReady).toBe(false);
    expect(scripts.cutoverReady).toBe(false);
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);
  });

  it('records the P-006 patch/notebook adapter closure without claiming cross-client mutation parity', () => {
    const mutation = managedCapabilityDisposition('edit-write-patch-notebook');

    // The adapters are registered, so the family is managed execution rather than an unsupported gap.
    expect(mutation.disposition).toBe('managed-execution');
    expect(mutation.managedAuthorities).toContain('capability:patch');
    expect(mutation.managedAuthorities).toContain('capability:notebook_edit');

    // The closed gap is gone and P-006 owns nothing further in this family.
    expect(mutation.gaps.map((gap) => gap.id)).not.toContain('patch-notebook-adapters');
    expect(mutation.gaps.flatMap((gap) => gap.owningPlanItems)).not.toContain('P-006');

    // What remains is the narrower real-client acceptance gap, owned by the items that can prove it.
    expect(mutation.gaps).toContainEqual(
      expect.objectContaining({
        id: 'patch-notebook-real-client-acceptance',
        kind: 'evidence',
        owningPlanItems: ['P-019', 'P-020', 'P-015'],
      }),
    );

    // Registration is asserted positively now, so a silently unregistered adapter cannot pass.
    expect(mutation.evidence.anchors).toContain("import './capability/patch';");
    expect(mutation.evidence.anchors).toContain("import './capability/notebook';");

    // R-1: the boundary must still forbid passing an exact-string edit off as a patch.
    expect(mutation.boundary).toContain('renaming an exact-string edit');

    // Closing an adapter gap must not open the cutover gate.
    expect(mutation.cutoverReady).toBe(false);
    expect(mutation.cutoverReason).not.toContain('P-006');
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);
  });

  it('assigns remaining implementation and evidence gaps to current Phase 4 lanes', () => {
    const gap = (family: Parameters<typeof managedCapabilityDisposition>[0], id: string) =>
      managedCapabilityDisposition(family).gaps.find((candidate) => candidate.id === id);

    expect(gap('script-orchestration-kernels', 'persistent-kernel-lifecycle')?.owningPlanItems).toContain('P-017');
    expect(gap('http-search-browser-computer', 'browser-provider-contract')?.owningPlanItems).toContain('P-018');
    expect(gap('jobs-output-stop-pty', 'pty-real-client-restart-acceptance')?.owningPlanItems).toContain('P-019');
    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(entry.gaps.flatMap((candidate) => candidate.owningPlanItems)).toContain('P-015');
    }

    const exclusion = gap('memory-checkpoint-resume-rewind', 'offline-bounded-recovery');
    expect(exclusion?.description).toContain('DELIBERATELY EXCLUDED');
    expect(exclusion?.owningPlanItems).toEqual(['P-016']);
    expect(exclusion?.owningPlanItems).not.toContain('P-004');
    expect(managedCapabilityDisposition('memory-checkpoint-resume-rewind').cutoverReason)
      .toContain('without rebuilding it');
  });

  it('keeps R-7 HTTP fetch distinct from search and browser/DOM instead of equating them', () => {
    const network = managedCapabilityDisposition('http-search-browser-computer');

    // A local implementation does not dispose the current-client acceptance gap.
    expect(network.disposition).toBe('unsupported-gap');
    expect(network.evidence.path).toBe('packages/operator-core/lib/agent-tools/capability/fetch.ts');
    expect(network.evidence.anchors).toContain('browserSessionArg.optional()');
    expect(network.gaps).toContainEqual(expect.objectContaining({ id: 'browser-provider-contract' }));

    // R-7: fetch, search, and browser/computer must be named as separate surfaces.
    expect(network.boundary).toContain('capability:fetch');
    expect(network.boundary).toContain('remain distinct');
    expect(network.managedAuthorities).toContain('capability:fetch');

    // Browser operations reuse the fetch door but have their own explicit lifetime.
    expect(network.managedAuthorities).toContain('capability:fetch browser sessions');
    expect(network.boundary).toContain('worker routing, actual-ledger/API, confinement, and restart cleanup acceptance remain open');
    expect(network.reuseSites.find((site) => site.path.endsWith('browser-session.e2e.test.ts'))?.note).toContain('mocked ledger');
    const browserGap = network.gaps.find((gap) => gap.id === 'browser-provider-contract');
    expect(browserGap?.falsifier).toContain('without conflating it with raw HTTP or sandbox pixels');

    expect(network.cutoverReady).toBe(false);
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);
  });

  it('keeps the remaining four R-7 canonical-state distinctions explicit instead of collapsing them', () => {
    // R-7 names five distinctions. HTTP fetch vs search/browser is asserted above; these are the other four.

    // (1) Session tasks are not the shared ledger.
    const tasks = managedCapabilityDisposition('tasks-plans-goals');
    expect(tasks.boundary).toContain('session-local');
    expect(tasks.boundary).toContain('must not masquerade as the shared ledger');
    expect(tasks.managedAuthorities).toContain('tasks:ops');
    expect(tasks.managedAuthorities).toContain('work_items:*');
    // The session surface and the durable authorities are cited as DIFFERENT files — not one store under two names.
    const durableSites = tasks.reuseSites.map((site) => site.path);
    expect(durableSites).not.toContain(tasks.evidence.path);
    expect(durableSites.some((path) => /work_items\//.test(path))).toBe(true);
    expect(durableSites.some((path) => /plans\//.test(path))).toBe(true);

    // (2)+(3) Durable memory is not scratch context, and transcript resume is not filesystem rewind.
    const memory = managedCapabilityDisposition('memory-checkpoint-resume-rewind');
    // Native transcript UX is retained precisely because its operations run on managed authority (R-7).
    expect(memory.disposition).toBe('managed-backed-native-interface');
    expect(memory.boundary).toContain('transcript continuation is never filesystem rewind');
    expect(memory.boundary).toContain('shadow durable-memory store');
    expect(memory.managedAuthorities).toContain('work_items:checkpoint');
    // No false equivalence: retaining transcript resume must not register a filesystem-rewind authority.
    expect(memory.managedAuthorities.some((authority) => /rewind/i.test(authority))).toBe(false);

    // (4) A multi-file patch is not an exact-string edit wearing a different name.
    const mutation = managedCapabilityDisposition('edit-write-patch-notebook');
    expect(mutation.boundary).toContain('must not be hidden by renaming an exact-string edit');
    for (const authority of ['capability:edit', 'capability:patch', 'capability:notebook_edit']) {
      expect(mutation.managedAuthorities).toContain(authority);
    }
    expect(new Set(mutation.managedAuthorities).size).toBe(mutation.managedAuthorities.length);

    // None of these distinctions opens the cutover gate.
    for (const entry of [tasks, memory, mutation]) expect(entry.cutoverReady).toBe(false);
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);
  });
});
