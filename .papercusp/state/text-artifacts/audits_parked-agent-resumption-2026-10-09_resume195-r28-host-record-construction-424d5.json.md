---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume195-r28-host-record-construction-424d5.json"
updated_at: 1792695580387
_body: "content"
---

{
  "edition": "resume195",
  "parent": "WI-6554700010008887",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "wake": {
    "deliveryId": 943632,
    "msgId": "coord-send-4924050e4aa3057be645ea804b76f2463c85c15535abc16fe8306751f62e543f",
    "disposition": "cursor-free inbox returns same message; already answered by coord-send-ddece5aa9e48e9c3e3ea4e9d93f137e092939ccc93c28e372167fae3e9d2f3f3 in Resume194; no resend or new monitoring"
  },
  "source": {
    "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": {
      "workingSHA256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
      "headSHA256": "247aaaaf5f403b1224810a398e858b7974b590cb5c03f2e9a65c7074c41d26bb",
      "equalsHEAD": false
    },
    "apps/operator/scripts/psu-pty-host.mjs": {
      "workingSHA256": "eaea562f234c52b6fc11218769d0103846f09d81203c39453d710c88b0c82d25",
      "headSHA256": "eaea562f234c52b6fc11218769d0103846f09d81203c39453d710c88b0c82d25",
      "equalsHEAD": true
    }
  },
  "diff": "diff --git a/apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts b/apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\nindex 17cfe8680d..ebd760b141 100644\n--- a/apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\n+++ b/apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\n@@ -9,8 +9,15 @@\n  * These tests pin the parse of the stated reset and the expiry that lets one deferred wake\n  * through (a wall still in place repaints and re-latches).\n  */\n-import { describe, it, expect } from 'vitest';\n+import { describe, it, expect, vi } from 'vitest';\n+import { randomUUID } from 'node:crypto';\n+import { EventEmitter } from 'node:events';\n+import { existsSync } from 'node:fs';\n+import { readFile } from 'node:fs/promises';\n+import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';\n import {\n+  hostThroughPty,\n+  metaPathFor,\n   makeAuthBlockDetector,\n   makeQuotaBlockDetector,\n   parseQuotaResetAtMs,\n@@ -26,6 +33,72 @@ const INCIDENT_WALL =\n const INCIDENT_RESET = new Date(2026, 9, 14, 20, 24, 0, 0).getTime();\n const BEFORE_RESET = new Date(2026, 9, 11, 0, 5, 0, 0).getTime();\n \n+describe('host discovery quota reset publication (R28)', () => {\n+  const absoluteWall = 'You’ve hit your usage limit. Try again at Jun 1st, 2040 8:24 PM.';\n+  const absoluteReset = new Date(2040, 5, 1, 20, 24).getTime();\n+  const cases = [\n+    { label: 'absolute local time', text: absoluteWall, expectedAtMs: absoluteReset },\n+    { label: 'relative duration', text: 'You’ve hit your usage limit. Try again in 2 hours.', relativeMs: 7_200_000 },\n+    { label: 'ANSI and wrapped output',\n+      text: '\\x1b[31mYou’ve hit your usage limit.\\x1b[0m Try again\\r\\n at Jun 1st,\\r\\n 2040 8:24 PM.',\n+      expectedAtMs: absoluteReset },\n+    { label: 'newest statement', text: absoluteWall + '\\nYou’ve hit your usage limit. Try again at Jun 2nd, 2040 9:30 PM.',\n+      expectedAtMs: new Date(2040, 5, 2, 21, 30).getTime() },\n+    { label: 'no stated reset', text: 'You’ve hit your usage limit.', expectedAtMs: null },\n+  ] as const;\n+\n+  it.each(cases)('publishes the parsed provider reset instant as quotaResetAtMs on the host record [$label]', async fixture => {\n+    const ownerId = `su-quota-publication-${randomUUID()}`;\n+    const metadataPath = metaPathFor(ownerId);\n+    const dataListeners: Array<(text: string) => void> = [];\n+    const exitListeners: Array<(event: { exitCode: number; signal: number }) => void> = [];\n+    // Exercise the production output detector and metadata writer; only the PTY is replaced.\n+    // This PID exceeds Linux's PID range, so fixture cleanup cannot address a live process.\n+    const child = {\n+      pid: 999_999_999, write() {}, kill() {}, resize() {}, pause() {}, resume() {}, unref() {},\n+      on() {},\n+      onData(listener: (text: string) => void) { dataListeners.push(listener); return { dispose() {} }; },\n+      onExit(listener: (event: { exitCode: number; signal: number }) => void) {\n+        exitListeners.push(listener); return { dispose() {} };\n+      },\n+    };\n+    const done = hostThroughPty({\n+      command: process.execPath, ownerId,\n+      env: hermeticEnv({ PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex' }),\n+      spawnPty: () => child,\n+      io: { stdin: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },\n+        stdout: { columns: 80, rows: 24, write() {}, on() {}, off() {} } },\n+      bridgeTty: false, signalSource: new EventEmitter(),\n+      onExit: () => {}, emitCompacted: () => null, reapScopeResidue: () => ({}),\n+    });\n+    try {\n+      await vi.waitFor(async () => {\n+        expect(JSON.parse(await readFile(metadataPath, 'utf8')))\n+          .toMatchObject({ ownerId, quotaBlocked: false, quotaResetAtMs: null });\n+      }, { timeout: 3000 });\n+      expect(dataListeners.length).toBeGreaterThan(0);\n+      const beforeOutput = Date.now();\n+      for (const listener of dataListeners) listener(fixture.text);\n+      const afterOutput = Date.now();\n+      // The detected edge must publish without waiting for the host's 15s activity tick.\n+      await vi.waitFor(async () => {\n+        const record = JSON.parse(await readFile(metadataPath, 'utf8'));\n+        expect(record).toMatchObject({ ownerId, quotaBlocked: true });\n+        if ('relativeMs' in fixture) {\n+          expect(record.quotaResetAtMs).toBeGreaterThanOrEqual(beforeOutput + fixture.relativeMs);\n+          expect(record.quotaResetAtMs).toBeLessThanOrEqual(afterOutput + fixture.relativeMs);\n+        } else {\n+          expect(record.quotaResetAtMs).toBe(fixture.expectedAtMs);\n+        }\n+      }, { timeout: 3000 });\n+    } finally {\n+      for (const listener of exitListeners) listener({ exitCode: 0, signal: 0 });\n+      await done;\n+    }\n+    expect(existsSync(metadataPath)).toBe(false);\n+  }, 10_000);\n+});\n+\n describe('provider detector replay mode follows the replacement child', () => {\n   it.each([\n     ['quota', makeQuotaBlockDetector, INCIDENT_WALL],\n",
  "scope": "Five R28 cases observe the production host discovery-file writer using existing spawnPty and hermeticEnv seams; no actual child process/provider/service or production edit. Cases cover absolute local reset, relative duration, ANSI/wrapping, newest statement and no stated reset. Immediate detected-edge publication required before15s activity tick; fake-child exit must remove metadata.",
  "verification": {
    "syntax": "node --check named file exit0",
    "whitespace": "git diff --check named file exit0",
    "testExecution": "NOT RUN; no pass/failure or acceptance claim"
  },
  "parentClaim": "live read self-assignee/open before edit",
  "lock": {
    "id": "98f47c75-2ef4-47ea-91c4-8f8850f88ceb",
    "releasedWithNativeEditProof": true
  },
  "priorVerifiedArchive": {
    "path": "audits/parked-agent-resumption-2026-10-09/resume194-independent-construction-and-reporter-custody-424d5.json",
    "chars": 12632,
    "sha256": "638c8b66935c643ecaec6dd9036aef95c0a48875721e1bca9fc3c060e6f9c99b"
  },
  "walls": [
    "all10 parent check IDs preserved",
    "R27/R28/R32-R34 construction not executed",
    "committed diagnostic reporter not yet proved loaded",
    "installed OTel coherence and staging3170 readiness still unverified; no new polling",
    "root460/root464 not rearmed; no loops/await/gate/release operations",
    "original116/allfix24h/provider/root961/launcher boundaries unchanged"
  ],
  "next": "After installed compatibility and staging readiness proof, establish committed heartbeat loading and its maintained suite before further costly diagnostic verification. New construction cases require first maintained execution, committed custody and independent parent grading; no old S41 or original population proof rerun for recall."
}
