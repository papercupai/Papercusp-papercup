---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume390-r28-refreshed-mechanical-proof-424d5.json"
updated_at: 1792976379021
_body: "content"
---

{
  "schemaVersion": 1,
  "parentWorkItem": "WI-6554700010008887",
  "scope": "R28 P004 and P012 mechanical host-record reset publication proof only",
  "testedCommit": "baf13de7bf3fa224e2a719488e71a8879e5702e5",
  "testFile": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
  "source": "apps/operator/scripts/psu-pty-host.mjs",
  "runs": [
    {
      "id": 22086746,
      "status": "fail",
      "commit": "baf13de7bf3fa224e2a719488e71a8879e5702e5",
      "counts": {
        "passed": 9,
        "failed": 12,
        "skipped": 0
      },
      "publicationCases": [
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
          "status": "fail"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
          "status": "fail"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
          "status": "fail"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
          "status": "fail"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22086741,
      "status": "pass",
      "commit": "baf13de7bf3fa224e2a719488e71a8879e5702e5",
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "publicationCases": [
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22086740,
      "status": "pass",
      "commit": "baf13de7bf3fa224e2a719488e71a8879e5702e5",
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "publicationCases": [
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
          "status": "pass"
        }
      ]
    },
    {
      "id": 22086208,
      "status": "pass",
      "commit": "baf13de7bf3fa224e2a719488e71a8879e5702e5",
      "counts": {
        "passed": 21,
        "failed": 0,
        "skipped": 0
      },
      "publicationCases": [
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
          "status": "pass"
        },
        {
          "title": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
          "status": "pass"
        }
      ]
    }
  ],
  "mutation": {
    "leg": "mutant",
    "mode": "copy-out",
    "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6568,7 +6568,7 @@\n  *  future at `nowMs` is ignored, so a mis-parse or a replayed old wall can\n  *  never open the gate early; null keeps the old fail-closed level. Pure;\n  *  exported for tests. */\n-export function parseQuotaResetAtMs(text, agent = '', nowMs = Date.now()) {\n+export function parseQuotaResetAtMs(text, agent = '', nowMs = Date.now()) { return null;\n   if (String(agent ?? '').trim().toLowerCase() !== 'codex') return null;\n   const flat = stripAnsi(String(text ?? '')).replace(/\\s+/g, ' ');\n   const starts = [...flat.matchAll(/try again (at|in) /gi)];\n",
    "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
    "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
    "againstCommit": null,
    "schemaVersion": 1,
    "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
    "mutateExpression": "s/(export function parseQuotaResetAtMs\\([^\\n]*\\) \\{)/$1 return null;/",
    "probeInvocationId": "6371f257-bd67-49f1-83d2-e1df4889a435",
    "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
    "subjectAfterSha256": "f3363b7acc8a3557c11957a91ad9458a640e05404dba7092e43b36b7acff8543",
    "mutantDiffTruncated": false,
    "subjectBeforeSha256": "bbc0421a918a35e16f6acfd09acc7bd20188a67b4b2486588e1da82220b35e5d"
  },
  "bindings": [
    70701,
    70702,
    70703,
    70704
  ],
  "certification": {
    "ok": true,
    "evaluatorBuild": {
      "sha": "ed29bd33d5",
      "version": "0.0.0"
    },
    "counts": {
      "clauses": 2,
      "passing": 2,
      "filed": 0,
      "unchanged": 0,
      "refused": 0,
      "notPassing": 0,
      "mechanicallyVerified": 2
    },
    "clauses": [
      {
        "specId": "AUTO-BAR-R-28-P-004",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70701
          },
          "caughtMutantBindingIds": [
            70702
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      },
      {
        "specId": "AUTO-BAR-R-28-P-012",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70703
          },
          "caughtMutantBindingIds": [
            70704
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      }
    ]
  },
  "logs": [
    "/tmp/parked-resume390-r28-committed-424d5.log",
    "/tmp/parked-resume390-r28-mutation-424d5.log"
  ],
  "limits": [
    "No provider wall was exhausted or recovered",
    "No original116 outcome or eligibility join",
    "No final24h, native-host, deployed or whole-plan acceptance",
    "Source currentness was measured by evaluator ed29bd33d5 at certification, not promised for future source changes"
  ],
  "noProductionSourceEdits": true,
  "currentSourceAcceptance": false,
  "freshnessCorrection": {
    "reason": "Tested HEAD omitted three carry-respawn edits already present before test launch; source equality preflight was missing.",
    "testedSourceSha256": "bbc0421a918a35e16f6acfd09acc7bd20188a67b4b2486588e1da82220b35e5d",
    "workingSourceSha256BeforeAndAfter": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5",
    "exactBindingCurrentness": "source-stale",
    "certificationReceipt": "Retained original PASS output; does not establish current-source acceptance.",
    "suspectedVerifierGap": "EI-26161676429536656",
    "claimResult": "not_claimable: agent-review admission floor; no bypass",
    "next": "New fixed7555e991 verification requires source/test/fixture equality preflight."
  }
}
