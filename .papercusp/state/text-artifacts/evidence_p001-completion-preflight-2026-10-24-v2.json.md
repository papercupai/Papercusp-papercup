---
rel_path: "evidence/p001-completion-preflight-2026-10-24-v2.json"
updated_at: 1792866611882
_body: "content"
---

{
  "ok": true,
  "results": [
    {
      "ok": true,
      "id": "WI-6554700010020287",
      "validationOnly": true,
      "completionAuthority": "proposed",
      "countsTowardBurnDown": false,
      "changeKindWarning": "WI-6554700010020287 landed authority:'proposed' (out of burn-down): it drops 'background-job', declared earlier for this item, and no `changeKindReason` says why. Re-close with a one-line `changeKindReason` (and `changeKinds` if the declared set is wrong — add 'ui' when the change is visible) to count it toward done.",
      "completionContract": {
        "version": "work-items-completion-v5",
        "requirements": [
          {
            "key": "assumptions",
            "description": "Terminal closes declare assumptions or explicitly declare none.",
            "applicable": true,
            "satisfied": true
          },
          {
            "key": "root-cause-verification",
            "description": "Successful defect closes carry complete causal evidence v2.",
            "applicable": false,
            "satisfied": null
          },
          {
            "key": "spec-test-adequacy",
            "description": "Affected first-class specs have current independently audited proof.",
            "applicable": true,
            "satisfied": true
          },
          {
            "key": "design-evidence",
            "description": "Enforced ratified design cases have current passing evidence.",
            "applicable": false,
            "satisfied": null
          },
          {
            "key": "verification-coverage",
            "description": "Universal verification claims enumerate a complete population partition.",
            "applicable": false,
            "satisfied": null
          },
          {
            "key": "self-review",
            "description": "Pilot self-review evidence is present and ledger-visible when applicable.",
            "applicable": false,
            "satisfied": null
          },
          {
            "key": "gate-red-lineage",
            "description": "A claimed red-gate repair is admitted on the judged lineage.",
            "applicable": false,
            "satisfied": null
          },
          {
            "key": "spec-conformance-closure",
            "description": "Linked-plan mapped requirements are declared, discharged checks pass, and drift alarms have approved deviations.",
            "applicable": true,
            "satisfied": true,
            "details": {
              "mappedRequirements": [
                "R-1",
                "R-2",
                "R-3",
                "R-4"
              ],
              "declaredRequirements": [
                "R-1",
                "R-2",
                "R-3",
                "R-4"
              ],
              "declarationFields": [
                "completion.discharges",
                "completion.contributesTo"
              ],
              "declarationSatisfied": true
            }
          },
          {
            "key": "conformance-review-independence",
            "description": "A conformance-review work-item is not closed by its plan implementer.",
            "applicable": false,
            "satisfied": null
          },
          {
            "key": "change-kind-proof",
            "description": "A successful close carries the proof each declared change kind requires.",
            "applicable": true,
            "satisfied": true
          },
          {
            "key": "live-service-evidence",
            "description": "Live-service closes name a concrete service and a falsifiable runtime observation in root verification evidence.",
            "applicable": false,
            "satisfied": null
          }
        ]
      }
    }
  ],
  "counts": {
    "ok": 1,
    "failed": 0
  },
  "_meta": {
    "explicitFullRequest": true,
    "format": "json",
    "_seeAlso": [
      {
        "tool": "Server-stamped settlement metadata: `work_items:complete` derives `settlementManifest` from the observed checkouts; callers must omit `settlementManifest` (including `completion.verification.settlementManifest`). When present in persisted evidence, it contains version=1, a positive generation, a 64-hex evidenceHash, repositoryRoot, a full 40- or 64-character headSha, normalizedPaths, and contentIdentity[]. Per-entry repositoryRoot/headSha identify sibling checkouts; normalizedPaths can repeat a relative path when distinct checkouts own it. Missing per-entry checkout fields fall back to the top-level root/head for legacy receipts. Do not send intuitive artifact fields such as schemaVersion, artifactPath, artifactSha256, head, or boolean contentIdentity."
      },
      {
        "tool": "For linked-plan closes, the spec-conformance-closure row in completionContract reports mapped and declared R-* keys; validateOnly:true previews it with the other completion requirements."
      },
      {
        "tool": "work_items:set_state (change state without recording a completion)"
      },
      {
        "tool": "coord:send (a note/question that is not a completion)"
      },
      {
        "tool": "improvements:capture (file the friction the reflect step surfaced)"
      },
      {
        "tool": "Finish is idempotent: after a timeout, re-check with work_items:get or retry the same completion. If work_items:complete times out, first re-read work_items:get; if the item is still open, retry the exact same completion payload (including assumptions). If you use work_items:set_state as the fallback, carry the same assumptions declaration and pass completionRef too. Shape: an ARRAY of facts:assert keys — assumptions: [\"my-fact-key\"] (note the brackets, even for a single key) — or the bare literal assumptions: \"none\"."
      },
      {
        "tool": "For batches, top-level ok is FALSE if any item failed (it is derived from results[].ok); inspect counts.failed and each result to see which."
      }
    ]
  }
}
