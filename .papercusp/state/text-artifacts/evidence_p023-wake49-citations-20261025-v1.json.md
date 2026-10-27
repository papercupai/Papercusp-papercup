---
rel_path: "evidence/p023-wake49-citations-20261025-v1.json"
updated_at: 1792890755109
_body: "content"
---

{
  "cutoff": "2026-10-25T01:07:49Z",
  "query": {
    "sql": "WITH cohort(id,closed_at) AS (VALUES ('WI-6554700010020287','2026-10-24T18:33:49.600Z'::timestamptz),('WI-2039882',NULL::timestamptz),('WI-2144482',NULL::timestamptz),('WI-6554700010020422',NULL::timestamptz),('WI-6554700010020423',NULL::timestamptz),('WI-2039884',NULL::timestamptz),('WI-6554700010020424',NULL::timestamptz),('WI-2039885',NULL::timestamptz),('WI-2039889',NULL::timestamptz),('WI-2039890',NULL::timestamptz)) SELECT c.id,c.closed_at,coalesce(jsonb_agg(jsonb_build_object('id',w.feature_id,'created',to_timestamp(w.created_ts/1000.0),'title',w.title,'after_close',CASE WHEN c.closed_at IS NULL THEN NULL ELSE to_timestamp(w.created_ts/1000.0)>=c.closed_at END)) FILTER(WHERE w.feature_id IS NOT NULL),'[]'::jsonb) AS bug_citations FROM cohort c LEFT JOIN harness_shared.work_items w ON w.workspace_id='papercusp-workspace' AND w.harness_slug='papercusp' AND w.item_kind='bug' AND coalesce(w.payload->>'lane','') <> 'observation' AND to_timestamp(w.created_ts/1000.0)>='2026-10-22T00:00:00Z' AND to_timestamp(w.created_ts/1000.0)<'2026-10-25T01:07:49Z' AND (coalesce(w.title,'')||E'\\n'||coalesce(w.summary,'')) ~ ('(^|[^0-9])'||substring(c.id from 4)||'([^0-9]|$)') GROUP BY c.id,c.closed_at ORDER BY c.id",
    "positiveControlSql": "SELECT feature_id FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND item_kind='bug' AND feature_id='EI-26852061161501115'",
    "allowUnscoped": false,
    "maxRows": 20,
    "timeoutMs": 20000
  },
  "result": {
    "advisory": "⚠ BACKLOG FLOW over work_items — 1 way(s) this query answers a different question than it appears to: (1) a hand-rolled created_ts/closed_ts window: work_items:burn_down already computes this AND reports what a hand-written GROUP BY cannot — it attributes from an append-only ledger (so members that have since died still count), declares that its buckets sum to the delta (so a bucket cannot be read as a sample), and stamps `truncatedByLimit` on the AGGREGATE (so a capped census is never quoted as a total).",
    "mode": "query",
    "rowCount": 10,
    "truncated": false,
    "fields": [
      "id",
      "closed_at",
      "bug_citations"
    ],
    "elapsedMs": 432,
    "rows": [
      {
        "id": "WI-2039882",
        "closed_at": null,
        "bug_citations": [
          {
            "id": "EI-26734627168354430",
            "title": "P531 committed close cannot reflect plan status because global dependency resync backfills blockers behind active downstream parents",
            "created": "2026-10-23T02:15:27.286+00:00",
            "after_close": null
          }
        ]
      },
      {
        "id": "WI-2039884",
        "closed_at": null,
        "bug_citations": []
      },
      {
        "id": "WI-2039885",
        "closed_at": null,
        "bug_citations": []
      },
      {
        "id": "WI-2039889",
        "closed_at": null,
        "bug_citations": []
      },
      {
        "id": "WI-2039890",
        "closed_at": null,
        "bug_citations": []
      },
      {
        "id": "WI-2144482",
        "closed_at": null,
        "bug_citations": [
          {
            "id": "EI-26756866381934062",
            "title": "P521 original native is pending-turn-stuck for hours: required wake misses while exact resume sees live host",
            "created": "2026-10-23T08:08:56.159+00:00",
            "after_close": null
          },
          {
            "id": "EI-26734627168354430",
            "title": "P531 committed close cannot reflect plan status because global dependency resync backfills blockers behind active downstream parents",
            "created": "2026-10-23T02:15:27.286+00:00",
            "after_close": null
          }
        ]
      },
      {
        "id": "WI-6554700010020287",
        "closed_at": "2026-10-24 18:33:49.6+00",
        "bug_citations": [
          {
            "id": "EI-26852061161501115",
            "title": "Frozen-test calibration depends on a test-run receipt that is now absent from the canonical ledger",
            "created": "2026-10-24T09:22:01.06+00:00",
            "after_close": false
          },
          {
            "id": "EI-26840728852696715",
            "title": "code:run fleet leader-brief roster conflicts with direct fleet status on the same explicit fleet",
            "created": "2026-10-24T06:21:53.737+00:00",
            "after_close": false
          },
          {
            "id": "EI-26770216458100907",
            "title": "Immutable plan revision cannot be reselected by the grading audit's supported reader",
            "created": "2026-10-23T11:41:07.524+00:00",
            "after_close": false
          },
          {
            "id": "EI-26751445991647770",
            "title": "Tiny isolated dependency publication timed out before existing-generation validation",
            "created": "2026-10-23T06:42:46.96+00:00",
            "after_close": false
          },
          {
            "id": "EI-26750088020754751",
            "title": "Scoped lint:tsc service timeout falls back to full operator-core compile",
            "created": "2026-10-23T06:21:11.898+00:00",
            "after_close": false
          },
          {
            "id": "EI-26693420204125420",
            "title": "rubrics:amend updates R2 Intent in rubric but preserves prior Intent in subject Requirements projection",
            "created": "2026-10-22T15:20:29.261+00:00",
            "after_close": false
          }
        ]
      },
      {
        "id": "WI-6554700010020422",
        "closed_at": null,
        "bug_citations": [
          {
            "id": "EI-26815617154975491",
            "title": "Immutable verifier preparation exhausts deadline behind global dependency-copy lock before tests start",
            "created": "2026-10-23T23:42:45.321+00:00",
            "after_close": null
          },
          {
            "id": "EI-26813495056594050",
            "title": "Release warns that a background proof is pending after a verified terminal checkpoint append",
            "created": "2026-10-23T23:09:01.447+00:00",
            "after_close": null
          },
          {
            "id": "EI-26805672429853664",
            "title": "Snapshot expansion may dereference malformed rows before receiver validation",
            "created": "2026-10-23T21:04:41.317+00:00",
            "after_close": null
          }
        ]
      },
      {
        "id": "WI-6554700010020423",
        "closed_at": null,
        "bug_citations": [
          {
            "id": "EI-26709114249196016",
            "title": "stale-claim-sweep releases blocked member during registered event wait",
            "created": "2026-10-22T19:29:56.269+00:00",
            "after_close": null
          },
          {
            "id": "EI-26816728144565532",
            "title": "Suspected stale watchdog context estimate causes repeated carry respawns after P533 session is parked",
            "created": "2026-10-24T00:00:24.776+00:00",
            "after_close": null
          },
          {
            "id": "EI-26811764509540023",
            "title": "Shared test PostgreSQL storage placement blocks clean P533 integration while /tmp has headroom",
            "created": "2026-10-23T22:41:31.184+00:00",
            "after_close": null
          },
          {
            "id": "EI-26804852119961183",
            "title": "Suspected false no-loop-turn classification while an existing fleet work turn is still active",
            "created": "2026-10-23T20:51:38.656+00:00",
            "after_close": null
          },
          {
            "id": "EI-26725670375564956",
            "title": "Turn-end held-work guard overrides explicit admission-only hold with timeout polling",
            "created": "2026-10-22T23:53:05.3+00:00",
            "after_close": null
          }
        ]
      },
      {
        "id": "WI-6554700010020424",
        "closed_at": null,
        "bug_citations": [
          {
            "id": "EI-26812358271557189",
            "title": "AUTO stop guard refuses an accepted queued carry-respawn boundary",
            "created": "2026-10-23T22:50:57.436+00:00",
            "after_close": null
          },
          {
            "id": "EI-26813487309852406",
            "title": "In-flight git-sync holds local source commits across more than ten cadence intervals",
            "created": "2026-10-23T23:08:54.176+00:00",
            "after_close": null
          }
        ]
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "feature_id": "EI-26852061161501115"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "feature_id"
      ],
      "status": "passed"
    }
  }
}
