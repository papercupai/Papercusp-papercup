---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume391-r29-r31-current-committed-proof-424d5.json"
updated_at: 1792977774120
_body: "content"
---

{
  "schemaVersion": 1,
  "parentWorkItem": "WI-6554700010008887",
  "scope": "R29/R30/R31 P004/P012 mechanical quota reset, probe and relatch fixtures",
  "testedCommit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
  "sourceEquality": "Canonical and original kept-tree source/test/fixture bytes matched fixed7555e991 before probes; kept-tree equality verified after each; canonical git diff equality passed again before binding",
  "r28Companion": "audits/parked-agent-resumption-2026-10-09/resume391-r28-corrected-committed-proof-424d5.json",
  "runs": [
    {
      "id": 22090039,
      "status": "fail",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 20,
        "failed": 1,
        "skipped": 0
      },
      "mutation": {
        "leg": "mutant",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6849,7 +6849,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
        "probeInvocationId": "38977fbe-1ee7-4b14-9736-25c44844349a",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "263b40290374abff12eed7ce8e41d0f2739db8b7abdd1697c81d048eccbd1b17",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "fail"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090037,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "mutation": {
        "leg": "copy-baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6849,7 +6849,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
        "probeInvocationId": "38977fbe-1ee7-4b14-9736-25c44844349a",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "263b40290374abff12eed7ce8e41d0f2739db8b7abdd1697c81d048eccbd1b17",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090036,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "mutation": {
        "leg": "baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6849,7 +6849,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
        "probeInvocationId": "38977fbe-1ee7-4b14-9736-25c44844349a",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "263b40290374abff12eed7ce8e41d0f2739db8b7abdd1697c81d048eccbd1b17",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090035,
      "status": "fail",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 19,
        "failed": 2,
        "skipped": 0
      },
      "mutation": {
        "leg": "mutant",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6780,7 +6780,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
        "probeInvocationId": "2d533b50-1a39-46f4-83e9-6629816a94f3",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "e51acf174bd1031551e29b4b858752f393fd12d2b115884f8c76dd88085569aa",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "fail"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "fail"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090033,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "mutation": {
        "leg": "copy-baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6780,7 +6780,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
        "probeInvocationId": "2d533b50-1a39-46f4-83e9-6629816a94f3",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "e51acf174bd1031551e29b4b858752f393fd12d2b115884f8c76dd88085569aa",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090029,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "mutation": {
        "leg": "baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6780,7 +6780,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
        "probeInvocationId": "2d533b50-1a39-46f4-83e9-6629816a94f3",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "e51acf174bd1031551e29b4b858752f393fd12d2b115884f8c76dd88085569aa",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090026,
      "status": "fail",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 19,
        "failed": 2,
        "skipped": 0
      },
      "mutation": {
        "leg": "mutant",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6777,7 +6777,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
        "probeInvocationId": "02153ebe-b0f0-4f0c-bc6e-7136b570b572",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "cb1b5a41ee59808062c71fd43afdbebf54137d637a922a454e2bcec5baa5ab21",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "fail"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "fail"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090023,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "mutation": {
        "leg": "copy-baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6777,7 +6777,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
        "probeInvocationId": "02153ebe-b0f0-4f0c-bc6e-7136b570b572",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "cb1b5a41ee59808062c71fd43afdbebf54137d637a922a454e2bcec5baa5ab21",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22090013,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "mutation": {
        "leg": "baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6777,7 +6777,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
        "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
        "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
        "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
        "probeInvocationId": "02153ebe-b0f0-4f0c-bc6e-7136b570b572",
        "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
        "subjectAfterSha256": "cb1b5a41ee59808062c71fd43afdbebf54137d637a922a454e2bcec5baa5ab21",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22088304,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "relevantCases": [
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
          "status": "pass"
        },
        {
          "title": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
          "status": "pass"
        }
      ]
    }
  ],
  "bindings": [
    {
      "id": 70749,
      "specId": "AUTO-BAR-R-31-P-012",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70748,
      "specId": "AUTO-BAR-R-31-P-012",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70747,
      "specId": "AUTO-BAR-R-31-P-004",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70746,
      "specId": "AUTO-BAR-R-31-P-004",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70745,
      "specId": "AUTO-BAR-R-30-P-012",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70744,
      "specId": "AUTO-BAR-R-30-P-012",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70743,
      "specId": "AUTO-BAR-R-30-P-004",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70742,
      "specId": "AUTO-BAR-R-30-P-004",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70741,
      "specId": "AUTO-BAR-R-29-P-012",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70740,
      "specId": "AUTO-BAR-R-29-P-012",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70739,
      "specId": "AUTO-BAR-R-29-P-004",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    },
    {
      "id": 70738,
      "specId": "AUTO-BAR-R-29-P-004",
      "revision": 2,
      "currentness": {
        "overall": "current",
        "dimensions": {
          "spec": "current",
          "source": "current",
          "test": "current",
          "fixture": "current",
          "rubric": "not-applicable",
          "environment": "not-applicable",
          "coverageEvidence": "not-applicable",
          "testRun": "current"
        },
        "staleReasons": [],
        "unknownReasons": [],
        "comparisonSupplied": true,
        "provenance": "server-measured"
      }
    }
  ],
  "certification": {
    "ok": true,
    "evaluatorBuild": {
      "sha": "9c3bd4d771",
      "version": "0.0.0"
    },
    "counts": {
      "clauses": 6,
      "passing": 6,
      "filed": 0,
      "unchanged": 0,
      "refused": 0,
      "notPassing": 0,
      "mechanicallyVerified": 6
    },
    "clauses": [
      {
        "specId": "AUTO-BAR-R-29-P-004",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "gaps": []
        }
      },
      {
        "specId": "AUTO-BAR-R-29-P-012",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "gaps": []
        }
      },
      {
        "specId": "AUTO-BAR-R-30-P-004",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "gaps": []
        }
      },
      {
        "specId": "AUTO-BAR-R-30-P-012",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "gaps": []
        }
      },
      {
        "specId": "AUTO-BAR-R-31-P-004",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "gaps": []
        }
      },
      {
        "specId": "AUTO-BAR-R-31-P-012",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "gaps": []
        }
      }
    ]
  },
  "independentFreshnessRead": {
    "evidence": [
      {
        "id": 70749,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70748,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70747,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70746,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70745,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70744,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70743,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70742,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70741,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70740,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70739,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 70738,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      }
    ]
  },
  "logs": [
    "/tmp/parked-resume391-r29-mutation-424d5.log",
    "/tmp/parked-resume391-r30-mutation-424d5.log",
    "/tmp/parked-resume391-r31-mutation-424d5.log"
  ],
  "limits": [
    "Mechanical fixture proof only",
    "No real-provider/live/native/deployed/final24h/original116 or whole-plan acceptance",
    "Currentness measured at selected binding reads, not promised for future source movement",
    "No production code edits or manual git publication"
  ]
}
