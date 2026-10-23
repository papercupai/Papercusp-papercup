---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume194-independent-construction-and-reporter-custody-424d5.json"
updated_at: 1792695147292
_body: "content"
---

{
  "edition": "resume194",
  "parent": "WI-6554700010008887",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "head": "060876c3b008b6305d2122026b89fa4e5ee1e532",
  "source": {
    "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts": {
      "workingSHA256": "01ea996376f9bf274b581707d0ef12cc3aa7cee613c789b06121486da6eab9aa",
      "headSHA256": "38844429b62cac847f8d32691ae2220c158148666364abcd83c49c951a41fcef",
      "equalsHEAD": false
    },
    "packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts": {
      "workingSHA256": "41e40c2feba574a59680359e3e57eefde1086525f6d50850f55946edbba9b6e5",
      "headSHA256": "b2d2a0ba178e9448fcd18ae6537cae1d2f8fb89f89342bbad6b7e152a7edccaf",
      "equalsHEAD": false
    },
    "scripts/lib/test-progress-heartbeat-reporter.mjs": {
      "workingSHA256": "168a13449a262c58f1e27eb70410634fd1cb70a7fc768bf008418e6b4a503bcd",
      "headSHA256": "bf3e65ec9a5535c8ebb8cc9e77a9058c937c33f6059419654c0765719c84ef93",
      "equalsHEAD": false
    },
    "packages/operator-core/lib/__tests__/test-progress-heartbeat-reporter.test.ts": {
      "workingSHA256": "060784eeae6bf40f7c72550acb27e02a2a25925b71d13c7f14ff14dde0c96331",
      "headSHA256": "074946ea2a52d2752a9defa8870f1ec12cd724a0e73bc875d9eb972edf5e0364",
      "equalsHEAD": false
    }
  },
  "diff": "diff --git a/packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts b/packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts\nindex 7c56a35eb9..c63ba0e69e 100644\n--- a/packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts\n+++ b/packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts\n@@ -7,6 +7,7 @@ import {\n   type StalledLoopsSweepDeps,\n } from './stalled-loops-guard';\n import { turnsStalledFloorMs, type LoopStatus } from './loop';\n+import { evaluateSilentHalt } from './silent-halt-reconcile';\n import type { StalledLoopHostReading } from '../../events/await/host-recovery-eligibility';\n import { findLiveHostAsync, type PsuPtyHost } from '../../events/await/psu-pty-discovery';\n \n@@ -205,6 +206,37 @@ const wakeStarvedProbe = () =>\n   }));\n \n describe('sweepStalledLoops (WI-6639 — act on turnsStalled instead of leaving it inert)', () => {\n+  it('leaves a disarmed actionable AUTO session visible to silent-halt without creating an exempting await', async () => {\n+    for (const intervalSec of [60, 600]) {\n+      const ownerId = `su-disarm-fallback-${intervalSec}`;\n+      const loop = status({ ownerId, turnsStalled: true, intervalSec });\n+      const sql = fakeSql([{ id: 'rt-fallback', target_owner_id: ownerId }]);\n+      const autoPause = vi.fn<AutoPauseFn>(async () => { loop.active = false; });\n+      const armWake = vi.fn<ArmWakeFn>(async () => {});\n+      const result = await sweepStalledLoops({ sql, workspaceId: 'ws' }, {\n+        getStatuses: async () => new Map([[ownerId, loop]]),\n+        autoPause, armWake, probeReachability: reach(false),\n+        broadcast: vi.fn<BroadcastFn>(async () => true),\n+        notify: vi.fn<NotifyFn>(async () => {}),\n+      });\n+      expect(result.paused).toBe(1);\n+      expect(autoPause).toHaveBeenCalledExactlyOnceWith(sql, 'rt-fallback', expect.any(String));\n+      expect(loop.active).toBe(false);\n+      expect(armWake).not.toHaveBeenCalled();\n+\n+      const floor = Math.max(30 * MIN, 5 * intervalSec * 1000);\n+      const input = { loopActive: loop.active, hasPosture: true, pendingAwaits: 0,\n+        heartbeatAgeMs: 1000, lastRealTurnAgeMs: 120 * MIN,\n+        inactiveForMs: floor, intervalSec, heldWorkItems: 1 };\n+      expect(evaluateSilentHalt(input)).toMatchObject({ halted: false, staleFloorMs: floor });\n+      expect(evaluateSilentHalt({ ...input, inactiveForMs: floor + 1 }))\n+        .toMatchObject({ halted: true, staleFloorMs: floor });\n+      // A genuine external await remains a wake source after the same disarm.\n+      expect(evaluateSilentHalt({ ...input, inactiveForMs: floor + 1, pendingAwaits: 1 }))\n+        .toMatchObject({ halted: false, exemption: 'pending-await x1 (a live wake source)' });\n+    }\n+  });\n+\n   it('no active loop-% rows and nothing to revive → no status read, no auto-pause, no broadcast', async () => {\n     const sql = fakeSql([]);\n     const getStatuses = vi.fn();\ndiff --git a/packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts b/packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts\nindex 4fe682a18b..8609781dd8 100644\n--- a/packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts\n+++ b/packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts\n@@ -1524,6 +1524,58 @@ describe('fleet scope assignment admission (P-016)', () => {\n       expect(advice.indexOf('events:await')).toBeLessThan(advice.indexOf(stop));\n     });\n \n+    it('renders loop:end only for legitimate completion or stop when unfinished obligations are retained', () => {\n+      const { advice } = fleetScopedMiss(issueScope, [], {\n+        issueBreakdown: zeroMatchBreakdown,\n+        planTerminality: { planSlugs: ['finished'], terminalPlanSlugs: ['finished'], allTerminal: true },\n+      });\n+      // Finishing the shared plan does not establish that this caller's other obligations ended.\n+      const permission = advice.indexOf('Only after a guaranteed wake is registered');\n+      const stop = advice.indexOf('call loop:end');\n+      expect(permission).toBeGreaterThanOrEqual(0);\n+      expect(stop).toBeGreaterThan(permission);\n+      expect(advice.slice(permission, stop)).toContain('no unfinished obligations remain');\n+      expect(advice.slice(permission, stop)).toContain('a verified stop/handoff has disposed of them');\n+      expect(advice.slice(permission, stop)).toContain('release only finished lane resources');\n+      expect(advice.slice(permission, stop)).toContain('retained blocked claims stay held');\n+      expect(advice.indexOf('If work remains blocked')).toBeLessThan(permission);\n+    });\n+\n+    it('renders continue-independent-work guidance for a partially blocked agent', () => {\n+      const { advice } = fleetScopedMiss(issueScope, [], {\n+        issueBreakdown: zeroMatchBreakdown,\n+        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 1,\n+          inFlightMatchedByFilter: 1, parkedMatchedByFilter: 0 },\n+      });\n+      const independent = advice.indexOf('First finish independent work on held items');\n+      const reassess = advice.indexOf('After that work completes, reassess the remaining held obligations in this same turn');\n+      const blocked = advice.indexOf('If work remains blocked');\n+      expect(independent).toBeGreaterThanOrEqual(0);\n+      expect(reassess).toBeGreaterThan(independent);\n+      expect(blocked).toBeGreaterThan(reassess);\n+      expect(advice.indexOf('call loop:end')).toBeGreaterThan(blocked);\n+      expect(advice).toContain('a blocked item you still hold stays held');\n+      expect(advice).toContain('Keep the existing loop armed until registration succeeds');\n+    });\n+\n+    it('renders a bounded exact-event wake with timeout for a fully blocked agent', () => {\n+      const { advice } = fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown });\n+      const missing = advice.indexOf('If no independently actionable blocker event is recorded');\n+      const supplied = advice.indexOf('Otherwise copy the supplied dependency event key exactly');\n+      expect(missing).toBeGreaterThanOrEqual(0);\n+      expect(supplied).toBeGreaterThan(missing);\n+      expect(advice.slice(missing, supplied)).toContain('do not call work_items:set_blocker or events:await');\n+      expect(advice.slice(missing, supplied)).toContain('Never fabricate a blocker ref or derive an event key from an item id');\n+      const registration = advice.slice(supplied, advice.indexOf('Only after a guaranteed wake is registered'));\n+      expect(registration).toContain('record its typed blocker with work_items:set_blocker if not already recorded');\n+      expect(registration).toContain('events:await for the exact recorded blocker event');\n+      expect(registration).toContain('positive timeout_sec matched to its recheckAt and on_timeout:\"wake\"');\n+      expect(registration).toContain('register it before ending this turn');\n+      expect(registration).toContain('Keep the existing loop armed until registration succeeds');\n+      expect(registration).toContain('do not invent an event from blocked status or await a lifecycle transition that this session itself must perform');\n+      expect(registration).toContain('A standing work-item:claimable watch is backlog interest only');\n+    });\n+\n     it('EI-20260781488788952: reports a completed bound plan as a successful plan wind-down', () => {\n       const completedPlanScope = {\n         ...issueScope,\n",
  "parentCheckRows": [
    {
      "id": "p013-amendment-applied",
      "claim": "Approved P-013 amendment is applied as rubric revision 9 with 32 criteria; original14 exact and R20/R21 absent."
    },
    {
      "id": "p013-activation6-recorded",
      "claim": "Activation audit 6 records 29 mappings on plan revision 68 and preserves M-001..M-011/source ranges."
    },
    {
      "id": "p013-owner-report-verified",
      "claim": "Owner report is published and readable at the returned report path."
    },
    {
      "id": "fire148-r12-current-qualified",
      "claim": "Fresh selected R12 agents-wedged case reaches a qualified terminal pass after the retention-admission fix; three sibling e2e cases were filtered and remain unverified."
    },
    {
      "id": "fire88-new-source-proof-pending",
      "claim": "Fire88 new-source task is terminalexit1; no current passing R12 acceptance."
    },
    {
      "id": "fire91-r12-retention-timeout",
      "claim": "Selected R12 case failed waiting180s for shared disk-retention mutex; upstream cause unresolved and no current acceptance established."
    },
    {
      "id": "fire89-vetting-audit-dispatched",
      "claim": "Construction remains unaccepted: Fire98 has20 unregistered atomic candidate outcomes and20 draft mappings; current rubric8/meaning7 and original14outcomes unchanged."
    },
    {
      "id": "fire88-original-terminal-custody",
      "claim": "Original Fire83 task completed0 and ledger21271929 selected1PASS0FAIL3filtered; all3receipt hashes and privatecleanup independently verified. This is historical committedproof, not current-source acceptance."
    },
    {
      "id": "fire80-root961-ledger-sequence",
      "claim": "Original failure/retry and acquire/no-release ledger sequence verified."
    },
    {
      "id": "fire80-root961-cause-boundary",
      "claim": "Callback absence versus unrecorded release failure remains unresolved."
    }
  ],
  "parentBeforeHash": "ad8352ff1637",
  "priorArchive": {
    "path": "audits/parked-agent-resumption-2026-10-09/resume193-verification-harness-audit-424d5.json",
    "chars": 523702,
    "sha256": "82f17d1564baaf2f9050a6ff426890459eafdd569ef0c783252a7568f4765601"
  },
  "verification": {
    "newTests": "NOT RUN; neither pass nor assertion failure claimed",
    "syntax": "node --check on both changed TS test files exit0",
    "whitespace": "git diff --check on both changed files exit0",
    "guardedReporterLoad": {
      "exitCode": 0,
      "elapsedMs": 224,
      "diagnosticReadyHook": "undefined",
      "diagnosticTraceMethod": "undefined",
      "progressHook": "function"
    },
    "route": "operator-api catalog route ready; actual staging build identity unknown because3170unreachable; no host-readiness proof"
  },
  "blockedOn": [
    "installed coherent OTel graph + host compatibility evidence owned by4bdf/EI26699933083234136",
    "actual staging3170 loaded build identity",
    "ordinary commit custody for heartbeat reporter/test before meaningful diagnostics"
  ],
  "preservedWalls": [
    "all ten original parent checks unchanged",
    "root460/root464 alreadyfired; no rearm",
    "no loop/gate/release operations",
    "prior focused9693969d/30063f5e terminal; no repeat",
    "R14 allfix24h notstarted",
    "original116 eligibility/outcomes unresolved",
    "provider/root961/launcher rootcause walls remain"
  ],
  "next": "Verify committed heartbeat source and maintained reporter suite only after startup readiness. Then diagnose exact active case before costly population retry. Four new construction cases for R27/R32/R33/R34 require first maintained execution; R28 actual host-record publication still requires construction."
}
