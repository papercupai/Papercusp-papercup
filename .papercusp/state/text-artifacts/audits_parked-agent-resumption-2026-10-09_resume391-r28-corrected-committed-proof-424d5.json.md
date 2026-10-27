---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume391-r28-corrected-committed-proof-424d5.json"
updated_at: 1792977136302
_body: "content"
---

{
  "schemaVersion": 1,
  "parentWorkItem": "WI-6554700010008887",
  "scope": "R28 P004/P012 mechanical host-record reset publication fixtures",
  "testedCommit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
  "sourceEquality": {
    "beforeRun": "Predecessor git diff --exit-code fixed7555e991 source/test/fixture passed",
    "afterRun": "Successor direct working/ref SHA256 comparisons all equal",
    "hashes": {
      "apps/operator/scripts/psu-pty-host.mjs": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5",
      "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
      "apps/operator/vitest-shims/psu-pty-temp-dir.ts": "651cac8c6257ab7dad254658dbd1474c2c94e814424a44532bfd6571307da910"
    }
  },
  "runs": [
    {
      "id": 22088311,
      "status": "fail",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
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
      "id": 22088310,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
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
      "id": 22088309,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
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
      "id": 22088304,
      "status": "pass",
      "commit": "7555e991067ac075b9430ae906a1a3fcc01d9e41",
      "dirty": false,
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
    "probeInvocationId": "93d82825-c343-430a-bb4d-82475aa10fe0",
    "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
    "subjectAfterSha256": "391d61a82a37d62f694fe0ecb32139937ad3cc8dcf65ee36d5283481dbc9573e",
    "mutantDiffTruncated": false,
    "subjectBeforeSha256": "032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5"
  },
  "bindings": [
    {
      "id": 70734,
      "specId": "AUTO-BAR-R-28-P-012",
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
      "id": 70733,
      "specId": "AUTO-BAR-R-28-P-012",
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
      "id": 70732,
      "specId": "AUTO-BAR-R-28-P-004",
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
      "id": 70731,
      "specId": "AUTO-BAR-R-28-P-004",
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
      "sha": "baf13de7bf",
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
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70731
          },
          "caughtMutantBindingIds": [
            70732
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
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70733
          },
          "caughtMutantBindingIds": [
            70734
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
    "/tmp/parked-resume390b-r28-committed-424d5.log",
    "/tmp/parked-resume390b-r28-mutation-424d5.log"
  ],
  "priorHistoricalArtifact": "audits/parked-agent-resumption-2026-10-09/resume390-r28-refreshed-mechanical-proof-424d5.json",
  "limits": [
    "No real-provider reset/recovery acceptance",
    "No original116 eligibility/continuity or outcome join",
    "No final24h, native-host, deployed or whole-plan acceptance",
    "Currentness measured only at this evidence read",
    "No production source edit or rerun in this successor"
  ]
}
