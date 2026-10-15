---
rel_path: "audits/parked-agent-resumption-2026-10-09/scoped-host-containment-fire14-424d5.json"
updated_at: 1791808856559
_body: "content"
---

{
  "schemaVersion": "parked-scoped-host-residue-v1",
  "workItem": "WI-6554700010008887",
  "sourceQueries": [
    "WITH a AS MATERIALIZED (SELECT content::jsonb c FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path='audits/parked-agent-resumption-2026-10-09/required-host-source-containment-fire14-424d5.json'), hosts AS MATERIALIZED (SELECT h FROM a CROSS JOIN LATERAL jsonb_array_elements(c->'hosts') h) SELECT h->>'ownerId' owner_id,h->>'advSessionId' adv_id,h->>'bridgeTty' bridge,h->>'hostCodeVersion' version,h->>'structuralContainment' containment,h->'missingMarkers' missing FROM hosts JOIN harness_shared.adv_sessions s ON s.id=(h->>'advSessionId')::bigint AND s.coord_owner_id=h->>'ownerId' WHERE s.workspace_id='papercusp-workspace' AND s.launch_spec->>'harnessSlug'='papercusp' AND h->>'structuralContainment' IN ('missing-markers','unknown') ORDER BY 1",
    "SELECT jsonb_agg(x->>'ownerId') owners FROM harness_shared.harness_text_artifacts a CROSS JOIN LATERAL jsonb_array_elements(a.content::jsonb->'rows') x WHERE a.workspace_id='papercusp-workspace' AND a.harness_slug='papercusp' AND a.rel_path='audits/parked-agent-resumption-2026-10-09/r13-original116-candidates-fire14-424d5.json'",
    "SELECT jsonb_object_agg(x->>'ownerId',x->>'decision') decisions FROM harness_shared.harness_text_artifacts a CROSS JOIN LATERAL jsonb_array_elements(a.content::jsonb->'decisions') x WHERE a.workspace_id='papercusp-workspace' AND a.harness_slug='papercusp' AND a.rel_path='audits/parked-agent-resumption-2026-10-09/dispositions.json'"
  ],
  "scope": "Scoped source-containment residue from saved local metadata snapshot. Original candidate membership and earlier R2 decision are custody signals, not permission to respawn. Marker absence alone does not prove current inability to think; no host acted upon.",
  "rows": [
    {
      "owner_id": "su-0d52d810-afcc-4f52-8863-4a92600f9485",
      "adv_id": "39377",
      "bridge": "false",
      "version": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-16e3554c-a66e-4183-b374-2e5ae2a95e36",
      "adv_id": "39669",
      "bridge": "false",
      "version": "1adf3ebf979c30788f760dae4dcf374e1e3ebc43ff5a22c13bfe41df75d8c68e",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-2b0b24d0-e9f4-4467-87a1-ff83cdd39d99",
      "adv_id": "35289",
      "bridge": "false",
      "version": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-owner-pause"
    },
    {
      "owner_id": "su-3ecaf532-8655-4072-b2c0-6bc3319221b1",
      "adv_id": "36177",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-44e04b45-8305-4182-813b-b5b0a931b2e0",
      "adv_id": "37454",
      "bridge": "false",
      "version": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "resume-candidate"
    },
    {
      "owner_id": "su-4d390264-fc3c-4875-a655-a71b0afcd6ef",
      "adv_id": "36101",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-50f71624-3c60-4db3-b43d-06160dbc957c",
      "adv_id": "36976",
      "bridge": "true",
      "version": "225756ed51ef1276cd37b79650eb36525e2ade30cfb93a529d63e3f9cf057174",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-51edba27-5372-4c49-8a17-af2ede9bb198",
      "adv_id": "38978",
      "bridge": "true",
      "version": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-56b83dff-25c8-4a9b-bacf-5c549c832931",
      "adv_id": "36026",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-586d69f1-1289-4cd0-824c-09a6f98ee5e7",
      "adv_id": "35913",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-5a70011e-0cac-4244-8b27-9aaf1ceb0b18",
      "adv_id": "39895",
      "bridge": "false",
      "version": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "containment": "missing-markers",
      "missing": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-60df5d22-d045-4660-bdbc-ff602879d3a8",
      "adv_id": "39434",
      "bridge": "false",
      "version": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-75676c8f-ed12-4217-b88d-57bd6f4043aa",
      "adv_id": "35940",
      "bridge": "false",
      "version": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "resume-candidate"
    },
    {
      "owner_id": "su-8aec963c-1284-4a99-85f6-64e3dd62c82f",
      "adv_id": "38866",
      "bridge": "true",
      "version": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-8ec23f4a-5d17-4f1c-bf4c-790edb53f5e3",
      "adv_id": "36110",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-98e0d4ff-6025-49e3-aba1-c1d3e5606cd9",
      "adv_id": "36445",
      "bridge": "false",
      "version": "1adf3ebf979c30788f760dae4dcf374e1e3ebc43ff5a22c13bfe41df75d8c68e",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-9c77cdda-2970-4f59-b57f-012184077358",
      "adv_id": "39313",
      "bridge": "false",
      "version": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "containment": "missing-markers",
      "missing": [
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-9dfd3ffc-fb7b-40bf-b625-d93dbab9f002",
      "adv_id": "35938",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-acd7804d-5729-4946-b02a-ca953853bffe",
      "adv_id": "38980",
      "bridge": "false",
      "version": "266153483ae8ad37b4bdb78398fffb6678a84444f48d7bf76dd90f15cd4530d7",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "adv_id": "39935",
      "bridge": "false",
      "version": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "containment": "missing-markers",
      "missing": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": true,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-b9896e0c-d92d-4333-9ee6-370b6911aad4",
      "adv_id": "39080",
      "bridge": "false",
      "version": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "containment": "missing-markers",
      "missing": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-c7d00eaf-c97c-44b5-b22e-3cb5e2ddb653",
      "adv_id": "39554",
      "bridge": "false",
      "version": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "containment": "missing-markers",
      "missing": [
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-dab96471-48c6-40bf-a2b6-2ec7c5b052ca",
      "adv_id": "35943",
      "bridge": "false",
      "version": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-e6d2a824-e413-4321-9aea-6600c71cec71",
      "adv_id": "36100",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "resume-candidate"
    },
    {
      "owner_id": "su-ee96d6e7-0474-48be-9d85-70cbb9d63d32",
      "adv_id": "39665",
      "bridge": "false",
      "version": "1adf3ebf979c30788f760dae4dcf374e1e3ebc43ff5a22c13bfe41df75d8c68e",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-f7a0f287-7667-49d1-af74-fd6b74a348c8",
      "adv_id": "39976",
      "bridge": "false",
      "version": "55f6e623302f359544407143766a9a7357229c9aa64d6240d70b291222ab6418",
      "containment": "unknown",
      "missing": null,
      "original116Candidate": false,
      "earlierR2Decision": null
    },
    {
      "owner_id": "su-fa4c1948-0cb1-4552-a7a3-dc274c5e1b0a",
      "adv_id": "36018",
      "bridge": "false",
      "version": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "containment": "missing-markers",
      "missing": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ],
      "original116Candidate": false,
      "earlierR2Decision": "justified-scoped-wait"
    }
  ]
}
